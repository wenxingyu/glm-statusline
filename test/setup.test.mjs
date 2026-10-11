import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from '../setup.mjs';

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-setup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'home with spaces', '.claude');
}

test('setup preserves existing settings, backs them up and deploys a working standalone runtime', async (t) => {
  const claudeDir = await temp(t);
  await fs.mkdir(claudeDir, { recursive: true });
  const original = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'test-only-token' },
    permissions: { allow: ['Read'] }, statusLine: { type: 'command', command: 'old-command' } });
  await fs.writeFile(path.join(claudeDir, 'settings.json'), original);
  const result = await setup({ claudeDir });
  assert.equal(await fs.readFile(result.backupPath, 'utf8'), original);
  const settings = JSON.parse(await fs.readFile(result.settingsPath, 'utf8'));
  assert.deepEqual(settings.env, { ANTHROPIC_AUTH_TOKEN: 'test-only-token' });
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.ok(settings.statusLine.command.includes('home with spaces'));
  assert.ok(!settings.statusLine.command.includes('npx'));
  const script = path.join(result.installDir, 'statusline.mjs');
  const demo = execFileSync(process.execPath, [script, '--demo'], {
    encoding: 'utf8', env: { ...process.env, GLM_STATUSLINE_CONFIG: result.configPath },
  });
  assert.match(demo, /5h 62%/);
  assert.equal(execFileSync(process.execPath, [script, '--version'], { encoding: 'utf8' }).trim(), '1.0.0');
});

test('setup initializes a new configuration and repeat setup preserves user preferences', async (t) => {
  const claudeDir = await temp(t);
  const initial = await setup({ claudeDir });
  assert.equal(initial.backupPath, null);
  const config = JSON.stringify({ glm: { showBalance: false }, lang: 'en' });
  await fs.writeFile(initial.configPath, config);
  const second = await setup({ claudeDir });
  assert.equal(second.backupPath, null);
  assert.equal(await fs.readFile(initial.configPath, 'utf8'), config);
  const demo = execFileSync(process.execPath, [path.join(initial.installDir, 'statusline.mjs'), '--demo'], {
    encoding: 'utf8', env: { ...process.env, GLM_STATUSLINE_CONFIG: initial.configPath },
  });
  assert.match(demo, /wk/);
  assert.ok(!demo.includes('¥'));
});

test('invalid settings are left untouched and do not trigger installation', async (t) => {
  const claudeDir = await temp(t);
  await fs.mkdir(claudeDir, { recursive: true });
  const settings = path.join(claudeDir, 'settings.json');
  for (const text of ['{broken', 'null', '[]']) {
    await fs.writeFile(settings, text);
    await assert.rejects(setup({ claudeDir }), /配置/);
    assert.equal(await fs.readFile(settings, 'utf8'), text);
    assert.deepEqual(await fs.readdir(claudeDir), ['settings.json']);
  }
});

test('help and version work without stdin; invalid options exit with a diagnostic', () => {
  const script = fileURLToPath(new URL('../statusline.mjs', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /--setup/);
  const invalid = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--help/);
  assert.equal(invalid.stdout, '');
});

test('npm-style symlink entry points execute the CLI', { skip: process.platform === 'win32' }, async (t) => {
  const claudeDir = await temp(t);
  await fs.mkdir(claudeDir, { recursive: true });
  const link = path.join(claudeDir, 'glm-statusline');
  await fs.symlink(fileURLToPath(new URL('../statusline.mjs', import.meta.url)), link);
  assert.equal(execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' }).trim(), '1.0.0');
});
