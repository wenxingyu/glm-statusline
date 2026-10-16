import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDeepSeekInfo, parseDeepSeekBalance, DEEPSEEK_BALANCE_URL } from '../deepseek.mjs';

const body = (balance = '97.81', currency = 'CNY') => ({ is_available: true,
  balance_infos: [{ currency, total_balance: balance }] });
async function setup(t) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-deepseek-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let now = 1_800_000_000_000, fail = false, data = body();
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => data };
  });
  return { requests, cacheDir, tick: (ms) => { now += ms; }, fail: () => { fail = true; },
    data: (value) => { data = value; },
    query: (options = {}) => getDeepSeekInfo({ key: 'test-key', cacheDir, proxyEnv: {}, ...options }) };
}

test('DeepSeek parser preserves zero, negatives and both currencies', () => {
  assert.deepEqual(parseDeepSeekBalance(body('0')), [{ currency: 'CNY', balance: 0 }]);
  assert.deepEqual(parseDeepSeekBalance(body('-0.12', 'USD')), [{ currency: 'USD', balance: -0.12 }]);
  assert.equal(parseDeepSeekBalance({ balance_infos: [...body().balance_infos, ...body('5', 'USD').balance_infos] }).length, 2);
});

test('DeepSeek parser rejects missing, malformed and unsupported currency values', () => {
  for (const value of [null, undefined, '', ' ', true, {}, [], 'bad', Infinity]) {
    assert.throws(() => parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY', total_balance: value }] }));
  }
  for (const value of [{}, { balance_infos: [] }, body('1', 'EUR')]) assert.throws(() => parseDeepSeekBalance(value));
});

test('balance endpoint uses Bearer authentication and caches successful results', async (t) => {
  const s = await setup(t);
  assert.equal((await s.query()).balances[0].balance, 97.81);
  await s.query();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, DEEPSEEK_BALANCE_URL);
  assert.equal(s.requests[0].options.headers.Authorization, 'Bearer test-key');
  await s.query({ force: true });
  assert.equal(s.requests.length, 2);
});

test('account caches are isolated and contain no plaintext API key', async (t) => {
  const s = await setup(t);
  await s.query();
  await s.query({ key: 'other-key' });
  const files = await fs.readdir(s.cacheDir);
  assert.equal(files.length, 2);
  for (const file of files) assert.doesNotMatch(file + await fs.readFile(path.join(s.cacheDir, file), 'utf8'), /test-key|other-key/);
});

test('offline fallback is marked stale, retry is throttled and the deadline never extends', async (t) => {
  const s = await setup(t);
  await s.query();
  s.tick(61000); s.fail();
  assert.equal((await s.query()).stale, true);
  assert.equal((await s.query()).balances[0].balance, 97.81);
  assert.equal(s.requests.length, 2);
  s.tick(1800000);
  assert.equal((await s.query()).balances, null);
});

test('zero stale lifetime disables fallback and zero TTL still shows a new result', async (t) => {
  const s = await setup(t);
  assert.equal((await s.query({ ttlSec: 0, staleSec: 0 })).ok, true);
  s.fail();
  assert.equal((await s.query({ force: true, staleSec: 0 })).balances, null);
});

test('malformed responses keep cached balances instead of inventing a zero', async (t) => {
  const s = await setup(t);
  await s.query();
  s.data({});
  const info = await s.query({ force: true });
  assert.equal(info.stale, true);
  assert.equal(info.balances[0].balance, 97.81);
});

test('live refresh lock returns cached data without another API request', async (t) => {
  const s = await setup(t);
  await s.query();
  const file = path.join(s.cacheDir, (await fs.readdir(s.cacheDir))[0]);
  await fs.writeFile(`${file}.lock`, String(process.pid));
  s.tick(61000);
  const info = await s.query();
  assert.equal(info.refreshing, true);
  assert.equal(info.stale, true);
  assert.equal(s.requests.length, 1);
});
