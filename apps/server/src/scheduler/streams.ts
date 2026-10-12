import { and, eq, isNull, sql } from 'drizzle-orm';

import { DEFAULT_INTERVAL_HOURS, PRERELEASE_WINDOW_LIMIT } from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { dailyMetrics, monitorStreams, repositories, trackedBranches } from '../db/schema.js';
import type { CredentialService } from '../credentials/service.js';
import { verifyUserToken } from '../credentials/verify.js';
import { GithubClient, buildPath, type GithubGetSpec } from '../integrations/github/client.js';
import {
  BranchHeadProjection,
  MetadataProjection,
  PrereleaseProjection,
  ReleaseProjection,
  parseBranchHead,
  parseLatestRelease,
  parseMetadata,
  parseReleaseWindow,
} from '../integrations/github/projections.js';
import { probeProxy } from '../integrations/transport/index.js';
import type { Transport } from '../integrations/transport/index.js';
import type { GithubProjection, GithubProjectionContext } from '../integrations/github/client.js';
import type { RateBudget } from './budget.js';
import { HOUR_MS, phaseSeedFor } from './planner.js';
import type { JobQueue, JobRow } from './queue.js';

/**
 * 采集执行。
 *
 * 语义要点：
 * - 每个采集流独立拥有 `initialized_at`，不能用 SHA 是否非空判断是否初始化。
 * - 每轮先完成 metadata 身份门禁，再执行该仓库的 Release / 分支任务；
 *   每次 metadata 成功都核对 github_id，ID 变化立即暂停该仓库全部流。
 * - 一次检测中某流失败不阻止其他流独立提交成功结果。
 * - 出站前、提交时都复核业务门禁；门禁变化后旧响应不写业务状态、趋势或业务缓存。
 */

export const STREAM_KINDS = ['metadata', 'release', 'prerelease', 'branch'] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

export function shanghaiDay(now: number): string {
  return new Date(now + 8 * HOUR_MS).toISOString().slice(0, 10);
}

export interface StreamRow {
  readonly id: number;
  readonly repoId: number;
  readonly kind: StreamKind;
  readonly branchId: number | null;
  readonly initializedAt: number | null;
  readonly projectionJson: string | null;
  readonly detectedChangeAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly configRevision: number;
  readonly nextDueAt: number | null;
}

function toStreamRow(row: typeof monitorStreams.$inferSelect): StreamRow {
  return {
    id: row.id,
    repoId: row.repoId,
    kind: row.kind as StreamKind,
    branchId: row.branchId,
    initializedAt: row.initializedAt,
    projectionJson: row.currentProjectionJson,
    detectedChangeAt: row.detectedChangeAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorCode: row.lastErrorCode,
    configRevision: row.configRevision,
    nextDueAt: row.nextDueAt,
  };
}

export function readStream(db: Database, streamId: number): StreamRow | null {
  const row = db.select().from(monitorStreams).where(eq(monitorStreams.id, streamId)).get();
  return row === undefined ? null : toStreamRow(row);
}

/** 一次读入全部采集流（公开列表等整库批量场景），避免逐流点查造成 N+1。 */
export function readAllStreams(db: Database): StreamRow[] {
  return db.select().from(monitorStreams).all().map(toStreamRow);
}

/**
 * 基线状态机。返回新的投影与变化时间：
 * - 未初始化且拿到确定结果 → 保存基线与初始化时间，**不提示更新**；
 * - 已初始化且相同 → 只更新时间，不延长变化标记；
 * - 已初始化且不同 → 按类型比较后保存并设置变化时间。
 */
export function applyBaseline<T extends { readonly id: string } | { readonly sha: string }>(
  stream: StreamRow,
  incoming: T,
  now: number,
): { projectionJson: string; detectedChangeAt: number | null; initialized: boolean; changed: boolean } {
  const serialized = JSON.stringify(incoming);
  if (stream.initializedAt === null) {
    return { projectionJson: serialized, detectedChangeAt: null, initialized: true, changed: false };
  }
  const previous = readProjectionKey(stream.projectionJson);
  const next = identityKey(incoming);
  if (previous !== null && previous === next) {
    return {
      projectionJson: serialized,
      detectedChangeAt: stream.detectedChangeAt,
      initialized: true,
      changed: false,
    };
  }
  return { projectionJson: serialized, detectedChangeAt: now, initialized: true, changed: true };
}

function identityKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['sha'] === 'string') return `sha:${record['sha']}`;
  if (typeof record['tagName'] === 'string') return `rel:${String(record['id'])}:${record['tagName']}`;
  if (typeof record['id'] === 'string') return `id:${record['id']}`;
  return null;
}

function readProjectionKey(json: string | null): string | null {
  if (json === null) return null;
  try {
    return identityKey(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}

export interface SchedulerDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly budget: RateBudget;
  readonly client: GithubClient;
  readonly transport: Transport;
  readonly credentials: CredentialService;
  readonly now: () => number;
  /** 启动恢复需要清理超时导入占位。 */
  readonly repositoryService: { releaseExpiredReservations(): number };
  /** 可选发现导入；关闭或未接线时为 null。 */
  readonly discovery?: { import(): Promise<unknown> } | null;
  /** 每日趋势导入；未接线时为 null。只声明调度需要的两个成员，避免调度层依赖趋势模块。 */
  readonly trends?:
    | {
        import(): Promise<unknown>;
        recordAttempt(result: { state: string; errorCode: string | null }): void;
      }
    | null;
}

export interface StreamTarget {
  readonly stream: StreamRow;
  readonly repoId: number;
  readonly fullName: string;
  readonly branchName: string | null;
}

export interface BranchActivityRow {
  readonly id: number;
  readonly mode: string;
  readonly resolvedName: string | null;
  readonly enabled: boolean;
}

/**
 * 实际参与采集的分支：同一 `resolved_name` 只保留一个采集流，
 * 默认跟随优先。
 *
 * 这里是**运行时派生**而不是改写 `enabled`：默认分支改名撞上某个固定分支时，
 * 该固定分支只是暂停参与采集；默认分支再改成别的名字后自动恢复，
 * 用户配置的 `enabled` 不会被系统悄悄改掉。
 */
export function collectableBranchIds(rows: readonly BranchActivityRow[]): Set<number> {
  const defaultName = rows.find((row) => row.mode === 'default')?.resolvedName ?? null;
  const ids = new Set<number>();
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.mode === 'fixed' && defaultName !== null && row.resolvedName === defaultName) continue;
    ids.add(row.id);
  }
  return ids;
}

export function branchActivity(db: Database, repoId: number): BranchActivityRow[] {
  return db
    .select({
      id: trackedBranches.id,
      mode: trackedBranches.mode,
      resolvedName: trackedBranches.resolvedName,
      enabled: trackedBranches.enabled,
    })
    .from(trackedBranches)
    .where(eq(trackedBranches.repoId, repoId))
    .all();
}

export function loadStreamTarget(db: Database, streamId: number): StreamTarget | null {
  const stream = readStream(db, streamId);
  if (stream === null) return null;
  const repo = db.select().from(repositories).where(eq(repositories.id, stream.repoId)).get();
  if (repo === undefined) return null;
  let branchName: string | null = null;
  if (stream.branchId !== null) {
    const collectable = collectableBranchIds(branchActivity(db, stream.repoId));
    if (!collectable.has(stream.branchId)) return null;
    const branch = db.select().from(trackedBranches).where(eq(trackedBranches.id, stream.branchId)).get();
    branchName = branch?.resolvedName ?? branch?.configuredName ?? null;
  }
  return { stream, repoId: stream.repoId, fullName: repo.canonicalName, branchName };
}

// ---------------------------------------------------------------------------- 投影读取

export function readMetadataProjection(stream: StreamRow): MetadataProjection | null {
  if (stream.projectionJson === null) return null;
  try {
    return MetadataProjection.parse(JSON.parse(stream.projectionJson) as unknown) as MetadataProjection;
  } catch {
    return null;
  }
}

