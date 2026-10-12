import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { JOB_LEASE_MS } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { MANUAL_FAIRNESS_RATIO, MAX_JOB_RETRIES, RETRY_BACKOFF_MS } from './constants.js';

/**
 * 任务队列与租约。
 *
 * - 任务来源、受理时间、暂停许可与资源集合都由服务器产生，客户端不能直接赋值。
 * - 租约默认 120 秒、每 30 秒续期；每次提交比较租约所有者与 attempt_token，
 *   周期任务在派发前额外比对入队时的 config_revision（runner 的 STREAM_CONFIG_CHANGED
 *   收口），租约过期后的旧回调不能覆盖新尝试。
 * - 周期任务排除暂停仓库；显式单次检测不受用户暂停限制，但仍受系统 blocked_reason、
 *   失效凭证与全局限流约束。
 */

export type JobKind =
  | 'metadata'
  | 'release'
  | 'prerelease'
  | 'branch'
  | 'branch_list'
  | 'token_verify'
  | 'proxy_test';

export type QueueClass = 'control' | 'initialization' | 'periodic' | 'manual';
export type JobOrigin = 'scheduler' | 'manual' | 'import' | 'control' | 'recovery';
export type JobState = 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface EnqueueSpec {
  readonly kind: JobKind;
  readonly queueClass: QueueClass;
  readonly origin: JobOrigin;
  readonly dueAt: number;
  readonly streamId?: number | null;
  readonly operationId?: number | null;
  readonly dedupeKey?: string | null;
  readonly acceptedAuthVersion?: number | null;
  readonly pauseOverride?: boolean;
  readonly configRevision?: number | null;
  readonly continuationJson?: string | null;
}

export interface JobRow {
  readonly id: number;
  readonly streamId: number | null;
  readonly operationId: number | null;
  readonly kind: JobKind;
  readonly queueClass: QueueClass;
  readonly origin: JobOrigin;
  readonly state: JobState;
  readonly attempt: number;
  readonly attemptToken: string | null;
  readonly configRevision: number | null;
  readonly continuationJson: string | null;
  readonly pauseOverride: boolean;
  readonly acceptedAuthVersion: number | null;
  readonly repoId: number | null;
  readonly branchId: number | null;
  /** 去重键；用于识别“候选操作任务”——操作行被级联删除后 operation_id 会变 NULL。 */
  readonly dedupeKey: string | null;
}

export interface JobCounts {
  readonly queued: number;
  readonly running: number;
  readonly retryWaiting: number;
  readonly oldestDueAt: number | null;
}

interface CandidateRow {
  id: number;
  stream_id: number | null;
  operation_id: number | null;
  kind: JobKind;
  queue_class: QueueClass;
  origin: JobOrigin;
  state: JobState;
  attempt: number;
  attempt_token: string | null;
  config_revision: number | null;
  continuation_json: string | null;
  pause_override: number;
  accepted_auth_version: number | null;
  repo_id: number | null;
  branch_id: number | null;
  dedupe_key: string | null;
}

export class JobQueue {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #leaseOwner: string;
  readonly #leaseMs: number;
  #regularSinceManual = 0;

  constructor(db: Database, leaseOwner: string, now: () => number = Date.now, leaseMs = JOB_LEASE_MS) {
    this.#db = db;
    this.#leaseOwner = leaseOwner;
    this.#now = now;
    this.#leaseMs = leaseMs;
  }

  get leaseOwner(): string {
    return this.#leaseOwner;
  }

