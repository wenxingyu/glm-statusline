import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILES = ['statusline.mjs', 'glm.mjs', 'deepseek.mjs', 'minimax.mjs', 'tokens.mjs', 'cache.mjs',
  'proxy.mjs', 'setup.mjs', 'package.json', 'config.json', 'LICENSE'];

function shellQuote(value) {
  if (process.platform === 'win32') {
    // 参数路径保留引号以支持空格；正斜杠同时适用于 PowerShell、CMD 和 Git Bash。
    const normalized = value.replaceAll('\\', '/');
    if (/["\r\n$`%]/.test(normalized)) throw new Error('安装路径包含不支持的 shell 特殊字符');
    return `"${normalized}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readOptional(file) {
  try { return await fs.readFile(file); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return null;
  }
}

async function atomicWrite(file, contents) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function installConfig(configPath, installDir) {
  // 独立记录这次迁移；用户之后编辑或恢复配置，不会再次触发覆盖。
  const statePath = path.join(installDir, 'setup-state.json');
  const stateBytes = await readOptional(statePath);
  let state = {};
  if (stateBytes !== null) {
    try { state = JSON.parse(stateBytes.toString('utf8')); } catch {
      throw new Error(`安装状态不是有效 JSON，请先修复：${statePath}`);
    }
    if (!Number.isInteger(state?.configRevision) || state.configRevision < 1) {
      throw new Error(`安装状态无效，请先修复：${statePath}`);
    }
  }
  const original = await readOptional(configPath);
  const migrate = stateBytes === null;
  let configBackupPath = null;
  if (original === null || migrate) {
    const defaults = await fs.readFile(path.join(SOURCE_DIR, 'config.json'));
    if (original !== null) {
      configBackupPath = `${configPath}.backup-${Date.now()}-${randomUUID()}`;
      // 原始字节备份成功后才替换；即使旧 JSON 损坏也能完整恢复。
      await fs.writeFile(configBackupPath, original, { flag: 'wx', mode: 0o600 });
    }
    await atomicWrite(configPath, defaults);
  }
  if (migrate) await atomicWrite(statePath, `${JSON.stringify({ configRevision: 1 })}\n`);
  return configBackupPath;
}

export async function setup({ claudeDir = path.join(os.homedir(), '.claude') } = {}) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const configPath = path.join(claudeDir, 'glm-statusline.json');
  const installDir = path.join(claudeDir, 'glm-statusline');
  // PowerShell 不能直接执行带引号的可执行文件路径；其 & 调用语法又不兼容 CMD/Bash。
  // Windows 使用 PATH 中的 node 作为三种 shell 都能识别的命令，脚本路径仍单独引用。
  const executable = process.platform === 'win32' ? 'node' : shellQuote(process.execPath);
  const command = `${executable} ${shellQuote(path.join(installDir, 'statusline.mjs'))}`;
  let original = null;
  let settings = {};
  try {
    original = await fs.readFile(settingsPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (original !== null) {
    try { settings = JSON.parse(original); } catch {
      throw new Error(`配置不是有效 JSON，请先修复：${settingsPath}`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`配置必须是 JSON 对象：${settingsPath}`);
    }
  }

  // 先部署运行文件，再切换入口；npx 缓存清理和 npm 升级不会破坏入口路径。
  await fs.mkdir(installDir, { recursive: true });
  for (const file of RUNTIME_FILES) {
    const source = path.join(SOURCE_DIR, file);
    const destination = path.join(installDir, file);
    if (source !== destination) await fs.copyFile(source, destination);
  }
  const configBackupPath = await installConfig(configPath, installDir);

  let backupPath = null;
  if (settings.statusLine?.type !== 'command' || settings.statusLine?.command !== command) {
    if (original !== null) {
      backupPath = `${settingsPath}.backup-${Date.now()}-${randomUUID()}`;
      await fs.writeFile(backupPath, original, { flag: 'wx', mode: 0o600 });
    }
    settings.statusLine = { type: 'command', command };
    await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { settingsPath, configPath, backupPath, configBackupPath, installDir };
}
