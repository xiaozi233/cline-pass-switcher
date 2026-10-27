// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

// api.cline.bot 的 TLS 1.3 握手偶尔会被对端直接断开（2026-10-27 实测过一次：连续 ECONNRESET，
// 约 10 秒后断，而同一时刻 TLS 1.2 正常、curl 走 schannel 也正常；几小时后 1.3 自行恢复）。
// 因此不写死版本：默认用系统默认（TLS 1.3），一旦遇到 ECONNRESET 就自动降级到 TLS 1.2 并重试，
// 之后保持 1.2 直到重启，避免每条请求都白等 10 秒。要固定版本用 TLS_MAX_VERSION 环境变量。
if (process.env.TLS_MAX_VERSION) tls.DEFAULT_MAX_VERSION = process.env.TLS_MAX_VERSION;
let tlsDegraded = false;
async function fetchTls(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const code = e?.cause?.code || e?.code || '';
    const reset = code === 'ECONNRESET' || /ECONNRESET|socket disconnected before secure TLS/i.test(e?.message || '');
    if (tlsDegraded || !reset) throw e;
    tlsDegraded = true;
    tls.DEFAULT_MAX_VERSION = 'TLSv1.2';
    console.warn('[网络] TLS 连接被重置（疑似 TLS 1.3 握手被对端断开），已自动降级到 TLS 1.2 并重试');
    return await fetch(url, opts);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  avoidVmc: false,         // 是否允许把 planner 请求换成底层公共模型 ID 绕开 VMC 私有层。
                           // 默认关闭：公共 ID 走 Cline Credits 按量计费，不属于订阅额度，余额不足会 402
  enforcePin: false,       // 严格钉住的"命中校验"：开启后非流式请求若实际命中 ≠ 目标上游，直接报 409 而不是静默返回
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { name, key, enabled } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询
  activeAccount: 0,        // single 模式下使用的账号下标
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/deepseek-v4.1-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstreams: string[]（有序优先列表，空=自动）, exclude: string[]（排除列表，优先级高于勾选）,
  //              pinMode: 'strict'|'preferred', sort: 'cost'|'ttft'|'tps'|null }
  // 请求按 upstreams 顺序逐个钉住尝试：第一个异常（非 200 / 网络失败 / 超时）自动顺切下一个，
  // 全部失败才把最后一个错误透传给客户端；exclude 中的上游永不被使用（自动模式下注入排除偏好）。
  // upstream 为旧版单上游兼容镜像（取列表第一个），maxRetries 已退役（旧值仅作回滚兼容保留在文件里）。
  perModel: {},
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const saveMeta = () => fs.writeFileSync(META_PATH, JSON.stringify(META, null, 2));
// 旧版单 apiKey 迁移为账号池
if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
  config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
  config.accountMode = 'single';
  config.activeAccount = 0;
  saveConfig();
}
config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single';

// perModel 配置升级：旧版单 upstream 迁移为有序多上游列表（upstream 保留为回滚兼容镜像）
(function migratePerModel() {
  let dirty = false;
  for (const c of Object.values(config.perModel || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.upstreams === undefined) { c.upstreams = c.upstream ? [c.upstream] : []; dirty = true; }
    if (c.exclude === undefined) { c.exclude = []; dirty = true; }
    if (!Array.isArray(c.upstreams)) { c.upstreams = []; dirty = true; }
    if (!Array.isArray(c.exclude)) { c.exclude = []; dirty = true; }
  }
  if (dirty) saveConfig();
})();

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [{ name: 'env-account', key: k, enabled: true }, ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

// 账号选择：roundrobin 在启用的账号间轮询；single 使用 activeAccount 指定的账号
let RR_COUNTER = 0;
function enabledAccounts() {
  return (config.accounts || []).filter((a) => a && a.key && a.enabled !== false);
}
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '' };
  if (config.accountMode === 'roundrobin' && list.length > 1) {
    const a = list[RR_COUNTER % list.length];
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
    return a;
  }
  const byIdx = config.accounts[config.activeAccount];
  if (byIdx && byIdx.key && byIdx.enabled !== false) return byIdx;
  return list[0];
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  return bearer === PROXY_KEY || admin === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchTls(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
  }
  return ids;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = String(e.tag || '').split('/')[0] || (e.provider_name || '').toLowerCase().replace(/\s+/g, '-');
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name, endpoints: 0, context: 0, uptime: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_30m || 0));
  }
  return { slug: real, endpoints: Object.values(detail) };
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

