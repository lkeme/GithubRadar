import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  fetchAdminLabels,
  fetchAvailableBranches,
  fetchCredentialStatus,
  fetchDiscovery,
  fetchImportProgress,
  fetchJobs,
  fetchOperation,
  fetchPins,
  fetchProxyStatus,
  fetchPublicConfig,
  fetchPublicLabels,
  fetchPublicRepositories,
  fetchRepositoryControls,
  fetchRepositoryDetail,
  fetchSettings,
  fetchSystemStatus,
  type DiscoveryListParams,
  type DiscoveryMeta,
  type ImportProgressData,
  type JobSummary,
  type OperationData,
  type PublicConfig,
  type PublicLabel,
  type PublicRepository,
  type RepositoryControl,
  type RepositoryDetailData,
  type SettingsData,
  type SystemStatusData,
  type CredentialStatusData,
  type ProxyStatus,
  type AvailableBranchesMeta,
  type LabelDefinition,
} from '../../lib/api';
import type { ListMeta } from '@githubradar/contracts';
import { ACTIVE_JOB_POLL_MS, PAGE_SIZE, PUBLIC_STALE_MS } from '../../lib/constants';
import {
  queryKeys,
  useDocumentVisible,
  useVisibleRefreshInterval,
} from '../../lib/query';
import type { DashboardFilters } from './filters';
import { filtersKey } from './filters';
import { useAuth } from '../auth/AuthProvider';

/**
 * 查询 hooks：
 * - 公开查询：staleTime 60 秒、可见时每 60 秒刷新、隐藏标签页停止刷新、翻页保留上一页数据避免闪烁。
 * - 管理查询：key 携带 authEpoch；会话未知/退出即停止（enabled=false）；一次性批量获取当前页 ID，禁止 N+1。
 * - 进行中的任务用 3 秒合并轮询，完成后停止。
 */

export function hasActiveJobState(state: JobSummary['state']): boolean {
  return state === 'queued' || state === 'running' || state === 'retry_wait';
}

// public/config 与 public/labels 同样是公开数据：staleTime 60 秒、可见页面每 60 秒刷新。
export function usePublicConfig(): UseQueryResult<PublicConfig> {
  const refreshInterval = useVisibleRefreshInterval();
  return useQuery({
    queryKey: queryKeys.publicConfig,
    queryFn: ({ signal }) => fetchPublicConfig(signal),
    staleTime: PUBLIC_STALE_MS,
    refetchInterval: refreshInterval,
  });
}

export function usePublicRepositories(
  filters: DashboardFilters,
  trendDays: number,
): UseQueryResult<{ data: PublicRepository[]; meta: ListMeta }> {
  const key = filtersKey(filters, trendDays);
  const refreshInterval = useVisibleRefreshInterval();
  const pageSize = PAGE_SIZE;
  return useQuery({
    queryKey: queryKeys.publicRepositories(key),
    queryFn: ({ signal }) =>
      fetchPublicRepositories(
        {
          q: filters.q,
          labels: filters.labels,
          pinned: filters.pinned,
          changed: filters.changed,
          sort: filters.sort,
          // 趋势窗口随列表请求一起发出：切换区间仍然只有一个请求。
          days: trendDays,
          page: filters.page,
          pageSize,
        },
        signal,
      ),
    refetchInterval: refreshInterval,
    placeholderData: keepPreviousData,
  });
}

export function usePublicLabels(): UseQueryResult<PublicLabel[]> {
  const refreshInterval = useVisibleRefreshInterval();
  return useQuery({
    queryKey: queryKeys.publicLabels,
    queryFn: ({ signal }) => fetchPublicLabels(signal),
    staleTime: PUBLIC_STALE_MS,
    refetchInterval: refreshInterval,
  });
}

export function useDiscovery(
  params: DiscoveryListParams,
  enabled: boolean = true,
): UseQueryResult<{ data: DiscoveryResultItems; meta: DiscoveryMeta }> {
  const key = JSON.stringify(params);
  const refreshInterval = useVisibleRefreshInterval();
  return useQuery({
    queryKey: queryKeys.discovery(key),
    queryFn: ({ signal }) => fetchDiscovery(params, signal),
    enabled,
    refetchInterval: refreshInterval,
    placeholderData: keepPreviousData,
  });
}

type DiscoveryResultItems = Awaited<ReturnType<typeof fetchDiscovery>>['data'];

