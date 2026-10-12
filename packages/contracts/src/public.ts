import { z } from 'zod';

/**
 * `z.strictObject` 严格模式：未知字段拒绝 400，不做 strip 后继续执行。
 * 这里只放 API 边界真正会复用的形状，不预先发明后续模块的字段。
 */

const ISO_8601_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** API 时间字段统一为 ISO 8601 UTC；服务端当前时间用 HTTP Date 头提供。 */
export const Iso8601Utc = z.string().regex(ISO_8601_UTC, '必须是 ISO 8601 UTC 时间');

/** 趋势分桶日期固定为北京时间日历日。 */
export const CalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD');

export const TrendPoint = z.strictObject({
  day: CalendarDay,
  stars: z.number().int().min(0),
  forks: z.number().int().min(0),
});
export type TrendPoint = z.infer<typeof TrendPoint>;

/** 聚合状态优先级见 domain/status.ts。 */
export const RepositoryStatus = z.enum([
  'pending',
  'healthy',
  'partial',
  'stale',
  'error',
  'paused',
]);
export type RepositoryStatus = z.infer<typeof RepositoryStatus>;

export const ReleaseSummary = z.strictObject({
  version: z.string().min(1),
  publishedAt: Iso8601Utc,
  url: z.string().min(1),
});
export type ReleaseSummary = z.infer<typeof ReleaseSummary>;

/** 预发布是独立可选流，窗口固定覆盖发布列表前 20 条。 */
export const PrereleaseSummary = z.strictObject({
  candidate: ReleaseSummary.nullable(),
  coverage: z.strictObject({
    limit: z.number().int().positive(),
    observedCount: z.number().int().min(0),
    mayHaveMore: z.boolean(),
  }),
});
export type PrereleaseSummary = z.infer<typeof PrereleaseSummary>;

export const BranchSummary = z.strictObject({
  name: z.string().min(1),
  /**
   * 已初始化但分支暂无提交（空基线）时为 null，前端显示“暂无提交”；
   * 与 Releases 的“暂无 Release”同形。
   */
  committedAt: Iso8601Utc.nullable(),
  url: z.string().min(1),
});
export type BranchSummary = z.infer<typeof BranchSummary>;

/**
 * 公开仓库 DTO 字段白名单。
 * 不含 editRevision、canManage、operationId、任务错误原文、代理或 Token 信息。
 */
export const PublicRepository = z.strictObject({
  id: z.string().min(1),
  fullName: z.string().min(1),
  displayName: z.string().nullable(),
  note: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().min(1),
  ownerAvatarUrl: z.string().nullable(),
  isPrivate: z.boolean(),
  language: z.string().nullable(),
  labels: z.array(z.string()),
  pinned: z.boolean(),
  stars: z.number().int().min(0),
  forks: z.number().int().min(0),
  status: RepositoryStatus,
  hasRecentChange: z.boolean(),
  lastChangeDetectedAt: Iso8601Utc.nullable(),
  changeExpiresAt: Iso8601Utc.nullable(),
  latestRelease: ReleaseSummary.nullable(),
  recentPrerelease: PrereleaseSummary.nullable(),
  branches: z.array(BranchSummary),
  lastCheckedAt: Iso8601Utc.nullable(),
  trends: z.array(TrendPoint),
});
export type PublicRepository = z.infer<typeof PublicRepository>;

/** GET /public/config 只返回白名单展示配置，不含任何凭证或调度细节。 */
export const PublicConfig = z.strictObject({
  title: z.string().min(1),
  discoveryEnabled: z.boolean(),
  displayTimeZone: z.literal('Asia/Shanghai'),
  repositoryLimit: z.number().int().positive(),
  /**
   * 前台通用数据状态：只说明尚未初始化或数据陈旧，绝不带 Token 原因、
   * 到期时间或账号信息。
   */
  overallState: z.enum(['ready', 'initializing', 'stale']),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** GET /public/repositories/:id/metrics 的响应形状。 */
export const MetricsResponse = z.strictObject({
  data: z.array(TrendPoint),
  meta: z.strictObject({ days: z.number().int().positive() }),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;

export const PublicLabel = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().nullable(),
});
export type PublicLabel = z.infer<typeof PublicLabel>;
