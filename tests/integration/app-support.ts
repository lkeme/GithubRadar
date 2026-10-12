import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { DiscoveryAdapter } from '../../apps/server/src/api/discovery-adapter.js';
import { TrendsAdapter } from '../../apps/server/src/trends/index.js';
import {
  buildApp,
  createDatabase,
  createTransport,
  CredentialService,
  createSession,
  encryptSecret,
  extractRateLimit,
  JobQueue,
  openDatabase,
  parsePublicOrigin,
  PAT_SECRET_NAME,
  RateBudget,
  runMigrations,
  GithubClient,
  LabelService,
  RepositoryService,
  Scheduler,
  SESSION_COOKIE_NAME,
  hashPassword,
  type AppConfig,
  type Database,
  type SqliteDatabase,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@githubradar/server';

/**
 * 应用级测试基座。
 *
 * 使用真实应用路由、真实临时 SQLite 与可控上游：只对网络层注入假 transport，
 * 不对中间件做 mock，因此断言的是真实副作用而不只是函数返回值。
 */

export const TEST_PASSWORD = 'TestPass1234!';
export const TEST_ORIGIN = 'http://127.0.0.1:8787';
/** 与 TEST_ORIGIN 一致的 Host 头，供注入式请求使用。 */
export const HOST_HEADER = '127.0.0.1:8787';

export interface LoggedInSession {
  readonly cookie: string;
  readonly csrfToken: string;
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly client: SqliteDatabase;
  readonly appKey: Buffer;
  readonly dir: string;
  readonly credentials: CredentialService;
  readonly scheduler: Scheduler;
  readonly repositoryService: RepositoryService;
  readonly labelService: LabelService;
  /** 登录：默认复用缓存会话，需要独立会话时传 `{ fresh: true }`。 */
  login(options?: { fresh?: boolean }): Promise<LoggedInSession>;
  close(): Promise<void>;
}
export interface FakeUpstreamResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** 可控上游：按 URL 匹配返回预设响应，并记录实际发出的请求。 */
export class FakeUpstream {
  readonly requests: { url: string; headers: Record<string, string> }[] = [];
  readonly #routes = new Map<string, FakeUpstreamResponse | (() => FakeUpstreamResponse)>();
  #default: FakeUpstreamResponse = { status: 404, body: { message: 'Not Found' } };

  on(url: string, response: FakeUpstreamResponse | (() => FakeUpstreamResponse)): void {
    this.#routes.set(url, response);
  }

  setDefault(response: FakeUpstreamResponse): void {
    this.#default = response;
  }

  get transport(): ReturnType<typeof createTransport> {
    return createTransport(null, {
      create: () => ({ destroy: () => undefined }) as never,
    });
  }

  handle(url: string): { status: number; headers: Record<string, string>; body: string } {
    const route = [...this.#routes.entries()].find(([key]) => url.startsWith(key));
    const response = route === undefined ? this.#default : typeof route[1] === 'function' ? route[1]() : route[1];
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: JSON.stringify(response.body ?? {}),
    };
  }
}

/**
 * 把凭证状态置为业务就绪。
 *
 * 只用于测试非门禁主题（字段白名单、批量边界等）：这些行为在门禁未就绪时会被
 * 提前拦下，因此需要先有一个“已验证的活动 PAT”。这里不访问网络，
 * 写入的也是一个明显的测试占位值。
 */
export function seedValidCredential(client: SqliteDatabase, appKey: Buffer, now: number): void {
  const encrypted = encryptSecret(appKey, PAT_SECRET_NAME, 'ghp_test-placeholder-token');
  client
    .prepare(
      `INSERT INTO secrets (name, ciphertext, nonce, auth_tag, key_version, revision)
       VALUES (?, ?, ?, ?, 1, 1)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, auth_tag = excluded.auth_tag`,
    )
    .run(PAT_SECRET_NAME, encrypted.ciphertext, encrypted.nonce, encrypted.authTag);
  client
    .prepare(
      `UPDATE github_credential_status
          SET credential_state = 'valid', connectivity = 'reachable',
              token_type_hint = 'classic', last_verified_at = ?, last_authenticated_at = ?,
              configured_at = ?, last_error_code = NULL, next_verification_at = ?
        WHERE id = 1`,
    )
    .run(now, now, now, now + 60 * 60 * 1000);
}

/**
 * 按路径精确匹配的假上游。
 *
 * 让调度路径（metadata 提交、身份门禁、合并、趋势、各流投影）可以在不访问真实 GitHub
 * 的前提下被完整驱动。匹配规则刻意保持严格：
 * - 片段只写路径时，只比对 pathname（忽略查询串）；
 * - 片段带查询串时（例如 `/releases?per_page=20&page=1`），查询串也必须一致。
 * 这样 `/repos/o/r` 不会意外吞掉 `/repos/o/r/releases/latest`。
 * 未匹配的请求返回 404，与真实客户端对未知路径的处理一致。
 */
export class JsonTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  readonly #routes: { path: string; search: string | null; response: { status: number; body: unknown; headers?: Record<string, string> } }[] =
    [];

  /** 同一个路径（含查询串）重复登记时覆盖旧响应，便于用例中途改变上游行为。 */
  on(
    pathFragment: string,
    response: { status: number; body: unknown; headers?: Record<string, string> },
  ): void {
    const [path, search] = pathFragment.split('?');
    const resolvedPath = path ?? pathFragment;
    const resolvedSearch = search === undefined ? null : `?${search}`;
    const index = this.#routes.findIndex(
      (route) => route.path === resolvedPath && route.search === resolvedSearch,
    );
    if (index >= 0) this.#routes.splice(index, 1);
    this.#routes.push({ path: resolvedPath, search: resolvedSearch, response });
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();
    for (const route of this.#routes) {
      // GitHub 的 owner/repo 路径不区分大小写，假上游保持同样语义。
      if (route.path.toLowerCase() !== path) continue;
      if (route.search !== null && route.search !== url.search) continue;
      return Promise.resolve({
        status: route.response.status,
        headers: { 'content-type': 'application/json', ...route.response.headers },
        body: JSON.stringify(route.response.body),
        bytes: 0,
        url: request.url,
      });
    }
    return Promise.resolve({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Not Found' }),
      bytes: 0,
      url: request.url,
    });
  }

  describe(): { mode: 'direct'; proxyScheme: null } {
    return { mode: 'direct', proxyScheme: null };
  }

  close(): void {
    // 无需释放。
  }
}

