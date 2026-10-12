import { and, eq, lt, ne } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { rateState } from '../db/schema.js';
import type { RateLimitSnapshot } from '../integrations/github/client.js';
import {
  MAX_BACKOFF_MS,
  MIN_REQUEST_INTERVAL_MS,
  SECONDARY_LIMIT_FLOOR_MS,
} from './constants.js';
import { reservedBudget } from './planner.js';

/**
 * 全局出站节奏与配额预算。
 *
 * 关键约束（不要凭直觉简化）：
 * - 剩余可用主要配额 `U = max(0, remaining - reserve)`，重置前秒数 `W`，
 *   请求起始间隔是 `max(1秒, W/U)`；**不得再叠加 `3600/R_hour` 作为全局间隔**。
 * - U=0 时等待 reset，不发起请求。
 * - 60%/20% 预算按 `account_id + rate_resource + reset_at` 记录，换同账号 PAT 不重置计费。
 * - 响应头缺失时保留最近可信状态，并按最坏一次计费扣减。
 * - 限流计时用响应 `Date` 与 reset 差校正宿主时钟偏差。
 */

const GLOBAL_ACCOUNT = '__global__';
const GLOBAL_RESOURCE = 'global';

interface LocalUsage {
  billed: number;
}

export interface BudgetState {
  readonly accountId: string | null;
  readonly resource: string;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: number | null;
  readonly observedAt: number | null;
  readonly billed: number;
  readonly backoffUntil: number;
  readonly nextRequestAt: number;
  readonly clockSkewMs: number;
}

const UNKNOWN_INTERVAL_MS = 2000;

export class RateBudget {
  readonly #db: Database;
  readonly #now: () => number;

