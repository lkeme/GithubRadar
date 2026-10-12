import { z } from 'zod';

import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, SEARCH_MAX_LENGTH } from './limits.js';
import { PublicConfig, PublicLabel, PublicRepository } from './public.js';

/** 成功格式统一为 `{ data, meta }`。 */
export const ListMeta = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX),
  total: z.number().int().min(0),
});
export type ListMeta = z.infer<typeof ListMeta>;

export const EmptyMeta = z.strictObject({});
export type EmptyMeta = z.infer<typeof EmptyMeta>;

/**
 * 查询参数永远是字符串。这里显式解析并拒绝非正整数，不依赖隐式强制转换，
 * 也不让 `?page=1.5`、`?page=-1` 之类输入落到 SQL。
 */
const queryInt = z
  .string()
  .regex(/^[1-9][0-9]*$/, '必须是正整数')
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value), '超出安全整数范围');

const queryFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** 排序白名单；置顶始终优先，默认排序的 NULLS LAST 规则由服务端显式实现。 */
export const RepositorySort = z.enum(['default', 'stars', 'name', 'sourceActivity']);
export type RepositorySort = z.infer<typeof RepositorySort>;

export const MonitoringFilter = z.enum(['all', 'active', 'paused']);
export type MonitoringFilter = z.infer<typeof MonitoringFilter>;

export const RepositoryListQuery = z.strictObject({
  q: z.string().max(SEARCH_MAX_LENGTH).optional(),
  /** 逗号分隔的标签名，服务端再规范化为数组。 */
  labels: z.string().max(1024).optional(),
  pinned: queryFlag.optional(),
  changed: queryFlag.optional(),
  monitoring: MonitoringFilter.optional(),
  sort: RepositorySort.optional(),
  /**
   * 趋势窗口（7/30/90/365 天）。列表一次返回本页仓库在该窗口内的降采样点，
   * 因此切换区间仍然只有一个请求，不会退化成每卡片一个请求。
   */
  days: z.enum(['7', '30', '90', '365']).optional(),
  page: queryInt.optional(),
  pageSize: queryInt
    .refine((value) => value <= PAGE_SIZE_MAX, `pageSize 最大 ${PAGE_SIZE_MAX}`)
    .optional(),
});
export type RepositoryListQuery = z.infer<typeof RepositoryListQuery>;

/** 服务端在服务端侧应用默认值，避免契约与实现两处各写一份默认值。 */
export const REPOSITORY_LIST_DEFAULTS = {
  page: 1,
  pageSize: PAGE_SIZE_DEFAULT,
  monitoring: 'all' satisfies MonitoringFilter,
  sort: 'default' satisfies RepositorySort,
  days: 30,
} as const;

export const RepositoryListResponse = z.strictObject({
  data: z.array(PublicRepository),
  meta: ListMeta,
});
export type RepositoryListResponse = z.infer<typeof RepositoryListResponse>;

export const LabelListResponse = z.strictObject({
  data: z.array(PublicLabel),
  meta: EmptyMeta,
});
export type LabelListResponse = z.infer<typeof LabelListResponse>;

export const ConfigResponse = z.strictObject({
  data: PublicConfig,
  meta: EmptyMeta,
});
export type ConfigResponse = z.infer<typeof ConfigResponse>;
