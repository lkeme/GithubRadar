import { CLOCK_ANOMALY_TOLERANCE_MS } from './constants';

/**
 * 相对时间：
 * - `describeDelta` 只负责“算出差值并归类”；`formatDescribedDelta` 只负责格式化；
 *   格式化器自身不计算时间差，两者由组件组合（components/RelativeTime.tsx）。
 * - 使用 `Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })`：-1 天得到“昨天”、-2 天得到“前天”。
 * - 小于 60 秒“刚刚”；1–59 分钟、1–23 小时取整；达到整天后按浏览器时区日历日规则；
 *   月/年使用日历差而非固定 30/365 天；未知显示“—”。
 * - 两类语义分开：`describeDelta` 用于上游来源时间（发布/提交/检查），未来超容差显示“时间异常”；
 *   `describeScheduledDelta` 用于本系统计划/到期时间（下次复核、配额重置、任务到期、退避截止），
 *   未来值是正常的，显示“X 后”，过去值按常规相对时间回落（逾期未执行一眼可读）。
 */

export type RelativeUnit = Intl.RelativeTimeFormatUnit;

export type DescribedDelta =
  | { kind: 'unknown' }
  | { kind: 'justNow' }
  | { kind: 'anomaly' }
  | { kind: 'value'; value: number; unit: RelativeUnit };

const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
/**
 * 准确时间提示。
 *
 * 注意：`dateStyle`/`timeStyle` 不能与 `timeZoneName` 等组件选项同时出现，
 * 否则 Intl 会抛 `TypeError: Invalid option`（整页白屏）。这里改用组件字段，
 * 语义等价且能带上时区名——按规范要求，准确时间必须显式可读。
 */
const absoluteFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

function localDayNumber(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** 浏览器时区的日历日差（later - earlier，按日历日而非固定 24 小时）。 */
export function localCalendarDayDiff(laterMs: number, earlierMs: number): number {
  return Math.max(0, Math.round(localDayNumber(laterMs) - localDayNumber(earlierMs)));
}

/** 浏览器时区的日历月差（不足整月向下取整）。 */
export function localCalendarMonthDiff(laterMs: number, earlierMs: number): number {
  const later = new Date(laterMs);
  const earlier = new Date(earlierMs);
  let months = (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
  if (later.getDate() < earlier.getDate()) {
    months -= 1;
  }
  return Math.max(0, months);
}

export function parseIso(iso: string | null | undefined): number {
  if (!iso) {
    return Number.NaN;
  }
  return Date.parse(iso);
}

export function describeDelta(targetMs: number, nowMs: number): DescribedDelta {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) {
    return { kind: 'unknown' };
  }
  const delta = targetMs - nowMs;
  if (delta > CLOCK_ANOMALY_TOLERANCE_MS) {
    return { kind: 'anomaly' };
  }
  if (delta >= 0) {
    return { kind: 'justNow' };
  }
  const past = -delta;
  if (past < 60_000) {
    return { kind: 'justNow' };
  }
  const minutes = Math.round(past / 60_000);
  if (minutes < 60) {
    return { kind: 'value', value: -Math.max(1, minutes), unit: 'minute' };
  }
  const hours = Math.round(past / 3_600_000);
  if (hours < 24) {
    return { kind: 'value', value: -Math.max(1, hours), unit: 'hour' };
  }
  const days = localCalendarDayDiff(nowMs, targetMs);
  if (days < 7) {
    return { kind: 'value', value: -Math.max(1, days), unit: 'day' };
  }
  if (days < 30) {
    return { kind: 'value', value: -Math.floor(days / 7), unit: 'week' };
  }
  const months = localCalendarMonthDiff(nowMs, targetMs);
  if (months < 12) {
    return { kind: 'value', value: -Math.max(1, months), unit: 'month' };
  }
  return { kind: 'value', value: -Math.max(1, Math.floor(months / 12)), unit: 'year' };
}

export function formatDescribedDelta(described: DescribedDelta): string {
  switch (described.kind) {
    case 'unknown':
      return '—';
    case 'justNow':
      return '刚刚';
    case 'anomaly':
      return '时间异常';
    case 'value':
      return relativeFormatter.format(described.value, described.unit);
  }
}

/**
 * 计划/到期类时间：未来超容差不报“时间异常”，按“X 后”表达（Intl 正值即“后”）；
 * 容差内“刚刚”；已过去的计划时间回落 describeDelta（逾期可读）。
 */
export function describeScheduledDelta(targetMs: number, nowMs: number): DescribedDelta {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) {
    return { kind: 'unknown' };
  }
  const delta = targetMs - nowMs;
  if (delta <= CLOCK_ANOMALY_TOLERANCE_MS) {
    return describeDelta(targetMs, nowMs);
  }
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) {
    return { kind: 'value', value: Math.max(1, minutes), unit: 'minute' };
  }
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) {
    return { kind: 'value', value: Math.max(1, hours), unit: 'hour' };
  }
  const days = localCalendarDayDiff(targetMs, nowMs);
  if (days < 30) {
    return { kind: 'value', value: Math.max(1, days), unit: 'day' };
  }
  const months = localCalendarMonthDiff(targetMs, nowMs);
  if (months < 12) {
    return { kind: 'value', value: Math.max(1, months), unit: 'month' };
  }
  return { kind: 'value', value: Math.max(1, Math.floor(months / 12)), unit: 'year' };
}

export function formatAbsolute(ms: number): string {
  return Number.isFinite(ms) ? absoluteFormatter.format(ms) : '—';
}

// ---- 精确时间（北京时间）：`yyyy/MM/dd HH:mm:ss`；时分秒为 00:00:00 时只显示日期 ----

const beijingExactFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 标准北京时间格式；无时分秒（整日 0 点）时省略时间部分。 */
export function formatBeijingDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const parts = beijingExactFormatter.formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const date = `${read('year')}/${read('month')}/${read('day')}`;
  const time = `${read('hour')}:${read('minute')}:${read('second')}`;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

// ---- 趋势日期：日趋势固定按北京时间分桶 ----

const beijingDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 将毫秒时间转换为北京时间日历日 `YYYY-MM-DD`。 */
export function beijingDayString(ms: number): string {
  return beijingDayFormatter.format(new Date(ms));
}

export function beijingDayToUtcMs(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}

// 同样不能用 dateStyle 与 timeZoneName 组合；趋势日期固定按北京时间，并显式标出时区名。
const beijingDisplayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZoneName: 'short',
});

export function formatBeijingDay(day: string): string {
  const ms = beijingDayToUtcMs(day);
  return Number.isFinite(ms) ? beijingDisplayFormatter.format(new Date(ms)) : '—';
}
