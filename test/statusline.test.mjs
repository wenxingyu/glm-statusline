import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig, resolveLanguage, gitBranch, renderGlm, render, shade,
  resolveCredential, renderDeepSeek, detectProvider, resolveSegments } from '../statusline.mjs';

test('invalid config fields fall back individually and segment order is preserved', () => {
  const defaults = normalizeConfig(null);
  const config = normalizeConfig({ segments: null, lang: 'invalid', glm: { platform: 'bad', showBalance: 'false' },
    timeoutMs: -1, staleSeconds: 'bad', cacheTtlSeconds: Infinity, contextLimit: -1 });
  assert.deepEqual(config, defaults);
  assert.deepEqual(normalizeConfig({ segments: ['glm', 'unknown', 'model', 'glm'] }).segments, ['glm', 'model']);
  assert.deepEqual(normalizeConfig({ segments: [] }).segments, []);
  assert.equal(normalizeConfig({ glm: { showBalance: false }, cacheTtlSeconds: 0 }).glm.showBalance, false);
  assert.equal(normalizeConfig({ cacheTtlSeconds: 0 }).cacheTtlSeconds, 0);
  assert.equal(normalizeConfig({ timeoutMs: 1.9 }).timeoutMs, 1);
  assert.equal(defaults.lang, 'auto');
  for (const lang of ['auto', 'zh', 'en']) assert.equal(normalizeConfig({ lang }).lang, lang);
});

test('explicit language overrides terminal and system locale without probing the system', () => {
  for (const lang of ['zh', 'en']) {
    assert.equal(resolveLanguage(lang, { env: { LC_ALL: lang === 'zh' ? 'en_US' : 'zh_CN' },
      systemLocale: () => { throw new Error('must not probe'); } }), lang);
  }
});

test('auto language supports Chinese locale variants and falls back to English for other locales', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans-CN', 'zh-Hant-TW', 'ZH_cn.UTF-8', 'zh_TW@stroke']) {
    assert.equal(resolveLanguage('auto', { env: { LANG: locale } }), 'zh', locale);
  }
  for (const locale of ['en-US', 'en_GB.UTF-8', 'ja_JP.UTF-8', 'fr-FR', 'C', 'C.UTF-8', 'POSIX']) {
    assert.equal(resolveLanguage('auto', { env: { LANG: locale }, systemLocale: () => 'zh-CN' }), 'en', locale);
  }
});

test('auto language uses LC_ALL then LC_MESSAGES then LANG then the system locale', () => {
  const detect = (env) => resolveLanguage('auto', { env, systemLocale: () => 'zh-Hant-TW' });
  assert.equal(detect({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN', LANG: 'zh_CN' }), 'en');
  assert.equal(detect({ LC_ALL: 'C', LC_MESSAGES: 'zh_CN', LANG: 'zh_CN' }), 'en');
  assert.equal(detect({ LC_ALL: '', LC_MESSAGES: 'zh_CN', LANG: 'en_US' }), 'zh');
  assert.equal(detect({ LC_ALL: 'not a locale', LC_MESSAGES: ' ', LANG: 'en_US' }), 'en');
  assert.equal(detect({ LANG: 'not a locale' }), 'zh');
  assert.equal(detect({}), 'zh');
  for (const locale of ['en-US', 'ja-JP', '', undefined, 'not a locale']) {
    assert.equal(resolveLanguage('auto', { env: {}, systemLocale: () => locale }), 'en');
  }
  assert.equal(resolveLanguage('auto', { env: {}, systemLocale: () => { throw new Error('unavailable'); } }), 'en');
});

test('auto language re-evaluates locale changes instead of caching the first result', () => {
  const env = { LANG: 'zh_CN.UTF-8' };
  assert.equal(resolveLanguage('auto', { env }), 'zh');
  env.LANG = 'en_US.UTF-8';
  assert.equal(resolveLanguage('auto', { env }), 'en');
});

test('git branches are found beyond five levels and in relative worktrees', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-statusline-git-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'a', 'b', 'c', 'd', 'e', 'f');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(path.join(dir, '.git'));
  await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/deep\n');
  assert.equal(await gitBranch(nested), 'feature/deep');
  const worktree = path.join(dir, 'worktree');
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: ../.git\n');
  assert.equal(await gitBranch(worktree), 'feature/deep');
});

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
test('renderer respects balance and level switches, including cached values', () => {
  const info = { level: 'pro', five: { usedPct: 38 }, balance: 46.2 };
  const config = normalizeConfig({ glm: { showBalance: false, showLevel: false } });
  assert.equal(strip(renderGlm(info, config, 'cn')), '5h 62%');
  assert.ok(!renderGlm(info, normalizeConfig({}), 'en').includes('¥'));
});

test('weekly-only data and zero balance survive partial failures with visible warning', () => {
  const line = strip(renderGlm({ weekly: { usedPct: 12 }, balance: 0, partialError: 'offline' }, normalizeConfig({ lang: 'zh' }), 'cn'));
  assert.equal(line, '周 88% · ¥0 · 部分查询失败');
});

test('fallback data and an initial refresh are visibly marked', () => {
  const config = normalizeConfig({ lang: 'zh' });
  assert.equal(strip(renderGlm({ five: { usedPct: 38 }, stale: true }, config, 'cn')), '5h 62% · 缓存');
  assert.equal(strip(renderGlm({ refreshing: true }, config, 'cn')), 'GLM 刷新中');
});

test('weekly labels and status messages use the selected language consistently', () => {
  for (const [lang, week, stale, partial, refreshing, fail] of [
    ['zh', '周', '缓存', '部分查询失败', 'GLM 刷新中', 'GLM 查询失败: 无数据'],
    ['en', 'wk', 'cached', 'partial failure', 'GLM refreshing', 'GLM query failed: no data'],
  ]) {
    const config = normalizeConfig({ lang });
    assert.equal(strip(renderGlm({ weekly: { usedPct: 12 }, stale: true }, config, 'cn')), `${week} 88% · ${stale}`);
    assert.equal(strip(renderGlm({ weekly: { usedPct: 12 }, partialError: 'offline' }, config, 'cn')), `${week} 88% · ${partial}`);
    assert.equal(strip(renderGlm({ refreshing: true }, config, 'cn')), refreshing);
    assert.equal(strip(renderGlm({}, config, 'cn')), fail);
  }
});

const renderCtx = async (input, config = {}) => strip(await render(input,
  normalizeConfig({ ...config, segments: ['ctx'] })));
const assistant = (usage, extra = {}) => JSON.stringify({ type: 'assistant',
  message: { role: 'assistant', usage }, ...extra });
async function transcript(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-context-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, content);
  return file;
}

