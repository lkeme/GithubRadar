import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import {
  INTERVAL_OPTIONS,
  MAX_BATCH_IDS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_IMPORT_ROWS,
  MAX_LABELS_PER_REPO,
  MAX_NOTE_LENGTH,
  REPOSITORY_LIMIT,
  type RepositoryStatus,
} from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import {
  dailyMetrics,
  jobGroupItems,
  jobGroups,
  jobs,
  labels,
  monitorStreams,
  repositories,
  repositoryLabels,
  trackedBranches,
} from '../db/schema.js';
import { AppError, isAppError, unauthenticated, validationFailed } from '../http/errors.js';
import { IMPORT_RESERVATION_TIMEOUT_MS, MANUAL_REUSE_WINDOW_MS } from '../scheduler/constants.js';
import { HOUR_MS, advanceDueAt } from '../scheduler/planner.js';
import type { JobQueue } from '../scheduler/queue.js';
import { collectableBranchIds, type BranchActivityRow } from '../scheduler/streams.js';
import {
  branchConfigRows,
  cancelQueuedJobsForStream,
  createStreamWithInitializationJob,
  readAvailableBranchesPage,
  repositoryIntervalMs,
  replaceBranchSelection,
  withImmediateTransaction,
  type AvailableBranchesPage,
  type BranchConfigRow,
  type BranchSelectionEntry,
} from './branches.js';
import { splitRepositoryInputRows, type InputParseError } from './input.js';
import { publicLabelId } from './labels.js';
import { isoUtc, publicRepoId } from './public.js';
import { aggregateRepositoryStatus } from './status.js';

/**
 * 仓库管理领域模块。
 *
 * 边界约定：
 * - 服务端维护字段（github_id、canonical_name、stars、baseline、blocked_reason、
 *   credential_revision 等）没有进入任何方法签名，接口层面就不可能被整体 spread 覆盖。
 * - 单仓编辑在 `BEGIN IMMEDIATE` 短事务内比较并递增 `edit_revision`；
 *   批量动作逐项独立短事务，事务内同时复核会话有效性与 editRevision。
 * - 改备注/别名/置顶/档位只增加展示或编辑版本，绝不清空采集基线、
 *   `detected_change_at` 或更新标记。
 */

export interface RepositoryDomainDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly now: () => number;
  /** 业务就绪门禁；批量处理期间逐项复核。未提供时视为始终就绪。 */
  readonly isBusinessReady?: () => boolean;
}

export type RepositoryVerificationState = 'pending' | 'verified' | 'failed' | 'expired';

/**
 * 采集流状态视图，按契约 `StreamStatus` 投影：时间字段为 ISO 8601 UTC 字符串，
 * `branchId` 保留数字主键，便于管理接口直接透出（GET /admin/repositories/:id）。
 */
export interface StreamStatusRow {
  readonly kind: 'metadata' | 'release' | 'prerelease' | 'branch';
  readonly branchId: number | null;
  readonly initialized: boolean;
  readonly detectedChangeAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastErrorCode: string | null;
  readonly nextDueAt: string | null;
}

/** 仓库可编辑配置 + 各流状态，按契约 `RepositoryDetail` 投影。 */
export interface RepositoryDetailRow {
  readonly id: string;
  readonly fullName: string;
  readonly displayName: string | null;
  readonly note: string | null;
  readonly description: string | null;
  readonly url: string;
  readonly htmlUrl: string;
  readonly isPrivate: boolean;
  readonly language: string | null;
  readonly stars: number;
  readonly forks: number;
  readonly archived: boolean;
  readonly enabled: boolean;
  readonly blockedReason: string | null;
  readonly intervalHours: number | null;
  readonly releaseEnabled: boolean;
  readonly includePrereleases: boolean;
  readonly defaultBranch: string | null;
  readonly pinOrder: number | null;
  readonly labels: { readonly id: string; readonly name: string; readonly color: string | null }[];
  readonly branches: BranchConfigRow[];
  readonly streams: StreamStatusRow[];
  readonly trends: { readonly day: string; readonly stars: number; readonly forks: number }[];
  readonly editRevision: number;
  readonly displayRevision: number;
  readonly collectionRevision: number;
  readonly identityRevision: number;
  readonly verificationState: RepositoryVerificationState;
  readonly identityVerifiedAt: string | null;
  readonly createdAt: string;
  readonly lastCheckedAt: string | null;
}

export type RepositoryJobState = 'idle' | 'queued' | 'running' | 'retry_wait';

export interface ControlRow {
  readonly id: number;
  readonly editRevision: number;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly status: RepositoryStatus;
  readonly verificationState: RepositoryVerificationState;
  readonly jobState: RepositoryJobState;
  readonly capabilities: {
    readonly canCheck: boolean;
    readonly canPause: boolean;
    readonly canResume: boolean;
    readonly canRemove: boolean;
    readonly canEdit: boolean;
  };
}

export interface RepositoryPatchInput {
  /** 缺前置版本：抛 428 REVISION_REQUIRED。 */
  readonly editRevision?: number;
  readonly displayName?: string | null;
  readonly note?: string | null;
  readonly enabled?: boolean;
  readonly intervalHours?: 3 | 6 | 12 | 24 | null;
  readonly releaseEnabled?: boolean;
  readonly includePrereleases?: boolean;
  readonly labelIds?: number[];
}

export type BulkActionInput = 'pause' | 'resume' | 'add_labels' | 'remove_labels' | 'remove' | 'check';

export type BulkItemStatus = 'ok' | 'conflict' | 'failed' | 'not_executed_auth' | 'not_executed_setup_required';

export interface BulkItemResultRow {
  readonly id: number;
  readonly status: BulkItemStatus;
  readonly errorCode: string | null;
}

export interface BulkActionCall {
  readonly action: BulkActionInput;
  readonly items: { readonly id: number; readonly editRevision: number }[];
  readonly labelIds?: number[];
  readonly sessionAuthVersion: number;
}

