import { getGlmInfo } from '../../glm.mjs';
import { setTimeout } from 'node:timers/promises';

let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  await setTimeout(500);
  return { ok: true, status: 200, json: async () => url.includes('/quota/')
    ? { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 38 }] } }
    : { code: 200, data: { balance: 46.2 } } };
};
process.once('message', async () => {
  const result = await getGlmInfo({ key: 'worker-key', cacheDir: process.argv[2], proxyEnv: {} });
  process.send({ result, calls }, () => process.disconnect());
});
process.send('ready');