// ---- 管理查询 ----

export function useRepositoryControls(ids: string[]): UseQueryResult<{ data: RepositoryControl[]; setupRequired: boolean }> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  const idsKey = useMemo(() => [...ids].sort().join(','), [ids]);
  const stableIds = useMemo(() => (idsKey.length > 0 ? idsKey.split(',') : []), [idsKey]);
  return useQuery({
    queryKey: queryKeys.controls(epoch, idsKey),
    queryFn: ({ signal }) => fetchRepositoryControls(stableIds, signal),
    enabled: isAuthenticated && stableIds.length > 0,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const controls = query.state.data?.data;
      const active = Array.isArray(controls) && controls.some((control) => control.jobState !== 'idle');
      return visible && active ? ACTIVE_JOB_POLL_MS : false;
    },
  });
}

export function useRepositoryDetail(id: string | null): UseQueryResult<RepositoryDetailData> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.repositoryDetail(epoch, id ?? ''),
    queryFn: ({ signal }) => fetchRepositoryDetail(id as string, signal),
    enabled: isAuthenticated && id !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useAvailableBranches(id: string | null): UseQueryResult<{ data: { name: string }[]; meta: AvailableBranchesMeta }> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.availableBranches(epoch, id ?? ''),
    queryFn: ({ signal }) => fetchAvailableBranches(id as string, 1, signal),
    enabled: isAuthenticated && id !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useAdminLabels(): UseQueryResult<LabelDefinition[]> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.adminLabels(epoch),
    queryFn: ({ signal }) => fetchAdminLabels(signal),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
}

export function usePins(): UseQueryResult<{ pinsRevision: number; ids: string[] }> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.pins(epoch),
    queryFn: ({ signal }) => fetchPins(signal),
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

export function useJobs(page: number): UseQueryResult<{ data: JobSummary[]; meta: ListMeta }> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.jobs(epoch, page),
    queryFn: ({ signal }) => fetchJobs(page, signal),
    enabled: isAuthenticated,
    refetchInterval: (query) => {
      if (!visible) {
        return false;
      }
      const jobs = query.state.data?.data;
      const active = Array.isArray(jobs) && jobs.some((job) => hasActiveJobState(job.state));
      return active ? ACTIVE_JOB_POLL_MS : 60_000;
    },
  });
}

export function useSystemStatus(): UseQueryResult<SystemStatusData> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.systemStatus(epoch),
    queryFn: ({ signal }) => fetchSystemStatus(signal),
    enabled: isAuthenticated,
    refetchInterval: visible ? 60_000 : false,
  });
}

export function useSettings(): UseQueryResult<SettingsData> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.settings(epoch),
    queryFn: ({ signal }) => fetchSettings(signal),
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

export function useCredentialStatus(): UseQueryResult<CredentialStatusData> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.credential(epoch),
    queryFn: ({ signal }) => fetchCredentialStatus(signal),
    enabled: isAuthenticated,
    refetchInterval: visible ? 60_000 : false,
  });
}

export function useProxyStatus(): UseQueryResult<ProxyStatus> {
  const { isAuthenticated, epoch } = useAuth();
  return useQuery({
    queryKey: queryKeys.proxy(epoch),
    queryFn: ({ signal }) => fetchProxyStatus(signal),
    enabled: isAuthenticated,
    staleTime: 30_000,
  });
}

export function useImportProgress(groupId: string | null): UseQueryResult<ImportProgressData> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.importProgress(epoch, groupId ?? ''),
    queryFn: ({ signal }) => fetchImportProgress(groupId as string, signal),
    enabled: isAuthenticated && groupId !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      if (!visible || groupId === null) {
        return false;
      }
      // 存在进行中任务时每 3 秒合并查询一次，完成后停止快速轮询。
      return query.state.data?.state === 'running' ? ACTIVE_JOB_POLL_MS : false;
    },
  });
}

export function useOperation(id: string | null): UseQueryResult<OperationData> {
  const { isAuthenticated, epoch } = useAuth();
  const visible = useDocumentVisible();
  return useQuery({
    queryKey: queryKeys.operation(epoch, id ?? ''),
    queryFn: ({ signal }) => fetchOperation(id as string, signal),
    enabled: isAuthenticated && id !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      if (!visible || id === null) {
        return false;
      }
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? ACTIVE_JOB_POLL_MS : false;
    },
  });
}