test('live context percentages take priority over transcript history and support real zero', async (t) => {
  const file = await transcript(t, assistant({ input_tokens: 180000 }));
  const window = { used_percentage: 13, remaining_percentage: 87,
    current_usage: { input_tokens: 26000 }, context_window_size: 200000 };
  assert.equal(await renderCtx({ context_window: window, transcript_path: file }), 'ctx 87%');
  assert.equal(await renderCtx({ context_window: { ...window, used_percentage: 0,
    current_usage: { input_tokens: 0 } }, transcript_path: file }), 'ctx 100%');
  assert.equal(await renderCtx({ context_window: { remaining_percentage: 72.4 } }), 'ctx 72%');
});

test('live input and cache tokens use the reported window size and exclude output', async () => {
  const window = { context_window_size: 1000000, current_usage: {
    input_tokens: 10000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 30000,
    output_tokens: 200000,
  } };
  assert.equal(await renderCtx({ context_window: window }), 'ctx 87%');
  assert.equal(await renderCtx({ context_window: window }, { contextLimit: 200000 }), 'ctx 35%');
  assert.equal(await renderCtx({ model: { id: 'claude-sonnet[1m]' },
    context_window: { current_usage: { input_tokens: 100000 } } }), 'ctx 90%');
});

test('explicit context limits recalculate both token and percentage payloads', async () => {
  assert.equal(await renderCtx({ context_window: { used_percentage: 10, context_window_size: 1000000,
    current_usage: { input_tokens: 120000 } } }, { contextLimit: 200000 }), 'ctx 40%');
  assert.equal(await renderCtx({ context_window: { used_percentage: 10, context_window_size: 1000000 } },
    { contextLimit: 200000 }), 'ctx 50%');
});

test('unknown and malformed context data display a placeholder instead of a percentage', async () => {
  for (const window of [undefined, {}, { current_usage: null, used_percentage: 0, remaining_percentage: 100 },
    { used_percentage: '0', remaining_percentage: false },
    { current_usage: { output_tokens: 50 } }, { current_usage: { input_tokens: -1 } },
    { current_usage: { input_tokens: '1000' } }]) {
    assert.equal(await renderCtx({ context_window: window }), 'ctx --');
  }
  assert.equal(await renderCtx({ transcript_path: 123 }), 'ctx --');
  assert.equal(await renderCtx({ transcript_path: path.join(os.tmpdir(), 'missing-glm-context-file') }), 'ctx --');
});

