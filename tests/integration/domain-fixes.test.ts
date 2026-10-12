import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database, SqliteDatabase } from '@githubradar/server';

import { requestBranchRefresh } from '../../apps/server/src/api/admin-support.js';
import { readAvailableBranchesPage } from '../../apps/server/src/domain/branches.js';
import { LabelService } from '../../apps/server/src/domain/labels.js';
import {
  listPublicRepositories,
  purgeOldMetricsByRetention,
  type PublicListOptions,
} from '../../apps/server/src/domain/public.js';
import { isAppError } from '../../apps/server/src/http/errors.js';
import { cacheKeyFor } from '../../apps/server/src/integrations/github/client.js';
import { JobQueue } from '../../apps/server/src/scheduler/queue.js';
import { createTestDatabase, insertRepository, TEST_NOW, type TestDatabase } from './support.js';

/** 回归测试：公开列表口径（聚合状态）、分支选择器任务归属、标签删除版本、趋势保留期。 */

const HOUR = 60 * 60 * 1000;
const NOW = TEST_NOW;
let context: TestDatabase | undefined;
let db: Database;
let client: SqliteDatabase;

beforeEach(() => {
  context = createTestDatabase();
  db = context.db;
  client = context.client;
});

afterEach(() => {
  context?.close();
  context = undefined;
});

// ---------------------------------------------------------------------------- helpers

interface RepoPatch {
  readonly githubId?: number;
  readonly enabled?: number;
  readonly blockedReason?: string | null;
  readonly releaseEnabled?: number;
  readonly includePrereleases?: number;
  readonly intervalHours?: number | null;
}

let githubIdSeq = 1000;

function createVerifiedRepo(name: string, patch: RepoPatch = {}): number {
  githubIdSeq += 1;
  const id = insertRepository(db, name, { githubId: patch.githubId ?? githubIdSeq });
  client
    .prepare(
      `UPDATE repositories
          SET verification_state = 'verified', identity_verified_at = ?, default_branch = 'main',
              enabled = ?, blocked_reason = ?, release_enabled = ?, include_prereleases = ?,
              interval_hours = ?, reserved_until = NULL
        WHERE id = ?`,
    )
    .run(
      TEST_NOW,
      patch.enabled ?? 1,
      patch.blockedReason ?? null,
      patch.releaseEnabled ?? 0,
      patch.includePrereleases ?? 0,
      patch.intervalHours ?? null,
      id,
    );
  return id;
}

interface StreamPatch {
  readonly branchId?: number | null;
  readonly initializedAt?: number | null;
  readonly projectionJson?: string | null;
  readonly detectedChangeAt?: number | null;
  readonly lastSuccessAt?: number | null;
  readonly lastErrorCode?: string | null;
}

function insertStream(repoId: number, kind: string, patch: StreamPatch = {}): number {
  const info = client
    .prepare(
      `INSERT INTO monitor_streams
         (repo_id, kind, branch_id, initialized_at, current_projection_json, detected_change_at,
          last_success_at, last_error_code, phase_seed, config_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      repoId,
      kind,
      patch.branchId ?? null,
      patch.initializedAt ?? null,
      patch.projectionJson ?? null,
      patch.detectedChangeAt ?? null,
      patch.lastSuccessAt ?? null,
      patch.lastErrorCode ?? null,
    );
  return Number(info.lastInsertRowid);
}

function insertBranch(repoId: number, mode: 'default' | 'fixed', name: string | null, enabled = 1): number {
  const info = client
    .prepare(
      `INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name, enabled)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(repoId, mode, mode === 'default' ? null : name, name, enabled);
  return Number(info.lastInsertRowid);
}

