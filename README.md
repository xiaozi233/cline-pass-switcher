# Cline Pass 上游控制台（cline-pass-switcher）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

**零依赖**的 Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🩹 **VMC 私有层处理（2026-10 新增）** —— Cline 现在给订阅模型加了一层私有渠道前置（`openai-compatible-private`），不吃 `only`；
  控制台会自动探测 `providerOptions.gateway.has` 能力过滤能否把它排除，从而**在订阅内**精确钉住上游（不消耗 Credits）
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 👥 **账号池** —— 多账号管理、手动切换、轮询均衡、逐账号连通性测试与用量统计
- 📊 **观测** —— 每条请求自动记录实际命中的渠道、背后模型、耗时（含流式）
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## 30 秒上手（本地）

```bash
git clone https://github.com/<你的用户名>/cline-pass-switcher.git
cd cline-pass-switcher
node server.js        # 仅需 Node ≥ 18，无需 npm install
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。
没有 key 也能启动：页面会提示配置入口。

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有一个性化反代（nginx 门户等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端访问代理的凭据） |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ name, key, enabled }]` |
| `accountMode` | `single` 手动指定 / `roundrobin` 轮询 |
| `activeAccount` | 单账号模式下使用的下标 |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `avoidVmc` | 是否允许把 planner 请求换成底层公共模型 ID 以绕开 VMC 私有层；**默认 `false`**（公共 ID 走 Cline Credits 按量计费，不属于订阅额度，余额不足会 402） |
| `enforcePin` | 严格钉住的命中校验：**默认 `false`**；开启后非流式请求若实际命中 ≠ 目标上游，直接返回 `409 pin_mismatch`，而不是静默返回别的上游结果（流式不适用，provider 元数据在末尾 chunk） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `perModel` | 每模型的钉住配置：`{ upstream, pinMode: strict|preferred, sort: cost|ttft|tps, maxRetries }` |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。
参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`，并新增 `modelAttempts`（逐次尝试的 canonicalSlug 与 provider）；直连管道顶层 `provider` 即实际上游；
2. **网关公开 endpoints 接口（当前主用）**：`GET https://ai-gateway.vercel.sh/v1/models/{slug}/endpoints` 无需鉴权，
   返回的 provider 清单与网关报错里的一致，还带可用率 / 延迟 / 吞吐；OpenRouter 的 `/{slug}/endpoints` 作第二兜底；
3. **假上游探测**（零 token，已降级为补充）：带不存在的 `only` 让网关报出渠道清单。两条管道写法不同（顶层 `provider` vs `providerOptions.gateway`）。

### 订阅内钉住：`has` 能力过滤（2026-10 实测，推荐）

`only` 单独发没用，是因为请求被私有层接住了。但给同一个请求再加上
`providerOptions.gateway.has`（要求上游具备某项能力）之后，**不满足该能力的私有渠道会被排除**，
请求直接落到 Vercel 公共层，`only` 这时才被真正评估：

```json
{
  "model": "cline-pass/deepseek-v4.1-flash-1017",
  "providerOptions": {
    "gateway": { "only": ["deepseek"], "has": ["vision"] }
  }
}
```

实测（2026-10-23，模型保持 `cline-pass/` 前缀）：

| 请求 | finalProvider |
|---|---|
| `only:["deepseek"]` | `openai-compatible-private`（私有层） |
| `only:["deepseek"]` + `has:["vision"]` | ✔ `deepseek`，plan 变成 `Provider set restricted to: deepseek` |
| `only:["baseten"]` + `has:["vision"]` | ✔ `baseten`（574ms） |
| 同上，流式 | ✔ 首个 chunk 即钉到 `deepseek` |
| 只加 `has:["vision"]` 不写 only | 私有层同样被排除（落到公共层自动选） |

**计费**：模型仍是 `cline-pass/*`，走订阅额度。实测前后 Credits 余额 `0.007764` 一分未变。

**自适应**：「探测」会用 `vision / tool-use / implicit-caching / structured-output / reasoning`
逐个试一次，找到第一个能让 `finalProvider` 命中目标渠道的能力就记下来（`hasPinOk` + `gatewayHas`）。
找到则请求默认带该 `has`，命中不了会**自动退回不带 has 的版本**，保证不会因为能力过滤把请求打挂。

**已知边界**：
- 只对 planner 管道有效；直连管道（`glm-5.3-flash`）加 `providerOptions` 会 500，不要加。
- 私有层是否被排除，取决于它是否声明了该能力。实测 `deepseek-v4.1-flash-1017` 全部能力都能踢掉，
  而 `deepseek-v4.1-flash` 的任何能力组合都踢不掉（`hasPinOk` 会记为 false，退回原行为）。
- `has` 是**真实的能力约束**：钉住的渠道本身不支持该能力时会失败，此时会自动回退到无 has 版本（不钉住但可用）。

### 2026-10 网关变化：VMC 私有层

Cline 给订阅模型套了一层 **VMC（虚拟模型配置）**：真实路由 ID 变成 `vmc/<model>-fallbacks`，**第一跳固定是 Cline 自己的私有渠道**
`private/...-contributor`（响应里显示为 `openai-compatible-private`），失败后才回落到 Vercel 公共池。
这一层**不吃 `providerOptions.gateway.only`**，所以：

