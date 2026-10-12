import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { PAGE_SIZE_MAX } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { jobs, monitorStreams, repositories, settings } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { JobQueue } from '../scheduler/queue.js';
import { solidifyGroupItemsByIds } from '../scheduler/queue.js';
import { ensureStreams } from '../scheduler/streams.js';

/**
 * 管理接口的补充查询与任务创建。
 *
 * 这些操作面向 HTTP 边界，因此放在 api 侧：领域模块只负责仓库自身规则，
 * 这里负责把"当前页补充数据""任务列表""全局设置"等读/写需求映射成受控语句。
 */

export interface JobSummaryView {
  readonly id: string;
  readonly kind: string;
  readonly queueClass: 'control' | 'initialization' | 'periodic' | 'manual';
  readonly origin: 'scheduler' | 'manual' | 'import' | 'control' | 'recovery';
  readonly state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  readonly repoId: string | null;
  readonly repoName: string | null;
  readonly attempt: number;
  readonly dueAt: string | null;
  readonly acceptedAt: string;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function listJobs(
  db: Database,
  query: { state: string; page: number; pageSize: number },
): { items: JobSummaryView[]; total: number } {
  const pageSize = Math.min(Math.max(query.pageSize, 1), PAGE_SIZE_MAX);
  const page = Math.max(query.page, 1);
  const stateFilter =
    query.state === 'all'
      ? undefined
      : query.state === 'queued'
        ? ['queued', 'retry_wait']
        : [query.state];

  const where =
    stateFilter === undefined
      ? undefined
      : inArray(jobs.state, stateFilter as ('queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed')[]);

  const totalRow = db
    .select({ count: sql<number>`COUNT(*) AS count` })
    .from(jobs)
    .where(where)
    .get();

  const rows = db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      queueClass: jobs.queueClass,
      origin: jobs.origin,
      state: jobs.state,
      attempt: jobs.attempt,
      dueAt: jobs.dueAt,
      acceptedAt: jobs.acceptedAt,
      finishedAt: jobs.finishedAt,
      errorCode: jobs.errorCode,
      streamId: jobs.streamId,
    })
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.acceptedAt), desc(jobs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const streamIds = rows.map((row) => row.streamId).filter((id): id is number => id !== null);
  const repoByStream = new Map<number, { id: number; name: string }>();
  if (streamIds.length > 0) {
    const streamRows = db
      .select({ id: monitorStreams.id, repoId: monitorStreams.repoId, name: repositories.canonicalName })
      .from(monitorStreams)
      .innerJoin(repositories, eq(repositories.id, monitorStreams.repoId))
      .where(inArray(monitorStreams.id, streamIds))
      .all();
    for (const row of streamRows) {
      repoByStream.set(row.id, { id: row.repoId, name: row.name });
    }
  }

  return {
    items: rows.map((row) => {
      const repo = row.streamId === null ? undefined : repoByStream.get(row.streamId);
      return {
        id: String(row.id),
        kind: row.kind,
        queueClass: row.queueClass as JobSummaryView['queueClass'],
        origin: row.origin as JobSummaryView['origin'],
        state: row.state as JobSummaryView['state'],
        repoId: repo === undefined ? null : `repo_${String(repo.id)}`,
        repoName: repo?.name ?? null,
        attempt: row.attempt,
        dueAt: iso(row.dueAt),
        acceptedAt: iso(row.acceptedAt) ?? new Date(0).toISOString(),
        finishedAt: iso(row.finishedAt),
        errorCode: row.errorCode,
      };
    }),
    total: totalRow?.count ?? 0,
  };
}

/**
 * 全局设置：档位使用 settings.revision。
 * 发现模块是默认能力，不接受开关字段。
 */
export function updateSettings(
  db: Database,
  now: number,
  patch: { revision: number; defaultIntervalHours?: number },
): void {
  // 版本比较与写入在同一事务内完成（变化在事务中比较，不先查后无条件更新）。
  const commit = db.$client.transaction(() => {
    const current = db.select().from(settings).where(eq(settings.id, 1)).get();
    if (current === undefined) throw new AppError('SERVICE_UNAVAILABLE', '全局设置未初始化');
    if (current.revision !== patch.revision) {
      throw new AppError('REVISION_CONFLICT', '全局设置已被其他操作修改');
    }
    const intervalChanged =
      patch.defaultIntervalHours !== undefined && patch.defaultIntervalHours !== current.defaultIntervalHours;

    db.update(settings)
      .set({
        ...(patch.defaultIntervalHours === undefined ? {} : { defaultIntervalHours: patch.defaultIntervalHours }),
        revision: current.revision + 1,
      })
      .where(eq(settings.id, 1))
      .run();
    if (intervalChanged) {
      rescheduleGlobalInheritors(db, now, patch.defaultIntervalHours as number);
    }
  });
  commit();
}