function insertMetric(repoId: number, day: string, stars: number, forks: number): void {
  client
    .prepare(
      `INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(repoId, day, stars, forks, NOW, NOW);
}

function listPublic(overrides: Partial<PublicListOptions> = {}) {
  return listPublicRepositories(db, { page: 1, pageSize: 50, ...overrides }, NOW);
}

function viewOf(repoId: number, result: ReturnType<typeof listPublic>) {
  const view = result.items.find((item) => item.id === `repo_${String(repoId)}`);
  expect(view, `repo_${String(repoId)} 应出现在公开列表`).toBeDefined();
  return view as NonNullable<typeof view>;
}

function expectAppErrorCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isAppError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

/**
 * 记录 daily_metrics 查询及其绑定参数个数：趋势只应为当页仓库 ID 加载。
 * 只拦截 `$client.prepare`，其余 Drizzle 调用原样透传。
 */
function trackTrendQueries(real: Database): { db: Database; params: number[] } {
  const params: number[] = [];
  const tracked = new Proxy(real, {
    get(target, prop) {
      if (prop === '$client') {
        const realClient = target.$client;
        return new Proxy(realClient, {
          get(clientTarget, clientProp) {
            if (clientProp === 'prepare') {
              return (sql: string) => {
                if (!/FROM\s+daily_metrics/i.test(sql)) return clientTarget.prepare(sql);
                return {
                  all: (...bound: unknown[]) => {
                    params.push(bound.length);
                    return clientTarget.prepare(sql).all(...bound);
                  },
                  get: (...bound: unknown[]) => clientTarget.prepare(sql).get(...bound),
                  run: (...bound: unknown[]) => clientTarget.prepare(sql).run(...bound),
                };
              };
            }
            const value = Reflect.get(clientTarget, clientProp);
            return typeof value === 'function' ? value.bind(clientTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Database;
  return { db: tracked, params };
}

// ---------------------------------------------------------------------------- 公开列表：lastCheckedAt 与聚合状态

describe('公开列表 lastCheckedAt 语义', () => {
  it('任一启用流从未成功 → lastCheckedAt 为 null；全部成功 → 取最早成功时间', () => {
    // A：metadata 成功，但 Release 流与分支流从未成功；null 不能只由成功流掩盖。
    const partial = createVerifiedRepo('owner/partial', { releaseEnabled: 1 });
    const partialBranch = insertBranch(partial, 'default', 'main');
    insertStream(partial, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    insertStream(partial, 'release', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: null });
    insertStream(partial, 'branch', {
      branchId: partialBranch,
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: null,
    });

    // B：两条流都成功 → 取最小值。
    const healthy = createVerifiedRepo('owner/complete', { releaseEnabled: 1 });
    insertStream(healthy, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    insertStream(healthy, 'release', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 2 * HOUR });

    const result = listPublic();
    const partialView = viewOf(partial, result);
    expect(partialView.lastCheckedAt).toBeNull();
    expect(partialView.status).toBe('partial');

    const healthyView = viewOf(healthy, result);
    expect(healthyView.lastCheckedAt).toBe(
      new Date(NOW - 5 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
    expect(healthyView.status).toBe('healthy');
  });

  it('停用的分支流与关掉的 Release 流不参与 lastCheckedAt 与聚合', () => {
    const repoId = createVerifiedRepo('owner/off-streams', { releaseEnabled: 0 });
    const disabledBranch = insertBranch(repoId, 'fixed', 'old', 0);
    insertStream(repoId, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    insertStream(repoId, 'release', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: null });
    insertStream(repoId, 'branch', {
      branchId: disabledBranch,
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: null,
    });

    const view = viewOf(repoId, listPublic());
    expect(view.lastCheckedAt).toBe(new Date(NOW - 5 * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    expect(view.status).toBe('healthy');
  });
});

describe('聚合状态与托管详情统一（优先级链）', () => {
  it('paused 优先于 blocked_reason；启用中的身份失配显示 error', () => {
    const paused = createVerifiedRepo('owner/paused', {
      enabled: 0,
      blockedReason: 'REPOSITORY_IDENTITY_CHANGED',
    });
    insertStream(paused, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });

    const blocked = createVerifiedRepo('owner/blocked', { blockedReason: 'REPOSITORY_IDENTITY_CHANGED' });
    insertStream(blocked, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });

    const result = listPublic();
    expect(viewOf(paused, result).status).toBe('paused');
    expect(viewOf(blocked, result).status).toBe('error');
  });

  it('全部失败但从未成功 → pending；成功过又失败 → error / partial', () => {
    const neverSucceeded = createVerifiedRepo('owner/never');
    insertStream(neverSucceeded, 'metadata', {
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: null,
      lastErrorCode: 'SERVICE_UNAVAILABLE',
    });

    const failedAfterSuccess = createVerifiedRepo('owner/failed-later', { releaseEnabled: 1 });
    insertStream(failedAfterSuccess, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    insertStream(failedAfterSuccess, 'release', {
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: NOW - 4 * HOUR,
      lastErrorCode: 'GITHUB_ACCESS_DENIED_OR_MISSING',
    });

    const allFailedAgo = createVerifiedRepo('owner/all-failed');
    insertStream(allFailedAgo, 'metadata', {
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: NOW - 5 * HOUR,
      lastErrorCode: 'SERVICE_UNAVAILABLE',
    });

    const result = listPublic();
    expect(viewOf(neverSucceeded, result).status).toBe('pending');
    expect(viewOf(failedAfterSuccess, result).status).toBe('partial');
    // 全部必要流最近一次尝试都失败：error 优先于"曾成功过"，不能假装 healthy。
    expect(viewOf(allFailedAgo, result).status).toBe('error');
  });
});

// ---------------------------------------------------------------------------- 公开列表：趋势只加载本页

describe('趋势只为本页仓库加载', () => {
  it('daily_metrics 查询只绑定当页仓库 ID', () => {
    const a = createVerifiedRepo('owner/aaa');
    const b = createVerifiedRepo('owner/bbb');
    const c = createVerifiedRepo('owner/ccc');
    insertMetric(a, '2023-11-01', 10, 1);
    insertMetric(b, '2023-11-01', 20, 2);
    insertMetric(c, '2023-11-01', 30, 3);

    const tracked = trackTrendQueries(db);
    const pageOne = listPublicRepositories(tracked.db, { page: 1, pageSize: 2 }, NOW);
    // 默认排序（无置顶、无变化时间）按规范名升序：aaa、bbb 在第 1 页。
    expect(pageOne.items.map((item) => item.fullName)).toEqual(['owner/aaa', 'owner/bbb']);
    expect(pageOne.items.map((item) => item.trends[0]?.stars)).toEqual([10, 20]);
    // 2 个仓库 ID + 1 个窗口起点，不能把整库都绑进查询。
    expect(tracked.params).toEqual([3]);

    const pageTwo = listPublicRepositories(tracked.db, { page: 2, pageSize: 2 }, NOW);
    expect(pageTwo.items.map((item) => item.fullName)).toEqual(['owner/ccc']);
    expect(pageTwo.items[0]?.trends).toEqual([{ day: '2023-11-01', stars: 30, forks: 3 }]);
    expect(tracked.params).toEqual([3, 2]);
  });
});

// ---------------------------------------------------------------------------- 空基线展示

describe('空基线分支与 Release 的公开投影', () => {
  it('已初始化但暂无提交的分支仍公开且 committedAt 为 null', () => {
    const repoId = createVerifiedRepo('owner/empty-branch');
    const emptyBranch = insertBranch(repoId, 'default', 'main');
    const withCommit = insertBranch(repoId, 'fixed', 'dev');
    // 未初始化的分支流不进入公开列表，但仍按"启用流从未成功"参与 lastCheckedAt。
    const pendingBranch = insertBranch(repoId, 'fixed', 'next');

    insertStream(repoId, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    // 空基线：初始化过、确定没有提交（投影为 null），成功时间已记录。
    insertStream(repoId, 'branch', {
      branchId: emptyBranch,
      initializedAt: NOW - 6 * HOUR,
      lastSuccessAt: NOW - 5 * HOUR,
    });
    insertStream(repoId, 'branch', {
      branchId: withCommit,
      initializedAt: NOW - 6 * HOUR,
      projectionJson: JSON.stringify({
        sha: 'a'.repeat(40),
        committedAt: '2023-10-01T00:00:00Z',
        htmlUrl: 'https://github.com/owner/empty-branch/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
      lastSuccessAt: NOW - 5 * HOUR,
    });
    insertStream(repoId, 'branch', { branchId: pendingBranch, lastSuccessAt: null });

    const view = viewOf(repoId, listPublic());
    expect(view.branches.map((branch) => branch.name)).toEqual(['dev', 'main']);
    expect(view.branches[0]).toMatchObject({ name: 'dev', committedAt: '2023-10-01T00:00:00Z' });
    expect(view.branches[1]?.committedAt).toBeNull();
    // 空基线分支没有可用的上游链接时回退到规范编码的 tree 链接。
    expect(view.branches[1]?.url).toBe('https://github.com/owner/empty-branch/tree/main');
    // 未初始化流尚未成功：仓库整体显示初始化/部分完成。
    expect(view.lastCheckedAt).toBeNull();
    expect(view.status).toBe('partial');
  });

  it('Release 空基线（列表可访问但没有官方 latest）投影为 latestRelease: null', () => {
    const repoId = createVerifiedRepo('owner/no-release', { releaseEnabled: 1 });
    insertStream(repoId, 'metadata', { initializedAt: NOW - 6 * HOUR, lastSuccessAt: NOW - 5 * HOUR });
    insertStream(repoId, 'release', {
      initializedAt: NOW - 6 * HOUR,
      projectionJson: null,
      lastSuccessAt: NOW - 5 * HOUR,
    });

    const view = viewOf(repoId, listPublic());
    expect(view.latestRelease).toBeNull();
    expect(view.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------- 趋势保留期

describe('趋势保留期下界按北京日归一', () => {
  it('删除早于北京时间窗口起点的桶，保留边界当天', () => {
    const repoId = createVerifiedRepo('owner/retention');
    // UTC 2026-10-10 20:00 = 北京 2026-10-11 04:00；365 天前的北京日是 2025-10-11。
    const now = Date.UTC(2026, 9, 10, 20, 0, 0);
    insertMetric(repoId, '2025-10-09', 1, 1);
    insertMetric(repoId, '2025-10-10', 2, 1);
    insertMetric(repoId, '2025-10-11', 3, 1);
    insertMetric(repoId, '2026-10-10', 4, 1);

    expect(purgeOldMetricsByRetention(db, now)).toBe(2);
    const days = (
      client.prepare('SELECT day FROM daily_metrics ORDER BY day').all() as { day: string }[]
    ).map((row) => row.day);
    expect(days).toEqual(['2025-10-11', '2026-10-10']);
  });
});

// ---------------------------------------------------------------------------- 分支选择器

describe('分支选择器 refreshing', () => {
  it('branch-refresh 任务不挂流，available-branches 仍标记 refreshing', () => {
    const repoId = createVerifiedRepo('owner/refresh');
    const queue = new JobQueue(db, 'test-worker', () => NOW);
    const key = cacheKeyFor({
      path: '/repos/owner/refresh/branches',
      query: { per_page: '100' },
      credentialRevision: 1,
      token: null,
    });
    client
      .prepare(
        `INSERT INTO http_cache (key, repo_id, projection_json, validated_at, projection_version)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(key, repoId, JSON.stringify([{ name: 'main' }, { name: 'dev' }]), NOW - 25 * HOUR);

    expect(readAvailableBranchesPage(db, repoId, 1, 30, NOW).cacheStatus).toBe('stale');

    requestBranchRefresh(db, queue, repoId, NOW);
    const during = readAvailableBranchesPage(db, repoId, 1, 30, NOW);
    expect(during.cacheStatus).toBe('refreshing');
    expect(during.total).toBe(2);

    // 任务结束后恢复为缓存自身状态。
    client.prepare("UPDATE jobs SET state = 'succeeded', finished_at = ? WHERE kind = 'branch_list'").run(NOW);
    expect(readAvailableBranchesPage(db, repoId, 1, 30, NOW).cacheStatus).toBe('stale');

    // 其他仓库的在途刷新不影响本仓库。
    const otherRepo = createVerifiedRepo('owner/other-refresh');
    requestBranchRefresh(db, queue, otherRepo, NOW);
    expect(readAvailableBranchesPage(db, repoId, 1, 30, NOW).cacheStatus).toBe('stale');
    expect(readAvailableBranchesPage(db, otherRepo, 1, 30, NOW).cacheStatus).toBe('refreshing');
  });
});

