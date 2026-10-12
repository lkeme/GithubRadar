import { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { ApiError, StaleAuthError } from './errors';
import { markPublicCacheRevalidation } from './api';
import { PUBLIC_REFRESH_MS, PUBLIC_STALE_MS } from './constants';

/**
 * 查询与轮询约定：
 * - 公开查询 staleTime 60 秒；页面可见时每 60 秒刷新，隐藏标签页停止周期刷新。
 * - 401 安静降级、403 显示原因不重试；管理查询 key 携带 authEpoch，退出后旧缓存不可见。
 * - 写操作成功后显式失效相关公开查询与管理补充查询。
 */

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof StaleAuthError) {
    return false;
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 429) {
      return false;
    }
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: PUBLIC_STALE_MS,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const ADMIN_QUERY_ROOT = 'admin';

/** 退出/认证转换：立即清空全部管理查询缓存。 */
export function removeAdminQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] === ADMIN_QUERY_ROOT });
}

export type InvalidationScope = 'repositories' | 'labels' | 'repositories+labels' | 'discovery' | 'config';

/**
 * 看板写操作成功后：公开查询与管理补充查询一起失效，不等 30 秒缓存自然过期。
 *
 * `public/config` 提供标题与前台通用数据状态（overallState），相关写操作后一并失效。
 */
export function invalidateAfterWrite(client: QueryClient, scope: InvalidationScope): void {
  // 公开响应带 max-age=30：不让失效触发的 refetch 被浏览器缓存直接满足，
  // 下一次公开请求强制走条件请求。
  markPublicCacheRevalidation();
  void client.invalidateQueries({
    predicate: (query) => {
      const root = query.queryKey[0];
      if (root === 'public') {
        const section = query.queryKey[1];
        if (section === 'config') {
          return scope === 'config' || scope === 'discovery';
        }
        if (section === 'repos') {
          return scope !== 'discovery' && scope !== 'config';
        }
        if (section === 'labels') {
          return scope === 'labels' || scope === 'repositories+labels';
        }
        if (section === 'discovery') {
          return scope === 'discovery';
        }
        if (section === 'trends') {
          return scope === 'discovery';
        }
        return false;
      }
      return root === ADMIN_QUERY_ROOT;
    },
  });
}

export const queryKeys = {
  publicConfig: ['public', 'config'] as const,
  publicRepositories: (paramsKey: string) => ['public', 'repos', paramsKey] as const,
  publicLabels: ['public', 'labels'] as const,
  discovery: (paramsKey: string) => ['public', 'discovery', paramsKey] as const,
  trends: (paramsKey: string) => ['public', 'trends', paramsKey] as const,
  controls: (epoch: number, idsKey: string) => ['admin', epoch, 'controls', idsKey] as const,
  repositoryDetail: (epoch: number, id: string) => ['admin', epoch, 'repo', id] as const,
  availableBranches: (epoch: number, id: string) => ['admin', epoch, 'branches', id] as const,
  adminLabels: (epoch: number) => ['admin', epoch, 'labels'] as const,
  pins: (epoch: number) => ['admin', epoch, 'pins'] as const,
  jobs: (epoch: number, page: number) => ['admin', epoch, 'jobs', page] as const,
  systemStatus: (epoch: number) => ['admin', epoch, 'system-status'] as const,
  settings: (epoch: number) => ['admin', epoch, 'settings'] as const,
  credential: (epoch: number) => ['admin', epoch, 'credential'] as const,
  proxy: (epoch: number) => ['admin', epoch, 'proxy'] as const,
  importProgress: (epoch: number, groupId: string) => ['admin', epoch, 'import', groupId] as const,
  operation: (epoch: number, id: string) => ['admin', epoch, 'operation', id] as const,
};

// ---- 文档可见性 ----

function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback);
  return () => {
    document.removeEventListener('visibilitychange', callback);
  };
}

function getVisibilitySnapshot(): boolean {
  return document.visibilityState === 'visible';
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot);
}

/** 可见时返回周期刷新间隔，隐藏标签页返回 false（停止周期刷新）。 */
export function useVisibleRefreshInterval(intervalMs: number = PUBLIC_REFRESH_MS): number | false {
  return useDocumentVisible() ? intervalMs : false;
}
