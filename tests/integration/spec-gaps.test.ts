import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  controlDispatchGate,
  CONTROL_OPERATION_WINDOW_MS,
  dueStreams,
  RateBudget,
  type JobKind,
} from '@githubradar/server';

import { JsonTransport, createTestApp, type TestApp } from './app-support.js';
import { createTestDatabase, insertRepository, TEST_NOW } from './support.js';

/** 回归测试：默认分支改名、停用流聚合、重启后凭证新鲜度、预算账户归属、控制操作节流、requestId 响应头。 */

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;

function metadataPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 555,
    full_name: 'owner/renamed-default',
    name: 'renamed-default',
    owner: { login: 'owner', avatar_url: null },
    html_url: 'https://github.com/owner/renamed-default',
    private: false,
    description: 'desc',
    language: 'TypeScript',
    stargazers_count: 10,
    forks_count: 2,
    archived: false,
    default_branch: 'main',
    ...overrides,
  };
}

describe('默认分支改名跟随', () => {
  let app: TestApp;
  let transport: JsonTransport;

  beforeEach(async () => {
    transport = new JsonTransport();
    app = await createTestApp({ withValidCredential: true, transport });
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedRepoWithStreams(): Promise<{ repoId: number; branchId: number; branchStreamId: number }> {
    const repoId = Number(
      app.client
        .prepare(
          `INSERT INTO repositories
             (github_id, canonical_name, html_url, default_branch, verification_state, identity_verified_at, created_at)
           VALUES (555, 'owner/renamed-default', 'https://github.com/owner/renamed-default', 'main', 'verified', ?, ?)`,
        )
        .run(NOW, NOW).lastInsertRowid,
    );
    const branchId = Number(
      app.client
        .prepare("INSERT INTO tracked_branches (repo_id, mode, resolved_name, enabled) VALUES (?, 'default', 'main', 1)")
        .run(repoId).lastInsertRowid,
    );
    app.client
      .prepare(
        "INSERT INTO monitor_streams (repo_id, kind, phase_seed, config_revision, next_due_at) VALUES (?, 'metadata', 5, 1, ?)",
      )
      .run(repoId, NOW + HOUR);
    const branchStreamId = Number(
      app.client
        .prepare(
          `INSERT INTO monitor_streams
             (repo_id, kind, branch_id, initialized_at, current_projection_json, detected_change_at,
              last_success_at, next_due_at, phase_seed, config_revision)
           VALUES (?, 'branch', ?, ?, ?, ?, ?, ?, 9, 1)`,
        )
        .run(
          repoId,
          branchId,
          NOW - HOUR,
          JSON.stringify({ sha: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00Z', htmlUrl: 'https://github.com/owner/renamed-default/tree/main' }),
          NOW - 2 * HOUR,
          NOW - HOUR,
          NOW + HOUR,
        ).lastInsertRowid,
    );
    return { repoId, branchId, branchStreamId };
  }

  async function runMetadataJob(repoId: number): Promise<void> {
    const streamId = (
      app.client
        .prepare("SELECT id FROM monitor_streams WHERE repo_id = ? AND kind = 'metadata'")
        .get(repoId) as { id: number }
    ).id;
    app.scheduler.jobQueue.enqueue({
      kind: 'metadata' as JobKind,
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });
    const job = app.scheduler.jobQueue.claimNext();
    expect(job).not.toBeNull();
    await app.scheduler.executeJob(job as NonNullable<typeof job>);
  }

  it('默认分支改名后跟随新名称、重建该流基线，且不制造代码更新提示', async () => {
    const { repoId, branchId, branchStreamId } = await seedRepoWithStreams();
    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload({ default_branch: 'trunk' }) });

    await runMetadataJob(repoId);

    const branch = app.client
      .prepare('SELECT resolved_name FROM tracked_branches WHERE id = ?')
      .get(branchId) as { resolved_name: string | null };
    expect(branch.resolved_name).toBe('trunk');

    const stream = app.client
      .prepare('SELECT initialized_at, detected_change_at, current_projection_json, config_revision FROM monitor_streams WHERE id = ?')
      .get(branchStreamId) as {
      initialized_at: number | null;
      detected_change_at: number | null;
      current_projection_json: string | null;
      config_revision: number;
    };
    // 换了采集对象就是新基线：不保留旧 SHA，也不产生变化标记。
    expect(stream.initialized_at).toBeNull();
    expect(stream.current_projection_json).toBeNull();
    expect(stream.detected_change_at).toBeNull();
    expect(stream.config_revision).toBe(2);

    const repo = app.client.prepare('SELECT default_branch, collection_revision FROM repositories WHERE id = ?').get(repoId) as {
      default_branch: string;
      collection_revision: number;
    };
    expect(repo.default_branch).toBe('trunk');
    expect(repo.collection_revision).toBe(2);
  });

  it('默认分支未变时不动基线', async () => {
    const { repoId, branchStreamId } = await seedRepoWithStreams();
    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload() });

    await runMetadataJob(repoId);

    const stream = app.client
      .prepare('SELECT initialized_at, detected_change_at FROM monitor_streams WHERE id = ?')
      .get(branchStreamId) as { initialized_at: number | null; detected_change_at: number | null };
    expect(stream.initialized_at).toBe(NOW - HOUR);
    expect(stream.detected_change_at).toBe(NOW - 2 * HOUR);
  });

  it('metadata 成功会记录当日 Star/Fork 趋势', async () => {
    const { repoId } = await seedRepoWithStreams();
    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload({ stargazers_count: 42, forks_count: 7 }) });

    await runMetadataJob(repoId);

    const metric = app.client
      .prepare('SELECT stars, forks FROM daily_metrics WHERE repo_id = ?')
      .get(repoId) as { stars: number; forks: number } | undefined;
    expect(metric).toEqual({ stars: 42, forks: 7 });
  });

  it('改名后与固定分支同名时只采集一条流，改回别的名字后自动恢复', async () => {
    const { repoId, branchId, branchStreamId } = await seedRepoWithStreams();
    // 另加一个固定分支 trunk，正好与改名后的默认分支同名。
    const fixedId = Number(
      app.client
        .prepare("INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name, enabled) VALUES (?, 'fixed', 'trunk', 'trunk', 1)")
        .run(repoId).lastInsertRowid,
    );
    const fixedStreamId = Number(
      app.client
        .prepare("INSERT INTO monitor_streams (repo_id, kind, branch_id, phase_seed, config_revision, next_due_at) VALUES (?, 'branch', ?, 4, 1, ?)")
        .run(repoId, fixedId, NOW + HOUR).lastInsertRowid,
    );

    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload({ default_branch: 'trunk' }) });
    await runMetadataJob(repoId);

    // 默认分支跟随到 trunk；同名的固定分支保留用户配置（enabled 仍为 1），
    // 但不再参与采集——参与与否是运行时派生的，不由系统改写用户开关。
    const rows = app.client
      .prepare('SELECT id, mode, resolved_name, enabled FROM tracked_branches WHERE repo_id = ? ORDER BY id')
      .all(repoId) as { id: number; mode: string; resolved_name: string; enabled: number }[];
    expect(rows.find((row) => row.id === branchId)).toMatchObject({ mode: 'default', resolved_name: 'trunk', enabled: 1 });
    expect(rows.find((row) => row.id === fixedId)).toMatchObject({ mode: 'fixed', enabled: 1 });

    const branchStreamsOf = (now: number): number[] =>
      dueStreams(app.db, now, 200)
        .filter((item) => item.streamId === branchStreamId || item.streamId === fixedStreamId)
        .map((item) => item.streamId)
        .sort((a, b) => a - b);

    expect(branchStreamsOf(NOW + 2 * HOUR)).toEqual([branchStreamId]);

    // 让默认分支流完成一次采集，再看公开列表：同名的固定分支不会重复出现。
    transport.on('/repos/owner/renamed-default/commits?sha=trunk&per_page=1', {
      status: 200,
      body: [
        {
          sha: 'a'.repeat(40),
          commit: { committer: { date: '2026-10-07T08:00:00Z' } },
          html_url: 'https://github.com/owner/renamed-default/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    });
    app.scheduler.jobQueue.enqueue({
      kind: 'branch' as JobKind,
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId: branchStreamId,
      dedupeKey: `stream:${String(branchStreamId)}`,
    });
    await app.scheduler.executeJob(
      app.scheduler.jobQueue.claimNext() as NonNullable<ReturnType<typeof app.scheduler.jobQueue.claimNext>>,
    );

    const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const view = (JSON.parse(list.body) as { data: { id: string; branches: { name: string }[] }[] }).data.find(
      (item) => item.id === `repo_${String(repoId)}`,
    );
    expect(view?.branches.map((branch) => branch.name)).toEqual(['trunk']);

    // 默认分支再改成别的名字：同名的固定分支自动回到采集中，无需重新保存分支设置。
    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload({ default_branch: 'master' }) });
    await runMetadataJob(repoId);

    // 默认分支流刚完成一次采集，下一相位在真实时间的 24 小时后，因此用一个覆盖它的窗口。
    expect(branchStreamsOf(Date.now() + 26 * HOUR)).toEqual([branchStreamId, fixedStreamId].sort((a, b) => a - b));
  });

  it('GitHub ID 变化会暂停该仓库并标记身份失配，且不改写用户的 enabled', async () => {
    const { repoId } = await seedRepoWithStreams();
    transport.on('/repos/owner/renamed-default', { status: 200, body: metadataPayload({ id: 999 }) });

    await runMetadataJob(repoId);

    const repo = app.client
      .prepare('SELECT enabled, blocked_reason FROM repositories WHERE id = ?')
      .get(repoId) as { enabled: number; blocked_reason: string | null };
    expect(repo.blocked_reason).toBe('REPOSITORY_IDENTITY_CHANGED');
    expect(repo.enabled).toBe(1);
  });
});