// ---------------------------------------------------------------------------- 标签删除事务

describe('标签删除在 IMMEDIATE 事务内比较版本', () => {
  it('缺版本 428、冲突 409；删除失败整体回滚且不残留事务', () => {
    const queue = new JobQueue(db, 'test-worker', () => NOW);
    const labels = new LabelService({ db, queue, now: () => NOW });
    const created = labels.create('工具');
    expect(created.labelRevision).toBe(1);

    expectAppErrorCode(() => labels.remove(1), 'REVISION_REQUIRED');
    labels.update(1, 1, { color: '#111111' });
    expectAppErrorCode(() => labels.remove(1, 1), 'REVISION_CONFLICT');
    expect((client.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n).toBe(1);

    // 删除语句被触发器拒绝时，事务不残留（BEGIN IMMEDIATE 失败后必须 ROLLBACK）。
    client.exec("CREATE TRIGGER block_label_delete BEFORE DELETE ON labels BEGIN SELECT RAISE(ABORT, 'BLOCKED'); END;");
    try {
      expect(() => labels.remove(1, 2)).toThrow();
      expect(client.inTransaction).toBe(false);
      expect((client.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n).toBe(1);
    } finally {
      client.exec('DROP TRIGGER block_label_delete');
    }

    labels.remove(1, 2);
    expect((client.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n).toBe(0);
    expectAppErrorCode(() => labels.remove(1, 2), 'NOT_FOUND');
  });
});
