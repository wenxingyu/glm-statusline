import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tokenTotals, generationSpeed } from '../tokens.mjs';

const time = (seconds) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const user = (seconds = 0) => ({ type: 'user', timestamp: time(seconds) });
const assistant = (id, usage = { input_tokens: 100, output_tokens: 50 }, seconds = 1, extra = {}) =>
  ({ type: 'assistant', timestamp: time(seconds), message: { id, role: 'assistant', usage }, ...extra });
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const counts = ({ input, output, cacheRead, cacheCreation, total }) => ({ input, output, cacheRead, cacheCreation, total });

async function setup(t, records = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-tokens-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const cacheDir = path.join(dir, 'cache');
  await fs.writeFile(file, records.length ? lines(records) : '');
  return { file, cacheDir, query: (options = {}) => tokenTotals(file, { cacheDir, ...options }),
    append: (records) => fs.appendFile(file, lines(records)),
    cacheFile: async () => path.join(cacheDir, (await fs.readdir(cacheDir)).find((f) => f.endsWith('.json'))) };
}

test('session totals include input, output, cache reads and cache creation', async (t) => {
  const s = await setup(t, [assistant('a', { input_tokens: 10, output_tokens: 20,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }), assistant('b')]);
  assert.deepEqual(counts(await s.query()), { input: 110, output: 70, cacheRead: 30, cacheCreation: 40, total: 250 });
});

test('repeated response blocks count once including nonadjacent duplicates', async (t) => {
  const s = await setup(t, [assistant('a'), assistant('b'), assistant('a'), assistant('b')]);
  assert.equal((await s.query()).total, 300);
  assert.equal((await s.query()).total, 300);
});

test('later usage updates contribute only the new counts and update the original speed sample', async (t) => {
  const s = await setup(t, [user(), assistant('a', { input_tokens: 100, output_tokens: 10 }, 2)]);
  await s.query();
  await s.append([assistant('a', { input_tokens: 100, output_tokens: 50 }, 3)]);
  const value = await s.query();
  assert.equal(value.total, 150);
  assert.equal(value.samples.length, 1);
  assert.equal(generationSpeed(value.samples), 25);
});

test('append resumes from a persisted byte offset and keeps deduplication across invocations', async (t) => {
  const s = await setup(t, [assistant('a')]);
  await s.query();
  const before = JSON.parse(await fs.readFile(await s.cacheFile(), 'utf8'));
  assert.equal(before.offset, (await fs.stat(s.file)).size);
  await s.append([assistant('a'), assistant('b')]);
  assert.equal((await s.query()).total, 300);
});

test('partial UTF-8 JSON lines are retried once their newline arrives', async (t) => {
  const s = await setup(t, [assistant('a')]);
  const bytes = Buffer.from(JSON.stringify({ ...assistant('b'), text: '中文' }) + '\n');
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  await fs.appendFile(s.file, bytes.subarray(0, split));
  assert.equal((await s.query()).total, 150);
  await fs.appendFile(s.file, bytes.subarray(split));
  assert.equal((await s.query()).total, 300);
});

test('malformed lines and invalid usage do not pollute totals', async (t) => {
  const s = await setup(t, [assistant('a')]);
  await fs.appendFile(s.file, '{broken}\nnull\n');
  await s.append([assistant('b', { input_tokens: -1 }), assistant('c', { input_tokens: '12' }),
    assistant('d', { input_tokens: true }), assistant('e', {})]);
  assert.equal((await s.query()).total, 150);
});

test('sidechain and non-assistant usage are excluded', async (t) => {
  const s = await setup(t, [assistant('a'), assistant('b', undefined, 2, { isSidechain: true }),
    { type: 'user', message: { usage: { input_tokens: 99999 } } }]);
  assert.equal((await s.query()).total, 150);
});

test('zero usage is valid while missing transcripts and empty sessions remain unknown', async (t) => {
  const s = await setup(t);
  assert.equal(await s.query(), null);
  for (const file of [null, 123, path.join(s.cacheDir, 'missing')]) assert.equal(await tokenTotals(file), null);
  await s.append([assistant('zero', { input_tokens: 0, output_tokens: 0 })]);
  assert.equal((await s.query()).total, 0);
});

test('compaction retains session totals', async (t) => {
  const s = await setup(t, [assistant('a'), { type: 'system', subtype: 'compact_boundary' }, assistant('b')]);
  assert.equal((await s.query()).total, 300);
});

