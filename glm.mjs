// GLM 额度查询模块
//
// 查询两类数据（接口参考 cc-switch / cc-toolkit 社区项目，生产验证过）：
//
// 1. Coding Plan 套餐额度
//    GET {base}/api/monitor/usage/quota/limit
//    - base 由平台决定：cn → https://open.bigmodel.cn，en → https://api.z.ai
//    - 认证：Authorization: <apiKey>（注意：智谱不加 Bearer 前缀）
//    - 响应：data.limits[]，percentage 为已用百分比；nextResetTime 为毫秒时间戳
//      unit=3 → 5 小时滚动窗口；unit=6 → 每周窗口（number 可能是 7 或 1）
//      老套餐只返回 1 条 TOKENS_LIMIT（仅 5 小时），新套餐返回 2 条
//    - data.level 为套餐等级（lite/pro/max）
//
// 2. 按量付费账户余额（仅国内 cn 平台）
//    GET https://bigmodel.cn/api/biz/account/query-customer-account-report
//    - 认证：Authorization: Bearer <apiKey>
//    - 响应：data.balance / data.availableBalance（单位 CNY）
//
// 所有请求结果按 TTL 写入临时文件缓存，避免状态栏高频刷新时打爆接口。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CACHE_DIR = path.join(os.tmpdir(), 'glm-statusline-v2');

export const PLATFORM_BASE = {
  cn: 'https://open.bigmodel.cn',
  en: 'https://api.z.ai',
};

const BALANCE_URL = 'https://bigmodel.cn/api/biz/account/query-customer-account-report';

function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// nextResetTime 兼容：毫秒数字 / 秒级数字 / 数字字符串
function asResetMs(v) {
  let n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e12) n *= 1000; // 秒 → 毫秒
  return n;
}

/** 解析套餐额度响应 → { level, five, weekly } */
export function parsePlan(body) {
  if (body && body.success === false) {
    throw new Error(String(body.msg || '接口返回失败'));
  }
  const data = body && body.data;
  if (!data || !Array.isArray(data.limits)) {
    throw new Error('响应格式异常：缺少 data.limits');
  }

  let five = null;
  let weekly = null;
  const unclassified = [];

  for (const item of data.limits) {
    const type = String(item?.type ?? '');
    if (!/^(TOKENS_LIMIT|CREDIT_LIMIT)$/i.test(type)) continue;
    const percentage = numeric(item.percentage);
    if (percentage === null) throw new Error('响应中无有效额度百分比');
    const entry = {
      usedPct: Math.min(100, Math.max(0, percentage)),
      resetMs: asResetMs(item?.nextResetTime),
    };
    switch (Number(item?.unit)) {
      case 3: if (!five) five = entry; break;   // 5 小时滚动窗口
      case 6: if (!weekly) weekly = entry; break; // 每周窗口
      default: unclassified.push(entry); break; // unit 缺失/不识别 → 兜底
    }
  }

  // 兜底启发式（unit 字段缺失时）：无重置时间的条目优先当 5 小时桶
  //（5h 桶在 0% 等状态下可能没有 reset），其余按重置时间升序依次填空位。
  unclassified.sort((a, b) =>
    ((a.resetMs == null ? 0 : 1) - (b.resetMs == null ? 0 : 1)) ||
    ((a.resetMs ?? 0) - (b.resetMs ?? 0))
  );
  for (const e of unclassified) {
    if (!five) five = e;
    else if (!weekly) weekly = e;
    // 智谱当前最多两条 TOKENS_LIMIT，多余的忽略
  }

  if (!five && !weekly) throw new Error('响应中无有效套餐额度');

  return {
    level: typeof data.level === 'string' ? data.level : null,
    five,
    weekly,
  };
}

/** 解析账户余额响应 → CNY 数值 */
export function parseBalance(body) {
  if (Number(body?.code) !== 200) {
    throw new Error(String(body?.msg || `查询失败 (code=${body?.code})`));
  }
  const d = body?.data ?? {};
  const n = numeric(d.availableBalance) ?? numeric(d.balance);
  if (n === null) throw new Error('响应中无有效余额字段');
  return n;
}

