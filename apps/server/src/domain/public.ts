import { and, eq, sql } from 'drizzle-orm';

import {
  CHANGE_WINDOW_DAYS,
  DAILY_METRICS_RETENTION_DAYS,
  DEFAULT_INTERVAL_HOURS,
  REPOSITORY_LIMIT,
  type RepositoryStatus,
  type RepositorySort,
} from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { dailyMetrics, labels, repositories, repositoryLabels, settings, trackedBranches } from '../db/schema.js';
import { HOUR_MS } from '../scheduler/planner.js';
import {
  collectableBranchIds,
  readAllStreams,
  readBranchProjection,
  readMetadataProjection,
  readPrereleaseProjection,
  readReleaseProjection,
  type StreamRow,
} from '../scheduler/streams.js';
import { aggregateRepositoryStatus } from './status.js';

/**
 * 公开读投影。
 *
 * - 字段白名单：id/fullName/displayName/note/description/url/ownerAvatarUrl/isPrivate/
 *   language/labels/pinned/stars/forks、发布/预发布/分支的展示字段、状态枚举、
 *   更新时间、变化时间、趋势点。没有 editRevision、canManage、任务错误原文或任何凭证信息。
 * - 只返回通过 GitHub 身份验证且未被删除的仓库；导入占位行不公开。
 * - 公开读只读本地数据库，不触发任何 GitHub 请求。
 * - 聚合状态委托 domain/status.ts 的唯一实现；lastCheckedAt 与托管详情同口径：
 *   任一启用采集流从未成功即为 null。
 */

export const PUBLIC_DTO_FIELDS = [
  'id',
  'fullName',
  'displayName',
  'note',
  'description',
  'url',
  'ownerAvatarUrl',
  'isPrivate',
  'language',
  'labels',
  'pinned',
  'stars',
  'forks',
  'status',
  'hasRecentChange',
  'lastChangeDetectedAt',
  'changeExpiresAt',
  'latestRelease',
  'recentPrerelease',
  'branches',
  'lastCheckedAt',
  'trends',
] as const;

export interface PublicRelease {
  readonly version: string;
  readonly publishedAt: string;
  readonly url: string;
}

export interface PublicPrerelease {
  readonly candidate: PublicRelease | null;
  readonly coverage: { readonly limit: number; readonly observedCount: number; readonly mayHaveMore: boolean };
}

export interface PublicBranch {
  readonly name: string;
  /** 已初始化但分支暂无提交（空基线）时为 null；前端显示“暂无提交”。 */
  readonly committedAt: string | null;
  readonly url: string;
}

export interface PublicTrendPoint {
  readonly day: string;
  readonly stars: number;
  readonly forks: number;
}

export interface PublicRepositoryView {
  readonly id: string;
  readonly fullName: string;
  readonly displayName: string | null;
  readonly note: string | null;
  readonly description: string | null;
  readonly url: string;
  readonly ownerAvatarUrl: string | null;
  readonly isPrivate: boolean;
  readonly language: string | null;
  readonly labels: string[];
  readonly pinned: boolean;
  readonly stars: number;
  readonly forks: number;
  readonly status: RepositoryStatus;
  readonly hasRecentChange: boolean;
  readonly lastChangeDetectedAt: string | null;
  readonly changeExpiresAt: string | null;
  readonly latestRelease: PublicRelease | null;
  readonly recentPrerelease: PublicPrerelease | null;
  readonly branches: PublicBranch[];
  readonly lastCheckedAt: string | null;
  readonly trends: PublicTrendPoint[];
}

