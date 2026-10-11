import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig, gitBranch, renderGlm, render } from '../statusline.mjs';

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
  const line = strip(renderGlm({ weekly: { usedPct: 12 }, balance: 0, partialError: 'offline' }, normalizeConfig({}), 'cn'));
  assert.equal(line, '周 88% · ¥0 · 部分查询失败');
});

test('fallback data and an initial refresh are visibly marked', () => {
  const config = normalizeConfig({});
  assert.equal(strip(renderGlm({ five: { usedPct: 38 }, stale: true }, config, 'cn')), '5h 62% · 缓存');
  assert.equal(strip(renderGlm({ refreshing: true }, config, 'cn')), 'GLM 刷新中');
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
