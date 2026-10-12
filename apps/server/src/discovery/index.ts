import type { Database } from '../db/client.js';
import type { SqliteDatabase } from '../db/open.js';
import {
  SOURCE_FILES,
  SOURCE_REPOSITORY,
  SOURCE_STALE_AFTER_MS,
  SOURCE_STATS_NOTE,
  commitUrl,
  parseStoredManifest,
} from './manifest.js';

export { runDiscoveryImport } from './importer.js';
export type {
  DiscoveryImportDeps,
  DiscoveryImportResult,
  DiscoveryImportState,
} from './importer.js';
export { SOURCE_FILES, SOURCE_REPOSITORY } from './manifest.js';
export type { DiscoveryApiAccess } from './manifest.js';

/**
 * 发现模块入口。
 *
 * `settings.discovery_enabled` 由迁移 0006 固定为启用，不提供关闭入口；下面的
 * `FEATURE_DISABLED` 分支只是防御手改数据库的情形。关闭语义：导入**不访问来源、不写状态**，
 * 返回 `state: 'skipped'`；读取**抛** `DiscoveryError`；已导入的数据保留。
 * 导入过程中的来源异常主要通过 `DiscoveryImportResult.errorCode` 返回。
 */

export type DiscoveryErrorCode =
  | 'SOURCE_DATA_ANOMALY'
  | 'FEATURE_DISABLED'
  | 'UPSTREAM_SCHEMA_CHANGED'
  | 'SERVICE_UNAVAILABLE';

