import { describe, expect, it } from 'vitest';

import {
  AppKeyError,
  APP_KEY_BYTES,
  APP_KEY_SECRET_NAME,
  PAT_SECRET_NAME,
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  ensureAdminAccount,
  hashPassword,
  loadOrCreateAppKey,
  verifyPassword,
} from '@githubradar/server';
import { passwordPolicyViolation } from '@githubradar/contracts';

import { adminHeaders, createTestApp, TEST_ORIGIN, type TestApp } from './app-support.js';
import { createTestDatabase, insertRepository, TEST_NOW } from './support.js';

/**
 * 系统自管理凭证与新增管理接口。
 *
 * 覆盖三件事：
 * 1. 主密钥与初始密码不再来自部署文件——首次启动生成、之后读回同一值；
 * 2. 设置页“重置 Token”与任务页“清空历史”的真实副作用；
 * 3. 标签删除与输入校验的服务端执行（前端禁用只是提示，不是边界）。
 */

async function withApp<T>(options: Parameters<typeof createTestApp>[0], run: (app: TestApp) => Promise<T>): Promise<T> {
  const app = await createTestApp(options);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe('应用主密钥自管理', () => {
  it('首次启动生成 32 字节并持久化，之后读回同一值', () => {
    const context = createTestDatabase();
    try {
      const first = loadOrCreateAppKey(context.client, () => TEST_NOW);
      expect(first.length).toBe(APP_KEY_BYTES);
      const row = context.client
        .prepare('SELECT name, value, created_at FROM app_secret WHERE name = ?')
        .get(APP_KEY_SECRET_NAME) as { name: string; value: Buffer; created_at: number };
      expect(row.created_at).toBe(TEST_NOW);
      expect(Buffer.from(row.value).equals(first)).toBe(true);

      // 重启（新连接、同一数据库）读回同一密钥，而不是重新生成。
      const second = loadOrCreateAppKey(context.client, () => TEST_NOW + 1000);
      expect(second.equals(first)).toBe(true);
      const count = context.client.prepare('SELECT COUNT(*) AS count FROM app_secret').get() as { count: number };
      expect(count.count).toBe(1);
    } finally {
      context.close();
    }
  });

  it('库内密钥长度异常时明确报错，不静默替换', () => {
    const context = createTestDatabase();
    try {
      loadOrCreateAppKey(context.client);
      context.client
        .prepare('UPDATE app_secret SET value = ? WHERE name = ?')
        .run(Buffer.from([1, 2, 3]), APP_KEY_SECRET_NAME);
      expect(() => loadOrCreateAppKey(context.client)).toThrowError(AppKeyError);
    } finally {
      context.close();
    }
  });
});

describe('管理员初始化', () => {
  it('初始密码随机生成并满足密码策略', async () => {
    const context = createTestDatabase();
    try {
      const result = await ensureAdminAccount({ db: context.db, now: () => TEST_NOW }, { hashPassword });
      expect(result.created).toBe(true);
      const password = result.initialPassword;
      expect(password).not.toBeNull();
      expect(passwordPolicyViolation(password ?? '')).toBeNull();
      expect((password ?? '').length).toBeGreaterThanOrEqual(PASSWORD_MIN_CHARS);
      expect((password ?? '').length).toBeLessThanOrEqual(PASSWORD_MAX_CHARS);

      const row = context.client.prepare('SELECT password_hash FROM admin_account WHERE id = 1').get() as {
        password_hash: string;
      };
      await expect(verifyPassword(password ?? '', row.password_hash)).resolves.toBe(true);
    } finally {
      context.close();
    }
  });

  it('已有账号时不再改动', async () => {
    const context = createTestDatabase();
    try {
      const first = await ensureAdminAccount({ db: context.db, now: () => TEST_NOW }, { hashPassword });
      expect(first.created).toBe(true);
      const firstPassword = first.initialPassword;

      const again = await ensureAdminAccount({ db: context.db, now: () => TEST_NOW }, { hashPassword });
      expect(again).toEqual({ created: false, initialPassword: null });

      const row = context.client.prepare('SELECT password_hash FROM admin_account WHERE id = 1').get() as {
        password_hash: string;
      };
      await expect(verifyPassword(firstPassword ?? '', row.password_hash)).resolves.toBe(true);
    } finally {
      context.close();
    }
  });
});

describe('重置 Token', () => {
  it('清除密文、复位为未配置并关闭业务门禁；门禁关闭期间仍可再次执行', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      expect(app.credentials.isReady()).toBe(true);

      const response = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/github-token',
        headers: adminHeaders(session),
      });
      expect(response.statusCode).toBe(200);

      const secret = app.client
        .prepare('SELECT COUNT(*) AS count FROM secrets WHERE name = ?')
        .get(PAT_SECRET_NAME) as { count: number };
      expect(secret.count).toBe(0);
      const status = app.credentials.status();
      expect(status.configured).toBe(false);
      expect(status.state).toBe('missing');
      expect(status.expiresAt).toBeNull();
      expect(status.lastErrorCode).toBeNull();
      expect(app.credentials.isReady()).toBe(false);

      // 业务写操作被门禁拒绝，凭证修复通路（含本接口）仍可用。
      const blocked = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/checks',
        headers: adminHeaders(session),
        payload: { scope: 'all' },
      });
      expect(blocked.statusCode).toBe(409);
      expect((JSON.parse(blocked.body) as { error: { code: string } }).error.code).toBe('GITHUB_SETUP_REQUIRED');

      const repeated = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/github-token',
        headers: adminHeaders(session),
      });
      expect(repeated.statusCode).toBe(200);
    });
  });

  it('缺少 CSRF 时拒绝，且不破坏已有凭证', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      const response = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/github-token',
        headers: { cookie: session.cookie, origin: TEST_ORIGIN },
      });
      expect(response.statusCode).toBe(403);
      expect(app.credentials.status().configured).toBe(true);
      expect(app.credentials.isReady()).toBe(true);
    });
  });
});