/**
 * 全局档位变化后重排**继承全局**的采集流：
 * - 单仓覆盖（`interval_hours` 非空）不受影响；
 * - 延长周期时原计划必然落在新周期之内，保留原计划即可，不需要重排；
 * - 已过期的流与缩短周期后落在新周期之外的原计划，只安排一次确定性错峰追赶
 *   （按 phase_seed 推出相位），不补跑所有错过的周期。
 */
export function rescheduleGlobalInheritors(db: Database, now: number, intervalHours: number): number {
  const periodMs = intervalHours * 60 * 60 * 1000;
  const rows = db.$client
    .prepare(
      `SELECT s.id AS id, s.phase_seed AS phase_seed, s.next_due_at AS next_due_at
         FROM monitor_streams s
         JOIN repositories r ON r.id = s.repo_id
        WHERE r.interval_hours IS NULL AND s.next_due_at IS NOT NULL`,
    )
    .all() as { id: number; phase_seed: number; next_due_at: number }[];

  const update = db.$client.prepare('UPDATE monitor_streams SET next_due_at = ? WHERE id = ?');
  for (const row of rows) {
    const offset = (row.phase_seed % 900) * 1000;
    let next: number;
    if (row.next_due_at <= now) {
      // 已经过期：只安排一次错峰追赶，不补跑所有错过的周期。
      next = now + offset;
    } else if (row.next_due_at - now > periodMs) {
      // 缩短周期后原相位落在新周期之外：落到新周期内的确定性错峰点。
      next = now + offset;
    } else {
      next = row.next_due_at;
    }
    update.run(next, row.id);
  }
  return rows.length;
}

/**
 * 清空任务历史（任务列表）。
 *
 * 只删除终态任务（成功/失败/取消/跳过）；排队、执行中与延后重试的任务保留，
 * 否则会掩盖仍在进行的采集。
 *
 * 导入批次的逐项进度是靠 `LEFT JOIN jobs` 读终态的（`job_group_items.status` 在成功路径上
 * 停在 'queued'），直接删任务会让已完成项重新显示"排队中"、批次永远不结束。
 * 因此删除前必须先把结论固化进批次项（成功/skipped/失败 + 错误码）并解除引用；
 * 这与保留期清理、单条移除共用 `solidifyGroupItems`，三处语义必须一致。
 * 未结束任务仍被引用时不解除——它们本身不会被删除。
 */
export function clearJobHistory(db: Database): number {
  const commit = db.$client.transaction(() => {
    // 结论先固化进批次项并解除引用，再删除任务：进度照常可读，历史真正清空。
    // 固化与删除针对同一个 id 集合（在同一事务内物化），不会出现"固化一批、删另一批"。
    const ids = (
      db.$client
        .prepare("SELECT id FROM jobs WHERE state IN ('succeeded', 'failed', 'cancelled', 'skipped')")
        .all() as { id: number }[]
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    solidifyGroupItemsByIds(db.$client, ids);
    const placeholders = ids.map(() => '?').join(', ');
    return Number(db.$client.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids).changes);
  });
  return commit();
}

const ACTIVE_JOB_STATES = ['queued', 'running', 'retry_wait'] as const;

/**
 * 停止单个任务（任务列表）：误发起的检测或一直延后重试的任务必须能就地终止，
 * 不必等它把重试阶梯走完。
 *
 * 语义与"领取-提交"一致：
 * - `attempt_token` 置空：在途响应回来时 `isCurrentAttempt` 不再成立，也不会改写任何业务状态；
 * - 状态直接落到 `cancelled`（终态），调度器不会再领取，去重键随之释放；
 * - 绑定的候选操作同步取消，避免系统设置里的操作卡停在"等待中"。
 *
 * 终态任务不需要停止：返回 false，由调用方决定文案（幂等，不报错）。
 */
