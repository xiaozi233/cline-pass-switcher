import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function waitForProxy(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`proxy exited early (${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error('proxy did not start in time');
}

test('proxy survives upstream stream interruption and downstream disconnect', { timeout: 20000 }, async (t) => {
  let mode = 'premature-close';
  let holdStartedResolve;
  let holdClosedResolve;
  let holdStarted = new Promise((resolve) => { holdStartedResolve = resolve; });
  let holdClosed = new Promise((resolve) => { holdClosedResolve = resolve; });

  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'premature-close') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '1000' });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (mode === 'hold') {
        res.on('close', holdClosedResolve);
        holdStartedResolve();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
  });

  const upstreamPort = await listen(upstream);
  const proxyPort = await (async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    return port;
  })();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cline-pass-stream-'));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    port: proxyPort,
    proxyKey: '',
    apiKey: '',
    accounts: [{ name: 'test', key: 'local-test-key', enabled: true }],
    activeAccount: 0,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    knownModels: [],
    perModel: {},
  }));

  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(proxyPort), BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const proxyURL = `http://127.0.0.1:${proxyPort}`;
  const chatURL = `${proxyURL}/v1/chat/completions`;
  await waitForProxy(proxyURL, child);
  const body = JSON.stringify({ model: 'test/model', stream: true, messages: [{ role: 'user', content: 'hello' }] });

  const interrupted = await fetch(chatURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(interrupted.status, 200);
  await assert.rejects(interrupted.text());
  assert.equal(child.exitCode, null, output);

  mode = 'hold';
  holdStarted = new Promise((resolve) => { holdStartedResolve = resolve; });
  holdClosed = new Promise((resolve) => { holdClosedResolve = resolve; });
  const controller = new AbortController();
  const pending = fetch(chatURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
  await holdStarted;
  controller.abort();
  await assert.rejects(pending);
  let timeout;
  try {
    await Promise.race([holdClosed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('client disconnect did not cancel upstream')), 3000);
    })]);
  } finally {
    clearTimeout(timeout);
  }

  mode = 'complete';
  const recovered = await fetch(chatURL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /\[DONE\]/);
  assert.equal(child.exitCode, null, output);
  assert.equal((await fetch(proxyURL)).status, 200);
  assert.match(output, /\[流中断\]/, output);
  assert.doesNotMatch(output, /Cannot pipe to a closed or destroyed stream/, output);
});
