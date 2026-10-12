import { CONTROL_OPERATIONS_PER_MINUTE, CONTROL_OPERATION_WINDOW_MS, PERIODIC_BUDGET_RATIO, RESERVE_BUDGET_RATIO } from './constants.js';

/**
 * 相位规划。
 *
 * 周期任务按到期相位错峰，而不是给所有请求加一个固定间隔：
 * 只有 1 个仓库、24 小时档、每轮 4 个请求时平均间隔是 6 小时，
 * 若当成全局限速，首次初始化会在首个请求之后白等 18 小时。
 * 最小请求间隔与配额门禁由 budget 模块负责，两者互不替代。
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

/** 同档位内把仓库轮次分散到 30 个分钟桶，再加确定性秒偏移。 */
export const BUCKETS_PER_HOUR = 30;

export function phaseSeedFor(githubId: number): number {
  // 稳定相位种子：同一个仓库在任何一次重启后都落在同一桶。
  let value = Math.imul(githubId ^ 0x9e3779b9, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return Math.abs(value);
}

export function bucketFor(seed: number, buckets: number): number {
  return seed % buckets;
}

export function secondOffsetFor(seed: number): number {
  // 桶内确定性秒偏移，避免同桶仓库在同一秒并发。
  return Math.floor(seed / 31) % 60;
}

/**
 * 按原计划相位推进：`next_due_at = previous_due + k × period`，
 * k 是使其晚于当前时间的最小正整数；不按完成时间无限漂移，也不补执行所有错过的周期。
 */
export function advanceDueAt(previousDueAt: number, periodMs: number, now: number): number {
  if (periodMs <= 0) return now + HOUR_MS;
  // 原计划仍在将来时保持原相位，不因为提前完成而漂移。
  if (previousDueAt > now) return previousDueAt;
  const missed = Math.floor((now - previousDueAt) / periodMs);
  return previousDueAt + (missed + 1) * periodMs;
}

/** 首次入队：落在当前时间之后最近的 bucket 边界上，桶内再加确定性秒偏移。 */
export function initialDueAt(seed: number, now: number, periodMs: number): number {
  const buckets = Math.max(1, Math.min(BUCKETS_PER_HOUR, Math.floor(periodMs / MINUTE_MS) || 1));
  const bucket = bucketFor(seed, buckets);
  const offsetMs = secondOffsetFor(seed) * 1000;
  const positionInPeriod = (now + offsetMs) % periodMs;
  const target = bucket * (periodMs / buckets);
  const delta = target > positionInPeriod ? target - positionInPeriod : periodMs - positionInPeriod + target;
  return now + delta;
}

/** 周期采集最多规划为配额的 60%，手动/初始化/重试预留 20%，最后 20% 保持余量。 */
export function plannedCapacity(limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.floor(limit * PERIODIC_BUDGET_RATIO);
}

export function reservedBudget(limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.ceil(limit * RESERVE_BUDGET_RATIO);
}

/**
 * 控制操作派发门禁：管理发起的控制操作每分钟最多 2 个。
 *
 * `activeTimes` 必须是**已经裁剪到窗口内**的派发时刻（升序）。返回下一个允许派发的时间；
 * 未达上限时返回 0，表示不受此门禁限制（仍受全局节奏与退避约束）。
 */
export function controlDispatchGate(activeTimes: readonly number[], now: number): number {
  const windowed = activeTimes.filter((at) => at > now - CONTROL_OPERATION_WINDOW_MS);
  if (windowed.length < CONTROL_OPERATIONS_PER_MINUTE) return 0;
  return (windowed[0] ?? now) + CONTROL_OPERATION_WINDOW_MS;
}

/** 上游在 UTC 01:00 运行；本系统在北京时间 10:00（＝UTC 02:00）附近错峰检查。 */
export const DISCOVERY_WINDOW_UTC_MS = 2 * HOUR_MS;

/**
 * 尚无任何已发布代次时的首次导入延迟。
 * 每日窗口最多可能刚过去近 24 小时，首次部署若等到下个窗口，"项目发现"会整天空白，
 * 因此第一次导入在门禁就绪后的小延迟内执行，成功发布后才回到每日窗口。
 */
export const DISCOVERY_FIRST_RUN_DELAY_MS = 2 * MINUTE_MS;

/**
 * 仍无已发布代次时的重试间隔。
 * 首次导入失败不能等到下个每日窗口（同样是近 24 小时空白），但也要避免把上游打穿。
 */
export const DISCOVERY_RETRY_DELAY_MS = 30 * MINUTE_MS;

/**
 * 下一个每日导入窗口：`UTC 02:00 + 部署稳定偏移`。
 * 偏移在库创建时随机生成并持久化，因此同一部署每天落在同一分钟，不同部署互不重叠。
 */
export function nextDiscoveryWindow(now: number, offsetSeconds: number): number {
  const dayMs = 24 * HOUR_MS;
  const base = DISCOVERY_WINDOW_UTC_MS + Math.max(0, offsetSeconds) * 1000;
  const dayStart = now - (now % dayMs);
  const candidate = dayStart + base;
  return candidate > now ? candidate : candidate + dayMs;
}

/**
 * 导入计划推进：已有活跃代次时用每日窗口，否则按"尽快拿到第一份数据"处理。
 * `hasPublished` 为 false 表示当前没有活跃代次（从未导入成功，或上一代次已被替换失败）。
 */
export function nextDiscoveryAttempt(
  now: number,
  offsetSeconds: number,
  hasPublished: boolean,
  firstRun: boolean,
): number {
  if (hasPublished) return nextDiscoveryWindow(now, offsetSeconds);
  return now + (firstRun ? DISCOVERY_FIRST_RUN_DELAY_MS : DISCOVERY_RETRY_DELAY_MS);
}
