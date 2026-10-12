/**
 * PUBLIC_ORIGIN 的规范化与精确比较。
 *
 * 只接受 scheme + host + 有效 port，不接受路径、查询、fragment 或 userinfo；
 * 比较时按规范化后的 origin 精确匹配，禁止后缀匹配，避免
 * `https://radar.example.com.evil.com` 这类伪造 Origin 通过。
 */

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 } as const;

export type AllowedProtocol = keyof typeof DEFAULT_PORTS;

export interface PublicOrigin {
  /** 规范化后的 origin，省略默认端口，例如 `https://radar.example.com`。 */
  readonly origin: string;
  readonly protocol: AllowedProtocol;
  /** 小写主机名；IPv6 保留方括号形式（`[::1]`）。 */
  readonly hostname: string;
  /** 显式端口；未写时按 scheme 取 80/443。 */
  readonly port: number;
  readonly isLoopback: boolean;
  /** Cookie 的 Secure 属性由 PUBLIC_ORIGIN 协议派生。 */
  readonly cookieSecure: boolean;
  /**
   * 是否允许在本 Origin 上进行后台登录：HTTPS 可以；明文 HTTP 仅限回环地址
   * 的本机部署。为 false 时管理 API 与已有 Cookie 认证一并拒绝。
   */
  readonly managementAllowed: boolean;
}

export class OriginConfigError extends Error {
  readonly code = 'PUBLIC_ORIGIN_INVALID';

  constructor(message: string) {
    super(`PUBLIC_ORIGIN: ${message}`);
    this.name = 'OriginConfigError';
  }
}

function isAllowedProtocol(protocol: string): protocol is AllowedProtocol {
  return protocol === 'http:' || protocol === 'https:';
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '[::1]' || hostname === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  // 127.0.0.0/8 全部视为回环地址。
  return ipv4 !== null && ipv4[1] === '127';
}

function normalize(url: URL): string {
  if (!isAllowedProtocol(url.protocol)) {
    throw new OriginConfigError(`只支持 http/https，收到 ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new OriginConfigError('不允许包含 userinfo');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    throw new OriginConfigError('缺少主机名');
  }
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OriginConfigError(`端口非法：${url.port}`);
  }
  const isDefaultPort = port === DEFAULT_PORTS[url.protocol];
  return `${url.protocol}//${hostname}${isDefaultPort ? '' : `:${port}`}`;
}

export function parsePublicOrigin(raw: string): PublicOrigin {
  if (raw === '' || raw !== raw.trim()) {
    throw new OriginConfigError('不能为空且不能包含首尾空白');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OriginConfigError('不是合法的 URL');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new OriginConfigError('只能填写 scheme、主机和端口，不能带路径、查询或 fragment');
  }
  const origin = normalize(url);
  const protocol = url.protocol as AllowedProtocol;
  const hostname = url.hostname.toLowerCase();
  const isLoopback = isLoopbackHost(hostname);
  return {
    origin,
    protocol,
    hostname,
    port: url.port === '' ? DEFAULT_PORTS[protocol] : Number(url.port),
    isLoopback,
    cookieSecure: protocol === 'https:',
    managementAllowed: protocol === 'https:' || isLoopback,
  };
}

/**
 * 判断请求的 Host 头是否属于本部署。
 *
 * 校验请求 Host 与允许主机、拒绝恶意 Host。这里只接受：
 * - 配置的 PUBLIC_ORIGIN 主机（带或不带显式端口）；
 * - 回环主机加实际监听端口，且**直连来源也是回环地址**——容器健康探针
 *   总是直接访问 127.0.0.1:PORT；反代默认转发 `Host: 127.0.0.1:PORT` 时
 *   不能让全站流量借道该分支绕过主机白名单。
 * 其余一律拒绝，因此把端口暴露到非预期主机名不会进入管理路径。
 */
export function isAllowedHost(
  expected: PublicOrigin,
  hostHeader: string | null | undefined,
  listenPort: number,
  clientIp: string,
): boolean {
  if (hostHeader === null || hostHeader === undefined) return false;
  const value = hostHeader.trim().toLowerCase();
  if (value === '') return false;
  const [hostPart, portPart] = splitHostPort(value);
  if (hostPart === '') return false;

  if (hostPart === expected.hostname.toLowerCase()) {
    // Host 头省略端口时，隐含的是该 scheme 的默认端口（http 80 / https 443），
    // 而不是本部署配置的端口——否则 `Host: example.com`（隐含 80）会被误判成命中 9000 端口。
    const impliedPort = portPart === '' ? DEFAULT_PORTS[expected.protocol] : Number(portPart);
    if (impliedPort === expected.port) return true;
  }
  // 回环探针豁免：回环主机 + 实际监听端口，且**直连来源也是回环地址**——
  // 容器健康探针总是直接访问 127.0.0.1:PORT；反代默认转发 `Host: 127.0.0.1:PORT`
  // 时不能让全站流量借道该分支绕过主机白名单。
  if (
    (hostPart === '127.0.0.1' || hostPart === 'localhost' || hostPart === '[::1]') &&
    portPart === String(listenPort)
  ) {
    return isLoopbackAddress(clientIp);
  }
  return false;
}

/** 直连来源 IP 是否回环：127.0.0.0/8、IPv6 回环及 IPv4 映射形式。 */
function isLoopbackAddress(ip: string): boolean {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

function splitHostPort(value: string): [string, string] {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return [value, ''];
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    return [host, rest.startsWith(':') ? rest.slice(1) : ''];
  }
  const index = value.lastIndexOf(':');
  if (index === -1) return [value, ''];
  return [value.slice(0, index), value.slice(index + 1)];
}

/**
 * 判断请求携带的 Origin 是否正是配置的部署 Origin。
 * `null`、`"null"`、空值和非法值一律不通过，由调用方返回 403。
 */
export function isSameOrigin(
  expected: PublicOrigin,
  candidate: string | null | undefined,
): boolean {
  if (candidate === null || candidate === undefined) return false;
  if (candidate === '' || candidate !== candidate.trim()) return false;
  if (candidate === 'null') return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  try {
    return normalize(url) === expected.origin;
  } catch {
    return false;
  }
}