test('resume estimates the latest main assistant usage and ignores unrelated or unfinished records', async (t) => {
  const file = await transcript(t, [assistant({ input_tokens: 10000 }),
    assistant({ input_tokens: 10000, cache_read_input_tokens: 14000, cache_creation_input_tokens: 2000 }),
    assistant({ input_tokens: 190000 }, { isSidechain: true }),
    JSON.stringify({ type: 'user', message: { usage: { input_tokens: 190000 } } }),
    assistant({ output_tokens: 400 }), assistant({ input_tokens: 'invalid' }), '{"type":"assistant"',
  ].join('\n'));
  assert.equal(await renderCtx({ context_window: { current_usage: null, used_percentage: 0 },
    transcript_path: file }), 'ctx ~87%');
  assert.equal(await renderCtx({ transcript_path: file, context_window: { context_window_size: 1000000 } }), 'ctx ~97%');
});

test('transcript scanning finds usage beyond the old 128 KiB tail', async (t) => {
  const file = await transcript(t, assistant({ input_tokens: 40000 }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: '中'.repeat(100000) } }) + '\n');
  assert.equal(await renderCtx({ transcript_path: file }), 'ctx ~80%');
});

test('compaction prevents fallback to pre-compaction usage until a new assistant response', async (t) => {
  const before = assistant({ input_tokens: 170000 }) + '\n' +
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n';
  const file = await transcript(t, before);
  const input = { context_window: { current_usage: null }, transcript_path: file };
  assert.equal(await renderCtx(input), 'ctx --');
  await fs.appendFile(file, assistant({ input_tokens: 20000 }) + '\n');
  assert.equal(await renderCtx(input), 'ctx ~90%');
  assert.equal(await renderCtx({ ...input, context_window: { used_percentage: 15,
    current_usage: { input_tokens: 30000 } } }), 'ctx 85%');
});

test('transcript scanning is bounded and percentages cannot go below zero', async (t) => {
  const file = await transcript(t, assistant({ input_tokens: 40000 }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4 * 1024 * 1024) } }));
  assert.equal(await renderCtx({ transcript_path: file }), 'ctx --');
  assert.equal(await renderCtx({ context_window: { current_usage: { input_tokens: 250000 } } }), 'ctx 0%');
});

test('optional segments preserve order and speedSamples accepts only one through twenty', () => {
  assert.deepEqual(normalizeConfig({ segments: ['speed', 'tok', 'deepseek', 'glm', 'speed'] }).segments,
    ['speed', 'tok', 'deepseek', 'glm']);
  for (const value of [0, -1, '5', null, Infinity, 21]) assert.equal(normalizeConfig({ speedSamples: value }).speedSamples, 5);
  assert.equal(normalizeConfig({ speedSamples: 20 }).speedSamples, 20);
});

test('dark colors adapt to terminal capabilities and light or unknown backgrounds retain standard colors', () => {
  assert.equal(shade('blue', { COLORFGBG: '15;0', TERM: 'xterm-256color' }), '\x1b[38;5;75m');
  assert.equal(shade('magenta', { COLORFGBG: '15;0', COLORTERM: 'truecolor' }), '\x1b[38;5;177m');
  assert.equal(shade('red', { COLORFGBG: '15;0', TERM: 'xterm-256color' }), '\x1b[38;5;203m');
  assert.equal(shade('blue', { COLORFGBG: '15;0', TERM: 'xterm' }), '\x1b[94m');
  assert.equal(shade('blue', { COLORFGBG: '0;15', TERM: 'xterm-256color' }), '\x1b[34m');
  assert.equal(shade('blue', {}), '\x1b[34m');
});

