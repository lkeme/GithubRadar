import { request as httpsRequest, type Agent, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

import { REQUEST_TIMEOUT_MS } from '@githubradar/contracts';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * 唯一出站通道。
 *
 * 所有目标都是 HTTPS；不使用原生 fetch，也不把 Node Agent 传给 fetch。
 * - 直连走 node:https 默认 Agent。
 * - HTTP/HTTPS 代理走 HttpsProxyAgent 的 CONNECT。
 * - SOCKS5 内部固定构造 `socks5h://` 以使用远端 DNS；`socks5://` 会走本地解析，
 *   不能满足受限网络需求。
 * - 不提供忽略证书校验的开关；重定向最多 3 次且逐跳校验主机白名单。
 */

export const CONNECT_TIMEOUT_MS = 10_000;
/** 普通 API 请求总超时；与契约 REQUEST_TIMEOUT_MS 同一数值，单一来源。 */
export const DEFAULT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

export interface ProxySettings {
  readonly scheme: 'http' | 'https' | 'socks5';
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

export interface TransportRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** 允许跟随时的主机白名单；不在白名单内直接失败。 */
  readonly allowedHosts?: readonly string[];
  /** 跨主机跳转时是否允许继续携带 Authorization；默认 false。 */
  readonly keepAuthorizationOnCrossHostRedirect?: boolean;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: number;
  readonly url: string;
}

export class TransportError extends Error {
  readonly code:
    | 'PROXY_UNREACHABLE'
    | 'GITHUB_RATE_LIMITED'
    | 'UPSTREAM_SCHEMA_CHANGED'
    | 'SERVICE_UNAVAILABLE';
  readonly stage: 'dns' | 'connect' | 'tls' | 'http' | 'body';

  constructor(
    code: TransportError['code'],
    message: string,
    stage: 'dns' | 'connect' | 'tls' | 'http' | 'body',
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.code = code;
    this.stage = stage;
  }
}

export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>;
  describe(): { readonly mode: 'direct' | 'proxy'; readonly proxyScheme: ProxySettings['scheme'] | null };
  close(): void;
}

function encodeCredential(value: string): string {
  return encodeURIComponent(value);
}

/** 代理 URL 必须正确编码认证字符，且不把含密码的 URL 持久化到任何地方。 */
export function buildProxyUrl(proxy: ProxySettings): string {
  const credentials =
    proxy.username === null ? '' : `${encodeCredential(proxy.username)}:${encodeCredential(proxy.password ?? '')}@`;
  // SOCKS 固定使用 socks5h，把域名解析交给代理由远端完成。
  const scheme = proxy.scheme === 'socks5' ? 'socks5h' : proxy.scheme;
  // IPv6 在 URL 里必须带方括号：裸 `::1` 会拼出无法解析的 `http://::1:3128`。
  // 校验层两种写法都接受，这里统一归一化，保存后的配置始终可用。
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${scheme}://${credentials}${host}:${proxy.port}`;
}

export interface AgentFactory {
  create(proxy: ProxySettings): Agent;
}

export const defaultAgentFactory: AgentFactory = {
  create(proxy) {
    const url = buildProxyUrl(proxy);
    return proxy.scheme === 'socks5' ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  },
};

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

class HttpsTransport implements Transport {
  readonly #proxy: ProxySettings | null;
  readonly #agents: AgentFactory;
  readonly #cache = new Map<string, Agent>();

  constructor(proxy: ProxySettings | null, agents: AgentFactory = defaultAgentFactory) {
    this.#proxy = proxy;
    this.#agents = agents;
  }

