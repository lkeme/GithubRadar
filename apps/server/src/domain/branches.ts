import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { MAX_BRANCHES_PER_REPO, MAX_BRANCH_NAME_BYTES } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { httpCache, jobs, monitorStreams, repositories, trackedBranches } from '../db/schema.js';
import { AppError, validationFailed } from '../http/errors.js';
import { cacheKeyFor } from '../integrations/github/client.js';
import { parseBranchList } from '../integrations/github/projections.js';
import { BRANCH_CACHE_TTL_MS } from '../scheduler/constants.js';
import { HOUR_MS, initialDueAt, phaseSeedFor } from '../scheduler/planner.js';
import type { JobKind, JobOrigin, JobQueue } from '../scheduler/queue.js';

/**
 * 分支配置。
 *
 * - 每仓 20 个唯一有效分支上限由数据库触发器兜底，应用层先校验并抛
 *   `AppError('BRANCH_LIMIT_REACHED')`。
 * - `mode='default'` 每仓至多一条且 `configured_name` 为 NULL；`fixed` 必须有名称，
 *   `(repo_id, configured_name)` 唯一且区分大小写。
 * - 同一 `resolved_name` 只保留一个采集流：重复条目保留配置行但 `enabled=0`，
 *   不创建分支流（`ensureStreams` 只处理 enabled 的分支）。
 * - 新增分支流 `initialized_at = NULL`，单独初始化，不产生更新提示。
 */

export const BRANCH_STATUSES = ['ok', 'unavailable', 'initializing', 'error'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export interface BranchConfigRow {
  readonly id: number;
  readonly mode: 'default' | 'fixed';
  /** 配置名（fixed 模式的分支名；default 跟随模式为 null），按契约 `BranchConfig.name`。 */
  readonly name: string | null;
  readonly resolvedName: string | null;
  readonly enabled: boolean;
  readonly status: BranchStatus;
  readonly committedAt: string | null;
  readonly url: string | null;
}

export interface BranchSelectionEntry {
  readonly mode: 'default' | 'fixed';
  readonly name: string | null;
}

export interface BranchSelectionDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly now: () => number;
}

/**
 * 共享的 `BEGIN IMMEDIATE` 短事务：容量检查、版本比较与占位/流写入必须在同一写事务内。
 * 已在事务中时直接复用外层事务（当前调用方均在事务外；此分支为嵌套调用的兜底）。
 */
export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  const client = db.$client;
  if (client.inTransaction) return fn();
  client.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    client.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      client.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始错误，连接级故障由上层处理。
    }
    throw error;
  }
}

/** 取消某个采集流上尚未开始的任务（周期/初始化均可），已领取的任务交由回调保护。 */
export function cancelQueuedJobsForStream(db: Database, streamId: number, now: number): number {
  return db
    .update(jobs)
    .set({ state: 'cancelled', finishedAt: now })
    .where(and(eq(jobs.streamId, streamId), inArray(jobs.state, ['queued', 'retry_wait'])))
    .run().changes;
}

/** 仓库档位（含继承全局）换算为毫秒。 */
export function repositoryIntervalMs(db: Database, repo: { readonly intervalHours: number | null }): number {
  let hours = repo.intervalHours;
  if (hours === null) {
    const row = db.$client
      .prepare('SELECT default_interval_hours AS hours FROM settings WHERE id = 1')
      .get() as { hours: number } | undefined;
    hours = row?.hours ?? 24;
  }
  return hours * HOUR_MS;
}

export interface StreamCreationSpec {
  readonly repoId: number;
  readonly kind: 'metadata' | 'release' | 'prerelease' | 'branch';
  readonly branchId: number | null;
  readonly configRevision: number;
  /** 相位种子来源：已验证仓库用 github_id，未验证用本行 id。 */
  readonly phaseSeedBase: number;
  readonly intervalMs: number;
  readonly origin: JobOrigin;
  readonly acceptedAuthVersion?: number | null;
}

/**
 * 创建采集流并安排一次初始化任务（新增流 `initialized_at = NULL`）。
 * 同资源已存在流时不做任何事并返回 null，避免覆盖已有基线。
 */