export function readBranchProjection(stream: StreamRow): BranchHeadProjection | null {
  if (stream.projectionJson === null) return null;
  try {
    return BranchHeadProjection.parse(JSON.parse(stream.projectionJson) as unknown) as BranchHeadProjection;
  } catch {
    return null;
  }
}

export function readReleaseProjection(stream: StreamRow): ReleaseProjection | null {
  if (stream.projectionJson === null) return null;
  try {
    return ReleaseProjection.parse(JSON.parse(stream.projectionJson) as unknown) as ReleaseProjection;
  } catch {
    return null;
  }
}

export function readPrereleaseProjection(stream: StreamRow): PrereleaseProjection | null {
  if (stream.projectionJson === null) return null;
  try {
    return PrereleaseProjection.parse(JSON.parse(stream.projectionJson) as unknown) as PrereleaseProjection;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- 目标解析

export interface StreamRequestSpec {
  readonly spec: GithubGetSpec<unknown>;
  readonly parse: (payload: unknown, context: GithubProjectionContext) => unknown;
  readonly identityFields: readonly string[];
}

export function buildStreamSpec(
  client: GithubClient,
  target: StreamTarget,
  credentialRevision: number,
  token: string | null,
): StreamRequestSpec | null {
  const { stream, fullName } = target;
  const pathParams = { owner: fullName.split('/')[0] ?? '', repo: fullName.split('/')[1] ?? '' };
  const repoPath = buildPath('/repos/{owner}/{repo}', pathParams);

  const common = { repoId: target.repoId, credentialRevision, token };
  switch (stream.kind) {
    case 'metadata':
      return {
        spec: { ...common, path: repoPath, projection: { parse: (payload) => parseMetadataForRepo(payload) } },
        parse: (payload) => parseMetadataForRepo(payload),
        identityFields: ['id', 'fullName'],
      };
    case 'release':
      return {
        spec: {
          ...common,
          path: `${repoPath}/releases/latest`,
          projection: { parse: (payload) => parseLatestRelease(payload, fullName) },
        },
        parse: (payload) => parseLatestRelease(payload, fullName),
        identityFields: ['id', 'tagName'],
      };
    case 'prerelease':
      return {
        spec: {
          ...common,
          path: `${repoPath}/releases`,
          query: { per_page: String(PRERELEASE_WINDOW_LIMIT), page: '1' },
          projection: releaseWindowProjection(fullName),
        },
        parse: (payload, context) => parseReleaseWindowProjection(payload, fullName, context.nextLink !== null),
        identityFields: ['candidate'],
      };
    case 'branch': {
      if (target.branchName === null) return null;
      const branch = target.branchName;
      return {
        spec: {
          ...common,
          path: `${repoPath}/commits`,
          query: { sha: branch, per_page: '1' },
          projection: { parse: (payload) => parseBranchHead(payload, fullName, branch) },
        },
        parse: (payload) => parseBranchHead(payload, fullName, branch),
        identityFields: ['sha'],
      };
    }
    default:
      return null;
  }
  void client;
}

/**
 * 仓库改名跟随：200 响应可能是 301 重定向后的新名，
 * 名字与请求名不一致是合法场景，数字 ID 核对由 runner 的提交路径负责。
 * 这里只保留结构校验，不再校验 full_name 与请求名一致。
 */
function parseMetadataForRepo(payload: unknown): MetadataProjection {
  return parseMetadata(payload);
}

/**
 * release 列表窗口投影：预发布流与 latest 404 的同轮确认共用同一 endpoint 契约。
 * `mayHaveMore` 同时考虑「列表恰好覆盖窗口上限」与「存在 Link rel="next"」（不跟随翻页）。
 */
export function releaseWindowProjection(fullName: string): GithubProjection<PrereleaseProjection> {
  return {
    parse: (payload, context) =>
      parseReleaseWindow(payload, fullName, PRERELEASE_WINDOW_LIMIT, context.nextLink !== null),
  };
}

function parseReleaseWindowProjection(payload: unknown, fullName: string, hasNext: boolean): unknown {
  return parseReleaseWindow(payload, fullName, PRERELEASE_WINDOW_LIMIT, hasNext);
}

// ---------------------------------------------------------------------------- 提交结果

export function commitStreamSuccess(
  db: Database,
  stream: StreamRow,
  incoming: unknown,
  now: number,
  nextDueAt: number,
): { changed: boolean } {
  const baseline = applyBaseline(
    stream,
    incoming as { readonly id: string } | { readonly sha: string },
    now,
  );
  const commit = db.$client.transaction(() => {
    db.update(monitorStreams)
      .set({
        initializedAt: now,
        currentProjectionJson: baseline.projectionJson,
        detectedChangeAt: baseline.detectedChangeAt,
        lastSuccessAt: now,
        lastAttemptAt: now,
        lastErrorCode: null,
        nextDueAt,
      })
      .where(eq(monitorStreams.id, stream.id))
      .run();
  });
  commit();
  return { changed: baseline.changed };
}

/**
 * 预发布窗口的基线判定。
 *
 * 与分支/Release 不同：候选移出窗口只表示「窗口内无预发布」，不判定它被删除或转正式，
 * 也**不刷新 7 天标记**。因此不能复用通用的 identityKey —— 那会把「没有候选」
 * 当成一次状态变化，导致变化标记被每轮检查不断续期。
 */
export function applyPrereleaseBaseline(
  stream: StreamRow,
  incoming: PrereleaseProjection,
  now: number,
): { projectionJson: string; detectedChangeAt: number | null; initialized: boolean; changed: boolean } {
  const serialized = JSON.stringify(incoming);
  if (stream.initializedAt === null) {
    return { projectionJson: serialized, detectedChangeAt: null, initialized: true, changed: false };
  }
  const previous = readPrereleaseProjection(stream)?.candidate ?? null;
  const next = incoming.candidate;
  if (next === null) {
    return {
      projectionJson: serialized,
      detectedChangeAt: stream.detectedChangeAt,
      initialized: true,
      changed: false,
    };
  }
  const same = previous !== null && previous.id === next.id && previous.tagName === next.tagName;
  return {
    projectionJson: serialized,
    detectedChangeAt: same ? stream.detectedChangeAt : now,
    initialized: true,
    changed: !same,
  };
}

export function commitPrereleaseSuccess(
  db: Database,
  stream: StreamRow,
  projection: PrereleaseProjection,
  now: number,
  nextDueAt: number,
): { changed: boolean } {
  const baseline = applyPrereleaseBaseline(stream, projection, now);
  db.update(monitorStreams)
    .set({
      initializedAt: now,
      currentProjectionJson: baseline.projectionJson,
      detectedChangeAt: baseline.detectedChangeAt,
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastErrorCode: null,
      nextDueAt,
    })
    .where(eq(monitorStreams.id, stream.id))
    .run();
  return { changed: baseline.changed };
}

export function commitStreamNotModified(
  db: Database,
  stream: StreamRow,
  now: number,
  nextDueAt: number,
): void {
  db.update(monitorStreams)
    .set({ lastSuccessAt: now, lastAttemptAt: now, lastErrorCode: null, nextDueAt })
    .where(eq(monitorStreams.id, stream.id))
    .run();
  // 304 同样证明仓库可访问且身份未变：release/branch 的身份门禁要求
  // `identity_verified_at` 在 24 小时内，而该时间只在 metadata 200 时写入。
  // 安静仓库（Star/描述长期不变）的 metadata 会一直命中 304，若不在这里续期，
  // 门禁必然过期，Release/分支会永远停在"每 5 秒重排但不出站"。
  //
  // 但"304"本身只说明缓存校验器有效，不是身份核对：续期前要求缓存投影里的数字 ID
  // 与当前记录的 github_id 一致（投影缺失/损坏则不续期，让 200 路径重新核对）。
  if (stream.kind === 'metadata') {
    const projection = readMetadataProjection(stream);
    if (projection !== null && /^\d+$/.test(projection.id) && Number.isSafeInteger(Number(projection.id))) {
      const repo = db
        .select({ githubId: repositories.githubId })
        .from(repositories)
        .where(eq(repositories.id, stream.repoId))
        .get();
      if (repo !== undefined && repo.githubId !== null && String(repo.githubId) === projection.id) {
        db.update(repositories)
          .set({ identityVerifiedAt: now })
          .where(eq(repositories.id, stream.repoId))
          .run();
      }
    }
  }
}

/**
 * 写入「确定为空」的基线。
 *
 * 适用场景：latest 经列表确认没有正式发布、真实空仓库/空分支的 commits 为空。
 * 空基线没有身份键，必须走本显式写入点，不能交给通用 identityKey 判定（理由见 applyPrereleaseBaseline）。
 *
 * `detectedChangeAt` 只在状态确实发生变化时记录一次：
 * 此前有投影、现在确定为空 → 设为 now；本来就是空基线 → 保留原值不刷新。
 */
export function commitEmptyBaseline(db: Database, stream: StreamRow, now: number, nextDueAt: number): void {
  db.update(monitorStreams)
    .set({
      initializedAt: now,
      currentProjectionJson: null,
      detectedChangeAt: stream.projectionJson !== null ? now : stream.detectedChangeAt,
      lastSuccessAt: now,
      lastAttemptAt: now,
      lastErrorCode: null,
      nextDueAt,
    })
    .where(eq(monitorStreams.id, stream.id))
    .run();
}

export function commitStreamFailure(
  db: Database,
  stream: StreamRow,
  errorCode: string,
  now: number,
  retryAt: number | null,
): void {
  // 失败不覆盖基线、不标记成功、不当作空结果，也不删除已有更新标记。
  db.update(monitorStreams)
    .set({
      lastAttemptAt: now,
      lastErrorCode: errorCode,
      lastErrorAt: now,
      nextDueAt: retryAt,
    })
    .where(eq(monitorStreams.id, stream.id))
    .run();
}

/**
 * 记录一次失败尝试，但**不动基线与周期计划**。
 *
 * 用于 5xx 退避重试与凭证失效这类"本轮还会继续、但已知失败"的情况
 * （已知失败要即时显示轻量异常状态，而不是等到 stale 阈值或者下一轮结束）。
 */
export function commitStreamAttemptError(
  db: Database,
  stream: StreamRow,
  errorCode: string,
  now: number,
): void {
  db.update(monitorStreams)
    .set({ lastAttemptAt: now, lastErrorCode: errorCode, lastErrorAt: now })
    .where(eq(monitorStreams.id, stream.id))
    .run();
}

// ---------------------------------------------------------------------------- 流清单维护

/**
 * 保证仓库拥有必需的采集流。新增流不产生更新提示：`initialized_at` 为空即可。
 * 默认分支用跟随模式，其它分支用固定名称模式。
 */
export function ensureStreams(db: Database, repoId: number, now: number): void {
  const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) return;

  const upsertStream = (kind: StreamKind, branchId: number | null, seedSource: number): void => {
    const existing = branchId === null
      ? db
          .select({ id: monitorStreams.id })
          .from(monitorStreams)
          .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.kind, kind), isNull(monitorStreams.branchId)))
          .get()
      : db
          .select({ id: monitorStreams.id })
          .from(monitorStreams)
          .where(and(eq(monitorStreams.repoId, repoId), eq(monitorStreams.kind, kind), eq(monitorStreams.branchId, branchId)))
          .get();
    if (existing !== undefined) return;
    const seed = phaseSeedFor(seedSource + (branchId ?? 0) * 31 + kind.length);
    db.insert(monitorStreams)
      .values({
        repoId,
        kind,
        branchId,
        phaseSeed: seed,
        configRevision: repo.collectionRevision,
        // 新建流的首轮检查按确定性小错峰尽快执行（单仓首次初始化的
        // 3–4 个请求应在秒级完成）——不能用周期相位 initialDueAt，那会把首轮
        // 推迟到最长一个整周期之后（24 小时档即最长 24 小时），仓库长期停在
        // "部分完成"。首轮成功后的下一次到期由 advanceDueAt 按周期推进，
        // 大批量导入时各流的完成时间自然拉开，相位仍然分散。
        nextDueAt: now + (seed % 10) * 1000,
      })
      .run();
  };

  const seedSource = repo.githubId ?? repo.id;
  upsertStream('metadata', null, seedSource);
  if (repo.releaseEnabled) {
    upsertStream('release', null, seedSource);
    if (repo.includePrereleases) upsertStream('prerelease', null, seedSource);
  }
  const branches = db
    .select()
    .from(trackedBranches)
    .where(and(eq(trackedBranches.repoId, repoId), eq(trackedBranches.enabled, true)))
    .all();
  for (const branch of branches) {
    upsertStream('branch', branch.id, seedSource);
  }
}

