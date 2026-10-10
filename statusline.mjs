#!/usr/bin/env node
// glm-statusline — Claude Code 状态栏：显示 GLM 剩余额度（套餐 5 小时/每周 + 账户余额）
//
// 用法：
//   在 ~/.claude/settings.json 中配置：
//     "statusLine": { "type": "command", "command": "node \"D:/Code/glm-statusline/statusline.mjs\"" }
//   Claude Code 会通过 stdin 传入会话 JSON，本脚本向 stdout 输出一行状态栏。
//
// 调试：
//   node statusline.mjs --query   # 立即真实查询一次额度并打印解析结果
//   node statusline.mjs --demo    # 用假数据预览状态栏样式（无网络请求）

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function loadConfig() {
  const override = process.env.GLM_STATUSLINE_CONFIG;
  const file = override || path.join(SCRIPT_DIR, 'config.json');
  try {
    const user = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      ...DEFAULTS,
      ...user,
      glm: { ...DEFAULTS.glm, ...(user.glm ?? {}) },
    };
  } catch {
    return DEFAULTS;
  }
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

async function gitBranch(cwd) {
  let dir = cwd;
  for (let i = 0; i < 5 && dir; i++) {
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
  zh: { week: '周', ctx: 'ctx', noKey: 'GLM 未配置 Key', fail: 'GLM 查询失败' },
  en: { week: 'wk', ctx: 'ctx', noKey: 'GLM no key', fail: 'GLM query failed' },
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

async function render(input, config) {
  const t = L[config.lang] ?? L.zh;
  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  const env = await loadClaudeSettingsEnv();
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
          parts.glm = [
            paint('PRO', C.yellow),
            quotaPart('5h', { usedPct: 38, resetMs: now + 132 * 60000 }),
            quotaPart(t.week, { usedPct: 12, resetMs: now + 82 * 3600000 }),
            paint('¥46.2', C.green),
          ].join(paint(' · ', C.dim));
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
        const chunks = [];
        if (config.glm.showLevel && info.level) {
          chunks.push(paint(info.level.toUpperCase(), C.yellow));
        }
        const five = quotaPart('5h', info.five);
        if (five) chunks.push(five);
        const weekly = quotaPart(t.week, info.weekly);
        if (weekly) chunks.push(weekly);
        if (info.balance != null) chunks.push(paint(fmtBalance(info.balance), C.green));
        if (chunks.length) {
          parts.glm = chunks.join(paint(' · ', C.dim));
          if (info.partialError && !info.five && !info.balance) {
            // 理论不可达，防御：无任何数据时显示错误
            parts.glm = paint(`${t.fail}: ${info.partialError}`, C.red);
          }
        } else {
          parts.glm = paint(`${t.fail}: ${info.error}`, C.red);
        }
        break;
      }
    }
  }

  return config.segments.map((s) => parts[s]).filter(Boolean).join(paint(' | ', C.dim));
}

// ── 入口 ────────────────────────────────────────────────────
async function main() {
  const config = await loadConfig();

  if (process.argv.includes('--demo')) {
    const fake = {
      model: { display_name: 'GLM-4.6' },
      workspace: { current_dir: path.join('D:', 'Code', 'glm-statusline') },
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

main().catch((e) => {
  // 状态栏脚本绝不能抛错——最坏情况输出一行占位
  console.log(paint('glm-statusline', C.dim));
  if (process.env.GLM_STATUSLINE_DEBUG) console.error(e);
});
