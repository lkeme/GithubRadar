import type { Database } from '../db/client.js';
import type { SqliteDatabase } from '../db/open.js';
import { DAILY_TREND_STATS_NOTE, TRENDS_MAX_PAGE } from '@githubradar/contracts';

import { isTrendReportStale, runTrendsImport, type TrendsImportResult } from './importer.js';
import { TRENDS_SOURCE_REPOSITORY, trendCommitUrl, type TrendsApiAccess } from './manifest.js';
import type { Transport } from '../integrations/transport/index.js';

/**
 * 每日趋势读取。
 *
 * 只读本地数据库：不发网络请求、不写状态。缺省回落到最新一份报告，
 * 指定日期不存在时同样回落到最新，并在 `meta.day` 里返回实际使用的日期。
 */

export const DEFAULT_TRENDS_PAGE_SIZE = 30;
export const MAX_TRENDS_PAGE_SIZE = 100;

export interface TrendsQuery {
  readonly day?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface TrendItemView {
  readonly rank: number;
  readonly fullName: string;
  readonly url: string;
  readonly stars: number;
  readonly domain: string | null;
  readonly previousRank: number | null;
}

export interface TrendSourceView {
  readonly repository: typeof TRENDS_SOURCE_REPOSITORY;
  readonly commit: string;
  readonly commitUrl: string;
  readonly importedAt: string;
  readonly stale: boolean;
  readonly note: string;
}

export interface TrendsPage {
  readonly items: readonly TrendItemView[];
  readonly day: string | null;
  readonly days: readonly string[];
  /** 当前报告之前是否还有更早的报告（决定 `previousRank` 是否有意义）。 */
  readonly hasPrevious: boolean;
  readonly total: number;
  readonly source: TrendSourceView | null;
}

interface RunRow {
  readonly id: number;
  readonly report_day: string;
  readonly source_commit: string;
  readonly imported_at: number;
}

export function readTrends(db: Database, query: TrendsQuery, now: number): TrendsPage {
  const sqlite = db.$client;
  // 分页值参与 `(page - 1) * pageSize` 后直接绑定给 LIMIT/OFFSET：
  // 超出安全整数会被 better-sqlite3 当成非法绑定值抛错，因此这里必须独立收口，
  // 不能只依赖路由层的契约校验。
  const page = Number.isSafeInteger(query.page) && query.page >= 1 ? Math.min(query.page, TRENDS_MAX_PAGE) : 1;
  const pageSize =
    Number.isSafeInteger(query.pageSize) && query.pageSize >= 1
      ? Math.min(MAX_TRENDS_PAGE_SIZE, query.pageSize)
      : DEFAULT_TRENDS_PAGE_SIZE;

  return sqlite.transaction((): TrendsPage => {
    const days = (sqlite.prepare('SELECT report_day FROM daily_trend_runs ORDER BY report_day DESC').all() as {
      report_day: string;
    }[]).map((row) => row.report_day);
    if (days.length === 0) {
      return { items: [], day: null, days: [], hasPrevious: false, total: 0, source: null };
    }

    const requested = query.day !== undefined && days.includes(query.day) ? query.day : (days[0] as string);
    const run = sqlite
      .prepare('SELECT id, report_day, source_commit, imported_at FROM daily_trend_runs WHERE report_day = ?')
      .get(requested) as RunRow;

    const previous = days.find((day) => day < run.report_day) ?? null;
    const previousRanks = previous === null ? new Map<string, number>() : rankMap(sqlite, previous);

    const totalRow = sqlite
      .prepare('SELECT COUNT(*) AS n FROM daily_trend_items WHERE run_id = ?')
      .get(run.id) as { n: number };
    const rows = sqlite
      .prepare(
        `SELECT rank, full_name, html_url, stars, domain
           FROM daily_trend_items WHERE run_id = ?
          ORDER BY rank ASC
          LIMIT ? OFFSET ?`,
      )
      .all(run.id, pageSize, (page - 1) * pageSize) as {
      rank: number;
      full_name: string;
      html_url: string;
      stars: number;
      domain: string | null;
    }[];

    return {
      items: rows.map((row) => ({
        rank: row.rank,
        fullName: row.full_name,
        url: row.html_url,
        stars: row.stars,
        domain: row.domain,
        previousRank: previousRanks.get(row.full_name) ?? null,
      })),
      day: run.report_day,
      days,
      hasPrevious: previous !== null,
      total: totalRow.n,
      source: {
        repository: TRENDS_SOURCE_REPOSITORY,
        commit: run.source_commit,
        commitUrl: trendCommitUrl(run.source_commit),
        importedAt: iso(run.imported_at),
        stale: isTrendReportStale(days[0] ?? null, now),
        note: DAILY_TREND_STATS_NOTE,
      },
    };
  })();
}

/** 上一份报告里「仓库 → 名次」；同一天重复出现时保留最好名次。 */
function rankMap(sqlite: SqliteDatabase, day: string): Map<string, number> {
  const rows = sqlite
    .prepare(
      `SELECT i.full_name AS name, MIN(i.rank) AS rank
         FROM daily_trend_items i
         JOIN daily_trend_runs r ON r.id = i.run_id
        WHERE r.report_day = ?
        GROUP BY i.full_name`,
    )
    .all(day) as { name: string; rank: number }[];
  return new Map(rows.map((row) => [row.name, row.rank]));
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 每日趋势以端口形式接入公开路由与调度器，便于在模块缺失时整体降级。
 * 与发现模块不同，这里没有开关：来源固定、读取失败只影响本页。
 */
export interface TrendsPort {
  read(query: TrendsQuery, now: number): TrendsPage;
  /** 导入由调度器按每日窗口触发；结果由调度器调用 recordAttempt 记录。 */
  import(): Promise<TrendsImportResult>;
  recordAttempt(result: TrendsImportResult): void;
  status(now: number): TrendsStatus;
}

/** 导入状态：与发现模块同构，用于管理端诊断"数据陈旧"还是"抓取一直失败"。 */
export interface TrendsStatus {
  /** 最近一次真实失败仍未被后续成功清掉时为 anomaly。 */
  readonly state: 'idle' | 'anomaly';
  readonly lastErrorCode: string | null;
  readonly lastAttemptAt: number | null;
  readonly lastFailureAt: number | null;
  readonly nextRunAt: number | null;
  readonly latestDay: string | null;
  readonly daysCount: number;
  readonly stale: boolean;
}

export class TrendsAdapter implements TrendsPort {
  readonly #db: Database;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #access: TrendsApiAccess | undefined;

  constructor(deps: {
    db: Database;
    transport: Transport;
    now: () => number;
    access?: TrendsApiAccess;
  }) {
    this.#db = deps.db;
    this.#transport = deps.transport;
    this.#now = deps.now;
    this.#access = deps.access;
  }

  read(query: TrendsQuery, now: number): TrendsPage {
    return readTrends(this.#db, query, now);
  }

  import(): Promise<TrendsImportResult> {
    return runTrendsImport({
      db: this.#db,
      transport: this.#transport,
      now: this.#now,
      ...(this.#access === undefined ? {} : { access: this.#access }),
    });
  }

  /**
   * 最近一次导入尝试的结论。
   *
   * 报告只在「有内容」时落库，因此"每天都在失败"从表里看不出来——与发现模块一样
   * 需要单独记录结论，管理端才能把"数据陈旧"和"抓取一直失败"分开说明。
   */
  status(now: number): TrendsStatus {
    const row = this.#db.$client
      .prepare(
        `SELECT trends_last_attempt_state AS state, trends_last_attempt_error AS error_code,
                trends_last_attempt_at AS at, trends_next_run_at AS next_run_at,
                trends_last_failure_error AS failure_error, trends_last_failure_at AS failure_at,
                (SELECT MAX(report_day) FROM daily_trend_runs) AS latest_day,
                (SELECT COUNT(*) FROM daily_trend_runs) AS days_count
           FROM settings WHERE id = 1`,
      )
      .get() as
      | {
          state: string | null;
          error_code: string | null;
          at: number | null;
          next_run_at: number | null;
          failure_error: string | null;
          failure_at: number | null;
          latest_day: string | null;
          days_count: number;
        }
      | undefined;
    const latestDay = row?.latest_day ?? null;
    // 判定用「最近一次失败」而不是「最近一次尝试」：一次 skipped（清单没变）不能把
    // 之前持续失败的结论抹掉，否则界面会把"天天失败"显示成"上次成功"。
    return {
      state: row?.failure_at !== null && row?.failure_at !== undefined ? 'anomaly' : 'idle',
      lastErrorCode: row?.failure_error ?? null,
      lastAttemptAt: row?.at ?? null,
      lastFailureAt: row?.failure_at ?? null,
      nextRunAt: row?.next_run_at ?? null,
      latestDay,
      daysCount: row?.days_count ?? 0,
      stale: isTrendReportStale(latestDay, now),
    };
  }

  /**
   * 由调度器在导入结束后调用（失败不影响导入本身）。
   *
   * 两个维度分开记：`state/at` 是本次尝试的结论，`failure_*` 只记录最近一次真实失败。
   * 两者都需要——只留前者时，紧跟其后的 skipped 会覆盖失败结论。
   */
  recordAttempt(result: TrendsImportResult): void {
    const now = this.#now();
    try {
      if (result.state === 'failed') {
        this.#db.$client
          .prepare(
            `UPDATE settings
                SET trends_last_attempt_state = ?, trends_last_attempt_error = ?, trends_last_attempt_at = ?,
                    trends_last_failure_error = ?, trends_last_failure_at = ?
              WHERE id = 1`,
          )
          .run(result.state, result.errorCode, now, result.errorCode ?? 'SERVICE_UNAVAILABLE', now);
        return;
      }
      this.#db.$client
        .prepare(
          `UPDATE settings
              SET trends_last_attempt_state = ?, trends_last_attempt_error = NULL, trends_last_attempt_at = ?
            WHERE id = 1`,
        )
        .run(result.state, now);
      // 只有**真正抓取并全部成功**才清除历史失败标记：
      // skipped 表示"清单没变、什么都没做"，它不能证明上游已恢复。
      if (result.state === 'published' && result.failedDays.length === 0) {
        this.#db.$client
          .prepare('UPDATE settings SET trends_last_failure_error = NULL, trends_last_failure_at = NULL WHERE id = 1')
          .run();
      }
    } catch {
      // 记录失败不影响导入结论本身。
    }
  }
}
