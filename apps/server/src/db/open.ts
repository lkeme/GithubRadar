import Database from 'better-sqlite3';

/**
 * SQLite 连接。
 *
 * 这些 PRAGMA 是连接级状态，必须在任何事务之外设置：`journal_mode` 在事务内是空操作，
 * 迁移事务不允许混入不可事务化的操作。
 */

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** 数据库文件路径；固定为工作目录下的 data/githubradar.sqlite（容器内为 /data/githubradar.sqlite）。 */
  readonly path: string;
  readonly readonly?: boolean;
}

export interface DatabasePragmas {
  readonly journalMode: string;
  /** 0=OFF、1=NORMAL、2=FULL、3=EXTRA；本系统要求 FULL。 */
  readonly synchronous: number;
  readonly busyTimeout: number;
  readonly foreignKeys: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const db = new Database(options.path, { readonly: options.readonly ?? false });
  if (options.readonly === true) {
    return db;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function readDatabasePragmas(db: SqliteDatabase): DatabasePragmas {
  return {
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
    busyTimeout: Number(db.pragma('busy_timeout', { simple: true })),
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })) === 1,
  };
}

/** 供 /health/ready 使用的本地只读探针：只确认连接可用，不触发任何上游请求。 */
export function probeDatabase(db: SqliteDatabase): boolean {
  const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
  return row?.ok === 1;
}