describe('停用的流不参与公开聚合', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp({ withValidCredential: true });
  });

  afterEach(async () => {
    await app.close();
  });

  it('关闭 Release 后旧发布流的保留数据不再产生更新标记', async () => {
    const repoId = insertRepository(app.db, 'owner/release-off');
    app.client.prepare("UPDATE repositories SET verification_state = 'verified', release_enabled = 0 WHERE id = ?").run(repoId);
    app.client
      .prepare(
        `INSERT INTO monitor_streams
           (repo_id, kind, initialized_at, current_projection_json, detected_change_at, last_success_at, phase_seed, config_revision)
         VALUES (?, 'release', ?, '{}', ?, ?, 3, 1)`,
      )
      .run(repoId, NOW - HOUR, NOW - 1000, NOW - HOUR);

    const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const body = JSON.parse(list.body) as { data: { id: string; hasRecentChange: boolean; latestRelease: unknown }[] };
    const view = body.data.find((item) => item.id === `repo_${String(repoId)}`);
    expect(view?.hasRecentChange).toBe(false);
    expect(view?.latestRelease).toBeNull();
  });

  it('停用某个分支后其流不再影响最近检查时间与更新标记', async () => {
    const repoId = insertRepository(app.db, 'owner/branch-off');
    app.client.prepare("UPDATE repositories SET verification_state = 'verified' WHERE id = ?").run(repoId);
    const activeBranch = Number(
      app.client
        .prepare("INSERT INTO tracked_branches (repo_id, mode, resolved_name, enabled) VALUES (?, 'default', 'main', 1)")
        .run(repoId).lastInsertRowid,
    );
    const disabledBranch = Number(
      app.client
        .prepare("INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name, enabled) VALUES (?, 'fixed', 'old', 'old', 0)")
        .run(repoId).lastInsertRowid,
    );
    const insertStream = app.client.prepare(
      `INSERT INTO monitor_streams
         (repo_id, kind, branch_id, initialized_at, current_projection_json, detected_change_at, last_success_at, phase_seed, config_revision)
       VALUES (?, 'branch', ?, ?, ?, ?, ?, 1, 1)`,
    );
    insertStream.run(
      repoId,
      activeBranch,
      NOW - HOUR,
      JSON.stringify({ sha: 'b'.repeat(40), committedAt: '2026-09-01T00:00:00Z', htmlUrl: 'https://github.com/owner/branch-off/tree/main' }),
      null,
      NOW - HOUR,
    );
    insertStream.run(
      repoId,
      disabledBranch,
      NOW - 10 * HOUR,
      JSON.stringify({ sha: 'c'.repeat(40), committedAt: '2026-10-09T00:00:00Z', htmlUrl: 'https://github.com/owner/branch-off/tree/old' }),
      NOW - 1000,
      NOW - 10 * HOUR,
    );

    const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const body = JSON.parse(list.body) as {
      data: { id: string; hasRecentChange: boolean; branches: { name: string }[]; lastCheckedAt: string | null }[];
    };
    const view = body.data.find((item) => item.id === `repo_${String(repoId)}`);
    expect(view?.hasRecentChange).toBe(false);
    expect(view?.branches.map((branch) => branch.name)).toEqual(['main']);
  });
});

