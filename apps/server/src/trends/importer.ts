import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import type { Database } from '../db/client.js';
import type { SqliteDatabase } from '../db/open.js';
import { TransportError, type Transport } from '../integrations/transport/index.js';
import {
  MAX_REPORT_FILES,
  TRENDS_PARSER_VERSION,
  TrendsSourceError,
  downloadTrendReport,
  resolveRemoteTrendReports,
  type TrendsApiAccess,
} from './manifest.js';
import { parseTrendReport, type ParsedTrendReport } from './parser.js';
import { HOUR_MS } from '../scheduler/planner.js';

/**
 * 每日趋势导入。
 *
 * 与项目发现一样按「代次」落库，但每天一份报告各自成代次，互不覆盖：
 * 报告是 Top 20 的日快照，新报告只追加当天，不删除历史日期。
 *
 * 流程：解析远程清单 → 只挑尚未导入的日期（最多 `MAX_REPORT_FILES` 天）→
 * 逐份下载与解析 → 每份在自己的短事务里写入（一份失败不影响其他日期）→
 * 全部失败才报告失败；部分成功在 `reason` 里说明失败日期。
 */

export const TRENDS_INSERT_BATCH_SIZE = 100;

export interface TrendsImportDeps {
  readonly db: Database;
  readonly transport: Transport;
  readonly now: () => number;
  readonly access?: TrendsApiAccess;
  /** 允许注入以在测试中跳过网络；键为报告日期。 */
  readonly fetchReport?: (day: string) => Promise<string>;
}

export type TrendsImportState = 'published' | 'skipped' | 'failed';

export interface TrendsImportResult {
  readonly state: TrendsImportState;
  /** 本次导入的日期（新到旧）。 */
  readonly importedDays: readonly string[];
  readonly failedDays: readonly string[];
  readonly rowsImported: number;
  readonly errorCode: string | null;
  readonly reason: string | null;
}

/** 已导入日期的快照：blob SHA 与解析版本都未变时才跳过重新下载。 */
interface ImportedReport {
  readonly blobSha: string | null;
  readonly parserVersion: number | null;
}

function readImported(sqlite: SqliteDatabase): Map<string, ImportedReport> {
  const rows = sqlite
    .prepare('SELECT report_day, source_manifest_json, parser_version FROM daily_trend_runs')
    .all() as { report_day: string; source_manifest_json: string; parser_version: number }[];
  const result = new Map<string, ImportedReport>();
  for (const row of rows) {
    let blobSha: string | null = null;
    try {
      const parsed = JSON.parse(row.source_manifest_json) as { blobSha?: unknown };
      blobSha = typeof parsed.blobSha === 'string' ? parsed.blobSha : null;
    } catch {
      blobSha = null;
    }
    result.set(row.report_day, { blobSha, parserVersion: row.parser_version });
  }
  return result;
}

/** 内容未变（同一 blob、同一解析版本）的日期不必重新下载。 */
function needsImport(imported: ImportedReport | undefined, blobSha: string): boolean {
  if (imported === undefined) return true;
  if (imported.parserVersion !== TRENDS_PARSER_VERSION) return true;
  // 旧代次没有记录 blob SHA 时按"内容未知"重新导入一次，之后就稳定了。
  if (imported.blobSha === null) return true;
  return imported.blobSha !== blobSha;
}