test('credentials are routed by provider with independent explicit overrides', () => {
  const env = { ANTHROPIC_AUTH_TOKEN: 'deepseek-key', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' };
  assert.deepEqual(resolveCredential('deepseek', env, {}), { key: 'deepseek-key', mismatch: false });
  assert.deepEqual(resolveCredential('glm', env, {}), { key: null, mismatch: true });
  assert.equal(resolveCredential('glm', env, { GLM_API_KEY: 'glm-key' }).key, 'glm-key');
  for (const base of ['https://open.bigmodel.cn/api/anthropic', 'https://api.z.ai/api/anthropic']) {
    assert.equal(resolveCredential('glm', { ...env, ANTHROPIC_BASE_URL: base }, {}).key, 'deepseek-key');
    assert.equal(resolveCredential('deepseek', { ...env, ANTHROPIC_BASE_URL: base }, {}).mismatch, true);
  }
  assert.equal(resolveCredential('deepseek', { DEEPSEEK_API_KEY: 'dedicated' }, {}).key, 'dedicated');
  assert.equal(resolveCredential('glm', { ANTHROPIC_AUTH_TOKEN: 'legacy-key' }, {}).key, 'legacy-key');
  for (const base of ['https://api.deepseek.com.evil.test', 'https://proxy.example', 'not a URL']) {
    assert.equal(resolveCredential('deepseek', { ...env, ANTHROPIC_BASE_URL: base }, {}).mismatch, true);
  }
});

test('auto recognizes supported URL hosts without trusting paths, lookalikes or key strings', () => {
  for (const [base, provider] of [
    ['https://api.deepseek.com/anthropic', 'deepseek'],
    ['https://OPEN.BIGMODEL.CN/api/anthropic', 'glm'],
    ['https://api.z.ai/api/anthropic', 'glm'],
    ['https://api.minimaxi.com/anthropic', 'minimax'],
    ['https://api.minimax.io/anthropic', 'minimax'],
    ['https://api.minimax.chat/anthropic', 'minimax'],
  ]) assert.equal(detectProvider(base), provider);
  for (const base of ['', undefined, 'not a URL', 'https://api.anthropic.com',
    'https://localhost:8080', 'https://proxy.example/api.deepseek.com',
    'https://api.deepseek.com.evil.test', 'https://evilbigmodel.cn',
    'https://minimax.io.evil.test', 'https://api.deepseek.com@proxy.example',
    'ftp://api.deepseek.com']) assert.equal(detectProvider(base), null);
  assert.deepEqual(resolveSegments(normalizeConfig({ segments: ['auto'] }),
    { GLM_API_KEY: 'dedicated' }, {}), []);
});

test('auto follows credential URL precedence, switches providers and deduplicates in display order', () => {
  const config = normalizeConfig({ segments: ['auto', 'model', 'deepseek', 'glm', 'auto'] });
  const settings = { ANTHROPIC_AUTH_TOKEN: 'settings-key', ANTHROPIC_BASE_URL: 'https://api.deepseek.com' };
  const current = { ANTHROPIC_AUTH_TOKEN: 'process-key', ANTHROPIC_BASE_URL: 'https://api.minimax.io' };
  assert.deepEqual(resolveSegments(config, settings, current), ['deepseek', 'model', 'glm']);
  delete settings.ANTHROPIC_AUTH_TOKEN;
  assert.deepEqual(resolveSegments(config, settings, current), ['minimax', 'model', 'deepseek', 'glm']);
  current.ANTHROPIC_BASE_URL = 'https://api.z.ai';
  assert.deepEqual(resolveSegments(config, settings, current), ['glm', 'model', 'deepseek']);
  assert.deepEqual(resolveSegments(normalizeConfig({ segments: ['deepseek', 'model', 'auto'] }),
    { ANTHROPIC_BASE_URL: 'https://api.deepseek.com' }, {}), ['deepseek', 'model']);
  assert.deepEqual(normalizeConfig({}).segments, ['model', 'dir', 'git', 'ctx', 'auto']);
});

test('provider mismatch is displayed without making a network request', async (t) => {
  const vars = ['GLM_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
  const original = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  t.after(() => { for (const v of vars) { if (original[v] === undefined) delete process.env[v]; else process.env[v] = original[v]; } });
  delete process.env.GLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test';
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
  // 隔离 settings.env，避免读取开发者本机的密钥。
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...args) => String(file).endsWith('settings.json') ? '{}' : readFile(file, ...args));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('must not fetch'); });
  assert.equal(strip(await render({}, normalizeConfig({ segments: ['glm'], lang: 'zh' }))), 'GLM Key 服务商不匹配');
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
  assert.equal(strip(await render({}, normalizeConfig({ segments: ['deepseek'], lang: 'en' }))), 'DeepSeek key provider mismatch');
  assert.equal(calls, 0);
});

test('token and speed segments render session totals, weighted speed and missing-data placeholders', async (t) => {
  const file = await transcript(t, [
    JSON.stringify({ type: 'user', timestamp: '2026-10-16T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-16T00:00:02Z',
      message: { id: 'a', usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 1000 } } }), '',
  ].join('\n'));
  const config = normalizeConfig({ segments: ['tok', 'speed'] });
  assert.equal(strip(await render({ transcript_path: file }, config)), 'tok 1.4k ↑100 ↓300 ⚡1.0k | 150 tok/s');
  assert.equal(strip(await render({}, config)), 'tok -- | -- tok/s');
});

test('DeepSeek balances preserve currencies and visibly mark offline fallback', () => {
  assert.equal(strip(renderDeepSeek({ balances: [{ currency: 'CNY', balance: 97.81 }], stale: true }, { lang: 'zh' })), '¥97.81 · 缓存');
  assert.equal(strip(renderDeepSeek({ balances: [{ currency: 'USD', balance: 0 }] }, { lang: 'en' })), '$0.00');
  assert.equal(strip(renderDeepSeek({ refreshing: true }, { lang: 'en' })), 'DeepSeek refreshing');
});
