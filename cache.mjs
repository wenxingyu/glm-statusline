// Shared atomic cache writes and process locks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeCache(file, cache) {
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
export async function acquireLock(file) {
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
export async function recoverLock(file) {
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

// 单一数据源的缓存流程；保留各服务商现有的字段和文件格式。
export async function cachedQuery({ file, field = 'value', valid, fetchValue, errorMessage,
  ttlSec, staleSec, force }) {
  const read = async () => {
    try {
      const c = JSON.parse(await fs.readFile(file, 'utf8'));
      if (c.version !== 2 || !Number.isFinite(c.attemptAt) || !Number.isFinite(c.updatedAt) ||
        (c.error !== null && typeof c.error !== 'string') || (c[field] !== null && !valid(c[field]))) return null;
      return c;
    } catch { return null; }
  };
  const due = (c) => {
    const now = Date.now();
    return force || !c || c.attemptAt > now || now - c.attemptAt >= ttlSec * 1000;
  };
  const show = (c, refreshing = false, updated = false) => {
    const now = Date.now();
    const age = c?.updatedAt > 0 && c.updatedAt <= now ? now - c.updatedAt : Infinity;
    const usable = c?.[field] != null && (updated || (!(c.error && staleSec <= 0) &&
      age <= (c.error ? staleSec : Math.max(ttlSec, staleSec)) * 1000));
    return { ok: Boolean(usable), value: usable ? c[field] : null,
      stale: Boolean(usable && !updated && (c.error || age >= ttlSec * 1000)),
      age: usable ? age : -1, refreshing, error: usable ? null : c?.error ?? null };
  };
  let prev = await read();
  if (!due(prev)) return show(prev);
  let release = await acquireLock(file);
  if (!release) { await recoverLock(file); release = await acquireLock(file); }
  if (!release) return show(await read(), true);
  try {
    prev = await read();
    if (!due(prev)) return show(prev);
    let cache;
    try {
      const value = await fetchValue();
      const now = Date.now();
      cache = { [field]: value, updatedAt: now, attemptAt: now, error: null };
    } catch (e) {
      cache = { [field]: prev?.[field] ?? null, updatedAt: prev?.updatedAt ?? 0,
        attemptAt: Date.now(), error: e.name === 'TimeoutError' ? '查询超时'
          : /^HTTP \d+$/.test(e.message) ? e.message : errorMessage };
    }
    await writeCache(file, cache);
    return show(cache, false, !cache.error);
  } finally { await release(); }
}
