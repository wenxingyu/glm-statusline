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

const CACHE_FILE = path.join(os.tmpdir(), 'glm-statusline-cache.json');

export const PLATFORM_BASE = {
  cn: 'https://open.bigmodel.cn',
  en: 'https://api.z.ai',
};

const BALANCE_URL = 'https://bigmodel.cn/api/biz/account/query-customer-account-report';

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
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
    const entry = {
      usedPct: clampPct(Number(item?.percentage) || 0),
      resetMs: asResetMs(item?.nextResetTime),
    };
    switch (item?.unit) {
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
  const raw = d.availableBalance ?? d.balance;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('响应中无有效余额字段');
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

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(cache) {
  try {
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache));
    await fs.rename(tmp, CACHE_FILE);
  } catch {
    // 缓存写失败不影响主流程
  }
}

/**
 * 获取 GLM 额度信息（带 TTL 缓存；查询失败时回退到过期缓存）。
 * @returns {Promise<{ok:boolean, level:?string, five:?object, weekly:?object,
 *                     balance:?number, error:?string, age:number}>}
 */
export async function getGlmInfo({
  key,
  platform = 'cn',
  showBalance = true,
  ttlSec = 60,
  staleSec = 1800,
  timeoutMs = 5000,
  force = false,
}) {
  const now = Date.now();
  const prev = await readCache();
  const fresh = prev && !force && now - prev.t <= ttlSec * 1000;
  if (fresh) return present(prev, now);

  const base = PLATFORM_BASE[platform] ?? PLATFORM_BASE.cn;
  const needBalance = platform === 'cn' && showBalance;

  const [planRes, balRes] = await Promise.allSettled([
    fetchJson(`${base}/api/monitor/usage/quota/limit`, { Authorization: key }, timeoutMs),
    needBalance
      ? fetchJson(BALANCE_URL, { Authorization: `Bearer ${key}` }, timeoutMs)
      : Promise.resolve(null),
  ]);

  const pick = (r, parse, prevVal) => {
    if (r.status === 'fulfilled' && r.value !== null) {
      try {
        return { val: parse(r.value), err: null };
      } catch (e) {
        return { val: prevVal ?? null, err: e.message };
      }
    }
    const err = r.status === 'rejected' ? errMsg(r.reason) : '查询失败';
    return { val: prevVal ?? null, err };
  };

  const plan = pick(planRes, parsePlan, prev?.plan);
  const bal = pick(balRes, parseBalance, prev?.balance);

  const cache = {
    t: now,
    plan: plan.val,
    planError: plan.err,
    balance: bal.val,
    balanceError: bal.err,
  };
  await writeCache(cache);
  return present(cache, now);
}

function errMsg(e) {
  if (e && e.name === 'TimeoutError') return '查询超时';
  if (e && e.name === 'AbortError') return '查询中止';
  return (e && e.message) || '网络错误';
}

function present(c, now) {
  const ok = Boolean(c && c.plan);
  const err = (c && (c.planError || c.balanceError)) || null;
  return {
    ok,
    level: (c?.plan && c.plan.level) || null,
    five: (c?.plan && c.plan.five) || null,
    weekly: (c?.plan && c.plan.weekly) || null,
    balance: c?.balance ?? null,
    error: ok ? null : (err || '无数据'),
    partialError: ok ? err : null,
    age: c ? now - c.t : -1,
  };
}