export function cancelJob(
  db: Database,
  credentials: { cancelOperation(operationId: number): void },
  jobId: number,
  now: number,
): boolean {
  const row = db
    .select({ state: jobs.state, operationId: jobs.operationId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (row === undefined) throw new AppError('NOT_FOUND', '任务不存在');
  if (!ACTIVE_JOB_STATES.includes(row.state as (typeof ACTIVE_JOB_STATES)[number])) return false;

  const changed = db
    .update(jobs)
    .set({ state: 'cancelled', finishedAt: now, leaseOwner: null, leaseUntil: null, attemptToken: null })
    .where(and(eq(jobs.id, jobId), inArray(jobs.state, [...ACTIVE_JOB_STATES])))
    .run().changes;
  if (changed > 0 && row.operationId !== null) {
    credentials.cancelOperation(row.operationId);
  }
  return changed > 0;
}

/**
 * 移除单条任务记录（任务列表）。
 *
 * 只允许移除终态任务：未结束的任务必须先停止（否则历史被删掉、任务仍在跑，
 * 界面与真实状态脱节）。
 * 导入批次引用着的任务同样先把结论固化到批次项、解除引用再删除——
 * 与清空历史同一套处理，否则这些任务在界面上永远删不掉。
 */
export function deleteJob(db: Database, jobId: number): void {
  const commit = db.$client.transaction(() => {
    // 状态校验放在事务内：事务外读到的快照可能已被 cancelJob 改写。
    const row = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, jobId)).get();
    if (row === undefined) throw new AppError('NOT_FOUND', '任务不存在');
    if (ACTIVE_JOB_STATES.includes(row.state as (typeof ACTIVE_JOB_STATES)[number])) {
      throw new AppError('VALIDATION_FAILED', '任务尚未结束，请先停止再移除');
    }
    // 与清空历史、保留期清理共用同一套"固化结论 + 解除引用"实现，避免多处语义分叉。
    solidifyGroupItemsByIds(db.$client, [jobId]);
    db.delete(jobs).where(eq(jobs.id, jobId)).run();
  });
  commit();
}

/** 显式重新验证活动 PAT：创建控制任务，不要求管理员在线也不需要请求内等待。 */
export function requestTokenVerification(queue: JobQueue, now: number): number {
  const { jobId } = queue.enqueue({
    kind: 'token_verify',
    queueClass: 'control',
    origin: 'manual',
    dueAt: now,
    dedupeKey: 'credential:verify',
  });
  return jobId;
}

/**
 * 候选操作的执行接线：提交候选 PAT/代理只写 pending_operations，
 * 必须同时入队引用该 operation 的控制任务，验证才会真的发生。
 * dedupeKey 绑定 operation id：同一操作重复提交不会产生第二个任务；
 * 旧候选被 #cancelStaleOperations 过期后，其遗留任务执行时会因操作非 pending
 * 而安静结束（executeControlJob 已处理该分支）。
 */
export function enqueueControlOperation(
  queue: JobQueue,
  kind: 'token_verify' | 'proxy_test',
  operationId: number,
  now: number,
): number {
  const { jobId } = queue.enqueue({
    kind,
    queueClass: 'control',
    origin: 'manual',
    dueAt: now,
    operationId,
    dedupeKey: `operation:${String(operationId)}`,
  });
  return jobId;
}

/** 显式刷新分支缓存：GET 与浏览器预取绝不触发，只有这个写接口会创建任务。 */
export function requestBranchRefresh(
  db: Database,
  queue: JobQueue,
  repoId: number,
  now: number,
): { jobId: number; reused: boolean } {
  const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) throw new AppError('NOT_FOUND', '仓库不存在');
  if (repo.verificationState !== 'verified') {
    throw new AppError('VALIDATION_FAILED', '仓库尚未完成验证，无法刷新分支缓存');
  }
  ensureStreams(db, repoId, now);
  const result = queue.enqueue({
    kind: 'branch_list',
    queueClass: 'manual',
    origin: 'manual',
    dueAt: now,
    dedupeKey: `branch-list:${String(repoId)}`,
    // 分支列表任务不属于任何采集流，仓库归属放在 continuation 里供执行器读取。
    continuationJson: JSON.stringify({ repoId }),
  });
  return { jobId: result.jobId, reused: result.reused };
}
