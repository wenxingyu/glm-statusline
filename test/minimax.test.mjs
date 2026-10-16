import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMiniMaxInfo, parseMiniMaxPlan } from '../minimax.mjs';
import { normalizeConfig, resolveCredential, resolveMiniMaxPlatform, renderMiniMax, render } from '../statusline.mjs';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const entry = (extra = {}) => ({ model_name: 'general', current_interval_remaining_percent: 62,
  current_weekly_remaining_percent: 88, ...extra });
const body = (entries = [entry()]) => ({ base_resp: { status_code: 0 }, model_remains: entries });

async function setup(t) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-minimax-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let now = 1_800_000_000_000, fail = false, data = body(), status = 200;
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (fail) throw new Error('offline');
    return { ok: status === 200, status, json: async () => data };
  });
  return { requests, cacheDir, tick: (ms) => { now += ms; }, fail: () => { fail = true; },
    data: (value) => { data = value; }, status: (value) => { status = value; },
    query: (options = {}) => getMiniMaxInfo({ key: 'test-minimax-key', cacheDir, proxyEnv: {}, ...options }) };
}

test('MiniMax parses remaining percentages without inverting them or relying on zero counts', () => {
  const result = parseMiniMaxPlan(body([entry({ current_interval_total_count: 0, current_interval_usage_count: 0 })]));
  assert.equal(result.five.usedPct, 38);
  assert.equal(result.weekly.usedPct, 12);
  assert.equal(strip(renderMiniMax(result, { lang: 'zh' })), 'MiniMax 5h 62% · 周 88%');
  assert.equal(strip(renderMiniMax(result, { lang: 'en' })), 'MiniMax 5h 62% · wk 88%');
});

test('quota parsing preserves zero, handles numeric strings, absolute timestamps and millisecond countdowns', () => {
  const result = parseMiniMaxPlan(body([entry({ current_interval_remaining_percent: '0',
    current_weekly_remaining_percent: '100', end_time: 1800003600, weekly_remains_time: 86400000 })]),
  { now: 1800000000000 });
  assert.equal(result.five.usedPct, 100);
  assert.equal(result.weekly.usedPct, 0);
  assert.equal(result.five.resetMs, 1800003600000);
  assert.equal(result.weekly.resetMs, 1800086400000);
});

test('MiniMax does not infer M Plan tiers from historical counts or invent API tier fields', () => {
  for (const total of [600, 1500, 4500, 30000]) {
    for (const count of [total, String(total)]) {
      const result = parseMiniMaxPlan(body([entry({ current_interval_total_count: count,
        current_interval_usage_count: 151, current_interval_remaining_percent: 89 })]));
      assert.equal(result.level, null);
      assert.equal(result.five.usedPct, 11);
      assert.equal(strip(renderMiniMax(result, { lang: 'en' })), 'MiniMax 5h 89% · wk 88%');
    }
  }
});

test('unknown totals or unrelated quota models do not invent a tier or hide valid percentages', () => {
  for (const total of [undefined, null, 0, -1, 599, 600, 600.1, 1000, 15000, 30001, false, '', ' ', [], {}, Infinity]) {
    const result = parseMiniMaxPlan(body([entry({ current_interval_total_count: total })]));
    assert.equal(result.level, null);
    assert.equal(result.five.usedPct, 38);
    assert.equal(strip(renderMiniMax(result, { lang: 'en' })), 'MiniMax 5h 62% · wk 88%');
  }
  for (const model_name of ['image', 'speech']) {
    assert.equal(parseMiniMaxPlan(body([entry({ model_name, current_interval_total_count: 1500 })])).level, null);
  }
});

test('configured tiers use official spelling and can be hidden without changing quota', () => {
  const result = parseMiniMaxPlan(body());
  for (const [level, label] of [['go', 'Go'], ['explore', 'Explore'], ['build', 'Build']]) {
    assert.equal(strip(renderMiniMax(result, { lang: 'en', minimax: { level } })),
      `${label} 5h 62% · wk 88%`);
    assert.equal(strip(renderMiniMax(result, { lang: 'en', minimax: { level }, _showProvider: true })),
      `MiniMax ${label} 5h 62% · wk 88%`);
    assert.equal(strip(renderMiniMax(result, { lang: 'en', minimax: { level, showLevel: false } })),
      'MiniMax 5h 62% · wk 88%');
  }
});

