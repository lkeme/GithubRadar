import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import {
  DiscoveryQuery,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  REPOSITORY_LIST_DEFAULTS,
  RepositoryListQuery,
} from '@githubradar/contracts';

import { AppError } from '../http/errors.js';
import { registerRoute, type RoutePolicyGuard } from '../http/policy.js';
import type { RouteContext } from '../http/route-context.js';
import {
  listPublicLabels,
  listPublicRepositories,
  parsePublicRepoId,
  publicConfig,
  publicOverallState,
  repositoryMetrics,
} from '../domain/public.js';
import { parseParams, parseQuery } from './validation.js';
import { z } from 'zod';

/**
 * 公开只读接口。
 *
 * - 只读本地数据库：不触发采集、不续会话、不修改配置。
 * - 匿名与登录访问同一参数必须得到完全相同的 DTO，不因 Cookie 返回额外字段。
 * - 对稳定序列化的 DTO 计算 ETag，max-age 最多 30 秒，并缩短到最近一次
 *   changeExpiresAt / stale 边界；304 同样返回 Date。
 */

const MAX_PUBLIC_CACHE_SECONDS = 30;

const MetricsQuery = z.strictObject({
  days: z.enum(['7', '30', '90', '365']),
});

const RepositoryParams = z.strictObject({ id: z.string().min(1).max(64) });

export interface DiscoveryReadResult {
  readonly items: readonly unknown[];
  readonly total: number;
  readonly source: unknown;
  /** 整代数据里出现过的筛选取值（语言、分类）。 */
  readonly filters: { readonly languages: readonly string[]; readonly categories: readonly string[] };
}

/** 最近一次导入尝试的状态；与“是否已有活跃代次”无关。 */
export type DiscoveryAttemptState = 'idle' | 'running' | 'anomaly';

export interface DiscoveryStatus {
  enabled: boolean;
  state: 'disabled' | DiscoveryAttemptState;
  /** 活跃代次的完成时间；尚无代次时为 null。 */
  lastSuccessAt: number | null;
  itemsCount: number | null;
  /** 下一次计划导入时间；尚未登记计划时为 null。 */
  nextRunAt: number | null;
  /** 最近一次导入尝试（含失败原因）；从未尝试过为 null。 */
  lastAttempt: { state: DiscoveryAttemptState; errorCode: string | null; finishedAt: number | null } | null;
}

/** 读取失败时的诊断出口：路由把 request.log 包一层传进来，适配器不自己造 logger。 */
export interface DiscoveryReadLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** 发现模块以端口形式接入，便于在模块关闭或不具备时不引入额外依赖。 */
export interface DiscoveryPort {
  isEnabled(): boolean;
  read(
    query: { q?: string; language?: string; category?: string; page: number; pageSize: number },
    log?: DiscoveryReadLogger,
  ): DiscoveryReadResult | null;
  status(): DiscoveryStatus;
}

