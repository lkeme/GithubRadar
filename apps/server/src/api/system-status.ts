import type { SystemStatusResponse } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { readDatabasePragmas, type SqliteDatabase } from '../db/open.js';
import type { CredentialService } from '../credentials/service.js';
import type { BudgetState } from '../scheduler/budget.js';
import type { JobQueue } from '../scheduler/queue.js';
import { HOUR_MS } from '../scheduler/planner.js';
import { isoUtc } from '../domain/public.js';
import type { DiscoveryStatus } from './public-routes.js';

/**
 * 后台运行状态。
 *
 * 只暴露运行必需维度：启用/初始化/正常/部分失败/陈旧数量、每档任务数、
 * 最老到期任务、预计请求速率、主要配额、304 比例、全局退避截止时间、数据库大小。
 * 不含凭证密文、Cookie、代理密码或上游响应正文。
 */

export interface SystemStatusDeps {
  readonly db: Database;
  readonly client: SqliteDatabase;
  readonly credentials: CredentialService;
  readonly queue: JobQueue;
  readonly budgetState: BudgetState;
  readonly schemaVersion: string | null;
  readonly databasePath: string;
  readonly now: number;
  /** 计划速率由本模块按仓库/档位自行统计，这里只需要观测值。 */
  readonly throughput: { observedRequestsPerHour: number; notModifiedRatio: number | null; averageLatencyMs: number | null };
  readonly schedulerRunning: boolean;
  readonly nextWakeAt: number | null;
  readonly discovery: DiscoveryStatus | null;
  readonly trends: {
    state: 'idle' | 'anomaly';
    lastErrorCode: string | null;
    lastAttemptAt: number | null;
    lastFailureAt: number | null;
    nextRunAt: number | null;
    latestDay: string | null;
    daysCount: number;
    stale: boolean;
  } | null;
}