  describe(): { mode: 'direct' | 'proxy'; proxyScheme: ProxySettings['scheme'] | null } {
    return { mode: this.#proxy === null ? 'direct' : 'proxy', proxyScheme: this.#proxy?.scheme ?? null };
  }

  #agentFor(): Agent | undefined {
    if (this.#proxy === null) return undefined;
    const key = `${this.#proxy.scheme}:${this.#proxy.host}:${this.#proxy.port}`;
    const existing = this.#cache.get(key);
    if (existing !== undefined) return existing;
    const agent = this.#agents.create(this.#proxy);
    this.#cache.set(key, agent);
    return agent;
  }

  close(): void {
    for (const agent of this.#cache.values()) agent.destroy();
    this.#cache.clear();
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    return this.#requestOnce(request, request.url, 0, true);
  }

  async #requestOnce(
    request: TransportRequest,
    target: string,
    redirects: number,
    allowAuthorization: boolean,
  ): Promise<TransportResponse> {
    const url = new URL(target);
    if (url.protocol !== 'https:') {
      throw new TransportError('SERVICE_UNAVAILABLE', `只允许 HTTPS 出站：${url.protocol}`, 'http');
    }
    if (url.username !== '' || url.password !== '') {
      throw new TransportError('SERVICE_UNAVAILABLE', '出站 URL 不允许包含 userinfo', 'http');
    }
    if (url.port !== '' && url.port !== '443') {
      throw new TransportError('SERVICE_UNAVAILABLE', `出站端口必须是 443：${url.port}`, 'http');
    }
    const allowedHosts = request.allowedHosts ?? ['api.github.com', 'raw.githubusercontent.com'];
    if (!allowedHosts.includes(url.hostname)) {
      throw new TransportError('SERVICE_UNAVAILABLE', `出站主机不在白名单：${url.hostname}`, 'http');
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;

    const headers: Record<string, string> = {
      // Node 底层 HTTPS 不自动解压；首版明确要求 identity，避免把压缩字节当成 JSON。
      'accept-encoding': 'identity',
      'user-agent': 'GithubRadar',
      host: url.hostname,
      ...request.headers,
    };
    if (!allowAuthorization) delete headers['authorization'];

    const options: RequestOptions = {
      method: 'GET',
      headers,
      agent: this.#agentFor(),
      // 保持 TLS 证书校验（默认即为校验，这里显式写出以防被后续改动放松）。
      rejectUnauthorized: true,
    };

    let stage: TransportError['stage'] = 'connect';
    const { status, headers: responseHeaders, body, bytes, location } = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
      bytes: number;
      location: string | undefined;
    }>((resolve, reject) => {
      const req = httpsRequest(url, options, (res) => {
        // 拿到响应即连接已经建立（keep-alive 复用连接不会再触发 connect/secureConnect）：
        // 必须在这里清除连接计时器，否则慢响应会被误判成 PROXY_UNREACHABLE，
        // 覆盖掉"连接超时 10 秒、总超时 20 秒"的语义。
        clearTimeout(connectTimer);
        const normalized = normalizeHeaders(res.headers);
        const encoding = normalized['content-encoding'];
        if (encoding !== undefined && encoding !== '' && encoding.toLowerCase() !== 'identity') {
          res.destroy();
          reject(
            new TransportError('UPSTREAM_SCHEMA_CHANGED', `上游返回了未支持的 Content-Encoding：${encoding}`, 'body'),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            reject(new TransportError('UPSTREAM_SCHEMA_CHANGED', `上游响应超过上限 ${maxBytes} 字节`, 'body'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: normalized,
            body: Buffer.concat(chunks).toString('utf8'),
            bytes: received,
            location: normalized['location'],
          });
        });
        res.on('error', (error) => {
          reject(new TransportError('SERVICE_UNAVAILABLE', '读取上游响应失败', 'body', { cause: error }));
        });
      });

      const total = setTimeout(() => {
        req.destroy();
        reject(new TransportError('SERVICE_UNAVAILABLE', `请求总超时（${timeoutMs}ms）`, stage));
      }, timeoutMs);

      const connectTimer = setTimeout(() => {
        req.destroy();
        reject(new TransportError('PROXY_UNREACHABLE', `连接超时（${CONNECT_TIMEOUT_MS}ms）`, stage));
      }, CONNECT_TIMEOUT_MS);

      // 只挂一次并随请求结束解绑：keep-alive 会把同一个 socket 复用给后续请求，
      // 若不移除，每个请求都会在同一个 EventEmitter 上再叠加三个监听
      // （超过 10 个即触发 MaxListenersExceededWarning，且旧闭包持有的 stage/timer 无法释放）。
      let socketRef: import('node:net').Socket | null = null;
      const onLookup = (): void => {
        stage = 'connect';
      };
      const onConnect = (): void => {
        stage = 'tls';
        clearTimeout(connectTimer);
      };
      const onSecureConnect = (): void => {
        stage = 'http';
        clearTimeout(connectTimer);
      };
      const detachSocketListeners = (): void => {
        socketRef?.off('lookup', onLookup);
        socketRef?.off('connect', onConnect);
        socketRef?.off('secureConnect', onSecureConnect);
        socketRef = null;
      };
      req.on('socket', (socket) => {
        socketRef = socket;
        socket.on('lookup', onLookup);
        socket.on('connect', onConnect);
        socket.on('secureConnect', onSecureConnect);
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(total);
        clearTimeout(connectTimer);
        detachSocketListeners();
        reject(
          new TransportError('PROXY_UNREACHABLE', '出站连接失败', stage, { cause: error }),
        );
      });

      req.on('close', () => {
        clearTimeout(total);
        clearTimeout(connectTimer);
        detachSocketListeners();
      });

      req.end();
    });

    if (status >= 300 && status < 400 && location !== undefined) {
      if (redirects >= MAX_REDIRECTS) {
        throw new TransportError('SERVICE_UNAVAILABLE', `重定向次数超过 ${MAX_REDIRECTS} 次`, 'http');
      }
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || !allowedHosts.includes(next.hostname)) {
        throw new TransportError('SERVICE_UNAVAILABLE', `重定向目标不在白名单：${next.hostname}`, 'http');
      }
      const crossHost = next.hostname !== url.hostname;
      const keepAuthorization =
        request.keepAuthorizationOnCrossHostRedirect === true || !crossHost;
      // 跨主机绝不传递 Authorization。
      return this.#requestOnce(request, next.toString(), redirects + 1, keepAuthorization);
    }

    return { status, headers: responseHeaders, body, bytes, url: url.toString() };
  }
}

