import { z } from 'zod';

import { PASSWORD_ALLOWED_SYMBOLS, PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS } from './limits.js';

/**
 * 部署与凭证类输入的格式校验。
 *
 * 这是服务端的唯一规则来源；前端在 `apps/web/src/lib/validation.ts` 保留等价实现
 * （前端对契约只做类型导入，运行时引用会把 zod 打进浏览器 bundle），
 * 修改规则时必须同步两处，并由契约测试比对。
 */

/** 代理主机：IPv4、IPv6（可带方括号）或合法主机名。 */
export function isValidProxyHost(value: string): boolean {
  const host = value.trim();
  if (host === '') return false;
  if (isIpv4(host)) return true;
  // 纯数字与点：只能按 IPv4 解释，不接受 "1.2.3" 或 "256.1.1.1" 这类歧义写法。
  if (/^[0-9.]+$/.test(host)) return false;
  if (host.startsWith('[') && host.endsWith(']')) return isIpv6(host.slice(1, -1));
  if (host.includes(':')) return isIpv6(host);
  return isHostname(host);
}

const IPV4_SEGMENT = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => IPV4_SEGMENT.test(part));
}

/** IPv6：允许一个 `::` 压缩、末段 IPv4 形式（如 `::ffff:192.168.0.1`）。 */
function isIpv6(value: string): boolean {
  const doubleColonParts = value.split('::');
  if (doubleColonParts.length > 2) return false;
  const toGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));

  const validGroups = (groups: readonly string[], allowIpv4Tail: boolean): boolean => {
    const plain = allowIpv4Tail && groups.length > 0 && groups[groups.length - 1]?.includes('.') === true
      ? groups.slice(0, -1)
      : groups;
    const tail = plain.length === groups.length ? null : groups[groups.length - 1];
    if (tail !== null && tail !== undefined && !isIpv4(tail)) return false;
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

/** 主机名：RFC 1123 标签（字母/数字/连字符，不以连字符开头或结尾），总长 ≤253。 */
function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

export const PROXY_HOST_INVALID = '主机必须是 IPv4、IPv6 或合法主机名';
export const PROXY_USERNAME_INVALID = '账号不能包含控制字符';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 账号/密码按原样提交，空白字符会进入代理握手，因此在契约层就拒绝。 */
export function isValidProxyUsername(value: string): boolean {
  const username = value.trim();
  return username.length <= 255 && !CONTROL_CHARS.test(username);
}

// 与 GithubToken 一样在链上 trim：校验对象必须与落库对象一致，
// 否则 "proxy.local " 这类带空白的取值能通过校验却拼不出可用 URL。
export const ProxyHost = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidProxyHost, { message: PROXY_HOST_INVALID });
export const ProxyUsername = z
  .string()
  .trim()
  .max(255)
  .refine((value) => !CONTROL_CHARS.test(value), { message: PROXY_USERNAME_INVALID });

/** 代理端口：自定义消息，避免直接把英文的默认校验文案透出到字段错误。 */
export const PROXY_PORT_INVALID = '端口需为 1–65535 的整数';
export const ProxyPort = z
  .number({ message: PROXY_PORT_INVALID })
  .int({ message: PROXY_PORT_INVALID })
  .min(1, { message: PROXY_PORT_INVALID })
  .max(65535, { message: PROXY_PORT_INVALID });

/** GitHub PAT：只接受 classic（ghp_）与 fine-grained（github_pat_）前缀，且不含空白字符。 */
export function isValidGithubToken(value: string): boolean {
  const token = value.trim();
  if (token === '' || token.length > 512) return false;
  if (/\s/.test(token)) return false;
  return token.startsWith('ghp_') || token.startsWith('github_pat_');
}

export const GITHUB_TOKEN_INVALID = '只接受 ghp_ 或 github_pat_ 开头的令牌，且不能包含空白字符';

export const GithubToken = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(isValidGithubToken, { message: GITHUB_TOKEN_INVALID });

/** 标签颜色：`#RGB`、`#RRGGBB` 或 `#RRGGBBAA`。 */
export const LABEL_COLOR_INVALID = '颜色需为 #RGB、#RRGGBB 或 #RRGGBBAA';

export function isValidLabelColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim());
}

export const LabelColor = z.string().max(32).refine(isValidLabelColor, { message: LABEL_COLOR_INVALID });

/** 允许的字符集合：字母、数字，加上可选的 `!@#$%^&*`（与 `PASSWORD_ALLOWED_SYMBOLS` 同一集合）。 */
const PASSWORD_CHARSET = /^[A-Za-z0-9!@#$%^&*]+$/;

export const PASSWORD_CHARSET_INVALID = `密码只能包含字母、数字与 ${PASSWORD_ALLOWED_SYMBOLS}`;
export const PASSWORD_COMPOSITION_INVALID = '密码需同时包含大写字母、小写字母与数字';

/**
 * 密码策略：返回第一条违规说明，符合策略时返回 null。
 * 服务端哈希入口与契约校验共用本函数；前端在 validation.ts 保留等价实现。
 */
export function passwordPolicyViolation(password: string): string | null {
  const chars = [...password].length;
  if (chars < PASSWORD_MIN_CHARS) return `密码至少 ${PASSWORD_MIN_CHARS} 个字符`;
  if (chars > PASSWORD_MAX_CHARS) return `密码最多 ${PASSWORD_MAX_CHARS} 个字符`;
  if (!PASSWORD_CHARSET.test(password)) return PASSWORD_CHARSET_INVALID;
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return PASSWORD_COMPOSITION_INVALID;
  }
  return null;
}

/**
 * 密码字段契约：直接复用策略函数，把**具体**的违规说明放进字段错误，
 * 而不是笼统的"密码不合规"（服务端 fields 会原样展示在对应输入框下）。
 */
export const Password = z.string().min(1).superRefine((value, ctx) => {
  const violation = passwordPolicyViolation(value);
  if (violation !== null) {
    ctx.addIssue({ code: 'custom', message: violation });
  }
});
