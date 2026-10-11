import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { getGlmInfo, parsePlan, parseBalance } from '../glm.mjs';

const body = (percentage = 38) => ({ data: { level: 'pro', limits: [
  { type: 'TOKENS_LIMIT', unit: 3, percentage },
  { type: 'TOKENS_LIMIT', unit: 6, percentage: 12 },
] } });
const response = (data) => ({ ok: true, status: 200, json: async () => data });

async function setup(t) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-statusline-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let failPlan = false;
  let failBalance = false;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    const isPlan = url.includes('/quota/');
    if (isPlan ? failPlan : failBalance) throw new Error('offline');
    return response(isPlan ? body() : { code: 200, data: { availableBalance: 46.2 } });
  });
  return {
    query: (options = {}) => getGlmInfo({ key: 'test-key', cacheDir, ...options }),
    cacheDir, requests,
    tick: (ms) => { now += ms; },
    fail: (plan = true, balance = true) => { failPlan = plan; failBalance = balance; },
  };
}

test('parsers preserve zero, numeric strings, reset timestamps and bucket units', () => {
  const plan = parsePlan({ data: { limits: [
    { type: 'CREDIT_LIMIT', unit: '6', percentage: '20', nextResetTime: '1800000000' },
    { type: 'TOKENS_LIMIT', unit: '3', percentage: 0 },
  ] } });
  assert.equal(plan.five.usedPct, 0);
  assert.equal(plan.weekly.usedPct, 20);
  assert.equal(plan.weekly.resetMs, 1_800_000_000_000);
  assert.equal(parseBalance({ code: '200', data: { availableBalance: '0', balance: 99 } }), 0);
});

test('invalid or missing quota and balance values never become fabricated zeroes', () => {
  for (const value of [undefined, null, '', ' ', false, [], {}, 'bad', Infinity]) {
    assert.throws(() => parsePlan(body(value === undefined ? 'bad' : value)));
    assert.throws(() => parseBalance({ code: 200, data: { balance: value } }));
  }
  assert.throws(() => parsePlan({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3 }] } }));
  assert.throws(() => parsePlan({ data: { limits: [] } }));
  assert.throws(() => parsePlan({ success: false, msg: 'denied' }));
  assert.throws(() => parseBalance({ code: 401 }));
  assert.equal(parseBalance({ code: 200, data: { availableBalance: '', balance: '12.5' } }), 12.5);
});

test('fresh cache avoids requests; force refresh bypasses it', async (t) => {
  const s = await setup(t);
  await s.query();
  assert.equal(s.requests.length, 2);
  s.tick(1000);
  assert.equal((await s.query()).age, 1000);
  assert.equal(s.requests.length, 2);
  await s.query({ force: true });
  assert.equal(s.requests.length, 4);
  const files = await fs.readdir(s.cacheDir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('.json'));
  assert.ok(!files[0].includes('test-key'));
  assert.ok(!(await fs.readFile(path.join(s.cacheDir, files[0]), 'utf8')).includes('test-key'));
});

test('accounts and platforms have independent caches', async (t) => {
  const s = await setup(t);
  await s.query();
  await s.query({ key: 'second-key' });
  const international = await s.query({ platform: 'en' });
  assert.equal(s.requests.length, 5);
  assert.equal(international.balance, null);
  assert.equal(international.partialError, null);
  assert.equal((await fs.readdir(s.cacheDir)).length, 3);
});

test('disabled balance is hidden on fresh cache and forced refresh without errors', async (t) => {
  const s = await setup(t);
  await s.query();
  for (const force of [false, true]) {
    const info = await s.query({ showBalance: false, force });
    assert.equal(info.balance, null);
    assert.equal(info.partialError, null);
  }
  assert.equal(s.requests.length, 3);
});

test('enabling balance fetches missing balance without refetching a fresh plan', async (t) => {
  const s = await setup(t);
  await s.query({ showBalance: false });
  const info = await s.query();
  assert.equal(s.requests.length, 2);
  assert.equal(info.balance, 46.2);
});

test('failed attempts do not reset success age or extend the stale deadline', async (t) => {
  const s = await setup(t);
  await s.query();
  s.fail();
  s.tick(61_000);
  const fallback = await s.query({ staleSec: 90 });
  assert.equal(fallback.five.usedPct, 38);
  assert.equal(fallback.age, 61_000);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.partialError, 'offline');
  s.tick(30_000);
  const expired = await s.query({ staleSec: 90 });
  assert.equal(s.requests.length, 4); // 失败重试也遵守 TTL
  assert.equal(expired.ok, false);
  assert.equal(expired.five, null);
  assert.equal(expired.balance, null);
  assert.equal(expired.age, -1);
});