function intervalMsFor(intervalHours: number | null): number {
  return (intervalHours ?? 24) * HOUR_MS;
}

export function streamIntervalMs(db: Database, repoId: number): number {
  const row = db
    .select({ intervalHours: repositories.intervalHours })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .get();
  const globalRow = db.$client.prepare('SELECT default_interval_hours AS hours FROM settings WHERE id = 1').get() as
    | { hours: number }
    | undefined;
  return intervalMsFor(row?.intervalHours ?? globalRow?.hours ?? DEFAULT_INTERVAL_HOURS);
}

/** 记录 metadata 成功后的 Star/Fork 趋势；同日多次检查只保留当日最后一次有效观察。 */
export function recordDailyMetric(
  db: Database,
  repoId: number,
  stars: number,
  forks: number,
  now: number,
): void {
  const day = shanghaiDay(now);
  db.insert(dailyMetrics)
    .values({ repoId, day, stars, forks, sampledAt: now, verifiedAt: now })
    .onConflictDoUpdate({
      target: [dailyMetrics.repoId, dailyMetrics.day],
      set: { stars, forks, sampledAt: now, verifiedAt: now },
    })
    .run();
}

/**
 * 身份失配：立即暂停该仓库全部流并递增采集 revision。
 *
 * 只写系统故障字段 `blocked_reason`，**不动用户的 `enabled` 开关**：
 * 两者混用会让公开看板把系统故障显示成"用户暂停"，并给管理员一个点了也没用的"恢复"按钮。
 */
