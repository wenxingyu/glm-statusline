// 按字节偏移增量扫描主会话 transcript，缓存中不保存消息内容。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeCache, acquireLock, recoverLock } from './cache.mjs';

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const CHECKPOINT_BYTES = 8 * 1024 * 1024;
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

function validTotals(c) {
  return validNumber(c.offset) && validNumber(c.records) &&
    Array.isArray(c.totals) && c.totals.length === 4 && c.totals.every(validNumber) &&
    Array.isArray(c.samples) && c.samples.length <= 20 && c.samples.every((s) =>
      typeof s?.id === 'string' && validNumber(s.tokens) && Number.isFinite(s.ms) && s.ms > 0);
}

function validCache(c) {
  if (c?.version !== 2 || c.kind !== 'tokens-v1' || !validTotals(c) ||
    !Number.isFinite(c.maxTimestamp) || typeof c.skipping !== 'boolean' ||
    !c.seen || typeof c.seen !== 'object' || Array.isArray(c.seen)) return false;
  for (const key of Object.keys(c.seen)) {
    const values = c.seen[key];
    if (!Array.isArray(values) || values.length !== 4 || !values.every(validNumber)) return false;
  }
  return true;
}

const fileIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
const fileStamp = (stat) => `${fileIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

async function matchesTranscript(fh, state) {
  const anchor = fingerprint(fh, state.offset);
  const head = state.offset <= 256 ? anchor : fingerprint(fh, 256);
  const [actualAnchor, actualHead] = await Promise.all([anchor, head]);
  return state.anchor === actualAnchor && state.head === actualHead;
}

async function readSummary(file, summaryFile, fh, stat) {
  try {
    const summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'));
    if (summary?.version !== 2 || summary.kind !== 'tokens-summary-v1' ||
      summary.transcript !== fileStamp(stat) || summary.offset !== stat.size || !validTotals(summary)) return null;
    // 摘要与完整检查点绑定。写入中断或检查点被替换时回到原有校验流程。
    if (summary.checkpoint === fileStamp(await fs.stat(file)) && await matchesTranscript(fh, summary)) return summary;
  } catch { /* 旧版本或不完整的缓存没有可用摘要 */ }
  return null;
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
    let stat = await fh.stat();
    if (!stat.isFile()) return null;
    const file = path.join(cacheDir, `${hash(source)}.json`);
    const summaryFile = `${file}.summary`;
    const summary = await readSummary(file, summaryFile, fh, stat);
    if (summary) return result(summary, stat.size);
    const read = async () => {
      try {
        const c = JSON.parse(await fs.readFile(file, 'utf8'));
        if (c?.identity === fileIdentity(stat) && c.offset <= stat.size &&
          !(c.size === stat.size && (c.mtime !== stat.mtimeMs || (c.ctime != null && c.ctime !== stat.ctimeMs))) &&
          validCache(c) && await matchesTranscript(fh, c)) return c;
      } catch { /* 首次扫描、损坏或被替换的缓存：重建 */ }
      return empty();
    };
    release = await acquireLock(file);
    if (!release) { await recoverLock(file); release = await acquireLock(file); }
    if (!release) return result(await read(), stat.size);
    stat = await fh.stat();
    const state = await read();
    const saveSummary = async () => {
      if (state.offset !== stat.size) return;
      const { offset, totals, records, samples, anchor, head } = state;
      const checkpoint = await fs.stat(file).catch(() => null);
      if (checkpoint) await writeCache(summaryFile, { kind: 'tokens-summary-v1', offset, totals, records, samples,
        anchor, head, transcript: fileStamp(stat), checkpoint: fileStamp(checkpoint) });
    };
    if (state.version === 2 && state.offset === stat.size) {
      await saveSummary();
      return result(state, stat.size);
    }
    let position = state.offset;
    let pending = Buffer.alloc(0);
    const buf = Buffer.alloc(256 * 1024);
    const stop = Math.min(stat.size, position + Math.max(buf.length, maxBytes));
    const checkpoint = async () => {
      state.identity = fileIdentity(stat);
      const anchor = fingerprint(fh, state.offset);
      [state.anchor, state.head] = await Promise.all([anchor, state.offset <= 256 ? anchor : fingerprint(fh, 256)]);
      state.size = stat.size;
      state.mtime = stat.mtimeMs;
      state.ctime = stat.ctimeMs;
      return writeCache(file, state);
    };
    let saved = state.offset;
    while (position < stop) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, stop - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
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
      // 长扫描定期保存进度，常见的小批量扫描只在末尾写一次完整表。
      if (position < stop && state.offset - saved >= CHECKPOINT_BYTES) { await checkpoint(); saved = state.offset; }
    }
    if (await checkpoint()) await saveSummary();
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
