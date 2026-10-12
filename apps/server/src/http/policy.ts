import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';

import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { AppError, isAppError, unauthenticated } from './errors.js';
import {
  checkSession,
  CSRF_TOKEN_HEADER,
  findSessionByToken,
  SESSION_COOKIE_NAME,
  touchSession,
  verifyCsrfToken,
  type SessionRow,
} from '../security/sessions.js';
import { isSameOrigin } from '../origin.js';

/**
 * 路由访问策略与默认拒绝。
 *
 * 每条路由必须显式声明 access 与 tokenGate；`onRoute` 钩子核对声明，
 * 缺失即启动失败，因此新增路由不可能“忘记加鉴权”而静默变成公开接口。
 * /api/v1/admin/* 命名和前端隐藏按钮都不是授权机制。
 */

export const ACCESS_POLICIES = ['public_read', 'login', 'session_read', 'admin_read', 'admin_write', 'health'] as const;
export type AccessPolicy = (typeof ACCESS_POLICIES)[number];

/** 未就绪时仍允许的修复通路，必须显式给出理由（白名单）。 */
export const TOKEN_GATE_EXEMPT_REASONS = [
  'static_and_health',
  'session_lifecycle',
  'credential_repair',
  'proxy_repair',
  'read_only_diagnostics',
] as const;
export type TokenGateExemptReason = (typeof TOKEN_GATE_EXEMPT_REASONS)[number];

export interface RoutePolicy {
  readonly access: AccessPolicy;
  /** 默认 required；exempt 必须同时给出白名单理由。 */
  readonly tokenGate?: 'required' | 'exempt';
  readonly tokenGateExemptReason?: TokenGateExemptReason;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  readonly method: HttpMethod;
  readonly url: string;
  readonly policy: RoutePolicy;
  readonly bodyLimit?: number;
  readonly rateLimit?: { max: number; timeWindow: string } | false;
  readonly handler: RouteHandlerMethod;
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy;
}

interface RouteConfig {
  policy?: RoutePolicy;
  rateLimit?: { max: number; timeWindow: string } | false;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 显式声明的访问策略；缺失时启动失败。 */
    policy?: RoutePolicy;
  }
}

export class RoutePolicyGuard {
  readonly #declared = new Map<string, RoutePolicy>();
  readonly #registered = new Map<string, RoutePolicy>();
  /**
   * 由第三方插件注册、无法携带我们 route config 的路由（例如 @fastify/static 为每个
   * 构建文件注册的 `GET /<文件路径>` 与 `HEAD /<文件路径>`）。仍然必须在这里显式声明策略，
   * 默认拒绝的性质不变：只有本进程主动登记过的插件路由才能通过覆盖检查。
   */
  readonly #pluginDeclared = new Map<string, RoutePolicy>();

  declare(spec: RouteSpec): void {
    const key = `${spec.method} ${spec.url}`;
    if (this.#declared.has(key)) {
      throw new Error(`ROUTE_POLICY_DUPLICATE: ${key} 重复注册`);
    }
    if (spec.policy.tokenGate === 'exempt' && spec.policy.tokenGateExemptReason === undefined) {
      throw new Error(`TOKEN_GATE_EXEMPT_REASON_MISSING: ${key} 声明 exempt 时必须给出白名单理由`);
    }
    this.#declared.set(key, spec.policy);
  }

  allowPluginRoute(method: HttpMethod | 'HEAD', url: string, policy: RoutePolicy): void {
    if (policy.tokenGate === 'exempt' && policy.tokenGateExemptReason === undefined) {
      throw new Error(`TOKEN_GATE_EXEMPT_REASON_MISSING: ${method} ${url} 声明 exempt 时必须给出白名单理由`);
    }
    this.#pluginDeclared.set(`${method.toUpperCase()} ${url}`, policy);
  }