- 私有渠道健康时，请求被它直接接住 → 表现为「钉住不生效」，`lastProvider` 恒为 `openai-compatible-private`；
- 私有渠道失败时，错误才从 Vercel 冒出来，假上游探针也才偶尔能拿到清单（其余时候被统一吞成 `empty response content`）。

绕过私有层有两条路：上面说的 `has` 能力过滤（订阅内，推荐），或者把 model 换成底层公共模型 ID（出订阅、按 Credits 计费，默认禁用）。

**可以走通的路径（默认关闭，需手动开启 `avoidVmc: true`）**：把请求的 `model` 换成底层公共模型 ID，
私有层不再参与，`only` 立即精确生效（实测 `cline-pass/deepseek-v4.1-flash-1017` → `deepseek/deepseek-v4.1-flash-1017`，钉 baseten/deepseek/wafer 全部命中）：

```json
{ "model": "deepseek/deepseek-v4.1-flash-1017", "providerOptions": { "gateway": { "only": ["wafer"] } } }
```

> ⚠ **计费边界（关键）**：只有 `cline-pass/*` 前缀吃订阅额度。一旦换成公共 ID，请求就走 **Cline Credits 按量计费**，
> 与订阅的 5 小时 / 周 / 月配额无关。Credits 余额不足时网关直接返回 `402 insufficient_credits`，
> 表现就是「直通失败 → 回退 `cline-pass/*` → 命中私有渠道」，看起来像随机偏移。
> 因此该模式默认关闭；开启后一旦检测到 402 会自动停用并标记「直通已禁用·余额不足」，避免每条请求白打一次。

探测时会用清单首尾两个渠道各验一次，只有两次都命中才标记 **钉住直通**（绿色徽章）；验证不过的模型（如 `deepseek-v4.1-flash`）
自动回退到原 `cline-pass/*` 请求。`avoidVmc: false`（默认）时完全不碰公共模型 ID。

> 直连管道的模型（如 `glm-5.3-flash`）本来就吃顶层 `provider.only`，无需直通。

### 能否「强制固定」某一个 provider

分三种情况，结论不同：

| 场景 | 能否强制 | 说明 |
|---|---|---|
| 直连管道（`glm-5.3-flash` 等） | ✔ 能 | 顶层 `provider.only: [X]` + `pinMode: strict`，失败直接报错，不会换 |
| 规划器管道 + `cline-pass/*` + `has` 能力过滤 | ✔ 能（订阅内） | 私有层不满足该能力时被排除，`only` 才被评估；见上一节 |
| 规划器管道 + `cline-pass/*`，只有 `only` | ✘ 不能 | 私有层在 only 之前接住请求；只写 `only` 时 `finalProvider` 恒为 `openai-compatible-private`，plan 里连 `Provider set restricted to` 都不出现 |
| 规划器管道 + 公共模型 ID | ✔ 能 | `only` 精确生效，但请求出了订阅、按 Credits 计费（默认禁用） |

想要「要么命中、要么报错」的语义，开 `enforcePin: true`：非流式请求命中不符直接 409，不给调用方一个"其实换了上游"的结果。
注意它只能兜底告警，不能改变网关的路由决定；被拒的那次请求额度已经消耗掉了。

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

### 实测记录（2026-10，VMC 上线后）

| 实验 | 结果 |
|---|---|
| `cline-pass/deepseek-v4.1-flash-1017` + `gateway.only:["baseten"]` | ✘ 被 `openai-compatible-private` 接住，only 未评估 |
| `deepseek/deepseek-v4.1-flash-1017` + `gateway.only:["baseten"]` | ✔ `finalProvider: baseten`，`Provider set restricted to: baseten` |
| 同上，流式 | ✔ 首个 chunk 即钉住渠道，`provider in stream: baseten` |
| `deepseek/deepseek-v4.1-flash` + `gateway.only:["baseten"]` | ✘ 落到 alibaba，规划器忽略 only → 该模型无直通 |
| 假上游 `only:["__probe__"]` | ✘ 私有层吞掉请求，返回 200 或 `empty response content` |
| `GET ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4.1-flash-1017/endpoints` | ✔ 18 个 provider，与报错清单完全一致 |
| `private/deepseek-v4p1-flash-1017-contributor` 直接请求 | ✘ `402 insufficient_credits`（私有 ID 也不属于订阅） |
| `cline-pass/*` + Credits 余额 $0.0078 | ✔ 200，不扣 Credits（订阅内） |
| `deepseek/*` 或 `private/*` + 订阅额度充足但 Credits 为 0 | ✘ `402 insufficient_credits` —— 订阅额度只管 `cline-pass/*` |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

---

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 账号池增删改、显隐密钥、逐账号连通性测试、单账号/轮询模式、用量统计 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求历史 | 自动记录每条请求的账号、实际渠道、耗时、尝试序列（最近 100 条，含流式） |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式、错误统一为
`{"error":{"message":...}}`、附加 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account` 等响应头。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**
部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**
能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

**Q：直接用官方 API 写 `provider.only` 为什么不生效？**
对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。

**Q：两条管道的渠道清单为什么不一样？**
钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**
经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

---

## 安全提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- 对外部署务必设置 `proxyKey`（控制台可随时轮换）；
- 「重试博弈」`maxRetries > 0` 时会放大请求量，注意额度消耗。

## License

[MIT](LICENSE)
