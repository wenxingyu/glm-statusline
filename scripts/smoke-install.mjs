// 通过 npm run test:install 执行：只使用打包产物和临时目录，不访问真实账号。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('请使用 npm run test:install');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-package-test-'));
const env = { ...process.env, npm_config_cache: path.join(root, 'cache') };
const options = { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] };
const npm = (...args) => execFileSync(process.execPath, [npmCli, ...args], options);

try {
  const [packed] = JSON.parse(npm('pack', '--json', '--pack-destination', root));
  assert.deepEqual(packed.files.map((file) => file.path).sort(),
    ['LICENSE', 'README.md', 'config.json', 'glm.mjs', 'package.json', 'setup.mjs', 'statusline.mjs']);
  const tarball = path.join(root, packed.filename);
  const prefix = path.join(root, 'global install');
  npm('install', '-g', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball);
  const cli = process.platform === 'win32' ? path.join(prefix, 'glm-statusline.cmd')
    : path.join(prefix, 'bin', 'glm-statusline');
  const runCli = (arg) => process.platform === 'win32'
    ? execSync(`"${cli}" ${arg}`, options) : execFileSync(cli, [arg], options);
  assert.equal(runCli('--version').trim(), version);
  assert.match(runCli('--demo'), /5h 62%/);
  console.log(`PASS npm global entry: ${process.platform}/${process.arch}`);

  assert.equal(npm('exec', '--offline', '--yes', '--package', tarball, '--', 'glm-statusline', '--version').trim(), version);
  console.log('PASS npm exec / npx entry');

  // 重定向 home 后通过包入口执行真实 --setup，随后用生成的命令读取会话 stdin。
  const home = path.join(root, 'isolated home');
  await fs.mkdir(home);
  options.env = { ...env, HOME: home, USERPROFILE: home };
  npm('exec', '--offline', '--yes', '--package', tarball, '--', 'glm-statusline', '--setup');
  const claudeDir = path.join(home, '.claude');
  const config = path.join(claudeDir, 'glm-statusline.json');
  await fs.writeFile(config, JSON.stringify({ segments: ['model'] }));
  const { statusLine } = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(execSync(statusLine.command, {
    ...options, env: { ...options.env, GLM_STATUSLINE_CONFIG: config },
    input: JSON.stringify({ model: { display_name: 'Installed OK' } }),
  }).replace(/\x1b\[[0-9;]*m/g, '').trim(), 'Installed OK');
  console.log('PASS packaged --setup and installed statusLine command');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
