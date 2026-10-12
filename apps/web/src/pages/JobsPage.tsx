import { CircleAlert, CircleStop, Eraser, Gauge, Lightbulb, Link2Off, ListTodo, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { RelativeTime } from '../components/RelativeTime';
import { RequireAuth } from '../components/AppShell';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Dialog';
import { IconButton } from '../components/ui/IconButton';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState } from '../components/ui/States';
import { useToast } from '../components/ui/Toast';
import { useCancelJob, useCheckAllRepositories, useClearJobHistory, useDeleteJob } from '../features/repos/mutations';
import { useCredentialStatus, useJobs, useSystemStatus } from '../features/repos/queries';
import type { JobSummary } from '../lib/api';
import { INTERVAL_OPTIONS, PAGE_SIZE } from '../lib/constants';
import { errorCodeMessage, errorMessage } from '../lib/errors';
import { formatExactCount } from '../lib/format';
import { cn } from '../components/ui/cn';

/**
 * 任务与诊断：
 * 排队/执行/失败/延后原因、配额面板（剩余/重置、估算和真实消耗、推荐档位）、连接与退避状态。
 * 只展示运行所需信息，不展示调度租约、数据库路径等内部实现细节。
 */

const JOB_STATE_TEXT: Record<JobSummary['state'], string> = {
  queued: '排队中',
  running: '执行中',
  retry_wait: '延后重试',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
};

// 与服务端 scheduler/queue.ts 的 JobKind 一一对应；未知 kind 回落原始值。
const JOB_KIND_TEXT: Record<string, string> = {
  metadata: '仓库基础信息',
  release: '正式版 Release',
  prerelease: '预发布窗口',
  branch: '分支 HEAD',
  branch_list: '分支列表刷新',
  token_verify: 'Token 验证',
  proxy_test: '代理测试',
};

const CREDENTIAL_STATE_TEXT: Record<string, string> = {
  missing: '未配置',
  unverified: '待验证',
  valid: '有效',
  invalid: '无效',
  expired: '已过期',
};

const CONNECTIVITY_TEXT: Record<string, string> = {
  unknown: '网络状态未知',
  reachable: 'GitHub 可达',
  unavailable: 'GitHub 不可达',
};

/** 发现模块状态；"上次导入失败"必须与"已开启"分开说明，否则只看到一个是非位。 */
const DISCOVERY_STATE_TEXT: Record<string, string> = {
  disabled: '已关闭',
  idle: '正常',
  running: '导入中',
  anomaly: '上次导入失败',
};

const DISCOVERY_ATTEMPT_TEXT: Record<string, string> = {
  idle: '成功',
  running: '进行中',
  anomaly: '失败',
};

function jobStateChip(state: JobSummary['state']): string {
  if (state === 'succeeded') {
    return 'bg-success-subtle text-success';
  }
  if (state === 'failed') {
    return 'bg-danger-subtle text-danger';
  }
  if (state === 'running') {
    return 'bg-accent-subtle text-accent-strong';
  }
  return 'bg-surface-2 text-muted';
}

interface TierRecommendation {
  tier: number | null;
  note: string;
}

/** 按档位自身的预计请求速率（服务端 throughput.plannedRequestsPerHourByTier 计算）。 */
type PlannedRequestsPerHourByTier = Record<'3' | '6' | '12' | '24', number>;

/**
 * 保守估算：推荐满足 `byTier[T] <= 60% 限额` 的最快档（3/6/12/24 依次检查）。
 * 每个档位用自己的预计速率，不能把当前速率再乘 24/tier；只建议，不自动修改档位。
 */