export function markIdentityChanged(db: Database, repoId: number, now: number): void {
  db.update(repositories)
    .set({
      blockedReason: 'REPOSITORY_IDENTITY_CHANGED',
      collectionRevision: sql`${repositories.collectionRevision} + 1`,
      identityRevision: sql`${repositories.identityRevision} + 1`,
    })
    .where(eq(repositories.id, repoId))
    .run();
  db.update(monitorStreams).set({ nextDueAt: null, lastErrorCode: 'REPOSITORY_IDENTITY_CHANGED', lastErrorAt: now }).where(eq(monitorStreams.repoId, repoId)).run();
}

/** 处理控制类任务（PAT 验证、候选代理测试）。 */
export async function executeControlJob(
  deps: SchedulerDeps,
  job: JobRow,
): Promise<{ ok: boolean; errorCode: string | null }> {
  if (job.kind === 'token_verify') {
    // 候选操作任务的特征是 dedupeKey=operation:<id>。pending_operations 随发起会话
    // 级联删除后 operation_id 被 FK 置 NULL——此时绝不能串到"活动凭证验证"分支
    // （那会用当前 PAT 发起一次 /user 并可能改写门禁版本）；候选已随会话销毁，安静结束。
    if (job.operationId === null && job.dedupeKey !== null && job.dedupeKey.startsWith('operation:')) {
      return { ok: true, errorCode: null };
    }
    const snapshot =
      job.operationId === null
        ? deps.credentials.beginActiveVerification()
        : deps.credentials.beginCandidateVerification(job.operationId);
    if (snapshot === null || snapshot.token === null) {
      const operation = job.operationId === null ? null : deps.credentials.readOperation(job.operationId);
      if (operation !== null && operation.status !== 'pending' && operation.status !== 'running') {
        return { ok: true, errorCode: null };
      }
      return { ok: false, errorCode: 'IMPORT_EXPIRED' };
    }
    const verification = await verifyUserToken(deps.transport, snapshot.token, deps.now);
    if (verification.rateLimit !== null) deps.budget.observe(verification.rateLimit);
    // 认证同时也确认了账户身份：预算按 account_id 归属，换同账号 PAT 不重置计费。
    deps.budget.bindAccount(verification.accountId ?? deps.credentials.status().accountId);
    // 请求期间被管理员停止（任务列表的"停止"会置空 attempt_token）：
    // 结果不再写回凭证状态，操作行已随取消收口。"停止"必须是真实生效的，不能只是界面上消失。
    if (!deps.queue.isCurrentAttempt(job)) {
      return { ok: true, errorCode: null };
    }
    if (snapshot.operationId === null) {
      deps.credentials.applyActiveVerification(snapshot, verification);
    } else {
      deps.credentials.applyCandidateVerification(snapshot.operationId, verification);
    }
    return { ok: verification.ok, errorCode: verification.errorCode };
  }

  if (job.kind === 'proxy_test') {
    if (job.operationId === null) return { ok: true, errorCode: null };
    const candidate = deps.credentials.readProxyCandidate(job.operationId);
    if (candidate === null) return { ok: false, errorCode: 'IMPORT_EXPIRED' };
    const probe = await probeProxy({
      scheme: candidate.scheme,
      host: candidate.host,
      port: candidate.port,
      username: candidate.username,
      password: candidate.password,
    });
    // 同上：被停止的测试不再应用结果（也不写候选配置）。
    if (!deps.queue.isCurrentAttempt(job)) {
      return { ok: true, errorCode: null };
    }
    const applied = deps.credentials.applyProxyResult(job.operationId, probe);
    return { ok: probe.ok && applied, errorCode: probe.ok ? null : 'PROXY_UNREACHABLE' };
  }

  return { ok: false, errorCode: 'UPSTREAM_SCHEMA_CHANGED' };
}

