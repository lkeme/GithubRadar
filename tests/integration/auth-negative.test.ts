import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSession } from '@githubradar/server';

import {
  TEST_ORIGIN,
  adminHeaders,
  createTestApp,
  type TestApp,
} from './app-support.js';

/**
 * 鉴权负向验收与业务门禁验收。
 *
 * 这些用例调用真实应用路由、真实临时 SQLite 与真实策略层，断言状态码与副作用
 * （数据库、任务、缓存），不是中间件函数返回值。
 *
 * 两个上下文刻意分开：
 * - `locked`：没有 PAT，用于验证门禁未就绪时的锁定与修复白名单；
 * - `ready`：已激活测试占位 PAT，用于验证字段白名单、批量边界等门禁之外的行为。
 */

let locked: TestApp;
let ready: TestApp;

beforeAll(async () => {
  locked = await createTestApp();
  ready = await createTestApp({ withValidCredential: true });
});

afterAll(async () => {
  await locked.close();
  await ready.close();
});

function countOf(context: TestApp, table: string): number {
  const row = context.client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

interface AdminRouteProbe {
  readonly method: string;
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  /** false 表示该请求本来就没有 body，不应携带 JSON 内容类型。 */
  readonly json?: boolean;
}

const ADMIN_ROUTES: readonly AdminRouteProbe[] = [
  { method: 'POST', url: '/api/v1/admin/repository-imports', payload: { input: 'owner/repo' } },
  { method: 'GET', url: '/api/v1/admin/repository-imports/1' },
  { method: 'GET', url: '/api/v1/admin/repository-controls?ids=repo_1' },
  { method: 'GET', url: '/api/v1/admin/repositories/repo_1' },
  { method: 'PATCH', url: '/api/v1/admin/repositories/repo_1', payload: { editRevision: 1, note: 'x' } },
  { method: 'DELETE', url: '/api/v1/admin/repositories/repo_1', json: false },
  { method: 'POST', url: '/api/v1/admin/repository-actions', payload: { action: 'pause', items: [{ id: 'repo_1', editRevision: 1 }] } },
  { method: 'GET', url: '/api/v1/admin/repositories/repo_1/available-branches' },
  { method: 'POST', url: '/api/v1/admin/repositories/repo_1/branch-refreshes', json: false },
  { method: 'PUT', url: '/api/v1/admin/repositories/repo_1/branches', payload: { editRevision: 1, branches: [] } },
  { method: 'PUT', url: '/api/v1/admin/pins', payload: { pinsRevision: 1, ids: [] } },
  { method: 'GET', url: '/api/v1/admin/labels' },
  { method: 'POST', url: '/api/v1/admin/labels', payload: { name: 'x' } },
  { method: 'PATCH', url: '/api/v1/admin/labels/label_1', payload: { labelRevision: 1, name: 'y' } },
  { method: 'DELETE', url: '/api/v1/admin/labels/label_1', json: false },
  { method: 'POST', url: '/api/v1/admin/checks', payload: { scope: 'all' } },
  { method: 'PUT', url: '/api/v1/admin/password', payload: { currentPassword: 'wrong-old-pass', newPassword: 'BrandNewPass123' } },
  { method: 'GET', url: '/api/v1/admin/jobs' },
  { method: 'DELETE', url: '/api/v1/admin/jobs', json: false },
  { method: 'POST', url: '/api/v1/admin/jobs/1/cancel' },
  { method: 'DELETE', url: '/api/v1/admin/jobs/1', json: false },
  { method: 'GET', url: '/api/v1/admin/job-groups/1' },
  { method: 'GET', url: '/api/v1/admin/settings' },
  { method: 'PUT', url: '/api/v1/admin/settings', payload: { revision: 1, defaultIntervalHours: 24 } },
  { method: 'PUT', url: '/api/v1/admin/github-token', payload: { token: 'ghp_x' } },
  { method: 'DELETE', url: '/api/v1/admin/github-token', json: false },
  { method: 'GET', url: '/api/v1/admin/github-token/status' },
  { method: 'POST', url: '/api/v1/admin/github-token/verify' },
  { method: 'GET', url: '/api/v1/admin/proxy' },
  { method: 'PUT', url: '/api/v1/admin/proxy', payload: { enabled: false, expectedRevision: 1 } },
  { method: 'POST', url: '/api/v1/admin/proxy/test', payload: { scheme: 'http', host: 'h', port: 8080 } },
  { method: 'GET', url: '/api/v1/admin/operations/1' },
  { method: 'GET', url: '/api/v1/admin/system-status' },
  { method: 'POST', url: '/api/v1/auth/activity' },
  { method: 'POST', url: '/api/v1/auth/logout' },
];

describe('匿名与伪造会话对全部管理接口的默认拒绝', () => {
  it('匿名请求每条管理路由都返回 401，且不产生任何数据库副作用', async () => {
    const before = {
      jobs: countOf(locked, 'jobs'),
      repositories: countOf(locked, 'repositories'),
      labels: countOf(locked, 'labels'),
      operations: countOf(locked, 'pending_operations'),
      sessions: countOf(locked, 'sessions'),
      secrets: countOf(locked, 'secrets'),
    };

    for (const route of ADMIN_ROUTES) {
      const headers: Record<string, string> = { origin: TEST_ORIGIN };
      if (route.json !== false) headers['content-type'] = 'application/json';
      const response = await locked.app.inject({
        method: route.method as 'GET',
        url: route.url,
        headers,
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      const body = JSON.parse(response.body) as { error: { code: string } };
      expect(body.error.code, `${route.method} ${route.url}`).toBe('UNAUTHENTICATED');
    }

    expect(countOf(locked, 'jobs')).toBe(before.jobs);
    expect(countOf(locked, 'repositories')).toBe(before.repositories);
    expect(countOf(locked, 'labels')).toBe(before.labels);
    expect(countOf(locked, 'pending_operations')).toBe(before.operations);
    expect(countOf(locked, 'sessions')).toBe(before.sessions);
    expect(countOf(locked, 'secrets')).toBe(before.secrets);
  });

  it('伪造、过期与空 Cookie 一律 401；重复同名 Cookie 被直接拒绝', async () => {
    locked.client
      .prepare(
        'INSERT INTO sessions (token_hash, auth_version, csrf_nonce, remember_me, created_at, last_seen_at, expires_at) VALUES (?, 1, ?, 0, 1, 1, ?)',
      )
      .run('deadbeef', 'nonce', Date.now() - 1000);

    for (const cookie of ['gr_session=forged-token-value', 'gr_session=', 'other_cookie=1; isAdmin=true']) {
      const response = await locked.app.inject({
        method: 'GET',
        url: '/api/v1/admin/system-status',
        headers: { cookie, origin: TEST_ORIGIN },
      });
      expect(response.statusCode, cookie).toBe(401);
    }

    // 同一 Cookie 名出现两次时不猜测哪一个有效。
    const duplicated = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-status',
      headers: { cookie: 'gr_session=forged; gr_session=another', origin: TEST_ORIGIN },
    });
    expect(duplicated.statusCode).toBe(403);
  });

  it('Bearer PAT、查询参数与伪造头部都不能当作管理授权', async () => {
    for (const headers of [
      { authorization: 'Bearer ghp_not-a-session', origin: TEST_ORIGIN },
      { origin: TEST_ORIGIN, 'x-forwarded-user': 'admin' },
      { origin: TEST_ORIGIN, 'x-github-token': 'ghp_x' },
    ]) {
      const response = await locked.app.inject({
        method: 'GET',
        url: '/api/v1/admin/system-status?isAdmin=true&role=admin&session=forged',
        headers,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });
});

describe('Origin、CSRF 与内容类型', () => {
  it('有效会话缺失 CSRF、跨会话 CSRF、外站 Origin 一律拒绝', async () => {
    const session = await locked.login();
    // 第二条独立会话：验证别的会话的 CSRF token 不能替我通过校验。
    const other = await locked.login({ fresh: true });

    const cases: { headers: Record<string, string>; expected: number }[] = [
      { headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'content-type': 'application/json' }, expected: 403 },
      { headers: adminHeaders(session, { 'x-csrf-token': other.csrfToken }), expected: 403 },
      { headers: adminHeaders(session, { origin: 'https://radar.example.com' }), expected: 403 },
      { headers: adminHeaders(session, { origin: 'http://127.0.0.1:8787.evil.com' }), expected: 403 },
      { headers: adminHeaders(session, { origin: 'null' }), expected: 403 },
    ];

    for (const testCase of cases) {
      const response = await locked.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/pins',
        headers: testCase.headers,
        payload: { pinsRevision: 1, ids: [] },
      });
      expect(response.statusCode, JSON.stringify(testCase.headers)).toBe(testCase.expected);
    }
  });

  it('缺少 Origin 头的写请求被拒绝，无 body 的 DELETE 也要求 Origin 与 CSRF', async () => {
    const session = await locked.login();
    const noOrigin = await locked.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/pins',
      headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { pinsRevision: 1, ids: [] },
    });
    expect(noOrigin.statusCode).toBe(403);

    const deleteWithoutCsrf = await locked.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/repositories/repo_1',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'if-match': '1' },
    });
    expect(deleteWithoutCsrf.statusCode).toBe(403);
  });

  it('表单内容类型被拒绝为 415，而不是被解析后执行', async () => {
    const session = await locked.login();
    const response = await locked.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: adminHeaders(session, { 'content-type': 'application/x-www-form-urlencoded' }),
      payload: 'token=ghp_x',
    });
    expect(response.statusCode).toBe(415);
  });

  it('登录也防跨站：外站 Origin 与表单内容类型都拒绝', async () => {
    // 登录接口按 IP 限速 5 次/分钟；本用例要连发两次登录，因此用独立实例，
    // 避免占用其他用例的配额（限速本身是生产行为，不为测试放宽）。
    const dedicated = await createTestApp();
    try {
      const crossSite = await dedicated.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        payload: { username: 'admin', password: 'x', rememberMe: false },
      });
      expect(crossSite.statusCode).toBe(403);

      const formPost = await dedicated.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin&password=x',
      });
      expect(formPost.statusCode).toBe(415);
    } finally {
      await dedicated.close();
    }
  });

  it('rememberMe 必须是真正的 JSON boolean，字符串 "false" 被拒绝', async () => {
    const response = await locked.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'TestPass1234!', rememberMe: 'false' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string; fields?: Record<string, string> } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields?.['rememberMe']).toBeDefined();
  });
});

