import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchWithProxy, proxyForUrl, proxyEnvironment } from '../proxy.mjs';
import { getGlmInfo } from '../glm.mjs';
import { setup } from '../setup.mjs';

// 仅用于本地模拟服务的公开测试密钥，不用于真实请求。
const cert = await fs.readFile(new URL('./fixtures/proxy-cert.pem', import.meta.url));
const key = await fs.readFile(new URL('./fixtures/proxy-key.pem', import.meta.url));

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function fixture(t, { secureProxy = false, status = 200, stall = false, tlsStall = false, handler } = {}) {
  // 实际执行 TLS 握手与域名校验，只增加对测试证书的信任。
  const connect = tls.connect;
  t.mock.method(tls, 'connect', (options, ...args) => connect({ ...options, ca: cert }, ...args));
  const received = [];
  const origin = tlsStall ? net.createServer() : https.createServer({ key, cert }, handler || ((req, res) => {
    received.push({ url: req.url, headers: req.headers, servername: req.socket.servername });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('/quota/')
      ? { data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } }
      : { code: 200, data: { balance: 46.2 } }));
  }));
  const originPort = await listen(t, origin);
  const tunnels = [];
  const proxy = secureProxy ? https.createServer({ key, cert }) : http.createServer();
  proxy.on('connect', (req, client, head) => {
    tunnels.push({ url: req.url, headers: req.headers });
    if (stall) return;
    if (status !== 200) {
      client.end(`HTTP/1.1 ${status} Rejected\r\n\r\n`);
      return;
    }
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-proxy-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  return { received, tunnels, cacheDir, reject: (code) => { status = code; },
    proxyUrl: `${secureProxy ? 'https' : 'http'}://127.0.0.1:${proxyPort}`,
  };
}

test('proxy selection supports precedence, fallback, lowercase and Claude settings', () => {
  const target = 'https://open.bigmodel.cn/api';
  assert.equal(proxyForUrl(target, {}), null);
  assert.equal(proxyForUrl(target, { HTTPS_PROXY: 'proxy.example:8080' }).href, 'http://proxy.example:8080/');
  assert.equal(proxyForUrl(target, { HTTPS_PROXY: 'http://secure', HTTP_PROXY: 'http://fallback' }).hostname, 'secure');
  assert.equal(proxyForUrl(target, { HTTP_PROXY: 'http://fallback' }).hostname, 'fallback');
  assert.equal(proxyForUrl(target, { ALL_PROXY: 'http://all' }).hostname, 'all');
  assert.equal(proxyForUrl(target, { https_proxy: 'http://lower', HTTPS_PROXY: 'http://upper' }).hostname, 'lower');
  assert.equal(proxyForUrl('http://example.com', { HTTP_PROXY: 'http://plain', HTTPS_PROXY: 'http://secure' }).hostname, 'plain');
  const env = proxyEnvironment({ HTTPS_PROXY: 'http://settings', NO_PROXY: '.bigmodel.cn' }, { https_proxy: 'http://process' });
  assert.equal(env.HTTPS_PROXY, 'http://process');
  assert.equal(env.NO_PROXY, '.bigmodel.cn');
  assert.equal(proxyEnvironment({ https_proxy: 'http://settings' }, { HTTPS_PROXY: '' }).HTTPS_PROXY, '');
});

test('NO_PROXY matches hosts, domain boundaries, ports, wildcard and IPv6', () => {
  const proxy = { HTTPS_PROXY: 'http://proxy' };
  for (const pattern of ['*', 'open.bigmodel.cn', '.bigmodel.cn', '*.bigmodel.cn', 'open.bigmodel.cn:443',
    'example.org, OPEN.BIGMODEL.CN other.org']) {
    assert.equal(proxyForUrl('https://open.bigmodel.cn/api', { ...proxy, NO_PROXY: pattern }), null);
  }
  for (const pattern of ['bigmodel.cn', '.model.cn', 'open.bigmodel.cn:80', 'example.org']) {
    assert.ok(proxyForUrl('https://open.bigmodel.cn/api', { ...proxy, NO_PROXY: pattern }));
  }
  assert.ok(proxyForUrl('https://notbigmodel.cn', { ...proxy, NO_PROXY: '.bigmodel.cn' }));
  assert.equal(proxyForUrl('https://[::1]:8443', { ...proxy, no_proxy: '[::1]:8443' }), null);
});

test('invalid proxies report a diagnostic without exposing credentials', () => {
  for (const address of ['http://user:secret@', 'http://user:%ZZ@proxy', 'socks5://user:secret@proxy']) {
    assert.throws(() => proxyForUrl('https://open.bigmodel.cn', { HTTPS_PROXY: address }),
      (error) => /代理/.test(error.message) && !error.message.includes('secret') && !error.message.includes('%ZZ'));
  }
});

test('absent proxies preserve the default fetch path', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return { ok: true }; });
  assert.equal((await fetchWithProxy('https://open.bigmodel.cn', { headers: {} }, {})).ok, true);
  assert.equal(calls, 1);
});