export async function createTestApp(
  options: {
    withValidCredential?: boolean;
    publicOrigin?: string;
    /** 注入假上游；不提供时会真的发起网络请求，因此涉及调度执行的用例必须提供。 */
    transport?: Transport;
    /** 受信反向代理列表（TRUSTED_PROXY 的等价注入）；默认不信任任何转发头。 */
    trustedProxies?: string[];
  } = {},
): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'githubradar-app-'));
  const client = openDatabase({ path: path.join(dir, 'githubradar.sqlite') });
  runMigrations(client);
  const db = createDatabase(client);
  const appKey = randomBytes(32);
  const now = (): number => Date.now();

  const passwordHash = await hashPassword(TEST_PASSWORD);
  client
    .prepare(
      'INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at) VALUES (1, ?, ?, 1, ?)',
    )
    .run('admin', passwordHash, now());
  // 项目发现是默认能力（迁移 0006 起单例行固定启用），不需要用例再打开。
  if (options.withValidCredential === true) {
    seedValidCredential(client, appKey, now());
  }

  const config: AppConfig = {
    nodeEnv: 'test',
    databasePath: path.join(dir, 'githubradar.sqlite'),
    publicOrigin: parsePublicOrigin(options.publicOrigin ?? TEST_ORIGIN),
    host: '127.0.0.1',
    port: 8787,
    loginRateLimitMax: 5,
    trustedProxies: options.trustedProxies ?? [],
  };

  const credentials = new CredentialService({ db, appKey, now });
  const transport = options.transport ?? createTransport(null);
  const budget = new RateBudget(db, now);
  const queue = new JobQueue(db, 'test-owner', now);
  const github = new GithubClient({ db, transport, now });
  const repositoryService = new RepositoryService({ db, queue, now });
  const labelService = new LabelService({ db, now, queue });
  const scheduler = new Scheduler(
    { db, queue, budget, client: github, transport, credentials, now, repositoryService },
    { ownerId: 'test-owner' },
  );

  // 发现模块的适配器：与生产一致地读取 settings.discovery_enabled。
  const discovery = new DiscoveryAdapter({
    db,
    transport,
    now,
    isEnabled: () =>
      (client.prepare('SELECT discovery_enabled AS enabled FROM settings WHERE id = 1').get() as {
        enabled: number;
      }).enabled === 1,
    access: {
      readToken: () => credentials.readActiveToken(),
      observeRateLimit: (headers) => {
        const snapshot = extractRateLimit(headers, now());
        if (snapshot !== null) budget.observe(snapshot);
      },
      shouldAbort: () => !credentials.isReady(),
    },
  });
  const trends = new TrendsAdapter({
    db,
    transport,
    now,
    access: {
      readToken: () => credentials.readActiveToken(),
      observeRateLimit: (headers) => {
        const snapshot = extractRateLimit(headers, now());
        if (snapshot !== null) budget.observe(snapshot);
      },
      shouldAbort: () => !credentials.isReady(),
    },
  });

  const app = await buildApp({
    config,
    db,
    appKey,
    now,
    gate: credentials,
    credentials,
    repositoryService,
    labelService,
    scheduler,
    budget,
    schemaVersion: '0004',
    databasePath: config.databasePath,
    disableStatic: true,
    discovery,
    trends,
    // 只输出错误：失败的用例能在测试日志里直接看到服务端异常原因，正常路径保持安静。
    logger: { level: 'error' },
  });
  await app.ready();

  /**
   * 注入式请求不会自带真实 Host 头（light-my-request 默认 `localhost:80`），
   * 而 Host 校验是生产行为的一部分。这里统一补上与本部署一致的 Host，
   * 而不是为了测试放宽服务端校验。
   */
  const originalInject = app.inject.bind(app);
  app.inject = ((options: unknown) => {
    if (typeof options === 'string') {
      return originalInject({ url: options, headers: { host: HOST_HEADER } });
    }
    const value = (options ?? {}) as { headers?: Record<string, string> };
    return originalInject({ ...value, headers: { host: HOST_HEADER, ...value.headers } });
  }) as typeof app.inject;

  let cachedSession: LoggedInSession | null = null;

  return {
    app,
    db,
    client,
    appKey,
    dir,
    credentials,
    scheduler,
    repositoryService,
    labelService,
    /**
     * 建立管理员会话。
     *
     * 这里直接在数据库里铸造会话，而不是调用 `POST /auth/login`：
     * 登录接口有 5 次/分钟的 IP 限速，注入式测试共用同一个 IP，
     * 几十个用例会互相耗尽配额，把被测行为变成限速行为。
     * 真实的登录端点由 e2e 流程与限速用例（review-fixes）单独覆盖。
     * 需要第二条独立会话时传 `{ fresh: true }`。
     */
    async login(options: { fresh?: boolean } = {}) {
      if (options.fresh !== true && cachedSession !== null) {
        return cachedSession;
      }
      const account = client.prepare('SELECT auth_version AS version FROM admin_account WHERE id = 1').get() as
        | { version: number }
        | undefined;
      if (account === undefined) throw new Error('测试管理员账号未初始化');
      const created = createSession(db, appKey, {
        authVersion: account.version,
        rememberMe: false,
        now: Date.now(),
      });
      const session: LoggedInSession = {
        cookie: `${SESSION_COOKIE_NAME}=${created.token}`,
        csrfToken: created.csrfToken,
      };
      if (options.fresh !== true) cachedSession = session;
      return session;
    },
    async close() {
      await app.close();
      transport.close();
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 带会话与 CSRF 的管理写请求。 */
export function adminHeaders(session: LoggedInSession, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: TEST_ORIGIN,
    'content-type': 'application/json',
    cookie: session.cookie,
    'x-csrf-token': session.csrfToken,
    ...extra,
  };
}
