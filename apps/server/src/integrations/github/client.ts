import { and, eq, lt } from 'drizzle-orm';

import { HTTP_CACHE_RETENTION_DAYS } from '@githubradar/contracts';

import type { Database } from '../../db/client.js';
import { httpCache } from '../../db/schema.js';
import { TransportError, type Transport } from '../transport/index.js';
import { EmptyBranchError, PROJECTION_VERSION, UpstreamSchemaError } from './projections.js';

/**
 * GitHub REST 客户端。
 *
 * - 固定 host 与 `X-GitHub-Api-Version`，不用动态日期。
 * - 持久化条件缓存：缓存键含 host、API 版本、方法、规范化路径/查询、Accept、
 *   凭证 revision 与投影 schema 版本。键中不含明文 Token。
 * - 200 解析后原子保存投影与校验器；304 仅在投影完整且版本一致时复用，
 *   缺失时安排一次无条件重取，绝不把 304 当成空响应。
 * - 网络等待期间不持有数据库事务；读写缓存都是同步短操作。
 */

export const GITHUB_API_HOST = 'api.github.com';
export const GITHUB_API_VERSION = '2026-03-10';
export const ACCEPT_GITHUB_JSON = 'application/vnd.github+json';
export const RAW_HOST = 'raw.githubusercontent.com';

export type GithubErrorCode =
  | 'GITHUB_TOKEN_INVALID'
  | 'GITHUB_ACCESS_DENIED_OR_MISSING'
  | 'GITHUB_RATE_LIMITED'
  | 'UPSTREAM_SCHEMA_CHANGED'
  | 'BRANCH_EMPTY'
  | 'PROXY_UNREACHABLE'
  | 'SERVICE_UNAVAILABLE';

export interface RateLimitSnapshot {
  readonly resource: string;
  readonly limit: number | null;
  readonly remaining: number | null;
  /** UTC 毫秒；上游给的是 epoch 秒。 */
  readonly resetAt: number | null;
  readonly observedAt: number;
}

export interface TokenMetadata {
  readonly expiresAt: number | null;
  readonly expiresSource: 'reported' | 'unknown';
  readonly classicScopes: string[] | null;
}

/** 投影解析上下文：调用方通过它拿到本响应中校验过的分页链接（不跟随，仅用于覆盖度判定）。 */
export interface GithubProjectionContext {
  /** 响应 Link 头中校验通过的 rel="next"，未提供或校验失败时为 null。 */
  readonly nextLink: string | null;
}

export interface GithubProjection<T> {
  parse(payload: unknown, context: GithubProjectionContext): T;
}

export interface GithubGetSpec<T> {
  /** 规范化路径，例如 `/repos/owner/repo/releases/latest`。 */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly projection: GithubProjection<T>;
  readonly repoId: number | null;
  readonly credentialRevision: number;
  /** 业务采集传当前 PAT；不含凭证的探测/raw 传 null。 */
  readonly token: string | null;
  /**
   * 调用方需要本轮拿到实体投影（例如采集流基线缺失/损坏，必须完成初始化）。
   * 为 true 时不发送条件请求：304 不能用来建立或修复基线。
   */
  readonly requiresProjection?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface GithubOutcome<T> {
  readonly kind: 'ok' | 'not_modified' | 'error';
  readonly data: T | null;
  readonly status: number;
  readonly errorCode: GithubErrorCode | null;
  readonly errorMessage: string | null;
  readonly rateLimit: RateLimitSnapshot | null;
  readonly tokenMetadata: TokenMetadata | null;
  /** true 表示本次为复用的条件缓存，没有新数据。 */
  readonly fromCache: boolean;
  readonly bytes: number;
  readonly url: string;
  /** 5xx/网络错误可按 1/5/15 分钟退避重试。 */
  readonly retryable: boolean;
  /** 响应 Retry-After 原值（秒或 HTTP 日期）；限流时用于与配额 reset 取较晚。 */
  readonly retryAfter: string | null;
  /** 响应 Date 头原值；用于校正宿主时钟偏差。 */
  readonly serverDate: string | null;
  /** 本响应校验通过的分页 next 链接；不跟随翻页。 */
  readonly nextLink: string | null;
}

interface CachedEntry {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly projectionJson: string | null;
  readonly nextLink: string | null;
  readonly projectionVersion: number;
  readonly credentialRevision: number | null;
}

export function cacheKeyFor(spec: {
  path: string;
  query?: Readonly<Record<string, string>>;
  credentialRevision: number;
  token: string | null;
}): string {
  const query = Object.entries(spec.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  // 键里只出现凭证 revision，不出现凭证明文。
  return [
    `host=${GITHUB_API_HOST}`,
    `api=${GITHUB_API_VERSION}`,
    'method=GET',
    `path=${spec.path}`,
    `query=${query}`,
    `accept=${ACCEPT_GITHUB_JSON}`,
    `cred=${spec.credentialRevision}`,
    `projection=v${PROJECTION_VERSION}`,
  ].join('|');
}

export function buildPath(
  pathTemplate: string,
  params: Readonly<Record<string, string>>,
): string {
  return pathTemplate.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`缺少路径参数 ${key}`);
    return encodeURIComponent(value);
  });
}

