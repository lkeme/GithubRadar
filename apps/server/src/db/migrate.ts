import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SqliteDatabase } from './open.js';

/**
 * 迁移执行器。
 *
 * - 迁移是本目录外的审核过的 .sql 文件，命名 `NNNN_name.sql`，按版本号顺序执行。
 * - 本次待执行的全部迁移与版本记账在同一个 `BEGIN IMMEDIATE` 事务内完成，
 *   失败整体回滚，不依赖“每个迁移文件各自事务”。
 * - 迁移文件内不允许出现事务控制语句，也不允许 VACUUM、journal_mode 之类
 *   不可事务化的操作。
 */

/**
 * migrations 目录位于包根，与 `src/db`、`dist/db` 都相隔两级，
 * 因此开发环境与容器（只复制 dist 和 migrations）都能解析到同一位置。
 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const LEDGER_TABLE = 'schema_migrations';

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

export type MigrationErrorCode =
  | 'MIGRATIONS_DIR_UNAVAILABLE'
  | 'MIGRATION_FILENAME_INVALID'
  | 'MIGRATION_DUPLICATE_VERSION'
  | 'SCHEMA_STATE_UNKNOWN'
  | 'MIGRATION_MISSING_FILE'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FAILED';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version: string | null;

  constructor(code: MigrationErrorCode, message: string, version: string | null = null, cause?: unknown) {
    // 错误码放在消息前缀，便于只读日志时直接定位失败环节。
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'MigrationError';
    this.code = code;
    this.version = version;
  }
}

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationRunResult {
  /** 本次实际执行的迁移版本，按执行顺序。 */
  readonly applied: readonly string[];
  /** 执行前已记账的迁移版本。 */
  readonly alreadyApplied: readonly string[];
  /** 执行后的 schema 版本，空库为 null。 */
  readonly schemaVersion: string | null;
}

interface LedgerRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): readonly Migration[] {
  let files: readonly string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.sql'));
  } catch (error) {
    throw new MigrationError('MIGRATIONS_DIR_UNAVAILABLE', `无法读取迁移目录：${dir}`, null, error);
  }

  const byVersion = new Map<string, Migration>();
  for (const file of [...files].sort()) {
    const match = MIGRATION_FILENAME.exec(file);
    if (match === null) {
      throw new MigrationError('MIGRATION_FILENAME_INVALID', `迁移文件名必须形如 NNNN_name.sql：${file}`);
    }
    const version = match[1] as string;
    const name = match[2] as string;
    if (byVersion.has(version)) {
      throw new MigrationError(
        'MIGRATION_DUPLICATE_VERSION',
        `迁移版本重复：${version}（${byVersion.get(version)?.file} 与 ${file}）`,
        version,
      );
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    byVersion.set(version, { version, name, file, sql, checksum: checksumOf(sql) });
  }

  return [...byVersion.values()].sort((a, b) => (a.version < b.version ? -1 : 1));
}

function listUserTables(db: SqliteDatabase): readonly string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as readonly { name: string }[];
  return rows.map((row) => row.name);
}

function readLedger(db: SqliteDatabase): readonly LedgerRow[] {
  return db
    .prepare(`SELECT version, name, checksum FROM ${LEDGER_TABLE} ORDER BY version`)
    .all() as readonly LedgerRow[];
}

export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[] = loadMigrations(),
  now: () => number = Date.now,
): MigrationRunResult {
  const ledgerExists =
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(
      LEDGER_TABLE,
    ) !== undefined;

  if (!ledgerExists) {
    const existing = listUserTables(db);
    if (existing.length > 0) {
      throw new MigrationError(
        'SCHEMA_STATE_UNKNOWN',
        `数据库已有表 [${existing.join(', ')}] 但缺少 ${LEDGER_TABLE}，拒绝按空库执行迁移`,
      );
    }
    // 记账表本身是引导步骤，不是迁移；真正的迁移与记账在下面同一事务内完成。
    db.exec(LEDGER_DDL);
  }

  const appliedRows = ledgerExists ? readLedger(db) : [];
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const row of appliedRows) {
    const migration = byVersion.get(row.version);
    if (migration === undefined) {
      throw new MigrationError(
        'MIGRATION_MISSING_FILE',
        `迁移 ${row.version} 已记账但缺少对应文件，可能使用了更早的版本`,
        row.version,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `迁移 ${row.version} 内容已变更；已应用的迁移不可修改，请新增迁移文件`,
        row.version,
      );
    }
  }

  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

  if (pending.length > 0) {
    const insertLedger = db.prepare(
      `INSERT INTO ${LEDGER_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
    );
    const applyPending = db.transaction((items: readonly Migration[]) => {
      for (const migration of items) {
        db.exec(migration.sql);
        insertLedger.run(migration.version, migration.name, migration.checksum, now());
      }
    });
    try {
      applyPending.immediate(pending);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        'MIGRATION_FAILED',
        `迁移执行失败，全部待执行迁移与版本记账已回滚：${detail}`,
        null,
        error,
      );
    }
  }

  const applied = pending.map((migration) => migration.version);
  return {
    applied,
    alreadyApplied: appliedRows.map((row) => row.version),
    schemaVersion: applied.at(-1) ?? appliedRows.at(-1)?.version ?? null,
  };
}
