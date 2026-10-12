import type { CredentialService } from '../../credentials/service.js';
import { createTransport, type ProxySettings, type Transport, type TransportRequest, type TransportResponse } from './index.js';

/**
 * 出站通道提供者。
 *
 * 代理变化会增加 transport revision；这里按 revision 缓存当前通道，
 * 配置变化后下一次请求即使用新通道，旧连接被关闭。直连与代理共用同一套
 * transport 语义，不产生第二套 HTTP 客户端。
 */

export interface TransportProviderDeps {
  readonly credentials: CredentialService;
  readonly describeProxy: () => { enabled: boolean; revision: number };
  /** 可注入的通道工厂；默认使用真实出站实现的 `createTransport`。 */
  readonly createTransport?: (proxy: ProxySettings | null) => Transport;
}

export class TransportProvider implements Transport {
  readonly #deps: TransportProviderDeps;
  readonly #factory: (proxy: ProxySettings | null) => Transport;
  #cached: { revision: number; transport: Transport; signature: string } | null = null;

  constructor(deps: TransportProviderDeps) {
    this.#deps = deps;
    this.#factory = deps.createTransport ?? createTransport;
  }

  #resolve(): Transport {
    const proxy = this.#deps.credentials.activeProxy();
    const revision = this.#deps.describeProxy().revision;
    const signature = proxy === null
      ? 'direct'
      : `${proxy.scheme}:${proxy.host}:${proxy.port}:${proxy.username ?? ''}`;
    // 必须同时比较 revision：轮换代理密码时 host/端口/用户名都没变，
    // 只看 signature 会继续复用带旧密码的 Agent，直到进程重启。
    if (this.#cached !== null && this.#cached.revision === revision && this.#cached.signature === signature) {
      return this.#cached.transport;
    }
    const transport = this.#factory(proxy as ProxySettings | null);
    const previous = this.#cached;
    this.#cached = { revision, transport, signature };
    if (previous !== null) previous.transport.close();
    return transport;
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    return this.#resolve().request(request);
  }

  describe(): { mode: 'direct' | 'proxy'; proxyScheme: ProxySettings['scheme'] | null } {
    return this.#resolve().describe();
  }

  close(): void {
    this.#cached?.transport.close();
    this.#cached = null;
  }
}
