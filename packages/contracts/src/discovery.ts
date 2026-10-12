import { z } from 'zod';

import { PAGE_SIZE_MAX } from './limits.js';
import { Iso8601Utc } from './public.js';

/** 发现模块。关闭时接口返回 FEATURE_DISABLED，只隐藏导航不算关闭。 */

export const DiscoveryItem = z.strictObject({
  githubId: z.string(),
  fullName: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  /** 来源记录值，采样时间未知时不展示为实时 Star。 */
  sourceStars: z.number().int().nullable(),
  sourceForks: z.number().int().nullable(),
  domains: z.array(z.string()),
  topics: z.array(z.string()),
  categories: z.array(z.string()),
  statsSampledAt: Iso8601Utc.nullable(),
  firstSeen: z.string().nullable(),
  monitored: z.boolean(),
});
export type DiscoveryItem = z.infer<typeof DiscoveryItem>;

export const DiscoveryResponse = z.strictObject({
  data: z.array(DiscoveryItem),
  meta: z.strictObject({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX),
    total: z.number().int().min(0),
    /**
     * 已启用但尚无活跃代次（首次导入未完成）时为 null：返回空列表是合法状态，
     * 不是错误，也不伪造来源信息。
     */
    source: z
      .strictObject({
        repository: z.literal('difyz9/github-trend-monitor'),
        commit: z.string(),
        commitUrl: z.string(),
        importedAt: Iso8601Utc,
        sourceUpdatedAt: Iso8601Utc.nullable(),
        fileNames: z.array(z.string()),
        stale: z.boolean(),
        note: z.string(),
      })
      .nullable(),
    /**
     * 整代数据里出现过的筛选取值：筛选下拉的选项不能从当前页推导，
     * 否则换页后选项集合会跟着当前页缩水。尚无代次时两个数组都为空。
     */
    filters: z.strictObject({
      languages: z.array(z.string()),
      categories: z.array(z.string()),
    }),
  }),
});
export type DiscoveryResponse = z.infer<typeof DiscoveryResponse>;

export const DiscoveryQuery = z.strictObject({
  q: z.string().max(100).optional(),
  language: z.string().max(64).optional(),
  category: z.string().max(64).optional(),
  page: z.string().regex(/^[1-9][0-9]*$/).optional(),
  // 与 envelope.ts 的列表分页同一口径：超限直接拒绝（400），不静默 clamp。
  pageSize: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => Number(value) <= PAGE_SIZE_MAX, `pageSize 最大 ${PAGE_SIZE_MAX}`)
    .optional(),
});
export type DiscoveryQuery = z.infer<typeof DiscoveryQuery>;
