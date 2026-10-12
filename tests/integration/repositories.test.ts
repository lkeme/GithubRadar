import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REPOSITORY_LIMIT, MAX_BATCH_IDS, MAX_BRANCHES_PER_REPO, MAX_LABELS_PER_REPO } from '@githubradar/contracts';
import type { Database, SqliteDatabase } from '@githubradar/server';

import { cacheKeyFor } from '../../apps/server/src/integrations/github/client.js';
import { LabelService } from '../../apps/server/src/domain/labels.js';
import { RepositoryService } from '../../apps/server/src/domain/repositories.js';
import { isAppError } from '../../apps/server/src/http/errors.js';
import { JobQueue } from '../../apps/server/src/scheduler/queue.js';
import { createTestDatabase, insertRepository, TEST_NOW, type TestDatabase } from './support.js';

/**
 * 仓库管理领域模块。
 * 使用真实临时 SQLite：容量触发器、部分唯一索引与外键级联都要真实生效。
 */

let context: TestDatabase | undefined;
let db: Database;
let client: SqliteDatabase;
let queue: JobQueue;
let service: RepositoryService;
let labels: LabelService;
let clock: number;
let githubIdSeq: number;

beforeEach(() => {
  context = createTestDatabase();
  db = context.db;
  client = context.client;
  clock = TEST_NOW;
  githubIdSeq = 1000;
  queue = new JobQueue(db, 'test-worker', () => clock);
  service = new RepositoryService({ db, queue, now: () => clock });
  labels = new LabelService({ db, queue, now: () => clock });
});

afterEach(() => {
  context?.close();
  context = undefined;
});

// ---------------------------------------------------------------------------- helpers

