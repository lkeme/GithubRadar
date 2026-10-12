import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import {
  JOB_LEASE_RENEW_MS,
  COMPLETED_JOB_CAPACITY,
  DIAGNOSTICS_RETENTION_DAYS,
  MAX_BRANCHES_PER_REPO,
  PRERELEASE_WINDOW_LIMIT,
} from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { jobGroupItems, jobs, monitorStreams, repositories, settings, trackedBranches } from '../db/schema.js';
import { purgeAbandonedDiscoveryRuns } from '../discovery/index.js';
import type { PrereleaseProjection, ReleaseProjection } from '../integrations/github/projections.js';
import { buildPath, purgeStaleHttpCache, type GithubOutcome } from '../integrations/github/client.js';
import { AppError } from '../http/errors.js';
import { purgeOldMetricsByRetention } from '../domain/public.js';
import { purgeExpiredSessions } from '../security/sessions.js';
import {
  CONTROL_OPERATION_WINDOW_MS,
  IDLE_WAKE_MS,
  MANUAL_REUSE_WINDOW_MS,
  MIN_REQUEST_INTERVAL_MS,
  RUNTIME_LOCK_LEASE_MS,
  RUNTIME_LOCK_RENEW_MS,
  SHUTDOWN_GRACE_MS,
} from './constants.js';
import { HOUR_MS, MINUTE_MS, advanceDueAt, controlDispatchGate, initialDueAt, nextDiscoveryAttempt, nextTrendsAttempt } from './planner.js';
import type { JobKind, JobQueue, JobRow } from './queue.js';
import {
  buildStreamSpec,
  commitEmptyBaseline,
  commitStreamAttemptError,
  commitStreamFailure,
  commitStreamNotModified,
  commitStreamSuccess,
  commitPrereleaseSuccess,
  dueStreams,
  ensureStreams,
  executeControlJob,
  loadStreamTarget,
  markIdentityChanged,
  readMetadataProjection,
  readStream,
  recordDailyMetric,
  releaseWindowProjection,
  streamIntervalMs,
  type SchedulerDeps,
  type StreamRow,
  type StreamTarget,
} from './streams.js';

/**
 * 常驻调度循环。
 *
 * 不用 setInterval 叠加异步扫描：这里是一个串行循环，每次只执行一个请求，
 * 完成后重新选择任务；`planDueStreams` 负责把到期的持久化计划变成任务，
 * 冷启动时每个错过的流只保留一次追赶任务。
 */

const DAY_MS = 24 * HOUR_MS;
const DIAGNOSTICS_RETENTION_MS = DIAGNOSTICS_RETENTION_DAYS * DAY_MS;

/**
 * 循环内未预期异常的日志节流间隔。
 * 只 catch 不记录会让"采集停摆"没有任何线索；每次循环都写又会刷满日志。
 */
const LOOP_ERROR_REPORT_INTERVAL_MS = 60 * 1000;

/** 让出事件循环：批量删除之间不长时间占用主线程。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface RuntimeLockHandle {
  readonly ownerId: string;
  readonly fence: number;
}

export class RuntimeLockError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeLockError';
  }
}

export function acquireRuntimeLock(db: Database, ownerId: string, now: number): RuntimeLockHandle {
  // 先确认单例行存在，再把"判定 + 抢占"压进一条条件 UPDATE：
  // 分三步（读→判→写）时两个实例可以同时通过判定、拿到相同的 fence，
  // 并在续租失败前的 30 秒里并行调度，"拒绝第二个调度进程"就不成立。
  const exists = db.$client.prepare('SELECT 1 AS ok FROM runtime_lock WHERE id = 1').get();
  if (exists === undefined) throw new RuntimeLockError('runtime_lock 单例行缺失');
  const claimed = db.$client
    .prepare(
      `UPDATE runtime_lock
          SET owner_id = ?, lease_until = ?, fence = fence + 1
        WHERE id = 1 AND (owner_id IS NULL OR lease_until <= ? OR owner_id = ?)
      RETURNING fence`,
    )
    .get(ownerId, now + RUNTIME_LOCK_LEASE_MS, now, ownerId) as { fence: number } | undefined;
  if (claimed === undefined) throw new RuntimeLockError('已有实例持有调度租约，拒绝启动第二个调度进程');
  return { ownerId, fence: claimed.fence };
}

export function renewRuntimeLock(db: Database, handle: RuntimeLockHandle, now: number): boolean {
  const result = db.$client
    .prepare('UPDATE runtime_lock SET lease_until = ? WHERE id = 1 AND owner_id = ? AND fence = ?')
    .run(now + RUNTIME_LOCK_LEASE_MS, handle.ownerId, handle.fence);
  return result.changes > 0;
}

export function releaseRuntimeLock(db: Database, handle: RuntimeLockHandle): void {
  db.$client
    .prepare('UPDATE runtime_lock SET owner_id = NULL, lease_until = 0 WHERE id = 1 AND owner_id = ? AND fence = ?')
    .run(handle.ownerId, handle.fence);
}

export interface SchedulerOptions {
  readonly ownerId: string;
  /** 关闭时等待在途请求的上限（默认 `SHUTDOWN_GRACE_MS`，30 秒，落在 Compose 的 45 秒宽限内）。 */
  readonly gracefulStopMs?: number;
}

export class Scheduler {
  readonly #deps: SchedulerDeps;
  readonly #options: SchedulerOptions;
  #lock: RuntimeLockHandle | null = null;
  #running = false;
  #loopPromise: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #lastRequestAt = 0;
  #stopped = false;
  #discoveryImport: Promise<unknown> | null = null;
  #trendsImport: Promise<unknown> | null = null;
  #nextWakeAt: number | null = null;
  #controlDispatchTimes: number[] = [];
  #gateWasReady = true;
  #lastMaintenance = 0;
  #lastDailyMaintenance = 0;
  #lastLoopErrorAt = 0;