test('configured tiers apply immediately to cache hits while old inferred tiers are ignored', async (t) => {
  const s = await setup(t);
  s.data(body([entry({ current_interval_total_count: 1500 })]));
  assert.equal((await s.query()).level, null);
  assert.equal((await s.query({ level: 'go' })).level, 'go');
  assert.equal((await s.query({ level: 'explore' })).level, 'explore');
  assert.equal((await s.query({ level: 'build' })).level, 'build');
  assert.equal(s.requests.length, 1);
  s.tick(61000); s.fail();
  const cached = await s.query();
  assert.equal(cached.level, null);
  assert.equal(cached.stale, true);
  const file = path.join(s.cacheDir, (await fs.readdir(s.cacheDir)).find((name) => name.endsWith('.json')));
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  old.value.level = 'go';
  await fs.writeFile(file, JSON.stringify(old));
  const legacy = await s.query();
  assert.equal(legacy.ok, true);
  assert.equal(legacy.level, null);
  assert.equal(legacy.five.usedPct, 38);
  assert.equal((await s.query({ level: 'build' })).level, 'build');
  s.tick(1800000);
  assert.equal((await s.query()).level, null);
});

test('MiniMax selects the general pool or explicit model and never sums different model pools', () => {
  const data = body([entry({ model_name: 'image', current_interval_remaining_percent: 99 }), entry()]);
  assert.equal(parseMiniMaxPlan(data).five.usedPct, 38);
  assert.equal(parseMiniMaxPlan(data, { model: 'IMAGE' }).five.usedPct, 1);
  assert.throws(() => parseMiniMaxPlan(data, { model: 'missing' }));
  assert.throws(() => parseMiniMaxPlan(body([entry({ model_name: 'a' }), entry({ model_name: 'b' })])));
  assert.equal(parseMiniMaxPlan({ data: { model_remains: [entry({ model_name: 'MiniMax-M2.7' })] } }).model, 'MiniMax-M2.7');
});

test('invalid percentages and ambiguous count-only payloads remain unknown', () => {
  for (const value of [null, undefined, false, '', ' ', -1, 101, Infinity, [], {}]) {
    assert.throws(() => parseMiniMaxPlan(body([entry({ current_interval_remaining_percent: value,
      current_weekly_remaining_percent: value, current_interval_total_count: 100, current_interval_usage_count: 40 })])));
  }
  assert.throws(() => parseMiniMaxPlan({ base_resp: { status_code: 1004 }, model_remains: [entry()] }));
  assert.throws(() => parseMiniMaxPlan(body([])));
  const partial = parseMiniMaxPlan(body([entry({ current_interval_status: 3 })]));
  assert.equal(partial.five, null);
  assert.equal(partial.weekly.usedPct, 12);
});

test('MiniMax configuration accepts its segment, platform and model with safe defaults', () => {
  const config = normalizeConfig({ segments: ['minimax', 'tok', 'minimax'], minimax: { platform: 'en', model: ' general ' } });
  assert.deepEqual(config.segments, ['minimax', 'tok']);
  assert.deepEqual(config.minimax, { platform: 'en', model: 'general', level: 'auto', showLevel: true });
  assert.deepEqual(normalizeConfig({ minimax: { platform: 'bad', model: '', showLevel: 'false' } }).minimax,
    { platform: 'auto', model: 'auto', level: 'auto', showLevel: true });
  assert.equal(normalizeConfig({ minimax: { showLevel: false } }).minimax.showLevel, false);
  for (const level of ['auto', 'go', 'explore', 'build']) {
    assert.equal(normalizeConfig({ minimax: { level } }).minimax.level, level);
  }
  for (const level of ['starter', 'plus', 'max', 'ultra', 'go-highspeed', 'GO', '', null]) {
    assert.equal(normalizeConfig({ minimax: { level } }).minimax.level, 'auto');
  }
});

test('MiniMax credentials support dedicated keys and reject other providers and lookalike domains', () => {
  for (const domain of ['api.minimaxi.com', 'api.minimax.cn', 'api.minimax.io', 'api.minimax.chat']) {
    const env = { ANTHROPIC_AUTH_TOKEN: 'subscription-key', ANTHROPIC_BASE_URL: `https://${domain}/anthropic` };
    assert.equal(resolveCredential('minimax', env, {}).key, 'subscription-key');
    assert.equal(resolveCredential('glm', env, {}).mismatch, true);
    assert.equal(resolveCredential('deepseek', env, {}).mismatch, true);
  }
  for (const domain of ['api.deepseek.com', 'api.minimax.io.evil.test', 'api.minimax.cn.evil.test', 'evilminimax.cn']) {
    assert.equal(resolveCredential('minimax', { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `https://${domain}` }, {}).mismatch, true);
  }
  assert.equal(resolveCredential('minimax', { MINIMAX_API_KEY: 'settings' }, { MINIMAX_API_KEY: 'process' }).key, 'process');
  assert.equal(resolveCredential('minimax', {}, {}).key, null);
});

