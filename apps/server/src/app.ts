import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { MAX_IMPORT_BODY_BYTES } from '@githubradar/contracts';
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import type { Database } from './db/client.js';
import {
  AppError,
  applyNoStore,
  decodePathname,
  errorEnvelope,
  isAppError,
} from './http/errors.js';
import { installAccessGuards, RoutePolicyGuard, type SessionGate } from './http/policy.js';
import { NOT_FOUND_PAGE_HTML } from './http/not-found-page.js';
import type { RouteContext } from './http/route-context.js';
import { registerAdminRoutes } from './api/admin-routes.js';
import { registerAuthRoutes } from './api/auth-routes.js';
import { registerPublicRoutes, type DiscoveryPort } from './api/public-routes.js';
import { registerHealthRoutes } from './api/health-routes.js';
import { buildSystemStatus } from './api/system-status.js';
import { registerStaticRoutes, SPA_ROUTES } from './static.js';
import { isAllowedHost } from './origin.js';
import type { AppConfig } from './config.js';
import type { CredentialService } from './credentials/service.js';
import type { RepositoryService } from './domain/repositories.js';
import type { LabelService } from './domain/labels.js';
import type { Scheduler } from './scheduler/runner.js';
import type { RateBudget } from './scheduler/budget.js';

/**
 * 应用装配。
 *
 * 只有一种 transport 出口、一套鉴权管线、一套错误信封；不在 HTTP 请求内跑完整采集。
 */

export interface AppDependencies {
  readonly config: AppConfig;
  readonly db: Database;
  readonly appKey: Buffer;
  readonly now: () => number;
  readonly gate: SessionGate;
  readonly credentials: CredentialService;
  readonly repositoryService: RepositoryService;
  readonly labelService: LabelService;
  readonly scheduler: Scheduler;
  readonly budget: RateBudget;
  readonly schemaVersion: string | null;
  readonly databasePath: string;
  readonly webDist?: string;
  readonly disableStatic?: boolean;
  /** true/false 全开全关；也可以传 Fastify 的 logger 配置（测试里常用 { level: 'error' }）。 */
  readonly logger?: boolean | { readonly level: string };
  readonly discovery?: DiscoveryPort | null;
}

