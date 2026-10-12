import { Inbox, SearchX, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Dialog';
import { useToast } from '../components/ui/Toast';
import { EmptyState, ErrorState } from '../components/ui/States';
import { Pagination } from '../components/ui/Pagination';
import { FilterBar } from '../components/dashboard/FilterBar';
import { SelectionToolbar } from '../components/dashboard/SelectionToolbar';
import { ConfirmRemoveDialog, type RemoveTarget } from '../components/dashboard/ConfirmRemoveDialog';
import { LabelPickerDialog } from '../components/dashboard/LabelPickerDialog';
import { MonitorEditDrawer } from '../components/dashboard/MonitorEditDrawer';
import { PinOrderDialog } from '../components/dashboard/PinOrderDialog';
import { RepoLabelsDialog } from '../components/dashboard/RepoLabelsDialog';
import { RepoCard } from '../components/dashboard/RepoCard';
import { RepoRow } from '../components/dashboard/RepoRow';
import { DashboardProvider, type BrowseState, type RepoActionKind, type RepoCommands } from '../components/dashboard/DashboardContext';
import { useAuth } from '../features/auth/AuthProvider';
import { useDashboardUi } from '../features/dashboard/ui-store';
import { toLabelIdNumbers } from '../features/repos/labels';
import {
  useDeleteRepository,
  useCheckRepositories,
  usePutPins,
  useRepositoryActions,
} from '../features/repos/mutations';
import {
  useAdminLabels,
  usePublicConfig,
  usePins,
  usePublicLabels,
  usePublicRepositories,
  useRepositoryControls,
} from '../features/repos/queries';
import type { BulkActionItemInput, BulkItemResult, PublicRepository } from '../lib/api';
import { PAGE_SIZE } from '../lib/constants';
import { errorMessage } from '../lib/errors';
import { useTrendRangePreference, useViewPreference } from '../lib/preferences';
import type { DashboardFilters } from '../features/repos/filters';
import { filtersToSearch, hasActiveFilters, parseFilters } from '../features/repos/filters';

interface BulkResultsState {
  title: string;
  rows: Array<{ id: string; name: string; text: string }>;
}

interface EditingRepoState {
  id: string;
  name: string;
}

function bulkStatusText(status: BulkItemResult['status']): string {
  switch (status) {
    case 'ok':
      return '成功';
    case 'conflict':
      return '配置已被其他操作更新，请刷新后重试';
    case 'failed':
      return '失败';
    case 'not_executed_auth':
      return '会话已失效，未执行';
    case 'not_executed_setup_required':
      return 'Token 未就绪，未执行';
  }
}

/**
 * 看板页面：
 * 筛选条件写入 URL；卡片（默认）与紧凑列表双视图共享同一筛选、分页与选中集合；
 * 登录后原位管理，公开数据与管理补充数据分开请求。
 */
export function DashboardPage() {
  const auth = useAuth();
  const ui = useDashboardUi();
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const [view, setView] = useViewPreference();
  const [trendRange, setTrendRange] = useTrendRangePreference();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editingRepo, setEditingRepo] = useState<EditingRepoState | null>(null);
  const [labelsRepo, setLabelsRepo] = useState<EditingRepoState | null>(null);
  const [removeTargets, setRemoveTargets] = useState<RemoveTarget[] | null>(null);
  const [bulkLabelMode, setBulkLabelMode] = useState<'add' | 'remove' | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkResultsState | null>(null);
  const [pinOrderOpen, setPinOrderOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const reposQuery = usePublicRepositories(filters, trendRange);
  const labelsQuery = usePublicLabels();
  const adminLabelsQuery = useAdminLabels();
  const repos = reposQuery.data?.data ?? [];
  const total = reposQuery.data?.meta.total ?? 0;
  const pageIds = useMemo(() => repos.map((repo) => repo.id), [repos]);
  const controlsQuery = useRepositoryControls(pageIds);
  const pinsQuery = usePins();

  const checkMutation = useCheckRepositories();
  const actionsMutation = useRepositoryActions();
  const deleteMutation = useDeleteRepository();
  const putPinsMutation = usePutPins();
  /** 置顶写操作提交的是完整顺序：任一卡片在途时，全部卡片的置顶入口一起禁用。 */
  const pinsPending = putPinsMutation.isPending;

  const controlsById = useMemo(
    () => new Map((controlsQuery.data?.data ?? []).map((control) => [control.id, control])),
    [controlsQuery.data],
  );
  const labelColors = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label) => [label.name, label.color])),
    [labelsQuery.data],
  );
  // 管理补充数据里带的门禁状态是"当前这一刻"的服务端结论；会话里的 setupRequired 是登录时
  // 的快照，可能因为刚完成 Token 验证而变旧。controls 已加载时以它为准，未加载时才退回会话值。
  const setupRequired =
    controlsQuery.data === undefined ? auth.setupRequired : controlsQuery.data.setupRequired === true;
  const configQuery = usePublicConfig();
  const overallState = configQuery.data?.overallState ?? 'ready';
  const selectedRepos = useMemo(() => repos.filter((repo) => selectedIds.has(repo.id)), [repos, selectedIds]);

  // 切换分页/搜索/标签/排序时清空选择（切换卡片/列表保留同页选择）。
  const filterSignature = [
    filters.q,
    filters.labels.join('\u0001'),
    filters.pinned ? '1' : '0',
    filters.changed ? '1' : '0',
    filters.sort,
    String(filters.page),
  ].join('\u0002');
  const lastSignatureRef = useRef(filterSignature);
  useEffect(() => {
    if (lastSignatureRef.current !== filterSignature) {
      lastSignatureRef.current = filterSignature;
      setSelectedIds(new Set());
    }
  }, [filterSignature]);

  // 自动刷新不会把新进入页面的仓库自动选中；已选 ID 离开当前页时移出选择。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const pageSet = new Set(pageIds);
      const next = new Set<string>();
      for (const id of prev) {
        if (pageSet.has(id)) {
          next.add(id);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [pageIds]);

  // 未登录（或认证未知/退出）时退出选择状态。
  useEffect(() => {
    if (!auth.isAuthenticated && ui.selectionActive) {
      ui.setSelectionActive(false);
      setSelectedIds(new Set());
    }
  }, [auth.isAuthenticated, ui.selectionActive, ui.setSelectionActive]);

  const updateFilters = useCallback(
    (patch: Partial<DashboardFilters>, options?: { replace?: boolean }): void => {
      const next: DashboardFilters = { ...filters, ...patch };
      setSearchParams(filtersToSearch(next), { replace: options?.replace ?? false });
    },
    [filters, setSearchParams],
  );

  const clearFilters = useCallback((): void => {
    setSearchParams(new URLSearchParams(), { replace: false });
  }, [setSearchParams]);

  // 页码越界自救：URL 停在高页码而结果集缩水（删除、暂停或筛选变化导致总量变小）时，
  // 列表为空且分页控件因 total 收缩而消失，用户会被留在空页上。查询成功且不在取数途中
  // 才静默回到第 1 页，避免用加载中的空快照触发跳页造成闪断。
  useEffect(() => {
    if (!reposQuery.isSuccess || reposQuery.isFetching) {
      return;
    }
    if (filters.page > 1 && repos.length === 0) {
      updateFilters({ page: 1 }, { replace: true });
    }
  }, [reposQuery.isSuccess, reposQuery.isFetching, filters.page, repos.length, updateFilters]);

  const markBusy = useCallback((ids: string[], kind: RepoActionKind, busy: boolean): void => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        const key = `${id}:${kind}`;
        if (busy) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  const buildItems = useCallback(
    (targets: PublicRepository[]): BulkActionItemInput[] => {
      const items: BulkActionItemInput[] = [];
      let missing = 0;
      for (const repo of targets) {
        const control = controlsById.get(repo.id);
        if (control === undefined) {
          missing += 1;
          continue;
        }
        items.push({ id: repo.id, editRevision: control.editRevision });
      }
      if (missing > 0) {
        push('error', `有 ${missing} 个仓库的管理状态尚未加载，未包含在本次操作中`);
      }
      return items;
    },
    [controlsById, push],
  );

  const reportBulkResults = useCallback(
    (title: string, results: BulkItemResult[], namesById: Map<string, string>): void => {
      if (results.length === 0) {
        push('error', `${title}失败：没有可执行的对象`);
        return;
      }
      const ok = results.filter((result) => result.status === 'ok').length;
      const failures = results.filter((result) => result.status !== 'ok');
      if (failures.length === 0) {
        push('success', `${title}完成：共 ${ok} 项`);
        return;
      }
      push('info', `${title}：成功 ${ok} 项，未完成 ${failures.length} 项`);
      setBulkResults({
        title: `${title}结果`,
        rows: failures.map((result) => ({
          id: result.id,
          name: namesById.get(result.id) ?? result.id,
          text: bulkStatusText(result.status),
        })),
      });
    },
    [push],
  );

  // ---- 单卡片操作 ----

  const handleCheck = useCallback(
    (repo: PublicRepository): void => {
      markBusy([repo.id], 'check', true);
      checkMutation.mutate(
        { ids: [repo.id] },
        {
          onSuccess: () => {
            push('success', `已排队检测：${repo.fullName}`);
          },
          onSettled: () => {
            markBusy([repo.id], 'check', false);
          },
        },
      );
    },
    [checkMutation.mutate, markBusy, push],
  );

  const handleTogglePause = useCallback(
    (repo: PublicRepository): void => {
      const control = controlsById.get(repo.id);
      if (control === undefined) {
        push('error', '管理状态尚未加载，请稍后重试');
        return;
      }
      const action = control.paused ? 'resume' : 'pause';
      markBusy([repo.id], 'pause', true);
      actionsMutation.mutate(
        { action, items: [{ id: repo.id, editRevision: control.editRevision }] },
        {
          onSuccess: (results) => {
            reportBulkResults(action === 'pause' ? '暂停检测' : '恢复检测', results, new Map([[repo.id, repo.fullName]]));
          },
          onSettled: () => {
            markBusy([repo.id], 'pause', false);
          },
        },
      );
    },
    [actionsMutation.mutate, controlsById, markBusy, push, reportBulkResults],
  );

  const handleTogglePin = useCallback(
    (repo: PublicRepository): void => {
      const pins = pinsQuery.data;
      if (pins === undefined) {
        push('error', '置顶顺序尚未加载，请稍后重试');
        return;
      }
      const nextIds = repo.pinned ? pins.ids.filter((id) => id !== repo.id) : [...pins.ids, repo.id];
      markBusy([repo.id], 'pin', true);
      putPinsMutation.mutate(
        { pinsRevision: pins.pinsRevision, ids: nextIds },
        {
          onSuccess: () => {
            push('success', repo.pinned ? `已取消置顶：${repo.fullName}` : `已置顶：${repo.fullName}`);
          },
          onSettled: () => {
            markBusy([repo.id], 'pin', false);
          },
        },
      );
    },
    [markBusy, pinsQuery.data, push, putPinsMutation.mutate],
  );

  const handleRemoveConfirmed = (): void => {
    const targets = removeTargets ?? [];
    if (targets.length === 0) {
      setRemoveTargets(null);
      return;
    }
    const adjustPage = (removed: number): void => {
      const remaining = total - removed;
      if (removed > 0 && remaining <= (filters.page - 1) * PAGE_SIZE) {
        updateFilters({ page: Math.max(1, Math.ceil(remaining / PAGE_SIZE)) });
      }
    };

    if (targets.length === 1) {
      const target = targets[0];
      const control = target === undefined ? undefined : controlsById.get(target.id);
      if (target === undefined) {
        setRemoveTargets(null);
        return;
      }
      if (control === undefined) {
        push('error', '管理状态尚未加载，请刷新后重试');
        return;
      }
      deleteMutation.mutate(
        { id: target.id, editRevision: control.editRevision },
        {
          onSuccess: () => {
            push('success', `已移除监控：${target.fullName}`);
            setRemoveTargets(null);
            adjustPage(1);
          },
        },
      );
      return;
    }

    const items = buildItems(repos.filter((repo) => targets.some((item) => item.id === repo.id)));
    const namesById = new Map(targets.map((target) => [target.id, target.fullName]));
    actionsMutation.mutate(
      { action: 'remove', items },
      {
        onSuccess: (results) => {
          reportBulkResults('移除监控', results, namesById);
          const ok = results.filter((result) => result.status === 'ok').length;
          setRemoveTargets(null);
          adjustPage(ok);
        },
      },
    );
  };

  // ---- 批量操作 ----

  const selectedTargets = (): PublicRepository[] => selectedRepos;

  const handleBulkCheck = (): void => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    checkMutation.mutate(
      { ids },
      {
        onSuccess: () => {
          push('success', `已排队检测 ${ids.length} 个仓库`);
        },
      },
    );
  };

  const handleBulkPauseToggle = (action: 'pause' | 'resume'): void => {
    const targets = selectedTargets();
    const items = buildItems(targets);
    if (items.length === 0) {
      return;
    }
    const namesById = new Map(targets.map((repo) => [repo.id, repo.fullName]));
    actionsMutation.mutate(
      { action, items },
      {
        onSuccess: (results) => {
          reportBulkResults(action === 'pause' ? '批量暂停' : '批量恢复', results, namesById);
        },
      },
    );
  };

  const handleBulkLabels = (labelIds: string[]): void => {
    const mode = bulkLabelMode;
    if (mode === null) {
      return;
    }
    const targets = selectedTargets();
    const items = buildItems(targets);
    // 与批量暂停一致：没有可执行对象时不提交空 items，否则服务端只会给出误导性的校验失败。
    if (items.length === 0) {
      return;
    }
    const numbers = toLabelIdNumbers(labelIds);
    const namesById = new Map(targets.map((repo) => [repo.id, repo.fullName]));
    setBulkLabelMode(null);
    actionsMutation.mutate(
      { action: mode === 'add' ? 'add_labels' : 'remove_labels', items, labelIds: numbers },
      {
        onSuccess: (results) => {
          reportBulkResults(mode === 'add' ? '批量添加标签' : '批量移除标签', results, namesById);
        },
      },
    );
  };

  const busy = useCallback((id: string, kind: RepoActionKind): boolean => busyKeys.has(`${id}:${kind}`), [busyKeys]);

  const toggleSelected = useCallback((id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const openEditMonitor = useCallback((repo: PublicRepository): void => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingRepo({ id: repo.id, name: repo.fullName });
  }, []);

  const openEditLabels = useCallback((repo: PublicRepository): void => {
    setLabelsRepo({ id: repo.id, name: repo.fullName });
  }, []);

  const openRemoveMonitor = useCallback((repo: PublicRepository): void => {
    setRemoveTargets([{ id: repo.id, fullName: repo.fullName, displayName: repo.displayName }]);
  }, []);

  // 上下文值整体 memo 化：卡片/行两个视图都消费同一份 browse/commands，
  // 每次渲染新建对象会让整页卡片跟着重渲（例如弹窗开关、选中集合变化）。
  const browse = useMemo<BrowseState>(
    () => ({
      authenticated: auth.isAuthenticated,
      setupRequired,
      controlsById,
      labelColors,
      trendRange,
      selectionActive: ui.selectionActive && auth.isAuthenticated,
      selected: selectedIds,
      pinsPending,
      toggleSelected,
    }),
    [
      auth.isAuthenticated,
      setupRequired,
      controlsById,
      labelColors,
      trendRange,
      ui.selectionActive,
      selectedIds,
      pinsPending,
      toggleSelected,
    ],
  );

  const commands = useMemo<RepoCommands>(
    () => ({
      check: handleCheck,
      togglePause: handleTogglePause,
      togglePin: handleTogglePin,
      editMonitor: openEditMonitor,
      editLabels: openEditLabels,
      removeMonitor: openRemoveMonitor,
      busy,
    }),
    [busy, handleCheck, handleTogglePause, handleTogglePin, openEditLabels, openEditMonitor, openRemoveMonitor],
  );

  const dashboardValue = useMemo(() => ({ browse, commands }), [browse, commands]);

  // 后台重取失败不能把整页列表换成错误页：TanStack Query 在保留 data 的同时会把 status 置为 error，
  // 只有"从未成功加载过"才是真正的失败，此时才有必要让列表让位给错误态。
  const queryError = reposQuery.isError && reposQuery.data === undefined ? reposQuery.error : null;
  const filtersActive = hasActiveFilters(filters);
  const pageCount = pageIds.length;
  const allSelected = pageCount > 0 && selectedIds.size === pageCount;

  return (
    <DashboardProvider value={dashboardValue}>
      <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-4 px-4 py-5 md:px-6 md:py-6 lg:px-8">
        {auth.isAuthenticated && setupRequired ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning-subtle p-3.5 text-aux2 text-text shadow-card"
          >
            <span className="flex min-w-52 flex-1 items-center gap-2.5">
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-control bg-warning/15 text-warning">
                <TriangleAlert size={16} />
              </span>
              业务尚未解锁：请在系统设置完成 Token 验证后再执行检测、暂停或编辑操作。
            </span>
            <Link
              to="/settings"
              className="shrink-0 rounded-control font-medium text-accent-strong underline-offset-2 transition-colors duration-150 hover:underline"
            >
              前往系统设置
            </Link>
          </div>
        ) : null}

        {/*
          匿名访客的通用数据状态：未初始化或数据陈旧时给出通用提示，
          只说数据状态，绝不输出 Token 原因、到期时间或配额。
        */}
        {!auth.isAuthenticated && overallState !== 'ready' ? (
          <div role="status" className="rounded-card border border-border bg-surface p-3.5 text-aux2 text-muted shadow-card">
            {overallState === 'initializing'
              ? '看板尚未完成初始化，暂时没有可展示的仓库数据。'
              : '数据暂未更新，下面显示的是最近一次成功采集的结果。'}
          </div>
        ) : null}

        {auth.status === 'unknown' && auth.sessionUnavailable ? (
          <div
            role="status"
            className="rounded-card border border-border bg-surface p-3.5 text-aux2 text-muted shadow-card"
          >
            无法确认登录状态，管理操作已暂时锁定；浏览不受影响。
          </div>
        ) : null}

        {/* 页头：标题 + 右侧结果计数与置顶顺序入口。 */}
        <header className="gr-rise flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-1">
          <div className="min-w-0">
            <h1 className="text-display font-semibold text-text">仓库看板</h1>
          </div>
          <div className="flex flex-col items-start gap-1.5 md:items-end">
            <p className="text-aux tabular-nums text-muted" role="status" aria-live="polite">
              {reposQuery.isSuccess
                ? filtersActive
                  ? `筛选结果 ${total} 个仓库`
                  : `共 ${total} 个仓库`
                : '正在加载仓库列表…'}
            </p>
            {auth.isAuthenticated && (pinsQuery.data?.ids.length ?? 0) > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => { setPinOrderOpen(true); }}>
                调整置顶顺序
              </Button>
            ) : null}
          </div>
        </header>

        {/* 粘性工具栏：滚动时悬浮于内容之上（紧贴顶栏下缘），搜索/筛选/排序/视图一站式。 */}
        <div className="sticky top-14 z-30 md:top-16">
          <FilterBar
            filters={filters}
            onChange={updateFilters}
            onClear={clearFilters}
            labels={labelsQuery.data ?? []}
            view={view}
            onViewChange={setView}
            trendRange={trendRange}
            onTrendRangeChange={setTrendRange}
          />
        </div>

        {queryError !== null ? (
          <ErrorState
            title="仓库列表加载失败"
            description={errorMessage(queryError)}
            onRetry={() => {
              void reposQuery.refetch();
            }}
            retryBusy={reposQuery.isFetching}
          />
        ) : reposQuery.isPending ? (
          <div aria-hidden="true" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="gr-card flex h-full flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <div className="gr-skeleton size-9 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="gr-skeleton h-3.5 w-2/3" />
                    <div className="gr-skeleton h-3 w-1/3" />
                  </div>
                </div>
                <div className="gr-skeleton h-3 w-full" />
                <div className="mt-auto rounded-control border border-border/70 bg-inset p-2.5">
                  <div className="gr-skeleton h-3 w-1/2" />
                  <div className="mt-2 gr-skeleton h-3 w-2/3" />
                </div>
                <div className="flex items-center justify-between border-t border-border pt-2.5">
                  <div className="gr-skeleton h-3 w-24" />
                  <div className="gr-skeleton h-6 w-28 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ) : repos.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={SearchX}
              title="无匹配结果"
              description="当前筛选条件下没有仓库，试试调整或清除筛选。"
              action={
                <Button size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="还没有监控的仓库"
              description={
                auth.isAuthenticated
                  ? '通过“添加仓库”批量导入 owner/repo 或 GitHub 仓库地址。'
                  : '登录后可以添加要监控的仓库。'
              }
              action={
                auth.isAuthenticated ? (
                  <Button size="sm" variant="primary" onClick={() => { ui.openImport(); }}>
                    添加仓库
                  </Button>
                ) : null
              }
            />
          )
        ) : view === 'cards' ? (
          <div key="cards" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {repos.map((repo, index) => (
              <RepoCard key={repo.id} repo={repo} index={index} />
            ))}
          </div>
        ) : (
          <div key="list" className="gr-card overflow-hidden shadow-card">
            {/* 列表头：与行同栅格的 overline 标签（桌面端）。 */}
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(0,1.55fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_13rem] gap-4 border-b border-border bg-inset px-4 py-2 lg:grid"
            >
              <span className="gr-label">仓库</span>
              <span className="gr-label">发布</span>
              <span className="gr-label">分支 · 热度</span>
              <span className="gr-label text-right">状态与操作</span>
            </div>
            <ul className="divide-y divide-border">
              {repos.map((repo, index) => (
                <RepoRow key={repo.id} repo={repo} index={index} />
              ))}
            </ul>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <Pagination
            page={filters.page}
            total={total}
            pageSize={PAGE_SIZE}
            onPageChange={(page) => {
              updateFilters({ page });
            }}
            busy={reposQuery.isFetching}
          />
        ) : null}

        {ui.selectionActive && auth.isAuthenticated ? (
          <SelectionToolbar
            selectedCount={selectedIds.size}
            pageCount={pageCount}
            allSelected={allSelected}
            onToggleAll={() => {
              setSelectedIds(allSelected ? new Set() : new Set(pageIds));
            }}
            onExit={() => {
              ui.setSelectionActive(false);
              setSelectedIds(new Set());
            }}
            onCheck={handleBulkCheck}
            onPause={() => {
              handleBulkPauseToggle('pause');
            }}
            onResume={() => {
              handleBulkPauseToggle('resume');
            }}
            onAddLabels={() => {
              setBulkLabelMode('add');
            }}
            onRemoveLabels={() => {
              setBulkLabelMode('remove');
            }}
            onRemove={() => {
              setRemoveTargets(
                selectedRepos.map((repo) => ({ id: repo.id, fullName: repo.fullName, displayName: repo.displayName })),
              );
            }}
            busy={actionsMutation.isPending || checkMutation.isPending}
          />
        ) : null}
      </div>

      <MonitorEditDrawer
        open={editingRepo !== null}
        onOpenChange={(next) => {
          if (!next) {
            setEditingRepo(null);
          }
        }}
        repoId={editingRepo?.id ?? null}
        repoName={editingRepo?.name ?? ''}
        returnFocusTo={openerRef}
        onSaved={() => {
          setEditingRepo(null);
        }}
      />

      {labelsRepo !== null ? (
        <RepoLabelsDialog
          key={labelsRepo.id}
          repo={labelsRepo}
          onClose={() => {
            setLabelsRepo(null);
          }}
        />
      ) : null}

      <ConfirmRemoveDialog
        open={removeTargets !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRemoveTargets(null);
          }
        }}
        targets={removeTargets ?? []}
        busy={actionsMutation.isPending || deleteMutation.isPending}
        onConfirm={handleRemoveConfirmed}
      />

      <PinOrderDialog
        open={pinOrderOpen}
        onOpenChange={setPinOrderOpen}
        pins={pinsQuery.data ?? null}
        pinsError={pinsQuery.isError}
        onSaved={() => {
          void pinsQuery.refetch();
        }}
      />

      <LabelPickerDialog
        open={bulkLabelMode !== null}
        onOpenChange={(next) => {
          if (!next) {
            setBulkLabelMode(null);
          }
        }}
        title={bulkLabelMode === 'remove' ? `从所选 ${selectedIds.size} 项移除标签` : `为所选 ${selectedIds.size} 项添加标签`}
        description={
          bulkLabelMode === 'remove'
            ? '只移除所选仓库对指定标签的引用，不删除全局标签定义，其他标签保留。'
            : '为所选仓库添加指定标签，保留其他已有标签。'
        }
        labels={adminLabelsQuery.data ?? []}
        initialSelectedIds={[]}
        confirmLabel={bulkLabelMode === 'remove' ? '移除标签' : '添加标签'}
        busy={actionsMutation.isPending}
        onConfirm={handleBulkLabels}
      />

      {bulkResults !== null ? (
        <Modal
          open
          onOpenChange={() => {
            setBulkResults(null);
          }}
          title={bulkResults.title}
          description="以下项目未完成；其他项目已按结果提交，可刷新后重试未完成项。"
          size="md"
          footer={
            <Button
              variant="primary"
              onClick={() => {
                setBulkResults(null);
              }}
            >
              知道了
            </Button>
          }
        >
          <ul className="max-h-72 overflow-y-auto rounded-control border border-border">
            {bulkResults.rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 text-aux2 last:border-b-0">
                <span className="min-w-0 truncate text-text" title={row.name}>
                  {row.name}
                </span>
                <span className="shrink-0 text-danger">{row.text}</span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </DashboardProvider>
  );
}