test('NO_PROXY makes a real direct request without consulting global fetch or agents', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected global fetch'); });
  t.mock.method(http.globalAgent, 'addRequest', () => { throw new Error('unexpected global agent'); });
  const server = http.createServer((req, res) => res.end('{"direct":true}'));
  const port = await listen(t, server);
  const response = await fetchWithProxy(`http://127.0.0.1:${port}/`,
    { headers: {}, signal: AbortSignal.timeout(2000) },
    { HTTP_PROXY: 'http://unreachable.invalid', NO_PROXY: '127.0.0.1' });
  assert.deepEqual(await response.json(), { direct: true });
});

for (const secureProxy of [false, true]) {
  test(`plan and balance work through an ${secureProxy ? 'HTTPS' : 'HTTP'} CONNECT proxy`, async (t) => {
    const f = await fixture(t, { secureProxy });
    const proxyUrl = f.proxyUrl.replace('://', '://user:p%40ss@');
    // HTTPS 代理外层证书也需要信任测试 CA。
    if (secureProxy) {
      const request = https.request;
      t.mock.method(https, 'request', (input, ...args) => input.method === 'CONNECT'
        ? request({ ...input, ca: cert }, ...args) : request(input, ...args));
    }
    const info = await getGlmInfo({ key: 'test-api-key', cacheDir: f.cacheDir,
      proxyEnv: { HTTPS_PROXY: proxyUrl }, timeoutMs: 2000 });
    assert.equal(info.ok, true, info.error);
    assert.equal(info.five.usedPct, 38);
    assert.equal(info.balance, 46.2);
    assert.deepEqual(f.tunnels.map((req) => req.url).sort(), ['bigmodel.cn:443', 'open.bigmodel.cn:443']);
    for (const req of f.tunnels) {
      assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
      assert.equal(req.headers.authorization, undefined);
    }
    for (const req of f.received) {
      assert.equal(req.headers.authorization, req.url.includes('/quota/') ? 'test-api-key' : 'Bearer test-api-key');
      assert.equal(req.headers['proxy-authorization'], undefined);
      assert.equal(req.servername, req.url.includes('/quota/') ? 'open.bigmodel.cn' : 'bigmodel.cn');
    }
    const international = await getGlmInfo({ key: 'test-api-key', platform: 'en', cacheDir: f.cacheDir,
      proxyEnv: { ALL_PROXY: f.proxyUrl }, timeoutMs: 2000 });
    assert.equal(international.ok, true, international.error);
    assert.equal(international.balance, null);
    assert.equal(f.tunnels.at(-1).url, 'api.z.ai:443');
  });
}