function parseIntegerHeader(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function extractRateLimit(
  headers: Readonly<Record<string, string>>,
  now: number,
): RateLimitSnapshot | null {
  const remaining = parseIntegerHeader(headers['x-ratelimit-remaining']);
  const limit = parseIntegerHeader(headers['x-ratelimit-limit']);
  const resetSeconds = parseIntegerHeader(headers['x-ratelimit-reset']);
  if (remaining === null && limit === null && resetSeconds === null) return null;
  return {
    resource: headers['x-ratelimit-resource'] ?? 'core',
    limit,
    remaining,
    resetAt: resetSeconds === null ? null : resetSeconds * 1000,
    observedAt: now,
  };
}

/**
 * 到期头形如 `2026-07-26 21:31:41 UTC`。只识别带明确时区的格式，
 * 不宽松猜测；无法解析时记为未知，不写"永久有效"。
 */
export function parseTokenExpiration(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC$/i.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match as unknown as [string, string, string, string, string, string, string];
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(ms) ? ms : null;
}

export function extractTokenMetadata(headers: Readonly<Record<string, string>>): TokenMetadata {
  const expiresAt = parseTokenExpiration(headers['github-authentication-token-expiration']);
  const scopesHeader = headers['x-oauth-scopes'];
  return {
    expiresAt,
    expiresSource: expiresAt === null ? 'unknown' : 'reported',
    classicScopes:
      scopesHeader === undefined
        ? null
        : scopesHeader
            .split(',')
            .map((scope) => scope.trim())
            .filter((scope) => scope !== ''),
  };
}

/**
 * 解析 Link 头中的 rel="next" 并校验为可信目标。
 * 只接受 https、api.github.com、非 userinfo/非标准端口、且与当前请求同一 endpoint 的链接；
 * 解析结果只用于覆盖度判定与缓存，不跟随翻页。
 */
export function parseNextLink(linkHeader: string | undefined, requestPath: string): string | null {
  if (linkHeader === undefined || linkHeader === '') return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part.trim());
    const href = match?.[1];
    if (href === undefined) continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (url.hostname !== GITHUB_API_HOST) continue;
    if (url.port !== '' && url.port !== '443') continue;
    if (url.username !== '' || url.password !== '') continue;
    if (url.pathname !== requestPath && !isRepositoryIdFormOf(url.pathname, requestPath)) continue;
    return url.toString();
  }
  return null;
}

/**
 * GitHub 对仓库子资源的分页 Link 使用数字 ID 形式（官方分页文档示例：
 * `<https://api.github.com/repositories/1300192/issues?page=2>`），与请求路径
 * `/repos/{owner}/{repo}/{endpoint}` 不同形。只放行"同一 endpoint 后缀"的
 * `/repositories/{id}/...` 变体，其余主机内路径仍拒绝。
 */
function isRepositoryIdFormOf(linkPath: string, requestPath: string): boolean {
  const requestMatch = /^\/repos\/[^/]+\/[^/]+(\/.+)$/.exec(requestPath);
  const linkMatch = /^\/repositories\/\d+(\/.+)$/.exec(linkPath);
  if (requestMatch === null || linkMatch === null) return false;
  return requestMatch[1] === linkMatch[1];
}

export function classifyStatus(
  status: number,
  headers: Readonly<Record<string, string>>,
): { errorCode: GithubErrorCode | null; retryable: boolean; message: string | null } {
  if (status === 401) {
    return { errorCode: 'GITHUB_TOKEN_INVALID', retryable: false, message: '认证失败，可能已撤销或过期' };
  }
  if (status === 429) {
    return { errorCode: 'GITHUB_RATE_LIMITED', retryable: true, message: '上游限流' };
  }
  if (status === 403) {
    const remaining = headers['x-ratelimit-remaining'];
    const retryAfter = headers['retry-after'];
    if (remaining === '0' || (retryAfter !== undefined && retryAfter !== '')) {
      return { errorCode: 'GITHUB_RATE_LIMITED', retryable: true, message: '配额耗尽或次级限流' };
    }
    // 非限流的 403 按权限不足处理，不把全部 403 当成限流。
    return { errorCode: 'GITHUB_ACCESS_DENIED_OR_MISSING', retryable: false, message: '权限不足或资源不可访问' };
  }
  if (status === 404) {
    return { errorCode: 'GITHUB_ACCESS_DENIED_OR_MISSING', retryable: false, message: '资源不存在或无权访问' };
  }
  if (status >= 500) {
    return { errorCode: 'SERVICE_UNAVAILABLE', retryable: true, message: `上游返回 ${status}` };
  }
  if (status >= 400) {
    return { errorCode: 'UPSTREAM_SCHEMA_CHANGED', retryable: false, message: `上游返回未预期的 ${status}` };
  }
  // 未覆盖的状态（无 Location 的 3xx、非 200 的 2xx 等）按上游契约异常归类：
  // 返回 null 会让下游退回 SERVICE_UNAVAILABLE（可重试），错误归因失真。
  return { errorCode: 'UPSTREAM_SCHEMA_CHANGED', retryable: false, message: `上游返回未预期的 ${status}` };
}

