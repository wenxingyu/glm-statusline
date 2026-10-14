import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from '../setup.mjs';

const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

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
  // Node 本身可能由 npx 安装；验证命令没有通过 npx/npm exec 启动即可。
  assert.doesNotMatch(settings.statusLine.command, /^(?:npx(?:\.cmd)?|npm(?:\.cmd)?\s+exec)\s/i);
  const script = path.join(result.installDir, 'statusline.mjs');
  const demo = execFileSync(process.execPath, [script, '--demo'], {
    encoding: 'utf8', env: { ...process.env, GLM_STATUSLINE_CONFIG: result.configPath },
  });
  assert.match(demo, /5h 62%/);
  assert.equal(execFileSync(process.execPath, [script, '--version'], { encoding: 'utf8' }).trim(), version);
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
  assert.equal(execFileSync(process.execPath, [link, '--version'], { encoding: 'utf8' }).trim(), version);
});

test('Windows case variants and 8.3 short paths execute the installed CLI', { skip: process.platform !== 'win32' }, async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const script = path.join(result.installDir, 'statusline.mjs');
  const shortDir = execSync(`for %I in ("${result.installDir}") do @echo %~sI`, { encoding: 'utf8' }).trim();
  // Node 的 ESM 扩展名匹配本身区分大小写，因此保留 .mjs 文件名。
  for (const entry of [path.join(path.dirname(script).toUpperCase(), 'statusline.mjs'), path.join(shortDir, 'statusline.mjs')]) {
    assert.equal(execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim(), version);
  }
});

test('generated statusLine command handles spaces and apostrophes and receives stdin through supported shells', async (t) => {
  const claudeDir = path.join(await temp(t), "user's workspace");
  const result = await setup({ claudeDir });
  await fs.writeFile(result.configPath, JSON.stringify({ segments: ['model', 'dir'] }));
  const { statusLine } = JSON.parse(await fs.readFile(result.settingsPath, 'utf8'));
  const input = JSON.stringify({ model: { display_name: 'Cross-platform' }, cwd: claudeDir });
  const options = { encoding: 'utf8', input, timeout: 10_000,
    env: { ...process.env, GLM_STATUSLINE_CONFIG: result.configPath } };
  const output = execSync(statusLine.command, options);
  assert.match(output, /Cross-platform/);
  assert.ok(output.includes("user's workspace"));
  if (process.platform === 'win32') {
    for (const shell of ['powershell.exe', 'pwsh.exe']) {
      await t.test(shell, (t) => {
        // 编码只用于无损传入命令文本；stdin 留给状态栏的会话 JSON。
        const encoded = Buffer.from(statusLine.command, 'utf16le').toString('base64');
        const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
        if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') {
          t.skip('PowerShell 7 is not installed');
          return;
        }
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Cross-platform/);
        assert.ok(result.stdout.includes("user's workspace"));
      });
    }
    const bash = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe');
    try { await fs.access(bash); } catch { return; }
    assert.match(execFileSync(bash, ['--noprofile', '--norc', '-c', statusLine.command], options), /Cross-platform/);
  } else if (process.platform === 'darwin') {
    assert.match(execFileSync('/bin/zsh', ['-f', '-c', statusLine.command], options), /Cross-platform/);
  }
});

test('POSIX installation paths preserve literal shell metacharacters', { skip: process.platform === 'win32' }, async (t) => {
  const claudeDir = path.join(await temp(t), 'user $HOME `uname` "quoted"');
  const result = await setup({ claudeDir });
  const { statusLine } = JSON.parse(await fs.readFile(result.settingsPath, 'utf8'));
  assert.equal(execSync(`${statusLine.command} --version`, { encoding: 'utf8', timeout: 10_000 }).trim(), version);
});