const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' https://avatars.githubusercontent.com data:",
  // 样式库需要 inline style；只对 style 策略作最小调整，不放开 script-src/unsafe-inline。
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function adminAuthVersion(db: Database): number {
  const row = db.$client.prepare('SELECT auth_version AS version FROM admin_account WHERE id = 1').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/**
 * 装配应用。
 *
 * 必须是异步：@fastify/rate-limit 通过 `onRoute` 钩子给每条路由挂限速参数，
 * 而插件体要到 `ready()` 才执行。如果先同步注册路由再等插件，插件永远看不到
 * 这些路由，限速会静默失效。这里 `await` 插件注册，确保顺序正确。
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    // 关闭框架自动 HEAD：不产生未声明的路由别名，策略覆盖检查因此没有漏网分支。
    exposeHeadRoutes: false,
    routerOptions: { caseSensitive: true, ignoreTrailingSlash: false },
    // 只在部署显式声明了受信反向代理时才采用转发头；否则 request.ip 就是直连来源，
    // 避免任意请求用 X-Forwarded-For 伪造 IP 绕过登录限速。
    trustProxy: deps.config.trustedProxies.length > 0 ? [...deps.config.trustedProxies] : false,
    // 入站体积上限与契约里的批量导入上限同源（单一来源，避免两处各写一遍后漂移）。
    bodyLimit: MAX_IMPORT_BODY_BYTES,
    logger: deps.logger ?? false,
    // 请求生命周期日志由业务按字段白名单自己输出，避免默认日志带上敏感头部。
    // 通过 logController 关闭（fastify@5.12 起 disableRequestLogging 顶层选项已废弃，FSTDEP023）。
    logController: new LogController({ disableRequestLogging: true }),
  });

  const guard = new RoutePolicyGuard();
  const context: RouteContext = {
    config: deps.config,
    db: deps.db,
    appKey: deps.appKey,
    now: deps.now,
    gate: deps.gate,
    credentials: deps.credentials,
    repositoryService: deps.repositoryService,
    labelService: deps.labelService,
    scheduler: deps.scheduler,
    authVersion: () => adminAuthVersion(deps.db),
    budgetState: () => deps.budget.state(),
    systemStatus: () =>
      buildSystemStatus({
        db: deps.db,
        client: deps.db.$client,
        credentials: deps.credentials,
        queue: deps.scheduler.jobQueue,
        budgetState: deps.budget.state(),
        schemaVersion: deps.schemaVersion,
        databasePath: deps.databasePath,
        now: deps.now(),
        throughput: {
          observedRequestsPerHour: deps.budget.throughput().requestsPerHour,
          notModifiedRatio: deps.budget.throughput().notModifiedRatio,
          averageLatencyMs: deps.budget.throughput().averageLatencyMs,
        },
        schedulerRunning: deps.scheduler.isRunning,
        nextWakeAt: deps.scheduler.nextWakeAt,
        discovery: deps.discovery?.status() ?? null,
      }),
  };

  await app.register(cookie, { secret: deps.appKey.toString('base64'), hook: 'onRequest' });
  await app.register(rateLimit, {
    global: false,
    // 默认 keyGenerator 只用 IP，而存储是全局共享的：这样公开接口的 120/分钟配额
    // 会与登录的 5/分钟挤在同一个计数器上，正常浏览就能把登录配额耗尽。
    // 键里带上路由，使每条路由的配额互不影响。
    keyGenerator: (request) => `${request.ip}|${request.routeOptions.url ?? request.url}`,
  });

  /**
   * body 可缺省的 JSON 解析。
   *
   * logout、activity、github-token/verify、branch-refreshes 都是无 body 的 POST；
   * Fastify 默认解析器对「声明 application/json 但 body 为空」直接 400，
   * 而这些请求本来就是合法的。这里把空 body 解析为 undefined，
   * 需要 body 的路由仍会由边界 schema 拒绝（400 VALIDATION_FAILED）。
   * 非法 JSON 依旧按 400 处理，不放松任何校验。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : '';
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      const error = new Error('请求体不是合法 JSON') as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  /**
   * 安全响应头与 no-store 在 onRequest 阶段统一设置。
   *
   * 不要放到 onSend：那时 payload 已经定稿，再调用 reply.header() 会触发
   * `ERR_HTTP_HEADERS_SENT`（表现为每个请求都写一条 unhandled error 日志）。
   * 放在这里还能保证错误响应、重定向与自动 HEAD 同样带上这些头。
   */
  app.addHook('onRequest', async (request, reply) => {
    // requestId 通过响应头提供；只放头部，不进可缓存的公开响应体。
    void reply.header('x-request-id', request.id);
    // Host 校验先于一切：恶意 Host 不应进入任何业务路径。
    if (!isAllowedHost(deps.config.publicOrigin, request.headers.host, deps.config.port, request.ip)) {
      void reply.status(403).send(errorEnvelope(new AppError('FORBIDDEN', '请求 Host 与本部署不一致')));
      return reply;
    }
    void reply.header('content-security-policy', CSP);
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    applyNoStore(request, reply);
    return undefined;
  });

  /**
   * 访问日志（必备维度：requestId、路由、HTTP 状态、耗时）。
   *
   * 只输出这些结构化字段，不记录 Cookie、CSRF、请求体或响应体；
   * 因此关闭 Fastify 自带的请求日志（它会带上完整请求头）是安全的。
   */
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  installAccessGuards(app, context, guard);

  registerHealthRoutes(app, guard, deps);
  registerAuthRoutes(app, guard, context);
  registerPublicRoutes(app, guard, context, deps.discovery ?? null);
  registerAdminRoutes(app, guard, context);

  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    const appError = isAppError(error)
      ? error
      : statusCode === 400
        ? new AppError('VALIDATION_FAILED', '请求体不是合法 JSON 或超出大小限制')
        : statusCode === 413
          ? new AppError('VALIDATION_FAILED', '请求体超出大小限制')
          : statusCode === 415
            ? new AppError('UNSUPPORTED_MEDIA_TYPE', '管理接口只接受 application/json')
            : statusCode === 429
              ? // 入站限速由 @fastify/rate-limit 抛出；不映射就会变成 500，客户端还会重试。
                new AppError('RATE_LIMITED', '请求过于频繁，请稍后重试')
              : new AppError('INTERNAL_ERROR', '服务器内部错误', { expose: false });

    if (!isAppError(error)) {
      // 客户端错误（415/400 等）是正常拒绝，按 info 记录错误码即可；
      // 只有 5xx 才升级为 error 并带上原始异常。原始异常不写入响应体。
      if (appError.status >= 500) {
        request.log.error({ err: error, code: appError.code }, 'request failed');
      } else {
        request.log.info({ status: appError.status, code: appError.code }, 'request rejected');
      }
    } else if (appError.status >= 500) {
      // AppError 的 5xx（例如凭证状态行缺失的 SERVICE_UNAVAILABLE）同样需要可观测痕迹；
      // 只记错误码与脱敏后的 message，不附带 stack（脱敏约定不变）。
      request.log.error({ code: appError.code, message: appError.message }, 'request failed');
    }
    void reply.status(appError.status).send(errorEnvelope(appError));
  });

  app.setNotFoundHandler((request, reply) => {
    // 未匹配任何路由：/api 返回 JSON 信封；页面路径返回品牌化 404（状态码不变），
    // 绝不回退成静态文件或 SPA shell，避免编码穿越与文件别名落到文件服务。
    // 判定用解码后的路径：`/%61pi/...` 这类编码变体同样按未知 API 处理。
    if (decodePathname(request.url.split('?')[0] ?? '').startsWith('/api/')) {
      void reply.status(404).send(errorEnvelope(new AppError('NOT_FOUND', '接口不存在')));
      return;
    }
    void reply.status(404).type('text/html; charset=utf-8').send(NOT_FOUND_PAGE_HTML);
  });

  registerStaticRoutes(app, guard, { webDist: deps.webDist, enabled: deps.disableStatic !== true });

  app.addHook('onReady', async () => {
    // 启动时核对策略覆盖：已声明未注册的路由会在这里失败。
    guard.assertConsistent();
  });

  return app;
}

export { SPA_ROUTES, type RouteContext };