export interface GithubClientDeps {
  readonly db: Database;
  readonly transport: Transport;
  readonly now: () => number;
}

export class GithubClient {
  readonly #deps: GithubClientDeps;

  constructor(deps: GithubClientDeps) {
    this.#deps = deps;
  }

  #readCache(key: string): CachedEntry | null {
    const row = this.#deps.db.select().from(httpCache).where(eq(httpCache.key, key)).get();
    if (row === undefined) return null;
    return {
      etag: row.etag,
      lastModified: row.lastModified,
      projectionJson: row.projectionJson,
      nextLink: row.nextLink,
      projectionVersion: row.projectionVersion,
      credentialRevision: row.credentialRevision,
    };
  }

  #writeProjection(
    key: string,
    spec: GithubGetSpec<unknown>,
    etag: string | null,
    lastModified: string | null,
    projectionJson: string | null,
    nextLink: string | null,
    repoId: number | null,
  ): void {
    const now = this.#deps.now();
    // 上传的校验器与投影在同一短事务里原子更新；next 链接同样属于本次响应的一部分。
    this.#deps.db
      .insert(httpCache)
      .values({
        key,
        repoId,
        etag,
        lastModified,
        projectionJson,
        nextLink,
        validatedAt: now,
        credentialRevision: spec.credentialRevision,
        projectionVersion: PROJECTION_VERSION,
      })
      .onConflictDoUpdate({
        target: httpCache.key,
        set: {
          repoId,
          etag,
          lastModified,
          projectionJson,
          nextLink,
          validatedAt: now,
          credentialRevision: spec.credentialRevision,
          projectionVersion: PROJECTION_VERSION,
        },
      })
      .run();
  }

  #touchValidation(key: string, repoId: number | null): void {
    this.#deps.db
      .update(httpCache)
      .set({ validatedAt: this.#deps.now() })
      .where(eq(httpCache.key, key))
      .run();
    void repoId;
  }

  /**
   * 读取当前凭证版本下的缓存投影：供 304 路径复用同一轮的列表结果，
   * 不发起网络。只在缓存行的投影版本与凭证 revision 都匹配时返回，否则 null。
   */
  readCachedProjection(spec: {
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly credentialRevision: number;
    readonly token: string | null;
  }): unknown | null {
    const key = cacheKeyFor(spec);
    const cached = this.#readCache(key);
    if (cached === null || cached.projectionJson === null) return null;
    if (cached.projectionVersion !== PROJECTION_VERSION) return null;
    if (cached.credentialRevision !== spec.credentialRevision) return null;
    try {
      return JSON.parse(cached.projectionJson) as unknown;
    } catch {
      return null;
    }
  }

  async #fetch(
    spec: GithubGetSpec<unknown>,
    conditional: { etag: string | null; lastModified: string | null } | null,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    url: string;
    transportError: TransportError | null;
  }> {
    const query = Object.entries(spec.query ?? {})
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    const url = `https://${GITHUB_API_HOST}${spec.path}${query === '' ? '' : `?${query}`}`;
    const headers: Record<string, string> = {
      accept: ACCEPT_GITHUB_JSON,
      'x-github-api-version': GITHUB_API_VERSION,
    };
    if (spec.token !== null) headers['authorization'] = `Bearer ${spec.token}`;
    if (conditional !== null) {
      if (conditional.etag !== null) headers['if-none-match'] = conditional.etag;
      else if (conditional.lastModified !== null) headers['if-modified-since'] = conditional.lastModified;
    }

    try {
      const response = await this.#deps.transport.request({
        url,
        headers,
        allowedHosts: [GITHUB_API_HOST],
        ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      });
      return { ...response, transportError: null };
    } catch (error) {
      return {
        status: 0,
        headers: {},
        body: '',
        bytes: 0,
        url,
        transportError: error instanceof TransportError ? error : null,
      };
    }
  }

  async get<T>(spec: GithubGetSpec<T>): Promise<GithubOutcome<T>> {
    const now = this.#deps.now();
    const key = cacheKeyFor(spec);
    const cached = this.#readCache(key);
    // 调用方明确需要实体投影（采集流基线缺失/损坏）时，304 不可复用。
    const requiresProjection = spec.requiresProjection === true;
    const hasUsableProjection =
      cached !== null &&
      cached.projectionJson !== null &&
      cached.projectionVersion === PROJECTION_VERSION &&
      cached.credentialRevision === spec.credentialRevision;

    const conditional =
      !requiresProjection && cached !== null && (cached.etag !== null || cached.lastModified !== null)
        ? { etag: cached.etag, lastModified: cached.lastModified }
        : null;

    let response = await this.#fetch(spec, conditional);

    if (response.status === 304) {
      if (hasUsableProjection && !requiresProjection) {
        this.#touchValidation(key, spec.repoId);
        return {
          kind: 'not_modified',
          data: null,
          status: 304,
          errorCode: null,
          errorMessage: null,
          rateLimit: extractRateLimit(response.headers, now),
          tokenMetadata: extractTokenMetadata(response.headers),
          fromCache: true,
          bytes: response.bytes,
          url: response.url,
          retryable: false,
          retryAfter: response.headers['retry-after'] ?? null,
          serverDate: response.headers['date'] ?? null,
          nextLink: parseNextLink(response.headers['link'], spec.path) ?? cached?.nextLink ?? null,
        };
      }
      // 304 但本地没有可用投影（或调用方明确需要实体投影）：安排一次无条件重取，不能当作空响应。
      response = await this.#fetch(spec, null);
    }

    if (response.transportError !== null) {
      const error = response.transportError;
      return {
        kind: 'error',
        data: null,
        status: 0,
        errorCode: error.code,
        errorMessage: error.message,
        rateLimit: null,
        tokenMetadata: null,
        fromCache: false,
        bytes: 0,
        url: response.url,
        retryable: true,
        retryAfter: null,
        serverDate: null,
        nextLink: null,
      };
    }

    const retryAfter = response.headers['retry-after'] ?? null;
    const serverDate = response.headers['date'] ?? null;

    if (response.status === 200) {
      const nextLink = parseNextLink(response.headers['link'], spec.path);
      let data: T;
      try {
        data = spec.projection.parse(JSON.parse(response.body) as unknown, { nextLink });
      } catch (error) {
        // 空仓库/空分支是「确定为空」的合法结果，用独立错误码透出，不与 schema 异常混为一谈。
        const branchEmpty = error instanceof EmptyBranchError;
        const message = branchEmpty
          ? error.message
          : error instanceof UpstreamSchemaError
            ? error.message
            : '上游响应结构与预期契约不一致，已结束本轮';
        return {
          kind: 'error',
          data: null,
          status: 200,
          errorCode: branchEmpty ? 'BRANCH_EMPTY' : 'UPSTREAM_SCHEMA_CHANGED',
          errorMessage: message,
          rateLimit: extractRateLimit(response.headers, now),
          tokenMetadata: extractTokenMetadata(response.headers),
          fromCache: false,
          bytes: response.bytes,
          url: response.url,
          retryable: false,
          retryAfter,
          serverDate,
          nextLink,
        };
      }

      try {
        // 不持久化完整上游响应：JSON.stringify 的对象只包含投影白名单字段。
        this.#writeProjection(
          key,
          spec as GithubGetSpec<unknown>,
          response.headers['etag'] ?? null,
          response.headers['last-modified'] ?? null,
          JSON.stringify(data),
          nextLink,
          spec.repoId,
        );
      } catch {
        // 缓存写入失败不影响本轮判定结果，下一次会重新无条件拉取。
      }

      return {
        kind: 'ok',
        data,
        status: 200,
        errorCode: null,
        errorMessage: null,
        rateLimit: extractRateLimit(response.headers, now),
        tokenMetadata: extractTokenMetadata(response.headers),
        fromCache: false,
        bytes: response.bytes,
        url: response.url,
        retryable: false,
        retryAfter,
        serverDate,
        nextLink,
      };
    }

    const classified = classifyStatus(response.status, response.headers);
    return {
      kind: 'error',
      data: null,
      status: response.status,
      errorCode: classified.errorCode,
      errorMessage: classified.message,
      rateLimit: extractRateLimit(response.headers, now),
      tokenMetadata: extractTokenMetadata(response.headers),
      fromCache: false,
      bytes: response.bytes,
      url: response.url,
      retryable: classified.retryable,
      retryAfter,
      serverDate,
      nextLink: null,
    };
  }
}

/** 不访问的缓存 30 天清理；活跃流的投影与基线继续保留。 */
export function purgeStaleHttpCache(db: Database, now: number): number {
  const cutoff = now - HTTP_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return db
    .delete(httpCache)
    .where(and(lt(httpCache.validatedAt, cutoff)))
    .run().changes;
}