  constructor(deps: SchedulerDeps, options: SchedulerOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** 任务队列入口：管理接口经它入队控制任务，诊断读取计数，测试直接领取。 */
  get jobQueue(): JobQueue {
    return this.#deps.queue;
  }

  get fence(): number {
    return this.#lock?.fence ?? 0;
  }

  /** 接收配置变化或新任务，唤醒正在等待的循环。 */
  notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) wake();
  }

  start(): void {
    if (this.#running) return;
    const now = this.#deps.now();
    this.#lock = acquireRuntimeLock(this.#deps.db, this.#options.ownerId, now);
    this.#recover();
    this.#running = true;
    this.#stopped = false;
    this.#loopPromise = this.#loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    this.notify();
    const deadline = Date.now() + (this.#options.gracefulStopMs ?? SHUTDOWN_GRACE_MS);
    const loop = this.#loopPromise;
    if (loop !== null) {
      await Promise.race([loop, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
    }
    // 在途的发现导入同样受宽限期约束：等它收口后再释放调度锁，
    // 避免锁释放窗口内第二实例并发导入、或进程立即退出留下 staging 残留。
    for (const pending of [this.#discoveryImport, this.#trendsImport]) {
      if (pending !== null) {
        await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
      }
    }
    if (this.#lock !== null) {
      releaseRuntimeLock(this.#deps.db, this.#lock);
      this.#lock = null;
    }
  }

  /** 冷启动恢复：过期租约转回队列、错过的流只保留一次追赶、清理过期占位。 */
  #recover(): void {
    const db = this.#deps.db;
    const now = this.#deps.now();
    this.#deps.queue.releaseExpiredLeases();
    this.#deps.credentials.purgeExpiredOperations();
    // 导入占位最长 24 小时；启动时同样清理，不能只等运行期计时器。
    this.#deps.repositoryService.releaseExpiredReservations();
    // 进程在 staging 写入与代次切换之间被强杀时，未完成的导入代次不会走 markRunFailed。
    purgeAbandonedDiscoveryRuns(db, now);

    const repos = db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.verificationState, 'verified'))
      .all();
    for (const repo of repos) {
      ensureStreams(db, repo.id, now);
    }

    // 已错过的周期任务只保留一次追赶：把过去到期的流收敛到“现在 + 错峰偏移”。
    const overdue = db
      .select({ id: monitorStreams.id, phaseSeed: monitorStreams.phaseSeed })
      .from(monitorStreams)
      .where(and(isNotNull(monitorStreams.nextDueAt), lte(monitorStreams.nextDueAt, now)))
      .all();
    for (const stream of overdue) {
      const offset = (stream.phaseSeed % 600) * 1000;
      db.update(monitorStreams)
        .set({ nextDueAt: now + offset })
        .where(eq(monitorStreams.id, stream.id))
        .run();
    }

    // 仍在运行的旧任务在本进程看来已无租约，交回队列重新领取。
    db.$client
      .prepare("UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_until = NULL, attempt_token = NULL WHERE state = 'running'")
      .run();
  }

  async #loop(): Promise<void> {
    let lastRenew = this.#deps.now();
    let lastLeaseHarvest = this.#deps.now();
    while (!this.#stopped) {
      const now = this.#deps.now();
      if (now - lastRenew >= RUNTIME_LOCK_RENEW_MS && this.#lock !== null) {
        if (!renewRuntimeLock(this.#deps.db, this.#lock, now)) {
          // 失去续租即停止领取任务，未结束响应作废。
          this.#running = false;
          break;
        }
        lastRenew = now;
      }
      // 周期性回收过期租约：进程内异常留下的 running 任务不能永久占住去重键。
      if (now - lastLeaseHarvest >= RUNTIME_LOCK_RENEW_MS) {
        this.#deps.queue.releaseExpiredLeases();
        lastLeaseHarvest = now;
      }
      // 周期维护：保留期与容量保护必须真的执行。
      if (now - this.#lastMaintenance >= HOUR_MS) {
        this.#lastMaintenance = now;
        try {
          await this.runMaintenance(now);
        } catch (error) {
          // 维护失败不影响采集；下一轮再试，但必须留下线索。
          this.#reportLoopError('周期维护', error);
        }
      }
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        this.#reportLoopError('调度循环', error);
        worked = false;
      }
      if (!worked) {
        await this.#waitFor(this.#nextWakeDelay());
      }
    }
  }

  /**
   * 循环内未预期异常的可见出口。
   *
   * 规划路径（到期扫描、发现导入、队列领取）抛出的异常不会写回任何 job 行，
   * 只 catch 不记录就只剩"什么都没发生"。按分钟节流，避免持续故障刷满日志。
   */
  #reportLoopError(context: string, error: unknown): void {
    const at = this.#deps.now();
    if (at - this.#lastLoopErrorAt < LOOP_ERROR_REPORT_INTERVAL_MS) return;
    this.#lastLoopErrorAt = at;
    process.stderr.write(
      `[scheduler] ${context}异常：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  #nextWakeDelay(): number {
    const now = this.#deps.now();
    const backoff = this.#deps.budget.backoffUntil();
    if (backoff > now) {
      this.#nextWakeAt = backoff;
      return Math.min(backoff - now, IDLE_WAKE_MS);
    }
    const next = this.#deps.budget.nextRequestAt();
    if (next > now) {
      this.#nextWakeAt = next;
      return Math.min(next - now, IDLE_WAKE_MS);
    }
    const nextVerification = this.#deps.db.$client
      .prepare('SELECT next_verification_at AS at FROM github_credential_status WHERE id = 1')
      .get() as { at: number | null } | undefined;
    if (nextVerification?.at != null && nextVerification.at > now) {
      this.#nextWakeAt = nextVerification.at;
      return Math.min(nextVerification.at - now, IDLE_WAKE_MS);
    }
    // 队列里已有到期时间的任务（例如被节奏门重排的）要按它唤醒，
    // 否则空闲上限会把刚到期的任务多压最多 30 秒。
    const earliestJob = this.#deps.db.$client
      .prepare(
        "SELECT MIN(due_at) AS at FROM jobs WHERE state IN ('queued', 'retry_wait') AND due_at IS NOT NULL",
      )
      .get() as { at: number | null } | undefined;
    if (earliestJob?.at != null && earliestJob.at > now) {
      this.#nextWakeAt = earliestJob.at;
      return Math.min(earliestJob.at - now, IDLE_WAKE_MS);
    }
    this.#nextWakeAt = null;
    return IDLE_WAKE_MS;
  }

  /** 下一次计划唤醒时间；供后台诊断展示"下次唤醒"。 */
  get nextWakeAt(): number | null {
    return this.#nextWakeAt;
  }

  async #waitFor(delayMs: number): Promise<void> {
    if (this.#stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, Math.max(0, delayMs));
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** 一台设备一次只执行一个请求；返回是否做了实际工作。 */
  async runOnce(): Promise<boolean> {
    if (!this.#running) return false;
    const now = this.#deps.now();
    this.#planDueStreams(now);
    this.#planCredentialVerification(now);
    this.#planDiscovery(now);
    this.#planTrends(now);

    // 业务门禁未就绪时只领取控制类任务：避免先领取业务任务再入队/取消的空转。
    const gateReady = this.#deps.credentials.isReady();
    const job = this.#deps.queue.claimNext(gateReady ? {} : { onlyControl: true });
    if (job === null) return false;

    // 节奏判定必须用同一个 now：#nextDispatchAt 若自己再读一次时钟，门禁空闲时
    // dispatchAt 会恒等于"几毫秒之后"，任务被无限领取→重排，永远不被执行。
    const dispatchAt = this.#nextDispatchAt(job, now);
    if (now < dispatchAt) {
      // 全局节奏未到：放回队列，不产生任何出站副作用。返回 true 让主循环立即进入下一轮，
      // 否则外层会再叠加一个完整唤醒间隔，把刚到期的任务多压最多 30 秒。
      this.#deps.queue.requeue(job, dispatchAt);
      await this.#waitFor(Math.min(dispatchAt - now, IDLE_WAKE_MS));
      return true;
    }

    await this.executeJob(job);
    return true;
  }

  #nextDispatchAt(job: JobRow, now: number): number {
    const backoff = this.#deps.budget.backoffUntil();
    // 控制操作可以优先于未开始的业务请求，但仍受真实 Retry-After 与配额约束。
    if (job.queueClass === 'control') {
      // 修复类控制请求可动用本地 20% 保留额度，不被业务节奏门禁锁死；
      // 真实 remaining=0 时仍必须等到 reset（canUseReservedBudget 为 false 时退回重置等待语义）。
      const quotaGate = this.#deps.budget.canUseReservedBudget() ? 0 : this.#deps.budget.nextRequestAt();
      // 管理发起的控制操作每分钟最多 2 个；超出的延后，不丢弃。
      return Math.max(
        backoff,
        this.#lastRequestAt + MIN_REQUEST_INTERVAL_MS,
        this.#controlDispatchGate(now),
        quotaGate,
        now,
      );
    }
    return Math.max(backoff, this.#deps.budget.nextRequestAt(), now);
  }

  /**
   * 控制操作的派发门禁：最近一分钟内已派发 2 个管理发起的控制操作时，
   * 下一个至少要等到最早那次的 60 秒之后。后台自身的复核任务不受此限制。
   */
  #controlDispatchGate(now: number): number {
    const cutoff = now - CONTROL_OPERATION_WINDOW_MS;
    while (this.#controlDispatchTimes.length > 0 && (this.#controlDispatchTimes[0] ?? 0) <= cutoff) {
      this.#controlDispatchTimes.shift();
    }
    return controlDispatchGate(this.#controlDispatchTimes, now);
  }

  #planDueStreams(now: number): void {
    // 业务门禁未就绪时完全不规划业务流：已接受采集暂停，修复后错峰恢复。
    // 否则每个到期流会每 60 秒被领取→发现门禁未开→重排，形成空转。
    if (!this.#deps.credentials.isReady()) {
      this.#gateWasReady = false;
      return;
    }
    if (!this.#gateWasReady) {
      this.#gateWasReady = true;
      this.staggerOverdueStreams(now);
    }

    const due = dueStreams(this.#deps.db, now, 200);
    for (const stream of due) {
      // kind 与 configRevision 由 dueStreams 一并返回，规划路径不再逐流回查。
      this.#deps.queue.enqueue({
        kind: stream.kind,
        queueClass: 'periodic',
        origin: 'scheduler',
        dueAt: now,
        streamId: stream.streamId,
        dedupeKey: `stream:${stream.streamId}`,
        pauseOverride: false,
        configRevision: stream.configRevision,
      });
    }
  }

  /**
   * 周期维护：执行各表的保留期与容量保护，删除一律分批，
   * 并在批次之间让出事件循环，避免长时间持有写锁。
   */
  async runMaintenance(now: number): Promise<void> {
    this.#deps.repositoryService.releaseExpiredReservations();
    purgeExpiredSessions(this.#deps.db, now);
    this.#deps.credentials.purgeExpiredOperations();
    // 凭证时间边界必须由后台持久化：GET 只读计算不足以阻止业务；
    // 幂等，到期即写 expired、递增 gate revision 并安排一次在线复核。
    this.#deps.credentials.persistTimeBoundaries();
    this.#deps.budget.purgeOldWindows(now);
    await yieldToEventLoop();

    if (now - this.#lastDailyMaintenance < DAY_MS) return;
    this.#lastDailyMaintenance = now;

    this.#deps.queue.purgeFinished(now, DIAGNOSTICS_RETENTION_MS, COMPLETED_JOB_CAPACITY);
    await yieldToEventLoop();
    this.#deps.queue.purgeFinishedGroups(now, DIAGNOSTICS_RETENTION_MS);
    await yieldToEventLoop();
    purgeStaleHttpCache(this.#deps.db, now);
    purgeOldMetricsByRetention(this.#deps.db, now);
  }

  /** 门禁恢复后错峰重排所有已过期的流，避免修复瞬间全部并发。 */
  staggerOverdueStreams(now: number): void {
    const overdue = this.#deps.db
      .select({ id: monitorStreams.id, phaseSeed: monitorStreams.phaseSeed })
      .from(monitorStreams)
      .where(and(isNotNull(monitorStreams.nextDueAt), lte(monitorStreams.nextDueAt, now)))
      .all();
    for (const stream of overdue) {
      const offset = (stream.phaseSeed % 600) * 1000;
      this.#deps.db
        .update(monitorStreams)
        .set({ nextDueAt: now + offset })
        .where(eq(monitorStreams.id, stream.id))
        .run();
    }
  }

  /**
   * 每日发现导入。
   *
   * 导入走自己的下载通道、不占用 GitHub API 串行槽，因此这里**不**把它排进任务队列，
   * 而是单独起一个受保护的异步任务：同一时刻最多一个导入在途，整轮失败不影响核心看板。
   * 业务门禁未就绪时暂停导入。
   */
  #planDiscovery(now: number): void {
    const discovery = this.#deps.discovery;
    if (discovery === null || discovery === undefined) return;
    if (this.#discoveryImport !== null) return;
    const decision = planDiscoverySchedule(this.#deps.db, now, this.#deps.credentials.isReady());
    if (decision !== 'start') return;

    this.#discoveryImport = discovery
      .import()
      .catch(() => undefined)
      .finally(() => {
        this.#discoveryImport = null;
        this.notify();
      }) as Promise<unknown>;
  }

  /** 供测试与诊断：确认已有导入在途，避免并发重复导入。 */
  get discoveryImportRunning(): boolean {
    return this.#discoveryImport !== null;
  }

  /** 供测试与诊断：每日趋势导入是否在途。 */
  get trendsImportRunning(): boolean {
    return this.#trendsImport !== null;
  }

  /**
   * 每日趋势导入。
   *
   * 与发现同理单独起受保护异步任务：每日只抓 1 份新报告（首次部署补最近 120 天），
   * 失败不阻塞核心看板。门禁未就绪时暂停——报告清单走 GitHub API，同样需要 PAT。
   */
  #planTrends(now: number): void {
    const trends = this.#deps.trends;
    if (trends === null || trends === undefined) return;
    if (this.#trendsImport !== null) return;
    const decision = planTrendsSchedule(this.#deps.db, now, this.#deps.credentials.isReady());
    if (decision !== 'start') return;

    this.#trendsImport = trends
      .import()
      // 结论落库：只 catch 不记录会让"每天都在失败"与"上游没更新"看起来一样。
      .then((result) => {
        trends.recordAttempt(result as { state: string; errorCode: string | null });
        return result;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#trendsImport = null;
        this.notify();
      }) as Promise<unknown>;
  }

  /**
   * 后台复核凭证新鲜度：连续 48 小时无可信认证成功、或已知 unverified/invalid/expired 时安排验证。
   * 不要求管理员在线，也不创建虚构会话。
   */
  #planCredentialVerification(now: number): void {
    const status = this.#deps.credentials.status();
    const state = status.effectiveState;
    if (state === 'valid') {
      if (status.nextVerificationAt !== null && status.nextVerificationAt <= now) {
        this.#deps.queue.enqueue({
          kind: 'token_verify',
          queueClass: 'control',
          origin: 'scheduler',
          dueAt: now,
          dedupeKey: 'credential:verify',
        });
      }
      return;
    }
    if (!status.configured) return;
    const due = status.nextVerificationAt ?? now;
    if (due <= now) {
      this.#deps.queue.enqueue({
        kind: 'token_verify',
        queueClass: 'control',
        origin: 'scheduler',
        dueAt: now,
        dedupeKey: 'credential:verify',
      });
    }
  }

  async executeJob(job: JobRow): Promise<void> {
    // 租约每 30 秒本地续期。单次执行通常远短于 120 秒租约，
    // 但慢上游或磁盘抖动时不能让租约在飞行中过期。
    const renewTimer = setInterval(() => {
      this.#deps.queue.renew(job.id, job.attemptToken ?? '');
    }, JOB_LEASE_RENEW_MS);
    try {
      await this.#dispatchJob(job);
    } catch (error) {
      // 未预期的异常不能让任务停在 running：那会让该流的去重键被永久占住，
      // 到期计划再也无法为它入队。按可重试失败收口；阶梯耗尽时推进周期计划，
      // 否则 next_due_at 停留在过去，下一轮规划会立即重新入队、重放退避阶梯。
      const errorCode = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      const { retried } = this.#deps.queue.retryOrFail(job, errorCode);
      if (!retried && job.streamId !== null) {
        const fresh = readStream(this.#deps.db, job.streamId);
        if (fresh !== null) {
          const failureAt = this.#deps.now();
          commitStreamFailure(
            this.#deps.db,
            fresh,
            errorCode,
            failureAt,
            failureAt + streamIntervalMs(this.#deps.db, fresh.repoId),
          );
        }
      }
      throw error;
    } finally {
      clearInterval(renewTimer);
    }
  }

  async #dispatchJob(job: JobRow): Promise<void> {
    const now = this.#deps.now();
    const gateRevisionAtDispatch = this.#deps.credentials.gateRevision();
    const credentialRevisionAtDispatch = this.#deps.credentials.credentialRevision();

    if (job.kind === 'token_verify' || job.kind === 'proxy_test') {
      // 管理发起的控制操作计入每分钟上限；后台复核用 origin='scheduler'，不受限。
      if (job.origin !== 'scheduler') {
        this.#controlDispatchTimes.push(now);
      }
      this.#deps.budget.recordRequestStart();
      this.#lastRequestAt = now;
      const result = await executeControlJob(this.#deps, job);
      this.#deps.budget.clearSecondaryStrikes();
      if (result.ok) {
        this.#deps.queue.finish(job, 'succeeded', null);
      } else {
        // 控制操作是管理员当场发起的交互动作，结论就是"这次候选配置不可用"：立即结束并把
        // 错误码写回操作行。套用 1/5/15 分钟重试阶梯只会让界面停在"等待中"，而重试不会改变
        // 同一个候选的结论；需要重测时由管理员重新发起或点「重新验证」。
        this.#deps.queue.finish(job, 'failed', result.errorCode);
        // 后台复核因本地凭证不可读而失败时，不留退避就会每个循环重新入队（规划器按
        // nextVerificationAt <= now 判定），形成每秒一次的空转。推到一小时后由管理员修复。
        if (job.kind === 'token_verify' && job.origin === 'scheduler' && result.errorCode === 'IMPORT_EXPIRED') {
          this.#deps.credentials.deferNextVerification(HOUR_MS);
        }
      }
      this.notify();
      return;
    }

    if (job.kind === 'branch_list') {
      await this.#executeBranchList(job);
      return;
    }

    if (job.streamId === null) {
      this.#deps.queue.finish(job, 'skipped', 'STREAM_MISSING');
      return;
    }

    const target = loadStreamTarget(this.#deps.db, job.streamId);
    if (target === null) {
      this.#deps.queue.finish(job, 'skipped', 'STREAM_UNAVAILABLE');
      return;
    }

    // 周期任务携带入队时的配置版本：入队后配置已变化（分支改名/开关切换等）
    // 则本次请求不再代表当前计划，跳过后由规划器按新 revision 重新入队。
    if (
      job.queueClass === 'periodic' &&
      job.configRevision !== null &&
      target.stream.configRevision !== job.configRevision
    ) {
      this.#deps.queue.finish(job, 'skipped', 'STREAM_CONFIG_CHANGED');
      return;
    }

    if (!this.#deps.credentials.isReady()) {
      // 门禁未就绪：不派发业务请求。周期任务的意图由流的 next_due_at 保留，
      // 修复后由计划重新入队；只有显式单次意图才继续等待。
      if (job.queueClass === 'periodic') {
        this.#deps.queue.finish(job, 'cancelled', 'GITHUB_SETUP_REQUIRED');
      } else {
        this.#deps.queue.requeue(job, now + 5 * 60 * 1000);
      }
      return;
    }

    // 每轮先完成 metadata 身份门禁，再执行该仓库的 Release / 分支任务。
    if (target.stream.kind !== 'metadata') {
      const repo = this.#deps.db
        .select({ identityVerifiedAt: repositories.identityVerifiedAt, verificationState: repositories.verificationState })
        .from(repositories)
        .where(eq(repositories.id, target.repoId))
        .get();
      const fresh = repo?.identityVerifiedAt !== null && repo?.identityVerifiedAt !== undefined && now - repo.identityVerifiedAt < 24 * HOUR_MS;
      if (!fresh || repo?.verificationState !== 'verified') {
        const metadataStreamId = this.#metadataStreamId(target.repoId);
        if (metadataStreamId !== null) {
          this.#deps.queue.enqueue({
            kind: 'metadata',
            queueClass: 'initialization',
            origin: 'recovery',
            dueAt: now,
            streamId: metadataStreamId,
            dedupeKey: `stream:${metadataStreamId}`,
          });
        }
        this.#deps.queue.requeue(job, now + 5 * 1000);
        return;
      }
    }

    const token = this.#deps.credentials.readActiveToken();
    const spec = buildStreamSpec(this.#deps.client, target, credentialRevisionAtDispatch, token);
    if (spec === null) {
      this.#deps.queue.finish(job, 'skipped', 'STREAM_UNAVAILABLE');
      return;
    }

    this.#deps.budget.recordRequestStart();
    this.#lastRequestAt = now;
    const startedAt = this.#deps.now();
    // 流基线缺失/损坏时本轮必须拿到实体投影：304 只说明缓存校验器还在，不能用来建立基线。
    const needsBaseline = target.stream.initializedAt === null || target.stream.projectionJson === null;
    const outcome = await this.#deps.client.get({
      ...spec.spec,
      projection: { parse: spec.parse },
      requiresProjection: needsBaseline,
    });
    this.#deps.budget.recordOutcome({ ms: this.#deps.now() - startedAt, notModified: outcome.kind === 'not_modified' });
    this.#deps.budget.observeServerDate(outcome.serverDate ?? undefined);
    this.#deps.budget.observe(outcome.rateLimit);
    if (outcome.errorCode === 'GITHUB_RATE_LIMITED') {
      // 明确的 Retry-After 与配额 reset 取较晚；无时间信息时退回 60 秒起步的次级退避。
      this.#deps.budget.applyRetryAfter(outcome.retryAfter ?? undefined);
      this.#deps.budget.applySecondaryBackoff();
    }
    this.#deps.budget.clearSecondaryStrikes();

    // 业务门禁在提交前复核：门禁变化后旧响应不写业务状态、趋势或业务缓存。
    if (this.#deps.credentials.gateRevision() !== gateRevisionAtDispatch) {
      this.#deps.queue.requeue(job, this.#deps.now() + 30 * 1000);
      return;
    }
    if (this.#deps.queue.isCurrentAttempt(job) === false) {
      this.#deps.queue.finish(job, 'skipped', 'LEASE_LOST');
      return;
    }

    const intervalMs = streamIntervalMs(this.#deps.db, target.repoId);
    const nextDueAt = advanceDueAt(target.stream.nextDueAt ?? now, intervalMs, now);

    switch (outcome.kind) {
      case 'ok':
        this.#commitOk(job, target.stream, target.repoId, outcome.data, now, nextDueAt);
        break;
      case 'not_modified': {
        commitStreamNotModified(this.#deps.db, target.stream, now, nextDueAt);
        if (target.stream.kind === 'prerelease') {
          // 304 证明了列表可访问、且缓存投影仍属本凭证版本：同样要消解 release 流的
          // LATEST_NOT_FOUND 待确认。只发预发布的仓库列表稳定后每轮都是 304，
          // 若只在 200 时确认，"无正式版"的空基线永远不会落库，仓库永久 partial。
          const cached = this.#deps.client.readCachedProjection({
            path: spec.spec.path,
            query: spec.spec.query,
            credentialRevision: credentialRevisionAtDispatch,
            token,
          });
          if (cached !== null) {
            this.#resolvePendingLatestConfirmation(target.repoId, cached as PrereleaseProjection, now, nextDueAt);
          }
        }
        this.#deps.queue.finish(job, 'succeeded', null);
        break;
      }
      case 'error':
        await this.#commitError(job, target, outcome, now, intervalMs, nextDueAt);
        break;
    }
    this.notify();
  }

  /**
   * 合并重复导入：释放多余占位并维护任务关联。
   *
   * 顺序很关键——先取消未开始任务、把批次项改指到保留行，再删除占位，
   * 否则级联删除会把导入反馈一起带走。
   */
  #mergeDuplicateRepository(placeholderId: number, targetId: number, now: number): void {
    const db = this.#deps.db;
    const merge = db.$client.transaction(() => {
      db.$client
        .prepare(
          `UPDATE jobs SET state = 'cancelled', finished_at = ?
            WHERE state IN ('queued', 'retry_wait')
              AND stream_id IN (SELECT id FROM monitor_streams WHERE repo_id = ?)`,
        )
        .run(now, placeholderId);
      db.$client
        .prepare('UPDATE job_group_items SET repo_id = ? WHERE repo_id = ?')
        .run(targetId, placeholderId);
      db.$client.prepare('DELETE FROM repositories WHERE id = ?').run(placeholderId);
    });
    merge();
    ensureStreams(db, targetId, now);
    const metadataStreamId = this.#metadataStreamId(targetId);
    if (metadataStreamId !== null) {
      this.#deps.queue.enqueue({
        kind: 'metadata',
        queueClass: 'initialization',
        origin: 'recovery',
        dueAt: now,
        streamId: metadataStreamId,
        dedupeKey: `stream:${metadataStreamId}`,
      });
    }
  }

  /**
   * 跟随默认分支改名。
   *
   * 默认分支是"跟随模式"：上游改名后本地必须跟着换采集对象，
   * 而不是继续轮询一个已不存在的分支名（那会永久停在"分支不可用"）。
   * 换采集对象等于新基线：清空该流的初始化与变化时间，
   * 因此不会把改名列进"代码更新"，只增加采集 revision。
   */
  #followDefaultBranch(repoId: number, newDefaultBranch: string, previousDefaultBranch: string | null): void {
    if (newDefaultBranch === previousDefaultBranch) return;
    const db = this.#deps.db;
    const following = db
      .select()
      .from(trackedBranches)
      .where(and(eq(trackedBranches.repoId, repoId), eq(trackedBranches.mode, 'default')))
      .all();
    if (following.length === 0) return;

    let changed = false;
    for (const branch of following) {
      if (branch.resolvedName === newDefaultBranch) continue;
      db.update(trackedBranches).set({ resolvedName: newDefaultBranch }).where(eq(trackedBranches.id, branch.id)).run();
      db.update(monitorStreams)
        .set({
          initializedAt: null,
          currentProjectionJson: null,
          detectedChangeAt: null,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastErrorCode: null,
          configRevision: sql`${monitorStreams.configRevision} + 1`,
        })
        .where(eq(monitorStreams.branchId, branch.id))
        .run();
      changed = true;
    }
    if (changed) {
      // 改名后可能与某个固定分支同名：同一 resolved_name 只保留一个采集流，
      // 默认跟随优先。这里不改写用户的 enabled——参与采集与否由 collectableBranchIds
      // 在运行时派生，默认分支再改名后该固定分支会自动恢复。
      db.update(repositories)
        .set({ collectionRevision: sql`${repositories.collectionRevision} + 1` })
        .where(eq(repositories.id, repoId))
        .run();
    }
  }

  #metadataStreamId(repoId: number): number | null {
    const row = this.#deps.db
      .select({ id: monitorStreams.id })
      .from(monitorStreams)
      .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.kind, 'metadata')))
      .get();
    return row?.id ?? null;
  }

  #commitOk(
    job: JobRow,
    stream: StreamRow,
    repoId: number,
    data: unknown,
    now: number,
    nextDueAt: number,
  ): void {
    const db = this.#deps.db;
    if (stream.kind === 'metadata') {
      const projection = data as ReturnType<typeof readMetadataProjection>;
      if (projection === null) {
        this.#deps.queue.finish(job, 'failed', 'UPSTREAM_SCHEMA_CHANGED');
        return;
      }
      // 上游数字 ID 必须是不带符号的十进制且落在安全整数范围内：
      // 超出范围会被 Number() 静默截断，把不同仓库误判成同一身份，因此不合法时不写任何库。
      if (!/^\d+$/.test(projection.id) || !Number.isSafeInteger(Number(projection.id))) {
        this.#deps.queue.finish(job, 'failed', 'UPSTREAM_SCHEMA_CHANGED');
        return;
      }
      const existing = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
      if (existing === undefined) {
        this.#deps.queue.finish(job, 'skipped', 'REPOSITORY_DELETED');
        return;
      }
      // 200 响应同样核对数字 ID：名称被其他新仓库占用时不得把新仓库写进旧基线。
      if (existing.githubId !== null && String(existing.githubId) !== projection.id) {
        markIdentityChanged(db, repoId, now);
        this.#deps.queue.finish(job, 'failed', 'REPOSITORY_IDENTITY_CHANGED');
        return;
      }
      // 名称不同但 GitHub ID 相同的导入合并到已有仓库，而不是让唯一约束报错，
      // 也不能让两个本地记录指向同一个上游仓库。
      const duplicate = db.$client
        .prepare('SELECT id FROM repositories WHERE github_id = ? AND id <> ?')
        .get(Number(projection.id), repoId) as { id: number } | undefined;
      if (duplicate !== undefined) {
        this.#mergeDuplicateRepository(repoId, duplicate.id, now);
        this.#deps.queue.finish(job, 'skipped', 'REPOSITORY_ALREADY_EXISTS');
        this.notify();
        return;
      }
      const commit = db.$client.transaction(() => {
        db.update(repositories)
          .set({
            githubId: Number(projection.id),
            canonicalName: projection.fullName,
            displayName: existing.displayName ?? projection.displayName,
            description: projection.description,
            htmlUrl: projection.htmlUrl,
            ownerAvatarUrl: projection.ownerAvatarUrl,
            isPrivate: projection.isPrivate,
            language: projection.language,
            stars: projection.stars,
            forks: projection.forks,
            archived: projection.archived,
            defaultBranch: projection.defaultBranch,
            verificationState: 'verified',
            blockedReason: null,
            reservedUntil: null,
            identityVerifiedAt: now,
            identityRevision: existing.identityRevision + 1,
          })
          .where(eq(repositories.id, repoId))
          .run();
        this.#followDefaultBranch(repoId, projection.defaultBranch, existing.defaultBranch);
        // 首次验证成功后创建 Release 流和默认分支流。只在 pending→verified 的
        // 转换时创建——用户此后通过分支设置移除默认跟随是明确配置，每个周期的
        // metadata 成功都按"无 default 行"重插会把该配置静默还原。
        const defaultBranch = projection.defaultBranch;
        const firstVerification = existing.verificationState !== 'verified';
        if (firstVerification && defaultBranch !== '' && defaultBranch !== 'HEAD') {
          const existingDefault = db
            .select({ id: trackedBranches.id })
            .from(trackedBranches)
            .where(and(eq(trackedBranches.repoId, repoId), eq(trackedBranches.mode, 'default')))
            .get();
          if (existingDefault === undefined) {
            // 容量护栏：已有 20 个分支时不再强插（触发器会 ABORT），保留用户配置。
            const branchCount = db.$client
              .prepare('SELECT COUNT(*) AS count FROM tracked_branches WHERE repo_id = ?')
              .get(repoId) as { count: number };
            if (branchCount.count < MAX_BRANCHES_PER_REPO) {
              db.insert(trackedBranches)
                .values({
                  repoId,
                  mode: 'default',
                  // default 跟随模式的 configured_name 恒为 NULL，实际分支名存 resolved_name。
                  configuredName: null,
                  resolvedName: defaultBranch,
                  enabled: true,
                })
                .run();
            }
          }
        }
      });
      commit();
      commitStreamSuccess(db, stream, projection, now, nextDueAt);
      recordDailyMetric(db, repoId, projection.stars, projection.forks, now);
      ensureStreams(db, repoId, now);
      this.#deps.queue.finish(job, 'succeeded', null);
      return;
    }

    if (stream.kind === 'prerelease') {
      const projection = data as PrereleaseProjection;
      const commit = db.$client.transaction(() => {
        // 预发布不刷新「候选消失」的变化标记：用专用基线判定而不是通用 identityKey。
        commitPrereleaseSuccess(db, stream, projection, now, nextDueAt);
        // 同轮列表请求合并：latest 404 的辅助确认复用这一次列表结果。
        this.#resolvePendingLatestConfirmation(repoId, projection, now, nextDueAt);
      });
      commit();
      this.#deps.queue.finish(job, 'succeeded', null);
      return;
    }

    if (stream.kind === 'release') {
      commitStreamSuccess(db, stream, data as ReleaseProjection, now, nextDueAt);
      this.#deps.queue.finish(job, 'succeeded', null);
      return;
    }

    // branch：同一分支 SHA 不同即视为分支状态变化，包括回退与 force-push。
    commitStreamSuccess(db, stream, data, now, nextDueAt);
    this.#deps.queue.finish(job, 'succeeded', null);
  }

  /** 预发布只比较当前窗口候选；候选消失只是移出窗口，不判删除或转正式。 */
  #resolvePendingLatestConfirmation(
    repoId: number,
    projection: PrereleaseProjection,
    now: number,
    nextDueAt: number,
  ): void {
    const pending = this.#deps.db
      .select({ id: monitorStreams.id })
      .from(monitorStreams)
      .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.kind, 'release'), eq(monitorStreams.lastErrorCode, 'LATEST_NOT_FOUND')))
      .get();
    if (pending === undefined) return;
    const stream = readStream(this.#deps.db, pending.id);
    if (stream === null) return;
    if (!projection.hasAnyPublishedRelease) {
      // 列表成功且窗口内没有正式发布，才记录“暂无 latest 正式版”。
      // 空基线必须走显式写入：不能借道通用变化判定，否则“没有 latest”会每轮被当成一次变化。
      commitEmptyBaseline(this.#deps.db, stream, now, nextDueAt);
      return;
    }
    // 窗口内存在其他正式发布也不自行将其提升为 latest。
    commitStreamFailure(this.#deps.db, stream, 'UPSTREAM_SCHEMA_CHANGED', now, now + 24 * HOUR_MS);
  }

  /**
   * 失败收口。
   *
   * 401/限流/可重试错误直接返回；其余终态错误按流的类型决定是否写空基线：
   * 空仓库/空分支是"确定为空"的合法结果，latest 404 且没有预发布流时
   * 会在本 job 内补一次列表确认。
   */
  async #commitError(
    job: JobRow,
    target: StreamTarget,
    outcome: Pick<GithubOutcome<unknown>, 'status' | 'errorCode' | 'retryable' | 'errorMessage' | 'retryAfter'>,
    now: number,
    intervalMs: number,
    nextDueAt: number,
  ): Promise<void> {
    const db = this.#deps.db;
    const stream = target.stream;
    const repoId = target.repoId;
    const errorCode = outcome.errorCode ?? 'SERVICE_UNAVAILABLE';

    if (outcome.status === 401) {
      // 全局锁定：暂停使用该凭证的业务采集并标失效，同时递增门禁版本。
      // 本次尝试到此结束（而不是原地续命）：流的 next_due_at 决定下一轮，
      // 门禁关闭期间不再规划业务流，凭证修复后才错峰恢复。
      this.#deps.credentials.noteBusinessUnauthorized();
      const fresh = readStream(db, stream.id);
      if (fresh !== null) commitStreamAttemptError(db, fresh, errorCode, now);
      this.#deps.queue.finish(job, 'failed', errorCode);
      this.notify();
      return;
    }

    if (errorCode === 'GITHUB_RATE_LIMITED') {
      this.#deps.budget.applyQuotaExhausted();
      const fresh = readStream(db, stream.id);
      if (fresh !== null) commitStreamAttemptError(db, fresh, errorCode, now);
      this.#deps.queue.retryOrFail(job, errorCode);
      return;
    }

    if (outcome.retryable) {
      // 重试期间也要让"已知失败"立即可见，但不改变基线与周期计划；
      // 阶梯耗尽则结束本轮并推进周期计划，否则 next_due_at 停留在过去，
      // 下一轮规划会立即重新入队，把 1/5/15 分钟退避阶梯无限重放。
      const fresh = readStream(db, stream.id);
      const { retried } = this.#deps.queue.retryOrFail(job, errorCode);
      if (fresh !== null) {
        if (retried) {
          commitStreamAttemptError(db, fresh, errorCode, now);
        } else {
          commitStreamFailure(db, fresh, errorCode, now, now + intervalMs);
        }
      }
      return;
    }

    // 空仓库/空分支是"确定为空"的合法结果；空数组由客户端透出 BRANCH_EMPTY，
    // GitHub 对空仓库的 commits 返回 409。按"确定空"写空基线，而不是判结构异常。
    // 409 只对分支流这样处理：分支请求派发前 metadata 身份门禁已先行成功。
    if (stream.kind === 'branch' && (errorCode === 'BRANCH_EMPTY' || outcome.status === 409)) {
      const fresh = readStream(db, stream.id);
      if (fresh !== null) commitEmptyBaseline(db, fresh, now, nextDueAt);
      this.#deps.queue.finish(job, 'succeeded', null);
      return;
    }

    // latest 返回 404：可能是没有官方 latest，也可能是权限问题，不能直接写空基线。
    if (stream.kind === 'release' && outcome.status === 404) {
      const hasPrereleaseStream = db
        .select({ id: monitorStreams.id })
        .from(monitorStreams)
        .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.kind, 'prerelease')))
        .get();
      const fresh = readStream(db, stream.id);
      if (fresh === null) {
        this.#deps.queue.finish(job, 'skipped', 'STREAM_UNAVAILABLE');
        return;
      }
      // 先记录待确认标记：列表确认失败时保留旧状态与重试计划。
      commitStreamFailure(db, fresh, 'LATEST_NOT_FOUND', now, now + intervalMs);
      if (hasPrereleaseStream === undefined) {
        // 没有预发布流可分摊：本 job 的 latest 请求已 404，这里发本轮唯一一次列表请求确认。
        await this.#confirmLatestWithList(job, target, now, nextDueAt);
      }
      // 有预发布流时同轮最多请求一次列表：交给预发布流确认可访问性。
      this.#deps.queue.finish(job, 'succeeded', null);
      return;
    }

    // 导入占位仓库的确认失败：非重试的终态错误立即释放占位与名额；
    // 只有网络/5xx 这类可重试错误允许保留占位并按重试规则等待，最长 24 小时。
    const repo = db
      .select({ verificationState: repositories.verificationState })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .get();
    if (repo !== undefined && repo.verificationState === 'pending') {
      this.#releaseDeniedPlaceholder(repoId, errorCode, now);
      this.#deps.queue.finish(job, 'succeeded', errorCode);
      return;
    }

    const retryDelay =
      errorCode === 'GITHUB_ACCESS_DENIED_OR_MISSING' ? 24 * HOUR_MS : intervalMs;
    const fresh = readStream(db, stream.id);
    if (fresh !== null) {
      commitStreamFailure(db, fresh, errorCode, now, now + retryDelay);
    }
    this.#deps.queue.finish(job, 'succeeded', errorCode);
  }

  /**
   * latest 404 且没有预发布流时的同轮列表确认。
   *
   * 本 job 的 latest 请求已 404，因此这是本轮唯一一次列表请求：待确认标记已写入，
   * 列表成功则复用 #resolvePendingLatestConfirmation 的空基线/异常判定；失败保留旧状态。
   * 列表请求同样先取得预算令牌并受门禁约束。
   */
  async #confirmLatestWithList(job: JobRow, target: StreamTarget, now: number, nextDueAt: number): Promise<void> {
    if (!this.#deps.credentials.isReady()) return;
    // 同轮确认只让位于真实配额耗尽与全局退避：上一个 latest 响应
    // 可能已把 remaining 归零或触发 Retry-After。正常的 U/W 起始间隔不阻塞——
    // 列表确认本来就算作同轮的第二次请求。
    if (this.#deps.budget.isBackingOff()) return;
    if (!this.#deps.budget.canUseReservedBudget()) return;
    const gateRevisionAtRequest = this.#deps.credentials.gateRevision();
    const [owner = '', name = ''] = target.fullName.split('/');
    this.#deps.budget.recordRequestStart();
    this.#lastRequestAt = this.#deps.now();
    const startedAt = this.#deps.now();
    const outcome = await this.#deps.client.get<PrereleaseProjection>({
      path: buildPath('/repos/{owner}/{repo}/releases', { owner, repo: name }),
      query: { per_page: String(PRERELEASE_WINDOW_LIMIT), page: '1' },
      projection: releaseWindowProjection(target.fullName),
      repoId: target.repoId,
      credentialRevision: this.#deps.credentials.credentialRevision(),
      token: this.#deps.credentials.readActiveToken(),
      // 确认判定需要本轮的窗口数据：304 只会给出「缓存仍有效」，无法作为确认输入，
      // 因此这里必须无条件取实体投影，否则待确认标记会跨轮卡在 304 上。
      requiresProjection: true,
    });
    this.#deps.budget.recordOutcome({ ms: this.#deps.now() - startedAt, notModified: outcome.kind === 'not_modified' });
    this.#deps.budget.observeServerDate(outcome.serverDate ?? undefined);
    this.#deps.budget.observe(outcome.rateLimit);
    if (outcome.errorCode === 'GITHUB_RATE_LIMITED') {
      // 与常规派发路径同构：明确 Retry-After 与 reset 取较晚，否则次级退避。
      this.#deps.budget.applyRetryAfter(outcome.retryAfter ?? undefined);
      this.#deps.budget.applySecondaryBackoff();
    }
    // 列表也失败：保留 LATEST_NOT_FOUND 待确认标记，下一轮再确认。
    if (outcome.kind !== 'ok' || outcome.data === null) return;
    // 请求期间的凭证门禁变化或租约变化都不写业务状态。
    if (this.#deps.credentials.gateRevision() !== gateRevisionAtRequest) return;
    if (this.#deps.queue.isCurrentAttempt(job) === false) return;
    this.#resolvePendingLatestConfirmation(target.repoId, outcome.data, now, nextDueAt);
  }

  /**
   * 导入占位仓库确认失败：非重试的终态错误（403/404、结构异常等）
   * 立即删除占位行释放名额，并把批次中对应项标为失败（错误码透传）。
   */
  #releaseDeniedPlaceholder(repoId: number, errorCode: string, now: number): void {
    const db = this.#deps.db;
    const release = db.$client.transaction(() => {
      // 镜像超时释放（releaseExpiredReservations）的逐项反馈：批次项标失败并透传错误码。
      db.update(jobGroupItems)
        .set({ status: 'failed', errorCode })
        .where(and(eq(jobGroupItems.repoId, repoId), inArray(jobGroupItems.status, ['pending', 'queued'])))
        .run();
      // 未开始任务取消；当前已领取任务由调用方结束。
      db.update(jobs)
        .set({ state: 'cancelled', finishedAt: now })
        .where(
          and(
            inArray(jobs.state, ['queued', 'retry_wait']),
            sql`${jobs.streamId} IN (SELECT id FROM monitor_streams WHERE repo_id = ${repoId})`,
          ),
        )
        .run();
      // 删除占位行释放名额；流与缓存随外键级联清理，批次项 repo_id 置 NULL 保留反馈。
      db.delete(repositories)
        .where(and(eq(repositories.id, repoId), eq(repositories.verificationState, 'pending')))
        .run();
    });
    release();
  }

  async #executeBranchList(job: JobRow): Promise<void> {
    // 分支列表任务不挂在采集流上，仓库归属由创建时写入的 continuation 提供。
    const repoId = job.repoId ?? readContinuationRepoId(job.continuationJson);
    if (repoId === null) {
      this.#deps.queue.finish(job, 'skipped', 'REPOSITORY_MISSING');
      return;
    }
    if (!this.#deps.credentials.isReady()) {
      this.#deps.queue.requeue(job, this.#deps.now() + 60 * 1000);
      return;
    }
    const repo = this.#deps.db
      .select({ canonicalName: repositories.canonicalName })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .get();
    if (repo === undefined) {
      this.#deps.queue.finish(job, 'skipped', 'REPOSITORY_DELETED');
      return;
    }
    this.#deps.budget.recordRequestStart();
    this.#lastRequestAt = this.#deps.now();
    const startedAt = this.#deps.now();
    const [owner, name] = repo.canonicalName.split('/');
    const token = this.#deps.credentials.readActiveToken();
    const outcome = await this.#deps.client.get({
      path: `/repos/${owner ?? ''}/${name ?? ''}/branches`,
      query: { per_page: '100' },
      repoId,
      credentialRevision: this.#deps.credentials.credentialRevision(),
      token,
      projection: {
        parse: (payload) =>
          Array.isArray(payload)
            ? (payload as unknown[]).flatMap((entry) => {
                const candidate = entry as { name?: unknown };
                return typeof candidate.name === 'string' ? [{ name: candidate.name }] : [];
              })
            : [],
      },
    });
    // 分支列表请求同样计入吞吐观测：速率、304 比例与平均延迟不能漏掉这一类出站。
    this.#deps.budget.recordOutcome({ ms: this.#deps.now() - startedAt, notModified: outcome.kind === 'not_modified' });
    this.#deps.budget.observeServerDate(outcome.serverDate ?? undefined);
    this.#deps.budget.observe(outcome.rateLimit);
    if (outcome.kind === 'error') {
      this.#deps.queue.retryOrFail(job, outcome.errorCode ?? 'SERVICE_UNAVAILABLE');
      return;
    }
    this.#deps.queue.finish(job, 'succeeded', null);
  }

  /** 手动检测入口（管理端「立即检测」与测试共用）：为指定仓库的全部流立即安排一次采集。 */
  scheduleManualCheck(repoId: number, origin: 'manual' | 'recovery' = 'manual'): number[] {
    const now = this.#deps.now();
    const repo = this.#deps.db
      .select({ verificationState: repositories.verificationState, blockedReason: repositories.blockedReason })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .get();
    if (repo === undefined) return [];
    // 身份失配、未验证等系统阻塞下不创建任务：否则界面显示"已排队"，
    // 任务却因队列过滤永远不被领取，还会占住该流的去重键。
    if (repo.verificationState !== 'verified' || repo.blockedReason !== null) {
      throw new AppError('GITHUB_ACCESS_DENIED_OR_MISSING', '该仓库当前不可检测');
    }
    ensureStreams(this.#deps.db, repoId, now);
    const streams = this.#deps.db
      .select({
        id: monitorStreams.id,
        kind: monitorStreams.kind,
        configRevision: monitorStreams.configRevision,
        lastSuccessAt: monitorStreams.lastSuccessAt,
      })
      .from(monitorStreams)
      .where(eq(monitorStreams.repoId, repoId))
      .all();
    const jobIds: number[] = [];
    for (const stream of streams) {
      if (now - (stream.lastSuccessAt ?? 0) < MANUAL_REUSE_WINDOW_MS) {
        continue;
      }
      const { jobId } = this.#deps.queue.enqueue({
        kind: stream.kind as JobKind,
        queueClass: 'manual',
        origin,
        dueAt: now,
        streamId: stream.id,
        dedupeKey: `stream:${stream.id}`,
        pauseOverride: origin === 'manual',
        configRevision: stream.configRevision,
      });
      jobIds.push(jobId);
    }
    this.notify();
    return jobIds;
  }

  /** 首次初始化调度：新增流从错峰桶开始，不立即发起全部请求。 */
  scheduleNewRepository(repoId: number): void {
    const now = this.#deps.now();
    ensureStreams(this.#deps.db, repoId, now);
    const intervalMs = streamIntervalMs(this.#deps.db, repoId);
    const streams = this.#deps.db
      .select({ id: monitorStreams.id, phaseSeed: monitorStreams.phaseSeed, nextDueAt: monitorStreams.nextDueAt })
      .from(monitorStreams)
      .where(eq(monitorStreams.repoId, repoId))
      .all();
    for (const stream of streams) {
      if (stream.nextDueAt !== null) continue;
      this.#deps.db
        .update(monitorStreams)
        .set({ nextDueAt: initialDueAt(stream.phaseSeed, now, intervalMs) })
        .where(eq(monitorStreams.id, stream.id))
        .run();
    }
    this.notify();
  }
}

export function readContinuationRepoId(continuationJson: string | null): number | null {
  if (continuationJson === null) return null;
  try {
    const parsed = JSON.parse(continuationJson) as { repoId?: unknown };
    return typeof parsed.repoId === 'number' ? parsed.repoId : null;
  } catch {
    return null;
  }
}

export type DiscoveryScheduleDecision = 'idle' | 'defer' | 'start';

/**
 * 每日趋势的调度判定。
 *
 * - 首次登记：只登记下一次尝试时间（首次部署用短延迟，之后是每日窗口）；
 * - 未到点：等待；
 * - 已到点但门禁未就绪：顺延一小时，避免每个 tick 重试；
 * - 已到点且门禁就绪：先推进计划再返回 start（失败不会立刻重试）。
 *
 * `hasPublished` 看的是「是否已有任意一份报告」，与发现的「已有活跃代次」同构。
 */
export function planTrendsSchedule(db: Database, now: number, gateReady: boolean): DiscoveryScheduleDecision {
  const row = db.$client
    .prepare(
      `SELECT discovery_offset_seconds AS offset,
              trends_next_run_at AS next,
              (SELECT COUNT(*) FROM daily_trend_runs) AS published
         FROM settings WHERE id = 1`,
    )
    .get() as { offset: number; next: number | null; published: number } | undefined;
  if (row === undefined) return 'idle';

  const hasPublished = row.published > 0;
  if (row.next === null) {
    db.$client
      .prepare('UPDATE settings SET trends_next_run_at = ? WHERE id = 1')
      .run(nextTrendsAttempt(now, row.offset, hasPublished, true));
    return 'idle';
  }
  if (row.next > now) return 'idle';
  if (!gateReady) {
    db.$client.prepare('UPDATE settings SET trends_next_run_at = ? WHERE id = 1').run(now + HOUR_MS);
    return 'defer';
  }

  db.$client
    .prepare('UPDATE settings SET trends_next_run_at = ? WHERE id = 1')
    .run(nextTrendsAttempt(now + MINUTE_MS, row.offset, hasPublished, false));
  return 'start';
}

/**
 * 每日发现导入的调度判定。
 *
 * - 未启用发现模块：不动；
 * - 首次登记：只登记下一次尝试时间，不立即导入；
 * - 未到点：等待；
 * - 已到点但业务门禁未就绪：导入暂停（raw 下载不需要 PAT 也不能绕开必填凭证），
 *   计划顺延一小时，避免每个 tick 重试；
 * - 已到点且门禁就绪：先把计划推进到下一次尝试再返回 start（导入失败不会立刻重试）。
 *
 * 下一次尝试时间由 `nextDiscoveryAttempt` 决定：已有活跃代次时是下个每日窗口，
 * 尚无任何代次时是首次/重试的短延迟——否则首次部署最多要空等近 24 小时。
 */
export function planDiscoverySchedule(db: Database, now: number, gateReady: boolean): DiscoveryScheduleDecision {
  const row = db.$client
    .prepare(
      `SELECT discovery_enabled AS enabled, discovery_offset_seconds AS offset,
              discovery_next_run_at AS next, active_discovery_run_id AS active
         FROM settings WHERE id = 1`,
    )
    .get() as { enabled: number; offset: number; next: number | null; active: number | null } | undefined;
  if (row === undefined || row.enabled !== 1) return 'idle';

  const hasPublished = row.active !== null;
  if (row.next === null) {
    db.$client
      .prepare('UPDATE settings SET discovery_next_run_at = ? WHERE id = 1')
      .run(nextDiscoveryAttempt(now, row.offset, hasPublished, true));
    return 'idle';
  }
  if (row.next > now) return 'idle';
  if (!gateReady) {
    db.$client.prepare('UPDATE settings SET discovery_next_run_at = ? WHERE id = 1').run(now + HOUR_MS);
    return 'defer';
  }

  // 先推进计划再启动，导入失败不会造成下一轮立刻重试。
  db.$client
    .prepare('UPDATE settings SET discovery_next_run_at = ? WHERE id = 1')
    .run(nextDiscoveryAttempt(now + MINUTE_MS, row.offset, hasPublished, false));
  return 'start';
}

export function enabledRepositoryIds(db: Database): number[] {
  return db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.enabled, true))
    .all()
    .map((row) => row.id);
}

export function readSettings(db: Database): { defaultIntervalHours: number; discoveryEnabled: boolean; revision: number; pinsRevision: number } {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (row === undefined) throw new Error('settings 单例行缺失');
  return {
    defaultIntervalHours: row.defaultIntervalHours,
    discoveryEnabled: row.discoveryEnabled,
    revision: row.revision,
    pinsRevision: row.pinsRevision,
  };
}

export function activeJobsForRepositories(db: Database, repoIds: number[]): Map<number, JobRow['state']> {
  const result = new Map<number, JobRow['state']>();
  if (repoIds.length === 0) return result;
  const rows = db.$client
    .prepare(
      `SELECT s.repo_id AS repo_id, j.state AS state
         FROM jobs j JOIN monitor_streams s ON s.id = j.stream_id
        WHERE j.state IN ('queued', 'running', 'retry_wait') AND s.repo_id IN (${repoIds.map(() => '?').join(',')})`,
    )
    .all(...repoIds) as { repo_id: number; state: JobRow['state'] }[];
  for (const row of rows) {
    const current = result.get(row.repo_id);
    // running 优先级最高：查询没有 ORDER BY，后出现的 queued/retry_wait 不能盖掉正在执行的状态。
    if (current === undefined || (current !== 'running' && row.state === 'running')) {
      result.set(row.repo_id, row.state);
    }
  }
  return result;
}