  /** onRoute 钩子：任何未经声明的路由（含框架自动 HEAD、第三方插件注册）都会让启动失败。 */
  observe(method: string, url: string, config: RouteConfig | undefined): void {
    const key = `${method.toUpperCase()} ${url}`;
    const policy = config?.policy ?? this.#pluginDeclared.get(key);
    if (policy === undefined) {
      throw new Error(`ROUTE_POLICY_MISSING: ${key} 未声明 access 策略`);
    }
    if (policy.tokenGate === 'exempt' && policy.tokenGateExemptReason === undefined) {
      throw new Error(`TOKEN_GATE_EXEMPT_REASON_MISSING: ${key}`);
    }
    this.#registered.set(key, policy);
  }

  /**
   * 请求时查询已生效的策略。
   *
   * 路由级 `config.policy` 优先；插件注册的路由（例如静态资源）没有自己的 config，
   * 因此回退到启动时登记过的插件策略。两者都没有时返回 undefined，由调用方按
   * “未声明即拒绝”处理，而不是默认放行。
   */
  policyFor(method: string, url: string, config: RouteConfig | undefined): RoutePolicy | undefined {
    return config?.policy ?? this.#registered.get(`${method.toUpperCase()} ${url}`);
  }

  /** 启动后核对：已声明的路由确实注册了；已注册未声明的路由在 onRoute 阶段即时失败。 */
  assertConsistent(): readonly RegisteredRoute[] {
    for (const key of this.#declared.keys()) {
      if (!this.#registered.has(key)) {
        throw new Error(`ROUTE_POLICY_NOT_REGISTERED: ${key} 已声明但未注册`);
      }
    }
    return [...this.#registered.entries()].map(([key, policy]) => {
      const spaceAt = key.indexOf(' ');
      return { method: key.slice(0, spaceAt), url: key.slice(spaceAt + 1), policy };
    });
  }
}

export function registerRoute(app: FastifyInstance, guard: RoutePolicyGuard, spec: RouteSpec): void {
  guard.declare(spec);
  app.route({
    method: spec.method,
    url: spec.url,
    handler: spec.handler,
    ...(spec.bodyLimit === undefined ? {} : { bodyLimit: spec.bodyLimit }),
    config: {
      policy: spec.policy,
      ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
    },
  });
}

export interface SessionGate {
  /** 业务就绪门禁；未就绪时抛 409 GITHUB_SETUP_REQUIRED。 */
  assertReady(): void;
  /** 只读诊断在门禁未就绪时仍然可用。 */
  isReady(): boolean;
}

export interface RequestContext {
  readonly config: AppConfig;
  readonly db: Database;
  readonly appKey: Buffer;
  readonly now: () => number;
  readonly gate: SessionGate;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 已通过校验的管理会话；未认证时为 undefined。 */
    session?: SessionRow;
  }
}

export function readSessionCookie(request: FastifyRequest): string | null {
  const raw = request.headers.cookie;
  if (typeof raw !== 'string' || raw === '') return null;
  const values: string[] = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    values.push(trimmed.slice(SESSION_COOKIE_NAME.length + 1));
  }
  if (values.length === 0) return null;
  // 同名 Cookie 出现多次时不猜测哪一个有效，直接拒绝。
  if (values.length > 1) {
    throw new AppError('FORBIDDEN', '请求携带了重复的会话 Cookie');
  }
  try {
    return decodeURIComponent(values[0] as string);
  } catch {
    return null;
  }
}

function assertOriginAllowed(context: RequestContext, request: FastifyRequest): void {
  const origin = request.headers.origin;
  const candidate = Array.isArray(origin) ? origin[0] : origin;
  if (!isSameOrigin(context.config.publicOrigin, candidate ?? null)) {
    throw new AppError('FORBIDDEN', '请求 Origin 与本部署不一致');
  }
}

function assertJsonContentType(request: FastifyRequest): void {
  const header = request.headers['content-type'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') return;
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '管理接口只接受 application/json');
  }
}

function assertCrossSiteRejected(request: FastifyRequest): void {
  const site = request.headers['sec-fetch-site'];
  const value = Array.isArray(site) ? site[0] : site;
  if (value === 'cross-site') {
    throw new AppError('FORBIDDEN', '拒绝跨站发起的请求');
  }
}

