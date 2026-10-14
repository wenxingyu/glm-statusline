import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../scripts/release-notes.mjs';

test('release notes select one exact version and preserve Markdown with LF or CRLF', () => {
  const changelog = '# 更新日志\n\n## 1.0.6 - 2026-10-14\n\n### 修复\n\n- 当前版本。\n\n## 1.0.5 - 2026-10-14\n\n旧版本。\n';
  for (const text of [changelog, changelog.replaceAll('\n', '\r\n')]) {
    assert.equal(releaseNotes(text, 'v1.0.6').replaceAll('\r\n', '\n'), '### 修复\n\n- 当前版本。\n');
    assert.equal(releaseNotes(text, '1.0.5'), '旧版本。\n');
    assert.throws(() => releaseNotes(text, '1.0'), /唯一/);
  }
});

test('missing, empty and duplicate version notes block release', () => {
  assert.throws(() => releaseNotes('# 更新日志\n', '1.0.6'), /唯一/);
  assert.throws(() => releaseNotes('## 1.0.6 - 2026-10-14\n\n## 1.0.5 - 2026-10-14\n旧版本', '1.0.6'), /不能为空/);
  assert.throws(() => releaseNotes('## 1.0.6 - 2026-10-14\n第一次\n## 1.0.6 - 2026-10-14\n第二次', '1.0.6'), /唯一/);
});

test('prerelease notes do not select the stable release', () => {
  const changelog = '## 1.1.0 - 2026-10-14\n正式版\n## 1.1.0-beta.0 - 2026-10-14\n预发布版';
  assert.equal(releaseNotes(changelog, 'v1.1.0-beta.0'), '预发布版\n');
});

test('current package has README summary, release notes and matching CLI output', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = await fs.readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = releaseNotes(changelog, pkg.version);
  assert.match(notes, /升级提示/);
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(`| **${pkg.version}**`), 'README must summarize the current release for npm users');
  const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
  assert.equal(execFileSync(process.execPath, [script], { encoding: 'utf8' }), notes);
});