describe('重启后的凭证新鲜度', () => {
  it('已有 valid 凭证在进程重启后先进入 unverified 并关闭门禁', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      expect(app.credentials.isReady()).toBe(true);
      const gateBefore = app.credentials.gateRevision();

      // 模拟重启：新进程不再沿用进程内的旧结论。
      expect(app.credentials.markRestartStale()).toBe(true);
      expect(app.credentials.isReady()).toBe(false);
      expect(app.credentials.status().state).toBe('unverified');
      expect(app.credentials.status().connectivity).toBe('unknown');
      // 门禁版本必须递增：门禁关闭后即便再次 valid，旧响应也不能重新生效。
      expect(app.credentials.gateRevision()).toBeGreaterThan(gateBefore);
      // 立即安排一次在线复核（不要求管理员在线）。
      const verification = app.credentials.beginActiveVerification();
      expect(verification.token).not.toBeNull();

      // 幂等：已经是 unverified 时不再重复递增门禁版本。
      const gateAfter = app.credentials.gateRevision();
      expect(app.credentials.markRestartStale()).toBe(false);
      expect(app.credentials.gateRevision()).toBe(gateAfter);
    } finally {
      await app.close();
    }
  });
});

describe('预算的账户归属与本地计费', () => {
  it('绑定账户后按 account/resource/reset 记录本系统已用计费量', () => {
    const db = createTestDatabase();
    try {
      const budget = new RateBudget(db.db, () => NOW);
      const resetAt = NOW + HOUR;
      budget.bindAccount('acct-1');
      budget.observe({ resource: 'core', limit: 5000, remaining: 4000, resetAt, observedAt: NOW });
      budget.recordRequestStart();

      const row = db.client
        .prepare('SELECT local_usage_json FROM rate_state WHERE account_id = ?')
        .get('acct-1') as { local_usage_json: string | null } | undefined;
      expect(row?.local_usage_json).toBe(JSON.stringify({ billed: 1 }));
      expect(budget.state().accountId).toBe('acct-1');
    } finally {
      db.close();
    }
  });
});

describe('控制操作派发节流', () => {
  it('一分钟内第 3 个控制操作被推迟到最早那次之后', () => {
    const now = NOW;
    expect(controlDispatchGate([], now)).toBe(0);
    expect(controlDispatchGate([now - 30_000], now)).toBe(0);
    // 已有两次派发：下一次要等到第一次满一分钟。
    expect(controlDispatchGate([now - 30_000, now - 20_000], now)).toBe(now - 30_000 + CONTROL_OPERATION_WINDOW_MS);
    // 超出窗口的旧记录不再占用额度。
    expect(controlDispatchGate([now - CONTROL_OPERATION_WINDOW_MS - 1, now - 20_000], now)).toBe(0);
  });
});

describe('requestId 响应头', () => {
  it('管理接口与公开接口都返回 X-Request-Id，且不进公开响应体', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const session = await app.login();
      const admin = await app.app.inject({
        method: 'GET',
        url: '/api/v1/admin/system-status',
        headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787' },
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.headers['x-request-id']).toBeDefined();

      const publicFirst = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
      const publicSecond = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
      expect(publicFirst.headers['x-request-id']).toBeDefined();
      // requestId 每次都不同，但可缓存响应体的 ETag 必须稳定——这正是"requestId 只放响应头"的理由。
      expect(publicFirst.headers['x-request-id']).not.toBe(publicSecond.headers['x-request-id']);
      expect(publicFirst.headers['etag']).toBe(publicSecond.headers['etag']);
      expect(publicFirst.body).not.toContain(String(publicFirst.headers['x-request-id']));
    } finally {
      await app.close();
    }
  });
});