/** 与契约 `ImportItemStatus` 对齐的逐项状态。 */
export type ImportItemStatusRow =
  | 'pending'
  | 'queued'
  | 'succeeded'
  | 'exists'
  | 'invalid'
  | 'limit_reached'
  | 'denied_or_missing'
  | 'failed'
  | 'expired';

/** 逐项导入状态，按契约 `ImportItem` 投影（repoId 为不透明字符串）。 */
export interface ImportItemRow {
  readonly index: number;
  readonly input: string;
  readonly status: ImportItemStatusRow;
  readonly errorCode: string | null;
  readonly repoId: string | null;
}

export interface ImportProgressRow {
  readonly state: 'running' | 'finished';
  readonly total: number;
  readonly items: ImportItemRow[];
}

export interface ImportBatchResult {
  readonly groupId: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly overflow: number;
}

export interface BulkItemCall {
  readonly id: number;
  readonly editRevision: number;
}

/** 会话在批量中途失效的内部信号：提交项保留，后续项停止。 */
class AuthRevokedSignal extends Error {
  constructor() {
    super('session revoked');
    this.name = 'AuthRevokedSignal';
  }
}

const INPUT_PARSE_ERRORS: readonly InputParseError[] = [
  'EMPTY',
  'INVALID_FORMAT',
  'SUB_PATH',
  'USERINFO',
  'BAD_HOST',
  'BAD_PORT',
  'ENCODED_SLASH',
];

type RepoRow = typeof repositories.$inferSelect;
type StreamRow = typeof monitorStreams.$inferSelect;

/** 导入批次逐项状态与任务状态的投影（只读，不写回）。 */
function importItemStatusOf(errorCode: string | null, status: string, jobState: string | null, jobErrorCode: string | null): ImportItemStatusRow {
  const code = errorCode ?? jobErrorCode;
  if (code !== null) {
    if (code === 'REPOSITORY_ALREADY_EXISTS') return 'exists';
    if (code === 'REPOSITORY_LIMIT_REACHED') return 'limit_reached';
    if (code === 'IMPORT_EXPIRED') return 'expired';
    if (code === 'GITHUB_ACCESS_DENIED_OR_MISSING') return 'denied_or_missing';
    if ((INPUT_PARSE_ERRORS as readonly string[]).includes(code)) return 'invalid';
    return 'failed';
  }
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'queued' || status === 'pending') {
    if (jobState === null) return status;
    if (jobState === 'succeeded') return 'succeeded';
    if (jobState === 'cancelled') return 'expired';
    if (jobState === 'failed' || jobState === 'skipped') return 'failed';
    return 'queued';
  }
  return 'failed';
}

function isDbConstraintError(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.includes(code);
}

function readGlobalIntervalHours(db: Database): number {
  const row = db.$client
    .prepare('SELECT default_interval_hours AS hours FROM settings WHERE id = 1')
    .get() as { hours: number } | undefined;
  return row?.hours ?? 24;
}

function toStreamStatusRow(stream: StreamRow): StreamStatusRow {
  return {
    kind: stream.kind as StreamStatusRow['kind'],
    branchId: stream.branchId,
    initialized: stream.initializedAt !== null,
    detectedChangeAt: isoUtc(stream.detectedChangeAt),
    lastSuccessAt: isoUtc(stream.lastSuccessAt),
    lastAttemptAt: isoUtc(stream.lastAttemptAt),
    lastErrorCode: stream.lastErrorCode,
    nextDueAt: isoUtc(stream.nextDueAt),
  };
}

export class RepositoryService {
  readonly #deps: RepositoryDomainDeps;

  constructor(deps: RepositoryDomainDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------------------ 导入

  /**
   * 创建导入批次。
   *
   * 在 `BEGIN IMMEDIATE` 短事务内检查 `count + new <= 999` 并预留占位行；
   * 占位行同样占用名额（`verification_state='pending'`、`github_id` 为 NULL、
   * `canonical_name` 为规范化小写键、`reserved_until = now + 24h`），并为每项创建
   * `kind='metadata'`、`queue_class='initialization'`、`origin='import'` 的任务。
   * 与已有 / 批内重复的规范键不重复占名额，逐项记“已存在”。
   * 返回计数：accepted=新建预留行数；rejected=未受理行数（格式错误或容量不足）；
   * overflow=超过单批 999 行的行数（不再解析）。
   */
  importBatch(rawInput: string, acceptedAuthVersion: number | null): ImportBatchResult {
    const db = this.#deps.db;
    const now = this.#deps.now();
    const rows = splitRepositoryInputRows(rawInput, MAX_IMPORT_ROWS);

    let groupId = 0;
    let accepted = 0;
    let rejected = 0;
    let overflow = 0;

    withImmediateTransaction(db, () => {
      const insertedGroup = db
        .insert(jobGroups)
        .values({ kind: 'repository_import', createdAt: now })
        .returning({ id: jobGroups.id })
        .all();
      groupId = insertedGroup[0]?.id ?? 0;
      if (groupId === 0) throw new Error('创建导入批次失败');

      const countRow = db.$client
        .prepare('SELECT COUNT(*) AS count FROM repositories')
        .get() as { count: number };
      let reservedCount = countRow.count;
      const seen = new Map<string, number>();

      for (const row of rows) {
        if (row.overflow) {
          this.#insertGroupItem(groupId, row.index, row.raw, null, null, 'failed', 'REPOSITORY_LIMIT_REACHED');
          overflow += 1;
          continue;
        }
        const parsed = row.result;
        if (parsed === null || !parsed.ok) {
          const errorCode: string = parsed === null ? 'INVALID_FORMAT' : parsed.error;
          this.#insertGroupItem(groupId, row.index, row.raw, null, null, 'failed', errorCode);
          rejected += 1;
          continue;
        }

        const value = parsed.value;
        const existingId = seen.get(value.key) ?? this.#findRepositoryIdByKey(value.key);
        if (existingId !== undefined) {
          seen.set(value.key, existingId);
          this.#insertGroupItem(groupId, row.index, row.raw, existingId, null, 'skipped', 'REPOSITORY_ALREADY_EXISTS');
          continue;
        }

        if (reservedCount >= REPOSITORY_LIMIT) {
          this.#insertGroupItem(groupId, row.index, row.raw, null, null, 'failed', 'REPOSITORY_LIMIT_REACHED');
          rejected += 1;
          continue;
        }

        try {
          const repoId = this.#reservePlaceholder(value, now);
          const intervalMs = repositoryIntervalMs(db, { intervalHours: null });
          const created = createStreamWithInitializationJob(
            db,
            this.#deps.queue,
            {
              repoId,
              kind: 'metadata',
              branchId: null,
              configRevision: 1,
              phaseSeedBase: repoId,
              intervalMs,
              origin: 'import',
              acceptedAuthVersion,
            },
            now,
          );
          this.#insertGroupItem(groupId, row.index, row.raw, repoId, created?.jobId ?? null, 'queued', null);
          seen.set(value.key, repoId);
          accepted += 1;
          reservedCount += 1;
        } catch (error) {
          // 触发器只是并发兜底；事务内检查已先行，这里按“数量超限”逐项反馈。
          if (isDbConstraintError(error, 'REPOSITORY_LIMIT_REACHED')) {
            this.#insertGroupItem(groupId, row.index, row.raw, null, null, 'failed', 'REPOSITORY_LIMIT_REACHED');
            rejected += 1;
            continue;
          }
          throw error;
        }
      }
    });

    return { groupId, accepted, rejected, overflow };
  }

  #reservePlaceholder(value: { owner: string; repo: string; key: string; htmlUrl: string }, now: number): number {
    const inserted = this.#deps.db
      .insert(repositories)
      .values({
        githubId: null,
        canonicalName: value.key,
        displayName: null,
        note: null,
        description: null,
        htmlUrl: value.htmlUrl,
        ownerAvatarUrl: null,
        isPrivate: false,
        language: null,
        stars: 0,
        forks: 0,
        archived: false,
        enabled: true,
        blockedReason: null,
        pinOrder: null,
        intervalHours: null,
        releaseEnabled: true,
        includePrereleases: false,
        defaultBranch: null,
        verificationState: 'pending',
        reservedUntil: now + IMPORT_RESERVATION_TIMEOUT_MS,
        identityVerifiedAt: null,
        identityRevision: 1,
        displayRevision: 1,
        collectionRevision: 1,
        editRevision: 1,
        createdAt: now,
      })
      .returning({ id: repositories.id })
      .all();
    const repoId = inserted[0]?.id;
    if (repoId === undefined) throw new Error('预留仓库占位失败');
    return repoId;
  }