  /**
   * 入队。相同 dedupe_key 已处于未结束状态时复用现有任务，
   * 但若本次带有更强的意图（显式单次检测/暂停许可）则把该意图合并进现有任务。
   */
  enqueue(spec: EnqueueSpec): { jobId: number; reused: boolean } {
    const now = this.#now();
    if (spec.dedupeKey !== null && spec.dedupeKey !== undefined) {
      const existing = this.#db
        .select({ id: jobs.id, queueClass: jobs.queueClass, origin: jobs.origin })
        .from(jobs)
        .where(and(eq(jobs.dedupeKey, spec.dedupeKey), inArray(jobs.state, ['queued', 'running', 'retry_wait'])))
        .get();
      if (existing !== undefined) {
        if (spec.origin === 'manual' || spec.pauseOverride === true) {
          this.#db
            .update(jobs)
            .set({
              origin: 'manual',
              pauseOverride: true,
              queueClass: spec.queueClass === 'manual' ? 'manual' : existing.queueClass,
              dueAt: Math.min(spec.dueAt, this.#now()),
            })
            .where(eq(jobs.id, existing.id))
            .run();
        }
        return { jobId: existing.id, reused: true };
      }
    }

    const inserted = this.#db
      .insert(jobs)
      .values({
        streamId: spec.streamId ?? null,
        operationId: spec.operationId ?? null,
        kind: spec.kind,
        queueClass: spec.queueClass,
        origin: spec.origin,
        acceptedAt: now,
        acceptedAuthVersion: spec.acceptedAuthVersion ?? null,
        pauseOverride: spec.pauseOverride ?? false,
        dedupeKey: spec.dedupeKey ?? null,
        state: 'queued',
        dueAt: spec.dueAt,
        attempt: 0,
        continuationJson: spec.continuationJson ?? null,
        configRevision: spec.configRevision ?? null,
        createdAt: now,
      })
      .returning({ id: jobs.id })
      .all();

    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('任务入队失败');
    return { jobId: id, reused: false };
  }

  #candidates(now: number, limit: number, onlyControl: boolean): CandidateRow[] {
    // 周期任务排除暂停仓库；显式单次检测可带 pause_override 绕过用户暂停，
    // 但系统 blocked_reason 对所有业务类任务生效。
    // onlyControl 供业务门禁未就绪时使用：只领取 control 类，不再"领取-再入队"空转。
    return this.#db.$client
      .prepare(
        `SELECT j.id, j.stream_id, j.operation_id, j.kind, j.queue_class, j.origin, j.state,
                j.attempt, j.attempt_token, j.config_revision, j.continuation_json,
                j.pause_override, j.accepted_auth_version, j.dedupe_key,
                s.repo_id AS repo_id, s.branch_id AS branch_id
           FROM jobs j
           LEFT JOIN monitor_streams s ON s.id = j.stream_id
           LEFT JOIN repositories r ON r.id = s.repo_id
          WHERE j.state IN ('queued', 'retry_wait')
            AND (j.due_at IS NULL OR j.due_at <= ?)
            AND (? = 0 OR j.queue_class = 'control')
            AND (
              j.queue_class = 'control'
              OR s.repo_id IS NULL
              OR (r.blocked_reason IS NULL AND (j.queue_class <> 'periodic' OR r.enabled = 1))
            )
          ORDER BY CASE WHEN j.queue_class = 'control' THEN 0 ELSE 1 END,
                   j.due_at IS NULL, j.due_at, j.id
          LIMIT ?`,
      )
      .all(now, onlyControl ? 1 : 0, limit) as CandidateRow[];
  }

  /**
   * 取下一个可执行任务。到期顺序优先，手动任务按公平比例适度插队：
   * 每完成一个手动请求，至少允许三个已到期常规请求。
   *
   * `onlyControl` 为 true 时只考虑控制类任务（业务门禁未就绪时使用）。
   */
  claimNext(options: { onlyControl?: boolean } = {}): JobRow | null {
    const now = this.#now();
    const candidates = this.#candidates(now, 64, options.onlyControl === true);
    if (candidates.length === 0) return null;

    const control = candidates.find((candidate) => candidate.queue_class === 'control');
    const manual = candidates.find((candidate) => candidate.queue_class === 'manual');
    const regular = candidates.find((candidate) => candidate.queue_class !== 'manual' && candidate.queue_class !== 'control');

    let chosen: CandidateRow | undefined;
    if (control !== undefined) {
      chosen = control;
    } else if (regular !== undefined && this.#regularSinceManual < MANUAL_FAIRNESS_RATIO) {
      chosen = regular;
      this.#regularSinceManual += 1;
    } else if (manual !== undefined) {
      chosen = manual;
      this.#regularSinceManual = 0;
    } else {
      chosen = regular;
    }
    if (chosen === undefined) return null;

    const attemptToken = `${this.#leaseOwner}:${chosen.id}:${chosen.attempt + 1}:${now}`;
    // 条件更新即租约：只有仍处于未结束状态且租约未被他人持有才能领取。
    const claimed = this.#db
      .update(jobs)
      .set({
        state: 'running',
        leaseOwner: this.#leaseOwner,
        leaseUntil: now + this.#leaseMs,
        attemptToken,
        attempt: chosen.attempt + 1,
      })
      .where(
        and(
          eq(jobs.id, chosen.id),
          inArray(jobs.state, ['queued', 'retry_wait']),
          or(isNull(jobs.leaseUntil), lt(jobs.leaseUntil, now)),
        ),
      )
      .run();
    if (claimed.changes === 0) return null;

    return {
      id: chosen.id,
      streamId: chosen.stream_id,
      operationId: chosen.operation_id,
      kind: chosen.kind,
      queueClass: chosen.queue_class,
      origin: chosen.origin,
      state: 'running',
      attempt: chosen.attempt + 1,
      attemptToken,
      configRevision: chosen.config_revision,
      continuationJson: chosen.continuation_json,
      pauseOverride: chosen.pause_override === 1,
      acceptedAuthVersion: chosen.accepted_auth_version,
      repoId: chosen.repo_id,
      branchId: chosen.branch_id,
      dedupeKey: chosen.dedupe_key,
    };
  }