describe('GET 无副作用与未知参数拒绝', () => {
  it('分支 GET 未命中缓存时返回 200 与 missing，且不创建任务', async () => {
    const session = await ready.login();
    const repoId = Number(
      ready.client
        .prepare(
          "INSERT INTO repositories (canonical_name, html_url, verification_state, created_at) VALUES ('owner/branch-get', 'https://github.com/owner/branch-get', 'verified', ?)",
        )
        .run(Date.now()).lastInsertRowid,
    );
    const before = countOf(ready, 'jobs');
    const response = await ready.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repositories/repo_${String(repoId)}/available-branches`,
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown[]; meta: { cacheStatus: string } };
    expect(body.data).toEqual([]);
    expect(body.meta.cacheStatus).toBe('missing');
    expect(countOf(ready, 'jobs')).toBe(before);
  });

  it('未知查询参数与强制动作参数直接拒绝', async () => {
    for (const url of [
      '/api/v1/public/repositories?force=1',
      '/api/v1/public/repositories?check=1',
      '/api/v1/public/repositories?page=0',
      '/api/v1/public/repositories?pageSize=101',
      '/api/v1/public/repositories?sort=created',
    ]) {
      const response = await locked.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('方法覆盖头不被支持', async () => {
    const response = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/public/repositories',
      headers: { 'x-http-method-override': 'DELETE' },
    });
    // 不支持覆盖语义：请求按 GET 正常处理，绝不执行 DELETE 对应动作。
    expect(response.statusCode).toBe(200);
    expect(countOf(locked, 'repositories')).toBe(0);
  });
});

describe('严格字段白名单', () => {
  it('PATCH 注入服务器维护字段时整条请求被拒绝，不静默丢弃后继续', async () => {
    const session = await ready.login();
    const repoId = Number(
      ready.client
        .prepare(
          "INSERT INTO repositories (canonical_name, html_url, verification_state, created_at) VALUES ('owner/patch', 'https://github.com/owner/patch', 'verified', ?)",
        )
        .run(Date.now()).lastInsertRowid,
    );

    for (const payload of [
      { editRevision: 1, github_id: 999 },
      { editRevision: 1, status: 'healthy' },
      { editRevision: 1, next_due_at: 0 },
      { editRevision: 1, isAdmin: true },
      { editRevision: 1, canonicalName: 'other/repo' },
      { editRevision: 1, stars: 99999 },
    ]) {
      const response = await ready.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/repositories/repo_${String(repoId)}`,
        headers: adminHeaders(session),
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const unchanged = ready.client
      .prepare('SELECT stars, canonical_name FROM repositories WHERE id = ?')
      .get(repoId) as { stars: number; canonical_name: string };
    expect(unchanged.stars).toBe(0);
    expect(unchanged.canonical_name).toBe('owner/patch');
  });

  it('缺前置版本返回 428', async () => {
    const session = await ready.login();
    const response = await ready.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/repositories/repo_1',
      headers: adminHeaders(session),
      payload: { note: 'x' },
    });
    expect(response.statusCode).toBe(428);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('REVISION_REQUIRED');

    const deleteWithoutIfMatch = await ready.app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/repositories/repo_1',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
    });
    expect(deleteWithoutIfMatch.statusCode).toBe(428);
  });
});