test('MiniMax platform auto detection respects domain boundaries and explicit configuration', () => {
  const config = normalizeConfig({});
  assert.equal(resolveMiniMaxPlatform(config, {}, {}), 'cn');
  assert.equal(resolveMiniMaxPlatform(config, {}, { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic' }), 'en');
  assert.equal(resolveMiniMaxPlatform(config, { ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic' }, {}), 'cn');
  assert.equal(resolveMiniMaxPlatform(config, { ANTHROPIC_BASE_URL: 'https://api.minimax.cn/anthropic' }, {}), 'cn');
  assert.equal(resolveMiniMaxPlatform(config, { ANTHROPIC_BASE_URL: 'https://api.minimax.io.evil.test' }, {}), 'cn');
  assert.equal(resolveMiniMaxPlatform(normalizeConfig({ minimax: { platform: 'en' } }), {}, {}), 'en');
});

test('MiniMax requests official regional endpoints with Bearer auth and separate platform/account/model caches', async (t) => {
  const s = await setup(t);
  await s.query();
  await s.query();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, 'https://www.minimaxi.com/v1/token_plan/remains');
  assert.equal(s.requests[0].options.headers.Authorization, 'Bearer test-minimax-key');
  await s.query({ platform: 'en' });
  assert.equal(s.requests[1].url, 'https://www.minimax.io/v1/token_plan/remains');
  await s.query({ key: 'another-key' });
  await s.query({ model: 'general' });
  assert.equal((await fs.readdir(s.cacheDir)).length, 4);
  for (const f of await fs.readdir(s.cacheDir)) assert.doesNotMatch(f + await fs.readFile(path.join(s.cacheDir, f), 'utf8'), /test-minimax-key|another-key/);
});

test('MiniMax offline fallback is marked cached, retries are throttled and stale expiry never extends', async (t) => {
  const s = await setup(t);
  await s.query();
  s.tick(61000); s.fail();
  const cached = await s.query();
  assert.equal(cached.stale, true);
  assert.equal(strip(renderMiniMax(cached, { lang: 'zh' })), 'MiniMax 5h 62% · 周 88% · 缓存');
  await s.query();
  assert.equal(s.requests.length, 2);
  s.tick(1800000);
  assert.equal((await s.query()).ok, false);
});

test('MiniMax business failures and HTTP errors do not fabricate full quota', async (t) => {
  const s = await setup(t);
  s.data({ base_resp: { status_code: 1004, status_msg: 'secret must not leak' }, model_remains: [entry()] });
  const result = await s.query();
  assert.equal(result.five, null);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  s.status(401);
  assert.equal((await s.query({ force: true })).error, 'HTTP 401');
});

test('MiniMax force refresh, zero TTL and disabling stale fallback work independently', async (t) => {
  const s = await setup(t);
  assert.equal((await s.query({ ttlSec: 0, staleSec: 0 })).ok, true);
  await s.query({ force: true });
  assert.equal(s.requests.length, 2);
  s.fail();
  assert.equal((await s.query({ force: true, staleSec: 0 })).ok, false);
});

test('MiniMax refresh locks return promptly, corrupt caches rebuild and malformed quota cannot overwrite good data', async (t) => {
  const s = await setup(t);
  await s.query();
  const file = path.join(s.cacheDir, (await fs.readdir(s.cacheDir))[0]);
  await fs.writeFile(`${file}.lock`, String(process.pid));
  const refreshing = await s.query({ force: true });
  assert.equal(refreshing.refreshing, true);
  assert.equal(s.requests.length, 1);
  await fs.unlink(`${file}.lock`);
  await fs.writeFile(file, '{broken');
  assert.equal((await s.query()).ok, true);
  s.data({});
  assert.equal((await s.query({ force: true })).stale, true);
});

test('MiniMax renderer handles missing credentials, mismatch and demo without requesting the network', async (t) => {
  const config = normalizeConfig({ segments: ['minimax'], lang: 'en' });
  const vars = ['MINIMAX_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
  const original = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  t.after(() => { for (const v of vars) { if (original[v] === undefined) delete process.env[v]; else process.env[v] = original[v]; } });
  for (const v of vars) delete process.env[v];
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...args) => String(file).endsWith('settings.json') ? '{}' : read(file, ...args));
  t.mock.method(globalThis, 'fetch', () => { assert.fail('unexpected request'); });
  assert.equal(strip(await render({}, config)), 'MiniMax no key');
  process.env.ANTHROPIC_AUTH_TOKEN = 'other';
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
  assert.equal(strip(await render({}, config)), 'MiniMax key provider mismatch');
  assert.equal(strip(await render({}, { ...config, _demo: true })), 'MiniMax 5h 62% · wk 88%');
  assert.equal(strip(renderMiniMax({ refreshing: true }, config)), 'MiniMax refreshing');
});