// Cline 自 2026-10 起在订阅模型前加了一层 VMC（虚拟模型配置）：真实路由 ID 形如
// vmc/<model>-fallbacks，第一跳固定是 Cline 自己的私有渠道 private/...-contributor
// （provider 显示为 openai-compatible-private），失败后才回落到 OpenRouter / Vercel 公共池。
// 私有渠道不吃 providerOptions.gateway.only，所以钉住只对"第二层"生效。
const PRIVATE_PROVIDER = 'openai-compatible-private';
const isPrivateSlug = (s) => typeof s === 'string' && s.startsWith('private/');

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  const modelAttempts = Array.isArray(rt.modelAttempts) ? rt.modelAttempts : [];
  // 实际尝试过的非私有 canonicalSlug（可用来到 OpenRouter 查同一模型的公共渠道）
  const publicSlugs = [...new Set(
    modelAttempts.map((a) => a?.canonicalSlug)
      .filter((s) => typeof s === 'string' && s.includes('/') && !isPrivateSlug(s)),
  )];
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
    // 命中的是 Cline 私有渠道 → 说明网关在钉住生效之前就消化了请求
    privateLayer: rt.finalProvider === PRIVATE_PROVIDER || isPrivateSlug(rt.canonicalSlug),
    publicSlugs,
  };
}

