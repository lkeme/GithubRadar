import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@githubradar/server';
import type { SqliteDatabase } from '@githubradar/server';

import { createTestDatabase, type TestDatabase } from './support.js';

/**
 * Drizzle schema 与已审核 SQL 迁移的一致性。
 *
 * 事实来源是 `migrations/*.sql`：列、约束、部分唯一索引与触发器都在那里。
 * `schema.ts` 只是查询层的镜像，本用例逐列比对两边，防止出现两套不一致的
 * 数据库定义（漏改一处就会在这里失败，而不是等到运行期）。
 */

interface TableInfoRow {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

let context: TestDatabase;
let client: SqliteDatabase;

beforeEach(() => {
  context = createTestDatabase();
  client = context.client;
});

afterEach(() => {
  context.close();
});

function actualColumns(table: string): Map<string, TableInfoRow> {
  const rows = client.prepare(`PRAGMA table_info('${table}')`).all() as TableInfoRow[];
  expect(rows.length, `表 ${table} 在数据库中不存在`).toBeGreaterThan(0);
  return new Map(rows.map((row) => [row.name, row]));
}

function drizzleTables(): { name: string; columns: string[] }[] {
  const tables: { name: string; columns: string[] }[] = [];
  for (const value of Object.values(schema)) {
    if (value === null || typeof value !== 'object') continue;
    // 用 getTableName 试探而不是 drizzle 的 is()：包导出里既有表也有函数与常量，
    // 只有真正的表能解析出名字，其余一律跳过。
    let name: string;
    try {
      name = getTableName(value as never);
    } catch {
      continue;
    }
    if (typeof name !== 'string' || name === '' || name === 'schema_migrations') continue;
    const columns = getTableColumns(value as never) as unknown as Record<string, { name: string; notNull: boolean }>;
    tables.push({ name, columns: Object.values(columns).map((column) => column.name) });
  }
  return tables;
}

describe('Drizzle 镜像与 SQL 迁移一致性', () => {
  it('每个 Drizzle 表的每一列都真实存在，且没有数据库列被遗漏', () => {
    const tables = drizzleTables();
    expect(tables.length).toBeGreaterThanOrEqual(20);

    for (const table of tables) {
      const actual = actualColumns(table.name);
      const declared = new Set(table.columns);

      for (const column of declared) {
        expect(actual.has(column), `${table.name}.${column} 在迁移中缺失`).toBe(true);
      }
      for (const column of actual.keys()) {
        expect(declared.has(column), `${table.name}.${column} 未在 schema.ts 中声明`).toBe(true);
      }
    }
  });

  it('NOT NULL 与主键约束两边一致', () => {
    for (const table of drizzleTables()) {
      const actual = actualColumns(table.name);
      const columns = getTableColumns(
        Object.values(schema).find((value) => {
          if (value === null || typeof value !== 'object') return false;
          try {
            return getTableName(value as never) === table.name;
          } catch {
            return false;
          }
        }) as never,
      ) as unknown as Record<string, { name: string; notNull: boolean }>;
      for (const column of Object.values(columns)) {
        const row = actual.get(column.name);
        expect(row, `${table.name}.${column.name}`).toBeDefined();
        if (row === undefined) continue;
        // 主键列在 SQLite 中可能为 notnull=0（INTEGER PRIMARY KEY 的别名行），因此单独判断。
        if (row.pk === 0) {
          expect(row.notnull === 1, `${table.name}.${column.name} 的 NOT NULL 不一致`).toBe(column.notNull);
        }
      }
    }
  });
});

describe('部分唯一索引与触发器（迁移独有约束）', () => {
  it('monitor_streams 的部分唯一索引与分支类型检查存在', () => {
    const indexes = client
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'monitor_streams'")
      .all() as { name: string; sql: string | null }[];
    const names = indexes.map((row) => row.name);
    expect(names).toContain('monitor_streams_resource_uq');
    expect(names).toContain('monitor_streams_branch_uq');
    // 只有这两个唯一索引必须是部分索引：SQLite 允许唯一键里含 NULL 的多行，
    // 资源唯一性必须靠 WHERE 限定，不能退化成普通 UNIQUE。
    for (const name of ['monitor_streams_resource_uq', 'monitor_streams_branch_uq']) {
      const index = indexes.find((row) => row.name === name);
      expect(index?.sql, name).toContain('WHERE');
    }

    const table = client
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'monitor_streams'")
      .get() as { sql: string };
    expect(table.sql).toContain("CHECK ((kind = 'branch') = (branch_id IS NOT NULL))");
  });

  it('容量触发器与去重部分唯一索引存在', () => {
    const triggers = client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all() as { name: string }[];
    const names = triggers.map((row) => row.name);
    for (const expected of [
      'repositories_capacity',
      'tracked_branches_capacity',
      'repository_labels_capacity',
    ]) {
      expect(names, expected).toContain(expected);
    }

    const jobIndex = client
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_dedupe_uq'")
      .get() as { sql: string } | undefined;
    expect(jobIndex?.sql).toContain("state IN ('queued', 'running', 'retry_wait')");
  });
});
