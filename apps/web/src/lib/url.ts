/**
 * returnTo 校验：
 * 只接受站内相对路径且限定允许页面（/、/discover、/settings、/jobs），保留安全查询参数；
 * 拒绝协议相对 URL、反斜杠、控制字符与跨站 Origin。
 */

const ALLOWED_RETURN_PATHS: readonly string[] = ['/', '/discover', '/settings', '/jobs'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeReturnTo(raw: string | null): string {
  if (raw === null || raw.length === 0) {
    return '/';
  }
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/';
  }
  if (CONTROL_CHARS.test(raw) || raw.includes('%5c') || raw.includes('%5C')) {
    return '/';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, window.location.origin);
  } catch {
    return '/';
  }
  if (parsed.origin !== window.location.origin) {
    return '/';
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== window.location.port) {
    return '/';
  }
  const path = parsed.pathname === '' ? '/' : parsed.pathname;
  if (!ALLOWED_RETURN_PATHS.includes(path)) {
    return '/';
  }
  return path + (parsed.search.length > 0 ? parsed.search : '');
}
