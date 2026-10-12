import { z } from 'zod';

import { PAGE_SIZE_MAX } from './limits.js';
import { CalendarDay, Iso8601Utc } from './public.js';

/**
 * 每日趋势：来源仓库 `difyz9/github-trend-monitor` 的 `reports/daily-trends-YYYY-MM-DD.md`。
 *
 * 每份报告是当天 Top 20 的快照（仓库、Star、分类），与项目发现的分类 CSV 是同一来源的
 * 不同视图：CSV 给出候选全集，报告给出每日榜单。榜单内的重名仓库（同一天出现在两个分类）
 * 保留为两行，因此唯一键是名次而不是仓库名。
 */

export const DailyTrendItem = z.strictObject({
  /** 报告内名次，从 1 开始。 */
  rank: z.number().int().min(1),
  fullName: z.string().min(1),
  url: z.string().min(1),
  stars: z.number().int().min(0),
  domain: z.string().nullable(),
  /** 上一份可用报告里的名次；首次出现时为 null。 */
  previousRank: z.number().int().min(1).nullable(),
});
export type DailyTrendItem = z.infer<typeof DailyTrendItem>;

export const DailyTrendSource = z.strictObject({
  repository: z.literal('difyz9/github-trend-monitor'),
  commit: z.string(),
  commitUrl: z.string(),
  importedAt: Iso8601Utc,
  /** 最新报告日期比当前北京时间落后 2 天以上即视为陈旧。 */
  stale: z.boolean(),
  note: z.string(),
});
export type DailyTrendSource = z.infer<typeof DailyTrendSource>;

export const DailyTrendResponse = z.strictObject({
  data: z.array(DailyTrendItem),
  meta: z.strictObject({
    /** 实际返回的报告日期；尚无任何报告时为 null。 */
    day: CalendarDay.nullable(),
    /** 可选报告日期，按新到旧排列，供日期选择器使用。 */
    days: z.array(CalendarDay),
    /**
     * 当前报告之前是否还存在更早的报告。只有为 true 时 `previousRank` 才有意义：
     * 为 false 时所有条目都是首次出现，界面不应把整榜都标成"新上榜"。
     */
    hasPrevious: z.boolean(),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX),
    total: z.number().int().min(0),
    source: DailyTrendSource.nullable(),
  }),
});
export type DailyTrendResponse = z.infer<typeof DailyTrendResponse>;

/**
 * 页码上限。SQLite 的 LIMIT/OFFSET 绑定超出安全整数范围会抛 datatype mismatch，
 * 而 page 是匿名可写的公开参数：必须在这里就拒绝，不能留给下游算术。
 */
export const TRENDS_MAX_PAGE = 100_000;

export const DailyTrendQuery = z.strictObject({
  /** 报告日期（YYYY-MM-DD）；缺省或已不存在时回落到最新一份。 */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD')
    .optional(),
  page: z
    .string()
    .regex(/^[1-9][0-9]*$/, '必须是正整数')
    .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) <= TRENDS_MAX_PAGE, `page 最大 ${TRENDS_MAX_PAGE}`)
    .optional(),
  pageSize: z
    .string()
    .regex(/^[1-9][0-9]*$/, '必须是正整数')
    .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) <= PAGE_SIZE_MAX, `pageSize 最大 ${PAGE_SIZE_MAX}`)
    .optional(),
});
export type DailyTrendQuery = z.infer<typeof DailyTrendQuery>;

/** 报告里的 Star 是生成榜单时的记录值，不代表实时数据。 */
export const DAILY_TREND_STATS_NOTE = '报告中的 Star 为生成榜单时的记录值，不代表实时数据';