export function dueStreams(
  db: Database,
  now: number,
  limit: number,
): { streamId: number; repoId: number; kind: StreamKind; configRevision: number }[] {
  const rows = db.$client
    .prepare(
      `SELECT s.id AS stream_id, s.repo_id AS repo_id, s.kind AS kind, s.config_revision AS config_revision
         FROM monitor_streams s
         JOIN repositories r ON r.id = s.repo_id
        WHERE s.next_due_at IS NOT NULL
          AND s.next_due_at <= ?
          AND r.enabled = 1
          AND r.blocked_reason IS NULL
          AND r.verification_state = 'verified'
          -- 停用或与默认分支重名的固定分支不产生周期任务：它们的流保留在库里，但不该每轮被规划再跳过。
          AND (
            s.kind <> 'branch'
            OR EXISTS (
              SELECT 1 FROM tracked_branches b
               WHERE b.id = s.branch_id AND b.enabled = 1
                 AND (
                   b.mode = 'default'
                   OR NOT EXISTS (
                     SELECT 1 FROM tracked_branches d
                      WHERE d.repo_id = b.repo_id AND d.mode = 'default'
                        AND d.resolved_name IS NOT NULL AND d.resolved_name = b.resolved_name
                   )
                 )
            )
          )
          AND s.id NOT IN (
            SELECT j.stream_id FROM jobs j
             WHERE j.stream_id IS NOT NULL AND j.state IN ('queued', 'running', 'retry_wait')
          )
        ORDER BY s.next_due_at
        LIMIT ?`,
    )
    .all(now, limit) as { stream_id: number; repo_id: number; kind: StreamKind; config_revision: number }[];
  return rows.map((row) => ({
    streamId: row.stream_id,
    repoId: row.repo_id,
    kind: row.kind,
    configRevision: row.config_revision,
  }));
}
