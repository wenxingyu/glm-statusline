// MiniMax Token Plan quota. Percentage fields are remaining quota, not usage.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchWithProxy } from './proxy.mjs';
import { cachedQuery } from './cache.mjs';

export const MINIMAX_BASE = { cn: 'https://www.minimaxi.com', en: 'https://www.minimax.io' };
const LEVELS = new Set(['go', 'explore', 'build']);
const numeric = (v) => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') &&
  Number.isFinite(Number(v)) ? Number(v) : null;

function windowQuota(entry, prefix, endField, remainsField, now) {
  const remaining = numeric(entry[`${prefix}_remaining_percent`]);
  if (remaining === null || remaining < 0 || remaining > 100 || numeric(entry[`${prefix}_status`]) === 3) return null;
  const end = numeric(entry[endField]);
  const duration = numeric(entry[remainsField]);
  const resetMs = end > 0 ? (end < 1e12 ? end * 1000 : end)
    : duration !== null && duration >= 0 ? now + duration : null;
  return { usedPct: 100 - remaining, resetMs };
}

export function parseMiniMaxPlan(body, { model = 'auto', now = Date.now() } = {}) {
  if (body?.base_resp?.status_code != null && numeric(body.base_resp.status_code) !== 0) {
    throw new Error('MiniMax API rejected the quota request');
  }
  const entries = body?.model_remains ?? body?.data?.model_remains;
  if (!Array.isArray(entries)) throw new Error('Missing model_remains');
  const valid = entries.filter((e) => e && typeof e.model_name === 'string');
  const entry = model === 'auto'
    ? valid.find((e) => e.model_name.toLowerCase() === 'general') ?? (valid.length === 1 ? valid[0] : null)
    : valid.find((e) => e.model_name.toLowerCase() === model.toLowerCase());
  if (!entry) throw new Error('No matching MiniMax quota model');
  const five = windowQuota(entry, 'current_interval', 'end_time', 'remains_time', now);
  const weekly = windowQuota(entry, 'current_weekly', 'weekly_end_time', 'weekly_remains_time', now);
  // usage_count has differed between endpoints; never invent a percentage from ambiguous counts.
  if (!five && !weekly) throw new Error('No reliable MiniMax quota percentage');
  // The official quota schema has no tier; counts do not identify an M Plan tier.
  return { model: entry.model_name, level: null, five, weekly };
}

function validValue(value) {
  if (!value || typeof value.model !== 'string' || (!value.five && !value.weekly)) return false;
  // Any level left by an older cache is ignored; only quota data is reused.
  return [value.five, value.weekly].every((q) => q === null || q &&
    Number.isFinite(q.usedPct) && q.usedPct >= 0 && q.usedPct <= 100 &&
    (q.resetMs === null || Number.isFinite(q.resetMs)));
}

export async function getMiniMaxInfo({ key, platform = 'cn', model = 'auto', level = 'auto', ttlSec = 60,
  staleSec = 1800, timeoutMs = 5000, force = false, proxyEnv = process.env,
  cacheDir = path.join(os.tmpdir(), 'glm-statusline-v2') }) {
  platform = platform === 'en' ? 'en' : 'cn';
  const hash = createHash('sha256').update(JSON.stringify([String(key), model])).digest('hex');
  const file = path.join(cacheDir, `minimax-${platform}-${hash}.json`);
  const { value, ...info } = await cachedQuery({ file, ttlSec, staleSec, force, valid: validValue,
    errorMessage: 'MiniMax 额度查询失败',
    fetchValue: async () => {
      const res = await fetchWithProxy(`${MINIMAX_BASE[platform]}/v1/token_plan/remains`, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyEnv);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseMiniMaxPlan(await res.json(), { model });
    },
  });
  return { ...info, model: value?.model ?? null, level: value && LEVELS.has(level) ? level : null,
    five: value?.five ?? null, weekly: value?.weekly ?? null };
}
