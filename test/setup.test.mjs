import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  assert.equal(JSON.parse(await fs.readFile(initial.configPath, 'utf8')).lang, 'auto');
  assert.deepEqual(JSON.parse(await fs.readFile(initial.configPath, 'utf8')).segments,
    ['model', 'dir', 'git', 'ctx', 'auto']);
  const config = JSON.stringify({ segments: ['glm'], glm: { showBalance: false }, lang: 'en' });
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

test('installed runtime supports the new token, speed, DeepSeek and MiniMax segments', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  await fs.writeFile(result.configPath, JSON.stringify({ segments: ['tok', 'speed', 'deepseek', 'minimax'], lang: 'en' }));
  const script = path.join(result.installDir, 'statusline.mjs');
  const demo = execFileSync(process.execPath, [script, '--demo'], {
    encoding: 'utf8', env: { ...process.env, GLM_STATUSLINE_CONFIG: result.configPath },
  }).replace(/\x1b\[[0-9;]*m/g, '').trim();
  assert.match(demo, /^tok .* \| 150 tok\/s \| ¥97\.81 \| MiniMax 5h 62% · wk 88%$/);
});

test('installed MiniMax query and status line use settings credentials and selected region', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const settings = JSON.parse(await fs.readFile(result.settingsPath, 'utf8'));
  settings.env = { MINIMAX_API_KEY: 'fixture-subscription-key' };
  await fs.writeFile(result.settingsPath, JSON.stringify(settings));
  await fs.writeFile(result.configPath, JSON.stringify({ segments: ['minimax'], lang: 'en',
    minimax: { platform: 'en' }, cacheTtlSeconds: 0 }));
  const script = path.join(result.installDir, 'statusline.mjs');
  const home = path.dirname(path.dirname(result.settingsPath));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(minimax_api_key|https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home,
    GLM_STATUSLINE_CONFIG: result.configPath });
  for (const args of [['--query'], []]) {
    const code = `process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://www.minimax.io/v1/token_plan/remains' ||
            options.headers.Authorization !== 'Bearer fixture-subscription-key') throw new Error('wrong request');
        return { ok: true, json: async () => ({ base_resp: { status_code: 0 }, model_remains: [{
          model_name: 'general', current_interval_remaining_percent: 62, current_weekly_remaining_percent: 88,
        }] }) };
      };
      await import(${JSON.stringify(pathToFileURL(script).href)});`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code],
      { encoding: 'utf8', input: '{}', env, timeout: 10000 });
    if (args.length) assert.equal(JSON.parse(output).five.usedPct, 38);
    else assert.equal(output.replace(/\x1b\[[0-9;]*m/g, '').trim(), 'MiniMax 5h 62% · wk 88%');
  }
});

test('installed auto routes both query and rendering to the selected provider and region exactly once', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const script = path.join(result.installDir, 'statusline.mjs');
  const home = path.dirname(path.dirname(result.settingsPath));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(glm_api_key|deepseek_api_key|minimax_api_key|anthropic_.*|https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home,
    GLM_STATUSLINE_CONFIG: result.configPath });
  for (const [base, provider, endpoint, body, expected] of [
    ['https://open.bigmodel.cn/api/anthropic', 'glm', 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } }, '5h 62%'],
    ['https://api.z.ai/api/anthropic', 'glm', 'https://api.z.ai/api/monitor/usage/quota/limit',
      { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } }, '5h 62%'],
    ['https://api.deepseek.com/anthropic', 'deepseek', 'https://api.deepseek.com/user/balance',
      { balance_infos: [{ currency: 'CNY', total_balance: '97.81' }] }, '¥97.81'],
    ['https://api.minimaxi.com/anthropic', 'minimax', 'https://www.minimaxi.com/v1/token_plan/remains',
      { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 62 }] }, 'MiniMax 5h 62%'],
    ['https://api.minimax.io/anthropic', 'minimax', 'https://www.minimax.io/v1/token_plan/remains',
      { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 62 }] }, 'MiniMax 5h 62%'],
  ]) {
    await fs.writeFile(result.settingsPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fixture-auto-key',
    } }));
    await fs.writeFile(result.configPath, JSON.stringify({ segments: ['model', 'auto', provider],
      lang: 'en', glm: { showBalance: false }, cacheTtlSeconds: 0 }));
    for (const args of [['--query'], []]) {
      const code = `process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
        let calls = 0;
        globalThis.fetch = async (url, options) => {
          calls++;
          if (url !== ${JSON.stringify(endpoint)} || options.headers.Authorization !==
              ${JSON.stringify(provider === 'glm' ? 'fixture-auto-key' : 'Bearer fixture-auto-key')}) {
            throw new Error('wrong request');
          }
          return { ok: true, json: async () => (${JSON.stringify(body)}) };
        };
        await import(${JSON.stringify(pathToFileURL(script).href)});
        process.on('beforeExit', () => { if (calls !== 1) process.exitCode = 2; });`;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8', input: '{"model":{"display_name":"session"}}', env, timeout: 10000,
      });
      if (args.length) assert.equal(JSON.parse(output).ok, true);
      else assert.equal(output.replace(/\x1b\[[0-9;]*m/g, '').trim(), `session | ${expected}`);
    }
  }
});

