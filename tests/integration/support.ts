import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDatabase, openDatabase, runMigrations, type Database, type SqliteDatabase } from '@githubradar/server';

/**
 * 集成测试使用真实临时 SQLite 文件（不是 :memory:），
 * 这样 WAL、外键、触发器和跨越连接的行为才是真实生效的。
 * 每个库文件放在独立临时目录，测试结束先关连接再删除，避免 Windows 上残留 -wal 文件。
 */

export interface TempDirectory {
  readonly dir: string;
  cleanup(): void;
}

export function createTempDirectory(prefix = 'githubradar-'): TempDirectory {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function writeMigrationFiles(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql, 'utf8');
  }
  return dir;
}

export interface TestDatabase {
  /** Drizzle 查询句柄（领域模块与调度/凭证模块使用）。 */
  readonly db: Database;
  /** 同一连接的 better-sqlite3 句柄，用于 PRAGMA 与约束断言。 */
  readonly client: SqliteDatabase;
  readonly dir: string;
  close(): void;
}

/**
 * 领域模块与领域外的调度/凭证模块都使用 Drizzle 句柄，底层仍是同一个连接。
 * 同一个连接上创建多个 Drizzle 包装是安全的：它只是无状态的查询构造器。
 */
export function drizzleOf(client: SqliteDatabase): Database {
  return createDatabase(client);
}

export function createTestDatabase(options: { migrate?: boolean } = {}): TestDatabase {
  const temp = createTempDirectory();
  const client = openDatabase({ path: path.join(temp.dir, 'githubradar.sqlite') });
  const db = createDatabase(client);
  try {
    if (options.migrate !== false) {
      runMigrations(client);
    }
  } catch (error) {
    // 迁移失败时也要释放句柄，否则 Windows 上临时目录无法删除。
    client.close();
    temp.cleanup();
    throw error;
  }
  return {
    db,
    client,
    dir: temp.dir,
    close() {
      client.close();
      temp.cleanup();
    },
  };
}

export const TEST_NOW = 1_700_000_000_000;

/** 兼容两种句柄：直接传 Drizzle 实例或底层 better-sqlite3 连接都可以。 */
function sqliteClientOf(db: Database | SqliteDatabase): SqliteDatabase {
  return typeof (db as SqliteDatabase).prepare === 'function' ? (db as SqliteDatabase) : (db as Database).$client;
}

export function insertRepository(
  db: Database | SqliteDatabase,
  canonicalName: string,
  overrides: { githubId?: number | null; createdAt?: number } = {},
): number {
  const info = sqliteClientOf(db)
    .prepare('INSERT INTO repositories (canonical_name, html_url, github_id, created_at) VALUES (?, ?, ?, ?)')
    .run(
      canonicalName,
      `https://github.com/${canonicalName}`,
      overrides.githubId ?? null,
      overrides.createdAt ?? TEST_NOW,
    );
  return Number(info.lastInsertRowid);
}