test('proxy rejection preserves stale data, reports proxy error and releases locks', async (t) => {
  const f = await fixture(t);
  const env = { HTTPS_PROXY: f.proxyUrl };
  const options = { key: 'test-key', cacheDir: f.cacheDir, proxyEnv: env, force: true };
  assert.equal((await getGlmInfo(options)).ok, true);
  f.reject(407);
  const info = await getGlmInfo(options);
  assert.equal(info.ok, true);
  assert.equal(info.stale, true);
  assert.equal(info.five.usedPct, 38);
  assert.match(info.partialError, /代理连接失败.*407/);
  const failed = await getGlmInfo({ ...options, staleSec: 0 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /代理连接失败.*407/);
  assert.ok(!(await fs.readdir(f.cacheDir)).some((name) => name.endsWith('.lock')));
});

for (const stage of ['CONNECT', 'TLS', 'response']) {
  test(`timeout covers a stalled ${stage} and releases the cache lock`, async (t) => {
    const f = await fixture(t, { stall: stage === 'CONNECT', tlsStall: stage === 'TLS', handler: stage === 'response'
      ? (req, res) => { res.writeHead(200); res.write('{'); } : undefined });
    const start = performance.now();
    const info = await getGlmInfo({ key: 'test-key', showBalance: false, cacheDir: f.cacheDir,
      proxyEnv: { HTTPS_PROXY: f.proxyUrl }, timeoutMs: 150 });
    assert.equal(info.error, '查询超时');
    assert.ok(performance.now() - start < 2000);
    assert.ok(!(await fs.readdir(f.cacheDir)).some((name) => name.endsWith('.lock')));
  });
}

test('TLS hostname validation remains enabled inside the proxy tunnel', async (t) => {
  const f = await fixture(t);
  await assert.rejects(fetchWithProxy('https://wrong-host.invalid/',
    { headers: {}, signal: AbortSignal.timeout(2000) }, { HTTPS_PROXY: f.proxyUrl }),
  { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('redirects use the same proxy policy and strip credentials across origins', async (t) => {
  const seen = [];
  const f = await fixture(t, { handler: (req, res) => {
    seen.push(req.headers.authorization);
    if (seen.length === 1) res.writeHead(302, { Location: 'https://bigmodel.cn/next' }).end();
    else res.end('{"success":true}');
  } });
  const response = await fetchWithProxy('https://open.bigmodel.cn/first',
    { headers: { Authorization: 'test-key' }, signal: AbortSignal.timeout(2000) }, { HTTPS_PROXY: f.proxyUrl });
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(seen, ['test-key', undefined]);
});

test('installed CLI reads proxies from Claude settings for query and status line', async (t) => {
  const f = await fixture(t);
  const home = path.join(f.cacheDir, 'home');
  const claudeDir = path.join(home, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_AUTH_TOKEN: 'fixture-api-key', HTTPS_PROXY: f.proxyUrl,
  } }));
  const installed = await setup({ claudeDir });
  await fs.writeFile(installed.configPath, JSON.stringify({ segments: ['glm'], cacheTtlSeconds: 0 }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(https?_proxy|all_proxy|no_proxy|glm_api_key|glm_statusline_config|anthropic_base_url|node_use_env_proxy)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: f.cacheDir, TEMP: f.cacheDir, TMPDIR: f.cacheDir,
    NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('./fixtures/proxy-cert.pem', import.meta.url)),
    GLM_STATUSLINE_CONFIG: installed.configPath });
  const run = promisify(execFile);
  const script = path.join(installed.installDir, 'statusline.mjs');
  const query = await run(process.execPath, [script, '--query'], { env, timeout: 5000 });
  assert.equal(JSON.parse(query.stdout).five.usedPct, 38);
  const rendering = run(process.execPath, [script], { env, timeout: 5000 });
  rendering.child.stdin.end('{}');
  assert.match((await rendering).stdout, /5h 62%/);
  assert.equal(f.tunnels.length, 4);
});
