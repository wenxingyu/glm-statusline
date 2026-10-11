import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig, gitBranch, renderGlm } from '../statusline.mjs';

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