describe('清空任务历史', () => {
  const insertJob = (context: TestApp, state: string): number => {
    const finished = state === 'queued' || state === 'running' || state === 'retry_wait' ? null : TEST_NOW;
    const info = context.client
      .prepare(
        `INSERT INTO jobs (kind, queue_class, origin, accepted_at, state, created_at, finished_at)
         VALUES ('metadata', 'periodic', 'scheduler', ?, ?, ?, ?)`,
      )
      .run(TEST_NOW, state, TEST_NOW, finished);
    return Number(info.lastInsertRowid);
  };

  it('只删除终态任务，排队与执行中的任务保留', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      insertJob(app, 'succeeded');
      insertJob(app, 'failed');
      insertJob(app, 'cancelled');
      const queuedId = insertJob(app, 'queued');
      const runningId = insertJob(app, 'running');

      const response = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/jobs',
        headers: adminHeaders(session),
      });
      expect(response.statusCode).toBe(200);

      const rows = app.client.prepare('SELECT id, state FROM jobs ORDER BY id').all() as {
        id: number;
        state: string;
      }[];
      expect(rows.map((row) => row.state).sort()).toEqual(['queued', 'running']);
      expect(rows.map((row) => row.id).sort()).toEqual([queuedId, runningId]);

      // 列表接口也随之为空（终态被清掉、进行中仍在）。
      const list = await app.app.inject({
        method: 'GET',
        url: '/api/v1/admin/jobs',
        headers: adminHeaders(session),
      });
      const body = JSON.parse(list.body) as { data: { state: string }[] };
      expect(body.data).toHaveLength(2);
    });
  });

  it('导入批次引用的任务保留：逐项进度不会因清空历史退回“排队中”', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      // 复刻导入落库形状：job_group_items.status 停在 queued，终态由 JOIN jobs 得出。
      const groupId = Number(
        app.client
          .prepare("INSERT INTO job_groups (kind, created_at, finished_at) VALUES ('repository_import', ?, ?)")
          .run(TEST_NOW, TEST_NOW).lastInsertRowid,
      );
      const jobId = insertJob(app, 'succeeded');
      app.client
        .prepare(
          `INSERT INTO job_group_items (group_id, input_index, normalized_input, repo_id, job_id, status, error_code)
           VALUES (?, 0, 'owner/imported', NULL, ?, 'queued', NULL)`,
        )
        .run(groupId, jobId);
      const plainJobId = insertJob(app, 'succeeded');
      expect(plainJobId).toBeGreaterThan(jobId);

      const response = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/jobs',
        headers: adminHeaders(session),
      });
      expect(response.statusCode).toBe(200);

      const remaining = app.client.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[];
      expect(remaining.map((row) => row.id)).toEqual([jobId]);

      const progress = await app.app.inject({
        method: 'GET',
        url: `/api/v1/admin/repository-imports/${String(groupId)}`,
        headers: adminHeaders(session),
      });
      const body = JSON.parse(progress.body) as { data: { state: string; items: { status: string }[] } };
      expect(body.data.state).toBe('finished');
      expect(body.data.items[0]?.status).toBe('succeeded');
    });
  });

  it('门禁未就绪时是写操作，被服务端拒绝', async () => {
    await withApp({}, async (app) => {
      const session = await app.login();
      insertJob(app, 'succeeded');
      const response = await app.app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/jobs',
        headers: adminHeaders(session),
      });
      expect(response.statusCode).toBe(409);
      expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('GITHUB_SETUP_REQUIRED');
      const count = app.client.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
      expect(count.count).toBe(1);
    });
  });
});