export async function runTrendsImport(deps: TrendsImportDeps): Promise<TrendsImportResult> {
  const sqlite = deps.db.$client;
  const startedAt = deps.now();

  let remote;
  try {
    remote = await resolveRemoteTrendReports(deps.transport, deps.access);
  } catch (error) {
    return failedResult([], errorCodeOf(error), messageOf(error));
  }

  const existing = readImported(sqlite);
  const pending = remote.files
    .filter((file) => needsImport(existing.get(file.day), file.blobSha))
    .slice(0, MAX_REPORT_FILES);
  if (pending.length === 0) {
    return {
      state: 'skipped',
      importedDays: [],
      failedDays: [],
      rowsImported: 0,
      errorCode: null,
      reason: '报告清单与已导入内容一致，未产生新数据',
    };
  }

  const fetchReport = deps.fetchReport ?? ((day: string) => downloadTrendReport(deps.transport, remote.commit, day, deps.access));
  const imported: string[] = [];
  const failedDays: string[] = [];
  const reasons: string[] = [];
  let rowsImported = 0;
  let firstErrorCode: string | null = null;
  let cancelled = false;

  for (const file of pending) {
    // 首次部署要回填上百天：门禁在下载途中断开时立即停止，剩余日期不算"失败"
    // （它们是"没来得及做"，写进 failedDays 会把主动取消表现成来源异常）。
    if (deps.access?.shouldAbort?.() === true) {
      cancelled = true;
      break;
    }
    let parsed: ParsedTrendReport;
    try {
      const text = await fetchReport(file.day);
      parsed = parseTrendReport(file.day, text);
    } catch (error) {
      failedDays.push(file.day);
      firstErrorCode ??= errorCodeOf(error);
      reasons.push(`${file.day}：${messageOf(error)}`);
      continue;
    }
    try {
      insertReport(sqlite, parsed, remote.commit, file.blobSha, startedAt);
      imported.push(file.day);
      rowsImported += parsed.rows.length;
    } catch (error) {
      failedDays.push(file.day);
      firstErrorCode ??= 'SERVICE_UNAVAILABLE';
      reasons.push(`${file.day}：写入失败（${messageOf(error)}）`);
    }
    await yieldToEventLoop();
  }

  if (imported.length === 0) {
    // 主动取消且一份都没导入：这是"没做"，不是"来源异常"。
    if (cancelled && failedDays.length === 0) {
      return {
        state: 'skipped',
        importedDays: [],
        failedDays: [],
        rowsImported: 0,
        errorCode: null,
        reason: '导入已被取消，未写入任何数据',
      };
    }
    return failedResult(failedDays, firstErrorCode ?? 'SOURCE_DATA_ANOMALY', reasons.join('；') || '没有任何报告导入成功');
  }
  return {
    state: 'published',
    importedDays: imported,
    failedDays,
    rowsImported,
    errorCode: null,
    reason:
      failedDays.length === 0
        ? (cancelled ? `已导入 ${imported.length} 天，其余日期因取消未处理` : null)
        : `已导入 ${imported.length} 天，${failedDays.length} 天失败（${reasons.join('；')}）`,
  };
}

/** 单份报告：先删同日期旧代次（重导），再整体写入，同一短事务。 */
function insertReport(
  sqlite: SqliteDatabase,
  parsed: ParsedTrendReport,
  commit: string,
  blobSha: string,
  importedAt: number,
): void {
  const write = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM daily_trend_runs WHERE report_day = ?').run(parsed.day);
    const info = sqlite
      .prepare(
        `INSERT INTO daily_trend_runs (report_day, source_commit, source_manifest_json, parser_version, imported_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.day,
        commit,
        JSON.stringify({ commit, day: parsed.day, blobSha, parserVersion: TRENDS_PARSER_VERSION }),
        TRENDS_PARSER_VERSION,
        importedAt,
      );
    const runId = Number(info.lastInsertRowid);
    const insert = sqlite.prepare(
      'INSERT INTO daily_trend_items (run_id, rank, full_name, html_url, stars, domain) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let offset = 0; offset < parsed.rows.length; offset += TRENDS_INSERT_BATCH_SIZE) {
      for (const row of parsed.rows.slice(offset, offset + TRENDS_INSERT_BATCH_SIZE)) {
        insert.run(runId, row.rank, row.fullName, row.url, row.stars, row.domain);
      }
    }
  });
  write();
}

/** 最新报告日期是否已落后当前北京时间 2 天以上。 */
export function isTrendReportStale(latestDay: string | null, now: number): boolean {
  if (latestDay === null) return true;
  // 报告日期按上游的生成时区（北京时间）解释；这里只做日历日比较，不涉及时分秒。
  const latest = Date.parse(`${latestDay}T00:00:00+08:00`);
  const current = Date.parse(`${shanghaiDayOf(now)}T00:00:00+08:00`);
  if (!Number.isFinite(latest) || !Number.isFinite(current)) return true;
  return current - latest > 2 * 24 * HOUR_MS - 1;
}

/** 毫秒时间对应的北京时间日历日（趋势模块内部使用，不引入调度模块的依赖）。 */
function shanghaiDayOf(now: number): string {
  return new Date(now + 8 * HOUR_MS).toISOString().slice(0, 10);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof TrendsSourceError) return error.code;
  if (error instanceof TransportError) return error.code;
  return 'SERVICE_UNAVAILABLE';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedResult(days: readonly string[], errorCode: string, reason: string): TrendsImportResult {
  return {
    state: 'failed',
    importedDays: [],
    failedDays: days,
    rowsImported: 0,
    errorCode,
    reason,
  };
}