function count(table: string): number {
  return (client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

interface RepoDbRow {
  id: number;
  canonical_name: string;
  note: string | null;
  enabled: number;
  edit_revision: number;
  display_revision: number;
  collection_revision: number;
  identity_revision: number;
  blocked_reason: string | null;
  verification_state: string;
  reserved_until: number | null;
  interval_hours: number | null;
  release_enabled: number;
  include_prereleases: number;
  pin_order: number | null;
}

interface StreamDbRow {
  id: number;
  repo_id: number;
  kind: string;
  branch_id: number | null;
  initialized_at: number | null;
  detected_change_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  next_due_at: number | null;
  config_revision: number;
}

interface JobDbRow {
  id: number;
  stream_id: number | null;
  kind: string;
  queue_class: string;
  origin: string;
  state: string;
  dedupe_key: string | null;
  pause_override: number;
  accepted_auth_version: number | null;
  due_at: number | null;
  error_code: string | null;
}

function repoRow(id: number): RepoDbRow {
  return client.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as RepoDbRow;
}

function streamsOf(repoId: number): StreamDbRow[] {
  return client.prepare('SELECT * FROM monitor_streams WHERE repo_id = ? ORDER BY id').all(repoId) as StreamDbRow[];
}

function streamOf(repoId: number, kind: string): StreamDbRow | undefined {
  return streamsOf(repoId).find((stream) => stream.kind === kind);
}

function jobsOf(repoId: number): JobDbRow[] {
  return client
    .prepare(
      `SELECT j.* FROM jobs j JOIN monitor_streams s ON s.id = j.stream_id WHERE s.repo_id = ? ORDER BY j.id`,
    )
    .all(repoId) as JobDbRow[];
}

function createVerifiedRepo(name: string, overrides: { defaultBranch?: string | null } = {}): number {
  githubIdSeq += 1;
  const id = insertRepository(db, name, { githubId: githubIdSeq });
  client.prepare(
    `UPDATE repositories SET verification_state = 'verified', identity_verified_at = ?, default_branch = ?, reserved_until = NULL WHERE id = ?`,
  ).run(TEST_NOW, overrides.defaultBranch === undefined ? 'main' : overrides.defaultBranch, id);
  return id;
}

function insertStream(
  repoId: number,
  kind: string,
  options: {
    branchId?: number | null;
    initializedAt?: number | null;
    detectedChangeAt?: number | null;
    lastSuccessAt?: number | null;
    lastErrorCode?: string | null;
    nextDueAt?: number | null;
    phaseSeed?: number;
    configRevision?: number;
  } = {},
): number {
  const info = client
    .prepare(
      `INSERT INTO monitor_streams
         (repo_id, kind, branch_id, initialized_at, detected_change_at, last_success_at, last_error_code, next_due_at, phase_seed, config_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repoId,
      kind,
      options.branchId ?? null,
      options.initializedAt ?? null,
      options.detectedChangeAt ?? null,
      options.lastSuccessAt ?? null,
      options.lastErrorCode ?? null,
      options.nextDueAt ?? null,
      options.phaseSeed ?? 7,
      options.configRevision ?? 1,
    );
  return Number(info.lastInsertRowid);
}

function insertBranch(repoId: number, mode: 'default' | 'fixed', name: string | null): number {
  const info = client
    .prepare('INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name) VALUES (?, ?, ?, ?)')
    .run(repoId, mode, name, mode === 'fixed' ? name : null);
  return Number(info.lastInsertRowid);
}

function insertAdmin(authVersion = 1): void {
  client.prepare(
    'INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at) VALUES (1, ?, ?, ?, ?)',
  ).run('admin', 'hash', authVersion, TEST_NOW);
}

function insertLabel(name: string): number {
  const info = client.prepare('INSERT INTO labels (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(isAppError(error), `期望 AppError，实际 ${String(error)}`).toBe(true);
    expect(isAppError(error) ? error.code : null).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有异常`);
}

// ---------------------------------------------------------------------------- 容量与占位

describe('导入批次与 999 上限', () => {
  it('事务内预留名额：998 条后一次导入 2 行，第 2 行数量超限，总数停在 999', () => {
    const seed = client.transaction(() => {
      for (let index = 0; index < REPOSITORY_LIMIT - 1; index += 1) {
        insertRepository(db, `owner/bulk-${index}`);
      }
    });
    seed();
    expect(count('repositories')).toBe(998);

    const first = service.importBatch('Owner/one\nowner/two', null);
    expect(first.accepted).toBe(1);
    expect(first.rejected).toBe(1);
    expect(count('repositories')).toBe(999);

    const progress = service.importProgress(first.groupId);
    expect(progress?.items.map((item) => item.status)).toEqual(['queued', 'limit_reached']);
    expect(progress?.items[1]?.errorCode).toBe('REPOSITORY_LIMIT_REACHED');

    const second = service.importBatch('owner/three', null);
    expect(second.accepted).toBe(0);
    expect(second.rejected).toBe(1);
    expect(count('repositories')).toBe(999);
  });

  it('占位行占用名额且带 24 小时预留、小写规范键与导入任务', () => {
    const result = service.importBatch('  Owner/Repo  ', 3);
    expect(result).toEqual({ groupId: expect.any(Number), accepted: 1, rejected: 0, overflow: 0 });

    const row = client.prepare('SELECT * FROM repositories').get() as RepoDbRow & { github_id: number | null; html_url: string };
    expect(row.canonical_name).toBe('owner/repo');
    expect(row.github_id).toBeNull();
    expect(row.verification_state).toBe('pending');
    expect(row.reserved_until).toBe(TEST_NOW + 24 * 60 * 60 * 1000);
    expect(row.html_url).toBe('https://github.com/Owner/Repo');

    const jobs = client.prepare('SELECT * FROM jobs').all() as JobDbRow[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'metadata',
      queue_class: 'initialization',
      origin: 'import',
      state: 'queued',
      accepted_auth_version: 3,
      dedupe_key: `stream:${streamOf(row.id, 'metadata')?.id}`,
    });
    const item = client.prepare('SELECT * FROM job_group_items').get() as {
      input_index: number;
      normalized_input: string;
      status: string;
      repo_id: number;
      job_id: number;
    };
    expect(item).toMatchObject({
      input_index: 0,
      normalized_input: 'Owner/Repo',
      status: 'queued',
      repo_id: row.id,
      job_id: jobs[0]?.id,
    });
  });

  it('批内与已有重复不重复占用名额，逐项报“已存在”', () => {
    const result = service.importBatch('dup/repo\nDUP/Repo\ndup/repo\nowner/other', null);
    expect(result.accepted).toBe(2);
    expect(count('repositories')).toBe(2);

    const progress = service.importProgress(result.groupId);
    expect(progress?.items.map((item) => item.status)).toEqual(['queued', 'exists', 'exists', 'queued']);
    const firstRepoId = progress?.items[0]?.repoId;
    expect(progress?.items[1]?.repoId).toBe(firstRepoId);
    expect(progress?.items[1]?.errorCode).toBe('REPOSITORY_ALREADY_EXISTS');

    const again = service.importBatch('dup/repo', null);
    expect(again.accepted).toBe(0);
    expect(count('repositories')).toBe(2);
    const againProgress = service.importProgress(again.groupId);
    expect(againProgress?.items[0]?.status).toBe('exists');
    expect(againProgress?.items[0]?.repoId).not.toBeNull();
  });

  it('格式错误逐行返回错误码，空行被跳过', () => {
    const result = service.importBatch('not a repo\n\nowner/ok\nhttps://gitlab.com/a/b', null);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(2);

    const progress = service.importProgress(result.groupId);
    expect(progress?.total).toBe(3);
    expect(progress?.items.map((item) => [item.index, item.status, item.errorCode])).toEqual([
      [0, 'invalid', 'INVALID_FORMAT'],
      [1, 'queued', null],
      [2, 'invalid', 'BAD_HOST'],
    ]);
  });

  it('超过 999 行的部分计入 overflow 并逐项标记', () => {
    const lines = Array.from({ length: 1001 }, (_, index) => `owner/x-${index}`);
    const result = service.importBatch(lines.join('\n'), null);
    expect(result.accepted).toBe(999);
    expect(result.overflow).toBe(2);
    expect(count('repositories')).toBe(999);

    const progress = service.importProgress(result.groupId);
    expect(progress?.total).toBe(1001);
    expect(progress?.items[1000]).toMatchObject({ status: 'limit_reached', errorCode: 'REPOSITORY_LIMIT_REACHED' });
  });

  it('releaseExpiredReservations 释放超时占位：删除占位、逐项 IMPORT_EXPIRED、取消未开始任务', () => {
    const first = service.importBatch('gone/repo', null);
    const placeholderId = client.prepare("SELECT id FROM repositories WHERE canonical_name = 'gone/repo'").get() as { id: number };
    const fresh = service.importBatch('fresh/repo', null);

    // 未超时的占位不受影响。
    expect(service.releaseExpiredReservations()).toBe(0);

    client.prepare('UPDATE repositories SET reserved_until = ? WHERE id = ?').run(TEST_NOW - 1, placeholderId.id);
    expect(service.releaseExpiredReservations()).toBe(1);

    expect(count('repositories')).toBe(1);
    const items = client
      .prepare('SELECT * FROM job_group_items WHERE group_id = ?')
      .all(first.groupId) as { status: string; error_code: string | null; repo_id: number | null }[];
    expect(items[0]).toMatchObject({ status: 'failed', error_code: 'IMPORT_EXPIRED', repo_id: null });

    const jobs = client.prepare('SELECT * FROM jobs').all() as JobDbRow[];
    const cancelled = jobs.filter((job) => job.state === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(jobs.filter((job) => job.state === 'queued')).toHaveLength(1);

    const progress = service.importProgress(first.groupId);
    expect(progress?.state).toBe('finished');
    expect(progress?.items[0]).toMatchObject({ status: 'expired', errorCode: 'IMPORT_EXPIRED', repoId: null });
    expect(service.importProgress(fresh.groupId)?.items[0]?.status).toBe('queued');
    expect(service.importProgress(9999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------- PATCH 与版本

describe('单仓 PATCH', () => {
  it('缺 editRevision 抛 428，错误版本抛 409，未知仓库抛 404', () => {
    const repoId = createVerifiedRepo('owner/patch');
    expectAppError(() => service.patch(repoId, { note: 'x' }), 'REVISION_REQUIRED');
    expectAppError(() => service.patch(repoId, { editRevision: 99, note: 'x' }), 'REVISION_CONFLICT');
    expectAppError(() => service.patch(12345, { editRevision: 1, note: 'x' }), 'NOT_FOUND');
  });

  it('改备注/别名递增 edit_revision 与 display_revision，不清空采集基线', () => {
    const repoId = createVerifiedRepo('owner/baseline');
    const streamId = insertStream(repoId, 'metadata', {
      initializedAt: TEST_NOW - 5000,
      detectedChangeAt: TEST_NOW - 4000,
      lastSuccessAt: TEST_NOW - 3000,
      nextDueAt: TEST_NOW + 1000,
    });

    service.patch(repoId, { editRevision: 1, note: '我的备注', displayName: '别名' });

    const repo = repoRow(repoId);
    expect(repo.note).toBe('我的备注');
    expect(repo.edit_revision).toBe(2);
    expect(repo.display_revision).toBe(2);
    expect(repo.collection_revision).toBe(1);
    expect(repo.identity_revision).toBe(1);

    const stream = client.prepare('SELECT * FROM monitor_streams WHERE id = ?').get(streamId) as StreamDbRow;
    expect(stream.initialized_at).toBe(TEST_NOW - 5000);
    expect(stream.detected_change_at).toBe(TEST_NOW - 4000);
    expect(stream.last_success_at).toBe(TEST_NOW - 3000);
    expect(stream.next_due_at).toBe(TEST_NOW + 1000);
  });

  it('缩短档位时已过期的流只安排一次错峰追赶；延长档位从最近完成轮次计算下一相位', () => {
    const repoId = createVerifiedRepo('owner/interval');
    client.prepare('UPDATE repositories SET interval_hours = 24 WHERE id = ?').run(repoId);
    const streamId = insertStream(repoId, 'metadata', {
      initializedAt: TEST_NOW - 1000,
      lastSuccessAt: TEST_NOW - 1000,
      nextDueAt: TEST_NOW - 500,
      phaseSeed: 42,
    });

    service.patch(repoId, { editRevision: 1, intervalHours: 3 });
    const shortened = client.prepare('SELECT * FROM monitor_streams WHERE id = ?').get(streamId) as StreamDbRow;
    expect(shortened.next_due_at).toBeGreaterThan(clock);
    expect(shortened.next_due_at).toBeLessThanOrEqual(clock + 900_000);
    expect(repoRow(repoId).interval_hours).toBe(3);

    // 延长：从最近成功时间按新周期推进，落在当前时间之后。
    client.prepare('UPDATE monitor_streams SET last_success_at = ?, next_due_at = ? WHERE id = ?').run(TEST_NOW - 60_000, TEST_NOW - 30_000, streamId);
    service.patch(repoId, { editRevision: 2, intervalHours: 24 });
    const extended = client.prepare('SELECT * FROM monitor_streams WHERE id = ?').get(streamId) as StreamDbRow;
    expect(extended.next_due_at).toBeGreaterThan(clock);
    expect((extended.next_due_at ?? 0) - (TEST_NOW - 60_000)).toBeLessThanOrEqual(24 * 3600_000 * 2);
  });

  it('releaseEnabled true→false 停用两条发布流；false→true 按新基线重建', () => {
    const repoId = createVerifiedRepo('owner/release');
    insertStream(repoId, 'metadata', { initializedAt: TEST_NOW - 100 });
    insertStream(repoId, 'release', { initializedAt: TEST_NOW - 100, detectedChangeAt: TEST_NOW - 50 });

    service.patch(repoId, { editRevision: 1, releaseEnabled: false, includePrereleases: true });
    expect(streamOf(repoId, 'metadata')).toBeDefined();
    expect(streamOf(repoId, 'release')).toBeUndefined();
    expect(streamOf(repoId, 'prerelease')).toBeUndefined();

    service.patch(repoId, { editRevision: 2, releaseEnabled: true });
    const release = streamOf(repoId, 'release');
    const prerelease = streamOf(repoId, 'prerelease');
    expect(release).toBeDefined();
    expect(release?.initialized_at).toBeNull();
    expect(release?.detected_change_at).toBeNull();
    expect(prerelease).toBeDefined();
    expect(prerelease?.initialized_at).toBeNull();
    // 重建的流各自安排了初始化任务。
    const kinds = jobsOf(repoId).map((job) => job.kind).sort();
    expect(kinds).toContain('release');
    expect(kinds).toContain('prerelease');
  });

  it('includePrereleases true→false 只清除预发布流，正式流不受影响', () => {
    const repoId = createVerifiedRepo('owner/prerelease');
    client.prepare('UPDATE repositories SET include_prereleases = 1 WHERE id = ?').run(repoId);
    insertStream(repoId, 'metadata', { initializedAt: TEST_NOW - 100 });
    const releaseId = insertStream(repoId, 'release', { initializedAt: TEST_NOW - 100, lastSuccessAt: TEST_NOW - 100 });
    insertStream(repoId, 'prerelease', { initializedAt: TEST_NOW - 100, detectedChangeAt: TEST_NOW - 20 });

    service.patch(repoId, { editRevision: 1, includePrereleases: false });
    expect(streamOf(repoId, 'prerelease')).toBeUndefined();
    const release = client.prepare('SELECT * FROM monitor_streams WHERE id = ?').get(releaseId) as StreamDbRow;
    expect(release.initialized_at).toBe(TEST_NOW - 100);
    expect(release.last_success_at).toBe(TEST_NOW - 100);

    service.patch(repoId, { editRevision: 2, includePrereleases: true });
    expect(streamOf(repoId, 'prerelease')?.initialized_at).toBeNull();
    expect(client.prepare('SELECT * FROM monitor_streams WHERE id = ?').get(releaseId)).toMatchObject({
      initialized_at: TEST_NOW - 100,
    });
  });

  it('暂停不清基线、取消未开始的周期任务；恢复保留基线并错峰入队', () => {
    const repoId = createVerifiedRepo('owner/pause');
    const streamId = insertStream(repoId, 'metadata', {
      initializedAt: TEST_NOW - 100,
      detectedChangeAt: TEST_NOW - 80,
      lastSuccessAt: TEST_NOW - 60,
      nextDueAt: TEST_NOW + 1000,
      configRevision: 3,
    });
    const periodic = queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: TEST_NOW,
      streamId,
      dedupeKey: `stream:${streamId}`,
    });
    const manual = queue.enqueue({
      kind: 'release',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: TEST_NOW,
    });
    // 手动检测任务不挂采集流，暂停仓库时不应取消这次单次检测。
    service.patch(repoId, { editRevision: 1, enabled: false });
    expect(repoRow(repoId).enabled).toBe(0);
    expect(streamOf(repoId, 'metadata')?.initialized_at).toBe(TEST_NOW - 100);
    expect(streamOf(repoId, 'metadata')?.detected_change_at).toBe(TEST_NOW - 80);
    expect((client.prepare('SELECT state FROM jobs WHERE id = ?').get(periodic.jobId) as { state: string }).state).toBe('cancelled');
    expect((client.prepare('SELECT state FROM jobs WHERE id = ?').get(manual.jobId) as { state: string }).state).toBe('queued');

    service.patch(repoId, { editRevision: 2, enabled: true });
    expect(repoRow(repoId).enabled).toBe(1);
    const metadata = streamOf(repoId, 'metadata') as StreamDbRow;
    expect(metadata.initialized_at).toBe(TEST_NOW - 100);
    expect(metadata.config_revision).toBe(4);
    expect(metadata.next_due_at).toBeGreaterThanOrEqual(TEST_NOW);
    const initJob = client
      .prepare("SELECT * FROM jobs WHERE kind = 'metadata' AND state = 'queued' AND queue_class = 'initialization'")
      .get() as JobDbRow | undefined;
    expect(initJob).toBeDefined();
    expect(initJob?.origin).toBe('control');
  });

  it('标签替换保留语义：只接受 20 个以内且必须存在', () => {
    const repoId = createVerifiedRepo('owner/labels');
    const first = insertLabel('一');
    const second = insertLabel('二');
    service.patch(repoId, { editRevision: 1, labelIds: [first] });
    expect(client.prepare('SELECT label_id FROM repository_labels WHERE repo_id = ?').all(repoId)).toHaveLength(1);

    service.patch(repoId, { editRevision: 2, labelIds: [first, second] });
    const attached = client.prepare('SELECT label_id FROM repository_labels WHERE repo_id = ? ORDER BY label_id').all(repoId) as {
      label_id: number;
    }[];
    expect(attached.map((row) => row.label_id)).toEqual([first, second]);

    service.patch(repoId, { editRevision: 3, labelIds: [second] });
    expect(
      (client.prepare('SELECT label_id FROM repository_labels WHERE repo_id = ?').all(repoId) as { label_id: number }[]).map(
        (row) => row.label_id,
      ),
    ).toEqual([second]);
    expect(count('labels')).toBe(2);

    expectAppError(() => service.patch(repoId, { editRevision: 4, labelIds: [999] }), 'VALIDATION_FAILED');
    expectAppError(
      () =>
        service.patch(repoId, {
          editRevision: 4,
          labelIds: Array.from({ length: MAX_LABELS_PER_REPO + 1 }, (_, index) => index + 1),
        }),
      'LABEL_LIMIT_REACHED',
    );
  });
});

// ---------------------------------------------------------------------------- 批量动作

describe('批量动作', () => {
  it('重复 ID 与非法 revision 整批拒绝', () => {
    createVerifiedRepo('owner/bulk-a');
    expectAppError(
      () => service.applyBulk({ action: 'pause', items: [{ id: 1, editRevision: 1 }, { id: 1, editRevision: 2 }], sessionAuthVersion: 1 }),
      'VALIDATION_FAILED',
    );
    expectAppError(
      () => service.applyBulk({ action: 'pause', items: [{ id: 1, editRevision: 0 }], sessionAuthVersion: 1 }),
      'VALIDATION_FAILED',
    );
    expectAppError(
      () =>
        service.applyBulk({
          action: 'pause',
          items: Array.from({ length: MAX_BATCH_IDS + 1 }, (_, index) => ({ id: index + 1, editRevision: 1 })),
          sessionAuthVersion: 1,
        }),
      'VALIDATION_FAILED',
    );
    expectAppError(() => service.applyBulk({ action: 'add_labels', items: [{ id: 1, editRevision: 1 }], sessionAuthVersion: 1 }), 'VALIDATION_FAILED');
  });

  it('逐项结果：ok / conflict / failed，互不影响', () => {
    insertAdmin(5);
    const a = createVerifiedRepo('owner/ok');
    const b = createVerifiedRepo('owner/conflict');

    const results = service.applyBulk({
      action: 'pause',
      items: [
        { id: a, editRevision: 1 },
        { id: b, editRevision: 99 },
        { id: 9999, editRevision: 1 },
      ],
      sessionAuthVersion: 5,
    });
    expect(results).toEqual([
      { id: a, status: 'ok', errorCode: null },
      { id: b, status: 'conflict', errorCode: 'REVISION_CONFLICT' },
      { id: 9999, status: 'failed', errorCode: 'NOT_FOUND' },
    ]);
    expect(repoRow(a).enabled).toBe(0);
    expect(repoRow(b).enabled).toBe(1);
  });

  it('会话无效且无已提交项时整批 401', () => {
    insertAdmin(5);
    const a = createVerifiedRepo('owner/auth');
    expectAppError(
      () => service.applyBulk({ action: 'pause', items: [{ id: a, editRevision: 1 }], sessionAuthVersion: 4 }),
      'UNAUTHENTICATED',
    );
    expect(repoRow(a).enabled).toBe(1);
  });

  it('会话中途失效：已提交项保留，剩余项标 not_executed_auth', () => {
    insertAdmin(5);
    const a = createVerifiedRepo('owner/auth-a');
    const b = createVerifiedRepo('owner/auth-b');
    const c = createVerifiedRepo('owner/auth-c');
    const labelId = insertLabel('触发');
    // 用触发器模拟批量过程中管理员密码变更导致的 auth_version 递增。
    client.prepare(
      `CREATE TRIGGER bump_auth_version AFTER INSERT ON repository_labels
       BEGIN UPDATE admin_account SET auth_version = auth_version + 1 WHERE id = 1; END`,
    ).run();

    const results = service.applyBulk({
      action: 'add_labels',
      labelIds: [labelId],
      items: [
        { id: a, editRevision: 1 },
        { id: b, editRevision: 1 },
        { id: c, editRevision: 1 },
      ],
      sessionAuthVersion: 5,
    });
    expect(results.map((row) => row.status)).toEqual(['ok', 'not_executed_auth', 'not_executed_auth']);
    expect(client.prepare('SELECT repo_id FROM repository_labels').all()).toEqual([{ repo_id: a }]);
  });

  it('check 动作对暂停仓库带 pause_override，且身份失配/未验证仓库不执行', () => {
    insertAdmin(1);
    const paused = createVerifiedRepo('owner/check');
    const streamId = insertStream(paused, 'metadata', { initializedAt: TEST_NOW - 100, lastSuccessAt: TEST_NOW - 10 * 60_000 });
    client.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(paused);

    const results = service.applyBulk({ action: 'check', items: [{ id: paused, editRevision: 1 }], sessionAuthVersion: 1 });
    expect(results[0]).toMatchObject({ status: 'ok' });
    const job = (client.prepare('SELECT * FROM jobs').all() as JobDbRow[]).find((row) => row.kind === 'metadata');
    expect(job).toMatchObject({ queue_class: 'manual', origin: 'manual', pause_override: 1, stream_id: streamId });
    expect(repoRow(paused).enabled).toBe(0);

    const pending = insertRepository(db, 'owner/pending');
    const blocked = createVerifiedRepo('owner/blocked');
    client.prepare("UPDATE repositories SET blocked_reason = 'REPOSITORY_IDENTITY_CHANGED' WHERE id = ?").run(blocked);
    const results2 = service.applyBulk({
      action: 'check',
      items: [
        { id: pending, editRevision: 1 },
        { id: blocked, editRevision: 1 },
      ],
      sessionAuthVersion: 1,
    });
    expect(results2.map((row) => row.status)).toEqual(['failed', 'failed']);
  });

  it('恢复会解除身份阻塞并重新入队 metadata', () => {
    insertAdmin(1);
    const repoId = createVerifiedRepo('owner/blocked-resume');
    insertStream(repoId, 'metadata', {});
    client
      .prepare("UPDATE repositories SET enabled = 0, blocked_reason = 'REPOSITORY_IDENTITY_CHANGED' WHERE id = ?")
      .run(repoId);

    const results = service.applyBulk({
      action: 'resume',
      items: [{ id: repoId, editRevision: 1 }],
      sessionAuthVersion: 1,
    });
    expect(results[0]).toMatchObject({ status: 'ok' });
    // 队列对阻塞仓库过滤掉全部业务类任务（含 metadata）：不解阻塞时这里刚入队的任务
    // 永远不会被领取，仓库只能永久停在错误状态。
    expect(repoRow(repoId).blocked_reason).toBeNull();
    const job = (client.prepare('SELECT * FROM jobs').all() as JobDbRow[]).find((row) => row.kind === 'metadata');
    expect(job).toMatchObject({ queue_class: 'initialization' });
  });

  it('标签动作保留其他标签，移除不删除全局定义', () => {
    insertAdmin(1);
    const repoId = createVerifiedRepo('owner/bulk-labels');
    const keep = insertLabel('保留');
    const addA = insertLabel('新增A');
    const addB = insertLabel('新增B');
    client.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)').run(repoId, keep);

    const added = service.applyBulk({
      action: 'add_labels',
      labelIds: [addA, addB],
      items: [{ id: repoId, editRevision: 1 }],
      sessionAuthVersion: 1,
    });
    expect(added[0]?.status).toBe('ok');
    expect(
      (client.prepare('SELECT label_id FROM repository_labels WHERE repo_id = ? ORDER BY label_id').all(repoId) as {
        label_id: number;
      }[]).map((row) => row.label_id),
    ).toEqual([keep, addA, addB].sort((x, y) => x - y));

    const removed = service.applyBulk({
      action: 'remove_labels',
      labelIds: [addA],
      items: [{ id: repoId, editRevision: 2 }],
      sessionAuthVersion: 1,
    });
    expect(removed[0]?.status).toBe('ok');
    expect(count('labels')).toBe(3);
    expect(
      (client.prepare('SELECT label_id FROM repository_labels WHERE repo_id = ? ORDER BY label_id').all(repoId) as {
        label_id: number;
      }[]).map((row) => row.label_id),
    ).toEqual([keep, addB].sort((x, y) => x - y));
  });

  it('add_labels 超过每仓 20 个标签时逐项失败，不写入', () => {
    insertAdmin(1);
    const repoId = createVerifiedRepo('owner/label-cap');
    const ids: number[] = [];
    const seed = client.transaction(() => {
      for (let index = 0; index < MAX_LABELS_PER_REPO; index += 1) ids.push(insertLabel(`标签-${index}`));
    });
    seed();
    // 已挂满 20 个标签，再添加一个即触发容量护栏。
    const attach = client.transaction(() => {
      for (const labelId of ids) {
        client.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)').run(repoId, labelId);
      }
    });
    attach();

    const extra = insertLabel('溢出');
    const results = service.applyBulk({
      action: 'add_labels',
      labelIds: [extra],
      items: [{ id: repoId, editRevision: 1 }],
      sessionAuthVersion: 1,
    });
    expect(results[0]).toEqual({ id: repoId, status: 'failed', errorCode: 'LABEL_LIMIT_REACHED' });
    expect(count('repository_labels')).toBe(MAX_LABELS_PER_REPO);
  });

  it('批量移除清理本地记录、流、缓存、趋势与未开始任务', () => {
    insertAdmin(1);
    const repoId = createVerifiedRepo('owner/remove');
    const streamId = insertStream(repoId, 'metadata', { initializedAt: TEST_NOW - 10 });
    insertBranch(repoId, 'fixed', 'main');
    client.prepare('INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, 1, 1, ?, ?)').run(
      repoId,
      '2026-10-01',
      TEST_NOW,
      TEST_NOW,
    );
    client.prepare(
      `INSERT INTO http_cache (key, repo_id, projection_json, validated_at, projection_version) VALUES (?, ?, '[]', ?, 1)`,
    ).run(`cache-${repoId}`, repoId, TEST_NOW);
    const group = client.prepare("INSERT INTO job_groups (kind, created_at) VALUES ('repository_import', ?)").run(TEST_NOW);
    const groupId = Number(group.lastInsertRowid);
    client.prepare("INSERT INTO job_group_items (group_id, input_index, normalized_input, repo_id, status) VALUES (?, 0, ?, ?, 'queued')").run(
      groupId,
      'owner/remove',
      repoId,
    );
    const { jobId } = queue.enqueue({
      kind: 'metadata',
      queueClass: 'initialization',
      origin: 'import',
      dueAt: TEST_NOW,
      streamId,
      dedupeKey: `stream:${streamId}`,
    });

    const results = service.applyBulk({ action: 'remove', items: [{ id: repoId, editRevision: 1 }], sessionAuthVersion: 1 });
    expect(results[0]?.status).toBe('ok');
    expect(repoRow(repoId)).toBeUndefined();
    expect(count('monitor_streams')).toBe(0);
    expect(count('tracked_branches')).toBe(0);
    expect(count('daily_metrics')).toBe(0);
    expect(count('http_cache')).toBe(0);
    expect((client.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: string }).state).toBe('cancelled');
    const item = client.prepare('SELECT repo_id, status FROM job_group_items WHERE group_id = ?').get(groupId) as {
      repo_id: number | null;
      status: string;
    };
    expect(item.repo_id).toBeNull();
    expect(item.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------- 分支

describe('分支配置与缓存', () => {
  it('21 个分支被拒绝；default 重复被拒绝；每组校验在写事务前完成', () => {
    const repoId = createVerifiedRepo('owner/branch-limit');
    expectAppError(
      () =>
        service.replaceBranches(
          repoId,
          1,
          Array.from({ length: MAX_BRANCHES_PER_REPO + 1 }, (_, index) => ({ mode: 'fixed' as const, name: `b-${index}` })),
        ),
      'BRANCH_LIMIT_REACHED',
    );
    expectAppError(
      () =>
        service.replaceBranches(repoId, 1, [
          { mode: 'default', name: null },
          { mode: 'default', name: null },
        ]),
      'VALIDATION_FAILED',
    );
    expectAppError(() => service.replaceBranches(repoId, 1, [{ mode: 'fixed', name: null }]), 'VALIDATION_FAILED');
    expectAppError(
      () =>
        service.replaceBranches(repoId, 1, [
          { mode: 'fixed', name: 'Main' },
          { mode: 'fixed', name: 'Main' },
        ]),
      'VALIDATION_FAILED',
    );
    expectAppError(() => service.replaceBranches(repoId, 99, [{ mode: 'default', name: null }]), 'REVISION_CONFLICT');
    expectAppError(() => service.replaceBranches(9999, 1, [{ mode: 'default', name: null }]), 'NOT_FOUND');
    expect(count('tracked_branches')).toBe(0);
  });

  it('替换分支设置：新流 initialized_at 为 NULL；删除的分支流级联清理；同 resolved_name 只保留一个流', () => {
    const repoId = createVerifiedRepo('owner/branch-replace', { defaultBranch: 'main' });
    const stale = insertBranch(repoId, 'fixed', 'stale');
    const staleStream = insertStream(repoId, 'branch', { branchId: stale, initializedAt: TEST_NOW - 10 });

    service.replaceBranches(repoId, 1, [
      { mode: 'default', name: null },
      { mode: 'fixed', name: 'main' },
      { mode: 'fixed', name: 'dev' },
    ]);

    const branches = client.prepare('SELECT * FROM tracked_branches WHERE repo_id = ? ORDER BY id').all(repoId) as {
      id: number;
      mode: string;
      configured_name: string | null;
      enabled: number;
    }[];
    expect(branches).toHaveLength(3);
    const duplicate = branches.find((row) => row.mode === 'fixed' && row.configured_name === 'main');
    expect(duplicate?.enabled).toBe(0);

    // stale 分支与流被清理，其任务取消。
    expect(streamOf(repoId, 'branch')?.branch_id).not.toBe(stale);
    expect(client.prepare('SELECT id FROM monitor_streams WHERE id = ?').get(staleStream)).toBeUndefined();

    const branchStreams = streamsOf(repoId).filter((stream) => stream.kind === 'branch');
    expect(branchStreams).toHaveLength(2);
    for (const stream of branchStreams) {
      expect(stream.initialized_at).toBeNull();
      expect(stream.next_due_at).not.toBeNull();
    }
    expect(repoRow(repoId).edit_revision).toBe(2);
    expect(repoRow(repoId).collection_revision).toBe(2);

    // 再次替换（相同集合）不重复创建流。
    service.replaceBranches(repoId, 2, [
      { mode: 'default', name: null },
      { mode: 'fixed', name: 'main' },
      { mode: 'fixed', name: 'dev' },
    ]);
    expect(streamsOf(repoId).filter((stream) => stream.kind === 'branch')).toHaveLength(2);
  });

  it('readAvailableBranches 只读本地缓存，未命中不创建任务', () => {
    const repoId = createVerifiedRepo('owner/branch-cache');
    const jobsBefore = count('jobs');

    const missing = service.readAvailableBranches(repoId, 1, 30);
    expect(missing).toEqual({ items: [], total: 0, cacheStatus: 'missing', fetchedAt: null });
    expect(count('jobs')).toBe(jobsBefore);

    const key = cacheKeyFor({
      path: '/repos/owner/branch-cache/branches',
      query: { per_page: '100' },
      credentialRevision: 1,
      token: null,
    });
    client.prepare(
      `INSERT INTO http_cache (key, repo_id, projection_json, validated_at, projection_version) VALUES (?, ?, ?, ?, 1)`,
    ).run(key, repoId, JSON.stringify([{ name: 'main' }, { name: 'dev' }, { name: 'feature/x' }]), TEST_NOW);

    const fresh = service.readAvailableBranches(repoId, 1, 2);
    expect(fresh.total).toBe(3);
    expect(fresh.items).toEqual([{ name: 'main' }, { name: 'dev' }]);
    expect(fresh.cacheStatus).toBe('fresh');
    expect(fresh.fetchedAt).toBe(TEST_NOW);

    const page2 = service.readAvailableBranches(repoId, 2, 2);
    expect(page2.items).toEqual([{ name: 'feature/x' }]);

    client.prepare('UPDATE http_cache SET validated_at = ? WHERE key = ?').run(TEST_NOW - 25 * 3600_000, key);
    expect(service.readAvailableBranches(repoId, 1, 30).cacheStatus).toBe('stale');

    // 显式刷新任务在途时标记 refreshing（branch_list 不挂采集流，仓库归属在 continuation 里）。
    queue.enqueue({
      kind: 'branch_list',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: TEST_NOW,
      dedupeKey: `branch-list:${repoId}`,
      continuationJson: JSON.stringify({ repoId }),
    });
    expect(service.readAvailableBranches(repoId, 1, 30).cacheStatus).toBe('refreshing');
    expect(count('jobs')).toBe(jobsBefore + 1);
  });
});

// ---------------------------------------------------------------------------- 读取与管理数据

describe('detail 与 controls', () => {
  it('detail 返回可编辑配置、分支与流状态（契约形状）', () => {
    const repoId = createVerifiedRepo('Owner/Detail');
    insertStream(repoId, 'metadata', { initializedAt: TEST_NOW - 10, lastSuccessAt: TEST_NOW - 5 });
    const branchId = insertBranch(repoId, 'fixed', 'dev');
    insertStream(repoId, 'branch', { branchId, initializedAt: TEST_NOW - 8, lastSuccessAt: TEST_NOW - 4 });
    const labelId = insertLabel('工具');
    client.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)').run(repoId, labelId);

    const detail = service.detail(repoId);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(`repo_${repoId}`);
    expect(detail?.fullName).toBe('Owner/Detail');
    expect(detail?.createdAt).toBe(new Date(TEST_NOW).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    expect(detail?.labels).toEqual([{ id: `label_${labelId}`, name: '工具', color: null }]);
    expect(detail?.branches).toHaveLength(1);
    expect(detail?.branches[0]).toMatchObject({ id: branchId, mode: 'fixed', name: 'dev', enabled: true, status: 'ok' });
    const kinds = detail?.streams.map((stream) => stream.kind) ?? [];
    expect(kinds).toEqual(['metadata', 'branch']);
    expect(detail?.lastCheckedAt).toBe(new Date(TEST_NOW - 5).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    expect(detail?.lastCheckedAt).not.toBeNull();
    expect(detail?.editRevision).toBe(1);
    expect(service.detail(9999)).toBeNull();
  });

  it('controls 一次最多 100 个 ID，返回暂停状态、聚合状态与能力位', () => {
    expectAppError(
      () => service.controls(Array.from({ length: 101 }, (_, index) => index + 1)),
      'VALIDATION_FAILED',
    );
    const ids: number[] = [];
    const seed = client.transaction(() => {
      for (let index = 0; index < MAX_BATCH_IDS; index += 1) ids.push(createVerifiedRepo(`owner/control-${index}`));
    });
    seed();
    const disabled = ids[0] as number;
    client.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(disabled);
    client.prepare("UPDATE repositories SET verification_state = 'pending' WHERE id = ?").run(ids[1] as number);

    const rows = service.controls([...ids]);
    expect(rows).toHaveLength(MAX_BATCH_IDS);
    expect(rows[0]).toMatchObject({ id: disabled, paused: true, status: 'paused' });
    expect(rows[0]?.capabilities.canResume).toBe(true);
    expect(rows[1]).toMatchObject({ id: ids[1], verificationState: 'pending', status: 'pending' });
    expect(rows[1]?.capabilities.canCheck).toBe(false);
    expect(rows[2]?.capabilities.canCheck).toBe(true);
    // 不存在的 ID 被跳过，不因缺失行报错。
    expect(service.controls([9999])).toEqual([]);
    expect(service.controls([])).toEqual([]);
  });

  it('controls 聚合状态按运行时有效分支计算：与默认分支重名的固定分支不拖累状态', () => {
    const repoId = createVerifiedRepo('owner/aggregate');
    client
      .prepare(
        "INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name) VALUES (?, 'default', NULL, 'main')",
      )
      .run(repoId);
    const fixedId = insertBranch(repoId, 'fixed', 'main');
    const defaultId = (
      client.prepare("SELECT id FROM tracked_branches WHERE repo_id = ? AND mode = 'default'").get(repoId) as {
        id: number;
      }
    ).id;

    insertStream(repoId, 'metadata', { initializedAt: TEST_NOW - 10, lastSuccessAt: TEST_NOW - 5 });
    insertStream(repoId, 'branch', { branchId: defaultId, initializedAt: TEST_NOW - 8, lastSuccessAt: TEST_NOW - 4 });
    // 同名固定分支已被默认跟随排除：它报错也不参与聚合，仓库仍为 healthy。
    insertStream(repoId, 'branch', {
      branchId: fixedId,
      lastSuccessAt: TEST_NOW - 4,
      lastErrorCode: 'GITHUB_ACCESS_DENIED_OR_MISSING',
    });

    expect(service.controls([repoId])[0]?.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------- 单仓删除

describe('单仓移除', () => {
  it('If-Match 版本不符 409，成功后返回规范名并清理本地数据', () => {
    const repoId = createVerifiedRepo('Owner/Remove-Single');
    expectAppError(() => service.remove(repoId, 99), 'REVISION_CONFLICT');
    expect(repoRow(repoId)).toBeDefined();
    expectAppError(() => service.remove(9999), 'NOT_FOUND');

    expect(service.remove(repoId, 1)).toBe('Owner/Remove-Single');
    expect(repoRow(repoId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- 标签与置顶

describe('标签定义与置顶', () => {
  it('创建、列表、重名拒绝、版本冲突与删除', () => {
    const created = labels.create('开发工具', '#336699');
    expect(created).toMatchObject({ id: 'label_1', name: '开发工具', color: '#336699', labelRevision: 1, usedByRepositories: 0 });
    expectAppError(() => labels.create('开发工具', null), 'VALIDATION_FAILED');
    expectAppError(() => labels.update(1, 99, { color: '#000000' }), 'REVISION_CONFLICT');

    const repoId = createVerifiedRepo('owner/label-use');
    client.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)').run(repoId, 1);
    expect(labels.list()[0]?.usedByRepositories).toBe(1);

    const updated = labels.update(1, 1, { color: '#111111' });
    expect(updated).toMatchObject({ labelRevision: 2, color: '#111111' });
    // 删除同样要求前置版本：缺 428、冲突 409，避免用旧界面覆盖他人的修改。
    expectAppError(() => labels.remove(1), 'REVISION_REQUIRED');
    expectAppError(() => labels.remove(1, 1), 'REVISION_CONFLICT');
    // 仍有仓库在用：删除被拒绝，标签与关联都保留。
    expectAppError(() => labels.remove(1, 2), 'LABEL_IN_USE');
    expect(count('repository_labels')).toBe(1);
    expect(count('labels')).toBe(1);

    // 解除关联后才能删除定义。
    client.prepare('DELETE FROM repository_labels WHERE label_id = 1').run();
    labels.remove(1, 2);
    expect(count('repository_labels')).toBe(0);
    expect(count('labels')).toBe(0);
    expectAppError(() => labels.remove(1, 2), 'NOT_FOUND');
  });

  it('setPins 用 pinsRevision 比较，只改变置顶顺序与编辑/展示版本', () => {
    const a = createVerifiedRepo('owner/pin-a');
    const b = createVerifiedRepo('owner/pin-b');
    insertStream(a, 'metadata', { initializedAt: TEST_NOW - 10, detectedChangeAt: TEST_NOW - 9 });

    expectAppError(() => labels.setPins(undefined, [a]), 'REVISION_REQUIRED');
    expectAppError(() => labels.setPins(9, [a]), 'REVISION_CONFLICT');
    expectAppError(() => labels.setPins(1, [a, 9999]), 'VALIDATION_FAILED');
    expectAppError(() => labels.setPins(1, [a, a]), 'VALIDATION_FAILED');

    labels.setPins(1, [b, a]);
    expect(repoRow(b).pin_order).toBe(1);
    expect(repoRow(a).pin_order).toBe(2);
    expect(repoRow(a).edit_revision).toBe(2);
    expect(repoRow(a).display_revision).toBe(2);
    expect(streamOf(a, 'metadata')?.detected_change_at).toBe(TEST_NOW - 9);
    const settingsRow = client.prepare('SELECT pins_revision FROM settings WHERE id = 1').get() as { pins_revision: number };
    expect(settingsRow.pins_revision).toBe(2);

    labels.setPins(2, []);
    expect(repoRow(a).pin_order).toBeNull();
    expect(repoRow(b).pin_order).toBeNull();
  });
});
