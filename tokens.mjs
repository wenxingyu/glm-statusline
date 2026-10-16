// 按字节偏移增量扫描主会话 transcript，缓存中不保存消息内容。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeCache, acquireLock, recoverLock } from './cache.mjs';

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const validNumber = (n) => Number.isSafeInteger(n) && n >= 0;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const empty = () => ({ kind: 'tokens-v1', offset: 0, totals: [0, 0, 0, 0], seen: {},
  samples: [], maxTimestamp: 0, skipping: false, records: 0 });

function consume(line, state) {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  if (!record || record.isSidechain) return;
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  const previousTime = state.maxTimestamp;
  if (Number.isFinite(timestamp)) state.maxTimestamp = Math.max(timestamp, previousTime);
  if (record.type !== 'assistant' && record.message?.role !== 'assistant') return;
  const usage = record.message?.usage;
  if (!usage || !FIELDS.some((f) => validNumber(usage[f])) ||
    FIELDS.some((f) => usage[f] != null && !validNumber(usage[f]))) return;
  const values = FIELDS.map((f) => usage[f] ?? 0);
  // 无 message.id 时用记录 UUID 去重；两者都没有时按行计数，但不估算速度。
  const messageId = record.message?.id;
  const identity = messageId || record.uuid;
  const id = identity ? hash(String(identity)) : null;
  const old = id ? state.seen[id] : null;
  const next = values.map((v, i) => Math.max(v, old?.[i] ?? 0));
  const totals = state.totals.map((v, i) => v + next[i] - (old?.[i] ?? 0));
  if (!totals.every(validNumber)) return;
  state.totals = totals;
  if (id) state.seen[id] = next;
  if (!old) state.records++;
  const sample = id && state.samples.find((s) => s.id === id);
  if (sample) sample.tokens = next[1];
  else if (!old && messageId && previousTime > 0 && timestamp > previousTime) {
    state.samples.push({ id, tokens: next[1], ms: timestamp - previousTime });
    state.samples = state.samples.slice(-20);
  }
}

function result(state, size) {
  if (!state.records) return null;
  const [input, output, cacheRead, cacheCreation] = state.totals;
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation,
    samples: state.samples, partial: state.offset < size };
}

async function fingerprint(fh, offset) {
  const length = Math.min(offset, 256);
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, offset - length);
  return hash(b.subarray(0, bytesRead));
}

function validCache(c) {
  return c?.version === 2 && c.kind === 'tokens-v1' && validNumber(c.offset) &&
    Array.isArray(c.totals) && c.totals.length === 4 && c.totals.every(validNumber) &&
    c.seen && typeof c.seen === 'object' && !Array.isArray(c.seen) &&
    Object.values(c.seen).every((v) => Array.isArray(v) && v.length === 4 && v.every(validNumber)) &&
    Array.isArray(c.samples) && c.samples.length <= 20 && c.samples.every((s) =>
      typeof s?.id === 'string' && validNumber(s.tokens) && Number.isFinite(s.ms) && s.ms > 0) &&
    Number.isFinite(c.maxTimestamp) && validNumber(c.records) && typeof c.skipping === 'boolean';
}

export async function tokenTotals(transcriptPath, {
  cacheDir = path.join(os.tmpdir(), 'glm-statusline-tokens-v1'),
  maxBytes = 32 * 1024 * 1024,
} = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fh, release;
  try {
    const source = await fs.realpath(transcriptPath);
    fh = await fs.open(source, 'r');
    const stat = await fh.stat();
    if (!stat.isFile()) return null;
    const file = path.join(cacheDir, `${hash(source)}.json`);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const read = async () => {
      try {
        const c = JSON.parse(await fs.readFile(file, 'utf8'));
        if (validCache(c) && c.identity === identity && c.offset <= stat.size &&
          c.anchor === await fingerprint(fh, c.offset) &&
          c.head === await fingerprint(fh, Math.min(c.offset, 256)) &&
          !(c.size === stat.size && c.mtime !== stat.mtimeMs)) return c;
      } catch { /* 首次扫描、损坏或被替换的缓存：重建 */ }
      return empty();
    };
    release = await acquireLock(file);
    if (!release) { await recoverLock(file); release = await acquireLock(file); }
    if (!release) return result(await read(), stat.size);
    const state = await read();
    if (state.version === 2 && state.offset === stat.size) return result(state, stat.size);
    let position = state.offset;
    let pending = Buffer.alloc(0);
    const buf = Buffer.alloc(256 * 1024);
    const stop = Math.min(stat.size, position + Math.max(buf.length, maxBytes));
    const checkpoint = async () => {
      state.identity = identity;
      state.anchor = await fingerprint(fh, state.offset);
      state.head = await fingerprint(fh, Math.min(state.offset, 256));
      state.size = stat.size;
      state.mtime = stat.mtimeMs;
      await writeCache(file, state);
    };
    let saved = state.offset;
    while (position < stop) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, stop - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
      let start = 0, end;
      while ((end = data.indexOf(10, start)) !== -1) {
        if (!state.skipping) consume(data.subarray(start, end).toString('utf8'), state);
        state.skipping = false;
        start = end + 1;
        state.offset = position - data.length + start;
      }
      pending = Buffer.from(data.subarray(start));
      // 畸形超长行不无限占用内存；跳到下一个换行再恢复解析。
      if (state.skipping || pending.length > 8 * 1024 * 1024) {
        pending = Buffer.alloc(0);
        state.skipping = true;
        state.offset = position;
      }
      if (state.offset - saved >= 1024 * 1024) { await checkpoint(); saved = state.offset; }
    }
    await checkpoint();
    return result(state, stat.size);
  } catch { return null; }
  finally {
    await fh?.close().catch(() => {});
    await release?.();
  }
}

export function generationSpeed(samples, count = 5) {
  const recent = (Array.isArray(samples) ? samples : []).filter((s) =>
    Number.isFinite(s.tokens) && s.tokens > 0 && Number.isFinite(s.ms) && s.ms > 0)
    .slice(-Math.min(20, Math.max(1, Math.floor(count) || 5)));
  if (!recent.length) return null;
  return recent.reduce((n, s) => n + s.tokens, 0) * 1000 / recent.reduce((n, s) => n + s.ms, 0);
}
