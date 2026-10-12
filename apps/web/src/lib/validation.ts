import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_ALLOWED_SYMBOLS,
} from './constants.js';

/**
 * 表单输入的即时校验规则。
 * 事实来源是服务端契约 `packages/contracts/src/network.ts`：前端对契约只做类型导入
 * （运行时导入会把 zod 打进客户端 bundle），因此规则在这里保留一份等价实现，
 * 修改时必须同步两处。服务端始终是唯一执行方，这里的校验只用于即时反馈，
 * 不构成授权或安全边界。
 */

// ---- 网络与凭证 ----

export const PROXY_HOST_INVALID = '主机必须是 IPv4、IPv6 或合法主机名';

const IPV4_SEGMENT = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => IPV4_SEGMENT.test(part));
}

function isIpv6(value: string): boolean {
  const doubleColonParts = value.split('::');
  if (doubleColonParts.length > 2) return false;
  const toGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));

  const validGroups = (groups: readonly string[], allowIpv4Tail: boolean): boolean => {
    const hasIpv4Tail = allowIpv4Tail && groups.length > 0 && groups[groups.length - 1]?.includes('.') === true;
    const plain = hasIpv4Tail ? groups.slice(0, -1) : groups;
    if (hasIpv4Tail && !isIpv4(groups[groups.length - 1] ?? '')) return false;
    return plain.every((group) => IPV6_GROUP.test(group));
  };

  if (doubleColonParts.length === 2) {
    const head = toGroups(doubleColonParts[0] ?? '');
    const tail = toGroups(doubleColonParts[1] ?? '');
    if (!validGroups(head, false) || !validGroups(tail, true)) return false;
    // `::` 至少压缩一个 16 位组；末段 IPv4 代表两个组，按 2 计数。
    const tailHasIpv4 = tail.length > 0 && (tail[tail.length - 1]?.includes('.') === true);
    return head.length + tail.length + (tailHasIpv4 ? 1 : 0) <= 7;
  }

  const groups = toGroups(value);
  if (!validGroups(groups, true)) return false;
  // 无 `::` 时必须恰好 8 个 16 位组；末段 IPv4 自身代表两个组，因此是 6 组 + IPv4。
  const hasIpv4Tail = groups.length > 0 && (groups[groups.length - 1]?.includes('.') === true);
  return hasIpv4Tail ? groups.length === 7 : groups.length === 8;
}

export function isValidProxyHost(value: string): boolean {
  const host = value.trim();
  if (host === '') return false;
  if (isIpv4(host)) return true;
  // 纯数字与点：只能按 IPv4 解释，不接受 "1.2.3" 或 "256.1.1.1" 这类歧义写法。
  if (/^[0-9.]+$/.test(host)) return false;
  if (host.startsWith('[') && host.endsWith(']')) return isIpv6(host.slice(1, -1));
  if (host.includes(':')) return isIpv6(host);
  if (host.length > 253) return false;
  return host
    .split('.')
    .every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export const PROXY_PORT_INVALID = '端口需为 1–65535 的整数';

/** 端口：1–65535 的十进制整数（与服务端契约一致，不接受 0、负数与非数字）。 */
export function isValidPort(value: string): boolean {
  if (!/^[0-9]{1,5}$/.test(value.trim())) return false;
  const port = Number(value.trim());
  return port >= 1 && port <= 65535;
}

export const PROXY_USERNAME_INVALID = '账号不能包含控制字符';

/** 代理账号：≤255 个字符且不含控制字符（与服务端契约一致）。 */
export function isValidProxyUsername(value: string): boolean {
  const username = value.trim();
  return username.length <= 255 && !/[\u0000-\u001f\u007f]/.test(username);
}

export const GITHUB_TOKEN_INVALID = '只接受 ghp_ 或 github_pat_ 开头的令牌，且不能包含空白字符';

export function isValidGithubToken(value: string): boolean {
  const token = value.trim();
  if (token === '' || token.length > 512) return false;
  if (/\s/.test(token)) return false;
  return token.startsWith('ghp_') || token.startsWith('github_pat_');
}

export const LABEL_COLOR_INVALID = '颜色需为 #RGB、#RRGGBB 或 #RRGGBBAA';

export function isValidLabelColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim());
}

// ---- 密码 ----

/** 允许的字符集合：字母、数字，加上可选的 `!@#$%^&*`（与服务端契约同一集合）。 */
const PASSWORD_CHARSET = /^[A-Za-z0-9!@#$%^&*]+$/;

export const PASSWORD_CHARSET_INVALID = `密码只能包含字母、数字与 ${PASSWORD_ALLOWED_SYMBOLS}`;
export const PASSWORD_COMPOSITION_INVALID = '密码需同时包含大写字母、小写字母与数字';

/** 与服务端 `assertPasswordPolicy` 同规则：返回第一条违规说明，符合时返回 null。 */
export function passwordPolicyViolation(password: string): string | null {
  const chars = [...password].length;
  if (chars < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`;
  if (chars > MAX_PASSWORD_LENGTH) return `密码最多 ${MAX_PASSWORD_LENGTH} 个字符`;
  if (!PASSWORD_CHARSET.test(password)) return PASSWORD_CHARSET_INVALID;
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return PASSWORD_COMPOSITION_INVALID;
  }
  return null;
}
