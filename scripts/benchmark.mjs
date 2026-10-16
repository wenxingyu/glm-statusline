// Offline, synthetic benchmark. Run with: node scripts/benchmark.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-benchmark-'));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(fn, count = 5) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return Math.round(median(times) * 10) / 10;
}

try {
  // Isolate settings, credentials, proxy configuration and caches from the real account.
  for (const key of Object.keys(process.env)) {
    if (/^(anthropic_.*|glm_.*|deepseek_api_key|minimax_api_key|https?_proxy|all_proxy|no_proxy)$/i.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, { HOME: root, USERPROFILE: root, TMP: root, TEMP: root, TMPDIR: root,
    GLM_API_KEY: 'benchmark-glm', DEEPSEEK_API_KEY: 'benchmark-deepseek', MINIMAX_API_KEY: 'benchmark-minimax' });
  const { render, normalizeConfig } = await import('../statusline.mjs');
  const { tokenTotals } = await import('../tokens.mjs');
  const cli = fileURLToPath(new URL('../statusline.mjs', import.meta.url));
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ segments: ['model'] }));
  const nodeStartup = await measure(() => {
    const result = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
    if (result.status !== 0) throw new Error('Node startup benchmark failed');
  }, 7);
  console.log(JSON.stringify({ scenario: 'bare Node process baseline', medianMs: nodeStartup, node: process.version }));
  const startup = await measure(() => {
    const result = spawnSync(process.execPath, [cli], { input: '{"model":{"id":"benchmark"}}',
      encoding: 'utf8', env: { ...process.env, GLM_STATUSLINE_CONFIG: configFile }, timeout: 10000 });
    if (result.status !== 0 || result.stdout.trim() === '') throw new Error('CLI benchmark failed');
  }, 7);
  console.log(JSON.stringify({ scenario: 'fresh CLI process, model only', medianMs: startup, node: process.version }));

  globalThis.fetch = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const body = url.includes('deepseek.com')
      ? { balance_infos: [{ currency: 'CNY', total_balance: '42' }] }
      : url.includes('minimaxi.com')
        ? { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 62 }] }
        : { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } };
    return { ok: true, json: async () => body };
  };
  const config = normalizeConfig({ segments: ['glm', 'deepseek', 'minimax'],
    glm: { showBalance: false }, cacheTtlSeconds: 0, lang: 'en' });
  console.log(JSON.stringify({ scenario: 'three providers, simulated 100ms each, TTL=0',
    medianMs: await measure(() => render({}, config)) }));

  for (const count of [1000, 10000, 50000]) {
    const file = path.join(root, `session-${count}.jsonl`);
    const cacheDir = path.join(root, `tokens-${count}`);
    const records = Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'assistant',
      timestamp: new Date(1800000000000 + i * 1000).toISOString(),
      message: { id: `response-${i}`, usage: { input_tokens: 100, output_tokens: 50 } } }));
    await fs.writeFile(file, records.join('\n') + '\n');
    const start = performance.now();
    const totals = await tokenTotals(file, { cacheDir });
    if (totals?.total !== count * 150 || totals.partial) throw new Error('Incomplete benchmark scan');
    const coldMs = Math.round(performance.now() - start);
    const warmMs = await measure(() => tokenTotals(file, { cacheDir }));
    const cache = path.join(cacheDir, (await fs.readdir(cacheDir)).find((name) => name.endsWith('.json')));
    console.log(JSON.stringify({ scenario: 'synthetic session, no new records on warm reads', records: count,
      coldMs, warmMedianMs: warmMs, cacheMiB: +((await fs.stat(cache)).size / 1024 ** 2).toFixed(2) }));
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  // root is the exact temporary directory created above; no user data is stored here.
  await fs.rm(root, { recursive: true, force: true });
}
