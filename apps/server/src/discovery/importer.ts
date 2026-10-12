import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import type { Database } from '../db/client.js';
import type { SqliteDatabase } from '../db/open.js';
import { TransportError, type Transport } from '../integrations/transport/index.js';
import {
  MAX_TOTAL_BYTES,
  SourceError,
  buildManifest,
  downloadSourceFiles,
  isSamePublishedData,
  missingFileNames,
  parseStoredManifest,
  resolveRemoteSource,
  serializeManifest,
  SOURCE_FILES,
  type DiscoveryApiAccess,
  type SourceManifest,
} from './manifest.js';
import {
  BAD_ROW_RATIO_DENOMINATOR,
  MAX_TOTAL_ROWS,
  parseCategoryCsv,
  type ParsedCandidate,
  type ParsedFile,
} from './parser.js';

/**
 * 可选发现导入编排。
 *
 * 流程：检查开关 → 解析来源 manifest（commit + 5 个 blob SHA）→ 与活跃代次比对后
 * 决定是否跳过下载 → 流式解析 5 个分类文件 → 按 GitHub ID 去重合并分类 →
 * 超限确定性截断 → 写入新 run 的 staging 数据 → 短事务切换活跃代次 → 删除旧代次数据。
 *
 * 失败时：不发布新代次、保留旧代次可读，中间数据被清理；结果通过
 * `DiscoveryImportResult.errorCode` 返回，`SOURCE_DATA_ANOMALY` 用于“任一必需文件
 * 缺失/失败、本轮全空、合法唯一候选下降超过 80%”等来源异常。
 *
 * 只使用注入的 `now()`；分类 CSV 的统计采样时间未知，`stats_sampled_at` 固定 NULL，
 * 不用导入时间填充。
 */

/** 最多保留 20,000 个唯一候选；超出时按来源 stars 降序 + 规范名确定性截断。 */
export const MAX_UNIQUE_CANDIDATES = 20_000;
/** SQLite 每批最多 100 行写入。 */
export const INSERT_BATCH_SIZE = 100;

export type DiscoveryImportState = 'published' | 'skipped' | 'failed';

export interface DiscoveryImportDeps {
  readonly db: Database;
  readonly transport: Transport;
  readonly now: () => number;
  /**
   * API 受控访问：commits/trees 带 PAT 并回调配额观测；raw 下载检查取消。
   * 未接线时保持匿名请求，行为与接线前一致。
   */
  readonly access?: DiscoveryApiAccess;
  /** 允许注入以在测试中跳过网络；默认用 transport 访问 GitHub API 与 raw。 */
  readonly fetchSource?: (commit: string) => Promise<ReadonlyMap<string, string>>;
}

export interface DiscoveryImportResult {
  /** 本次创建的 run id；未创建 run（功能关闭、来源 manifest 尚不可用等）时为 0。 */
  readonly runId: number;
  readonly state: DiscoveryImportState;
  readonly rowsTotal: number;
  readonly rowsValid: number;
  readonly uniqueCandidates: number;
  readonly errorCode: string | null;
  readonly reason: string | null;
}

interface SettingsRow {
  readonly discovery_enabled: number;
}

interface ActiveRun {
  readonly id: number;
  readonly state: string;
  readonly rowsTotal: number;
  readonly rowsValid: number;
}

interface MergedCandidate {
  readonly candidate: ParsedCandidate;
  /** 出现过的分类文件，按固定优先序；写入 source_file（逗号连接）。 */
  readonly categories: string[];
}

interface InsertableItem {
  readonly githubId: number;
  readonly canonicalName: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stars: number | null;
  readonly forks: number | null;
  readonly domainsJson: string | null;
  readonly topicsJson: string | null;
  readonly firstSeen: string | null;
  readonly sourceCreatedAt: string | null;
  readonly sourceFile: string;
}

