import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyPrereleaseBaseline,
  isAllowedHost,
  nextDiscoveryWindow,
  parsePublicOrigin,
  RateBudget,
  rescheduleGlobalInheritors,
  TransportProvider,
  type PrereleaseProjection,
  type StreamRow,
} from '@githubradar/server';

import { createTestApp, TEST_ORIGIN, HOST_HEADER, type TestApp } from './app-support.js';
import { createTestDatabase, insertRepository } from './support.js';

/** 回归测试：预发布标记、Host 与传输门禁、时钟偏差方向、代理 revision、全局档位重排、发现窗口。 */

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function streamRow(overrides: Partial<StreamRow> = {}): StreamRow {
  return {
    id: 1,
    repoId: 1,
    kind: 'prerelease',
    branchId: null,
    initializedAt: NOW - HOUR,
    projectionJson: null,
    detectedChangeAt: NOW - 5 * HOUR,
    lastSuccessAt: NOW - HOUR,
    lastErrorCode: null,
    configRevision: 1,
    nextDueAt: NOW + HOUR,
    ...overrides,
  };
}

function projection(candidate: { id: string; tagName: string } | null): PrereleaseProjection {
  return {
    candidate:
      candidate === null
        ? null
        : {
            id: candidate.id,
            tagName: candidate.tagName,
            name: candidate.tagName,
            publishedAt: '2026-10-01T00:00:00Z',
            prerelease: true,
            draft: false,
            htmlUrl: `https://github.com/o/r/releases/tag/${candidate.tagName}`,
          },
    windowLimit: 20,
    observedCount: 20,
    mayHaveMore: true,
    hasAnyPublishedRelease: true,
  };
}

describe('预发布基线不刷新 7 天标记', () => {
  it('候选完全相同不视为变化', () => {
    const existing = streamRow({ projectionJson: JSON.stringify(projection({ id: '7', tagName: 'v2.0.0-rc.1' })) });
    const result = applyPrereleaseBaseline(existing, projection({ id: '7', tagName: 'v2.0.0-rc.1' }), NOW);
    expect(result.changed).toBe(false);
    expect(result.detectedChangeAt).toBe(NOW - 5 * HOUR);
  });

  it('候选移出窗口不视为变化，也不刷新标记', () => {
    const existing = streamRow({ projectionJson: JSON.stringify(projection({ id: '7', tagName: 'v2.0.0-rc.1' })) });
    const result = applyPrereleaseBaseline(existing, projection(null), NOW);
    expect(result.changed).toBe(false);
    expect(result.detectedChangeAt).toBe(NOW - 5 * HOUR);
  });

  it('窗口内出现新的预发布候选才算变化', () => {
    const existed = streamRow({ projectionJson: JSON.stringify(projection({ id: '7', tagName: 'v2.0.0-rc.1' })) });
    const replaced = applyPrereleaseBaseline(existed, projection({ id: '8', tagName: 'v2.1.0-rc.1' }), NOW);
    expect(replaced.changed).toBe(true);
    expect(replaced.detectedChangeAt).toBe(NOW);

    const empty = streamRow({ projectionJson: JSON.stringify(projection(null)), detectedChangeAt: null });
    const firstSeen = applyPrereleaseBaseline(empty, projection({ id: '8', tagName: 'v2.1.0-rc.1' }), NOW);
    expect(firstSeen.changed).toBe(true);
  });
});