export function createStreamWithInitializationJob(
  db: Database,
  queue: JobQueue,
  spec: StreamCreationSpec,
  now: number,
): { streamId: number; jobId: number } | null {
  const existing = db
    .select({ id: monitorStreams.id })
    .from(monitorStreams)
    .where(
      and(
        eq(monitorStreams.repoId, spec.repoId),
        eq(monitorStreams.kind, spec.kind),
        spec.branchId === null ? isNull(monitorStreams.branchId) : eq(monitorStreams.branchId, spec.branchId),
      ),
    )
    .get();
  if (existing !== undefined) return null;

  const seed = phaseSeedFor(spec.phaseSeedBase + (spec.branchId ?? 0) * 31 + spec.kind.length);
  const inserted = db
    .insert(monitorStreams)
    .values({
      repoId: spec.repoId,
      kind: spec.kind,
      branchId: spec.branchId,
      initializedAt: null,
      currentProjectionJson: null,
      detectedChangeAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
      // 首次初始化按错峰桶开始，不立即发起全部请求。
      nextDueAt: initialDueAt(seed, now, spec.intervalMs),
      phaseSeed: seed,
      configRevision: spec.configRevision,
    })
    .returning({ id: monitorStreams.id })
    .all();
  const streamId = inserted[0]?.id;
  if (streamId === undefined) throw new Error('创建采集流失败');

  const { jobId } = queue.enqueue({
    kind: spec.kind as JobKind,
    queueClass: 'initialization',
    origin: spec.origin,
    dueAt: now,
    streamId,
    dedupeKey: `stream:${streamId}`,
    configRevision: spec.configRevision,
    acceptedAuthVersion: spec.acceptedAuthVersion ?? null,
  });
  return { streamId, jobId };
}

/** 校验分支选择：数量上限、default 唯一性、fixed 名称与大小写敏感的唯一性。 */
export function validateBranchSelection(
  selection: readonly BranchSelectionEntry[],
): { mode: 'default' | 'fixed'; name: string | null }[] {
  if (selection.length > MAX_BRANCHES_PER_REPO) {
    throw new AppError('BRANCH_LIMIT_REACHED', `每仓最多 ${MAX_BRANCHES_PER_REPO} 个有效分支`);
  }
  const seen = new Set<string>();
  const out: { mode: 'default' | 'fixed'; name: string | null }[] = [];
  let defaults = 0;

  for (const entry of selection) {
    if (entry.mode === 'default') {
      if (entry.name !== null && entry.name !== undefined) {
        throw validationFailed({ branches: 'default 跟随模式不能指定分支名' });
      }
      if (defaults > 0) {
        throw validationFailed({ branches: '每仓至多一条 default 跟随分支' });
      }
      defaults += 1;
      seen.add('default');
      out.push({ mode: 'default', name: null });
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') {
      throw validationFailed({ branches: 'fixed 模式必须提供分支名' });
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_BRANCH_NAME_BYTES) {
      throw validationFailed({ branches: `分支名超过 ${MAX_BRANCH_NAME_BYTES} 字节` });
    }
    if (seen.has(`fixed\u0000${name}`)) {
      throw validationFailed({ branches: `分支「${name}」重复` });
    }
    seen.add(`fixed\u0000${name}`);
    out.push({ mode: 'fixed', name });
  }
  return out;
}

function branchKeyOf(mode: string, configuredName: string | null): string {
  return mode === 'default' ? 'default' : `fixed\u0000${configuredName ?? ''}`;
}