  #accountId: string | null = null;
  #resource = 'core';
  #limit: number | null = null;
  #remaining: number | null = null;
  #resetAt: number | null = null;
  #observedAt: number | null = null;
  #billed = 0;
  #nextRequestAt = 0;
  #clockSkewMs = 0;
  /** 身份未知时沿用的进程级退避。 */
  #processBackoffUntil = 0;
  #secondaryStrikes = 0;
  readonly #samples: { at: number; ms: number; notModified: boolean }[] = [];

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    this.#loadGlobalBackoff();
  }

  #globalRow(): { backoffUntil: number } {
    const row = this.#db
      .select()
      .from(rateState)
      .where(and(eq(rateState.accountId, GLOBAL_ACCOUNT), eq(rateState.resource, GLOBAL_RESOURCE)))
      .get();
    return { backoffUntil: row?.backoffUntil ?? 0 };
  }

  #loadGlobalBackoff(): void {
    const row = this.#globalRow();
    this.#processBackoffUntil = Math.max(this.#processBackoffUntil, row.backoffUntil);
  }

  #writeGlobalBackoff(until: number): void {
    this.#db
      .insert(rateState)
      .values({
        accountId: GLOBAL_ACCOUNT,
        resource: GLOBAL_RESOURCE,
        resetAt: 0,
        backoffUntil: until,
        nextRequestAt: until,
        observedAt: this.#now(),
      })
      .onConflictDoUpdate({
        target: [rateState.accountId, rateState.resource, rateState.resetAt],
        set: { backoffUntil: until, nextRequestAt: until, observedAt: this.#now() },
      })
      .run();
  }

  /** 候选身份确认后绑定账户；未确认前不写账户维度计费。 */
  bindAccount(accountId: string | null): void {
    this.#accountId = accountId;
  }

  get accountId(): string | null {
    return this.#accountId;
  }

  get clockSkewMs(): number {
    return this.#clockSkewMs;
  }

  /** 用响应 Date 头与本地时钟的差值校正 reset 计时，避免宿主时钟漂移导致提前/延后恢复。 */
  observeServerDate(dateHeader: string | undefined): void {
    if (dateHeader === undefined || dateHeader === '') return;
    const parsed = Date.parse(dateHeader);
    if (!Number.isFinite(parsed)) return;
    const skew = parsed - this.#now();
    // 明显的解析失败或荒谬偏差不采纳。
    if (Math.abs(skew) > 24 * 60 * 60 * 1000) return;
    this.#clockSkewMs = skew;
  }

  #localUsage(resetAt: number): LocalUsage {
    if (this.#accountId === null) return { billed: this.#billed };
    const row = this.#db
      .select({ localUsageJson: rateState.localUsageJson })
      .from(rateState)
      .where(
        and(
          eq(rateState.accountId, this.#accountId),
          eq(rateState.resource, this.#resource),
          eq(rateState.resetAt, resetAt),
        ),
      )
      .get();
    if (row?.localUsageJson === null || row?.localUsageJson === undefined) return { billed: 0 };
    try {
      const parsed = JSON.parse(row.localUsageJson) as Partial<LocalUsage>;
      return { billed: typeof parsed.billed === 'number' ? parsed.billed : 0 };
    } catch {
      return { billed: 0 };
    }
  }

  #writeLocalUsage(resetAt: number, usage: LocalUsage): void {
    if (this.#accountId === null) return;
    const now = this.#now();
    // 账户行可能还不存在（首次观察该 reset 周期），因此必须 upsert：
    // 只做 UPDATE 会让本地计费永远留在内存里，换进程就丢失。
    this.#db
      .insert(rateState)
      .values({
        accountId: this.#accountId,
        resource: this.#resource,
        resetAt,
        observedCredentialRevision: null,
        limitValue: this.#limit,
        remaining: this.#remaining,
        localUsageJson: JSON.stringify(usage),
        observedAt: now,
        backoffUntil: 0,
        nextRequestAt: this.#nextRequestAt,
      })
      .onConflictDoUpdate({
        target: [rateState.accountId, rateState.resource, rateState.resetAt],
        set: {
          localUsageJson: JSON.stringify(usage),
          limitValue: this.#limit,
          remaining: this.#remaining,
          nextRequestAt: this.#nextRequestAt,
          observedAt: now,
        },
      })
      .run();
  }

  /**
   * 观察响应头。3xx/4xx 也带配额头，因此任何响应都应记录。
   *
   * 时间基准约定（必须统一，否则校正会互相抵消或反向）：
   * `#resetAt` 存的是**换算到本地时钟**的 reset 时刻，即 `上游 epoch - clockSkewMs`。
   * 之后所有读取都直接用 `#resetAt`，不再二次减 skew。
   */
  observe(snapshot: RateLimitSnapshot | null): void {
    if (snapshot === null) {
      this.#billed += 1;
      this.#recomputeNextRequestAt();
      return;
    }
    this.#resource = snapshot.resource;
    this.#limit = snapshot.limit ?? this.#limit;
    this.#remaining = snapshot.remaining;
    this.#observedAt = snapshot.observedAt;
    this.#resetAt = snapshot.resetAt === null ? this.#resetAt : snapshot.resetAt - this.#clockSkewMs;
    this.#recomputeNextRequestAt();
  }

  /** 每次请求开始先取得队列令牌，再根据响应更新配额。 */
  recordRequestStart(): void {
    if (this.#resetAt === null || this.#accountId === null) return;
    const usage = this.#localUsage(this.#resetAt);
    this.#billed = usage.billed + 1;
    this.#writeLocalUsage(this.#resetAt, { billed: this.#billed });
  }

  #recomputeNextRequestAt(): void {
    const now = this.#now();
    if (this.#resetAt !== null && now >= this.#resetAt) {
      // 跨过 reset 后旧预算失效，接受一次受控引导。
      this.#remaining = null;
      this.#resetAt = null;
    }

    if (this.#remaining === null || this.#resetAt === null) {
      this.#nextRequestAt = now + UNKNOWN_INTERVAL_MS;
      return;
    }

    const reserve = reservedBudget(this.#limit);
    const usable = Math.max(0, this.#remaining - reserve);
    if (usable <= 0) {
      // 保留额度可以支撑修复控制请求，但不越过真实配额：等到 reset。
      this.#nextRequestAt = Math.max(now + MIN_REQUEST_INTERVAL_MS, this.#resetAt);
      return;
    }
    const windowSeconds = Math.max(1, (this.#resetAt - now) / 1000);
    const intervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, (windowSeconds / usable) * 1000);
    this.#nextRequestAt = now + intervalMs;
  }

  /** 修复类控制请求可以动用本地保留额度，但仍受真实配额与退避约束。 */
  canUseReservedBudget(): boolean {
    return this.#remaining === null || this.#remaining > 0;
  }

  nextRequestAt(): number {
    const now = this.#now();
    if (this.#resetAt !== null && this.#remaining !== null && this.#remaining <= 0) {
      return Math.max(now + MIN_REQUEST_INTERVAL_MS, this.#resetAt);
    }
    return this.#nextRequestAt;
  }

  backoffUntil(): number {
    return Math.max(this.#processBackoffUntil, this.#globalRow().backoffUntil);
  }

  isBackingOff(): boolean {
    return this.#now() < this.backoffUntil();
  }

  /** 明确 Retry-After（秒或 HTTP 日期）。 */
  applyRetryAfter(header: string | undefined): void {
    if (header === undefined || header === '') return;
    const seconds = Number(header);
    let until: number | null = null;
    if (Number.isFinite(seconds) && seconds >= 0) {
      until = this.#now() + seconds * 1000;
    } else {
      const parsed = Date.parse(header);
      // 上游给出的绝对时间同样换算到本地时钟。
      if (Number.isFinite(parsed)) until = parsed - this.#clockSkewMs;
    }
    if (until === null) return;
    // remaining=0 时等待 reset；两者同时存在取较晚时间。
    const candidate = Math.max(until, this.#resetAt ?? 0);
    this.#setBackoff(candidate);
  }

  /** 次级限流且无明确时间：至少 60 秒，指数退避带抖动，最多 1 小时。 */
  applySecondaryBackoff(): void {
    this.#secondaryStrikes += 1;
    const base = SECONDARY_LIMIT_FLOOR_MS * 2 ** (this.#secondaryStrikes - 1);
    const jitter = Math.floor(Math.random() * 5_000);
    this.#setBackoff(this.#now() + Math.min(base + jitter, MAX_BACKOFF_MS));
  }

  /** 配额耗尽：等到 reset，而不是无限重试。 */
  applyQuotaExhausted(): void {
    if (this.#resetAt !== null) this.#setBackoff(this.#resetAt);
  }

  #setBackoff(until: number): void {
    this.#processBackoffUntil = Math.max(this.#processBackoffUntil, until);
    this.#writeGlobalBackoff(this.#processBackoffUntil);
  }

  /** 越过当前退避期后清零次级限流计数；不清除账户级有效限流截止时间。 */
  clearSecondaryStrikes(): void {
    if (this.#secondaryStrikes > 0 && this.#now() >= this.#processBackoffUntil) {
      this.#secondaryStrikes = 0;
    }
  }

  /**
   * 记录一次实际出站的耗时与是否命中 304，用于后台诊断（304 比例、延迟）。
   * 只保留最近一小时、最多 5000 个样本，避免长期运行占内存。
   */
  recordOutcome(input: { ms: number; notModified: boolean }): void {
    const at = this.#now();
    this.#samples.push({ at, ms: Math.max(0, input.ms), notModified: input.notModified });
    const cutoff = at - 60 * 60 * 1000;
    while (this.#samples.length > 0 && (this.#samples[0]?.at ?? 0) < cutoff) {
      this.#samples.shift();
    }
    if (this.#samples.length > 5000) {
      this.#samples.splice(0, this.#samples.length - 5000);
    }
  }

  throughput(): { requestsPerHour: number; notModifiedRatio: number | null; averageLatencyMs: number | null } {
    if (this.#samples.length === 0) {
      return { requestsPerHour: 0, notModifiedRatio: null, averageLatencyMs: null };
    }
    const now = this.#now();
    const first = this.#samples[0]?.at ?? now;
    const elapsedMs = Math.max(60_000, now - first);
    const notModified = this.#samples.filter((sample) => sample.notModified).length;
    const latency = this.#samples.reduce((sum, sample) => sum + sample.ms, 0);
    return {
      // 按观测窗口折算的小时速率；运行不足一小时时会偏保守地以 1 分钟为下限。
      requestsPerHour: Math.round((this.#samples.length * 3_600_000) / elapsedMs),
      notModifiedRatio: notModified / this.#samples.length,
      averageLatencyMs: Math.round(latency / this.#samples.length),
    };
  }

  state(): BudgetState {
    return {
      accountId: this.#accountId,
      resource: this.#resource,
      limit: this.#limit,
      remaining: this.#remaining,
      resetAt: this.#resetAt,
      observedAt: this.#observedAt,
      billed: this.#billed,
      backoffUntil: this.backoffUntil(),
      nextRequestAt: this.nextRequestAt(),
      clockSkewMs: this.#clockSkewMs,
    };
  }

  /** 清理过期的历史计费行；全局退避行（reset_at = 0）必须保留。 */
  purgeOldWindows(now: number): number {
    return this.#db
      .delete(rateState)
      .where(
        and(lt(rateState.resetAt, now - 24 * 60 * 60 * 1000), ne(rateState.accountId, GLOBAL_ACCOUNT)),
      )
      .run().changes;
  }
}