function assertManagementTransportAllowed(context: RequestContext): void {
  if (!context.config.publicOrigin.managementAllowed) {
    throw new AppError(
      'FORBIDDEN',
      '当前部署为明文 HTTP 且绑定在非回环地址，后台管理必须通过 HTTPS 访问',
    );
  }
}

export function installAccessGuards(app: FastifyInstance, context: RequestContext, guard: RoutePolicyGuard): void {
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      guard.observe(method, routeOptions.url, routeOptions.config as RouteConfig | undefined);
    }
  });

  app.addHook('preHandler', async (request) => {
    // 未匹配到任何路由时由 not-found 处理器负责：它没有也不应该有路由策略。
    if ((request as { is404?: boolean }).is404 === true) return;

    const routeConfig = request.routeOptions.config as RouteConfig | undefined;
    const policy = guard.policyFor(request.method, request.routeOptions.url ?? request.url, routeConfig);
    if (policy === undefined) {
      throw new Error(`ROUTE_POLICY_MISSING: ${request.method} ${request.url}`);
    }

    const { access } = policy;
    if (access === 'public_read' || access === 'health') return;

    if (access === 'login') {
      assertManagementTransportAllowed(context);
      assertOriginAllowed(context, request);
      assertJsonContentType(request);
      return;
    }

    assertCrossSiteRejected(request);

    if (access === 'session_read') {
      // 非回环明文 HTTP 部署下不承认任何已有 Cookie 认证：直接按未登录返回，
      // 而不是先回 CSRF token 再由前端遮罩。
      if (!context.config.publicOrigin.managementAllowed) {
        request.session = undefined;
        return;
      }
      // 未登录返回 200 与 authenticated=false，不抛错。
      request.session = tryLoadSession(context, request) ?? undefined;
      return;
    }

    assertManagementTransportAllowed(context);
    const session = requireSession(context, request);
    request.session = session;

    if (access === 'admin_write') {
      assertOriginAllowed(context, request);
      const header = request.headers[CSRF_TOKEN_HEADER];
      const candidate = Array.isArray(header) ? header[0] : header;
      if (!verifyCsrfToken(context.appKey, session, candidate)) {
        throw new AppError('CSRF_REJECTED', 'CSRF 校验失败');
      }
      const method = request.method.toUpperCase();
      if (method !== 'DELETE') {
        assertJsonContentType(request);
      }
      // 真实管理写操作续期空闲窗口；GET 读取与 session 轮询不续期，
      // 避免后台轮询把普通会话无限续命。绝对期限不因 touch 改变。
      touchSession(context.db, session.id, context.now());
      if (policy.tokenGate !== 'exempt') {
        context.gate.assertReady();
      }
      return;
    }

    // admin_read：不要求 CSRF；门禁语义与写路径一致——默认受 Token 门禁约束，
    // 只有显式声明 exempt（白名单理由）的只读诊断才在门禁未就绪时放行。
    // 声明与行为因此不会漂移：未来新增的 admin_read 忘记声明就会真的被门禁拦住。
    if (policy.tokenGate !== 'exempt') {
      context.gate.assertReady();
    }
  });
}

function tryLoadSession(context: RequestContext, request: FastifyRequest): SessionRow | null {
  const token = readSessionCookie(request);
  if (token === null || token === '') return null;
  // 会话存储读取失败必须显式拒绝执行（auth DB 失败返回 503，
  // 不回退到前端状态或过期内存缓存），而不是让异常冒泡成 500。
  try {
    const stored = findSessionByToken(context.db, token);
    if (stored === null) return null;
    const account = context.db.$client
      .prepare('SELECT auth_version FROM admin_account WHERE id = 1')
      .get() as { auth_version: number } | undefined;
    if (account === undefined) return null;
    if (checkSession(stored, account.auth_version, context.now()) !== 'ok') return null;
    return stored;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw new AppError('SERVICE_UNAVAILABLE', '会话存储暂不可用，请稍后重试');
  }
}

function requireSession(context: RequestContext, request: FastifyRequest): SessionRow {
  const session = tryLoadSession(context, request);
  if (session === null) throw unauthenticated();
  return session;
}