/** 替换所选分支设置（PUT branches）；editRevision 在写事务内比较。 */
export function replaceBranchSelection(
  deps: BranchSelectionDeps,
  repoId: number,
  editRevision: number,
  selection: readonly BranchSelectionEntry[],
): void {
  const { db, queue, now } = deps;
  const desired = validateBranchSelection(selection);
  const timestamp = now();

  withImmediateTransaction(db, () => {
    const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (repo === undefined) throw new AppError('NOT_FOUND', '仓库不存在');
    if (repo.editRevision !== editRevision) {
      throw new AppError('REVISION_CONFLICT', '仓库配置已被其他编辑修改，请刷新后重试');
    }
    const claim = db
      .update(repositories)
      .set({ editRevision: sql`${repositories.editRevision} + 1` })
      .where(and(eq(repositories.id, repoId), eq(repositories.editRevision, editRevision)))
      .run();
    if (claim.changes === 0) {
      throw new AppError('REVISION_CONFLICT', '仓库配置已被其他编辑修改，请刷新后重试');
    }

    // 目标解析名：default 跟随当前默认分支（可能尚未验证），fixed 用配置名。
    const mergedNames = new Set<string>();
    if (desired.some((entry) => entry.mode === 'default') && repo.defaultBranch !== null) {
      mergedNames.add(repo.defaultBranch);
    }
    const plan = desired.map((entry) => {
      if (entry.mode === 'default') {
        return {
          key: 'default',
          mode: 'default' as const,
          configuredName: null,
          resolvedName: repo.defaultBranch,
          enabled: true,
        };
      }
      const duplicate = mergedNames.has(entry.name ?? '');
      if (!duplicate) mergedNames.add(entry.name ?? '');
      return {
        key: branchKeyOf('fixed', entry.name),
        mode: 'fixed' as const,
        configuredName: entry.name,
        resolvedName: entry.name,
        enabled: !duplicate,
      };
    });

    const existingRows = db
      .select()
      .from(trackedBranches)
      .where(eq(trackedBranches.repoId, repoId))
      .all();
    const existingByKey = new Map(existingRows.map((row) => [branchKeyOf(row.mode, row.configuredName), row]));
    const keep = new Set(plan.map((entry) => entry.key));

    let changed = false;
    for (const row of existingRows) {
      if (keep.has(branchKeyOf(row.mode, row.configuredName))) continue;
      // 删除的分支流级联清理；未开始的流任务先取消，避免引用被删流。
      const streams = db
        .select({ id: monitorStreams.id })
        .from(monitorStreams)
        .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.branchId, row.id)))
        .all();
      for (const stream of streams) {
        cancelQueuedJobsForStream(db, stream.id, timestamp);
      }
      db.delete(trackedBranches).where(eq(trackedBranches.id, row.id)).run();
      changed = true;
    }

    const branchIds: { branchId: number; enabled: boolean }[] = [];
    for (const entry of plan) {
      const row = existingByKey.get(entry.key);
      if (row === undefined) {
        const inserted = db
          .insert(trackedBranches)
          .values({
            repoId,
            mode: entry.mode,
            configuredName: entry.configuredName,
            resolvedName: entry.resolvedName,
            enabled: entry.enabled,
          })
          .returning({ id: trackedBranches.id })
          .all();
        const branchId = inserted[0]?.id;
        if (branchId === undefined) throw new Error('创建分支配置失败');
        branchIds.push({ branchId, enabled: entry.enabled });
        changed = true;
        continue;
      }
      branchIds.push({ branchId: row.id, enabled: entry.enabled });
      if (row.enabled !== entry.enabled || row.resolvedName !== entry.resolvedName) {
        db.update(trackedBranches)
          .set({ enabled: entry.enabled, resolvedName: entry.resolvedName })
          .where(eq(trackedBranches.id, row.id))
          .run();
        changed = true;
      }
    }

    // 分支集合变化增加相关流采集 revision；新增流使用递增后的值。
    const nextCollectionRevision = repo.collectionRevision + (changed ? 1 : 0);
    if (changed) {
      db.update(repositories)
        .set({ collectionRevision: nextCollectionRevision })
        .where(eq(repositories.id, repoId))
        .run();
    }

    const intervalMs = repositoryIntervalMs(db, repo);
    const seedBase = repo.githubId ?? repo.id;
    for (const entry of branchIds) {
      if (!entry.enabled) continue;
      createStreamWithInitializationJob(
        db,
        queue,
        {
          repoId,
          kind: 'branch',
          branchId: entry.branchId,
          configRevision: nextCollectionRevision,
          phaseSeedBase: seedBase,
          intervalMs,
          origin: 'control',
        },
        timestamp,
      );
    }
  });
}

interface BranchRow {
  id: number;
  mode: string;
  configured_name: string | null;
  resolved_name: string | null;
  enabled: number;
  stream_id: number | null;
  initialized_at: number | null;
  last_error_code: string | null;
  current_projection_json: string | null;
}

function branchStatusOf(streamId: number | null, initializedAt: number | null, lastErrorCode: string | null): BranchStatus {
  if (streamId === null) return 'initializing';
  if (lastErrorCode === 'GITHUB_ACCESS_DENIED_OR_MISSING') return 'unavailable';
  if (lastErrorCode !== null) return 'error';
  if (initializedAt === null) return 'initializing';
  return 'ok';
}