export function createTransport(proxy: ProxySettings | null, agents: AgentFactory = defaultAgentFactory): Transport {
  return new HttpsTransport(proxy, agents);
}

/** 代理连通性探测的固定目标；后台接口不得变成任意 URL 探测器。 */
export const PROXY_PROBE_URL = 'https://api.github.com/rate_limit';

export interface ProxyProbeStage {
  readonly stage: 'dns' | 'connect' | 'tls' | 'http';
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly detail: string | null;
}

/**
 * 用与业务完全相同的 transport 探测候选代理，返回分阶段结果。
 * 失败时也返回已完成的阶段，便于管理员判断是 DNS、连接还是 TLS 问题。
 */
export async function probeProxy(
  candidate: ProxySettings,
  agents: AgentFactory = defaultAgentFactory,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<{ stages: ProxyProbeStage[]; ok: boolean; detail: string | null }> {
  const stages: ProxyProbeStage[] = [];
  const started = Date.now();
  const transport = createTransport(candidate, agents);
  try {
    const response = await transport.request({
      url: PROXY_PROBE_URL,
      timeoutMs,
      maxBytes: 256 * 1024,
      headers: { accept: 'application/vnd.github+json' },
    });
    stages.push({
      stage: 'dns',
      ok: true,
      elapsedMs: Date.now() - started,
      detail: candidate.scheme === 'socks5' ? '由代理远端解析（socks5h）' : '本地解析',
    });
    stages.push({ stage: 'connect', ok: true, elapsedMs: Date.now() - started, detail: null });
    stages.push({ stage: 'tls', ok: true, elapsedMs: Date.now() - started, detail: null });
    stages.push({
      stage: 'http',
      ok: response.status >= 200 && response.status < 500,
      elapsedMs: Date.now() - started,
      detail: `HTTP ${response.status}`,
    });
    return { stages, ok: response.status >= 200 && response.status < 500, detail: null };
  } catch (error) {
    const elapsed = Date.now() - started;
    const transportError = error instanceof TransportError ? error : null;
    const failedStage = transportError?.stage ?? 'connect';
    for (const stage of ['dns', 'connect', 'tls', 'http'] as const) {
      const reached = ['dns', 'connect', 'tls', 'http'].indexOf(stage) <= ['dns', 'connect', 'tls', 'http'].indexOf(failedStage);
      stages.push({
        stage,
        ok: reached && stage !== failedStage,
        elapsedMs: elapsed,
        detail: stage === failedStage ? (transportError?.message ?? '探测失败') : null,
      });
      if (stage === failedStage) break;
    }
    return { stages, ok: false, detail: transportError?.message ?? '代理不可达' };
  } finally {
    transport.close();
  }
}
