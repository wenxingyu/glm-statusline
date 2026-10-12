// Node.js 18 的 fetch 不会自动读取代理变量，使用内置模块建立 CONNECT 隧道。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

// 进程环境优先于 Claude settings.env；同一来源中小写优先，空值允许覆盖配置。
export function proxyEnvironment(settings = {}, current = process.env) {
  return Object.fromEntries(PROXY_VARS.map((name) => [name,
    current[name.toLowerCase()] ?? current[name] ?? settings[name.toLowerCase()] ?? settings[name] ?? '',
  ]));
}

const hostname = (url) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

export function proxyForUrl(input, env = process.env) {
  const target = new URL(input);
  const read = (name) => String(env[name.toLowerCase()] ?? env[name] ?? '').trim();
  const host = hostname(target);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const entry of read('NO_PROXY').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (entry === '*') return null;
    const match = entry.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match) continue;
    if (match[2] && match[2] !== port) continue;
    let pattern = match[1].replace(/^\[|\]$/g, '');
    if (pattern.startsWith('*.') || pattern.startsWith('.')) {
      pattern = pattern.replace(/^\*?\./, '');
      if (host === pattern || host.endsWith(`.${pattern}`)) return null;
    } else if (host === pattern) return null;
  }
  const value = (target.protocol === 'https:' ? read('HTTPS_PROXY') : '') ||
    read('HTTP_PROXY') || read('ALL_PROXY');
  if (!value) return null;
  let proxy;
  try {
    proxy = new URL(value.includes('://') ? value : `http://${value}`);
    // 提前检查 URL 编码，避免报错中包含带密码的代理地址。
    decodeURIComponent(proxy.username);
    decodeURIComponent(proxy.password);
  } catch {
    throw new Error('代理地址无效，请检查 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY');
  }
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error('代理协议不支持，请使用 http:// 或 https:// 代理地址');
  }
  return proxy;
}

function requestWithProxy(target, proxy, { headers, signal }) {
  return new Promise((resolve, reject) => {
    let connectRequest, request, socket, agent;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      request?.destroy();
      connectRequest?.destroy();
      agent?.destroy();
      socket?.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal.reason);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    const send = (tunnel) => {
      try {
        const secure = target.protocol === 'https:';
        const origin = secure ? https : http;
        if (tunnel) {
          agent = new origin.Agent({ keepAlive: false });
          agent.createConnection = () => {
            if (secure) {
              const host = hostname(target);
              socket = tls.connect({ socket: tunnel, host, servername: isIP(host) ? undefined : host });
            }
            return socket;
          };
        }
        request = origin.request(target, { headers, agent: agent || false }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', (error) => finish(error));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            finish(null, { status: response.statusCode,
              ok: response.statusCode >= 200 && response.statusCode < 300,
              location: response.headers.location,
              json: async () => JSON.parse(body),
            });
          });
        });
        request.on('error', (error) => finish(error));
        request.end();
      } catch (error) { finish(error); }
    };
    if (!proxy) return send();
    try {
      const authority = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`;
      const proxyHeaders = { Host: authority };
      if (proxy.username || proxy.password) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
      }
      const transport = proxy.protocol === 'https:' ? https : http;
      connectRequest = transport.request({
        hostname: hostname(proxy), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: authority, headers: proxyHeaders, agent: false,
      });
      connectRequest.on('error', (error) => finish(error));
      connectRequest.on('response', (res) => {
        res.resume();
        finish(new Error(`代理连接失败 (HTTP ${res.statusCode})`));
      });
      connectRequest.on('connect', (res, tunnel, head) => {
        socket = tunnel;
        if (settled) return tunnel.destroy();
        if (res.statusCode !== 200) return finish(new Error(`代理连接失败 (HTTP ${res.statusCode})`));
        try {
          if (head.length) tunnel.unshift(head);
          send(tunnel);
        } catch (error) { finish(error); }
      });
      connectRequest.end();
    } catch (error) { finish(error); }
  });
}

export async function fetchWithProxy(input, options, env = process.env) {
  let target = new URL(input);
  let headers = { ...options.headers };
  const configured = PROXY_VARS.slice(0, 3).some((name) => env[name.toLowerCase()] || env[name]);
  for (let redirects = 0; ; redirects++) {
    const proxy = proxyForUrl(target, env);
    if (!proxy && !configured) return fetch(target.href, { ...options, headers });
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('请求协议不支持');
    // NO_PROXY 明确直连，避免新版 Node 全局环境代理覆盖 settings.env 的绕过规则。
    const response = await requestWithProxy(target, proxy, { ...options, headers });
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) return response;
    if (redirects >= 5) throw new Error('重定向次数过多');
    const next = new URL(response.location, target);
    if (next.origin !== target.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) =>
        !['authorization', 'cookie'].includes(name.toLowerCase())));
    }
    target = next;
  }
}