describe('采集路径全流类型', () => {
  let app: TestApp;
  let transport: JsonTransport;

  const REPO = 'owner/multi-stream';

  function rawRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 9001,
      tag_name: 'v3.0.0',
      name: 'v3.0.0',
      published_at: '2026-10-01T00:00:00Z',
      prerelease: false,
      draft: false,
      html_url: `https://github.com/${REPO}/releases/tag/v3.0.0`,
      body: '上游正文不应被保存',
      ...overrides,
    };
  }

  beforeEach(async () => {
    transport = new JsonTransport();
    app = await createTestApp({ withValidCredential: true, transport });
    transport.on(`/repos/${REPO}`, {
      status: 200,
      body: {
        id: 700,
        full_name: REPO,
        name: 'multi-stream',
        owner: { login: 'owner', avatar_url: null },
        html_url: `https://github.com/${REPO}`,
        private: false,
        description: '多流样本',
        language: 'Go',
        stargazers_count: 5,
        forks_count: 1,
        archived: false,
        default_branch: 'main',
      },
    });
    transport.on(`/repos/${REPO}/releases/latest`, { status: 200, body: rawRelease() });
    transport.on(`/repos/${REPO}/releases?per_page=20&page=1`, {
      status: 200,
      body: [
        rawRelease(),
        rawRelease({ id: 9002, tag_name: 'v3.1.0-rc.1', prerelease: true, published_at: '2026-10-05T00:00:00Z' }),
        rawRelease({ id: 9003, tag_name: 'v9.9.9', draft: true, published_at: '2026-10-06T00:00:00Z' }),
      ],
      headers: { etag: 'W/"releases"' },
    });
    transport.on(`/repos/${REPO}/commits?sha=main&per_page=1`, {
      status: 200,
      body: [
        {
          sha: 'f'.repeat(40),
          commit: { committer: { date: '2026-10-07T08:00:00Z' }, message: '不应保存的提交说明' },
          html_url: `https://github.com/${REPO}/commit/${'f'.repeat(40)}`,
        },
      ],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function seedAllStreams(): { repoId: number; streamIds: Record<'metadata' | 'release' | 'prerelease' | 'branch', number> } {
    const repoId = insertRepository(app.db, REPO, { githubId: 700 });
    app.client
      .prepare("UPDATE repositories SET verification_state = 'verified', identity_verified_at = ?, include_prereleases = 1 WHERE id = ?")
      .run(Date.now(), repoId);
    const branchId = Number(
      app.client
        .prepare("INSERT INTO tracked_branches (repo_id, mode, resolved_name, enabled) VALUES (?, 'default', 'main', 1)")
        .run(repoId).lastInsertRowid,
    );
    const insert = app.client.prepare(
      "INSERT INTO monitor_streams (repo_id, kind, branch_id, phase_seed, config_revision, next_due_at) VALUES (?, ?, ?, 1, 1, ?)",
    );
    const now = Date.now();
    return {
      repoId,
      streamIds: {
        metadata: Number(insert.run(repoId, 'metadata', null, now).lastInsertRowid),
        release: Number(insert.run(repoId, 'release', null, now).lastInsertRowid),
        prerelease: Number(insert.run(repoId, 'prerelease', null, now).lastInsertRowid),
        branch: Number(insert.run(repoId, 'branch', branchId, now).lastInsertRowid),
      },
    };
  }

  async function runStreamJob(streamId: number, kind: JobKind): Promise<void> {
    app.scheduler.jobQueue.enqueue({
      kind,
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: Date.now(),
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });
    const job = app.scheduler.jobQueue.claimNext();
    expect(job, kind).not.toBeNull();
    await app.scheduler.executeJob(job as NonNullable<typeof job>);
  }

  it('四条流都能拿到并投影上游结果，且失败分类正确', async () => {
    const { repoId, streamIds } = seedAllStreams();

    await runStreamJob(streamIds.metadata, 'metadata');
    await runStreamJob(streamIds.release, 'release');
    await runStreamJob(streamIds.prerelease, 'prerelease');
    await runStreamJob(streamIds.branch, 'branch');

    const rows = app.client
      .prepare('SELECT kind, initialized_at, current_projection_json, last_error_code FROM monitor_streams WHERE repo_id = ?')
      .all(repoId) as { kind: string; initialized_at: number | null; current_projection_json: string | null; last_error_code: string | null }[];

    for (const row of rows) {
      expect(row.last_error_code, row.kind).toBeNull();
      expect(row.initialized_at, row.kind).not.toBeNull();
      expect(row.current_projection_json, row.kind).not.toBeNull();
    }

    const byKind = new Map(rows.map((row) => [row.kind, row]));
    // 首次建立基线：不产生"更新"标记。
    const repo = app.client.prepare('SELECT github_id, stars, default_branch FROM repositories WHERE id = ?').get(repoId) as {
      github_id: number;
      stars: number;
      default_branch: string;
    };
    expect(repo.github_id).toBe(700);
    expect(repo.stars).toBe(5);

    const release = JSON.parse(byKind.get('release')?.current_projection_json ?? 'null') as { tagName: string };
    expect(release.tagName).toBe('v3.0.0');

    // 预发布窗口：草稿占窗口但不入候选，候选取 prerelease=true 的最新一条。
    const prerelease = JSON.parse(byKind.get('prerelease')?.current_projection_json ?? 'null') as {
      candidate: { tagName: string } | null;
      observedCount: number;
      mayHaveMore: boolean;
    };
    expect(prerelease.candidate?.tagName).toBe('v3.1.0-rc.1');
    expect(prerelease.observedCount).toBe(3);
    expect(prerelease.mayHaveMore).toBe(false);

    // 分支只保存 SHA/时间/链接；提交说明与 Release 正文都不入库。
    const branch = byKind.get('branch')?.current_projection_json ?? '';
    expect(branch).toContain('f'.repeat(40));
    expect(branch).not.toContain('不应保存的提交说明');
    expect(byKind.get('release')?.current_projection_json ?? '').not.toContain('上游正文不应被保存');

    // 落库的投影必须能被严格回读：schema 与生产者少一个字段，公开面就会静默变成空。
    const published = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const publishedBody = JSON.parse(published.body) as {
      data: {
        latestRelease: { version: string } | null;
        recentPrerelease: { candidate: { version: string } | null; coverage: { limit: number } } | null;
        hasRecentChange: boolean;
      }[];
    };
    expect(publishedBody.data[0]?.latestRelease?.version).toBe('v3.0.0');
    expect(publishedBody.data[0]?.recentPrerelease?.candidate?.version).toBe('v3.1.0-rc.1');
    expect(publishedBody.data[0]?.recentPrerelease?.coverage.limit).toBe(20);
    // 首次建立基线不产生更新标记。
    expect(publishedBody.data[0]?.hasRecentChange).toBe(false);
  });

  it('上游返回 404 的分类是"无权限或不存在"，且不覆盖已有基线', async () => {
    const { repoId, streamIds } = seedAllStreams();
    await runStreamJob(streamIds.release, 'release');
    const before = app.client
      .prepare('SELECT current_projection_json FROM monitor_streams WHERE id = ?')
      .get(streamIds.release) as { current_projection_json: string };

    // 让 upstream 之后一直 404。
    transport.on(`/repos/${REPO}/releases/latest`, { status: 404, body: { message: 'Not Found' } });
    await runStreamJob(streamIds.release, 'release');

    const after = app.client
      .prepare('SELECT current_projection_json, last_error_code FROM monitor_streams WHERE id = ?')
      .get(streamIds.release) as { current_projection_json: string | null; last_error_code: string | null };
    // latest 404 交给同轮列表确认，这里只要求不写空基线、不丢已有投影。
    expect(after.current_projection_json).toBe(before.current_projection_json);
    expect(after.last_error_code).toBe('LATEST_NOT_FOUND');
    void repoId;
  });
});

describe('候选凭证激活闭环', () => {
  let app: TestApp;
  let transport: JsonTransport;

  beforeEach(async () => {
    transport = new JsonTransport();
    // 起点是"未配置"，即新部署后的真实状态。
    app = await createTestApp({ transport });
  });

  afterEach(async () => {
    await app.close();
  });

  async function runControlJob(operationId: number): Promise<void> {
    // 生产接线回归：提交候选后控制任务已由路由入队，
    // 这里只领取并执行；手工 enqueue 会掩盖“提交后无人验证”的缺环。
    void operationId;
    const job = app.scheduler.jobQueue.claimNext();
    expect(job).not.toBeNull();
    expect(job?.kind).toBe('token_verify');
    expect(job?.operationId).not.toBeNull();
    await app.scheduler.executeJob(job as NonNullable<typeof job>);
  }

  it('提交候选 PAT 即入队控制任务，不需要调用方手工创建（生产接线）', async () => {
    const session = await app.login();
    const submit = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { token: 'ghp_wired_by_route' },
    });
    expect(submit.statusCode).toBe(202);
    const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);
    const job = app.client
      .prepare("SELECT kind, queue_class, state, operation_id FROM jobs WHERE operation_id = ?")
      .get(operationId) as { kind: string; queue_class: string; state: string; operation_id: number } | undefined;
    expect(job).toBeDefined();
    expect(job?.kind).toBe('token_verify');
    expect(job?.queue_class).toBe('control');
    expect(job?.state).toBe('queued');
  });

  it('提交候选 PAT → 在线验证 → 原子激活，并解析类型/到期/scope', async () => {
    const session = await app.login();
    const submit = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { token: 'github_pat_11AA22BB33CC' },
    });
    expect(submit.statusCode).toBe(202);
    const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);
    expect(Number.isInteger(operationId)).toBe(true);

    transport.on('/user', {
      status: 200,
      body: { id: 4242, login: 'octocat', email: 'must-not-be-stored@example.com' },
      headers: {
        'github-authentication-token-expiration': '2030-01-01 00:00:00 UTC',
        'x-oauth-scopes': 'repo, read:org',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'x-ratelimit-resource': 'core',
      },
    });

    await runControlJob(operationId);

    const status = app.credentials.status();
    expect(status.state).toBe('valid');
    expect(status.effectiveState).toBe('valid');
    expect(status.tokenTypeHint).toBe('fine_grained');
    expect(status.accountId).toBe('4242');
    expect(status.classicScopes).toEqual(['repo', 'read:org']);
    expect(status.expiresSource).toBe('reported');
    expect(status.expiresAt).toBe(Date.UTC(2030, 0, 1, 0, 0, 0));
    expect(app.credentials.isReady()).toBe(true);

    // 候选密文被销毁，且任何地方都不出现明文 Token 或 /user 的私人字段。
    const operations = app.client.prepare('SELECT status, encrypted_candidate FROM pending_operations').all() as {
      status: string;
      encrypted_candidate: Buffer;
    }[];
    expect(operations[0]?.status).toBe('succeeded');
    const plaintext = app.client
      .prepare('SELECT name, ciphertext FROM secrets')
      .all() as { name: string; ciphertext: Buffer }[];
    for (const row of plaintext) {
      expect(row.ciphertext.toString('utf8')).not.toContain('github_pat_');
    }
    const dump = JSON.stringify({
      repos: app.client.prepare('SELECT * FROM repositories').all(),
      credential: app.client.prepare('SELECT * FROM github_credential_status').all(),
    });
    expect(dump).not.toContain('must-not-be-stored');
    expect(dump).not.toContain('github_pat_11AA22BB33CC');
  });

  it('/user 返回 401 时不激活候选，活动配置保持不变', async () => {
    const session = await app.login();
    const submit = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { token: 'ghp_bad_token_value' },
    });
    const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);

    transport.on('/user', { status: 401, body: { message: 'Bad credentials' } });
    await runControlJob(operationId);

    expect(app.credentials.status().state).toBe('missing');
    expect(app.credentials.isReady()).toBe(false);
    const operation = app.credentials.readOperation(operationId);
    expect(operation?.status).toBe('failed');
    expect(operation?.errorCode).toBe('GITHUB_TOKEN_INVALID');
  });

  it('/user 成功但结构缺 id 时按上游契约异常处理，不激活', async () => {
    const session = await app.login();
    const submit = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { token: 'ghp_weird_shape' },
    });
    const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);

    transport.on('/user', { status: 200, body: { login: 'no-id-here' } });
    await runControlJob(operationId);

    expect(app.credentials.status().state).toBe('missing');
    expect(app.credentials.readOperation(operationId)?.errorCode).toBe('UPSTREAM_SCHEMA_CHANGED');
  });

  it('非 ghp_/github_pat_ 前缀的输入在提交阶段被拒绝', async () => {
    const session = await app.login();
    const submit = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
      payload: { token: 'Bearer something-else' },
    });
    expect(submit.statusCode).toBe(400);
    const body = JSON.parse(submit.body) as { error: { code: string; fields?: Record<string, string> } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields?.['token']).toBeDefined();
  });
});

