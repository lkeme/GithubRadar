import type { Database } from '../db/client.js';
import {
  DiscoveryError,
  readActiveDiscovery,
  runDiscoveryImport,
  type DiscoveryApiAccess,
  type DiscoveryImportResult,
  type DiscoveryItemRecord,
  type DiscoverySourceInfo,
} from '../discovery/index.js';
import type { Transport } from '../integrations/transport/index.js';
import type { DiscoveryAttemptState, DiscoveryPort, DiscoveryReadLogger, DiscoveryReadResult, DiscoveryStatus } from './public-routes.js';

/**
 * 发现模块到公开 API 的适配。
 */

/** 代次行状态 → 对外的尝试结论：staging 仍在写、failed 需要管理员介入、其余视为已发布。 */
function attemptState(runState: string | null): DiscoveryAttemptState {
  if (runState === 'staging') return 'running';
  if (runState === 'failed') return 'anomaly';
  return 'idle';
}

export interface DiscoveryAdapterDeps {
  readonly db: Database;
  readonly transport: Transport;
  readonly now: () => number;
  readonly isEnabled: () => boolean;
  /**
   * 上游 API 访问：commits/trees 请求共用 PAT 配额（带授权头并回报
   * x-ratelimit-*），raw 下载在门禁关闭时中止。由装配层注入。
   */
  readonly access: DiscoveryApiAccess;
}

export class DiscoveryAdapter implements DiscoveryPort {
  readonly #deps: DiscoveryAdapterDeps;

  constructor(deps: DiscoveryAdapterDeps) {
    this.#deps = deps;
  }

  isEnabled(): boolean {
    return this.#deps.isEnabled();
  }

  read(
    query: { q?: string; language?: string; category?: string; page: number; pageSize: number },
    log?: DiscoveryReadLogger,
  ): DiscoveryReadResult | null {
    if (!this.isEnabled()) return null;
    try {
      const page = readActiveDiscovery(this.#deps.db, query);
      // 监视状态一次查完（见 monitoredGithubIds），不给每个条目单独发 SELECT。
      const monitored = monitoredGithubIds(this.#deps.db, page.items.map((item) => item.githubId));
      return {
        items: page.items.map((item) => toPublicItem(item, monitored)),
        total: page.total,
        source: page.source === null ? null : toPublicSource(page.source),
        filters: page.filters,
      };
    } catch (error) {
      // 开关关闭（防手改数据库的防御分支）是正常状态，安静返回 null；
      // 其余错误必须留下痕迹，否则调用方只能给出一个没有原因的 502。
      if (error instanceof DiscoveryError && error.code === 'FEATURE_DISABLED') return null;
      log?.warn({ code: error instanceof DiscoveryError ? error.code : null, err: error }, 'discovery read failed');
      return null;
    }
  }

  status(): DiscoveryStatus {
    if (!this.isEnabled()) {
      return { enabled: false, state: 'disabled', lastSuccessAt: null, itemsCount: null, nextRunAt: null, lastAttempt: null };
    }
    // 活跃代次给出已发布数据；最近一次尝试（按 started_at）给出失败原因——
    // 只有“已发布代次”时状态永远看不出导入是否一直在失败。
    const row = this.#deps.db.$client
      .prepare(
        `SELECT s.discovery_next_run_at AS next_run_at,
                (SELECT COUNT(*) FROM discovery_items i WHERE i.run_id = s.active_discovery_run_id) AS items,
                a.completed_at AS active_completed_at,
                l.state AS last_state, l.error_code AS last_error_code, l.completed_at AS last_completed_at
           FROM settings s
           LEFT JOIN discovery_runs a ON a.id = s.active_discovery_run_id AND a.state = 'active'
           LEFT JOIN discovery_runs l
             ON l.id = (SELECT id FROM discovery_runs ORDER BY started_at DESC, id DESC LIMIT 1)
          WHERE s.id = 1`,
      )
      .get() as
      | {
          next_run_at: number | null;
          items: number | null;
          active_completed_at: number | null;
          last_state: string | null;
          last_error_code: string | null;
          last_completed_at: number | null;
        }
      | undefined;

    if (row === undefined) {
      return { enabled: true, state: 'idle', lastSuccessAt: null, itemsCount: null, nextRunAt: null, lastAttempt: null };
    }
    return {
      enabled: true,
      state: attemptState(row.last_state),
      lastSuccessAt: row.active_completed_at,
      itemsCount: row.items ?? 0,
      nextRunAt: row.next_run_at,
      lastAttempt:
        row.last_state === null
          ? null
          : {
              state: attemptState(row.last_state),
              errorCode: row.last_error_code,
              finishedAt: row.last_completed_at,
            },
    };
  }

  /** 由调度器在每日窗口调用；返回结果用于诊断，不自动加入监控。 */
  async import(): Promise<DiscoveryImportResult> {
    return runDiscoveryImport({
      db: this.#deps.db,
      transport: this.#deps.transport,
      now: this.#deps.now,
      access: this.#deps.access,
    });
  }
}

/**
 * 一页内所有条目的监视状态一次查完：逐条 `SELECT` 是典型的 N+1。
 * 占位符分批构造，避免一次绑定超过 SQLite 的参数上限。
 */
function monitoredGithubIds(db: Database, githubIds: readonly number[]): Set<number> {
  const monitored = new Set<number>();
  const unique = [...new Set(githubIds)];
  const BATCH_SIZE = 500;
  for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
    const batch = unique.slice(offset, offset + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db.$client
      .prepare(`SELECT github_id FROM repositories WHERE github_id IN (${placeholders})`)
      .all(...batch) as { github_id: number }[];
    for (const row of rows) {
      monitored.add(row.github_id);
    }
  }
  return monitored;
}

function toPublicItem(item: DiscoveryItemRecord, monitored: ReadonlySet<number>): unknown {
  return {
    githubId: String(item.githubId),
    fullName: item.canonicalName,
    url: item.htmlUrl,
    description: item.description,
    language: item.language,
    // 分类 CSV 的 stars/forks 是来源快照，采样时间未知，不当实时值展示。
    sourceStars: item.sourceStars,
    sourceForks: item.sourceForks,
    domains: item.domains,
    topics: item.topics,
    categories: item.categories,
    statsSampledAt: isoOrNull(item.statsSampledAt),
    firstSeen: item.firstSeen,
    monitored: monitored.has(item.githubId),
  };
}

function toPublicSource(source: DiscoverySourceInfo): unknown {
  return {
    repository: source.repository,
    commit: source.commit,
    commitUrl: source.commitUrl,
    importedAt: isoOrNull(source.importedAt),
    sourceUpdatedAt: isoOrNull(source.sourceUpdatedAt),
    fileNames: source.fileNames,
    stale: source.stale,
    note: source.note,
  };
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
