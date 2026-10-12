import { useSyncExternalStore } from 'react';

/**
 * 服务器时钟偏差估算：
 * - 用响应 `Date` 头 + 请求往返中点估算偏差；响应带 `Age`（缓存年龄）时计入。
 * - 相对时间展示使用校正后的服务器时间；页面恢复可见时重算（本模块的分钟 tick 触发重渲染）。
 * - 本模块只负责“现在几点”，不做任何时间差文案格式化（格式化在 relative-time.ts）。
 */

interface TimingSample {
  sentAt: number;
  receivedAt: number;
  dateHeader: string | null;
  ageHeader: string | null;
}

const MAX_SANE_OFFSET_MS = 24 * 60 * 60 * 1000;

let offsetMs = 0;
let offsetKnown = false;

export function recordServerTiming(sample: TimingSample): void {
  if (sample.dateHeader === null) {
    return;
  }
  const serverAt = Date.parse(sample.dateHeader);
  if (!Number.isFinite(serverAt)) {
    return;
  }
  let ageMs = 0;
  if (sample.ageHeader !== null) {
    const age = Number(sample.ageHeader);
    if (Number.isFinite(age) && age > 0) {
      ageMs = age * 1000;
    }
  }
  const clientMid = (sample.sentAt + sample.receivedAt) / 2;
  const candidate = serverAt + ageMs - clientMid;
  if (Math.abs(candidate) > MAX_SANE_OFFSET_MS) {
    return;
  }
  if (!offsetKnown || Math.abs(candidate - offsetMs) > 1000) {
    offsetMs = candidate;
    offsetKnown = true;
  }
}

/** 校正后的服务器当前时间（毫秒）。 */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

// ---- 每分钟重渲染的共享时钟（不访问服务器） ----

let nowSnapshot = Date.now();
const listeners = new Set<() => void>();
let timer: number | null = null;

function tick(): void {
  nowSnapshot = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

function handleVisibility(): void {
  if (document.visibilityState === 'visible') {
    tick();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (listeners.size === 1) {
    nowSnapshot = Date.now();
    timer = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', handleVisibility);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      document.removeEventListener('visibilitychange', handleVisibility);
    }
  };
}

function getSnapshot(): number {
  return nowSnapshot;
}

/** 每 60 秒与页面恢复可见时更新的客户端时间戳；配合 serverNow() 得到校正后的现在。 */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
