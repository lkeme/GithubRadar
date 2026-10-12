/**
 * 数值与外链展示辅助：
 * - Star/Fork 可紧凑缩写，聚焦/点击可查看准确数值。
 * - 外链只允许 https 且主机为 github.com；仓库头像仅允许 https://avatars.githubusercontent.com（无 userinfo、非标准端口）。
 */

const exactFormatter = new Intl.NumberFormat('zh-CN');
const compactFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatExactCount(value: number): string {
  return exactFormatter.format(value);
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return Math.abs(value) < 1000 ? exactFormatter.format(value) : compactFormatter.format(value);
}

export function formatSignedCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return value > 0 ? `+${exactFormatter.format(value)}` : exactFormatter.format(value);
}

export const GITHUB_AVATAR_HOST = 'avatars.githubusercontent.com';
/** 外链白名单主机：仓库、Release、分支等外链只指向 GitHub 官方域。 */
export const GITHUB_LINK_HOST = 'github.com';

export function isSafeHttpsUrl(raw: string | null | undefined): raw is string {
  if (!raw) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return false;
  }
  return true;
}

/** 外链只允许 https 且主机必须是 github.com；其余返回 null，由调用方渲染为纯文本。 */
export function safeExternalHref(raw: string | null | undefined): string | null {
  if (!isSafeHttpsUrl(raw)) {
    return null;
  }
  try {
    return new URL(raw).hostname === GITHUB_LINK_HOST ? raw : null;
  } catch {
    return null;
  }
}

/** 头像只允许 GitHub 官方头像主机；不建立任意 URL 图片代理。 */
export function safeAvatarSrc(raw: string | null | undefined): string | null {
  if (!isSafeHttpsUrl(raw)) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    return parsed.hostname === GITHUB_AVATAR_HOST ? raw : null;
  } catch {
    return null;
  }
}