function recommendTier(
  plannedByTier: PlannedRequestsPerHourByTier | null,
  limit: number | null,
  averageLatencyMs: number | null,
): TierRecommendation {
  const confidence = averageLatencyMs === null ? '，缺少实际耗时数据' : '';
  if (plannedByTier === null) {
    return { tier: null, note: `暂无请求速率的估算数据${confidence}` };
  }
  if (limit === null || limit <= 0) {
    return { tier: null, note: `主要配额未知，无法估算${confidence}` };
  }
  const budget = limit * 0.6;
  for (const tier of INTERVAL_OPTIONS) {
    if (plannedByTier[String(tier) as keyof PlannedRequestsPerHourByTier] <= budget) {
      return { tier, note: `保守估算（按全部仓库套用该档位）${confidence}` };
    }
  }
  return { tier: null, note: `按当前估算即使 24 小时档也超出 60% 预算：容量不足，请减少仓库或分支${confidence}` };
}

/** 任务行的错误码文案：已知码给中文说明，内部码给领域文案，未知码给兜底文案 + 原始码。 */
function errorCodeText(code: string | null): string {
  if (code === null || code.length === 0) {
    return '—';
  }
  return errorCodeMessage(code);
}

export function JobsPage() {
  return (
    <RequireAuth>
      <JobsContent />
    </RequireAuth>
  );
}

function JobsContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPage = Number(searchParams.get('page') ?? '1');
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const jobsQuery = useJobs(page);
  const statusQuery = useSystemStatus();
  const credentialQuery = useCredentialStatus();
  const checkAllMutation = useCheckAllRepositories();
  const clearHistoryMutation = useClearJobHistory();
  const cancelJobMutation = useCancelJob();
  const deleteJobMutation = useDeleteJob();
  const { push } = useToast();
  const [clearHistoryOpen, setClearHistoryOpen] = useState(false);

  const jobs = jobsQuery.data?.data ?? [];
  const total = jobsQuery.data?.meta.total ?? 0;
  const status = statusQuery.data;
  const credential = credentialQuery.data;
  const rateLimit = credential?.rateLimit ?? null;
  const throughput = status?.throughput;
  const recommendation = recommendTier(
    throughput?.plannedRequestsPerHourByTier ?? null,
    rateLimit?.limit ?? null,
    throughput?.averageLatencyMs ?? null,
  );
  // 清空历史是写操作：门禁未就绪时服务端会拒绝，界面同步禁用并给出原因。
  const canClearHistory = credential?.state === 'valid' && total > 0 && !clearHistoryMutation.isPending;

  /** 停止未结束的任务：终态任务不能停止，只提供"移除"。 */
  const stopJob = (job: JobSummary): void => {
    cancelJobMutation.mutate(
      { id: job.id },
      {
        onSuccess: () => {
          push('success', `已停止任务：${JOB_KIND_TEXT[job.kind] ?? job.kind}`);
          void jobsQuery.refetch();
          void statusQuery.refetch();
        },
        onError: (error) => {
          push('error', errorMessage(error));
        },
      },
    );
  };

  const removeJob = (job: JobSummary): void => {
    deleteJobMutation.mutate(
      { id: job.id },
      {
        onSuccess: () => {
          push('success', '已移除任务记录');
          void jobsQuery.refetch();
          void statusQuery.refetch();
          // 删掉本页最后一条记录时回落到第 1 页：否则末页会停在空列表上（同清空历史）。
          if (jobs.length <= 1 && page > 1) {
            const next = new URLSearchParams(searchParams);
            next.delete('page');
            setSearchParams(next, { replace: true });
          }
        },
        onError: (error) => {
          push('error', errorMessage(error));
        },
      },
    );
  };

  const quotaUsedRatio =
    rateLimit !== null && rateLimit.remaining !== null && rateLimit.limit !== null && rateLimit.limit > 0
      ? Math.min(1, Math.max(0, 1 - rateLimit.remaining / rateLimit.limit))
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-5 px-4 py-5 md:px-6 md:py-7 lg:px-8">
      <header className="gr-rise flex flex-col gap-1.5">
        <h1 className="text-display font-semibold text-text">任务与诊断</h1>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-label="配额面板" className="gr-card flex flex-col gap-4 p-5 md:p-6">
          <h2 className="flex items-center gap-2.5 border-b border-border pb-4 text-[15px] font-semibold tracking-tight text-text">
            <span aria-hidden="true" className="gr-icon-tile size-8">
              <Gauge size={16} />
            </span>
            配额
          </h2>
          {rateLimit === null ? (
            <p className="text-aux2 text-muted">暂无配额观测数据；系统会在下一次成功请求后更新。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums text-text">
                  {rateLimit.remaining === null ? '—' : formatExactCount(rateLimit.remaining)}
                </span>
                <span className="text-aux2 text-muted">
                  / {rateLimit.limit === null ? '—' : formatExactCount(rateLimit.limit)} 剩余
                </span>
                <span className="rounded-full border border-border bg-inset px-2 py-0.5 font-mono text-aux text-muted">{rateLimit.resource}</span>
              </div>
              {quotaUsedRatio !== null ? (
                <div
                  role="img"
                  aria-label={`已使用约 ${Math.round(quotaUsedRatio * 100)}% 配额`}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                >
                  <div
                    className={cn('h-full rounded-full', quotaUsedRatio > 0.8 ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${Math.round(quotaUsedRatio * 100)}%` }}
                  />
                </div>
              ) : null}
              <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2.5 text-aux2 sm:grid-cols-[6rem_1fr_6rem_1fr]">
                <dt className="gr-label pt-0.5">重置时间</dt>
                <dd className="text-text">
                  {rateLimit.resetAt === null ? '—' : <RelativeTime iso={rateLimit.resetAt} future />}
                </dd>
                <dt className="gr-label pt-0.5">观测时间</dt>
                <dd className="text-text">
                  {rateLimit.observedAt === null ? '—' : <RelativeTime iso={rateLimit.observedAt} />}
                </dd>
              </dl>
            </>
          )}
          <p className="text-aux leading-relaxed text-muted">额度与 GitHub 账号共享，不是该 Token 独享。</p>

          <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-4 text-aux2 sm:grid-cols-[6rem_1fr_6rem_1fr]">
            <dt className="gr-label pt-0.5">估算消耗</dt>
            <dd className="tabular-nums text-text">
              {throughput === undefined ? '—' : `${throughput.plannedRequestsPerHour.toFixed(1)} 次/小时（计划）`}
            </dd>
            <dt className="gr-label pt-0.5">真实消耗</dt>
            <dd className="tabular-nums text-text">
              {throughput === undefined ? '—' : `${throughput.observedRequestsPerHour.toFixed(1)} 次/小时（观测）`}
            </dd>
            <dt className="gr-label pt-0.5">304 命中比例</dt>
            <dd className="tabular-nums text-text">
              {throughput?.notModifiedRatio === null || throughput === undefined
                ? '暂无数据'
                : `${Math.round(throughput.notModifiedRatio * 100)}%`}
            </dd>
            <dt className="gr-label pt-0.5">平均延迟</dt>
            <dd className="tabular-nums text-text">
              {throughput?.averageLatencyMs === null || throughput === undefined
                ? '暂无数据'
                : `${Math.round(throughput.averageLatencyMs)} ms`}
            </dd>
          </dl>

          <p className="flex items-start gap-2 rounded-control border border-border bg-inset p-3 text-aux2 leading-relaxed text-text" role="status">
            <Lightbulb size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="font-medium">推荐档位：</span>
              {recommendation.tier === null ? recommendation.note : `${recommendation.tier} 小时档。${recommendation.note}`}
            </span>
          </p>
        </section>

        <section aria-label="连接与退避状态" className="gr-card flex flex-col gap-4 p-5 md:p-6">
          <h2 className="flex items-center gap-2.5 border-b border-border pb-4 text-[15px] font-semibold tracking-tight text-text">
            <span aria-hidden="true" className="gr-icon-tile size-8">
              <ListTodo size={16} />
            </span>
            连接与退避
          </h2>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2.5 text-aux2 sm:grid-cols-[6rem_1fr_6rem_1fr]">
            <dt className="gr-label pt-0.5">Token 状态</dt>
            <dd className="text-text">
              {credential === undefined
                ? '—'
                : `${CREDENTIAL_STATE_TEXT[credential.state] ?? credential.state} · ${
                    CONNECTIVITY_TEXT[credential.connectivity] ?? credential.connectivity
                  }`}
            </dd>
            <dt className="gr-label pt-0.5">最近验证</dt>
            <dd className="text-text">
              {credential?.lastVerifiedAt == null ? '尚未验证' : <RelativeTime iso={credential.lastVerifiedAt} />}
            </dd>
            <dt className="gr-label pt-0.5">代理</dt>
            <dd className="text-text">
              {status === undefined ? '—' : status.proxy.enabled ? '已启用' : status.proxy.configured ? '已配置未启用' : '未配置'}
            </dd>
            <dt className="gr-label pt-0.5">调度器</dt>
            <dd className="text-text">{status === undefined ? '—' : status.scheduler.running ? '运行中' : '未运行'}</dd>
            <dt className="gr-label pt-0.5">下次唤醒</dt>
            <dd className="text-text">
              {status?.scheduler.nextWakeAt == null ? '—' : <RelativeTime iso={status.scheduler.nextWakeAt} future />}
            </dd>
            <dt className="gr-label pt-0.5">全局限流</dt>
            <dd className="text-text">
              {status?.scheduler.backoffUntil == null ? (
                '无退避'
              ) : (
                <span className="text-warning">
                  退避至 <RelativeTime iso={status.scheduler.backoffUntil} future />
                  {status.scheduler.backoffReason !== null ? `（${status.scheduler.backoffReason}）` : ''}
                </span>
              )}
            </dd>
            <dt className="gr-label pt-0.5">任务队列</dt>
            <dd className="text-text">
              {status === undefined ? (
                '—'
              ) : (
                <span className="inline-flex flex-wrap gap-x-2 tabular-nums">
                  <span className="whitespace-nowrap">排队 {status.jobs.queued}</span>
                  <span className="whitespace-nowrap">执行 {status.jobs.running}</span>
                  <span className="whitespace-nowrap">延后 {status.jobs.retryWaiting}</span>
                  <span className="whitespace-nowrap">容量 {status.jobs.capacity}</span>
                </span>
              )}
            </dd>
            <dt className="gr-label pt-0.5">发现模块</dt>
            <dd className="text-text">
              {status === undefined
                ? '—'
                : status.discovery.enabled
                  ? `${formatExactCount(status.discovery.itemsCount ?? 0)} 条候选 · ${
                      DISCOVERY_STATE_TEXT[status.discovery.state ?? ''] ?? status.discovery.state ?? '未知状态'
                    }`
                  : '已关闭'}
            </dd>
            <dt className="gr-label pt-0.5">发现导入</dt>
            <dd className="text-text">
              {status === undefined ? (
                '—'
              ) : (
                <span className="inline-flex flex-wrap gap-x-2">
                  <span className="whitespace-nowrap">
                    下次 {status.discovery.nextRunAt === null ? '尚未排定' : <RelativeTime iso={status.discovery.nextRunAt} future />}
                  </span>
                  {status.discovery.lastAttempt === null ? (
                    <span className="whitespace-nowrap">尚无尝试记录</span>
                  ) : (
                    <span
                      className={cn(
                        'whitespace-nowrap',
                        status.discovery.lastAttempt.state === 'anomaly' ? 'text-warning' : undefined,
                      )}
                    >
                      上次{DISCOVERY_ATTEMPT_TEXT[status.discovery.lastAttempt.state] ?? status.discovery.lastAttempt.state}
                      {status.discovery.lastAttempt.errorCode === null
                        ? ''
                        : `（${errorCodeText(status.discovery.lastAttempt.errorCode)}）`}
                      {status.discovery.lastAttempt.finishedAt === null ? (
                        ''
                      ) : (
                        <>
                          {' '}
                          <RelativeTime iso={status.discovery.lastAttempt.finishedAt} />
                        </>
                      )}
                    </span>
                  )}
                </span>
              )}
            </dd>
            {/* 趋势报告只落库成功结果：只显示"最新报告日期"会让抓取一直失败看起来像上游没更新。 */}
            <dt className="gr-label pt-0.5">每日趋势</dt>
            <dd className="text-text">
              {status === undefined ? (
                '—'
              ) : (
                <span className="inline-flex flex-wrap gap-x-2">
                  <span className="whitespace-nowrap">
                    {status.trends.daysCount === 0
                      ? '尚无报告'
                      : `${formatExactCount(status.trends.daysCount)} 天 · 最新 ${status.trends.latestDay ?? '—'}`}
                  </span>
                  <span className="whitespace-nowrap">
                    下次 {status.trends.nextRunAt === null ? '尚未排定' : <RelativeTime iso={status.trends.nextRunAt} future />}
                  </span>
                  {status.trends.lastAttemptAt === null ? (
                    <span className="whitespace-nowrap">尚无尝试记录</span>
                  ) : (
                    <span
                      className={cn('whitespace-nowrap', status.trends.state === 'anomaly' ? 'text-warning' : undefined)}
                    >
                      {/* 判定用「最近一次真实失败」：一次"清单未变"的跳过不能把持续失败显示成成功。 */}
                      {status.trends.state === 'anomaly'
                        ? `最近失败${status.trends.lastErrorCode === null ? '' : `（${errorCodeText(status.trends.lastErrorCode)}）`}`
                        : '最近无失败'}
                      {status.trends.lastFailureAt !== null ? (
                        <>
                          {' '}
                          <RelativeTime iso={status.trends.lastFailureAt} />
                        </>
                      ) : (
                        <>
                          {' '}
                          <RelativeTime iso={status.trends.lastAttemptAt} />
                        </>
                      )}
                    </span>
                  )}
                </span>
              )}
            </dd>
          </dl>
          {credential !== undefined && credential.state !== 'valid' ? (
            <p className="flex items-center gap-2 rounded-control border border-warning/40 bg-warning-subtle p-3 text-aux2 text-text">
              <Link2Off size={15} aria-hidden="true" className="shrink-0" />
              Token 未就绪，业务采集已暂停；请先在系统设置完成验证。
            </p>
          ) : null}
        </section>
      </div>

      <section aria-label="任务列表" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight text-text">任务列表</h2>
          <div className="flex flex-wrap items-center gap-2">
            {credential?.state === 'valid' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={checkAllMutation.isPending}
                aria-busy={checkAllMutation.isPending}
                onClick={() => {
                  checkAllMutation.mutate(undefined, {
                    onSuccess: (accepted) => {
                      push('success', accepted.reused ? '已有检测任务在执行，已合并' : '已创建检测任务（全部启用仓库）');
                    },
                  });
                }}
              >
                检测全部启用仓库
              </Button>
            ) : (
              <span className="text-aux text-muted">Token 未就绪，无法发起检测</span>
            )}
            <IconButton
              icon={Eraser}
              label="清空历史"
              tooltip="清空任务历史（只删除已结束的任务）"
              disabled={!canClearHistory}
              onClick={() => {
                setClearHistoryOpen(true);
              }}
            />
          </div>
        </div>
        {jobsQuery.isError ? (
          <ErrorState
            title="任务列表加载失败"
            description={errorMessage(jobsQuery.error)}
            onRetry={() => {
              void jobsQuery.refetch();
            }}
            retryBusy={jobsQuery.isFetching}
          />
        ) : jobsQuery.isPending ? (
          <div aria-hidden="true" className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="gr-card flex items-center gap-3 p-3.5">
                <div className="gr-skeleton h-5 w-16 rounded-full" />
                <div className="gr-skeleton h-3.5 w-40" />
                <div className="gr-skeleton ml-auto h-3 w-24" />
              </div>
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState icon={CircleAlert} title="暂无任务" description="手动检测或定时任务开始后会在此显示。" compact />
        ) : (
          <ul className="gr-card divide-y divide-border shadow-card">
            {jobs.map((job) => (
              <li key={job.id} className="gr-rise flex flex-col gap-1.5 p-3.5 transition-[background-color] duration-150 hover:bg-inset md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-aux2">
                  <span className={cn('gr-chip', jobStateChip(job.state))}>{JOB_STATE_TEXT[job.state]}</span>
                  <span className="font-medium text-text">{JOB_KIND_TEXT[job.kind] ?? job.kind}</span>
                  <span className="min-w-0 max-w-64 truncate font-mono text-aux text-muted" title={job.repoName ?? undefined}>
                    {job.repoName ?? '（未关联仓库）'}
                  </span>
                  {/* attempt 是已执行的尝试次数（首次领取即为 1）；只有重试过才值得展示。 */}
                  {job.attempt > 1 ? <span className="text-aux text-muted">第 {job.attempt} 次尝试</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-aux text-muted">
                  <span>
                    受理 <RelativeTime iso={job.acceptedAt} />
                  </span>
                  {job.state === 'retry_wait' && job.dueAt !== null ? (
                    <span className="text-warning">
                      延后至 <RelativeTime iso={job.dueAt} future />
                      {job.errorCode !== null ? `（${errorCodeText(job.errorCode)}）` : ''}
                    </span>
                  ) : job.state === 'queued' && job.dueAt !== null ? (
                    <span>
                      到期 <RelativeTime iso={job.dueAt} future />
                    </span>
                  ) : null}
                  {job.finishedAt !== null ? (
                    <span>
                      完成 <RelativeTime iso={job.finishedAt} />
                    </span>
                  ) : null}
                  {job.state === 'failed' && job.errorCode !== null ? (
                    <span className="text-danger">{errorCodeText(job.errorCode)}</span>
                  ) : null}
                  {/* 行内动作：未结束的任务可以停止（不再按重试阶梯反复尝试），已结束的可移除记录。 */}
                  <span className="flex items-center">
                    {job.state === 'queued' || job.state === 'running' || job.state === 'retry_wait' ? (
                      <IconButton
                        icon={CircleStop}
                        label={`停止任务：${JOB_KIND_TEXT[job.kind] ?? job.kind}`}
                        tooltip="停止任务（不再重试）"
                        disabled={cancelJobMutation.isPending || credential?.state !== 'valid'}
                        onClick={() => {
                          stopJob(job);
                        }}
                      />
                    ) : (
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        label={`移除任务记录：${JOB_KIND_TEXT[job.kind] ?? job.kind}`}
                        tooltip="移除这条任务记录"
                        disabled={deleteJobMutation.isPending || credential?.state !== 'valid'}
                        onClick={() => {
                          removeJob(job);
                        }}
                      />
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {total > PAGE_SIZE ? (
          <Pagination
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
            onPageChange={(nextPage) => {
              const next = new URLSearchParams(searchParams);
              if (nextPage > 1) {
                next.set('page', String(nextPage));
              } else {
                next.delete('page');
              }
              setSearchParams(next, { replace: false });
            }}
            busy={jobsQuery.isFetching}
          />
        ) : null}
      </section>

      <Modal
        open={clearHistoryOpen}
        onOpenChange={setClearHistoryOpen}
        title="清空任务历史"
        description="只删除已结束（成功/失败/取消/跳过）的任务记录；排队、执行中与延后重试的任务保留。"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setClearHistoryOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              disabled={clearHistoryMutation.isPending}
              aria-busy={clearHistoryMutation.isPending}
              onClick={() => {
                clearHistoryMutation.mutate(undefined, {
                  onSuccess: () => {
                    setClearHistoryOpen(false);
                    if (page > 1) {
                      const next = new URLSearchParams(searchParams);
                      next.delete('page');
                      setSearchParams(next, { replace: true });
                    }
                    void jobsQuery.refetch();
                    push('success', '已清空已结束的任务');
                  },
                  onError: (error) => {
                    setClearHistoryOpen(false);
                    push('error', errorMessage(error));
                  },
                });
              }}
            >
              清空历史
            </Button>
          </>
        }
      >
        <p className="text-aux2 leading-relaxed text-text">清空后无法恢复；需要保留排查线索时请先截图或导出。</p>
      </Modal>
    </div>
  );
}