export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;

  constructor(code: DiscoveryErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

export interface DiscoveryQuery {
  /** 关键词，匹配规范名或描述（最多 100 字符）。 */
  readonly q?: string;
  /** 语言精确匹配。 */
  readonly language?: string;
  /** 分类精确匹配（分类 CSV 文件名，如 `RAG.csv`）；合并过的候选按全部来源文件匹配。 */
  readonly category?: string;
  /** 从 1 开始；非法值按 1 处理。 */
  readonly page: number;
  /** 默认 30，最大 100；非法值按默认处理。 */
  readonly pageSize: number;
}

export interface DiscoveryItemRecord {
  readonly githubId: number;
  readonly canonicalName: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly language: string | null;
  /** 来源记录值；采样时间未知时为 null，字段名即声明不得展示为实时 Star。 */
  readonly sourceStars: number | null;
  readonly sourceForks: number | null;
  readonly domains: readonly string[];
  readonly topics: readonly string[];
  /** 出现过的分类文件，按固定优先序；首个为主分类。 */
  readonly categories: readonly string[];
  readonly sourceFile: string;
  readonly firstSeen: string | null;
  readonly sourceCreatedAt: string | null;
  readonly statsSampledAt: number | null;
}

export interface DiscoverySourceInfo {
  readonly repository: typeof SOURCE_REPOSITORY;
  readonly commit: string;
  readonly commitUrl: string;
  /** 本系统导入时间（活跃代次 completed_at，缺省用 started_at）。 */
  readonly importedAt: number;
  /** 源数据时间；上传提交时间不可验证时为 null。 */
  readonly sourceUpdatedAt: number | null;
  /** 5 个分类文件名。 */
  readonly fileNames: readonly string[];
  /** 源数据超过 72 小时未更新（或无法验证更新时间）即为陈旧。 */
  readonly stale: boolean;
  readonly note: string;
}

/**
 * 活跃代次里实际出现过的筛选取值。
 *
 * 筛选下拉的选项必须来自整代数据，不能从当前页 30 条里猜：否则换页或筛选后
 * 选项集合会跟着变，用户既看不到自己当前选了什么，也选不到只出现在别页的语言。
 */
export interface DiscoveryFilters {
  /** 语言，按名称升序。 */
  readonly languages: readonly string[];
  /** 出现过的分类文件，按 `SOURCE_FILES` 的固定优先序。 */
  readonly categories: readonly string[];
}

export interface ActiveDiscoveryPage {
  readonly items: readonly DiscoveryItemRecord[];
  readonly total: number;
  readonly source: DiscoverySourceInfo | null;
  readonly filters: DiscoveryFilters;
}

export const DEFAULT_DISCOVERY_PAGE_SIZE = 30;
export const MAX_DISCOVERY_PAGE_SIZE = 100;

/** staging 代次被视为“已被放弃”的时限：导入本身远短于一小时。 */
export const STAGING_ABANDON_AFTER_MS = 60 * 60 * 1000;

/**
 * 清理被放弃的 staging 代次（条目随外键级联删除）。
 *
 * staging 只存在于“写入数据”与“切换活跃代次”之间，进程被强杀（OOM、SIGKILL）时
 * 不会走 `markRunFailed`，代次连同最多 2 万行条目会永久留在库内。这里按开始时间
 * 加一小时下限清理，避免误删仍在进行的导入；由调度启动恢复阶段调用（已持有租约）。
 */
export function purgeAbandonedDiscoveryRuns(db: Database, now: number): number {
  const info = db.$client
    .prepare("DELETE FROM discovery_runs WHERE state = 'staging' AND started_at < ?")
    .run(now - STAGING_ABANDON_AFTER_MS);
  return Number(info.changes);
}

interface RunRow {
  readonly id: number;
  readonly source_commit: string;
  readonly source_manifest_json: string;
  readonly state: string;
  readonly started_at: number;
  readonly completed_at: number | null;
  readonly source_updated_at: number | null;
}

interface ItemRow {
  readonly github_id: number;
  readonly canonical_name: string;
  readonly html_url: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stars: number | null;
  readonly forks: number | null;
  readonly domains_json: string | null;
  readonly topics_json: string | null;
  readonly first_seen: string | null;
  readonly source_created_at: string | null;
  readonly source_file: string;
  readonly stats_sampled_at: number | null;
}

/**
 * 读取当前活跃代次。在同一个只读事务内取 `active_run_id` + 数量 + 行 + 来源信息，
 * 防止切换代次时混读；不写状态、不发网络请求。
 *
 * 排序固定为来源 stars 降序 + 规范名 + GitHub ID（与 `discovery_items_rank_idx` 一致），
 * 分页稳定。功能关闭时抛 `DiscoveryError`（code `FEATURE_DISABLED`）。
 */
export function readActiveDiscovery(db: Database, query: DiscoveryQuery): ActiveDiscoveryPage {
  const sqlite = db.$client;
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const q = normalizeFilter(query.q, 100);
  const language = normalizeFilter(query.language, 64);
  const category = normalizeFilter(query.category, 64);

  return sqlite.transaction((): ActiveDiscoveryPage => {
    const settings = sqlite
      .prepare('SELECT discovery_enabled, active_discovery_run_id FROM settings WHERE id = 1')
      .get() as { discovery_enabled: number; active_discovery_run_id: number | null } | undefined;
    if (settings === undefined || settings.discovery_enabled !== 1) {
      throw new DiscoveryError('FEATURE_DISABLED', '发现模块已关闭');
    }
    const runId = settings.active_discovery_run_id;
    if (runId === null) return { items: [], total: 0, source: null, filters: EMPTY_FILTERS };

    const run = sqlite
      .prepare(
        `SELECT id, source_commit, source_manifest_json, state, started_at, completed_at, source_updated_at
           FROM discovery_runs WHERE id = ? AND state = 'active'`,
      )
      .get(runId) as RunRow | undefined;
    if (run === undefined) return { items: [], total: 0, source: null, filters: EMPTY_FILTERS };

    const conditions: string[] = ['run_id = ?'];
    const params: (string | number)[] = [runId];
    if (q !== null) {
      conditions.push("(canonical_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(q)}%`;
      params.push(pattern, pattern);
    }
    if (language !== null) {
      conditions.push('language = ?');
      params.push(language);
    }
    if (category !== null) {
      // source_file 是多分类时的逗号连接列表；按完整文件名匹配某一项。
      conditions.push("(',' || source_file || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${escapeLike(category)},%`);
    }
    const where = conditions.join(' AND ');

    const totalRow = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM discovery_items WHERE ${where}`)
      .get(...params) as { n: number };

    const rows = sqlite
      .prepare(
        `SELECT github_id, canonical_name, html_url, description, language, stars, forks,
                domains_json, topics_json, first_seen, source_created_at, source_file, stats_sampled_at
           FROM discovery_items WHERE ${where}
          ORDER BY stars DESC, canonical_name ASC, github_id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as ItemRow[];

    return {
      items: rows.map(mapItem),
      total: totalRow.n,
      source: sourceFromRun(run),
      filters: readFilters(sqlite, runId),
    };
  })();
}

/** 整代数据的筛选取值；与当前页无关，也不随筛选条件收敛。 */
function readFilters(sqlite: SqliteDatabase, runId: number): DiscoveryFilters {
  const languages = (
    sqlite
      .prepare(
        `SELECT DISTINCT language FROM discovery_items
          WHERE run_id = ? AND language IS NOT NULL AND language <> ''
          ORDER BY language ASC`,
      )
      .all(runId) as { language: string }[]
  ).map((row) => row.language);

  const present = new Set(
    (
      sqlite.prepare('SELECT DISTINCT source_file FROM discovery_items WHERE run_id = ?').all(runId) as {
        source_file: string;
      }[]
    ).flatMap((row) =>
      row.source_file
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  );
  // 固定优先序：同一份来源在任何一代里顺序一致，不按字典序打乱文件语义。
  const categories = SOURCE_FILES.filter((name) => present.has(name));

  return { languages, categories };
}

const EMPTY_FILTERS: DiscoveryFilters = { languages: [], categories: [] };

function mapItem(row: ItemRow): DiscoveryItemRecord {
  const categories = row.source_file
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return {
    githubId: row.github_id,
    canonicalName: row.canonical_name,
    htmlUrl: row.html_url,
    description: row.description,
    language: row.language,
    sourceStars: row.stars,
    sourceForks: row.forks,
    domains: parseJsonList(row.domains_json),
    topics: parseJsonList(row.topics_json),
    categories,
    sourceFile: categories[0] ?? row.source_file,
    firstSeen: row.first_seen,
    sourceCreatedAt: row.source_created_at,
    statsSampledAt: row.stats_sampled_at,
  };
}

function sourceFromRun(run: RunRow): DiscoverySourceInfo {
  const manifest = parseStoredManifest(run.source_manifest_json);
  const commit = manifest?.commit ?? run.source_commit;
  const fileNames = manifest !== null ? manifest.files.map((entry) => entry.name) : [...SOURCE_FILES];
  const sourceUpdatedAt = run.source_updated_at;
  return {
    repository: SOURCE_REPOSITORY,
    commit,
    commitUrl: commitUrl(commit),
    importedAt: run.completed_at ?? run.started_at,
    sourceUpdatedAt,
    fileNames,
    stale: sourceUpdatedAt === null || Date.now() - sourceUpdatedAt > SOURCE_STALE_AFTER_MS,
    note: SOURCE_STATS_NOTE,
  };
}

function parseJsonList(json: string | null): readonly string[] {
  if (json === null) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function normalizePage(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function normalizePageSize(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.min(MAX_DISCOVERY_PAGE_SIZE, Math.floor(value)) : DEFAULT_DISCOVERY_PAGE_SIZE;
}

function normalizeFilter(value: string | undefined, maxChars: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const chars = [...trimmed];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : trimmed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