test('providers run concurrently while rendering and query JSON preserve configured order', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const script = path.join(result.installDir, 'statusline.mjs');
  const home = path.dirname(path.dirname(result.settingsPath));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(glm_api_key|deepseek_api_key|minimax_api_key|anthropic_.*|https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home,
    GLM_STATUSLINE_CONFIG: result.configPath, GLM_API_KEY: 'fixture-concurrent-glm',
    DEEPSEEK_API_KEY: 'fixture-concurrent-deepseek', MINIMAX_API_KEY: 'fixture-concurrent-minimax' });
  await fs.writeFile(result.configPath, JSON.stringify({ segments: ['deepseek', 'glm', 'minimax'],
    lang: 'en', glm: { showBalance: false }, cacheTtlSeconds: 0 }));
  for (const args of [['--query'], []]) {
    const code = `process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify(args)}];
      const pending = [];
      let completed = 0;
      // No request can finish until all three have started. Serial execution fails without timing assertions.
      globalThis.fetch = (url) => new Promise((resolve) => {
        const body = url.includes('deepseek.com')
          ? { balance_infos: [{ currency: 'CNY', total_balance: '42' }] }
          : url.includes('minimaxi.com')
            ? { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 62 }] }
            : { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } };
        pending.push(() => { completed++; resolve({ ok: true, json: async () => body }); });
        if (pending.length === 3) for (const finish of [...pending].reverse()) finish();
      });
      process.on('beforeExit', () => { if (completed !== 3) process.exitCode = 2; });
      await import(${JSON.stringify(pathToFileURL(script).href)});`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', input: '{}', env, timeout: 10000,
    });
    if (args.length) {
      const data = JSON.parse(output);
      assert.deepEqual(Object.keys(data), ['deepseek', 'glm', 'minimax']);
      assert.ok(Object.values(data).every((info) => info.ok));
    } else assert.equal(output.replace(/\x1b\[[0-9;]*m/g, '').trim(), '¥42.00 | 5h 62% | MiniMax 5h 62%');
  }
});

test('unknown auto URLs hide only the provider segment, never query, and explain failures on demand', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const script = path.join(result.installDir, 'statusline.mjs');
  const home = path.dirname(path.dirname(result.settingsPath));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(anthropic_.*|glm_statusline_debug)$/i.test(name)));
  Object.assign(env, { HOME: home, USERPROFILE: home, GLM_STATUSLINE_CONFIG: result.configPath });
  await fs.writeFile(result.configPath, JSON.stringify({ segments: ['model', 'auto', 'ctx'] }));
  for (const base of ['', 'not a URL', 'https://api.anthropic.com', 'https://proxy.example/secret',
    'https://api.deepseek.com.evil.test']) {
    await fs.writeFile(result.settingsPath, JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fixture-secret', GLM_API_KEY: 'dedicated-secret',
    } }));
    for (const mode of ['render', 'debug', 'query']) {
      const code = `process.argv = [process.execPath, ${JSON.stringify(script)},
          ...${JSON.stringify(mode === 'query' ? ['--query'] : [])}];
        globalThis.fetch = () => { process.exit(99); };
        await import(${JSON.stringify(pathToFileURL(script).href)});`;
      const output = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        encoding: 'utf8', input: '{"model":{"display_name":"session"}}', timeout: 10000,
        env: { ...env, GLM_STATUSLINE_DEBUG: mode === 'debug' ? '1' : '' },
      });
      assert.equal(output.status, mode === 'query' ? 1 : 0, output.stderr);
      assert.equal(output.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim(), mode === 'query' ? '' : 'session | ctx --');
      if (mode === 'render') assert.equal(output.stderr, '');
      else assert.match(output.stderr, /ANTHROPIC_BASE_URL/);
      assert.doesNotMatch(output.stderr, /secret/);
    }
  }
});

test('installed auto language follows locale on each invocation and keeps explicit user choices', async (t) => {
  const result = await setup({ claudeDir: await temp(t) });
  const script = path.join(result.installDir, 'statusline.mjs');
  const run = (locale) => execFileSync(process.execPath, [script, '--demo'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GLM_STATUSLINE_CONFIG: result.configPath, LC_ALL: locale },
  }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(run('zh_CN.UTF-8'), /周 88%/);
  assert.match(run('en_US.UTF-8'), /wk 88%/);
  assert.match(run('zh-Hant-TW'), /周 88%/);
  assert.match(run('C'), /wk 88%/);
  for (const lang of ['zh', 'en']) {
    const config = JSON.stringify({ lang, segments: ['glm'] });
    await fs.writeFile(result.configPath, config);
    await setup({ claudeDir: path.dirname(result.configPath) });
    assert.equal(await fs.readFile(result.configPath, 'utf8'), config);
    assert.match(run(lang === 'zh' ? 'en_US.UTF-8' : 'zh_CN.UTF-8'), lang === 'zh' ? /周 88%/ : /wk 88%/);
  }
  // 用隔离的 home 和无凭据环境验证真实渲染的未配置提示，不访问用户账号或网络。
  await fs.writeFile(result.configPath, JSON.stringify({ lang: 'auto', segments: ['glm'] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(glm_api_key|anthropic_auth_token|anthropic_api_key)$/i.test(name)));
  const home = path.dirname(path.dirname(result.configPath));
  for (const [locale, expected] of [['zh_CN.UTF-8', 'GLM 未配置 Key'], ['en_US.UTF-8', 'GLM no key']]) {
    const output = execFileSync(process.execPath, [script], {
      encoding: 'utf8', input: '{}', timeout: 10_000,
      env: { ...env, HOME: home, USERPROFILE: home, GLM_STATUSLINE_CONFIG: result.configPath, LC_ALL: locale },
    });
    assert.equal(output.replace(/\x1b\[[0-9;]*m/g, '').trim(), expected);
  }
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
