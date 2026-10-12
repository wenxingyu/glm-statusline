import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILES = ['statusline.mjs', 'glm.mjs', 'proxy.mjs', 'setup.mjs', 'package.json', 'config.json', 'LICENSE'];

function shellQuote(value) {
  if (process.platform === 'win32') {
    // Claude Code 在 Windows 下通过 shell 执行命令；正斜杠同时适用于 Git Bash。
    const normalized = value.replaceAll('\\', '/');
    if (/["\r\n$`%]/.test(normalized)) throw new Error('安装路径包含不支持的 shell 特殊字符');
    return `"${normalized}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function setup({ claudeDir = path.join(os.homedir(), '.claude') } = {}) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const configPath = path.join(claudeDir, 'glm-statusline.json');
  const installDir = path.join(claudeDir, 'glm-statusline');
  const command = `${shellQuote(process.execPath)} ${shellQuote(path.join(installDir, 'statusline.mjs'))}`;
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
  try {
    await fs.writeFile(configPath, await fs.readFile(path.join(SOURCE_DIR, 'config.json')), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  let backupPath = null;
  if (settings.statusLine?.type !== 'command' || settings.statusLine?.command !== command) {
    if (original !== null) {
      backupPath = `${settingsPath}.backup-${Date.now()}-${randomUUID()}`;
      await fs.writeFile(backupPath, original, { flag: 'wx', mode: 0o600 });
    }
    settings.statusLine = { type: 'command', command };
    const tmp = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, settingsPath);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return { settingsPath, configPath, backupPath, installDir };
}
