#!/usr/bin/env node
// glm-statusline — Claude Code 状态栏：显示 GLM 剩余额度（套餐 5 小时/每周 + 账户余额）
//
// 用法：
//   在 ~/.claude/settings.json 中配置：
//     glm-statusline --setup
//   Claude Code 会通过 stdin 传入会话 JSON，本脚本向 stdout 输出一行状态栏。
//
// 调试：
//   glm-statusline --setup   # 自动配置 Claude Code
//   glm-statusline --query   # 立即真实查询一次额度并打印解析结果
//   glm-statusline --demo    # 用假数据预览状态栏样式（无网络请求）

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getGlmInfo, PLATFORM_BASE } from './glm.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── 颜色 ────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const paint = (s, color) => `${color}${s}${C.reset}`;

// ── 配置 ────────────────────────────────────────────────────
const DEFAULTS = {
  segments: ['model', 'dir', 'git', 'ctx', 'glm'], // 要显示的分段，按顺序
  lang: 'zh',                                       // zh | en
  glm: {
    platform: 'auto',   // auto | cn | en（auto 时按 ANTHROPIC_BASE_URL 判断）
    showBalance: true,  // 是否显示按量付费账户余额（仅 cn 平台）
    showLevel: true,    // 是否显示套餐等级（PRO 等）
  },
  cacheTtlSeconds: 60,    // 额度查询缓存时间
  staleSeconds: 1800,     // 查询失败时过期缓存最长可用时间
  timeoutMs: 5000,        // 单次请求超时
  contextLimit: 0,        // 上下文窗口，0 = 按模型自动（200k / 1M）
};

export function normalizeConfig(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  const glm = user.glm ?? {};
  const number = (key, min = 0, max = Number.MAX_SAFE_INTEGER) =>
    Number.isFinite(user[key]) && user[key] >= min && user[key] <= max
      ? user[key] : DEFAULTS[key];
  return {
    segments: Array.isArray(user.segments)
      ? [...new Set(user.segments.filter((s) => DEFAULTS.segments.includes(s)))]
      : [...DEFAULTS.segments],
    lang: ['zh', 'en'].includes(user.lang) ? user.lang : DEFAULTS.lang,
    glm: {
      platform: ['auto', 'cn', 'en'].includes(glm.platform) ? glm.platform : DEFAULTS.glm.platform,
      showBalance: typeof glm.showBalance === 'boolean' ? glm.showBalance : DEFAULTS.glm.showBalance,
      showLevel: typeof glm.showLevel === 'boolean' ? glm.showLevel : DEFAULTS.glm.showLevel,
    },
    cacheTtlSeconds: number('cacheTtlSeconds'),
    staleSeconds: number('staleSeconds'),
    timeoutMs: Math.floor(number('timeoutMs', 1, 2_147_483_647)),
    contextLimit: number('contextLimit'),
  };
}

async function loadConfig() {
  const override = process.env.GLM_STATUSLINE_CONFIG;
  const files = override ? [override] : [
    path.join(os.homedir(), '.claude', 'glm-statusline.json'),
    path.join(SCRIPT_DIR, 'config.json'),
  ];
  for (const file of files) {
    try {
      return normalizeConfig(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        if (process.env.GLM_STATUSLINE_DEBUG) console.error(`读取配置失败：${file}`, e.message);
        return normalizeConfig({});
      }
    }
  }
  return normalizeConfig({});
}

// ── API Key / 平台识别 ──────────────────────────────────────
async function loadClaudeSettingsEnv() {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    return JSON.parse(await fs.readFile(p, 'utf8'))?.env ?? {};
  } catch {
    return {};
  }
}

function resolveKey(env) {
  return (
    process.env.GLM_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    null
  );
}

function resolvePlatform(config, env) {
  if (config.glm.platform && config.glm.platform !== 'auto') return config.glm.platform;
  const base = String(env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? '');
  if (base.includes('z.ai')) return 'en';
  return 'cn'; // bigmodel.cn 及其他情况默认走国内版
}

// ── 数据采集 ────────────────────────────────────────────────
async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    setTimeout(done, 1500).unref(); // 手动运行且未管道输入时兜底
  });
}