test('staleSec=0 disables fallback after a failed refresh', async (t) => {
  const s = await setup(t);
  await s.query();
  s.fail();
  assert.equal((await s.query({ force: true, staleSec: 0 })).ok, false);
});

test('zero TTL and stale limit still display successful current queries as fresh', async (t) => {
  const s = await setup(t);
  const info = await s.query({ ttlSec: 0, staleSec: 0, force: true });
  assert.equal(info.five.usedPct, 38);
  assert.equal(info.balance, 46.2);
  assert.equal(info.stale, false);
});

test('plan and balance expire independently and recover after an outage', async (t) => {
  const s = await setup(t);
  await s.query();
  s.fail(false, true);
  s.tick(61_000);
  await s.query({ staleSec: 90 });
  s.tick(61_000);
  const info = await s.query({ staleSec: 90 });
  assert.equal(info.five.usedPct, 38);
  assert.equal(info.balance, null);
  assert.equal(info.partialError, 'offline');
  assert.equal(info.stale, false);
  s.fail(false, false);
  const recovered = await s.query({ force: true });
  assert.equal(recovered.balance, 46.2);
  assert.equal(recovered.partialError, null);
});

test('malformed responses use valid stale data instead of showing 100 percent', async (t) => {
  const s = await setup(t);
  await s.query();
  t.mock.method(globalThis, 'fetch', async () => response(body('invalid')));
  s.tick(61_000);
  const info = await s.query();
  assert.equal(info.five.usedPct, 38);
  assert.equal(info.stale, true);
});

test('corrupt cache is ignored and rewritten', async (t) => {
  const s = await setup(t);
  await s.query();
  const [file] = await fs.readdir(s.cacheDir);
  await fs.writeFile(path.join(s.cacheDir, file), '{broken');
  assert.equal((await s.query()).ok, true);
  assert.equal(s.requests.length, 4);
});

test('network timeout reports failure and releases the refresh lock', async (t) => {
  const s = await setup(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  const info = await s.query();
  assert.equal(info.error, '查询超时');
  assert.equal(info.ok, false);
  assert.ok((await fs.readdir(s.cacheDir)).every((f) => f.endsWith('.json')));
});

test('a live refresh lock returns only usable cached data without another request', async (t) => {
  const s = await setup(t);
  await s.query();
  const [file] = await fs.readdir(s.cacheDir);
  await fs.writeFile(path.join(s.cacheDir, `${file}.lock`), String(process.pid));
  s.tick(61_000);
  const info = await s.query({ staleSec: 90 });
  assert.equal(info.five.usedPct, 38);
  assert.equal(info.refreshing, true);
  assert.equal(info.stale, true);
  s.tick(30_000);
  const expired = await s.query({ staleSec: 90 });
  assert.equal(expired.five, null);
  assert.equal(expired.error, '刷新中');
  assert.equal(s.requests.length, 2);
});

test('locks left by exited processes are recovered', async (t) => {
  const s = await setup(t);
  await s.query();
  const [file] = await fs.readdir(s.cacheDir);
  const deadPid = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim();
  await fs.writeFile(path.join(s.cacheDir, `${file}.lock`), deadPid);
  assert.equal((await s.query({ force: true })).ok, true);
  assert.equal(s.requests.length, 4);
  assert.deepEqual(await fs.readdir(s.cacheDir), [file]);
});

test('an unavailable cache directory does not prevent displaying a successful query', async (t) => {
  const s = await setup(t);
  const blocked = path.join(s.cacheDir, 'file');
  await fs.writeFile(blocked, 'not a directory');
  const info = await s.query({ cacheDir: blocked });
  assert.equal(info.ok, true);
  assert.equal(info.balance, 46.2);
});

test('concurrent processes share one refresh and other callers return promptly', { timeout: 15_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-statusline-process-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const spawn = () => {
    const child = fork(new URL('./fixtures/query-worker.mjs', import.meta.url), [dir], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = new Promise((resolve) => child.once('message', resolve));
    const result = new Promise((resolve, reject) => {
      let data;
      child.on('message', (msg) => { if (msg.result) data = msg; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 && data ? resolve(data) : reject(new Error(stderr || `exit ${code}`)));
    });
    return { child, ready, result };
  };
  const workers = Array.from({ length: 4 }, spawn);
  await Promise.all(workers.map((w) => w.ready));
  workers.forEach((w) => w.child.send('go'));
  const results = await Promise.all(workers.map((w) => w.result));
  assert.equal(results.reduce((sum, r) => sum + r.calls, 0), 2);
  assert.equal(results.filter((r) => r.result.ok).length, 1);
  assert.equal(results.filter((r) => r.result.refreshing).length, 3);
  assert.equal((await fs.readdir(dir)).length, 1);
});
