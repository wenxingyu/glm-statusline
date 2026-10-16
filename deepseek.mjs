// DeepSeek 官方余额接口；按账号隔离缓存，失败重试不延长旧余额的寿命。
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchWithProxy } from './proxy.mjs';
import { cachedQuery } from './cache.mjs';

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

export function parseDeepSeekBalance(body) {
  if (!Array.isArray(body?.balance_infos) || !body.balance_infos.length) {
    throw new Error('响应中无有效余额字段');
  }
  return body.balance_infos.map((entry) => {
    const raw = entry?.total_balance;
    if (!['CNY', 'USD'].includes(entry?.currency) ||
      !['number', 'string'].includes(typeof raw) || String(raw).trim() === '' ||
      !Number.isFinite(Number(raw))) throw new Error('响应中无有效余额字段');
    return { currency: entry.currency, balance: Number(raw) };
  });
}

export async function getDeepSeekInfo({ key, ttlSec = 60, staleSec = 1800,
  timeoutMs = 5000, force = false, proxyEnv = process.env,
  cacheDir = path.join(os.tmpdir(), 'glm-statusline-v2') }) {
  const hash = createHash('sha256').update(String(key)).digest('hex');
  const file = path.join(cacheDir, `deepseek-${hash}.json`);
  const { value, ...info } = await cachedQuery({ file, field: 'balances', ttlSec, staleSec, force,
    valid: (balances) => Array.isArray(balances) && balances.length > 0 &&
      balances.every((b) => ['CNY', 'USD'].includes(b?.currency) && Number.isFinite(b.balance)),
    errorMessage: '余额查询失败',
    fetchValue: async () => {
      const res = await fetchWithProxy(DEEPSEEK_BALANCE_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
      }, proxyEnv);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseDeepSeekBalance(await res.json());
    },
  });
  return { ...info, balances: value };
}