export async function gitBranch(cwd) {
  let dir = path.resolve(cwd);
  while (dir) {
    const dotGit = path.join(dir, '.git');
    const st = await fs.stat(dotGit).catch(() => null);
    if (st) {
      let head = null;
      if (st.isDirectory()) {
        head = await fs.readFile(path.join(dotGit, 'HEAD'), 'utf8').catch(() => null);
      } else {
        // worktree：.git 是文件，内容形如 "gitdir: <path>"
        const s = await fs.readFile(dotGit, 'utf8').catch(() => null);
        const m = s && s.match(/gitdir:\s*(.+)/);
        if (m) {
          const gd = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(dir, m[1].trim());
          head = await fs.readFile(path.join(gd, 'HEAD'), 'utf8').catch(() => null);
        }
      }
      if (head) {
        const m = head.match(/^ref:\s*refs\/heads\/(\S+)/);
        return m ? m[1] : '(detached)';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 从 transcript 尾部取最近一次 assistant 用量，估算当前上下文 token 数
async function contextTokens(transcriptPath) {
  if (!transcriptPath) return null;
  const fh = await fs.open(transcriptPath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 128 * 1024);
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const u = JSON.parse(lines[i])?.message?.usage;
        if (u) {
          return (
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0)
          );
        }
      } catch { /* 尾部截断的半行 JSON，跳过 */ }
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return null;
}

// ── 渲染 ────────────────────────────────────────────────────
const L = {
  zh: { week: '周', ctx: 'ctx', noKey: 'GLM 未配置 Key', fail: 'GLM 查询失败',
    stale: '缓存', partial: '部分查询失败', refreshing: 'GLM 刷新中' },
  en: { week: 'wk', ctx: 'ctx', noKey: 'GLM no key', fail: 'GLM query failed',
    stale: 'cached', partial: 'partial failure', refreshing: 'GLM refreshing' },
};

function fmtCountdown(resetMs) {
  if (!resetMs) return null;
  const s = Math.round((resetMs - Date.now()) / 1000);
  if (s <= 0) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

// 剩余比例着色：<=15% 红，<=40% 黄，其余绿
const remainColor = (remain) => (remain <= 15 ? C.red : remain <= 40 ? C.yellow : C.green);

function quotaPart(label, entry) {
  if (!entry) return null;
  const remain = Math.round(100 - entry.usedPct);
  const cd = fmtCountdown(entry.resetMs);
  return paint(`${label} ${remain}%`, remainColor(remain)) + (cd ? paint(` (${cd})`, C.dim) : '');
}

function fmtBalance(n) {
  const s = n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(Math.round(n * 100) / 100);
  return `¥${s}`;
}

export function renderGlm(info, config, platform) {
  const t = L[config.lang] ?? L.zh;
  const chunks = [];
  if (config.glm.showLevel && info.level) chunks.push(paint(info.level.toUpperCase(), C.yellow));
  const five = quotaPart('5h', info.five);
  if (five) chunks.push(five);
  const weekly = quotaPart(t.week, info.weekly);
  if (weekly) chunks.push(weekly);
  if (config.glm.showBalance && platform === 'cn' && info.balance != null) {
    chunks.push(paint(fmtBalance(info.balance), C.green));
  }
  if (!chunks.length) {
    if (info.refreshing) return paint(t.refreshing, C.dim);
    return paint(`${t.fail}: ${info.error || info.partialError || '无数据'}`, C.red);
  }
  if (info.stale) chunks.push(paint(t.stale, C.yellow));
  else if (info.partialError) chunks.push(paint(t.partial, C.yellow));
  return chunks.join(paint(' · ', C.dim));
}

async function render(input, config) {
  if (!input || typeof input !== 'object') input = {};
  const t = L[config.lang] ?? L.zh;
  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  const env = config.segments.includes('glm') && !config._demo ? await loadClaudeSettingsEnv() : {};
  const key = resolveKey(env);
  const platform = resolvePlatform(config, env);
  const parts = {};

  for (const seg of config.segments) {
    switch (seg) {
      case 'model': {
        const name = input.model?.display_name || input.model?.id || '';
        if (name) parts.model = paint(name, C.cyan);
        break;
      }
      case 'dir': {
        parts.dir = paint(path.basename(cwd) || cwd, C.blue);
        break;
      }
      case 'git': {
        const branch = await gitBranch(cwd);
        if (branch) parts.git = paint(branch, C.magenta);
        break;
      }
      case 'ctx': {
        const limit =
          config.contextLimit > 0
            ? config.contextLimit
            : /\[1m\]|1m/i.test(input.model?.id || '') ? 1_000_000 : 200_000;
        const used = await contextTokens(input.transcript_path);
        if (used != null) {
          const pct = Math.min(100, Math.round((used / limit) * 100));
          // ctx 显示剩余百分比，但按已用比例着色（用得越多越红）
          parts.ctx = paint(`${t.ctx} ${100 - pct}%`, pct >= 85 ? C.red : pct >= 60 ? C.yellow : C.green);
        }
        break;
      }
      case 'glm': {
        if (config._demo) {
          // 假数据预览，无网络请求
          const now = Date.now();
          parts.glm = renderGlm({ level: 'pro',
            five: { usedPct: 38, resetMs: now + 132 * 60000 },
            weekly: { usedPct: 12, resetMs: now + 82 * 3600000 }, balance: 46.2,
          }, config, platform);
          break;
        }
        if (!key) {
          parts.glm = paint(t.noKey, C.yellow);
          break;
        }
        const info = await getGlmInfo({
          key,
          platform,
          showBalance: config.glm.showBalance,
          ttlSec: config.cacheTtlSeconds,
          staleSec: config.staleSeconds,
          timeoutMs: config.timeoutMs,
        });
        parts.glm = renderGlm(info, config, platform);
        break;
      }
    }
  }

  return config.segments.map((s) => parts[s]).filter(Boolean).join(paint(' | ', C.dim));
}

// ── 入口 ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`glm-statusline — Claude Code 的 GLM 额度状态栏

用法：glm-statusline [选项]

  --setup       安装运行文件并配置 Claude Code（已有设置自动备份）
  --demo        使用假数据预览，不请求接口
  --query       强制查询并输出 JSON
  --version     显示版本
  --help        显示帮助

无选项时从 stdin 读取 Claude Code 会话 JSON，输出一行状态栏。
用户配置：~/.claude/glm-statusline.json
也可通过 GLM_STATUSLINE_CONFIG 指定配置文件。`);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(JSON.parse(await fs.readFile(path.join(SCRIPT_DIR, 'package.json'), 'utf8')).version);
    return;
  }
  if (args.some((arg) => !['--setup', '--demo', '--query'].includes(arg)) || args.length > 1) {
    throw new Error('请每次使用一个选项；运行 glm-statusline --help 查看用法');
  }
  if (args.includes('--setup')) {
    const { setup } = await import('./setup.mjs');
    const result = await setup();
    console.log(`已配置 Claude Code：${result.settingsPath}`);
    console.log(`用户配置：${result.configPath}`);
    if (result.backupPath) console.log(`原设置备份：${result.backupPath}`);
    console.log('重启 Claude Code 或开启新会话即可生效。');
    return;
  }
  const config = await loadConfig();

  if (process.argv.includes('--demo')) {
    const fake = {
      model: { display_name: 'GLM-4.6' },
      workspace: { current_dir: process.cwd() },
    };
    const line = await render(fake, { ...config, _demo: true });
    console.log(line);
    return;
  }

  if (process.argv.includes('--query')) {
    const env = await loadClaudeSettingsEnv();
    const key = resolveKey(env);
    if (!key) {
      console.error('未找到 API Key（检查 GLM_API_KEY 或 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN）');
      process.exit(1);
    }
    const platform = resolvePlatform(config, env);
    console.error(`平台: ${platform} (${PLATFORM_BASE[platform]})  Key: ${key.slice(0, 6)}***`);
    const info = await getGlmInfo({
      key,
      platform,
      showBalance: config.glm.showBalance,
      ttlSec: 0, // 强制刷新
      staleSec: config.staleSeconds,
      timeoutMs: config.timeoutMs,
      force: true,
    });
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  const input = await readStdinJson();
  const line = await render(input, config);
  if (line) console.log(line);
}

const entryPath = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]));
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) main().catch((e) => {
  if (process.argv.length > 2) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  // 状态栏脚本绝不能抛错——最坏情况输出一行占位
  console.log(paint('glm-statusline', C.dim));
  if (process.env.GLM_STATUSLINE_DEBUG) console.error(e);
});