export function registerPublicRoutes(
  app: FastifyInstance,
  guard: RoutePolicyGuard,
  context: RouteContext,
  discovery: DiscoveryPort | null = null,
): void {
  const policy = { access: 'public_read', tokenGate: 'exempt', tokenGateExemptReason: 'read_only_diagnostics' } as const;
  const rateLimit = { max: 120, timeWindow: '1 minute' };

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/public/config',
    policy,
    rateLimit,
    handler: async (request, reply) => {
      const config = publicConfig(context.db);
      const overallState = publicOverallState(context.db, context.now());
      sendPublic(request, reply, { data: { ...config, overallState }, meta: {} }, MAX_PUBLIC_CACHE_SECONDS);
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/public/repositories',
    policy,
    rateLimit,
    handler: async (request, reply) => {
      const query = parseQuery(request, RepositoryListQuery);
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? PAGE_SIZE_DEFAULT;
      const labels =
        query.labels === undefined || query.labels === ''
          ? undefined
          : query.labels
              .split(',')
              .map((value) => value.trim())
              .filter((value) => value !== '');

      const now = context.now();
      const { items, total } = listPublicRepositories(
        context.db,
        {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(labels === undefined ? {} : { labels }),
          ...(query.pinned === undefined ? {} : { pinned: query.pinned }),
          ...(query.changed === undefined ? {} : { changed: query.changed }),
          monitoring: query.monitoring ?? 'all',
          sort: query.sort ?? 'default',
          days: query.days === undefined ? REPOSITORY_LIST_DEFAULTS.days : Number(query.days),
          page,
          pageSize,
        },
        now,
      );

      // 缓存不得跨过变化标记到期边界，否则浏览器会继续显示已过期的更新点。
      const maxAge = Math.min(MAX_PUBLIC_CACHE_SECONDS, secondsToNearestChangeBoundary(items, now));
      sendPublic(request, reply, { data: items, meta: { page, pageSize, total } }, maxAge);
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/public/labels',
    policy,
    rateLimit,
    handler: async (request, reply) => {
      sendPublic(request, reply, { data: listPublicLabels(context.db), meta: {} }, MAX_PUBLIC_CACHE_SECONDS);
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/public/repositories/:id/metrics',
    policy,
    rateLimit,
    handler: async (request, reply) => {
      const params = parseParams(request, RepositoryParams);
      const query = parseQuery(request, MetricsQuery);
      if (parsePublicRepoId(params.id) === null) {
        throw new AppError('NOT_FOUND', '仓库不存在');
      }
      const points = repositoryMetrics(context.db, params.id, Number(query.days), context.now());
      if (points === null) {
        throw new AppError('NOT_FOUND', '仓库不存在');
      }
      sendPublic(request, reply, { data: points, meta: { days: Number(query.days) } }, MAX_PUBLIC_CACHE_SECONDS);
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/public/discovery',
    policy,
    rateLimit,
    handler: async (request, reply) => {
      // 关闭发现模块同时关闭其 API 数据返回，不能只隐藏导航。
      if (discovery === null || !discovery.isEnabled()) {
        throw new AppError('FEATURE_DISABLED', '项目发现功能未启用');
      }
      const query = parseQuery(request, DiscoveryQuery);
      const page = query.page === undefined ? 1 : Number(query.page);
      const pageSize = Math.min(query.pageSize === undefined ? PAGE_SIZE_DEFAULT : Number(query.pageSize), PAGE_SIZE_MAX);
      const result = discovery.read(
        {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.language === undefined ? {} : { language: query.language }),
          ...(query.category === undefined ? {} : { category: query.category }),
          page,
          pageSize,
        },
        { warn: (fields, message) => request.log.warn(fields, message) },
      );
      if (result === null) {
        throw new AppError('SOURCE_DATA_ANOMALY', '发现数据暂不可用');
      }
      sendPublic(
        request,
        reply,
        {
          data: result.items,
          // source 为 null 表示“已启用但尚无活跃代次”，不是错误；前端据此区分
          // “尚未完成首次导入”与“筛选后无匹配”。
          meta: { page, pageSize, total: result.total, source: result.source, filters: result.filters },
        },
        MAX_PUBLIC_CACHE_SECONDS,
      );
    },
  });
}

function secondsToNearestChangeBoundary(
  items: readonly { changeExpiresAt: string | null }[],
  now: number,
): number {
  let nearest = MAX_PUBLIC_CACHE_SECONDS;
  for (const item of items) {
    if (item.changeExpiresAt === null) continue;
    const expiresAt = Date.parse(item.changeExpiresAt);
    if (!Number.isFinite(expiresAt)) continue;
    const seconds = Math.floor((expiresAt - now) / 1000);
    if (seconds >= 0 && seconds < nearest) nearest = Math.max(0, seconds);
  }
  return nearest;
}

export function sendPublic(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  maxAgeSeconds: number,
): void {
  // 响应体必须是稳定序列化：不放入 requestId/serverTime，否则 ETag 每次都变化。
  const body = JSON.stringify(payload);
  const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
  void reply.header('etag', etag);
  void reply.header('x-request-id', request.id);
  // must-revalidate：max-age 过期后缓存必须回源验证，不允许在过期窗口内
  // 直接服务陈旧条目（“重新验证公开HTTP缓存”；写操作后的失效由前端
  // 以 no-cache 请求强制绕过 max-age，双保险）。
  void reply.header('cache-control', `public, max-age=${Math.max(0, Math.floor(maxAgeSeconds))}, must-revalidate`);
  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((value) => value.trim() === etag)) {
    void reply.status(304).send();
    return;
  }
  void reply.type('application/json; charset=utf-8').status(200).send(body);
}