describe('Host 校验', () => {
  const loopback = parsePublicOrigin('http://127.0.0.1:8080');
  const remote = parsePublicOrigin('https://radar.example.com');

  it('接受配置主机与回环探针，拒绝其他主机', () => {
    expect(isAllowedHost(loopback, '127.0.0.1:8080', 8080, '127.0.0.1')).toBe(true);
    expect(isAllowedHost(loopback, 'localhost:8080', 8080, '127.0.0.1')).toBe(true);
    expect(isAllowedHost(remote, 'radar.example.com', 8080, '203.0.113.9')).toBe(true);
    expect(isAllowedHost(remote, 'radar.example.com:443', 8080, '203.0.113.9')).toBe(true);

    expect(isAllowedHost(remote, 'evil.example.com', 8080, '203.0.113.9')).toBe(false);
    expect(isAllowedHost(remote, 'radar.example.com.evil.com', 8080, '203.0.113.9')).toBe(false);
    expect(isAllowedHost(loopback, 'radar.example.com', 8080, '127.0.0.1')).toBe(false);
    expect(isAllowedHost(remote, undefined, 8080, '203.0.113.9')).toBe(false);
    expect(isAllowedHost(remote, '', 8080, '203.0.113.9')).toBe(false);
    // 回环 Host 分支要求直连来源也是回环：外部客户端不能借道。
    expect(isAllowedHost(remote, '127.0.0.1:8080', 8080, '203.0.113.9')).toBe(false);
  });

  it('恶意 Host 在应用层被拒绝', async () => {
    const app = await createTestApp();
    try {
      const bad = await app.app.inject({
        method: 'GET',
        url: '/api/v1/public/config',
        headers: { host: 'evil.example.com' },
      });
      expect(bad.statusCode).toBe(403);

      const good = await app.app.inject({
        method: 'GET',
        url: '/api/v1/public/config',
        headers: { host: HOST_HEADER },
      });
      expect(good.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('非回环明文 HTTP 不承认已有 Cookie', () => {
  let app: TestApp;
  let session: { cookie: string; csrfToken: string };

  beforeEach(async () => {
    // 先用回环 Origin 取得一个真实会话，再以非回环明文 Origin 重建应用。
    const loopbackApp = await createTestApp({ withValidCredential: true });
    session = await loopbackApp.login();
    await loopbackApp.close();
    app = await createTestApp({ withValidCredential: true, publicOrigin: 'http://192.168.1.50:8080' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('/auth/session 按未登录返回，管理接口一律 403', async () => {
    const sessionResponse = await app.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: session.cookie, origin: 'http://192.168.1.50:8080', host: '192.168.1.50:8080' },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const body = JSON.parse(sessionResponse.body) as { data: { authenticated: boolean; csrfToken: string | null } };
    expect(body.data.authenticated).toBe(false);
    expect(body.data.csrfToken).toBeNull();

    const admin = await app.app.inject({
      method: 'GET',
      url: '/api/v1/admin/system-status',
      headers: { cookie: session.cookie, origin: 'http://192.168.1.50:8080', host: '192.168.1.50:8080' },
    });
    expect(admin.statusCode).toBe(403);

    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://192.168.1.50:8080', host: '192.168.1.50:8080', 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'TestPass1234!', rememberMe: false },
    });
    expect(login.statusCode).toBe(403);
  });
});

describe('配额节奏的时钟偏差校正', () => {
  it('宿主时钟偏差只校正一次，且方向是"换算到本地时钟"', () => {
    const db = createTestDatabase();
    try {
      const skewMs = 10 * 60 * 1000;
      let localNow = NOW;
      const budget = new RateBudget(db.db, () => localNow);
      // 上游 Date 比本机快 10 分钟 → skew = +10min。
      budget.observeServerDate(new Date(localNow + skewMs).toUTCString());

      const resetAt = NOW + 60 * 60 * 1000;
      budget.observe({ resource: 'core', limit: 5000, remaining: 4000, resetAt, observedAt: NOW });

      // 剩余窗口按本地时钟计算为 50 分钟，而不是 60 或 70 分钟。
      const state = budget.state();
      expect(state.resetAt).toBe(resetAt - skewMs);
      const wait = budget.nextRequestAt() - localNow;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThan(60 * 60 * 1000);
    } finally {
      db.close();
    }
  });
});

describe('代理 revision 参与传输层缓存', () => {
  it('同 host/端口/用户名但 revision 变化时重建通道并关闭旧通道', () => {
    const created: { password: string | null; closed: boolean }[] = [];
    let revision = 1;
    let password = 'old-secret';
    const proxy = { scheme: 'http' as const, host: 'proxy.local', port: 3128, username: 'u' };

    const provider = new TransportProvider({
      credentials: { activeProxy: () => ({ ...proxy, password }), readProxy: () => ({ enabled: true, revision }) } as never,
      describeProxy: () => ({ enabled: true, revision }),
      createTransport: () => {
        const entry = { password, closed: false };
        created.push(entry);
        return {
          request: () => Promise.reject(new Error('not used')),
          describe: () => ({ mode: 'proxy' as const, proxyScheme: 'http' as const }),
          close: () => {
            entry.closed = true;
          },
        };
      },
    });

    expect(provider.describe().mode).toBe('proxy');
    expect(created).toHaveLength(1);

    // 只轮换密码：signature 不变，只有 revision 能触发重建。
    password = 'new-secret';
    revision = 2;
    expect(provider.describe().mode).toBe('proxy');
    expect(created).toHaveLength(2);
    expect(created[1]?.password).toBe('new-secret');
    expect(created[0]?.closed).toBe(true);

    // revision 不变时复用同一实例。
    expect(provider.describe().mode).toBe('proxy');
    expect(created).toHaveLength(2);

    provider.close();
    expect(created[1]?.closed).toBe(true);
  });
});

describe('全局档位变化重排继承仓库', () => {
  it('已过期的流只安排一次错峰追赶，单仓覆盖不受影响', () => {
    const db = createTestDatabase();
    try {
      const inherited = insertRepository(db.db, 'owner/inherit');
      const overridden = insertRepository(db.db, 'owner/overridden');
      db.client.prepare("UPDATE repositories SET verification_state = 'verified', interval_hours = 12 WHERE id = ?").run(overridden);

      const insertStream = db.client.prepare(
        "INSERT INTO monitor_streams (repo_id, kind, phase_seed, next_due_at, config_revision) VALUES (?, 'metadata', ?, ?, 1)",
      );
      // 继承全局的流已经过期很久；单仓 12 小时覆盖的流保持原相位。
      insertStream.run(inherited, 42, NOW - 30 * HOUR);
      const overrideStreamId = Number(insertStream.run(overridden, 7, NOW - 30 * HOUR).lastInsertRowid);

      const affected = rescheduleGlobalInheritors(db.db, NOW, 3);
      expect(affected).toBe(1);

      const inheritedDue = db.client
        .prepare('SELECT next_due_at FROM monitor_streams WHERE repo_id = ?')
        .get(inherited) as { next_due_at: number };
      // 追赶点落在未来 15 分钟内的错峰位置，而不是立刻并发。
      expect(inheritedDue.next_due_at).toBeGreaterThan(NOW);
      expect(inheritedDue.next_due_at).toBeLessThanOrEqual(NOW + 15 * 60 * 1000);

      const overrideDue = db.client
        .prepare('SELECT next_due_at FROM monitor_streams WHERE id = ?')
        .get(overrideStreamId) as { next_due_at: number };
      expect(overrideDue.next_due_at).toBe(NOW - 30 * HOUR);
    } finally {
      db.close();
    }
  });
});

describe('每日发现窗口', () => {
  it('落在北京时间 10:00 之后的部署稳定偏移上，一天一次', () => {
    // UTC 01:00（北京时间 09:00）时，下一个窗口应在当天；UTC 03:00 时应在次日。
    const beforeWindow = Date.UTC(2026, 9, 10, 1, 0, 0);
    const afterWindow = Date.UTC(2026, 9, 10, 3, 0, 0);

    const first = nextDiscoveryWindow(beforeWindow, 600);
    expect(first).toBe(Date.UTC(2026, 9, 10, 2, 0, 0) + 600 * 1000);
    expect(first - beforeWindow).toBe(HOUR + 600 * 1000);

    const second = nextDiscoveryWindow(afterWindow, 600);
    expect(second).toBe(Date.UTC(2026, 9, 11, 2, 0, 0) + 600 * 1000);
    expect(second - first).toBe(24 * HOUR);
  });
});

describe('不可检测仓库的手动检测', () => {
  it('身份失配仓库不创建任务，也不占住该流的去重键', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const repoId = Number(
        app.client
          .prepare(
            `INSERT INTO repositories (canonical_name, html_url, verification_state, created_at, blocked_reason)
             VALUES ('owner/blocked', 'https://github.com/owner/blocked', 'verified', ?, 'REPOSITORY_IDENTITY_CHANGED')`,
          )
          .run(Date.now()).lastInsertRowid,
      );
      expect(() => app.scheduler.scheduleManualCheck(repoId, 'manual')).toThrowError();

      const jobs = app.client.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
      expect(jobs.count).toBe(0);

      // 公开状态按"检测失败"呈现，而不是"用户暂停"。
      const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
      const body = JSON.parse(list.body) as { data: { id: string; status: string }[] };
      expect(body.data[0]?.status).toBe('error');
    } finally {
      await app.close();
    }
  });

  it('对不可检测仓库调用 checks 返回明确错误而不是"已排队"', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const repoId = Number(
        app.client
          .prepare(
            `INSERT INTO repositories (canonical_name, html_url, verification_state, created_at, blocked_reason)
             VALUES ('owner/blocked2', 'https://github.com/owner/blocked2', 'verified', ?, 'REPOSITORY_IDENTITY_CHANGED')`,
          )
          .run(Date.now()).lastInsertRowid,
      );
      const session = await app.login();
      const response = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/checks',
        headers: {
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
          cookie: session.cookie,
          'x-csrf-token': session.csrfToken,
        },
        payload: { scope: 'selected', ids: [`repo_${String(repoId)}`] },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body) as { error: { code: string } };
      expect(body.error.code).toBe('GITHUB_ACCESS_DENIED_OR_MISSING');
    } finally {
      await app.close();
    }
  });
});

describe('入站限速的响应形状', () => {
  it('登录超过 5 次/分钟返回 429 RATE_LIMITED，而不是 500', async () => {
    const app = await createTestApp();
    try {
      let lastStatus = 0;
      let lastBody = '';
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await app.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
          payload: { username: 'admin', password: 'wrong-password', rememberMe: false },
        });
        lastStatus = response.statusCode;
        lastBody = response.body;
        if (lastStatus === 429) break;
      }
      expect(lastStatus).toBe(429);
      expect((JSON.parse(lastBody) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});

describe('改密事务、代理激活复核、凭证复核退避与到期落库', () => {
  it('改密在途期间会话被撤销：最终事务拒绝提交', async () => {
    const app = await createTestApp();
    try {
      const session = await app.login();
      const hashBefore = (
        app.client.prepare('SELECT password_hash FROM admin_account WHERE id = 1').get() as {
          password_hash: string;
        }
      ).password_hash;
      // 不 await：scrypt 哈希期间事件循环让出，logout 先落地撤销会话。
      const passwordPromise = app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/password',
        headers: {
          cookie: session.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        payload: { currentPassword: 'TestPass1234!', newPassword: 'RotatedPass123' },
      });
      const logout = await app.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: session.cookie,
          origin: TEST_ORIGIN,
          'x-csrf-token': session.csrfToken,
        },
      });
      expect(logout.statusCode).toBe(204);
      const password = await passwordPromise;
      // 撤销先提交则后续同步写拒绝；密码哈希未被修改。
      expect([401, 403]).toContain(password.statusCode);
      const hashAfter = (
        app.client.prepare('SELECT password_hash FROM admin_account WHERE id = 1').get() as {
          password_hash: string;
        }
      ).password_hash;
      expect(hashAfter).toBe(hashBefore);
    } finally {
      await app.close();
    }
  });

  it('改密并发只允许一个成功，另一个被拒绝并撤销全部会话', async () => {
    const app = await createTestApp();
    try {
      const sessionA = await app.login({ fresh: true });
      const sessionB = await app.login({ fresh: true });
      const change = (session: typeof sessionA, newPassword: string) =>
        app.app.inject({
          method: 'PUT',
          url: '/api/v1/admin/password',
          headers: {
            cookie: session.cookie,
            origin: TEST_ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': session.csrfToken,
          },
          payload: { currentPassword: 'TestPass1234!', newPassword },
        });
      const [first, second] = await Promise.all([
        change(sessionA, 'RotatedPassA123'),
        change(sessionB, 'RotatedPassB123'),
      ]);
      // 同一旧密码的并发改密：恰好一个成功；另一个按版本冲突（409）
      // 或验证失败（401，若其读取发生在第一个提交之后）被拒绝。
      const outcomes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
      expect(outcomes[0]).toBe(204);
      expect([401, 409]).toContain(outcomes[1]);
      const sessions = app.client.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
      expect(sessions.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('发起会话撤销后候选代理不被应用', async () => {
    const app = await createTestApp();
    try {
      const session = await app.login();
      const submit = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/proxy',
        headers: {
          cookie: session.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        payload: { enabled: true, expectedRevision: 1, scheme: 'http', host: '10.0.0.8', port: 3128 },
      });
      expect(submit.statusCode).toBe(202);
      const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);

      // 模拟“提交后会话失效”：把发起会话置为已过期（行保留——级联删除路径
      // 由外键 ON DELETE CASCADE 直接销毁候选，这里测的是仍然存活的候选行
      // 必须被激活前的会话复核拦下）。
      app.client.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000);
      const applied = app.credentials.applyProxyResult(operationId, { ok: true, stages: [], detail: null });
      expect(applied).toBe(false);
      const proxy = app.credentials.readProxy();
      expect(proxy.enabled).toBe(false);
      expect(app.credentials.readOperation(operationId)?.status).toBe('cancelled');
    } finally {
      await app.close();
    }
  });

  it('凭证复核失败按 1/5/15 分钟阶梯退避，之后每日一次', async () => {
    const app = await createTestApp();
    try {
      const failWithGap = async (previousAttemptOffsetMs: number | null): Promise<number> => {
        if (previousAttemptOffsetMs !== null) {
          app.client
            .prepare('UPDATE github_credential_status SET last_attempt_at = ? WHERE id = 1')
            .run(Date.now() - previousAttemptOffsetMs);
        }
        const before = Date.now();
        const snapshot = app.credentials.beginActiveVerification();
        app.credentials.applyActiveVerification(snapshot, {
          ok: false,
          accountId: null,
          status: 401,
          errorCode: 'GITHUB_TOKEN_INVALID',
          errorMessage: 'Bad credentials',
          tokenMetadata: null,
          rateLimit: null,
          connectivity: 'reachable',
        });
        return (app.credentials.status().nextVerificationAt ?? 0) - before;
      };

      // 新一轮失败序列：60 秒后复核。
      const firstDelay = await failWithGap(null);
      expect(firstDelay).toBeGreaterThanOrEqual(55 * 1000);
      expect(firstDelay).toBeLessThanOrEqual(70 * 1000);

      // 距上一次尝试 60 秒的连续失败：5 分钟档。
      const secondDelay = await failWithGap(60 * 1000);
      expect(secondDelay).toBeGreaterThanOrEqual(4 * 60 * 1000);
      expect(secondDelay).toBeLessThanOrEqual(6 * 60 * 1000);

      // 距上一次尝试 30 分钟的失败：进入每日一次的稳态档。
      const thirdDelay = await failWithGap(30 * 60 * 1000);
      expect(thirdDelay).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
      expect(thirdDelay).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

      expect(app.credentials.status().state).toBe('invalid');
      expect(app.credentials.isReady()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('稳态复核的首次失败从 60 秒起步，不直接跳到每小时封顶', async () => {
    const app = await createTestApp();
    try {
      // 稳态：上一次复核在一小时前成功（last_verified_at 覆盖上一次尝试）。
      const hourAgo = Date.now() - 60 * 60 * 1000;
      app.client
        .prepare(
          `UPDATE github_credential_status
              SET credential_state = 'valid', last_verified_at = ?, last_authenticated_at = ?, last_attempt_at = ?
            WHERE id = 1`,
        )
        .run(hourAgo, hourAgo, hourAgo);
      const before = Date.now();
      const snapshot = app.credentials.beginActiveVerification();
      app.credentials.applyActiveVerification(snapshot, {
        ok: false,
        accountId: null,
        status: 401,
        errorCode: 'GITHUB_TOKEN_INVALID',
        errorMessage: 'Bad credentials',
        tokenMetadata: null,
        rateLimit: null,
        connectivity: 'reachable',
      });
      const delay = (app.credentials.status().nextVerificationAt ?? 0) - before;
      // 稳态下的首次失败必须落在 1/5/15 阶梯的第一档，而不是按每日稳态间隔直接封顶。
      expect(delay).toBeGreaterThanOrEqual(55 * 1000);
      expect(delay).toBeLessThanOrEqual(70 * 1000);
    } finally {
      await app.close();
    }
  });

  it('复核遇到 5xx 这类可重试失败也安排阶梯退避（控制任务不再走任务级重试）', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const before = Date.now();
      const snapshot = app.credentials.beginActiveVerification();
      app.credentials.applyActiveVerification(snapshot, {
        ok: false,
        accountId: null,
        status: 502,
        errorCode: 'SERVICE_UNAVAILABLE',
        errorMessage: 'Bad gateway',
        tokenMetadata: null,
        rateLimit: null,
        connectivity: 'reachable',
      });
      const status = app.credentials.status();
      // 一次 5xx 不该让凭证下线（不写 invalid），但必须把复核排到阶梯的第一档，
      // 否则复核任务失败即终态之后，一次瞬时故障会拖到下一个每日窗口。
      expect(status.state).toBe('valid');
      const delay = (status.nextVerificationAt ?? 0) - before;
      expect(delay).toBeGreaterThanOrEqual(55 * 1000);
      expect(delay).toBeLessThanOrEqual(70 * 1000);
    } finally {
      await app.close();
    }
  });

  it('已知可信到期时间到达后由后台持久化 expired 并递增 gate revision', async () => {
    const app = await createTestApp();
    try {
      const now = Date.now();
      app.client
        .prepare(
          `UPDATE github_credential_status
              SET credential_state = 'valid', expires_at = ?, expires_observed_at = ?
            WHERE id = 1`,
        )
        .run(now - 1000, now - 60_000);
      const gateBefore = app.credentials.gateRevision();
      app.credentials.persistTimeBoundaries();
      const status = app.credentials.status();
      expect(status.state).toBe('expired');
      expect(status.effectiveState).toBe('expired');
      expect(app.credentials.gateRevision()).toBe(gateBefore + 1);
      expect(app.credentials.isReady()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('48 小时无可信认证成功的边界同样落库：unverified 并递增 gate revision', async () => {
    const app = await createTestApp();
    try {
      const now = Date.now();
      app.client
        .prepare(
          `UPDATE github_credential_status
              SET credential_state = 'valid', last_verified_at = ?, last_authenticated_at = ?
            WHERE id = 1`,
        )
        .run(now - 60_000, now - 49 * 60 * 60 * 1000);
      const gateBefore = app.credentials.gateRevision();
      app.credentials.persistTimeBoundaries();
      const status = app.credentials.status();
      expect(status.state).toBe('unverified');
      expect(app.credentials.gateRevision()).toBe(gateBefore + 1);
      expect((status.nextVerificationAt ?? 0)).toBeLessThanOrEqual(now + 1000);
      expect(app.credentials.isReady()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('分档估算按各档自身速率计算，单仓覆盖不受档位假设影响', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const twelve = insertRepository(app.db, 'owner/twelve', { githubId: 8101 });
      const inherits = insertRepository(app.db, 'owner/inherits', { githubId: 8102 });
      for (const [repoId, intervalHours] of [
        [twelve, 12],
        [inherits, null],
      ] as const) {
        app.client
          .prepare(
            `UPDATE repositories SET verification_state = 'verified', enabled = 1, blocked_reason = NULL,
                    interval_hours = ?, release_enabled = 1, include_prereleases = 0 WHERE id = ?`,
          )
          .run(intervalHours, repoId);
        app.client
          .prepare(
            "INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name, enabled) VALUES (?, 'fixed', 'main', 'main', 1)",
          )
          .run(repoId);
      }
      const session = await app.login();
      const response = await app.app.inject({
        method: 'GET',
        url: '/api/v1/admin/system-status',
        headers: { cookie: session.cookie, origin: TEST_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      const data = (
        JSON.parse(response.body) as {
          data: { throughput: { plannedRequestsPerHourByTier: Record<'3' | '6' | '12' | '24', number> } };
        }
      ).data;
      // 每轮请求 = 1 metadata + 1 release + 1 分支 = 3：12h 覆盖仓恒为 3/12=0.25/h，
      // 继承仓随假设档位 3/T。绝不能把“当前速率”再乘 24/tier。
      expect(data.throughput.plannedRequestsPerHourByTier['3']).toBe(1.25);
      expect(data.throughput.plannedRequestsPerHourByTier['6']).toBe(0.75);
      expect(data.throughput.plannedRequestsPerHourByTier['12']).toBe(0.5);
      expect(data.throughput.plannedRequestsPerHourByTier['24']).toBe(0.38);
    } finally {
      await app.close();
    }
  });
});

describe('TRUSTED_PROXY 转发头集成', () => {
  it('未配置受信代理时伪造 XFF 不分桶；配置后不同 XFF 各自计数', async () => {
    // 未配置受信代理：伪造 XFF 不影响限速计数（同一个直连 IP 的桶），7 次内触发 429。
    const untrusted = await createTestApp();
    try {
      let saw429 = false;
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await untrusted.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            origin: TEST_ORIGIN,
            'content-type': 'application/json',
            'x-forwarded-for': `9.9.9.${attempt}`,
          },
          payload: { username: 'admin', password: 'wrong', rememberMe: false },
        });
        if (response.statusCode === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    } finally {
      await untrusted.close();
    }

    // 配置受信代理（直连方 127.0.0.1 命中列表）：不同 XFF 是不同的桶，不触发限速。
    const trusted = await createTestApp({ trustedProxies: ['127.0.0.1'] });
    try {
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await trusted.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: {
            origin: TEST_ORIGIN,
            'content-type': 'application/json',
            'x-forwarded-for': `8.8.8.${attempt}`,
          },
          payload: { username: 'admin', password: 'wrong', rememberMe: false },
        });
        // 各伪造来源 IP 各自计数：7 次不同 XFF 都不应触发 429。
        expect(response.statusCode, `attempt ${attempt}`).toBe(401);
      }
    } finally {
      await trusted.close();
    }
  });
});