describe('批量边界', () => {
  it('超过 100 项的批量请求被拒绝', async () => {
    const session = await ready.login();
    const many = Array.from({ length: 101 }, (_value, index) => ({
      id: `repo_${String(index + 1)}`,
      editRevision: 1,
    }));
    const response = await ready.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-actions',
      headers: adminHeaders(session),
      payload: { action: 'pause', items: many },
    });
    expect(response.statusCode).toBe(400);
  });

  it('伪造 revision 的批量项逐项报冲突，不越界改写对象', async () => {
    const session = await ready.login();
    const repoId = Number(
      ready.client
        .prepare(
          "INSERT INTO repositories (canonical_name, html_url, verification_state, created_at, enabled) VALUES ('owner/bulk', 'https://github.com/owner/bulk', 'verified', ?, 1)",
        )
        .run(Date.now()).lastInsertRowid,
    );

    const response = await ready.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-actions',
      headers: adminHeaders(session),
      payload: { action: 'pause', items: [{ id: `repo_${String(repoId)}`, editRevision: 99 }] },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { results: { status: string }[] } };
    expect(body.data.results[0]?.status).toBe('conflict');

    const row = ready.client.prepare('SELECT enabled FROM repositories WHERE id = ?').get(repoId) as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });
});

describe('公开数据与管理缓存隔离', () => {
  it('同参数下匿名与登录返回完全相同的公开 DTO', async () => {
    const session = await ready.login();
    const anonymous = await ready.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const authenticated = await ready.app.inject({
      method: 'GET',
      url: '/api/v1/public/repositories',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(anonymous.body).toBe(authenticated.body);
  });

  it('公开 DTO 不出现任何管理字段', async () => {
    const response = await ready.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const serialized = response.body;
    for (const forbidden of ['editRevision', 'canManage', 'operationId', 'credentialRevision', 'lastErrorCode']) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('所有管理响应都是 no-store，公开响应可缓存且 ETag 稳定', async () => {
    const session = await ready.login();
    const admin = await ready.app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-status',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(admin.headers['cache-control']).toBe('no-store');

    const error = await ready.app.inject({ method: 'GET', url: '/api/v1/admin/system-status' });
    expect(error.headers['cache-control']).toBe('no-store');

    const first = await ready.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const second = await ready.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    expect(first.headers['etag']).toBeDefined();
    expect(first.headers['etag']).toBe(second.headers['etag']);
    expect(String(first.headers['cache-control'])).toContain('max-age=');

    const notModified = await ready.app.inject({
      method: 'GET',
      url: '/api/v1/public/repositories',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['date']).toBeDefined();
  });
});

describe('静态与未知路径边界', () => {
  it('未知 API 不回退 SPA，返回 JSON 404', async () => {
    for (const url of ['/api/v1/unknown', '/api/unknown']) {
      const response = await locked.app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} -> ${response.body}`).toBe(404);
      expect(response.headers['content-type'], url).toContain('application/json');
    }
  });

  it('秘密与数据路径不可通过静态服务读取', async () => {
    for (const url of ['/data/githubradar.sqlite', '/run/secrets/app_key', '/.git/config']) {
      const response = await locked.app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} -> ${response.body}`).toBe(404);
    }
  });
});

describe('会话期限与不复活', () => {
  it('空闲超时的会话在后续请求中直接失效，且不被轮询复活', async () => {
    // 直接铸造一条独立会话：登录接口有 5 次/分钟的 IP 限速，
    // 会话期限是被测行为，不应该靠消耗登录配额来准备数据。
    const minted = createSession(locked.db, locked.appKey, {
      authVersion: 1,
      rememberMe: false,
      now: Date.now(),
    });
    const idleSince = Date.now() - 13 * 60 * 60 * 1000;
    locked.client
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(idleSince, Date.now() + 60 * 60 * 1000, minted.id);

    const cookie = `gr_session=${minted.token}`;
    const polled = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie, origin: TEST_ORIGIN },
    });
    const body = JSON.parse(polled.body) as { data: { authenticated: boolean; csrfToken: string | null } };
    expect(body.data.authenticated).toBe(false);
    expect(body.data.csrfToken).toBeNull();

    const revived = locked.client
      .prepare('SELECT last_seen_at FROM sessions WHERE id = ?')
      .get(minted.id) as { last_seen_at: number };
    expect(revived.last_seen_at).toBe(idleSince);

    // 过期会话也不能用来执行管理操作。
    const admin = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-status',
      headers: { cookie, origin: TEST_ORIGIN },
    });
    expect(admin.statusCode).toBe(401);
  });
});

