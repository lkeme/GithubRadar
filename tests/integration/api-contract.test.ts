import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AvailableBranchesResponse,
  BulkActionResponse,
  CredentialStatusResponse,
  DailyTrendResponse,
  ImportProgressResponse,
  JobListResponse,
  LabelListAdminResponse,
  LabelListResponse,
  MetricsResponse,
  OperationResponse,
  PinsResponse,
  ProxyStatusResponse,
  PublicConfig,
  RepositoryControlsResponse,
  RepositoryDetail,
  RepositoryListResponse,
  SessionResponse,
  SettingsResponse,
  SystemStatusResponse,
} from '@githubradar/contracts';

import { adminHeaders, createTestApp, type LoggedInSession, type TestApp } from './app-support.js';

/**
 * 契约一致性。
 *
 * 直接拿真实应用的响应去校验共享契约 schema，避免出现「契约里声明了但实现从不返回」
 * 或「实现了但契约里没有」这两类漂移。公开 DTO 用 strictObject，因此多一个字段也算失败。
 */

let context: TestApp;
let session: LoggedInSession;

const NOW = Date.now();

beforeAll(async () => {
  context = await createTestApp({ withValidCredential: true });

  // 一个已验证仓库 + 三条采集流，让公开投影有真实内容可校验。
  const repoId = Number(
    context.client
      .prepare(
        `INSERT INTO repositories
           (github_id, canonical_name, display_name, note, description, html_url, is_private, language,
            stars, forks, archived, enabled, interval_hours, release_enabled, include_prereleases,
            default_branch, verification_state, identity_verified_at, created_at)
         VALUES (4242, 'owner/contract-fixture', '契约样本', 'note', 'desc', 'https://github.com/owner/contract-fixture',
                 0, 'TypeScript', 100, 20, 0, 1, 6, 1, 1, 'main', 'verified', ?, ?)`,
      )
      .run(NOW, NOW).lastInsertRowid,
  );
  const branchId = Number(
    context.client
      .prepare("INSERT INTO tracked_branches (repo_id, mode, resolved_name, enabled) VALUES (?, 'default', 'main', 1)")
      .run(repoId).lastInsertRowid,
  );

  const insertStream = context.client.prepare(
    `INSERT INTO monitor_streams
       (repo_id, kind, branch_id, initialized_at, current_projection_json, detected_change_at,
        last_attempt_at, last_success_at, next_due_at, phase_seed, config_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  insertStream.run(
    repoId,
    'metadata',
    null,
    NOW,
    JSON.stringify({
      id: '4242',
      fullName: 'owner/contract-fixture',
      displayName: '契约样本',
      description: 'desc',
      htmlUrl: 'https://github.com/owner/contract-fixture',
      ownerAvatarUrl: null,
      isPrivate: false,
      language: 'TypeScript',
      stars: 100,
      forks: 20,
      archived: false,
      defaultBranch: 'main',
    }),
    null,
    NOW,
    NOW,
    NOW + 6 * 60 * 60 * 1000,
    11,
  );
  insertStream.run(
    repoId,
    'release',
    null,
    NOW,
    JSON.stringify({
      id: '7001',
      tagName: 'v1.2.3',
      name: 'v1.2.3',
      publishedAt: new Date(NOW - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      prerelease: false,
      draft: false,
      htmlUrl: 'https://github.com/owner/contract-fixture/releases/tag/v1.2.3',
    }),
    NOW - 86_400_000,
    NOW,
    NOW,
    NOW + 6 * 60 * 60 * 1000,
    13,
  );
  insertStream.run(
    repoId,
    'branch',
    branchId,
    NOW,
    JSON.stringify({
      sha: 'd'.repeat(40),
      committedAt: new Date(NOW - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      htmlUrl: 'https://github.com/owner/contract-fixture/tree/main',
    }),
    NOW - 3600_000,
    NOW,
    NOW,
    NOW + 6 * 60 * 60 * 1000,
    17,
  );
  context.client
    .prepare(
      'INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, 100, 20, ?, ?)',
    )
    .run(repoId, new Date(NOW + 8 * 3600_000).toISOString().slice(0, 10), NOW, NOW);

  session = await context.login();
});

afterAll(async () => {
  await context.close();
});

function expectValid<T>(schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } }, body: string, label: string): T {
  const parsed = schema.safeParse(JSON.parse(body) as unknown);
  if (!parsed.success) {
    throw new Error(`${label} 与契约不一致：${JSON.stringify(parsed.error, null, 2)}`);
  }
  return JSON.parse(body) as T;
}

describe('公开接口响应符合契约', () => {
  it('GET /public/config', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/public/config' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: unknown };
    expectValid(PublicConfig, JSON.stringify(body.data), 'PublicConfig');
    // 前台状态标记只说明初始化/陈旧，不含凭证原因。
    expect(['ready', 'initializing', 'stale']).toContain((body.data as { overallState: string }).overallState);
  });

  it('GET /public/repositories 含白名单字段，且不含管理字段', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    expect(response.statusCode).toBe(200);
    expectValid(RepositoryListResponse, response.body, 'RepositoryListResponse');

    const body = JSON.parse(response.body) as { data: { fullName: string; trends: unknown[] }[] };
    const fixture = body.data.find((item) => item.fullName === 'owner/contract-fixture');
    expect(fixture).toBeDefined();
    expect(fixture?.trends.length).toBeGreaterThan(0);
  });

  it('GET /public/trends：尚无报告时返回空结构与 null 来源，日期参数非法被拒绝', async () => {
    const empty = await context.app.inject({ method: 'GET', url: '/api/v1/public/trends' });
    expect(empty.statusCode).toBe(200);
    expectValid(DailyTrendResponse, empty.body, 'DailyTrendResponse');
    const emptyBody = JSON.parse(empty.body) as { data: unknown[]; meta: { day: string | null; source: unknown } };
    expect(emptyBody.data).toEqual([]);
    expect(emptyBody.meta.day).toBeNull();
    expect(emptyBody.meta.source).toBeNull();

    const bad = await context.app.inject({ method: 'GET', url: '/api/v1/public/trends?day=2026/10/24' });
    expect(bad.statusCode).toBe(400);

    const unknown = await context.app.inject({ method: 'GET', url: '/api/v1/public/trends?pageSize=101' });
    expect(unknown.statusCode).toBe(400);
  });

  it('GET /public/labels 与 GET /public/repositories/:id/metrics', async () => {
    const labels = await context.app.inject({ method: 'GET', url: '/api/v1/public/labels' });
    expect(labels.statusCode).toBe(200);
    // 公开标签列表整体按契约校验（LabelListResponse 的 meta 为 strict 空对象）。
    expectValid(LabelListResponse, labels.body, 'LabelListResponse');

    // 夹具仓库的内部 ID 不保证是 1，这里按列表取真实 ID 再校验趋势接口。
    const list = await context.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const first = (JSON.parse(list.body) as { data: { id: string }[] }).data[0];
    expect(first).toBeDefined();
    const metrics = await context.app.inject({
      method: 'GET',
      url: `/api/v1/public/repositories/${String(first?.id)}/metrics?days=30`,
    });
    expect(metrics.statusCode).toBe(200);
    expectValid(MetricsResponse, metrics.body, 'MetricsResponse');

    const missing = await context.app.inject({
      method: 'GET',
      url: '/api/v1/public/repositories/repo_999999/metrics?days=30',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('会话与管理接口响应符合契约', () => {
  it('GET /auth/session', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787' },
    });
    expect(response.statusCode).toBe(200);
    expectValid(SessionResponse, response.body, 'SessionResponse');
  });

  it('GET /admin/system-status 与 settings / jobs / pins / proxy', async () => {
    const headers = { cookie: session.cookie, origin: 'http://127.0.0.1:8787' };

    const status = await context.app.inject({ method: 'GET', url: '/api/v1/admin/system-status', headers });
    expect(status.statusCode).toBe(200);
    expectValid(SystemStatusResponse, status.body, 'SystemStatusResponse');

    const settings = await context.app.inject({ method: 'GET', url: '/api/v1/admin/settings', headers });
    expect(settings.statusCode).toBe(200);
    expectValid(SettingsResponse, settings.body, 'SettingsResponse');

    const jobs = await context.app.inject({ method: 'GET', url: '/api/v1/admin/jobs', headers });
    expect(jobs.statusCode).toBe(200);
    expectValid(JobListResponse, jobs.body, 'JobListResponse');

    const pins = await context.app.inject({ method: 'GET', url: '/api/v1/admin/pins', headers });
    expect(pins.statusCode).toBe(200);
    expectValid(PinsResponse, pins.body, 'PinsResponse');

    const proxy = await context.app.inject({ method: 'GET', url: '/api/v1/admin/proxy', headers });
    expect(proxy.statusCode).toBe(200);
    expectValid(ProxyStatusResponse, proxy.body, 'ProxyStatusResponse');

    const labels = await context.app.inject({ method: 'GET', url: '/api/v1/admin/labels', headers });
    expect(labels.statusCode).toBe(200);
    expectValid(LabelListAdminResponse, labels.body, 'LabelListAdminResponse');

    const tokenStatus = await context.app.inject({
      method: 'GET',
      url: '/api/v1/admin/github-token/status',
      headers,
    });
    expect(tokenStatus.statusCode).toBe(200);
    expectValid(CredentialStatusResponse, tokenStatus.body, 'CredentialStatusResponse');
    // 状态卡绝不含明文或片段。
    expect(tokenStatus.body).not.toContain('ghp_');
  });

  it('GET /admin/repository-controls 与单仓详情', async () => {
    const headers = { cookie: session.cookie, origin: 'http://127.0.0.1:8787' };

    const list = await context.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const ids = (JSON.parse(list.body) as { data: { id: string }[] }).data.map((item) => item.id);
    expect(ids.length).toBeGreaterThan(0);

    const controls = await context.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repository-controls?ids=${ids.join(',')}`,
      headers,
    });
    expect(controls.statusCode).toBe(200);
    expectValid(RepositoryControlsResponse, controls.body, 'RepositoryControlsResponse');

    for (const id of ids) {
      const detail = await context.app.inject({
        method: 'GET',
        url: `/api/v1/admin/repositories/${id}`,
        headers,
      });
      expect(detail.statusCode, id).toBe(200);
      const detailBody = JSON.parse(detail.body) as { data: unknown; meta: unknown };
      expectValid(RepositoryDetail, JSON.stringify(detailBody.data), `RepositoryDetail ${id}`);

      const branches = await context.app.inject({
        method: 'GET',
        url: `/api/v1/admin/repositories/${id}/available-branches`,
        headers,
      });
      expect(branches.statusCode, id).toBe(200);
      expectValid(AvailableBranchesResponse, branches.body, `AvailableBranchesResponse ${id}`);
    }
  });

  it('候选操作视图（job 形式）符合契约', async () => {
    const verify = await context.app.inject({
      method: 'POST',
      url: '/api/v1/admin/github-token/verify',
      headers: adminHeaders(session),
    });
    expect(verify.statusCode).toBe(202);
    const operationId = (JSON.parse(verify.body) as { data: { operationId: string } }).data.operationId;

    const operation = await context.app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/${operationId}`,
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787' },
    });
    expect(operation.statusCode).toBe(200);
    expectValid(OperationResponse, operation.body, 'OperationResponse');
  });

  it('导入批次与任务组进度符合契约', async () => {
    const headers = { cookie: session.cookie, origin: 'http://127.0.0.1:8787' };
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-imports',
      headers: adminHeaders(session),
      payload: { input: 'owner/contract-import' },
    });
    expect(created.statusCode).toBe(202);
    const groupId = (JSON.parse(created.body) as { data: { groupId: string } }).data.groupId;
    expect(groupId).not.toBe('');

    // 单行导入批次：进度接口与任务组接口返回同一形状，逐行 ImportItem 一并校验收敛。
    const progress = await context.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repository-imports/${groupId}`,
      headers,
    });
    expect(progress.statusCode).toBe(200);
    const progressBody = expectValid<{ data: { total: number; items: unknown[] } }>(
      ImportProgressResponse,
      progress.body,
      'ImportProgressResponse',
    );
    expect(progressBody.data.total).toBe(1);
    expect(progressBody.data.items).toHaveLength(1);

    const group = await context.app.inject({
      method: 'GET',
      url: `/api/v1/admin/job-groups/${groupId}`,
      headers,
    });
    expect(group.statusCode).toBe(200);
    expectValid(ImportProgressResponse, group.body, 'ImportProgressResponse（job-groups）');
  });

  it('POST /admin/repository-actions 符合契约', async () => {
    const headers = { cookie: session.cookie, origin: 'http://127.0.0.1:8787' };
    const list = await context.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const targetId = (JSON.parse(list.body) as { data: { id: string }[] }).data[0]?.id ?? '';
    expect(targetId).not.toBe('');

    const revisionOf = async (url: string): Promise<number> => {
      const detail = await context.app.inject({ method: 'GET', url, headers });
      expect(detail.statusCode).toBe(200);
      return (JSON.parse(detail.body) as { data: { editRevision: number } }).data.editRevision;
    };
    const detailUrl = `/api/v1/admin/repositories/${targetId}`;

    const pause = await context.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-actions',
      headers: adminHeaders(session),
      payload: { action: 'pause', items: [{ id: targetId, editRevision: await revisionOf(detailUrl) }] },
    });
    expect(pause.statusCode).toBe(200);
    const pauseBody = expectValid<{ data: { results: { status: string }[] } }>(
      BulkActionResponse,
      pause.body,
      'BulkActionResponse',
    );
    // 批量结果是逐项结论（含 errorCode 字段），不是整批单一错误码。
    expect(pauseBody.data.results).toHaveLength(1);
    expect(pauseBody.data.results[0]?.status).toBe('ok');

    // 恢复原状态，保持夹具对后续用例的语义不变。
    const resume = await context.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-actions',
      headers: adminHeaders(session),
      payload: { action: 'resume', items: [{ id: targetId, editRevision: await revisionOf(detailUrl) }] },
    });
    expect(resume.statusCode).toBe(200);
    expectValid(BulkActionResponse, resume.body, 'BulkActionResponse（恢复）');
  });
});
