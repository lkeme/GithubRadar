import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SqliteDatabase } from './open.js';
import * as schema from './schema.js';

export { schema };

/**
 * Drizzle 实例类型。
 *
 * 底层 better-sqlite3 句柄通过 `$client` 取得：DDL、部分唯一索引命中的 upsert、
 * 调度热路径的到期领取等场景需要直接使用预编译语句，与类型化查询共用同一连接与事务。
 */
export type Database = BetterSQLite3Database<typeof schema> & { readonly $client: SqliteDatabase };

export function createDatabase(client: SqliteDatabase): Database {
  return drizzle(client, { schema });
}