export function buildSystemStatus(deps: SystemStatusDeps): SystemStatusResponse['data'] {
  const pragmas = readDatabasePragmas(deps.client);

  const repoCounts = deps.client
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN verification_state = 'verified' THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN verification_state = 'pending' THEN 1 ELSE 0 END) AS initializing,
         SUM(CASE WHEN enabled = 0 AND verification_state = 'verified' THEN 1 ELSE 0 END) AS paused
       FROM repositories`,
    )
    .get() as { total: number | null; verified: number | null; initializing: number | null; paused: number | null };

  const streamCounts = deps.client
    .prepare(
      `SELECT
         SUM(CASE WHEN last_error_code IS NULL THEN 1 ELSE 0 END) AS healthy,
         SUM(CASE WHEN last_error_code IS NOT NULL AND last_success_at IS NOT NULL THEN 1 ELSE 0 END) AS partial,
         SUM(CASE WHEN last_error_code IS NOT NULL AND last_success_at IS NULL THEN 1 ELSE 0 END) AS errored
       FROM monitor_streams`,
    )
    .get() as { healthy: number | null; partial: number | null; errored: number | null };

  const streamErrors = deps.client
    .prepare(
      `SELECT COUNT(*) AS count FROM monitor_streams
        WHERE next_due_at IS NOT NULL AND next_due_at < ? AND last_error_code IS NULL
          AND last_success_at IS NOT NULL AND last_success_at < ?`,
    )
    .get(deps.now, deps.now - 2 * 24 * HOUR_MS) as { count: number | null };

  const sizeRow = deps.client
    .prepare('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()')
    .get() as { size: number | null } | undefined;

  const counts = deps.queue.counts();
  const credential = deps.credentials.status();
  const proxy = deps.credentials.readProxy();

  const lease = deps.client
    .prepare('SELECT owner_id, lease_until FROM runtime_lock WHERE id = 1')
    .get() as { owner_id: string | null; lease_until: number | null } | undefined;

  // 预计请求速率：按每仓每轮请求数（基础 + 分支 + 发布）除以所属档位累加。
  const planned = deps.client
    .prepare(
      `SELECT COALESCE(SUM(
                 (1
                  + (SELECT COUNT(*) FROM tracked_branches b WHERE b.repo_id = r.id AND b.enabled = 1)
                  + CASE WHEN r.release_enabled = 1 THEN 1 ELSE 0 END
                  + CASE WHEN r.release_enabled = 1 AND r.include_prereleases = 1 THEN 1 ELSE 0 END
                 ) * 1.0 / COALESCE(r.interval_hours, s.default_interval_hours)
               ), 0) AS per_hour
         FROM repositories r, settings s
        WHERE s.id = 1 AND r.enabled = 1 AND r.blocked_reason IS NULL AND r.verification_state = 'verified'`,
    )
    .get() as { per_hour: number } | undefined;

  // 分档估算：假设全局默认档位为 T 时的预计请求速率。
  // 单仓覆盖不受影响（COALESCE 优先取覆盖值），继承全局的仓库按 T 计。
  // 推荐档位必须用对应档位自身的速率与预算比较，不能把当前速率再乘 24/tier。
  const plannedByTier = deps.client
    .prepare(
      `SELECT
         COALESCE(SUM((1
           + (SELECT COUNT(*) FROM tracked_branches b WHERE b.repo_id = r.id AND b.enabled = 1)
           + CASE WHEN r.release_enabled = 1 THEN 1 ELSE 0 END
           + CASE WHEN r.release_enabled = 1 AND r.include_prereleases = 1 THEN 1 ELSE 0 END
          ) * 1.0 / COALESCE(r.interval_hours, 3)), 0) AS tier3,
         COALESCE(SUM((1
           + (SELECT COUNT(*) FROM tracked_branches b WHERE b.repo_id = r.id AND b.enabled = 1)
           + CASE WHEN r.release_enabled = 1 THEN 1 ELSE 0 END
           + CASE WHEN r.release_enabled = 1 AND r.include_prereleases = 1 THEN 1 ELSE 0 END
          ) * 1.0 / COALESCE(r.interval_hours, 6)), 0) AS tier6,
         COALESCE(SUM((1
           + (SELECT COUNT(*) FROM tracked_branches b WHERE b.repo_id = r.id AND b.enabled = 1)
           + CASE WHEN r.release_enabled = 1 THEN 1 ELSE 0 END
           + CASE WHEN r.release_enabled = 1 AND r.include_prereleases = 1 THEN 1 ELSE 0 END
          ) * 1.0 / COALESCE(r.interval_hours, 12)), 0) AS tier12,
         COALESCE(SUM((1
           + (SELECT COUNT(*) FROM tracked_branches b WHERE b.repo_id = r.id AND b.enabled = 1)
           + CASE WHEN r.release_enabled = 1 THEN 1 ELSE 0 END
           + CASE WHEN r.release_enabled = 1 AND r.include_prereleases = 1 THEN 1 ELSE 0 END
          ) * 1.0 / COALESCE(r.interval_hours, 24)), 0) AS tier24
       FROM repositories r
       WHERE r.enabled = 1 AND r.blocked_reason IS NULL AND r.verification_state = 'verified'`,
    )
    .get() as { tier3: number; tier6: number; tier12: number; tier24: number } | undefined;

  return {
    database: {
      path: deps.databasePath,
      schemaVersion: deps.schemaVersion,
      sizeBytes: sizeRow?.size ?? 0,
      journalMode: pragmas.journalMode,
      foreignKeys: pragmas.foreignKeys,
    },
    scheduler: {
      running: deps.schedulerRunning,
      leaseOwner: lease?.owner_id ?? null,
      leaseUntil: isoUtc(lease?.lease_until ?? null),
      nextWakeAt: isoUtc(deps.nextWakeAt),
      globalNextRequestAt: isoUtc(deps.budgetState.nextRequestAt),
      backoffUntil: deps.budgetState.backoffUntil === 0 ? null : isoUtc(deps.budgetState.backoffUntil),
      backoffReason: deps.budgetState.backoffUntil > deps.now ? 'RATE_LIMITED' : null,
    },
    repositories: {
      total: repoCounts.total ?? 0,
      verified: repoCounts.verified ?? 0,
      initializing: repoCounts.initializing ?? 0,
      healthy: streamCounts.healthy ?? 0,
      partial: streamCounts.partial ?? 0,
      stale: streamErrors.count ?? 0,
      error: streamCounts.errored ?? 0,
      paused: repoCounts.paused ?? 0,
    },
    jobs: {
      queued: counts.queued,
      running: counts.running,
      retryWaiting: counts.retryWaiting,
      oldestDueAt: isoUtc(counts.oldestDueAt),
      capacity: 100_000,
    },
    throughput: {
      plannedRequestsPerHour: Math.round((planned?.per_hour ?? 0) * 100) / 100,
      plannedRequestsPerHourByTier: {
        '3': Math.round((plannedByTier?.tier3 ?? 0) * 100) / 100,
        '6': Math.round((plannedByTier?.tier6 ?? 0) * 100) / 100,
        '12': Math.round((plannedByTier?.tier12 ?? 0) * 100) / 100,
        '24': Math.round((plannedByTier?.tier24 ?? 0) * 100) / 100,
      },
      observedRequestsPerHour: deps.throughput.observedRequestsPerHour,
      notModifiedRatio: deps.throughput.notModifiedRatio,
      averageLatencyMs: deps.throughput.averageLatencyMs,
    },
    credential: {
      state: credential.effectiveState,
      connectivity: credential.connectivity,
      lastErrorCode: credential.lastErrorCode,
    },
    proxy: { enabled: proxy.enabled, configured: proxy.configured },
    discovery: {
      enabled: deps.discovery?.enabled ?? false,
      state: deps.discovery?.state ?? 'disabled',
      lastSuccessAt: isoUtc(deps.discovery?.lastSuccessAt ?? null),
      itemsCount: deps.discovery?.itemsCount ?? null,
      nextRunAt: isoUtc(deps.discovery?.nextRunAt ?? null),
      // 只有活跃代次时看不出“最近的导入一直在失败”，因此把最近一次尝试一并透出。
      lastAttempt:
        deps.discovery?.lastAttempt == null
          ? null
          : {
              state: deps.discovery.lastAttempt.state,
              errorCode: deps.discovery.lastAttempt.errorCode,
              finishedAt: isoUtc(deps.discovery.lastAttempt.finishedAt),
            },
    },
    trends: {
      state: deps.trends?.state ?? 'idle',
      lastErrorCode: deps.trends?.lastErrorCode ?? null,
      lastAttemptAt: isoUtc(deps.trends?.lastAttemptAt ?? null),
      lastFailureAt: isoUtc(deps.trends?.lastFailureAt ?? null),
      nextRunAt: isoUtc(deps.trends?.nextRunAt ?? null),
      latestDay: deps.trends?.latestDay ?? null,
      daysCount: deps.trends?.daysCount ?? 0,
      stale: deps.trends?.stale ?? true,
    },
  };
}