describe('停止与移除单条任务', () => {
  interface JobRowShape {
    state: string;
    finished_at: number | null;
    attempt_token: string | null;
    lease_owner: string | null;
    operation_id: number | null;
  }

  const insertJob = (context: TestApp, state: string, operationId: number | null = null): number => {
    const finished = state === 'queued' || state === 'running' || state === 'retry_wait' ? null : TEST_NOW;
    const info = context.client
      .prepare(
        `INSERT INTO jobs (kind, queue_class, origin, accepted_at, state, attempt, created_at, finished_at, operation_id)
         VALUES ('metadata', 'periodic', 'scheduler', ?, ?, 1, ?, ?, ?)`,
      )
      .run(TEST_NOW, state, TEST_NOW, finished, operationId);
    return Number(info.lastInsertRowid);
  };

  const readJob = (context: TestApp, id: number): JobRowShape =>
    context.client
      .prepare('SELECT state, finished_at, attempt_token, lease_owner, operation_id FROM jobs WHERE id = ?')
      .get(id) as JobRowShape;

  it('停止未结束任务：落到 cancelled 并清空租约与 attempt_token（在途响应无法再提交）', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      const queuedId = insertJob(app, 'queued');
      app.client.prepare('UPDATE jobs SET attempt_token = ? WHERE id = ?').run('owner:1:1', queuedId);
      const runningId = insertJob(app, 'running');
      app.client
        .prepare('UPDATE jobs SET attempt_token = ?, lease_owner = ? WHERE id = ?')
        .run('owner:2:1', 'owner', runningId);

      for (const id of [queuedId, runningId]) {
        const response = await app.app.inject({
          method: 'POST',
          url: `/api/v1/admin/jobs/${String(id)}/cancel`,
          headers: adminHeaders(session),
        });
        expect(response.statusCode).toBe(200);
        const row = readJob(app, id);
        expect(row.state).toBe('cancelled');
        expect(row.finished_at).not.toBeNull();
        expect(row.attempt_token).toBeNull();
        expect(row.lease_owner).toBeNull();
      }

      // 幂等：对已取消的任务重复停止不报错，也不影响其它行。
      const again = await app.app.inject({
        method: 'POST',
        url: `/api/v1/admin/jobs/${String(queuedId)}/cancel`,
        headers: adminHeaders(session),
      });
      expect(again.statusCode).toBe(200);
      expect(readJob(app, queuedId).state).toBe('cancelled');
    });
  });

  it('停止候选操作任务时同步取消操作，界面不会停在“等待中”', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      const submitted = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/proxy',
        headers: adminHeaders(session),
        payload: { enabled: true, scheme: 'http', host: '127.0.0.1', port: 3128, expectedRevision: 1 },
      });
      expect(submitted.statusCode).toBe(202);
      const job = app.client
        .prepare("SELECT id, operation_id, state FROM jobs WHERE kind = 'proxy_test' ORDER BY id DESC LIMIT 1")
        .get() as { id: number; operation_id: number; state: string };

      const response = await app.app.inject({
        method: 'POST',
        url: `/api/v1/admin/jobs/${String(job.id)}/cancel`,
        headers: adminHeaders(session),
      });
      expect(response.statusCode).toBe(200);
      const operation = app.client
        .prepare('SELECT status FROM pending_operations WHERE id = ?')
        .get(job.operation_id) as { status: string };
      expect(operation.status).toBe('cancelled');
    });
  });

  it('移除只允许终态任务：未结束的先停止，导入批次引用的不允许移除', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      const retryId = insertJob(app, 'retry_wait');
      const failedId = insertJob(app, 'failed');

      const denied = await app.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/jobs/${String(retryId)}`,
        headers: adminHeaders(session),
      });
      expect(denied.statusCode).toBe(400);
      expect(readJob(app, retryId).state).toBe('retry_wait');

      // 导入批次引用着的任务不能删：那会让批次进度退回“排队中”。
      const groupId = Number(
        app.client
          .prepare("INSERT INTO job_groups (kind, created_at, finished_at) VALUES ('repository_import', ?, ?)")
          .run(TEST_NOW, TEST_NOW).lastInsertRowid,
      );
      const referencedId = insertJob(app, 'succeeded');
      app.client
        .prepare(
          `INSERT INTO job_group_items (group_id, input_index, normalized_input, repo_id, job_id, status, error_code)
           VALUES (?, 0, 'owner/imported', NULL, ?, 'queued', NULL)`,
        )
        .run(groupId, referencedId);
      const referenced = await app.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/jobs/${String(referencedId)}`,
        headers: adminHeaders(session),
      });
      expect(referenced.statusCode).toBe(400);

      const removed = await app.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/jobs/${String(failedId)}`,
        headers: adminHeaders(session),
      });
      expect(removed.statusCode).toBe(200);
      const remaining = app.client.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[];
      expect(remaining.map((row) => row.id)).toEqual([retryId, referencedId]);
    });
  });

  it('门禁未就绪时同样被服务端拒绝写入', async () => {
    await withApp({}, async (app) => {
      const session = await app.login();
      const jobId = insertJob(app, 'retry_wait');
      for (const request of [
        { method: 'POST' as const, url: `/api/v1/admin/jobs/${String(jobId)}/cancel` },
        { method: 'DELETE' as const, url: `/api/v1/admin/jobs/${String(jobId)}` },
      ]) {
        const response = await app.app.inject({ ...request, headers: adminHeaders(session) });
        expect(response.statusCode).toBe(409);
        expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe('GITHUB_SETUP_REQUIRED');
      }
      expect(readJob(app, jobId).state).toBe('retry_wait');
    });
  });
});

describe('标签删除与输入校验由服务端执行', () => {
  it('仍被仓库使用的标签删除被拒绝，解除关联后可删除', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();
      const created = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/labels',
        headers: adminHeaders(session),
        payload: { name: '在用标签', color: '#336699' },
      });
      expect(created.statusCode).toBe(201);
      const label = (JSON.parse(created.body) as { data: { id: string; labelRevision: number } }).data;

      const repoId = insertRepository(app.db, 'owner/label-in-use', { githubId: 7701 });
      app.client
        .prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)')
        .run(repoId, Number(label.id.replace('label_', '')));

      const denied = await app.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/labels/${label.id}`,
        headers: adminHeaders(session, { 'if-match': String(label.labelRevision) }),
      });
      expect(denied.statusCode).toBe(409);
      expect((JSON.parse(denied.body) as { error: { code: string } }).error.code).toBe('LABEL_IN_USE');

      app.client.prepare('DELETE FROM repository_labels WHERE label_id = ?').run(Number(label.id.replace('label_', '')));
      const allowed = await app.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/labels/${label.id}`,
        headers: adminHeaders(session, { 'if-match': String(label.labelRevision) }),
      });
      expect(allowed.statusCode).toBe(204);
    });
  });

  it('非法主机、端口、Token、颜色与弱密码在契约层被拒并指出字段', async () => {
    await withApp({ withValidCredential: true }, async (app) => {
      const session = await app.login();

      const proxyHost = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/proxy',
        headers: adminHeaders(session),
        payload: { enabled: true, scheme: 'http', host: 'bad host', port: 3128, expectedRevision: 1 },
      });
      expect(proxyHost.statusCode).toBe(400);
      const proxyBody = JSON.parse(proxyHost.body) as { error: { code: string; fields?: Record<string, string> } };
      expect(proxyBody.error.code).toBe('VALIDATION_FAILED');
      expect(proxyBody.error.fields?.['host']).toBeDefined();

      const proxyPort = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/proxy/test',
        headers: adminHeaders(session),
        payload: { scheme: 'http', host: '127.0.0.1', port: 70000 },
      });
      expect(proxyPort.statusCode).toBe(400);

      const token = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/github-token',
        headers: adminHeaders(session),
        payload: { token: 'ghp_has space' },
      });
      expect(token.statusCode).toBe(400);
      expect(
        (JSON.parse(token.body) as { error: { fields?: Record<string, string> } }).error.fields?.['token'],
      ).toBeDefined();

      const labelColor = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/labels',
        headers: adminHeaders(session),
        payload: { name: '颜色非法', color: 'red' },
      });
      expect(labelColor.statusCode).toBe(400);
      expect(
        (JSON.parse(labelColor.body) as { error: { fields?: Record<string, string> } }).error.fields?.['color'],
      ).toBeDefined();

      const password = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/password',
        headers: adminHeaders(session),
        payload: { currentPassword: 'TestPass1234!', newPassword: 'weakpassword' },
      });
      expect(password.statusCode).toBe(400);
      expect(
        (JSON.parse(password.body) as { error: { fields?: Record<string, string> } }).error.fields?.['newPassword'],
      ).toBeDefined();
    });
  });
});