describe('门禁未就绪时的锁定与修复白名单', () => {
  it('未配置 PAT 时业务写入返回 409 GITHUB_SETUP_REQUIRED，匿名仍先 401', async () => {
    const session = await locked.login();
    for (const route of [
      { method: 'POST', url: '/api/v1/admin/repository-imports', payload: { input: 'owner/repo' } },
      { method: 'POST', url: '/api/v1/admin/checks', payload: { scope: 'all' } },
      { method: 'PUT', url: '/api/v1/admin/pins', payload: { pinsRevision: 1, ids: [] } },
      { method: 'POST', url: '/api/v1/admin/repository-actions', payload: { action: 'pause', items: [] } },
      { method: 'PUT', url: '/api/v1/admin/settings', payload: { revision: 1, defaultIntervalHours: 24 } },
    ]) {
      const response = await locked.app.inject({
        method: route.method as 'POST',
        url: route.url,
        headers: adminHeaders(session),
        payload: route.payload,
      });
      expect(response.statusCode, route.url).toBe(409);
      const body = JSON.parse(response.body) as { error: { code: string; message: string } };
      expect(body.error.code, route.url).toBe('GITHUB_SETUP_REQUIRED');
      // 门禁错误只说明状态与修复路径，不泄露任何秘密。
      expect(body.error.message).not.toContain('ghp_');
    }
  });

  it('修复白名单在未就绪时仍然可用：PAT 提交、代理测试、只读诊断、会话生命周期', async () => {
    // 本用例会主动退出登录，因此用独立会话，避免撤销测试基座复用的那条会话。
    const session = await locked.login({ fresh: true });

    const tokenSubmit = await locked.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: adminHeaders(session),
      payload: { token: 'github_pat_placeholder_value' },
    });
    expect([202, 400]).toContain(tokenSubmit.statusCode);

    const proxyTest = await locked.app.inject({
      method: 'POST',
      url: '/api/v1/admin/proxy/test',
      headers: adminHeaders(session),
      payload: { scheme: 'http', host: '127.0.0.1', port: 1 },
    });
    expect(proxyTest.statusCode).toBe(202);

    const status = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/admin/github-token/status',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(status.statusCode).toBe(200);
    const statusBody = JSON.parse(status.body) as { data: Record<string, unknown> };
    expect(statusBody.data['state']).toBe('missing');
    expect(statusBody.data).not.toHaveProperty('token');

    const systemStatus = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-status',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(systemStatus.statusCode).toBe(200);

    const logout = await locked.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: adminHeaders(session),
    });
    expect(logout.statusCode).toBe(204);
  });

  it('缺失凭证时显式重新验证被拒绝，不生成匿名请求', async () => {
    const session = await locked.login();
    const response = await locked.app.inject({
      method: 'POST',
      url: '/api/v1/admin/github-token/verify',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('GITHUB_TOKEN_REQUIRED');
  });

  it('状态就绪的应用允许业务写入，且凭证状态里没有明文', async () => {
    // 前置条件：测试占位凭证已激活，否则这里测到的是门禁而不是目标行为。
    expect(ready.credentials.status()).toMatchObject({ configured: true, effectiveState: 'valid' });
    const session = await ready.login();
    const response = await ready.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-imports',
      headers: adminHeaders(session),
      payload: { input: 'owner/ready-import' },
    });
    expect(response.statusCode).toBe(202);

    const secrets = ready.client.prepare('SELECT ciphertext FROM secrets').all() as { ciphertext: Buffer }[];
    for (const row of secrets) {
      expect(row.ciphertext.toString('utf8')).not.toContain('ghp_');
    }
  });
});