// 从网关错误文本里提取被允许的渠道清单。两种格式都兼容：
// - 规划器（Vercel）：`... Available providers are: alibaba, baseten, ... wafer","type":"invalid_request_error"`
// - 直连（OpenRouter）：`{"error":{"metadata":{"available_providers":[...]}}}`
function extractProviderSlugs(text) {
  const s = String(text || '');
  const found = new Set();
  const line = /Available providers are:\s*([^"]*)/.exec(s);
  if (line) {
    for (const part of line[1].split(/,\s*/)) {
      const v = part.trim().replace(/^["']|["'.]$/g, '');
      if (/^[a-z0-9][a-z0-9-]*$/.test(v)) found.add(v);
    }
  }
  const arr = /"available_providers"\s*:\s*\[([^\]]*)\]/.exec(s);
  if (arr) {
    for (const part of arr[1].split(',')) {
      const v = part.trim().replace(/^"|"$/g, '');
      if (/^[a-z0-9][a-z0-9-]*$/.test(v)) found.add(v);
    }
  }
  const NOT_SLUG = new Set(['the', 'and', 'type', 'message', 'error', 'code', 'metadata']);
  return [...found].filter((v) => !NOT_SLUG.has(v));
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// 注意：VMC 私有渠道会先接住请求（此时 only 被忽略、请求可能直接成功），
// 只有私有渠道不可用/限流时错误才从 Vercel 或 OpenRouter 冒出来，所以必须重试。
const PROBE_UPSTREAM = 'cp-probe-none';
async function harvestAvailableProviders(modelId, pipeline, { tries = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    const acc = pickAccount();
    const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
    const body = pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: [PROBE_UPSTREAM] } } }
      : { ...base, provider: { only: [PROBE_UPSTREAM] } };
    const { json } = await fetchJSON(
      `${config.upstreamBase}/chat/completions`,
      { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) },
      45000,
    ).catch(() => ({ json: null }));
    const err = json?.error;
    if (err != null) {
      const toks = extractProviderSlugs(typeof err === 'string' ? err : JSON.stringify(err));
      if (toks.length) return toks;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ---- 兜底/主枚举：OpenRouter 与 Vercel AI Gateway 的公开 endpoints 接口 ----
// Vercel 这个接口无需鉴权，返回的 provider 清单与网关报错里的一致（实测 18 个逐个吻合），
// 还带 uptime/延迟/吞吐，是比"假上游探针"更稳定的枚举源。openrouter 作为第二兜底。
const VG_API = 'https://ai-gateway.vercel.sh/v1';

async function vgEndpoints(slug) {
  if (!/^[A-Za-z0-9._/-]+$/.test(slug)) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${VG_API}/models/${slug}/endpoints`, {}, 30000);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = slugify(e.provider_name || String(e.tag || '').split('/')[0] || '');
    if (!pSlug) continue;
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name || pSlug, endpoints: 0, context: 0, uptime: 0, ttft: 0, tps: 0, prompt: 0, completion: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_1d || e.uptime_last_1h || 0));
    d.ttft = d.ttft || Math.round(e.latency_last_1h?.p50 || 0);
    d.tps = Math.max(d.tps, Math.round(e.throughput_last_1h?.p50 || 0));
    d.prompt = d.prompt || Number(e.pricing?.prompt || 0);
    d.completion = d.completion || Number(e.pricing?.completion || 0);
  }
  return { slug, endpoints: Object.values(detail) };
}

async function orSlugCandidates(modelId, meta = {}) {
  const out = new Set();
  for (const s of meta.publicSlugs || []) if (s.includes('/')) out.add(s);
  if (meta.canonicalSlug && String(meta.canonicalSlug).includes('/') && !isPrivateSlug(meta.canonicalSlug)) out.add(meta.canonicalSlug);
  const tail = norm(String(modelId || '').replace(/^cline-pass\//, ''));
  let ids = [];
  try { ids = await orModelList(); } catch { /* 目录拉取失败不影响主流程 */ }
  // 按模型名尾部匹配（cline-pass/deepseek-v4.1-flash → deepseek/deepseek-v4.1-flash）
  for (const id of ids) {
    if (norm(String(id).split('/').pop()) === tail) out.add(id);
  }
  return [...out];
}

// 依次尝试候选 slug：Vercel endpoints（权威）→ OpenRouter endpoints（参考）
async function enumerateUpstreams(modelId, meta = {}) {
  const slugs = await orSlugCandidates(modelId, meta);
  for (const slug of slugs) {
    try {
      const res = await vgEndpoints(slug);
      if (res.endpoints.length) return { source: 'vercel', slug: res.slug, upstreams: res.endpoints.map((e) => e.slug), detail: res.endpoints };
    } catch { /* 继续下一个候选 */ }
  }
  for (const slug of slugs) {
    try {
      const res = await orEndpoints(slug);
      if (res.endpoints.length) return { source: 'openrouter', slug: res.slug, upstreams: res.endpoints.map((e) => e.slug), detail: res.endpoints };
    } catch { /* 继续下一个候选 */ }
  }
  return null;
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId) {
  const t0 = Date.now();
  // 裸请求只用来判断管道与"实际命中的渠道"。VMC 私有渠道限流时会返回笼统的
  // "empty response content"，重试一次避免把偶发失败当成探测失败。
  let json = null;
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    const acc = pickAccount();
    const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
    const res = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
    }, 180000).catch(() => ({ json: { error: 'network error' } }));
    json = res.json;
    if (!(json?.error && !json?.data)) break;
    lastErr = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
    await new Promise((r) => setTimeout(r, 500));
  }
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) return { ok: false, error: lastErr || String(json.error) };

  const r = parseRouting(json);
  const prev = META.models[modelId] || {};
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  // 直连管道的 OpenRouter endpoint 明细（规划器管道留给兜底逻辑用）
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline !== 'planner' && r.canonicalSlug) {
    try {
      const res = await orEndpoints(r.canonicalSlug);
      endpoints = res.endpoints;
      orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  // 枚举公共渠道：优先用 Vercel/OpenRouter 的公开 endpoints 接口（稳定、零 token），
  // 假上游探针只在网关恰好透传错误时作为补充。
  let upstreamSource = harvest ? 'gateway' : null;
  let enumRes = null;
  if (!harvest || r.pipeline === 'planner') {
    enumRes = await enumerateUpstreams(modelId, { ...prev, canonicalSlug: r.canonicalSlug, publicSlugs: r.publicSlugs });
  }
  if (enumRes) {
    orSlug = orSlug || enumRes.slug;
    for (const e of enumRes.detail || []) endpoints.push(e);
    if (!harvest) {
      harvest = enumRes.upstreams;
      upstreamSource = enumRes.source;
    }
  }
  const detail = { ...prev.upstreamDetail };
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  // 规划器管道：验证换公共模型 ID 后 only 是否真被采纳（决定请求链路是否走 publicSlug）
  // avoidVmc=false 时完全不碰公共模型 ID（公共 ID 走 Credits 按量计费，不属于订阅额度）
  let publicRouteOk = false;
  if (config.avoidVmc !== false && r.pipeline === 'planner' && orSlug && upstreams.length) {
    publicRouteOk = await verifyPublicRoute(modelId, orSlug, upstreams);
  }
  // 订阅内的钉住方案：能力过滤 has 踢掉私有层（不碰公共模型 ID、不消耗 Credits）
  let hasPin = null;
  if (r.pipeline === 'planner' && upstreams.length >= 2) {
    hasPin = await probeHasPin(modelId, upstreams, r.pipeline);
  }
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    privateLayer: !!r.privateLayer,
    publicSlugs: r.publicSlugs?.length ? r.publicSlugs : (prev.publicSlugs || []),
    availableProviders: harvest || prev.availableProviders || [],
    upstreamSource: upstreamSource || prev.upstreamSource || null,
    canonicalSlug: r.canonicalSlug,
    publicSlug: orSlug || prev.publicSlug || null,
    publicRouteOk,
    // 订阅内钉住：has 能力过滤是否可用（planner 管道、不涉及公共 ID）
    hasPinOk: !!hasPin,
    gatewayHas: hasPin?.caps || prev.gatewayHas || null,
    hasPinVerifiedWith: hasPin?.verifiedWith || null,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  // 验证通过说明余额/路由都正常，清掉之前的直通封锁标记
  if (publicRouteOk) delete META.models[modelId].publicRouteBlocked;
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 钉住直通走的是 Cline Credits 公共计费（不是订阅额度）。余额耗尽时网关直接 402，
// 表现为"直通尝试失败 → 回退原 model → 命中私有渠道"，也就是用户看到的"路由偏离"。
// 一旦确认余额不足就短路：把 publicRouteOk 关掉，后续请求不再白打一次 402（充值后重新探测即可恢复）。
function noteCreditsExhausted(modelId, msg) {
  if (!/insufficient_credits|Insufficient balance/i.test(String(msg || ''))) return false;
  const meta = (META.models[modelId] ||= {});
  if (meta.publicRouteOk !== false || !meta.publicRouteBlocked) {
    meta.publicRouteOk = false;
    meta.publicRouteBlocked = { reason: 'insufficient_credits', note: String(msg).slice(0, 200), at: Date.now() };
    saveMeta();
  }
  return true;
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'unknown';                // 网关吞掉了真实原因（VMC 私有层失败时的通用错误），无法判定渠道状态
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const toks = extractProviderSlugs(errMsg);
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount();
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = msg.slice(0, 160);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      results[slug] = { status, ms: Date.now() - t0, note };
    }));
  }
  META.models[modelId] = { ...meta, upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, validatedAt: Date.now() };
  saveMeta();
  return results;
}

// 从官方接口、官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  const addModel = (value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string') return;
    const normalized = id.trim().toLowerCase();
    if (normalized.startsWith('cline-pass/')) found.add(normalized);
  };
  // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
  try {
    const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', {}, 30000);
    const list = json?.clinePass || json?.data?.clinePass;
    if (Array.isArray(list) && list.length) {
      list.forEach(addModel);
      sources.push('cline.api');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'] || json?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => addModel(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 官方文档表格兜底
  try {
    const res = await fetchTls('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

function record(modelId, info) {
  META.models[modelId] = { ...(META.models[modelId] || {}), ...info };
  META.history.unshift({ ts: Date.now(), model: modelId, ...info });
  if (META.history.length > 100) META.history.length = 100;
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return { status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  const r = parseRouting(d);
  return { status: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null, gatewayHas = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  // 管道未知时只发 Vercel 形式：实测同时带顶层 provider 与 providerOptions.gateway 会让网关直接 500。
  // 订阅模型绝大多数走规划器（Vercel），直连模型探测一次后就会走对分支。
  const useVercel = pipeline !== 'direct';
  const useOpenRouter = pipeline === 'direct';
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    // 能力过滤 has：VMC 私有渠道不满足该能力时会被排除，only 才有机会被评估（实测 2026-10）
    // 只在明确钉了某个上游时注入——自动模式下加 has 会把私有层整个排除掉，属于额外的行为改变
    if (gatewayHas && gatewayHas.length && upstream) gw.has = gatewayHas;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，排除的永不在候选中
// - 未勾选：单候选自动模式，排除换算成 only 白名单注入（见 injectPrefs）
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const base = { strict, sort, excludeList: exclude };
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.map((u, i) => ({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return [{ ...base, upstream: null, orderRest: [], excludeList: exclude }];
}

// 验证"换公共模型 ID 后 only 是否真的生效"：部分模型（如 deepseek-v4.1-flash）虽然是公共 ID，
// 但 Cline 仍按自己的规划器在所有渠道间加权，only 被静默忽略。只有 finalProvider 命中才算数。
async function verifyPublicRoute(modelId, publicSlug, upstreams) {
  const list = [...new Set(upstreams || [])];
  if (list.length < 2) return false;
  // 取首尾两个渠道各验一次：只验一个可能会撞上"默认就选中它"的假阳性
  // （deepseek-v4.1-flash 默认路由就是清单首位 alibaba，单点验证会误判）。
  for (const target of [list[0], list[list.length - 1]]) {
    const acc = pickAccount();
    const body = { model: publicSlug, messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 128, providerOptions: { gateway: { only: [target] } } };
    const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
    }, 120000).catch(() => ({ json: null }));
    if (json?.error && !json?.data) {
      noteCreditsExhausted(modelId, errText(json.error));
      return false;
    }
    if (parseRouting(json).finalProvider !== target) return false;
  }
  return true;
}

// 探测「能力过滤能否踢掉 VMC 私有层」：planner 管道上，has 命中私有渠道不满足的能力时，
// 私有层会被排除，providerOptions.gateway.only 才真正生效（实测 2026-10）。
// 逐个能力试，找到第一个能让 finalProvider 命中目标渠道的即可（全部走订阅额度，不消耗 Credits）。
const HAS_CAPS = ['vision', 'tool-use', 'implicit-caching', 'structured-output', 'reasoning'];
async function probeHasPin(modelId, upstreams, pipeline) {
  if (pipeline !== 'planner') return null;
  const list = [...new Set(upstreams || [])];
  if (list.length < 2) return null;
  // 用清单末尾的渠道做验证：首位常常是网关的默认选择，容易假阳性
  const target = list[list.length - 1];
  for (const cap of HAS_CAPS) {
    const acc = pickAccount();
    const body = {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with OK' }],
      max_tokens: 64,
      providerOptions: { gateway: { only: [target], has: [cap] } },
    };
    const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
    }, 120000).catch(() => ({ json: null }));
    if (json?.error && !json?.data) continue;
    if (parseRouting(json).finalProvider === target) return { caps: [cap], verifiedWith: target };
  }
  return null;
}

// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

// 规划器管道的钉住被 VMC 私有层挡在 only 之前（私有层不吃 gateway.only）。
// 实测：把 model 换成底层公共模型 ID 直接发（如 cline-pass/deepseek-v4.1-flash-1017 →
// deepseek/deepseek-v4.1-flash-1017），私有层不再参与，only 立刻生效。
// ⚠ 计费边界：只有 cline-pass/* 前缀吃订阅额度；换成公共 ID 就走 Cline Credits 按量计费，
// Credits 余额不足会直接 402（insufficient_credits），与订阅额度是否充足无关。
// 并非每个模型都有可用公共 ID，所以失败会自动回退原 cline-pass/* 请求。
// 可用 config.avoidVmc=false 关闭该行为。
function modelVariants(modelId) {
  const meta = META.models[modelId] || {};
  const out = [];
  if (config.avoidVmc !== false && meta.pipeline === 'planner' && meta.publicRouteOk && meta.publicSlug && meta.publicSlug !== modelId) {
    out.push({ model: meta.publicSlug, viaPublic: true });
  }
  out.push({ model: modelId, viaPublic: false });
  return out;
}

// 单次向上游网关发起非流式请求；返回 { status, out, routing, netError, acc }
// 异常（网络错误/非 JSON/非 200）不抛出，由调用方决定切换
async function attemptOnce(sendModel, prefsModelId, body, attempt, signal) {
  const send = { ...injectPrefs(body, prefsModelId, attempt), model: sendModel };
  const acc = pickAccount();
  try {
    const res = await fetchTls(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) return { status: 502, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc };
    const { status, body: out, routing } = unwrap(json);
    return { status, out, routing, netError: null, acc };
  } catch (e) {
    return { status: 502, out: { error: { message: `upstream fetch failed: ${e.message}`, type: 'upstream_error' } }, routing: {}, netError: e.message, acc };
  }
}

// 顺序故障转移：依次执行候选，非 200 / 网络失败 / 超时即切换下一个；全部失败返回最后一次结果。
// 流式：首包前（网关以 JSON 而非 SSE 应答错误）仍可切换；SSE 一旦开始即透传，无法重试。
// 每次尝试有独立的超时中止（attemptTimeoutMs）；客户端断开会中止当前尝试。
// 返回 { status, out, routing, acc, trace, streamUp? } —— trace 为逐次尝试 [{ upstream, status, ms, note }]
async function runChatChain(req, body, modelId, cfg, { stream = false, attemptTimeoutMs = 120000 } = {}) {
  const attempts = buildAttempts(modelId, cfg);
  const metaM = META.models[modelId] || {};
  // 每个上游候选再展开成「公共模型 ID 优先 / 原 model 兜底」两次尝试
  const variants = modelVariants(modelId);
  // planner 管道上，带 has 的版本排在前面：它能踢掉 VMC 私有层让 only 生效；失败自动退到无 has 版本
  const hasOpts = (metaM.pipeline === 'planner' && metaM.hasPinOk && Array.isArray(metaM.gatewayHas) && metaM.gatewayHas.length)
    ? [{ gatewayHas: metaM.gatewayHas, viaHas: true }, { gatewayHas: null, viaHas: false }]
    : [{ gatewayHas: null, viaHas: false }];
  const jobs = attempts.flatMap((a) => variants.flatMap((v) => hasOpts.map((h) => ({ ...a, sendModel: v.model, viaPublic: v.viaPublic, ...h }))));
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeCtrl = null;            // 当前尝试的 AbortController；流式成功后保持指向该次 fetch，用于断连时中止上游 body
  let keepCloseHook = false;        // 流式 SSE 建立后，close 钩子要保留到流结束
  const onClientClose = () => { if (activeCtrl) activeCtrl.abort(); };
  req.on('close', onClientClose);
  try {
    for (const attempt of jobs) {
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = { ...injectPrefs(body, modelId, attempt), model: attempt.sendModel };
          const acc = pickAccount();
          let up = null;
          let netError = null;
          try {
            up = await fetchTls(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal: ctrl.signal });
          } catch (e) { netError = e.message; }
          const ctype = up?.headers?.get('content-type') || '';
          let isSSE = !!up && up.status === 200 && ctype.includes('event-stream');
          // 网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}：
          // 读首个数据块探测，真正的 SSE 第一行是 "data: {...}" 且非纯错误对象
          let firstChunk = null;
          if (isSSE) {
            let reader = null;
            try {
              reader = up.body.getReader();
              const { value, done } = await reader.read();
              if (done) {
                isSSE = false;
                netError = 'empty stream';
              } else {
                firstChunk = Buffer.from(value);
                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);
                if (head.startsWith('data:')) {
                  const payload = head.replace(/^data:\s*/, '').slice(0, 160);
                  if (payload.startsWith('{"error"')) { isSSE = false; netError = `stream error: ${payload.slice(0, 120)}`; }
                } else {
                  isSSE = false;
                  netError = `unexpected stream head: ${head.slice(0, 60)}`;
                }
              }
            } catch (e) {
              isSSE = false;
              netError = e.message;
            } finally {
              try { reader?.releaseLock(); } catch {}
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let text = '';
            let json = null;
            if (firstChunk) {
              // 已消费的块 + 剩余 body 拼回完整错误文本
              const rest = await up.text().catch(() => '');
              text = firstChunk.toString('utf8') + rest;
            } else {
              text = await up.text();
            }
            try { json = JSON.parse(text); } catch {}
            const msg = errText(json?.error) || text.slice(0, 160) || netError;
            trace.push({ model: attempt.sendModel, viaPublic: attempt.viaPublic, viaHas: attempt.viaHas, upstream: attempt.upstream, status: up.status, ms, note: msg.slice(0, 160) });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (attempt.viaPublic) noteCreditsExhausted(modelId, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            last = { status: json?.error ? 502 : up.status, out: json || { error: { message: text.slice(0, 400) || netError, type: 'upstream_error' } }, routing: parseRouting(json || {}), acc, netError: null };
            continue; // 错误：还未向客户端写任何字节，可切换下一候选
          }
          if (!up) {
            trace.push({ model: attempt.sendModel, viaPublic: attempt.viaPublic, viaHas: attempt.viaHas, upstream: attempt.upstream, status: 502, ms, note: netError || 'no response' });
            last = { status: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc, netError: netError || 'no response' };
            continue;
          }
          // 真 SSE：firstChunk 与剩余 body 串联透传（SSE 开始后无法重试）；close 钩子保留用于客户端断开时中止上游
          keepCloseHook = true;
          trace.push({ model: attempt.sendModel, viaPublic: attempt.viaPublic, viaHas: attempt.viaHas, upstream: attempt.upstream, status: 200, ms, note: 'stream' });
          return { status: 200, streamUp: up, streamHead: firstChunk, acc, trace, t0 };
        }
        // 非流式
        const r = await attemptOnce(attempt.sendModel, modelId, body, attempt, ctrl.signal);
        const ms = Date.now() - t1;
        const note = r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok');
        trace.push({ model: attempt.sendModel, viaPublic: attempt.viaPublic, viaHas: attempt.viaHas, upstream: attempt.upstream, status: r.status, ms, note });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && attempt.viaPublic) noteCreditsExhausted(modelId, errText(r.out?.error?.message) || note);
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        last = r;
        if (r.status === 200) break;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!keepCloseHook) req.off('close', onClientClose);
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  const modelId = body.model;
  if (!modelId) return sendJSON(res, 400, { error: { message: 'model is required' } });

  const cfg = config.perModel[modelId] || {};
  const targets = buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean);
  const isStream = !!body.stream;

  const chain = await runChatChain(req, body, modelId, cfg, { stream: isStream });

  if (isStream && chain.streamUp) {
    // 流式透传：先写已探测的首块，再接剩余 body；tap 在结束时回读路由元数据并记录
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    const ctype = up.headers.get('content-type') || 'text/event-stream';
    res.writeHead(up.status, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
    });
    if (chain.streamHead) res.write(chain.streamHead);
    const buf = [];
    const tap = new Transform({
      transform(c, enc, cb) { buf.push(c); cb(null, c); },
      flush(cb) {
        const text = Buffer.concat(buf).toString('utf8');
        let provider = null, canonical = null;
        // direct 管道：最后一个 chunk 顶层带 provider（显示名）与 model
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10 && !provider; i--) {
          const l = lines[i];
          if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
          try {
            const c = JSON.parse(l.slice(6));
            if (typeof c.provider === 'string') { provider = slugify(c.provider); canonical = c.model || null; }
          } catch { /* 跳过不完整行 */ }
        }
        // planner 管道：final chunk 的 provider_metadata.gateway.routing
        if (!provider) {
          const fp = /"finalProvider":"([^"]+)"/.exec(text);
          const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
          provider = fp ? fp[1] : null;
          canonical = cs ? cs[1] : null;
        }
        record(modelId, { provider, canonical, ms: Date.now() - t0, stream: true, error: null, account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace });
        cb();
      },
    });
    Readable.fromWeb(up.body).pipe(tap).pipe(res);
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  // 严格钉住的命中校验（enforcePin）：宁可直接报错，也不让调用方拿到"其实换了上游"的结果。
  // 只对非流式生效——流式的 provider 元数据在末尾 chunk，写响应头时还无法判定。
  if (config.enforcePin === true && status === 200) {
    const target = ((cfg.upstreams || []).find((u) => u) || null);
    const strict = (cfg.pinMode || 'strict') === 'strict';
    if (strict && target && routing.finalProvider !== target) {
      record(modelId, {
        provider: routing.finalProvider || null, canonical: routing.canonicalSlug || null,
        ms: Date.now() - chain.t0, stream: false, attempts: chain.trace.map((t) => t.upstream || 'auto'),
        trace: chain.trace, error: `pin_mismatch: ${routing.finalProvider}`, account: acc ? acc.name : null,
      });
      return sendJSON(res, 409, {
        error: {
          message: `pin_mismatch: 目标上游 ${target}，实际 ${routing.finalProvider || '未知'}。enforcePin 已开启，拒绝返回非目标上游的结果。`,
          type: 'pin_mismatch',
        },
        target, actual: routing.finalProvider || null, trace: chain.trace,
      });
    }
  }
  // 客户端实际使用成功的新订阅模型自动收录进列表
  if (status === 200 && /^cline-pass\//.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
  });
  res.end(JSON.stringify(out));
}

// ---------- HTTP 服务 ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/') || CHAT_PATHS.has(p)) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const sub = config.knownModels.map((id) => ({ id, config: config.perModel[id] || {}, meta: META.models[id] || null }));
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/test') {
      // 临时配置可带 upstreams/exclude（数组）或旧版 upstream（单值），完整走故障转移链路
      const { model, upstream, upstreams, exclude } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const t0 = Date.now();
      const cfg = { ...(config.perModel[model] || {}) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      const chain = await runChatChain(req, body, model, cfg, { stream: false, attemptTimeoutMs: 180000 });
      const trace = chain.trace || [];
      if (chain.status !== 200) {
        return sendJSON(res, 200, {
          ok: false, error: (chain.out?.error?.message || 'upstream error').slice?.(0, 400) || 'upstream error',
          targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace,
        });
      }
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, {
        ok: true, ms: Date.now() - t0,
        targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [],
        actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null,
        privateLayer: !!r.privateLayer, publicSlugs: r.publicSlugs,
        canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120),
        account: chain.acc?.name || null, trace,
      });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJSON(res, 200, {
        accounts: config.accounts,
        mode: config.accountMode,
        active: config.activeAccount,
        stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const accs = (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a, i) => ({
          name: String(a.name || `账号${i + 1}`).slice(0, 50),
          key: String(a.key || '').trim(),
          enabled: a.enabled !== false,
        }))
        .filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      config.accounts = accs;
      config.accountMode = body.mode === 'roundrobin' ? 'roundrobin' : 'single';
      config.activeAccount = Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      saveConfig();
      RR_COUNTER = 0;
      return sendJSON(res, 200, { ok: true, accounts: config.accounts.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = JSON.parse(await readBody(req).then((b) => b.toString()));
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'GET' && p === '/api/security') {
      return sendJSON(res, 200, { proxyKey: config.proxyKey || '', publicBaseUrl: config.publicBaseUrl || '', authRequired: !!PROXY_KEY, exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.proxyKey !== undefined) config.proxyKey = String(body.proxyKey).trim();
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, { ok: true, proxyKey: config.proxyKey, publicBaseUrl: config.publicBaseUrl, authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const results = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels });
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.perModel) {
        for (const [m, c] of Object.entries(body.perModel)) {
          const normalize = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
          let upstreams = normalize(c.upstreams);
          const exclude = normalize(c.exclude);
          const excl = new Set(exclude);
          upstreams = upstreams.filter((u) => !excl.has(u)); // 同时出现以 exclude 为准
          const upstream = upstreams[0] || null; // 旧字段兼容镜像
          config.perModel[m] = {
            upstream,
            upstreams,
            exclude,
            pinMode: c.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: ['cost', 'ttft', 'tps'].includes(c.sort) ? c.sort : null,
          };
        }
        saveConfig();
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog())])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, 500, { error: { message: e.message } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

server.on('error', (e) => {
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1`);
});