describe('分支选择器缓存闭环', () => {
  let app: TestApp;
  let transport: JsonTransport;

  const REPO = 'owner/branch-cache';

  beforeEach(async () => {
    transport = new JsonTransport();
    app = await createTestApp({ withValidCredential: true, transport });
  });

  afterEach(async () => {
    await app.close();
  });

  it('显式刷新后后台能读到分支列表，且读取不触发新请求', async () => {
    const repoId = insertRepository(app.db, REPO, { githubId: 808 });
    app.client.prepare("UPDATE repositories SET verification_state = 'verified' WHERE id = ?").run(repoId);
    transport.on(`/repos/${REPO}/branches?per_page=100`, {
      status: 200,
      body: [{ name: 'main' }, { name: 'release/1.x' }, { name: 'feature/x' }],
      headers: { etag: 'W/"branches"' },
    });

    const session = await app.login();
    const refresh = await app.app.inject({
      method: 'POST',
      url: `/api/v1/admin/repositories/repo_${String(repoId)}/branch-refreshes`,
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787', 'x-csrf-token': session.csrfToken },
    });
    expect(refresh.statusCode).toBe(202);

    const job = app.scheduler.jobQueue.claimNext();
    expect(job).not.toBeNull();
    await app.scheduler.executeJob(job as NonNullable<typeof job>);
    expect(transport.requests).toHaveLength(1);

    const branches = await app.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repositories/repo_${String(repoId)}/available-branches`,
      headers: { cookie: session.cookie, origin: 'http://127.0.0.1:8787' },
    });
    expect(branches.statusCode).toBe(200);
    const body = JSON.parse(branches.body) as {
      data: { name: string }[];
      meta: { cacheStatus: string; total: number };
    };
    expect(body.data.map((item) => item.name)).toEqual(['main', 'release/1.x', 'feature/x']);
    expect(body.meta.cacheStatus).toBe('fresh');
    // 读取分支缓存绝不产生新的上游请求。
    expect(transport.requests).toHaveLength(1);
  });
});

describe('失败重试阶梯与陈旧状态', () => {
  let app: TestApp;
  let transport: JsonTransport;

  const REPO = 'owner/flaky';

  beforeEach(async () => {
    transport = new JsonTransport();
    app = await createTestApp({ withValidCredential: true, transport });
  });

  afterEach(async () => {
    await app.close();
  });

  function seedMetadataStream(): { repoId: number; streamId: number } {
    const repoId = insertRepository(app.db, REPO, { githubId: 909 });
    app.client
      .prepare("UPDATE repositories SET verification_state = 'verified', identity_verified_at = ? WHERE id = ?")
      .run(Date.now(), repoId);
    const streamId = Number(
      app.client
        .prepare(
          "INSERT INTO monitor_streams (repo_id, kind, phase_seed, config_revision, next_due_at) VALUES (?, 'metadata', 1, 1, ?)",
        )
        .run(repoId, Date.now()).lastInsertRowid,
    );
    return { repoId, streamId };
  }

  async function runJob(streamId: number): Promise<void> {
    app.scheduler.jobQueue.enqueue({
      kind: 'metadata' as JobKind,
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: Date.now(),
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });
    const job = app.scheduler.jobQueue.claimNext();
    expect(job).not.toBeNull();
    await app.scheduler.executeJob(job as NonNullable<typeof job>);
  }

  it('5xx 按 1/5/15 分钟退避重试，超过 3 次后结束本轮', async () => {
    const { streamId } = seedMetadataStream();
    transport.on(`/repos/${REPO}`, { status: 503, body: { message: 'Service Unavailable' } });

    await runJob(streamId);
    const first = app.client
      .prepare('SELECT id, state, attempt, due_at FROM jobs ORDER BY id LIMIT 1')
      .get() as { id: number; state: string; attempt: number; due_at: number };
    expect(first.state).toBe('retry_wait');
    expect(first.attempt).toBe(1);
    // 第一次退避是 1 分钟，而不是立刻重试。
    expect(first.due_at).toBeGreaterThan(Date.now() + 50_000);

    // 把重试时间提前，模拟退避到期后继续同一个任务，直到它结束本轮。
    for (let round = 0; round < 5; round += 1) {
      const current = app.client.prepare('SELECT state FROM jobs WHERE id = ?').get(first.id) as { state: string };
      if (current.state !== 'retry_wait') break;
      app.client
        .prepare('UPDATE jobs SET due_at = ? WHERE id = ? AND state = ?')
        .run(Date.now() - 1, first.id, 'retry_wait');
      await runJob(streamId);
    }
    const last = app.client.prepare('SELECT state, attempt FROM jobs WHERE id = ?').get(first.id) as {
      state: string;
      attempt: number;
    };
    expect(last.state).toBe('failed');
    // 约定：最多 3 次重试（1/5/15 分钟），初始尝试 + 3 次重试，失败时 attempt 为 4。
    expect(last.attempt).toBe(4);

    // 失败不改写基线、也不标记成功。
    const stream = app.client
      .prepare('SELECT last_success_at, last_error_code FROM monitor_streams WHERE id = ?')
      .get(streamId) as { last_success_at: number | null; last_error_code: string | null };
    expect(stream.last_success_at).toBeNull();
    expect(stream.last_error_code).toBe('SERVICE_UNAVAILABLE');
  });

  it('某流超过 2×档位未成功时显示为陈旧，而不是健康', async () => {
    const { repoId, streamId } = seedMetadataStream();
    const now = Date.now();
    // 档位 3 小时 → 阈值 6 小时；上次成功在 8 小时前。
    app.client.prepare("UPDATE repositories SET interval_hours = 3 WHERE id = ?").run(repoId);
    app.client
      .prepare(
        "UPDATE monitor_streams SET initialized_at = ?, last_success_at = ?, current_projection_json = '{}' WHERE id = ?",
      )
      .run(now - 20 * HOUR, now - 8 * HOUR, streamId);

    const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const body = JSON.parse(list.body) as { data: { id: string; status: string }[] };
    expect(body.data.find((item) => item.id === `repo_${String(repoId)}`)?.status).toBe('stale');
  });
});

describe('凭证新鲜度与门禁', () => {
  it('连续 48 小时无可信认证成功即关闭业务门禁', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      expect(app.credentials.isReady()).toBe(true);

      // 每日一次复核的稳态：24 小时内仍视为有效。
      app.client
        .prepare('UPDATE github_credential_status SET last_authenticated_at = ? WHERE id = 1')
        .run(Date.now() - 25 * HOUR);
      expect(app.credentials.status().effectiveState).toBe('valid');

      // 把最近认证时间推到 49 小时前：状态字段仍是 valid，但有效状态必须降级。
      app.client
        .prepare('UPDATE github_credential_status SET last_authenticated_at = ? WHERE id = 1')
        .run(Date.now() - 49 * HOUR);

      expect(app.credentials.status().state).toBe('valid');
      expect(app.credentials.status().effectiveState).toBe('unverified');
      expect(app.credentials.isReady()).toBe(false);

      const session = await app.login();
      const write = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/pins',
        headers: {
          cookie: session.cookie,
          origin: 'http://127.0.0.1:8787',
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        payload: { pinsRevision: 1, ids: [] },
      });
      expect(write.statusCode).toBe(409);
      expect((JSON.parse(write.body) as { error: { code: string } }).error.code).toBe('GITHUB_SETUP_REQUIRED');
    } finally {
      await app.close();
    }
  });

  it('已知到期时间到达即视为 expired，业务写入被门禁挡下', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      app.client
        .prepare('UPDATE github_credential_status SET expires_at = ? WHERE id = 1')
        .run(Date.now() - 1000);
      expect(app.credentials.status().effectiveState).toBe('expired');
      expect(app.credentials.isReady()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('更旧的验证结论不能覆盖更新的结论', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const stale = app.credentials.beginActiveVerification();
      // 更晚的一次验证开始：序号前进，此时旧的快照已经过期。
      app.credentials.beginActiveVerification();

      app.credentials.applyActiveVerification(stale, {
        ok: true,
        accountId: 'should-not-apply',
        status: 200,
        errorCode: null,
        errorMessage: null,
        tokenMetadata: { expiresAt: null, expiresSource: 'unknown', classicScopes: null },
        rateLimit: null,
        connectivity: 'reachable',
      });

      // 旧结论被丢弃：account 没有被那次验证改写。
      expect(app.credentials.status().accountId).not.toBe('should-not-apply');
    } finally {
      await app.close();
    }
  });
});

describe('代理候选应用', () => {
  it('候选网络验证失败时保留原配置，成功后原子替换且代理密码加密存放', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const session = await app.login();
      const submit = await app.app.inject({
        method: 'POST',
        url: '/api/v1/admin/proxy/test',
        headers: {
          cookie: session.cookie,
          origin: 'http://127.0.0.1:8787',
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        payload: { scheme: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p@ss word' },
      });
      expect(submit.statusCode).toBe(202);
      const operationId = Number((JSON.parse(submit.body) as { data: { operationId: string } }).data.operationId);

      // 测试型候选失败不改变活动代理。
      expect(app.credentials.applyProxyResult(operationId, { ok: false, stages: [], detail: '不可达' })).toBe(false);
      expect(app.credentials.readProxy().enabled).toBe(false);
      expect(app.credentials.readOperation(operationId)?.errorCode).toBe('PROXY_UNREACHABLE');

      // 同一候选改为成功后应用：这里直接走 apply 的落库分支。
      const applySubmit = await app.app.inject({
        method: 'PUT',
        url: '/api/v1/admin/proxy',
        headers: {
          cookie: session.cookie,
          origin: 'http://127.0.0.1:8787',
          'content-type': 'application/json',
          'x-csrf-token': session.csrfToken,
        },
        payload: { enabled: true, scheme: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'p@ss word', expectedRevision: 1 },
      });
      expect(applySubmit.statusCode).toBe(202);
      const applyId = Number((JSON.parse(applySubmit.body) as { data: { operationId: string } }).data.operationId);

      expect(app.credentials.applyProxyResult(applyId, { ok: true, stages: [], detail: null })).toBe(true);
      const proxy = app.credentials.readProxy();
      expect(proxy).toMatchObject({ configured: true, enabled: true, scheme: 'socks5', host: '127.0.0.1', port: 1080 });
      expect(proxy.revision).toBe(2);

      const stored = app.client.prepare("SELECT ciphertext FROM secrets WHERE name = 'proxy_password'").get() as
        | { ciphertext: Buffer }
        | undefined;
      expect(stored).toBeDefined();
      expect(stored?.ciphertext.toString('utf8')).not.toContain('p@ss word');

      // 显式关闭代理会递增 revision 并回到直连。
      app.credentials.disableProxy(2);
      expect(app.credentials.readProxy().enabled).toBe(false);
      expect(app.credentials.activeProxy()).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('导入 → 验证 → 看板的完整闭环', () => {
  let app: TestApp;
  let transport: JsonTransport;

  const INPUT = 'owner/New-Repo';

  beforeEach(async () => {
    transport = new JsonTransport();
    app = await createTestApp({ transport });
  });

  afterEach(async () => {
    await app.close();
  });

  it('未验证时不能导入（门禁），验证后逐项结果与公开投影都正确', async () => {
    const session = await app.login();

    // 门禁未就绪（没有 PAT）时导入必须被服务端拒绝。
    const blocked = await app.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-imports',
      headers: {
        cookie: session.cookie,
        origin: 'http://127.0.0.1:8787',
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      payload: { input: INPUT },
    });
    expect(blocked.statusCode).toBe(409);
    expect((JSON.parse(blocked.body) as { error: { code: string } }).error.code).toBe('GITHUB_SETUP_REQUIRED');
    expect(app.client.prepare('SELECT COUNT(*) AS count FROM repositories').get()).toEqual({ count: 0 });

    // 完成初始化后重来一次。
    const ready = await createTestApp({ transport });
    transport.on('/user', { status: 200, body: { id: 1, login: 'octocat' } });
    const readySession = await ready.login();
    const submitted = await ready.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/github-token',
      headers: {
        cookie: readySession.cookie,
        origin: 'http://127.0.0.1:8787',
        'content-type': 'application/json',
        'x-csrf-token': readySession.csrfToken,
      },
      payload: { token: 'ghp_activation_token' },
    });
    const operationId = Number((JSON.parse(submitted.body) as { data: { operationId: string } }).data.operationId);
    void operationId;
    // 提交路由已入队控制任务（生产接线），直接领取执行即可。
    await ready.scheduler.executeJob(
      ready.scheduler.jobQueue.claimNext() as NonNullable<ReturnType<typeof ready.scheduler.jobQueue.claimNext>>,
    );
    expect(ready.credentials.isReady()).toBe(true);

    transport.on('/repos/owner/New-Repo', {
      status: 200,
      body: {
        id: 1234,
        full_name: 'owner/New-Repo',
        name: 'New-Repo',
        owner: { login: 'owner', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
        html_url: 'https://github.com/owner/New-Repo',
        private: false,
        description: '刚导入的仓库',
        language: 'Rust',
        stargazers_count: 3,
        forks_count: 1,
        archived: false,
        default_branch: 'main',
      },
    });
    transport.on('/repos/owner/New-Repo/releases/latest', { status: 404, body: { message: 'Not Found' } });
    transport.on('/repos/owner/New-Repo/releases?per_page=20&page=1', { status: 200, body: [] });
    transport.on('/repos/owner/New-Repo/commits?sha=main&per_page=1', {
      status: 200,
      body: [
        {
          sha: 'e'.repeat(40),
          commit: { committer: { date: '2026-10-07T00:00:00Z' } },
          html_url: `https://github.com/owner/New-Repo/commit/${'e'.repeat(40)}`,
        },
      ],
    });

    const imported = await ready.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-imports',
      headers: {
        cookie: readySession.cookie,
        origin: 'http://127.0.0.1:8787',
        'content-type': 'application/json',
        'x-csrf-token': readySession.csrfToken,
      },
      payload: { input: INPUT },
    });
    expect(imported.statusCode).toBe(202);
    const groupId = (JSON.parse(imported.body) as { data: { groupId: string } }).data.groupId;

    // 占位行已占用名额但不公开。
    const pending = await ready.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repository-imports/${groupId}`,
      headers: { cookie: readySession.cookie, origin: 'http://127.0.0.1:8787' },
    });
    const pendingBody = JSON.parse(pending.body) as { data: { state: string; items: { status: string }[] } };
    expect(pendingBody.data.items[0]?.status).toBe('queued');

    // 驱动该仓库的初始化任务。
    const job = ready.scheduler.jobQueue.claimNext();
    expect(job).not.toBeNull();
    await ready.scheduler.executeJob(job as NonNullable<typeof job>);

    const done = await ready.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repository-imports/${groupId}`,
      headers: { cookie: readySession.cookie, origin: 'http://127.0.0.1:8787' },
    });
    const doneBody = JSON.parse(done.body) as {
      data: { state: string; items: { status: string; repoId: string | null }[] };
    };
    expect(doneBody.data.items[0]?.status).toBe('succeeded');
    expect(doneBody.data.items[0]?.repoId).toMatch(/^repo_\d+$/);

    // 公开看板出现该仓库，且不再有占位痕迹。
    const list = await ready.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
    const listBody = JSON.parse(list.body) as { data: { fullName: string; status: string; latestRelease: unknown }[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.fullName).toBe('owner/New-Repo');
    // 首次检测建立基线：没有变化标记，也没有正式版。
    expect(listBody.data[0]?.latestRelease).toBeNull();

    // 再次导入同一仓库（大小写不同）应识别为已存在，不占名额、不发请求。
    const before = transport.requests.length;
    const again = await ready.app.inject({
      method: 'POST',
      url: '/api/v1/admin/repository-imports',
      headers: {
        cookie: readySession.cookie,
        origin: 'http://127.0.0.1:8787',
        'content-type': 'application/json',
        'x-csrf-token': readySession.csrfToken,
      },
      payload: { input: 'owner/new-repo' },
    });
    const againId = (JSON.parse(again.body) as { data: { groupId: string } }).data.groupId;
    const againProgress = await ready.app.inject({
      method: 'GET',
      url: `/api/v1/admin/repository-imports/${againId}`,
      headers: { cookie: readySession.cookie, origin: 'http://127.0.0.1:8787' },
    });
    const againBody = JSON.parse(againProgress.body) as { data: { items: { status: string }[] } };
    expect(againBody.data.items[0]?.status).toBe('exists');
    expect(transport.requests.length).toBe(before);
    expect((ready.client.prepare('SELECT COUNT(*) AS count FROM repositories').get() as { count: number }).count).toBe(1);

    await ready.close();
  });
});