export async function runDiscoveryImport(deps: DiscoveryImportDeps): Promise<DiscoveryImportResult> {
  const sqlite = deps.db.$client;
  const startedAt = deps.now();

  const settings = sqlite
    .prepare('SELECT discovery_enabled FROM settings WHERE id = 1')
    .get() as SettingsRow | undefined;
  if (settings === undefined || settings.discovery_enabled !== 1) {
    // 关闭时不访问来源、不写任何状态（发现恒为启用、不提供关闭入口；此分支仅防御手改数据库）。
    return {
      runId: 0,
      state: 'skipped',
      rowsTotal: 0,
      rowsValid: 0,
      uniqueCandidates: 0,
      errorCode: 'FEATURE_DISABLED',
      reason: '发现模块已关闭，未访问来源',
    };
  }

  // 1. 来源 manifest：commit + data/ 下 5 个目标文件的 blob SHA。
  let remote;
  try {
    remote = await resolveRemoteSource(deps.transport, deps.access);
  } catch (error) {
    return failedWithoutRun(error);
  }
  const manifest = buildManifest(remote);
  if (manifest === null) {
    const missing = missingFileNames(remote).join(', ');
    return {
      runId: 0,
      state: 'failed',
      rowsTotal: 0,
      rowsValid: 0,
      uniqueCandidates: 0,
      errorCode: 'SOURCE_DATA_ANOMALY',
      reason: `必需文件在 data/ 下缺失：${missing}`,
    };
  }

  // 2. 与活跃代次比对：blob SHA 与 parser 版本都未变时不重新下载、不产生新代次。
  const active = readActiveRun(sqlite);
  if (active !== null) {
    const stored = parseStoredManifest(active.manifestJson);
    if (isSamePublishedData(stored, manifest)) {
      return {
        runId: active.run.id,
        state: 'skipped',
        rowsTotal: active.run.rowsTotal,
        rowsValid: active.run.rowsValid,
        uniqueCandidates: active.itemCount,
        errorCode: null,
        reason: '来源 blob 与 parser 版本未变化，未重新下载，也未产生新代次',
      };
    }
  }

  // 3. 读取 5 个文件（注入实现或默认 raw 下载；并发 1）。
  const fetchSource =
    deps.fetchSource ?? ((commit: string) => downloadSourceFiles(deps.transport, commit, deps.access));
  let contents: ReadonlyMap<string, string>;
  try {
    contents = await fetchSource(manifest.commit);
  } catch (error) {
    return failedWithRun(sqlite, manifest, startedAt, deps.now(), 0, 0, error);
  }

  const missingEntries = SOURCE_FILES.filter((name) => !contents.has(name));
  if (missingEntries.length > 0) {
    return failedWithRun(
      sqlite,
      manifest,
      startedAt,
      deps.now(),
      0,
      0,
      new SourceError('SOURCE_DATA_ANOMALY', `必需文件内容缺失：${missingEntries.join(', ')}`),
    );
  }
  let totalBytes = 0;
  for (const name of SOURCE_FILES) {
    totalBytes += Buffer.byteLength(contents.get(name) ?? '', 'utf8');
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return failedWithRun(
      sqlite,
      manifest,
      startedAt,
      deps.now(),
      0,
      0,
      new SourceError('SOURCE_DATA_ANOMALY', '本轮下载合计超过 128 MiB 上限'),
    );
  }

  // 4. 逐文件流式解析；行数预算为整轮 200,000 行。
  //    每个文件解析完成后立即释放其原始文本：峰值内存从「全部原始文本 + 全部候选」
  //    收敛为「剩余未解析文本 + 已解析候选」，避免 64 MiB 级原始串长期驻留。
  const pendingContents = new Map(contents);
  const parsedFiles: ParsedFile[] = [];
  let rowsTotal = 0;
  let rowsValid = 0;
  for (const name of SOURCE_FILES) {
    try {
      const parsed = await parseCategoryCsv(name, pendingContents.get(name) ?? '', MAX_TOTAL_ROWS - rowsTotal);
      pendingContents.delete(name);
      parsedFiles.push(parsed);
      rowsTotal += parsed.rowsTotal;
      rowsValid += parsed.rowsValid;
    } catch (error) {
      return failedWithRun(sqlite, manifest, startedAt, deps.now(), rowsTotal, rowsValid, error);
    }
  }

  // 5. 坏行比例超过 5% 整轮失败；用整数比较：bad * 20 > total 等价于 bad/total > 5%。
  const badRows = rowsTotal - rowsValid;
  if (badRows * BAD_ROW_RATIO_DENOMINATOR > rowsTotal) {
    return failedWithRun(
      sqlite,
      manifest,
      startedAt,
      deps.now(),
      rowsTotal,
      rowsValid,
      new SourceError('SOURCE_DATA_ANOMALY', `坏行比例超过 5%（${badRows}/${rowsTotal}）`),
    );
  }

  // 6. 按 GitHub ID 去重并合并分类：优先序靠前的文件、文件内首个合法行优先。
  const { merged, duplicateRows, conflictRows } = mergeCandidates(parsedFiles);
  if (merged.length === 0) {
    return failedWithRun(
      sqlite,
      manifest,
      startedAt,
      deps.now(),
      rowsTotal,
      rowsValid,
      new SourceError('SOURCE_DATA_ANOMALY', '本轮结果为空，不发布新代次'),
    );
  }
  if (active !== null && active.itemCount > 0 && merged.length * 5 < active.itemCount) {
    return failedWithRun(
      sqlite,
      manifest,
      startedAt,
      deps.now(),
      rowsTotal,
      rowsValid,
      new SourceError(
        'SOURCE_DATA_ANOMALY',
        `合法唯一候选 ${merged.length} 比上一轮 ${active.itemCount} 下降超过 80%`,
      ),
    );
  }

  // 7. 超过 20,000 时确定性截断（按来源 stars 降序 + 规范名；不是增长榜）。
  let kept = merged;
  let truncatedFrom: number | null = null;
  if (merged.length > MAX_UNIQUE_CANDIDATES) {
    truncatedFrom = merged.length;
    kept = [...merged].sort(compareCandidates).slice(0, MAX_UNIQUE_CANDIDATES);
  }

  // 8. 写入新 run 的 staging 数据（批量 100 行，提交之间让出事件循环）。
  let runId: number;
  try {
    runId = insertStagingRun(sqlite, manifest, startedAt, rowsTotal, rowsValid);
  } catch (error) {
    return failedWithoutRun(error);
  }
  try {
    const insertItem = sqlite.prepare(
      `INSERT INTO discovery_items (
         run_id, github_id, canonical_name, html_url, description, language, stars, forks,
         domains_json, topics_json, first_seen, source_created_at, source_file, stats_sampled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    const insertBatch = sqlite.transaction((batch: readonly InsertableItem[]) => {
      for (const item of batch) {
        insertItem.run(
          runId,
          item.githubId,
          item.canonicalName,
          item.htmlUrl,
          item.description,
          item.language,
          item.stars,
          item.forks,
          item.domainsJson,
          item.topicsJson,
          item.firstSeen,
          item.sourceCreatedAt,
          item.sourceFile,
        );
      }
    });
    for (let offset = 0; offset < kept.length; offset += INSERT_BATCH_SIZE) {
      const batch = kept.slice(offset, offset + INSERT_BATCH_SIZE).map(toInsertable);
      insertBatch(batch);
      // 每批都让出事件循环，比要求的“每 200 行或 10 ms”更保守。
      await yieldToEventLoop();
    }
  } catch (error) {
    markRunFailed(sqlite, runId, deps.now(), errorCodeOf(error));
    return failedResult(runId, rowsTotal, rowsValid, 0, error, '写入 staging 数据失败');
  }

  // 9. 原子切换：同一短事务内降级旧代次、激活新代次并更新 settings 指针。
  const completedAt = deps.now();
  try {
    const swap = sqlite.transaction(() => {
      if (active !== null) {
        sqlite
          .prepare("UPDATE discovery_runs SET state = 'superseded' WHERE id = ? AND state = 'active'")
          .run(active.run.id);
      }
      const promoted = sqlite
        .prepare("UPDATE discovery_runs SET state = 'active', completed_at = ? WHERE id = ? AND state = 'staging'")
        .run(completedAt, runId);
      if (promoted.changes !== 1) {
        throw new Error('新代次未能从 staging 切换为 active');
      }
      const pointer = sqlite
        .prepare('UPDATE settings SET active_discovery_run_id = ? WHERE id = 1')
        .run(runId);
      if (pointer.changes !== 1) {
        throw new Error('settings.active_discovery_run_id 更新失败');
      }
    });
    swap();
  } catch (error) {
    // 切换失败：清理半份数据，旧代次与指针保持不变（原子性）。
    markRunFailed(sqlite, runId, deps.now(), 'SERVICE_UNAVAILABLE');
    return failedResult(runId, rowsTotal, rowsValid, 0, error, '切换活跃代次失败，已清理本次数据');
  }

  // 10. 切换成功后删除旧（superseded）代次数据；失败不回滚已发布的新代次。
  let cleanupNote: string | null = null;
  try {
    sqlite.prepare("DELETE FROM discovery_runs WHERE state = 'superseded'").run();
  } catch {
    cleanupNote = '旧代次数据清理未完成，将在下次导入时重试';
  }

  const notes: string[] = [];
  if (duplicateRows > 0) {
    notes.push(`合并重复候选 ${duplicateRows} 行（跨文件冲突 ${conflictRows} 行）`);
  }
  if (truncatedFrom !== null) {
    notes.push(`候选 ${truncatedFrom} 超过上限，按来源 stars 降序与规范名截断至 ${MAX_UNIQUE_CANDIDATES}`);
  }
  if (cleanupNote !== null) notes.push(cleanupNote);

  return {
    runId,
    state: 'published',
    rowsTotal,
    rowsValid,
    uniqueCandidates: kept.length,
    errorCode: null,
    reason: notes.length === 0 ? null : notes.join('；'),
  };
}

function readActiveRun(sqlite: SqliteDatabase): { run: ActiveRun; manifestJson: string; itemCount: number } | null {
  const settings = sqlite
    .prepare('SELECT active_discovery_run_id FROM settings WHERE id = 1')
    .get() as { active_discovery_run_id: number | null } | undefined;
  const runId = settings?.active_discovery_run_id ?? null;
  if (runId === null) return null;

  const run = sqlite
    .prepare(
      `SELECT id, source_manifest_json, state, rows_total, rows_valid
         FROM discovery_runs WHERE id = ? AND state = 'active'`,
    )
    .get(runId) as
    | { id: number; source_manifest_json: string; state: string; rows_total: number; rows_valid: number }
    | undefined;
  if (run === undefined) return null;

  const count = sqlite
    .prepare('SELECT COUNT(*) AS n FROM discovery_items WHERE run_id = ?')
    .get(runId) as { n: number };

  return {
    run: { id: run.id, state: run.state, rowsTotal: run.rows_total, rowsValid: run.rows_valid },
    manifestJson: run.source_manifest_json,
    itemCount: count.n,
  };
}

function mergeCandidates(parsedFiles: readonly ParsedFile[]): {
  merged: MergedCandidate[];
  duplicateRows: number;
  conflictRows: number;
} {
  const byId = new Map<number, MergedCandidate>();
  let duplicateRows = 0;
  let conflictRows = 0;

  // parsedFiles 已按 SOURCE_FILES 顺序；Map 保留首次插入即“首个合法行优先”。
  for (const parsed of parsedFiles) {
    for (const candidate of parsed.rows) {
      const existing = byId.get(candidate.githubId);
      if (existing === undefined) {
        byId.set(candidate.githubId, { candidate, categories: [parsed.file] });
        continue;
      }
      duplicateRows += 1;
      if (!existing.categories.includes(parsed.file)) {
        existing.categories.push(parsed.file);
        conflictRows += 1;
      }
    }
  }
  return { merged: [...byId.values()], duplicateRows, conflictRows };
}

function compareCandidates(a: MergedCandidate, b: MergedCandidate): number {
  const starsA = a.candidate.stars ?? -1;
  const starsB = b.candidate.stars ?? -1;
  if (starsA !== starsB) return starsB - starsA;
  const nameA = a.candidate.canonicalName;
  const nameB = b.candidate.canonicalName;
  if (nameA < nameB) return -1;
  if (nameA > nameB) return 1;
  return a.candidate.githubId - b.candidate.githubId;
}

function toInsertable(entry: MergedCandidate): InsertableItem {
  const { candidate, categories } = entry;
  return {
    githubId: candidate.githubId,
    canonicalName: candidate.canonicalName,
    htmlUrl: candidate.htmlUrl,
    description: candidate.description,
    language: candidate.language,
    stars: candidate.stars,
    forks: candidate.forks,
    domainsJson: candidate.domains.length === 0 ? null : JSON.stringify(candidate.domains),
    topicsJson: candidate.topics.length === 0 ? null : JSON.stringify(candidate.topics),
    firstSeen: candidate.firstSeen,
    sourceCreatedAt: candidate.sourceCreatedAt,
    // 合并后的分类文件按固定优先序列出；单分类即纯文件名，多分类用逗号连接。
    sourceFile: categories.join(','),
  };
}

function insertStagingRun(
  sqlite: SqliteDatabase,
  manifest: SourceManifest,
  startedAt: number,
  rowsTotal: number,
  rowsValid: number,
): number {
  const info = sqlite
    .prepare(
      `INSERT INTO discovery_runs (
         source_commit, source_manifest_json, parser_version, state, started_at, completed_at,
         source_updated_at, rows_total, rows_valid, error_code
       ) VALUES (?, ?, ?, 'staging', ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      manifest.commit,
      serializeManifest(manifest),
      manifest.parserVersion,
      startedAt,
      manifest.sourceUpdatedAt,
      rowsTotal,
      rowsValid,
    );
  return Number(info.lastInsertRowid);
}

/** 清理半份数据：删除条目，并把这次尝试标记为 failed（不删除旧代次）。 */
function markRunFailed(sqlite: SqliteDatabase, runId: number, completedAt: number, errorCode: string): void {
  try {
    const cleanup = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM discovery_items WHERE run_id = ?').run(runId);
      sqlite
        .prepare("UPDATE discovery_runs SET state = 'failed', error_code = ?, completed_at = ? WHERE id = ?")
        .run(errorCode, completedAt, runId);
    });
    cleanup();
  } catch {
    // 清理失败时不再掩盖原始错误；残留的 staging 代次不会被前台读取（只读 active 代次）。
  }
}