async function fetchJson(url, headers, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'glm-statusline/1.0',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`API Key 无效 (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function validEntry(entry, isPlan) {
  if (!entry || !Number.isFinite(entry.attemptAt) || !Number.isFinite(entry.updatedAt)) return null;
  if (entry.error !== null && typeof entry.error !== 'string') return null;
  const value = entry.value;
  if (value !== null) {
    if (!isPlan && !Number.isFinite(value)) return null;
    if (isPlan) {
      if (!value || (value.level !== null && typeof value.level !== 'string')) return null;
      if (!value.five && !value.weekly) return null;
      for (const quota of [value.five, value.weekly]) {
        if (quota !== null && (!quota || !Number.isFinite(quota.usedPct) || quota.usedPct < 0 ||
          quota.usedPct > 100 || (quota.resetMs !== null && !Number.isFinite(quota.resetMs)))) return null;
      }
    }
  }
  return entry;
}

async function readCache(file) {
  try {
    const cache = JSON.parse(await fs.readFile(file, 'utf8'));
    if (cache.version !== 2) return {};
    return { plan: validEntry(cache.plan, true), balance: validEntry(cache.balance, false) };
  } catch {
    return {};
  }
}

async function writeCache(file, cache) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ version: 2, ...cache }), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    // 缓存写失败不影响主流程
    if (process.env.GLM_STATUSLINE_DEBUG) console.error('缓存写入失败:', e.message);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// 独占文件锁：其他进程立即返回可用缓存，不阻塞状态栏等待网络。
async function acquireLock(file) {
  const lock = `${file}.lock`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
  } catch {
    return async () => {}; // 缓存目录不可用时仍允许查询
  }
  try {
    const handle = await fs.open(lock, 'wx', 0o600);
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    return async () => { await fs.unlink(lock).catch(() => {}); };
  } catch (e) {
    if (e.code !== 'EEXIST') return async () => {}; // 临时目录不可写时仍允许查询
    return null;
  }
}

// 崩溃进程留下的锁由独立的回收锁串行清理，避免多个进程误删新锁。
async function recoverLock(file) {
  const recovery = `${file}.recovery`;
  let handle;
  try {
    handle = await fs.open(recovery, 'wx', 0o600);
    const lock = `${file}.lock`;
    const pid = Number(await fs.readFile(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) {
        if (e.code === 'ESRCH') await fs.unlink(lock);
      }
    } else {
      const stat = await fs.stat(lock);
      if (Date.now() - stat.mtimeMs > 120_000) await fs.unlink(lock);
    }
  } catch { /* 锁正被创建、回收，或无权限时保留 */ }
  finally {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.unlink(recovery).catch(() => {});
    }
  }
}

const ageOf = (entry, now) => entry && entry.updatedAt > 0 && entry.updatedAt <= now
  ? now - entry.updatedAt : Infinity;
const fresh = (entry, now, ttlSec) => Boolean(entry && ttlSec > 0 &&
  entry.attemptAt <= now && now - entry.attemptAt < ttlSec * 1000);

async function refresh(url, headers, parse, previous, timeoutMs) {
  try {
    const value = parse(await fetchJson(url, headers, timeoutMs));
    const now = Date.now();
    return { value, updatedAt: now, attemptAt: now, error: null };
  } catch (e) {
    return { value: previous?.value ?? null, updatedAt: previous?.updatedAt ?? 0,
      attemptAt: Date.now(), error: errMsg(e) };
  }
}

/**
 * 获取 GLM 额度信息（带 TTL 缓存；查询失败时回退到过期缓存）。
 * 套餐和余额分别记录最后成功时间与尝试时间；失败不会延长数据寿命。
 * age 为展示数据中最旧一项的年龄（毫秒），无数据时为 -1。
 */
export async function getGlmInfo({
  key,
  platform = 'cn',
  showBalance = true,
  ttlSec = 60,
  staleSec = 1800,
  timeoutMs = 5000,
  force = false,
  cacheDir = CACHE_DIR,
}) {
  platform = platform === 'en' ? 'en' : 'cn';
  const hash = createHash('sha256').update(String(key)).digest('hex');
  const file = path.join(cacheDir, `${platform}-${hash}.json`);
  const needBalance = platform === 'cn' && showBalance;
  const show = (cache, refreshing = false, updated = []) => present(cache, Date.now(),
    { needBalance, ttlSec, staleSec, refreshing, updated });
  let prev = await readCache(file);
  const due = (entry) => force || !fresh(entry, Date.now(), ttlSec);
  if (!due(prev.plan) && (!needBalance || !due(prev.balance))) return show(prev);

  let release = await acquireLock(file);
  if (!release) {
    await recoverLock(file);
    release = await acquireLock(file);
  }
  if (!release) return show(await readCache(file), true);
  try {
    // 获取锁前可能已有另一个进程完成了刷新。
    prev = await readCache(file);
    const [plan, balance] = await Promise.all([
      due(prev.plan) ? refresh(`${PLATFORM_BASE[platform]}/api/monitor/usage/quota/limit`,
        { Authorization: key }, parsePlan, prev.plan, timeoutMs) : prev.plan,
      needBalance && due(prev.balance) ? refresh(BALANCE_URL,
        { Authorization: `Bearer ${key}` }, parseBalance, prev.balance, timeoutMs) : prev.balance,
    ]);
    const cache = { plan: plan ?? null, balance: balance ?? null };
    await writeCache(file, cache);
    const updated = [plan !== prev.plan ? plan : null, balance !== prev.balance ? balance : null]
      .filter((entry) => entry && !entry.error);
    return show(cache, false, updated);
  } finally {
    await release();
  }
}

function errMsg(e) {
  if (e && e.name === 'TimeoutError') return '查询超时';
  if (e && e.name === 'AbortError') return '查询中止';
  return (e && e.message) || '网络错误';
}

function present(c, now, { needBalance, ttlSec, staleSec, refreshing, updated }) {
  const usable = (entry) => {
    if (entry?.value == null) return false;
    if (updated.includes(entry)) return true; // TTL 为 0 时，本次查询结果仍然有效
    if (entry.error && staleSec <= 0) return false;
    const maxAge = entry.error ? staleSec : Math.max(ttlSec, staleSec);
    return ageOf(entry, now) <= maxAge * 1000;
  };
  const plan = usable(c.plan) ? c.plan.value : null;
  const balance = needBalance && usable(c.balance) ? c.balance.value : null;
  const shown = [plan ? c.plan : null, balance !== null ? c.balance : null].filter(Boolean);
  const stale = shown.some((entry) => !updated.includes(entry) &&
    (Boolean(entry.error) || ageOf(entry, now) >= ttlSec * 1000));
  const ok = Boolean(plan || balance !== null);
  const err = c.plan?.error || (needBalance && c.balance?.error) || null;
  return {
    ok,
    level: plan?.level ?? null,
    five: plan?.five ?? null,
    weekly: plan?.weekly ?? null,
    balance,
    error: ok ? null : (err || (refreshing ? '刷新中' : '无数据')),
    partialError: ok ? err : null,
    age: shown.length ? Math.max(...shown.map((entry) => ageOf(entry, now))) : -1,
    stale,
    refreshing,
  };
}