describe('公开发现接口', () => {
  it('默认启用时可读，返回来源归属与来源快照值', async () => {
    const app = await createTestApp();
    try {
      app.client
        .prepare(
          `INSERT INTO discovery_runs
             (source_commit, source_manifest_json, parser_version, state, started_at, completed_at, source_updated_at, rows_total, rows_valid)
           VALUES ('abc123', '{}', 1, 'staging', ?, ?, ?, 1, 1)`,
        )
        .run(Date.now(), Date.now(), Date.now() - 3600_000);
      app.client
        .prepare(
          `INSERT INTO discovery_items
             (run_id, github_id, canonical_name, html_url, description, language, stars, forks, domains_json, topics_json, first_seen, source_file)
           VALUES (1, 4242, 'acme/tool', 'https://github.com/acme/tool', '一个工具', 'Python', 1200, 10, '["AI"]', '["llm"]', '2026-01-01', 'AI_Agent.csv')`,
        )
        .run();
      app.client.prepare("UPDATE discovery_runs SET state = 'active' WHERE id = 1").run();
      app.client.prepare('UPDATE settings SET active_discovery_run_id = 1 WHERE id = 1').run();

      const response = await app.app.inject({ method: 'GET', url: '/api/v1/public/discovery' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        data: {
          fullName: string;
          sourceStars: number | null;
          statsSampledAt: string | null;
          monitored: boolean;
        }[];
        meta: { total: number; source: { commit: string; note: string; stale: boolean } };
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.fullName).toBe('acme/tool');
      // 来源计数是快照值，采样时间未知时保持 null，不能伪造成实时 Star。
      expect(body.data[0]?.sourceStars).toBe(1200);
      expect(body.data[0]?.statsSampledAt).toBeNull();
      expect(body.meta.source.commit).toBe('abc123');
      expect(body.meta.source.note).toContain('来源记录值');

      // 已加入监控的候选会被标记（不自动加入，仅提示）。
      const repoId = insertRepository(app.db, 'acme/tool', { githubId: 4242 });
      void repoId;
      const second = await app.app.inject({ method: 'GET', url: '/api/v1/public/discovery' });
      expect((JSON.parse(second.body) as { data: { monitored: boolean }[] }).data[0]?.monitored).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('趋势窗口随列表请求', () => {
  it('days 决定返回的趋势点窗口，且不发生每卡片请求', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      const now = Date.now();
      const repoId = insertRepository(app.db, 'owner/trend-window');
      app.client.prepare("UPDATE repositories SET verification_state = 'verified' WHERE id = ?").run(repoId);
      const insertMetric = app.client.prepare(
        'INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      // 造 100 天历史：7 天窗口应只返回最近 7 个点。
      for (let offset = 0; offset < 100; offset += 1) {
        const sampledAt = now - offset * 24 * HOUR;
        const day = new Date(sampledAt + 8 * HOUR).toISOString().slice(0, 10);
        insertMetric.run(repoId, day, 1000 - offset, 10, sampledAt, sampledAt);
      }

      const short = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories?days=7' });
      const long = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories?days=365' });
      const shortPoints = (JSON.parse(short.body) as { data: { trends: unknown[] }[] }).data[0]?.trends.length ?? 0;
      const longPoints = (JSON.parse(long.body) as { data: { trends: unknown[] }[] }).data[0]?.trends.length ?? 0;

      expect(shortPoints).toBeGreaterThan(0);
      expect(shortPoints).toBeLessThanOrEqual(8);
      expect(longPoints).toBeGreaterThan(shortPoints);
      expect(longPoints).toBeLessThanOrEqual(100);

      // 不传 days 时按默认 30 天窗口。
      const fallback = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
      const fallbackPoints = (JSON.parse(fallback.body) as { data: { trends: unknown[] }[] }).data[0]?.trends.length ?? 0;
      expect(fallbackPoints).toBeGreaterThan(shortPoints);
      expect(fallbackPoints).toBeLessThan(longPoints);

      // 非法区间被拒绝，而不是静默按默认值处理。
      const invalid = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories?days=42' });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('聚合状态的不变量', () => {
  it('停用的流不参与聚合状态判定', async () => {
    const app = await createTestApp({ withValidCredential: true });
    try {
      // 聚合状态与"现在"比较，因此这里必须用真实时间戳而不是固定夹具时间。
      const now = Date.now();
      const repoId = insertRepository(app.db, 'owner/state');
      app.client
        .prepare("UPDATE repositories SET verification_state = 'verified', release_enabled = 0 WHERE id = ?")
        .run(repoId);
      // metadata 流正常成功，被停用的 release 流保留错误码不应把仓库拉成 error/partial。
      app.client
        .prepare(
          `INSERT INTO monitor_streams
             (repo_id, kind, initialized_at, current_projection_json, last_success_at, last_error_code, last_error_at, phase_seed, config_revision)
           VALUES (?, 'metadata', ?, '{}', ?, NULL, NULL, 1, 1)`,
        )
        .run(repoId, now - HOUR, now - HOUR);
      app.client
        .prepare(
          `INSERT INTO monitor_streams
             (repo_id, kind, initialized_at, last_success_at, last_error_code, last_error_at, phase_seed, config_revision)
           VALUES (?, 'release', ?, NULL, 'GITHUB_ACCESS_DENIED_OR_MISSING', ?, 2, 1)`,
        )
        .run(repoId, now - HOUR, now - HOUR);

      const list = await app.app.inject({ method: 'GET', url: '/api/v1/public/repositories' });
      const body = JSON.parse(list.body) as { data: { id: string; status: string }[] };
      expect(body.data.find((item) => item.id === `repo_${String(repoId)}`)?.status).toBe('healthy');
    } finally {
      await app.close();
    }
  });
});