  renew(jobId: number, attemptToken: string): boolean {
    const now = this.#now();
    const result = this.#db
      .update(jobs)
      .set({ leaseUntil: now + this.#leaseMs })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.state, 'running'),
          eq(jobs.leaseOwner, this.#leaseOwner),
          eq(jobs.attemptToken, attemptToken),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** 提交前复查租约所有者与 attempt_token；失配则不写任何业务状态。 */
  isCurrentAttempt(job: JobRow): boolean {
    if (job.attemptToken === null) return false;
    const row = this.#db
      .select({ leaseOwner: jobs.leaseOwner, attemptToken: jobs.attemptToken, state: jobs.state })
      .from(jobs)
      .where(eq(jobs.id, job.id))
      .get();
    return (
      row !== undefined &&
      row.state === 'running' &&
      row.leaseOwner === this.#leaseOwner &&
      row.attemptToken === job.attemptToken
    );
  }

  finish(job: JobRow, state: 'succeeded' | 'failed' | 'cancelled' | 'skipped', errorCode: string | null): void {
    // 取消/跳过代表这次领取没有真正执行，回退手动公平计数。
    if (state === 'cancelled' || state === 'skipped') this.#refundFairnessSlot(job);
    this.#db
      .update(jobs)
      .set({ state, finishedAt: this.#now(), errorCode, leaseOwner: null, leaseUntil: null })
      .where(and(eq(jobs.id, job.id), eq(jobs.attemptToken, job.attemptToken ?? '')))
      .run();
  }

  /** 释放本次领取但不结束任务：交回队列并推迟到指定时间，不产生任何出站副作用。 */
  requeue(job: JobRow, dueAt: number): void {
    // 未执行的领取既不该消耗公平额度，也不该消耗重试阶梯：领取时 attempt 已经 +1，
    // 全局节奏门/门禁未就绪这类每几秒一次的重排会把 1/5/15 分钟额度吃光，
    // 于是真正的瞬时故障第一次发生时直接终态失败，并把该流推迟一整个采集周期。
    this.#refundFairnessSlot(job);
    this.#db
      .update(jobs)
      .set({
        state: 'queued',
        dueAt,
        leaseOwner: null,
        leaseUntil: null,
        attemptToken: null,
        attempt: Math.max(0, job.attempt - 1),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.attemptToken, job.attemptToken ?? '')))
      .run();
  }

  /** 未真正执行的常规领取不消耗手动公平额度，保证"每完成一个手动请求后至少三个常规请求真正执行"。 */
  #refundFairnessSlot(job: JobRow): void {
    if (job.queueClass === 'manual' || job.queueClass === 'control') return;
    if (this.#regularSinceManual > 0) this.#regularSinceManual -= 1;
  }

  /** 5xx/网络超时按 1/5/15 分钟退避，最多 3 次重试（初始尝试之外），然后结束本轮。 */
  retryOrFail(job: JobRow, errorCode: string | null): { retried: boolean; dueAt: number | null } {
    const now = this.#now();
    // attempt 在领取时递增：第 1..3 次尝试失败后分别按 1/5/15 分钟退避，
    // 第 4 次尝试（= 初始尝试 + 3 次重试）仍失败才结束本轮。
    if (job.attempt <= MAX_JOB_RETRIES) {
      const backoff = RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[0];
      const dueAt = now + backoff;
      this.#db
        .update(jobs)
        .set({ state: 'retry_wait', dueAt, leaseOwner: null, leaseUntil: null, attemptToken: null })
        .where(and(eq(jobs.id, job.id), eq(jobs.attemptToken, job.attemptToken ?? '')))
        .run();
      return { retried: true, dueAt };
    }
    this.finish(job, 'failed', errorCode);
    return { retried: false, dueAt: null };
  }

  /** 租约过期：转换状态并更换 attempt_token，不能只修改 lease_until。 */
  releaseExpiredLeases(): number {
    const now = this.#now();
    const result = this.#db
      .update(jobs)
      .set({
        state: 'queued',
        leaseOwner: null,
        leaseUntil: null,
        attemptToken: null,
        dueAt: now,
      })
      .where(and(eq(jobs.state, 'running'), lt(jobs.leaseUntil, now)))
      .run();
    return result.changes;
  }

  counts(): JobCounts {
    const row = this.#db.$client
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN state = 'retry_wait' THEN 1 ELSE 0 END) AS retry_waiting,
           MIN(CASE WHEN state IN ('queued', 'retry_wait') THEN due_at END) AS oldest_due_at
         FROM jobs`,
      )
      .get() as { queued: number | null; running: number | null; retry_waiting: number | null; oldest_due_at: number | null };
    return {
      queued: row.queued ?? 0,
      running: row.running ?? 0,
      retryWaiting: row.retry_waiting ?? 0,
      oldestDueAt: row.oldest_due_at,
    };
  }

  /**
   * 已完成任务保留 30 天，并设置 100,000 条容量保护；未完成任务不得被清理。
   *
   * 分批删除：一次删掉整个积压会长时间持有写锁并阻塞事件循环，因此每批最多 `batch` 行。
   * 两个删除条件都是固定子句，不含任何外部输入。
   */
  purgeFinished(now: number, retentionMs: number, capacity: number, batch = 500): number {
    const terminal = "state IN ('succeeded', 'failed', 'cancelled', 'skipped')";
    let removed = 0;
    for (let round = 0; round < 40; round += 1) {
      const info = this.#db.$client
        .prepare(
          `DELETE FROM jobs WHERE id IN (
             SELECT id FROM jobs WHERE ${terminal} AND finished_at < ? LIMIT ?
           )`,
        )
        .run(now - retentionMs, batch);
      removed += info.changes;
      if (info.changes < batch) break;
    }

    const overflow = this.#db.$client
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE ${terminal}`)
      .get() as { count: number };
    let excess = overflow.count - capacity;
    for (let round = 0; round < 40 && excess > 0; round += 1) {
      const take = Math.min(batch, excess);
      const info = this.#db.$client
        .prepare(
          `DELETE FROM jobs WHERE id IN (
             SELECT id FROM jobs WHERE ${terminal} ORDER BY finished_at ASC LIMIT ?
           )`,
        )
        .run(take);
      removed += info.changes;
      excess -= info.changes;
      if (info.changes === 0) break;
    }
    return removed;
  }

  /** 任务组与逐项结果保留 30 天；逐项结果随组级联删除。 */
  purgeFinishedGroups(now: number, retentionMs: number, batch = 200): number {
    let removed = 0;
    for (let round = 0; round < 40; round += 1) {
      const info = this.#db.$client
        .prepare('DELETE FROM job_groups WHERE id IN (SELECT id FROM job_groups WHERE created_at < ? LIMIT ?)')
        .run(now - retentionMs, batch);
      removed += info.changes;
      if (info.changes < batch) break;
    }
    return removed;
  }

  /** 仓库被删除或暂停时取消其未开始的周期任务（含退避等待中的）；已接受的单次意图保留。 */
  cancelPeriodicFor(repoId: number): number {
    return this.#db
      .update(jobs)
      .set({ state: 'cancelled', finishedAt: this.#now() })
      .where(
        and(
          inArray(jobs.state, ['queued', 'retry_wait']),
          eq(jobs.queueClass, 'periodic'),
          sql`${jobs.streamId} IN (SELECT id FROM monitor_streams WHERE repo_id = ${repoId})`,
        ),
      )
      .run().changes;
  }
}