export function isoUtc(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 公开 ID 是不透明字符串，内部主键不直接暴露语义。 */
export function publicRepoId(id: number): string {
  return `repo_${id}`;
}

export function parsePublicRepoId(value: string): number | null {
  const match = /^repo_(\d+)$/.exec(value);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

interface RepoRow {
  id: number;
  github_id: number | null;
  canonical_name: string;
  display_name: string | null;
  note: string | null;
  description: string | null;
  html_url: string;
  owner_avatar_url: string | null;
  is_private: number;
  language: string | null;
  stars: number;
  forks: number;
  enabled: number;
  blocked_reason: string | null;
  pin_order: number | null;
  interval_hours: number | null;
  release_enabled: number;
  include_prereleases: number;
  created_at: number;
}

function intervalMsOf(intervalHours: number | null, globalHours: number): number {
  return (intervalHours ?? globalHours) * HOUR_MS;
}

export interface PublicListOptions {
  readonly q?: string;
  readonly labels?: readonly string[];
  readonly pinned?: boolean;
  readonly changed?: boolean;
  readonly monitoring?: 'all' | 'active' | 'paused';
  readonly sort?: RepositorySort;
  /** 趋势窗口天数；列表一次返回本页仓库在该窗口内的降采样点。 */
  readonly days?: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface PublicListResult {
  readonly items: PublicRepositoryView[];
  readonly total: number;
}

export function listPublicRepositories(
  db: Database,
  options: PublicListOptions,
  now: number,
): PublicListResult {
  const settingsRow = db.select().from(settings).where(eq(settings.id, 1)).get();
  const globalHours = settingsRow?.defaultIntervalHours ?? DEFAULT_INTERVAL_HOURS;

  const rows = db.$client
    .prepare(
      `SELECT id, github_id, canonical_name, display_name, note, description, html_url,
              owner_avatar_url, is_private, language, stars, forks, enabled, blocked_reason,
              pin_order, interval_hours, release_enabled, include_prereleases, created_at
         FROM repositories
        WHERE verification_state = 'verified'
        ORDER BY id`,
    )
    .all() as RepoRow[];

  const labelRows = db
    .select({ repoId: repositoryLabels.repoId, name: labels.name })
    .from(repositoryLabels)
    .innerJoin(labels, eq(labels.id, repositoryLabels.labelId))
    .all();
  const labelsByRepo = new Map<number, string[]>();
  for (const row of labelRows) {
    const list = labelsByRepo.get(row.repoId) ?? [];
    list.push(row.name);
    labelsByRepo.set(row.repoId, list);
  }

  const pinOrders = new Map<string, number | null>(
    rows.map((row) => [publicRepoId(row.id), row.pin_order]),
  );

  // 流与分支各一次批量读入：列表在过滤/排序前要为全部已验证仓库构建视图，
  // 逐仓/逐流点查会让单次请求的成本随仓库数线性放大（N+1）。
  const streamsByRepo = new Map<number, StreamRow[]>();
  for (const stream of readAllStreams(db)) {
    const list = streamsByRepo.get(stream.repoId) ?? [];
    list.push(stream);
    streamsByRepo.set(stream.repoId, list);
  }
  const branchesByRepo = new Map<number, Map<number, typeof trackedBranches.$inferSelect>>();
  for (const branch of db.select().from(trackedBranches).all()) {
    const map = branchesByRepo.get(branch.repoId) ?? new Map<number, typeof trackedBranches.$inferSelect>();
    map.set(branch.id, branch);
    branchesByRepo.set(branch.repoId, map);
  }

  const views: PublicRepositoryView[] = [];
  for (const row of rows) {
    const streams = streamsByRepo.get(row.id) ?? [];
    const branchRows = branchesByRepo.get(row.id) ?? new Map<number, typeof trackedBranches.$inferSelect>();
    /** 分支名解析走内存中的批量结果，不再逐流回查。 */
    const branchInfo = (stream: StreamRow): { name: string } | null => {
      if (stream.branchId === null) return null;
      const branch = branchRows.get(stream.branchId);
      if (branch === undefined) return null;
      if (branch.enabled !== true) return null;
      const name = branch.resolvedName ?? branch.configuredName;
      if (name === null) return null;
      return { name };
    };
    /**
     * 只有"仍然启用"的流参与公开聚合：
     * 关闭 Release、关闭预发布或停用某个分支后，其保留的旧字段不得再影响
     * 更新标记、最近检查时间和排序。分支还要排除与默认分支重名的固定分支
     * （同一 resolved_name 只保留一个采集流）。
     */
    const collectable = collectableBranchIds(
      [...branchRows.values()].map((branch) => ({
        id: branch.id,
        mode: branch.mode,
        resolvedName: branch.resolvedName,
        enabled: branch.enabled,
      })),
    );
    const activeStreams = streams.filter((stream) => {
      if (stream.kind === 'release') return row.release_enabled === 1;
      if (stream.kind === 'prerelease') return row.release_enabled === 1 && row.include_prereleases === 1;
      if (stream.kind === 'branch') {
        return stream.branchId !== null && collectable.has(stream.branchId);
      }
      return true;
    });

    const labels0 = labelsByRepo.get(row.id) ?? [];
    const newestChange = activeStreams.reduce<number | null>((acc, stream) => {
      if (stream.detectedChangeAt === null) return acc;
      return acc === null || stream.detectedChangeAt > acc ? stream.detectedChangeAt : acc;
    }, null);

    const metadataStream = activeStreams.find((stream) => stream.kind === 'metadata') ?? null;
    const releaseStream = activeStreams.find((stream) => stream.kind === 'release') ?? null;
    const prereleaseStream = activeStreams.find((stream) => stream.kind === 'prerelease') ?? null;
    const branchStreams = activeStreams.filter((stream) => stream.kind === 'branch');

    const releaseProjection = releaseStream === null ? null : readReleaseProjection(releaseStream);
    const prereleaseProjection = prereleaseStream === null ? null : readPrereleaseProjection(prereleaseStream);
    const metadataProjection = metadataStream === null ? null : readMetadataProjection(metadataStream);

    const branches: PublicBranch[] = [];
    for (const stream of branchStreams) {
      const info = branchInfo(stream);
      if (info === null) continue;
      const projection = readBranchProjection(stream);
      /**
       * 空基线：已初始化（initialized_at 非空）且没有投影，表示该分支
       * 暂无提交——属于确定结果而不是检测失败，仍要出现在公开分支列表里，
       * 只把 committedAt 置 null（前端显示“暂无提交”）。尚未初始化的流不公开。
       */
      if (projection === null && stream.initializedAt === null) continue;
      branches.push({
        name: info.name,
        committedAt: projection?.committedAt ?? null,
        // 分支外链逐段正确编码；除非上游给出了明确可直接使用的链接。
        url: projection !== null && projection.htmlUrl !== ''
          ? projection.htmlUrl
          : `https://github.com/${row.canonical_name}/tree/${encodeURIComponent(info.name)}`,
      });
    }
    // 最近提交时间降序；未知提交时间（空基线）排在最后。
    branches.sort((a, b) => {
      if (a.committedAt === b.committedAt) return 0;
      if (a.committedAt === null) return 1;
      if (b.committedAt === null) return -1;
      return a.committedAt < b.committedAt ? 1 : -1;
    });

    const lastCheckedAt =
      activeStreams.length === 0 || activeStreams.some((stream) => stream.lastSuccessAt === null)
        ? null
        : Math.min(...activeStreams.map((stream) => stream.lastSuccessAt ?? 0));

    // 聚合状态与托管详情共用同一实现（domain/status.ts，优先级链）。
    const status = aggregateRepositoryStatus({
      enabled: row.enabled === 1,
      blockedReason: row.blocked_reason,
      verificationState: 'verified',
      releaseEnabled: row.release_enabled === 1,
      includePrereleases: row.include_prereleases === 1,
      intervalMs: intervalMsOf(row.interval_hours, globalHours),
      now,
      streams,
      enabledBranchIds: collectable,
    });

    const hasRecentChange = newestChange !== null && newestChange > now - CHANGE_WINDOW_DAYS * 24 * HOUR_MS;

    views.push({
      id: publicRepoId(row.id),
      fullName: row.canonical_name,
      displayName: row.display_name,
      note: row.note,
      description: row.description ?? metadataProjection?.description ?? null,
      url: row.html_url,
      ownerAvatarUrl: row.owner_avatar_url,
      isPrivate: row.is_private === 1,
      language: row.language ?? metadataProjection?.language ?? null,
      labels: labels0,
      pinned: row.pin_order !== null,
      stars: row.stars,
      forks: row.forks,
      status,
      hasRecentChange,
      lastChangeDetectedAt: hasRecentChange ? isoUtc(newestChange) : null,
      changeExpiresAt: hasRecentChange && newestChange !== null
        ? isoUtc(newestChange + CHANGE_WINDOW_DAYS * 24 * HOUR_MS)
        : null,
      // Release 空基线：列表可访问但没有官方 latest 时投影为 null，
      // 公开侧与“未初始化”同形——显示“暂无 Release”，不宣称从未发布过版本。
      latestRelease:
        releaseProjection === null
          ? null
          : {
              version: releaseProjection.tagName,
              publishedAt: releaseProjection.publishedAt,
              url: releaseProjection.htmlUrl,
            },
      recentPrerelease:
        prereleaseStream === null
          ? null
          : {
              candidate:
                prereleaseProjection?.candidate === null || prereleaseProjection === null
                  ? null
                  : {
                      version: prereleaseProjection.candidate.tagName,
                      publishedAt: prereleaseProjection.candidate.publishedAt,
                      url: prereleaseProjection.candidate.htmlUrl,
                    },
              coverage: {
                limit: prereleaseProjection?.windowLimit ?? 20,
                observedCount: prereleaseProjection?.observedCount ?? 0,
                mayHaveMore: prereleaseProjection?.mayHaveMore ?? false,
              },
            },
      branches,
      lastCheckedAt: isoUtc(lastCheckedAt),
      // 趋势在过滤、排序、分页后只为本页仓库加载，避免为整库做无谓查询；这里先占位。
      trends: [],
    });
  }

  const filtered = views.filter((view) => matchesFilter(view, options));
  sortViews(filtered, options.sort ?? 'default', pinOrders);
  const total = filtered.length;
  const start = (options.page - 1) * options.pageSize;
  const pageViews = filtered.slice(start, start + options.pageSize);

  const pageIds = pageViews.flatMap((view) => {
    const id = parsePublicRepoId(view.id);
    return id === null ? [] : [id];
  });
  const trendByRepo = loadTrendBuckets(db, pageIds, now, options.days ?? 30);
  const items = pageViews.map((view) => {
    const id = parsePublicRepoId(view.id);
    return { ...view, trends: id === null ? [] : (trendByRepo.get(id) ?? []) };
  });
  return { items, total };
}

function matchesFilter(view: PublicRepositoryView, options: PublicListOptions): boolean {
  if (options.monitoring === 'active' && view.status === 'paused') return false;
  if (options.monitoring === 'paused' && view.status !== 'paused') return false;
  if (options.pinned === true && !view.pinned) return false;
  if (options.pinned === false && view.pinned) return false;
  if (options.changed === true && !view.hasRecentChange) return false;
  if (options.changed === false && view.hasRecentChange) return false;
  if (options.labels !== undefined && options.labels.length > 0) {
    const wanted = new Set(options.labels);
    if (!view.labels.some((label) => wanted.has(label))) return false;
  }
  if (options.q !== undefined && options.q !== '') {
    const needle = options.q.toLowerCase();
    const haystack = [view.fullName, view.displayName ?? '', view.description ?? '', view.note ?? '']
      .join('\u0000')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function sourceActivityOf(view: PublicRepositoryView): string {
  const candidates: string[] = [];
  if (view.latestRelease !== null) candidates.push(view.latestRelease.publishedAt);
  // 空基线分支没有提交时间，不参与来源活动时间比较。
  for (const branch of view.branches) {
    if (branch.committedAt !== null) candidates.push(branch.committedAt);
  }
  if (candidates.length === 0) return '';
  return candidates.reduce((acc, value) => (value > acc ? value : acc), '');
}

/**
 * 默认排序：置顶优先 → 置顶手工顺序 → 仍在 7 天窗口内的最近发现变化时间降序
 * （到期视为 null，显式 NULLS LAST）→ 最近来源活动时间降序 → 仓库规范名 → ID。
 */
export function sortViews(
  views: PublicRepositoryView[],
  sort: RepositorySort,
  pinOrders: ReadonlyMap<string, number | null>,
): void {
  views.sort((a, b) => {
    const aPinned = a.pinned ? 0 : 1;
    const bPinned = b.pinned ? 0 : 1;
    if (aPinned !== bPinned) return aPinned - bPinned;
    if (aPinned === 0) {
      const aOrder = pinOrders.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = pinOrders.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    if (sort === 'stars') {
      if (a.stars !== b.stars) return b.stars - a.stars;
    } else if (sort === 'name') {
      if (a.fullName !== b.fullName) return a.fullName < b.fullName ? -1 : 1;
    } else if (sort === 'sourceActivity') {
      const aSource = sourceActivityOf(a);
      const bSource = sourceActivityOf(b);
      if (aSource !== bSource) return aSource < bSource ? 1 : -1;
    } else {
      // 变化时间降序，过期项视为 null 排在后面，不能让过期标记永久压住活跃仓库。
      const aChange = a.hasRecentChange ? (a.lastChangeDetectedAt ?? '') : '';
      const bChange = b.hasRecentChange ? (b.lastChangeDetectedAt ?? '') : '';
      if (aChange !== bChange) return aChange < bChange ? 1 : -1;
      const aSource = sourceActivityOf(a);
      const bSource = sourceActivityOf(b);
      if (aSource !== bSource) return aSource < bSource ? 1 : -1;
    }
    if (a.fullName !== b.fullName) return a.fullName < b.fullName ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function loadTrendBuckets(
  db: Database,
  repoIds: readonly number[],
  now: number,
  days: number,
): Map<number, PublicTrendPoint[]> {
  const result = new Map<number, PublicTrendPoint[]>();
  if (repoIds.length === 0) return result;
  const placeholders = repoIds.map(() => '?').join(',');
  // 趋势按北京时间日历日分桶，窗口起点同样按北京时间计算。
  const since = new Date(now - days * 24 * HOUR_MS + 8 * HOUR_MS).toISOString().slice(0, 10);
  const rows = db.$client
    .prepare(
      `SELECT repo_id, day, stars, forks FROM daily_metrics
        WHERE repo_id IN (${placeholders}) AND day >= ?
        ORDER BY repo_id, day`,
    )
    .all(...repoIds, since) as {
    repo_id: number;
    day: string;
    stars: number;
    forks: number;
  }[];
  for (const row of rows) {
    const list = result.get(row.repo_id) ?? [];
    list.push({ day: row.day, stars: row.stars, forks: row.forks });
    result.set(row.repo_id, list);
  }
  return result;
}

export function repositoryMetrics(
  db: Database,
  repoPublicId: string,
  days: number,
  now: number,
): PublicTrendPoint[] | null {
  const repoId = parsePublicRepoId(repoPublicId);
  if (repoId === null) return null;
  // 公开按 ID 查询时同样检查仓库已验证且未删除，不因绕过列表而暴露占位数据。
  const repo = db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, repoId), eq(repositories.verificationState, 'verified')))
    .get();
  if (repo === undefined) return null;
  const since = new Date(now - days * 24 * HOUR_MS + 8 * HOUR_MS).toISOString().slice(0, 10);
  const rows = db
    .select({ day: dailyMetrics.day, stars: dailyMetrics.stars, forks: dailyMetrics.forks })
    .from(dailyMetrics)
    .where(and(eq(dailyMetrics.repoId, repoId), sql`${dailyMetrics.day} >= ${since}`))
    .orderBy(dailyMetrics.day)
    .all();
  return rows.map((row) => ({ day: row.day, stars: row.stars, forks: row.forks }));
}

/** 公开标签只返回已验证仓库实际使用的标签。 */
export function listPublicLabels(db: Database): { id: string; name: string; color: string | null }[] {
  const rows = db.$client
    .prepare(
      `SELECT DISTINCT l.id AS id, l.name AS name, l.color AS color
         FROM labels l
         JOIN repository_labels rl ON rl.label_id = l.id
         JOIN repositories r ON r.id = rl.repo_id
        WHERE r.verification_state = 'verified'
        ORDER BY l.name`,
    )
    .all() as { id: number; name: string; color: string | null }[];
  return rows.map((row) => ({ id: `label_${row.id}`, name: row.name, color: row.color }));
}

export function publicConfig(db: Database): {
  title: string;
  discoveryEnabled: boolean;
  displayTimeZone: 'Asia/Shanghai';
  repositoryLimit: number;
} {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  return {
    title: 'Github雷达',
    discoveryEnabled: row?.discoveryEnabled ?? false,
    displayTimeZone: 'Asia/Shanghai',
    repositoryLimit: REPOSITORY_LIMIT,
  };
}

/** 前台状态标记：只说明初始化或数据陈旧，不输出 Token 原因、到期时间或配额。 */
export function publicOverallState(db: Database, now: number): 'ready' | 'initializing' | 'stale' {
  const verified = db
    .select({ count: sql<number>`COUNT(*) AS count` })
    .from(repositories)
    .where(eq(repositories.verificationState, 'verified'))
    .get();
  if ((verified?.count ?? 0) === 0) return 'initializing';
  const stale = db.$client
    .prepare(
      `SELECT COUNT(*) AS count FROM monitor_streams s
         JOIN repositories r ON r.id = s.repo_id
        WHERE r.verification_state = 'verified'
          AND s.initialized_at IS NOT NULL
          AND s.last_success_at < ?`,
    )
    .get(now - 2 * 24 * HOUR_MS) as { count: number };
  return (stale.count ?? 0) === 0 ? 'ready' : 'stale';
}

export function purgeOldMetricsByRetention(db: Database, now: number): number {
  // 趋势按北京时间日历日分桶，保留期下界与 loadTrendBuckets 的
  // 窗口起点一致：+8h 后再取日期，不能直接用 UTC 日。
  const since = new Date(now - DAILY_METRICS_RETENTION_DAYS * 24 * HOUR_MS + 8 * HOUR_MS)
    .toISOString()
    .slice(0, 10);
  return db.delete(dailyMetrics).where(sql`${dailyMetrics.day} < ${since}`).run().changes;
}
