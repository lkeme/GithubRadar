import { STORAGE_PREFIX } from './constants';

/**
 * localStorage 只存主题偏好与视图偏好（任务硬性规则）：
 * key 一律带 `githubradar:` 前缀，读取异常或缺省时回落默认值，绝不写入任何凭证或管理字段。
 */

export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    // 隐私模式等场景下写入失败时静默回落默认值。
  }
}

export function readPreferenceFrom<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readPreference(key);
  if (raw !== null && (allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  return fallback;
}