test('truncation and same-size rewrite rebuild cached totals', async (t) => {
  const s = await setup(t, [assistant('a'), assistant('b')]);
  await s.query();
  await fs.writeFile(s.file, lines([assistant('c')]));
  assert.equal((await s.query()).total, 150);
  await fs.writeFile(s.file, lines([assistant('d', { input_tokens: 200, output_tokens: 50 })]));
  assert.equal((await s.query()).total, 250);
});

test('replacement with a larger file does not reuse old totals', async (t) => {
  const s = await setup(t, [assistant('a')]);
  await s.query();
  const replacement = `${s.file}.new`;
  await fs.writeFile(replacement, lines([assistant('b'), assistant('c')]));
  await fs.rename(replacement, s.file);
  assert.equal((await s.query()).total, 300);
});

test('corrupt caches rebuild safely and do not store transcript text', async (t) => {
  const s = await setup(t, [{ ...assistant('a'), content: 'private transcript text' }]);
  await s.query();
  const file = await s.cacheFile();
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('private transcript text'));
  await fs.writeFile(file, '{broken');
  assert.equal((await s.query()).total, 150);
});

test('scan budget persists progress and completes on following invocations', async (t) => {
  const records = Array.from({ length: 6000 }, (_, i) => assistant(String(i)));
  const s = await setup(t, records);
  let result = await s.query({ maxBytes: 256 * 1024 });
  assert.equal(result.partial, true);
  let previous = result.total;
  for (let i = 0; result.partial && i < 10; i++) {
    result = await s.query({ maxBytes: 256 * 1024 });
    assert.ok(result.total >= previous);
    previous = result.total;
  }
  assert.equal(result.partial, false);
  assert.equal(result.total, 900000);
});

test('a live scanner lock returns its checkpoint without writing or waiting', async (t) => {
  const s = await setup(t, [assistant('a')]);
  await s.query();
  const file = await s.cacheFile();
  await fs.writeFile(`${file}.lock`, String(process.pid));
  await s.append([assistant('b')]);
  assert.equal((await s.query()).total, 150);
  await fs.unlink(`${file}.lock`);
  assert.equal((await s.query()).total, 300);
});

test('speed uses the maximum previous timestamp and first response timestamp', async (t) => {
  const s = await setup(t, [user(0), user(2), user(1), assistant('a', { output_tokens: 100 }, 4),
    assistant('a', { output_tokens: 100 }, 5)]);
  assert.equal(generationSpeed((await s.query()).samples), 50);
});

test('speed skips missing, reversed and equal timestamps', async (t) => {
  const s = await setup(t, [assistant('first'), user(10), assistant('a', { output_tokens: 100 }, 9),
    assistant('b', { output_tokens: 100 }, 10), { ...assistant('c'), timestamp: 'bad' }]);
  assert.equal(generationSpeed((await s.query()).samples), null);
});

test('sidechain timestamps cannot change main-session speed', async (t) => {
  const s = await setup(t, [user(), assistant('side', undefined, 100, { isSidechain: true }),
    assistant('a', { output_tokens: 100 }, 2)]);
  assert.equal(generationSpeed((await s.query()).samples), 50);
});

test('speed is weighted by duration and honors the configured sample count', () => {
  const samples = [{ tokens: 100, ms: 1000 }, { tokens: 200, ms: 10000 }];
  assert.equal(generationSpeed(samples), 300 / 11);
  assert.equal(generationSpeed(samples, 1), 20);
  assert.equal(generationSpeed([{ tokens: 0, ms: 1 }]), null);
});

test('speed retains only twenty response samples across cache reloads', async (t) => {
  const records = [user()];
  for (let i = 1; i <= 25; i++) records.push(assistant(String(i), { output_tokens: i }, i));
  const s = await setup(t, records);
  const result = await s.query();
  assert.equal(result.samples.length, 20);
  assert.equal(generationSpeed(result.samples), 23);
  assert.equal(generationSpeed((await s.query()).samples, 20), 15.5);
});

test('UUID fallback handles legacy usage and does not fabricate response timing', async (t) => {
  const legacy = { ...assistant(undefined), uuid: 'legacy' };
  const s = await setup(t, [user(), legacy, legacy]);
  assert.equal((await s.query()).total, 150);
  assert.equal(generationSpeed((await s.query()).samples), null);
});