  /**
   * 按规范化小写键查找已有仓库。
   *
   * 必须大小写不敏感：占位行存的是小写键，而验证成功后 `canonical_name`
   * 会被改写成 GitHub 返回的显示大小写（如 `Owner/Repo`），直接用 `=` 比较会漏掉。
   */
  #findRepositoryIdByKey(key: string): number | undefined {
    const row = this.#deps.db.$client
      .prepare('SELECT id FROM repositories WHERE lower(canonical_name) = ? LIMIT 1')
      .get(key) as { id: number } | undefined;
    return row?.id;
  }

  #insertGroupItem(
    groupId: number,
    inputIndex: number,
    input: string,
    repoId: number | null,
    jobId: number | null,
    status: string,
    errorCode: string | null,
  ): void {
    this.#deps.db
      .insert(jobGroupItems)
      .values({ groupId, inputIndex, normalizedInput: input, repoId, jobId, status, errorCode })
      .run();
  }

  /** 导入批次进度（GET /admin/repository-imports/:id）；只读投影，不产生写入副作用。 */
  importProgress(groupId: number): ImportProgressRow | null {
    const db = this.#deps.db;
    const group = db.select().from(jobGroups).where(eq(jobGroups.id, groupId)).get();
    if (group === undefined) return null;

    const rows = db.$client
      .prepare(
        `SELECT i.input_index, i.normalized_input, i.repo_id, i.status, i.error_code,
                j.state AS job_state, j.error_code AS job_error_code
           FROM job_group_items i
           LEFT JOIN jobs j ON j.id = i.job_id
          WHERE i.group_id = ?
          ORDER BY i.input_index`,
      )
      .all(groupId) as {
      input_index: number;
      normalized_input: string | null;
      repo_id: number | null;
      status: string;
      error_code: string | null;
      job_state: string | null;
      job_error_code: string | null;
    }[];

    const items: ImportItemRow[] = rows.map((row) => ({
      index: row.input_index,
      input: row.normalized_input ?? '',
      status: importItemStatusOf(row.error_code, row.status, row.job_state, row.job_error_code),
      errorCode: row.error_code ?? row.job_error_code,
      repoId: row.repo_id === null ? null : publicRepoId(row.repo_id),
    }));
    const finished = group.finishedAt !== null || items.every((item) => item.status !== 'pending' && item.status !== 'queued');
    return { state: finished ? 'finished' : 'running', total: items.length, items };
  }

  /**
   * 启动与周期清理：释放超时占位。
   * 删除 `verification_state='pending'` 且 `reserved_until < now` 的占位行，
   * 把对应 `job_group_items` 记为 failed/IMPORT_EXPIRED，并取消其未开始任务。
   */
  releaseExpiredReservations(): number {
    const db = this.#deps.db;
    const now = this.#deps.now();
    const expired = db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.verificationState, 'pending'),
          isNotNull(repositories.reservedUntil),
          lt(repositories.reservedUntil, now),
        ),
      )
      .all();

    let released = 0;
    for (const candidate of expired) {
      withImmediateTransaction(db, () => {
        const fresh = db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.id, candidate.id),
              eq(repositories.verificationState, 'pending'),
              isNotNull(repositories.reservedUntil),
              lt(repositories.reservedUntil, now),
            ),
          )
          .get();
        if (fresh === undefined) return;

        db.update(jobGroupItems)
          .set({ status: 'failed', errorCode: 'IMPORT_EXPIRED' })
          .where(and(eq(jobGroupItems.repoId, candidate.id), inArray(jobGroupItems.status, ['pending', 'queued'])))
          .run();
        // 未开始任务（导入 metadata 任务等）取消；已领取任务由回调的存在性检查保护。
        db.update(jobs)
          .set({ state: 'cancelled', finishedAt: now })
          .where(
            and(
              inArray(jobs.state, ['queued', 'retry_wait']),
              sql`(${jobs.id} IN (SELECT job_id FROM job_group_items WHERE repo_id = ${candidate.id})
                   OR ${jobs.streamId} IN (SELECT id FROM monitor_streams WHERE repo_id = ${candidate.id}))`,
            ),
          )
          .run();
        db.delete(repositories)
          .where(
            and(
              eq(repositories.id, candidate.id),
              eq(repositories.verificationState, 'pending'),
              lt(repositories.reservedUntil, now),
            ),
          )
          .run();
        released += 1;
      });
    }
    return released;
  }

  // ------------------------------------------------------------------ 读取

  /** 仓库可编辑配置 + 各流状态（对应 GET /admin/repositories/:id）。 */
  detail(repoId: number): RepositoryDetailRow | null {
    const db = this.#deps.db;
    const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (repo === undefined) return null;

    const streams = db
      .select()
      .from(monitorStreams)
      .where(eq(monitorStreams.repoId, repoId))
      .orderBy(asc(monitorStreams.id))
      .all();
    const branches = branchConfigRows(db, repoId);
    // 与公开列表/聚合状态同口径：与默认分支重名的固定分支不参与"启用流"判定，
    // 否则它永远未成功的 lastSuccessAt 会让详情页 lastCheckedAt 恒为 null。
    const branchEnabled = collectableBranchIds(branches);

    const labelRows = db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(repositoryLabels)
      .innerJoin(labels, eq(labels.id, repositoryLabels.labelId))
      .where(eq(repositoryLabels.repoId, repoId))
      .orderBy(asc(labels.name))
      .all();
    const trends = db
      .select({ day: dailyMetrics.day, stars: dailyMetrics.stars, forks: dailyMetrics.forks })
      .from(dailyMetrics)
      .where(eq(dailyMetrics.repoId, repoId))
      .orderBy(asc(dailyMetrics.day))
      .all();

    // 仓库汇总 lastCheckedAt 取所有启用采集流最近成功时间的最小值；任一流从未成功为 null。
    const enabledStreams = streams.filter((stream) => {
      if (stream.kind === 'branch') return stream.branchId !== null && branchEnabled.has(stream.branchId);
      if (stream.kind === 'release') return repo.releaseEnabled;
      if (stream.kind === 'prerelease') return repo.releaseEnabled && repo.includePrereleases;
      return true;
    });
    let lastCheckedAt: number | null = null;
    if (enabledStreams.length > 0 && enabledStreams.every((stream) => stream.lastSuccessAt !== null)) {
      lastCheckedAt = Math.min(...enabledStreams.map((stream) => stream.lastSuccessAt ?? 0));
    }

    return {
      id: publicRepoId(repo.id),
      fullName: repo.canonicalName,
      displayName: repo.displayName,
      note: repo.note,
      description: repo.description,
      url: repo.htmlUrl,
      htmlUrl: repo.htmlUrl,
      isPrivate: repo.isPrivate,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      archived: repo.archived,
      enabled: repo.enabled,
      blockedReason: repo.blockedReason,
      intervalHours: repo.intervalHours,
      releaseEnabled: repo.releaseEnabled,
      includePrereleases: repo.includePrereleases,
      defaultBranch: repo.defaultBranch,
      pinOrder: repo.pinOrder,
      labels: labelRows.map((row) => ({
        id: publicLabelId(row.id),
        name: row.name,
        color: row.color,
      })),
      branches,
      streams: streams.map(toStreamStatusRow),
      trends,
      editRevision: repo.editRevision,
      displayRevision: repo.displayRevision,
      collectionRevision: repo.collectionRevision,
      identityRevision: repo.identityRevision,
      verificationState: repo.verificationState as RepositoryVerificationState,
      identityVerifiedAt: isoUtc(repo.identityVerifiedAt),
      createdAt: isoUtc(repo.createdAt) ?? new Date(repo.createdAt).toISOString(),
      lastCheckedAt: isoUtc(lastCheckedAt),
    };
  }

  /**
   * 当前页管理补充数据（GET /admin/repository-controls），一次最多 100 个 ID。
   * 只返回已存在的行；能力字段仅用于 UI，门禁未就绪时调用方应统一置 false。
   */
  controls(ids: readonly number[]): ControlRow[] {
    if (ids.length > MAX_BATCH_IDS) {
      throw validationFailed({ ids: `一次最多读取 ${MAX_BATCH_IDS} 个 ID` });
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];

    const db = this.#deps.db;
    const repoRows = db.select().from(repositories).where(inArray(repositories.id, unique)).all();
    const byId = new Map(repoRows.map((repo) => [repo.id, repo]));

    const streamRows = db.select().from(monitorStreams).where(inArray(monitorStreams.repoId, unique)).all();
    const streamsByRepo = new Map<number, StreamRow[]>();
    for (const stream of streamRows) {
      const list = streamsByRepo.get(stream.repoId);
      if (list === undefined) streamsByRepo.set(stream.repoId, [stream]);
      else list.push(stream);
    }
    const branchRows = db
      .select({
        id: trackedBranches.id,
        repoId: trackedBranches.repoId,
        mode: trackedBranches.mode,
        resolvedName: trackedBranches.resolvedName,
        enabled: trackedBranches.enabled,
      })
      .from(trackedBranches)
      .where(inArray(trackedBranches.repoId, unique))
      .all();
    // 参与聚合的"有效分支"按运行时口径派生：与默认分支重名的固定分支被排除了，
    // 不能直接使用原始 enabled=1 集合，否则会把重复分支的错误拖进仓库状态。
    const activityByRepo = new Map<number, BranchActivityRow[]>();
    for (const branch of branchRows) {
      const list = activityByRepo.get(branch.repoId);
      if (list === undefined) activityByRepo.set(branch.repoId, [branch]);
      else list.push(branch);
    }
    const jobStates = this.#activeJobStates(unique);
    const globalHours = readGlobalIntervalHours(db);
    const now = this.#deps.now();

    const out: ControlRow[] = [];
    for (const id of unique) {
      const repo = byId.get(id);
      if (repo === undefined) continue;
      const streams = streamsByRepo.get(id) ?? [];
      const intervalMs = (repo.intervalHours ?? globalHours) * HOUR_MS;
      const status = aggregateRepositoryStatus({
        enabled: repo.enabled,
        blockedReason: repo.blockedReason,
        verificationState: repo.verificationState,
        releaseEnabled: repo.releaseEnabled,
        includePrereleases: repo.includePrereleases,
        intervalMs,
        now,
        streams,
        enabledBranchIds: collectableBranchIds(activityByRepo.get(id) ?? []),
      });
      out.push({
        id: repo.id,
        editRevision: repo.editRevision,
        enabled: repo.enabled,
        paused: !repo.enabled,
        status,
        verificationState: repo.verificationState as RepositoryVerificationState,
        jobState: jobStates.get(id) ?? 'idle',
        capabilities: {
          canCheck: repo.verificationState === 'verified' && repo.blockedReason === null,
          canPause: repo.enabled,
          canResume: !repo.enabled,
          canRemove: true,
          canEdit: true,
        },
      });
    }
    return out;
  }

  #activeJobStates(repoIds: readonly number[]): Map<number, RepositoryJobState> {
    const result = new Map<number, RepositoryJobState>();
    if (repoIds.length === 0) return result;
    const rows = this.#deps.db.$client
      .prepare(
        `SELECT s.repo_id AS repo_id, j.state AS state
           FROM jobs j
           JOIN monitor_streams s ON s.id = j.stream_id
          WHERE j.state IN ('queued', 'running', 'retry_wait')
            AND s.repo_id IN (${repoIds.map(() => '?').join(',')})`,
      )
      .all(...repoIds) as { repo_id: number; state: 'queued' | 'running' | 'retry_wait' }[];
    for (const row of rows) {
      const current = result.get(row.repo_id);
      if (current === undefined || (current !== 'running' && row.state === 'running')) {
        result.set(row.repo_id, row.state);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ 编辑

  /** 单仓 PATCH。白名单字段之外的服务器维护字段不接受，也不会被写回。 */
  patch(repoId: number, patch: RepositoryPatchInput): void {
    if (patch.editRevision === undefined || patch.editRevision === null) {
      throw new AppError('REVISION_REQUIRED', '缺少 editRevision');
    }
    if (patch.displayName !== undefined && patch.displayName !== null && [...patch.displayName].length > MAX_DISPLAY_NAME_LENGTH) {
      throw validationFailed({ displayName: `别名最多 ${MAX_DISPLAY_NAME_LENGTH} 个字符` });
    }
    if (patch.note !== undefined && patch.note !== null && [...patch.note].length > MAX_NOTE_LENGTH) {
      throw validationFailed({ note: `备注最多 ${MAX_NOTE_LENGTH} 个字符` });
    }
    if (patch.intervalHours !== undefined && patch.intervalHours !== null && !(INTERVAL_OPTIONS as readonly number[]).includes(patch.intervalHours)) {
      throw validationFailed({ intervalHours: '档位只能是 3/6/12/24 或 null（继承全局）' });
    }
    const labelIds = patch.labelIds;
    if (labelIds !== undefined) {
      const seen = new Set<number>();
      for (const id of labelIds) {
        if (!Number.isInteger(id) || id <= 0) throw validationFailed({ labelIds: '包含非法的标签 ID' });
        if (seen.has(id)) throw validationFailed({ labelIds: '包含重复的标签 ID' });
        seen.add(id);
      }
      if (labelIds.length > MAX_LABELS_PER_REPO) {
        throw new AppError('LABEL_LIMIT_REACHED', `每仓最多 ${MAX_LABELS_PER_REPO} 个标签`);
      }
    }

    const db = this.#deps.db;
    const now = this.#deps.now();
    const editRevision = patch.editRevision;

    withImmediateTransaction(db, () => {
      const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
      if (repo === undefined) throw new AppError('NOT_FOUND', '仓库不存在');
      if (repo.editRevision !== editRevision) {
        throw new AppError('REVISION_CONFLICT', '仓库配置已被其他编辑修改，请刷新后重试');
      }

      // 先原子递增编辑版本（条件更新即版本比较）；后续字段更新在同一写事务内进行。
      const claimed = db
        .update(repositories)
        .set({ editRevision: sql`${repositories.editRevision} + 1` })
        .where(and(eq(repositories.id, repoId), eq(repositories.editRevision, editRevision)))
        .run();
      if (claimed.changes === 0) {
        throw new AppError('REVISION_CONFLICT', '仓库配置已被其他编辑修改，请刷新后重试');
      }

      const next: Partial<typeof repositories.$inferInsert> = {};
      let displayRevisionBumped = false;
      if (patch.displayName !== undefined) {
        next.displayName = patch.displayName;
        displayRevisionBumped = true;
      }
      if (patch.note !== undefined) {
        next.note = patch.note;
        displayRevisionBumped = true;
      }
      if (displayRevisionBumped) {
        next.displayRevision = repo.displayRevision + 1;
      }

      const releaseEnabledNow = patch.releaseEnabled ?? repo.releaseEnabled;
      const includePrereleasesNow = patch.includePrereleases ?? repo.includePrereleases;
      let collectionRevision = repo.collectionRevision;
      const bumpCollectionRevision = (): number => {
        collectionRevision += 1;
        next.collectionRevision = collectionRevision;
        return collectionRevision;
      };

      // Release 开关：关闭时停用正式与预发布流；重新开启按新基线重建（不生成更新提示）。
      // 同一次 PATCH 可能同时改档位，新建流按生效后的档位计算相位。
      const effectiveRepo = patch.intervalHours === undefined ? repo : { ...repo, intervalHours: patch.intervalHours };
      if (patch.releaseEnabled !== undefined && patch.releaseEnabled !== repo.releaseEnabled) {
        next.releaseEnabled = patch.releaseEnabled;
        if (patch.releaseEnabled) {
          const revision = bumpCollectionRevision();
          this.#createAuxiliaryStream(effectiveRepo, 'release', revision, now);
          if (includePrereleasesNow) this.#createAuxiliaryStream(effectiveRepo, 'prerelease', revision, now);
        } else {
          this.#deleteAuxiliaryStreams(repoId, ['release', 'prerelease'], now);
        }
      }

      // 预发布开关：只初始化 / 只清除预发布流，正式流不受影响。
      if (patch.includePrereleases !== undefined && patch.includePrereleases !== repo.includePrereleases) {
        next.includePrereleases = patch.includePrereleases;
        if (patch.includePrereleases && releaseEnabledNow) {
          const revision = collectionRevision === repo.collectionRevision ? bumpCollectionRevision() : collectionRevision;
          this.#createAuxiliaryStream(effectiveRepo, 'prerelease', revision, now);
        } else {
          this.#deleteAuxiliaryStreams(repoId, ['prerelease'], now);
        }
      }

      // 用户暂停开关：不清基线；暂停取消未开始的周期任务，保留已接受的单次检测。
      if (patch.enabled !== undefined && patch.enabled !== repo.enabled) {
        next.enabled = patch.enabled;
        if (!patch.enabled) {
          this.#deps.queue.cancelPeriodicFor(repoId);
        } else {
          // 恢复保留基线并错峰入队；先复验身份由 metadata 任务完成。
          this.#resumeScheduling(repoId, now);
        }
      }

      // 档位：缩短时只安排一次追赶；延长时从最近完成的轮次计算下一相位。
      if (patch.intervalHours !== undefined && patch.intervalHours !== repo.intervalHours) {
        const oldMs = (repo.intervalHours ?? readGlobalIntervalHours(db)) * HOUR_MS;
        const newMs = (patch.intervalHours ?? readGlobalIntervalHours(db)) * HOUR_MS;
        next.intervalHours = patch.intervalHours;
        if (oldMs !== newMs) this.#rescheduleForInterval(repoId, oldMs, newMs, now);
      }

      if (Object.keys(next).length > 0) {
        db.update(repositories).set(next).where(eq(repositories.id, repoId)).run();
      }

      if (labelIds !== undefined) {
        this.#replaceLabels(repoId, labelIds);
      }
    });
  }

  #createAuxiliaryStream(repo: RepoRow, kind: 'release' | 'prerelease', configRevision: number, now: number): void {
    const db = this.#deps.db;
    createStreamWithInitializationJob(
      db,
      this.#deps.queue,
      {
        repoId: repo.id,
        kind,
        branchId: null,
        configRevision,
        phaseSeedBase: repo.githubId ?? repo.id,
        intervalMs: repositoryIntervalMs(db, repo),
        origin: 'control',
      },
      now,
    );
  }

  #deleteAuxiliaryStreams(repoId: number, kinds: readonly ('release' | 'prerelease')[], now: number): void {
    const db = this.#deps.db;
    const streams = db
      .select({ id: monitorStreams.id })
      .from(monitorStreams)
      .where(and(eq(monitorStreams.repoId, repoId), inArray(monitorStreams.kind, [...kinds])))
      .all();
    for (const stream of streams) {
      cancelQueuedJobsForStream(db, stream.id, now);
    }
    db.delete(monitorStreams)
      .where(and(eq(monitorStreams.repoId, repoId), inArray(monitorStreams.kind, [...kinds])))
      .run();
  }

  /** 恢复（enabled false→true）：保留基线，metadata 流 config_revision 递增并错峰入队。 */
  #resumeScheduling(repoId: number, now: number): void {
    const db = this.#deps.db;
    // 身份失配这类系统阻塞只能由"人明确要求恢复"解除：队列对阻塞仓库过滤掉全部业务类任务
    // （含 metadata），不解阻塞时这里刚入队的 metadata 永远不会被领取，仓库会永久停在
    // 错误状态。解除后 metadata 立即复核上游身份，仍不一致时会再次 markIdentityChanged。
    db.update(repositories).set({ blockedReason: null }).where(eq(repositories.id, repoId)).run();
    const streams = db.select().from(monitorStreams).where(eq(monitorStreams.repoId, repoId)).all();
    for (const stream of streams) {
      const offset = (stream.phaseSeed % 900) * 1000;
      db.update(monitorStreams)
        .set({
          nextDueAt: now + offset,
          ...(stream.kind === 'metadata' ? { configRevision: stream.configRevision + 1 } : {}),
        })
        .where(eq(monitorStreams.id, stream.id))
        .run();
    }
    const metadata = streams.find((stream) => stream.kind === 'metadata');
    if (metadata !== undefined) {
      this.#deps.queue.enqueue({
        kind: 'metadata',
        queueClass: 'initialization',
        origin: 'control',
        dueAt: now + (metadata.phaseSeed % 900) * 1000,
        streamId: metadata.id,
        dedupeKey: `stream:${metadata.id}`,
        configRevision: metadata.configRevision + 1,
      });
    }
  }

  #rescheduleForInterval(repoId: number, oldMs: number, newMs: number, now: number): void {
    const db = this.#deps.db;
    const streams = db.select().from(monitorStreams).where(eq(monitorStreams.repoId, repoId)).all();
    for (const stream of streams) {
      if (stream.nextDueAt === null) continue;
      if (newMs < oldMs) {
        // 缩短周期且已过期：只安排一次错峰追赶，不立即突发。
        if (stream.nextDueAt <= now) {
          db.update(monitorStreams)
            .set({ nextDueAt: now + (stream.phaseSeed % 900) * 1000 })
            .where(eq(monitorStreams.id, stream.id))
            .run();
        }
        continue;
      }
      // 延长周期：从最近完成的轮次（或既有计划）计算下一相位。
      const base = stream.lastSuccessAt ?? stream.nextDueAt;
      db.update(monitorStreams)
        .set({ nextDueAt: advanceDueAt(base, newMs, now) })
        .where(eq(monitorStreams.id, stream.id))
        .run();
    }
  }

  #replaceLabels(repoId: number, labelIds: readonly number[]): void {
    const db = this.#deps.db;
    if (labelIds.length > 0) {
      const found = db.select({ id: labels.id }).from(labels).where(inArray(labels.id, [...labelIds])).all();
      if (found.length !== labelIds.length) {
        throw validationFailed({ labelIds: '包含不存在的标签 ID' });
      }
    }
    db.delete(repositoryLabels).where(eq(repositoryLabels.repoId, repoId)).run();
    for (const labelId of labelIds) {
      db.insert(repositoryLabels).values({ repoId, labelId }).run();
    }
  }

  // ------------------------------------------------------------------ 批量

  /**
   * 批量动作：逐项独立短事务，事务内同时复核会话有效性与 editRevision。
   * 部分失败不回滚其他已提交项；会话中途失效则停止后续项并标 `not_executed_auth`，
   * 若没有任何已提交项，整批按未认证处理。
   */
  applyBulk(input: BulkActionCall): BulkItemResultRow[] {
    this.#validateBulkCall(input);
    const db = this.#deps.db;
    const now = this.#deps.now();
    const labelIds = input.labelIds ?? [];

    const results: BulkItemResultRow[] = [];
    let processed = 0;
    let stopped = false;
    // 业务门禁在批内同样逐项复核：门禁在批处理期间失效时保留已提交项、停止剩余项。
    let gateOpen = this.#deps.isBusinessReady?.() ?? true;

    for (const item of input.items) {
      if (stopped) {
        results.push({ id: item.id, status: 'not_executed_auth', errorCode: null });
        continue;
      }
      if (!gateOpen) {
        results.push({ id: item.id, status: 'not_executed_setup_required', errorCode: 'GITHUB_SETUP_REQUIRED' });
        continue;
      }
      try {
        const result = withImmediateTransaction(db, () =>
          this.#applyBulkItem(input.action, item, labelIds, input.sessionAuthVersion, now),
        );
        processed += 1;
        // 提交成功后重新取一次门禁：下一项据此决定是否执行。
        gateOpen = this.#deps.isBusinessReady?.() ?? true;
        results.push(result);
      } catch (error) {
        if (error instanceof AuthRevokedSignal) {
          if (processed === 0) throw unauthenticated();
          stopped = true;
          results.push({ id: item.id, status: 'not_executed_auth', errorCode: null });
          continue;
        }
        if (isAppError(error)) {
          processed += 1;
          results.push({ id: item.id, status: 'failed', errorCode: error.code });
          continue;
        }
        throw error;
      }
    }
    return results;
  }

  #validateBulkCall(input: BulkActionCall): void {
    if (input.items.length === 0 || input.items.length > MAX_BATCH_IDS) {
      throw validationFailed({ items: `批量动作必须包含 1–${MAX_BATCH_IDS} 个仓库` });
    }
    const seen = new Set<number>();
    for (const item of input.items) {
      if (!Number.isInteger(item.id) || item.id <= 0) throw validationFailed({ items: '包含非法的仓库 ID' });
      if (!Number.isInteger(item.editRevision) || item.editRevision < 1) {
        throw validationFailed({ items: '包含非法的 editRevision' });
      }
      if (seen.has(item.id)) throw validationFailed({ items: '包含重复的仓库 ID' });
      seen.add(item.id);
    }
    if (input.action === 'add_labels' || input.action === 'remove_labels') {
      const labelIds = input.labelIds;
      if (labelIds === undefined || labelIds.length === 0) {
        throw validationFailed({ labelIds: '标签动作必须携带 labelIds' });
      }
      if (labelIds.length > MAX_LABELS_PER_REPO) {
        throw new AppError('LABEL_LIMIT_REACHED', `每仓最多 ${MAX_LABELS_PER_REPO} 个标签`);
      }
      const labelSeen = new Set<number>();
      for (const id of labelIds) {
        if (!Number.isInteger(id) || id <= 0) throw validationFailed({ labelIds: '包含非法的标签 ID' });
        if (labelSeen.has(id)) throw validationFailed({ labelIds: '包含重复的标签 ID' });
        labelSeen.add(id);
      }
    }
  }

  #applyBulkItem(
    action: BulkActionInput,
    item: BulkItemCall,
    labelIds: readonly number[],
    sessionAuthVersion: number,
    now: number,
  ): BulkItemResultRow {
    const db = this.#deps.db;
    // 事务内复核会话有效性：密码变更/撤销会递增 auth_version。
    const account = db.$client
      .prepare('SELECT auth_version AS version FROM admin_account WHERE id = 1')
      .get() as { version: number } | undefined;
    if (account === undefined || account.version !== sessionAuthVersion) {
      throw new AuthRevokedSignal();
    }

    const repo = db.select().from(repositories).where(eq(repositories.id, item.id)).get();
    if (repo === undefined) return { id: item.id, status: 'failed', errorCode: 'NOT_FOUND' };
    if (repo.editRevision !== item.editRevision) {
      return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
    }

    // 条件更新即版本比较：事务内比较并原子递增 edit_revision。
    const claim = (): boolean => {
      const updated = db
        .update(repositories)
        .set({ editRevision: sql`${repositories.editRevision} + 1` })
        .where(and(eq(repositories.id, item.id), eq(repositories.editRevision, item.editRevision)))
        .run();
      return updated.changes > 0;
    };

    switch (action) {
      case 'pause': {
        // 暂停：取消未开始的周期任务，不取消管理员明确发起的单次检测，不清基线。
        if (!claim()) return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
        db.update(repositories).set({ enabled: false }).where(eq(repositories.id, item.id)).run();
        this.#deps.queue.cancelPeriodicFor(item.id);
        return { id: item.id, status: 'ok', errorCode: null };
      }
      case 'resume': {
        // 恢复：保留基线并错峰入队，先复验身份。
        if (!claim()) return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
        db.update(repositories).set({ enabled: true }).where(eq(repositories.id, item.id)).run();
        this.#resumeScheduling(item.id, now);
        return { id: item.id, status: 'ok', errorCode: null };
      }
      case 'add_labels': {
        // 先做标签存在性与容量检查，再提交版本递增，失败项不留下已变更的 revision。
        const found = db.select({ id: labels.id }).from(labels).where(inArray(labels.id, [...labelIds])).all();
        if (found.length !== labelIds.length) {
          return { id: item.id, status: 'failed', errorCode: 'NOT_FOUND' };
        }
        const attached = new Set(
          db
            .select({ labelId: repositoryLabels.labelId })
            .from(repositoryLabels)
            .where(eq(repositoryLabels.repoId, item.id))
            .all()
            .map((row) => row.labelId),
        );
        const additions = labelIds.filter((labelId) => !attached.has(labelId));
        if (attached.size + additions.length > MAX_LABELS_PER_REPO) {
          return { id: item.id, status: 'failed', errorCode: 'LABEL_LIMIT_REACHED' };
        }
        if (!claim()) return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
        // 添加标签保留其他标签；重复标签不重复写入。
        for (const labelId of additions) {
          db.insert(repositoryLabels).values({ repoId: item.id, labelId }).run();
        }
        return { id: item.id, status: 'ok', errorCode: null };
      }
      case 'remove_labels': {
        if (!claim()) return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
        // 只删除仓库关系，不删除全局标签定义；其他标签保留。
        db.delete(repositoryLabels)
          .where(and(eq(repositoryLabels.repoId, item.id), inArray(repositoryLabels.labelId, [...labelIds])))
          .run();
        return { id: item.id, status: 'ok', errorCode: null };
      }
      case 'remove': {
        if (!claim()) return { id: item.id, status: 'conflict', errorCode: 'REVISION_CONFLICT' };
        this.#deleteLocalRepository(item.id, now);
        return { id: item.id, status: 'ok', errorCode: null };
      }
      case 'check': {
        // 单项检测带 pause_override；但身份失配/未验证仓库不执行。
        if (repo.verificationState !== 'verified' || repo.blockedReason !== null) {
          return { id: item.id, status: 'failed', errorCode: 'REPOSITORY_NOT_READY' };
        }
        this.#enqueueManualCheck(item.id, now, true);
        return { id: item.id, status: 'ok', errorCode: null };
      }
      default:
        return { id: item.id, status: 'failed', errorCode: 'VALIDATION_FAILED' };
    }
  }

  #enqueueManualCheck(repoId: number, now: number, pauseOverride: boolean): void {
    const db = this.#deps.db;
    const streams = db.select().from(monitorStreams).where(eq(monitorStreams.repoId, repoId)).all();
    const enabledBranches = new Set(
      db
        .select({ id: trackedBranches.id })
        .from(trackedBranches)
        .where(and(eq(trackedBranches.repoId, repoId), eq(trackedBranches.enabled, true)))
        .all()
        .map((row) => row.id),
    );
    for (const stream of streams) {
      if (stream.kind === 'branch' && (stream.branchId === null || !enabledBranches.has(stream.branchId))) continue;
      // 成功检查后 5 分钟内重复手动检测复用最近结果，不新增请求。
      if (stream.lastSuccessAt !== null && now - stream.lastSuccessAt < MANUAL_REUSE_WINDOW_MS) continue;
      this.#deps.queue.enqueue({
        kind: stream.kind as 'metadata' | 'release' | 'prerelease' | 'branch',
        queueClass: 'manual',
        origin: 'manual',
        dueAt: now,
        streamId: stream.id,
        dedupeKey: `stream:${stream.id}`,
        pauseOverride,
        configRevision: stream.configRevision,
      });
    }
  }

  // ------------------------------------------------------------------ 删除

  /**
   * 单仓删除（DELETE，If-Match 语义）。删除本地记录、流、缓存、趋势与未开始任务；
   * 不操作 GitHub 远程仓库。返回被删除的规范名；`job_group_items` 通过外键置 NULL 保留反馈。
   */
  remove(repoId: number, expectedEditRevision?: number): string {
    const db = this.#deps.db;
    const now = this.#deps.now();
    return withImmediateTransaction(db, () => {
      const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
      if (repo === undefined) throw new AppError('NOT_FOUND', '仓库不存在');
      if (expectedEditRevision !== undefined && repo.editRevision !== expectedEditRevision) {
        throw new AppError('REVISION_CONFLICT', '仓库配置已被其他编辑修改，请刷新后重试');
      }
      this.#deleteLocalRepository(repoId, now);
      return repo.canonicalName;
    });
  }

  #deleteLocalRepository(repoId: number, now: number): void {
    const db = this.#deps.db;
    // 未开始的队列项（含导入 metadata 任务、周期与初始化任务）取消；
    // 已领取任务允许完成，但其回调会被存在性检查挡住，不会写回已删数据。
    db.update(jobs)
      .set({ state: 'cancelled', finishedAt: now })
      .where(
        and(
          inArray(jobs.state, ['queued', 'retry_wait']),
          sql`${jobs.streamId} IN (SELECT id FROM monitor_streams WHERE repo_id = ${repoId})`,
        ),
      )
      .run();
    // 流、分支、标签关系、趋势与缓存随外键级联清理；job_group_items.repo_id 置 NULL 保留记录。
    db.delete(repositories).where(eq(repositories.id, repoId)).run();
  }

  // ------------------------------------------------------------------ 分支

  replaceBranches(repoId: number, editRevision: number, branches: readonly BranchSelectionEntry[]): void {
    replaceBranchSelection({ db: this.#deps.db, queue: this.#deps.queue, now: this.#deps.now }, repoId, editRevision, branches);
  }

  /** 本地分支缓存读取；未命中不创建任务。 */
  readAvailableBranches(repoId: number, page: number, pageSize: number): AvailableBranchesPage {
    return readAvailableBranchesPage(this.#deps.db, repoId, page, pageSize, this.#deps.now());
  }
}

export { branchConfigRows };