function failedWithoutRun(error: unknown): DiscoveryImportResult {
  return {
    runId: 0,
    state: 'failed',
    rowsTotal: 0,
    rowsValid: 0,
    uniqueCandidates: 0,
    errorCode: errorCodeOf(error),
    reason: messageOf(error),
  };
}

/** 已有完整 manifest 时记录一条 failed run，便于管理员检查来源后手动重试。 */
function failedWithRun(
  sqlite: SqliteDatabase,
  manifest: SourceManifest,
  startedAt: number,
  completedAt: number,
  rowsTotal: number,
  rowsValid: number,
  error: unknown,
): DiscoveryImportResult {
  const errorCode = errorCodeOf(error);
  const info = sqlite
    .prepare(
      `INSERT INTO discovery_runs (
         source_commit, source_manifest_json, parser_version, state, started_at, completed_at,
         source_updated_at, rows_total, rows_valid, error_code
       ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      manifest.commit,
      serializeManifest(manifest),
      manifest.parserVersion,
      startedAt,
      completedAt,
      manifest.sourceUpdatedAt,
      rowsTotal,
      rowsValid,
      errorCode,
    );
  return failedResult(Number(info.lastInsertRowid), rowsTotal, rowsValid, 0, error, null);
}

function failedResult(
  runId: number,
  rowsTotal: number,
  rowsValid: number,
  uniqueCandidates: number,
  error: unknown,
  overrideReason: string | null,
): DiscoveryImportResult {
  return {
    runId,
    state: 'failed',
    rowsTotal,
    rowsValid,
    uniqueCandidates,
    errorCode: errorCodeOf(error),
    reason: overrideReason ?? messageOf(error),
  };
}

function errorCodeOf(error: unknown): string {
  if (error instanceof SourceError) return error.code;
  if (error instanceof TransportError) return error.code;
  return 'SERVICE_UNAVAILABLE';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