function readBranchProjection(json: string | null): { committedAt: string; url: string } | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as { committedAt?: unknown; htmlUrl?: unknown };
    if (typeof value.committedAt === 'string' && typeof value.htmlUrl === 'string') {
      return { committedAt: value.committedAt, url: value.htmlUrl };
    }
  } catch {
    // 投影损坏按未提交处理，不视为成功。
  }
  return null;
}

/** 分支配置行 + 各分支流状态（供 GET /admin/repositories/:id 使用）。 */
export function branchConfigRows(db: Database, repoId: number): BranchConfigRow[] {
  const rows = db.$client
    .prepare(
      `SELECT b.id, b.mode, b.configured_name, b.resolved_name, b.enabled,
              s.id AS stream_id, s.initialized_at, s.last_error_code, s.current_projection_json
         FROM tracked_branches b
         LEFT JOIN monitor_streams s ON s.kind = 'branch' AND s.branch_id = b.id
        WHERE b.repo_id = ?
        ORDER BY b.id`,
    )
    .all(repoId) as BranchRow[];

  return rows.map((row) => {
    const projection = readBranchProjection(row.current_projection_json);
    return {
      id: row.id,
      mode: row.mode === 'default' ? 'default' : 'fixed',
      name: row.configured_name,
      resolvedName: row.resolved_name,
      enabled: row.enabled === 1,
      status: branchStatusOf(row.stream_id, row.initialized_at, row.last_error_code),
      committedAt: projection?.committedAt ?? null,
      url: projection?.url ?? null,
    };
  });
}

export interface AvailableBranchesPage {
  readonly items: { name: string }[];
  readonly total: number;
  readonly cacheStatus: 'fresh' | 'stale' | 'missing' | 'refreshing';
  readonly fetchedAt: number | null;
}

function readCredentialRevision(db: Database): number {
  const row = db.$client
    .prepare('SELECT credential_revision AS revision FROM github_credential_status WHERE id = 1')
    .get() as { revision: number } | undefined;
  return row?.revision ?? 1;
}

/**
 * 只读本地 `http_cache` 中分支选择器的投影。
 * 未命中不创建任务；显式刷新由调用方另发 branch_list 任务。
 */
export function readAvailableBranchesPage(
  db: Database,
  repoId: number,
  page: number,
  pageSize: number,
  now: number,
): AvailableBranchesPage {
  const repo = db
    .select({ canonicalName: repositories.canonicalName })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .get();
  if (repo === undefined) throw new AppError('NOT_FOUND', '仓库不存在');

  const [owner = '', name = ''] = repo.canonicalName.split('/');
  const key = cacheKeyFor({
    path: `/repos/${owner}/${name}/branches`,
    query: { per_page: '100' },
    credentialRevision: readCredentialRevision(db),
    token: null,
  });
  const cached = db.select().from(httpCache).where(eq(httpCache.key, key)).get();

  let items: { name: string }[] = [];
  let fetchedAt: number | null = null;
  let cacheStatus: AvailableBranchesPage['cacheStatus'] = 'missing';
  if (cached !== undefined && cached.projectionJson !== null) {
    fetchedAt = cached.validatedAt;
    try {
      items = parseBranchList(JSON.parse(cached.projectionJson) as unknown);
      const validatedAt = cached.validatedAt ?? 0;
      cacheStatus = now - validatedAt <= BRANCH_CACHE_TTL_MS ? 'fresh' : 'stale';
    } catch {
      items = [];
      cacheStatus = 'stale';
    }
  }

  // branch_list 任务不挂采集流，仓库归属在 continuation_json.repoId 里（刷新分支缓存）。
  const refreshing = db.$client
    .prepare(
      `SELECT 1 AS active
         FROM jobs
        WHERE kind = 'branch_list'
          AND state IN ('queued', 'running', 'retry_wait')
          AND json_extract(continuation_json, '$.repoId') = ?
        LIMIT 1`,
    )
    .get(repoId) as { active: number } | undefined;
  if (refreshing !== undefined) cacheStatus = 'refreshing';

  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const safeSize = Number.isFinite(pageSize) ? Math.min(100, Math.max(1, Math.floor(pageSize))) : 30;
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    total: items.length,
    cacheStatus,
    fetchedAt,
  };
}