describe('日志与错误不含秘密标记', () => {
  it('错误响应体与失败登录响应都不回显提交的凭证', async () => {
    const session = await locked.login();
    const marker = 'ghp_SENTINEL_must_not_leak';
    const apiKeySubmit = await locked.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: adminHeaders(session, { 'content-type': 'application/json' }),
      payload: { token: marker, extra: 'nope' },
    });
    expect(apiKeySubmit.statusCode).toBe(400);
    expect(apiKeySubmit.body).not.toContain(marker);

    // 未登录的公开错误同样不回显输入。
    const publicBad = await locked.app.inject({
      method: 'GET',
      url: `/api/v1/public/repositories?q=${encodeURIComponent(marker)}&bogus=1`,
    });
    expect(publicBad.statusCode).toBe(400);
    expect(publicBad.body).not.toContain(marker);
  });
});

describe('编码路径、登录轮换与操作续期', () => {
  it('百分号编码的管理路径命中路由时仍带 no-store；编码形式的未知 API 返回 JSON 404', async () => {
    const session = await ready.login();
    // %61 = 'a'：Fastify 路由按解码后的段匹配，no-store 与未知 API 判定
    // 必须与路由同一口径，否则形成未保护别名。
    const settings = await ready.app.inject({
      method: 'GET',
      url: '/api/v1/%61dmin/settings',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.headers['cache-control']).toBe('no-store');

    const sessionProbe = await ready.app.inject({
      method: 'GET',
      url: '/api/v1/%61uth/session',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(sessionProbe.statusCode).toBe(200);
    expect(sessionProbe.headers['cache-control']).toBe('no-store');

    const unknown = await ready.app.inject({
      method: 'GET',
      url: '/%61pi/v1/definitely-missing',
      headers: { origin: TEST_ORIGIN },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain('application/json');
    const unknownBody = JSON.parse(unknown.body) as { error: { code: string } };
    expect(unknownBody.error.code).toBe('NOT_FOUND');
  });

  it('登录成功轮换请求携带的旧会话：旧 Cookie 立即失效', async () => {
    const first = await locked.login({ fresh: true });
    const relogin = await locked.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { cookie: first.cookie, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'TestPass1234!', rememberMe: false },
    });
    expect(relogin.statusCode).toBe(200);
    // 旧会话已随成功登录被撤销，不得在重新登录后继续有效。
    const stale = await locked.app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      headers: { cookie: first.cookie, origin: TEST_ORIGIN },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('真实管理写操作续期空闲窗口，GET 读取与 session 轮询不续期', async () => {
    const session = await ready.login();
    const sessionRow = (): { id: number; last_seen_at: number } =>
      ready.client
        .prepare('SELECT id, last_seen_at FROM sessions ORDER BY id DESC LIMIT 1')
        .get() as { id: number; last_seen_at: number };
    const ancient = Date.now() - 30 * 60 * 1000;
    ready.client.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(ancient, sessionRow().id);

    // GET 读取不续期。
    await ready.app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(sessionRow().last_seen_at).toBe(ancient);

    // /auth/session 轮询同样不续期。
    await ready.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN },
    });
    expect(sessionRow().last_seen_at).toBe(ancient);

    // 真实写操作（PUT settings，值不变）续期空闲窗口。
    const settings = ready.client
      .prepare('SELECT revision, default_interval_hours FROM settings WHERE id = 1')
      .get() as { revision: number; default_interval_hours: number };
    const updated = await ready.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers: adminHeaders(session),
      payload: { revision: settings.revision, defaultIntervalHours: settings.default_interval_hours },
    });
    expect(updated.statusCode).toBe(200);
    expect(sessionRow().last_seen_at).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });
});
