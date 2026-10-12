import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  MigrationError,
  openDatabase,
  probeDatabase,
  readDatabasePragmas,
  runMigrations,
  type SqliteDatabase,
} from '@githubradar/server';

import { createTempDirectory, writeMigrationFiles } from './support.js';

const openDatabases: SqliteDatabase[] = [];
const cleanupFns: (() => void)[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const cleanup of cleanupFns.splice(0)) {
    cleanup();
  }
});

function openTempDatabase(): SqliteDatabase {
  const temp = createTempDirectory();
  cleanupFns.push(temp.cleanup);
  const db = openDatabase({ path: path.join(temp.dir, 'githubradar.sqlite') });
  openDatabases.push(db);
  return db;
}

function tableNames(db: SqliteDatabase): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('数据库连接', () => {
  it('打开连接后 WAL、外键、busy_timeout、synchronous 均按预期生效', () => {
    const db = openTempDatabase();
    expect(readDatabasePragmas(db)).toEqual({
      journalMode: 'wal',
      synchronous: 2,
      busyTimeout: 5000,
      foreignKeys: true,
    });
    expect(probeDatabase(db)).toBe(true);
  });

  it('WAL 模式在磁盘上生成独立日志文件，说明不是内存库', () => {
    const db = openTempDatabase();
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
    const files = db.pragma('database_list', { simple: false }) as { file: string }[];
    const main = files.find((row) => row.file !== '');
    expect(main).toBeDefined();
    expect(existsSync(`${main?.file ?? ''}-wal`)).toBe(true);
  });
});

describe('迁移文件装载', () => {
  it('默认目录解析到真实 migrations 目录，且首个迁移为 0001_init.sql', () => {
    const migrations = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(migrations.map((migration) => migration.file)).toContain('0001_init.sql');
    expect(migrations[0]?.version).toBe('0001');
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('文件名必须形如 NNNN_name.sql', () => {
    const temp = createTempDirectory();
    cleanupFns.push(temp.cleanup);
    writeMigrationFiles(temp.dir, { 'init.sql': 'SELECT 1;' });
    expect(() => loadMigrations(temp.dir)).toThrowError(/MIGRATION_FILENAME_INVALID/);
  });

  it('同一版本号出现两次时拒绝执行', () => {
    const temp = createTempDirectory();
    cleanupFns.push(temp.cleanup);
    writeMigrationFiles(temp.dir, {
      '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
      '0001_b.sql': 'CREATE TABLE b (id INTEGER);',
    });
    expect(() => loadMigrations(temp.dir)).toThrowError(/MIGRATION_DUPLICATE_VERSION/);
  });

  it('迁移目录不可读时给出明确错误而不是抛裸异常', () => {
    const temp = createTempDirectory();
    cleanupFns.push(temp.cleanup);
    expect(() => loadMigrations(path.join(temp.dir, 'missing'))).toThrowError(/MIGRATIONS_DIR_UNAVAILABLE/);
  });
});

describe('迁移执行', () => {
  it('首次执行应用全部待执行迁移并记账', () => {
    const db = openTempDatabase();
    const result = runMigrations(db);
    const expected = loadMigrations().map((migration) => migration.version);
    expect(result.applied).toEqual(expected);
    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    expect(result.alreadyApplied).toEqual([]);
    expect(result.schemaVersion).toBe(expected.at(-1));

    const tables = tableNames(db);
    for (const expected of [
      'admin_account',
      'daily_metrics',
      'daily_trend_items',
      'daily_trend_runs',
      'discovery_items',
      'discovery_runs',
      'github_credential_status',
      'http_cache',
      'job_group_items',
      'job_groups',
      'jobs',
      'labels',
      'monitor_streams',
      'pending_operations',
      'proxy_config',
      'rate_state',
      'repository_labels',
      'repositories',
      'runtime_lock',
      'schema_migrations',
      'secrets',
      'sessions',
      'settings',
      'tracked_branches',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('重复执行是幂等的，不重复应用也不重复记账', () => {
    const db = openTempDatabase();
    runMigrations(db);
    const expected = loadMigrations().map((migration) => migration.version);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(expected);
    expect(second.schemaVersion).toBe(expected.at(-1));

    const ledgerCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(ledgerCount.count).toBe(expected.length);
  });

  it('单例默认行只初始化一次，默认档位为 24 小时且发现模块恒为启用', () => {
    const db = openTempDatabase();
    runMigrations(db);
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as {
      default_interval_hours: number;
      discovery_enabled: number;
      pins_revision: number;
      revision: number;
      active_discovery_run_id: number | null;
    };
    expect(settings.default_interval_hours).toBe(24);
    expect(settings.discovery_enabled).toBe(1);
    expect(settings.pins_revision).toBe(1);
    expect(settings.revision).toBe(1);
    expect(settings.active_discovery_run_id).toBeNull();

    const credential = db.prepare('SELECT * FROM github_credential_status WHERE id = 1').get() as {
      credential_state: string;
      connectivity: string;
      gate_revision: number;
      verification_attempt_seq: number;
    };
    expect(credential.credential_state).toBe('missing');
    expect(credential.connectivity).toBe('unknown');
    expect(credential.gate_revision).toBe(1);
    expect(credential.verification_attempt_seq).toBe(0);

    // 管理员账号不由迁移创建，必须来自启动时的 ensureAdminAccount。
    const admin = db.prepare('SELECT COUNT(*) AS count FROM admin_account').get() as { count: number };
    expect(admin.count).toBe(0);

    const lock = db.prepare('SELECT owner_id, lease_until, fence FROM runtime_lock WHERE id = 1').get() as {
      owner_id: string | null;
      lease_until: number;
      fence: number;
    };
    expect(lock).toEqual({ owner_id: null, lease_until: 0, fence: 0 });
  });

  it('已记账迁移的内容被修改时拒绝启动', () => {
    const db = openTempDatabase();
    const migrations = loadMigrations();
    runMigrations(db, migrations);
    const tampered = migrations.map((migration) => ({ ...migration, checksum: 'f'.repeat(64) }));
    expect(() => runMigrations(db, tampered)).toThrowError(/MIGRATION_CHECKSUM_MISMATCH/);
  });

  it('已记账但缺少对应文件时拒绝启动', () => {
    const db = openTempDatabase();
    runMigrations(db);
    expect(() => runMigrations(db, [])).toThrowError(/MIGRATION_MISSING_FILE/);
  });

  it('数据库已有表却没有记账表时按未知状态拒绝，不当作空库', () => {
    const db = openTempDatabase();
    db.exec('CREATE TABLE legacy_table (id INTEGER PRIMARY KEY)');
    let caught: unknown;
    try {
      runMigrations(db);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('SCHEMA_STATE_UNKNOWN');
    expect(tableNames(db)).toEqual(['legacy_table']);
  });

  it('任一迁移失败时整批待执行迁移与版本记账一起回滚', () => {
    const temp = createTempDirectory();
    cleanupFns.push(temp.cleanup);
    writeMigrationFiles(temp.dir, {
      '0001_alpha.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);',
      '0002_broken.sql': 'CREATE TABLE beta (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;',
    });

    const db = openTempDatabase();
    let caught: unknown;
    try {
      runMigrations(db, loadMigrations(temp.dir));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('MIGRATION_FAILED');

    // 先成功的 0001 也必须回滚：迁移与记账在同一事务内。
    expect(tableNames(db)).toEqual(['schema_migrations']);
    const ledger = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(ledger.count).toBe(0);
  });

  it('回滚后修正迁移文件即可重新执行，无需删除数据库', () => {
    const temp = createTempDirectory();
    cleanupFns.push(temp.cleanup);
    writeMigrationFiles(temp.dir, {
      '0001_alpha.sql': 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);',
      '0002_broken.sql': 'THIS IS NOT SQL;',
    });

    const db = openTempDatabase();
    expect(() => runMigrations(db, loadMigrations(temp.dir))).toThrowError(/MIGRATION_FAILED/);

    writeMigrationFiles(temp.dir, { '0002_broken.sql': 'CREATE TABLE beta (id INTEGER PRIMARY KEY);' });
    const result = runMigrations(db, loadMigrations(temp.dir));
    expect(result.applied).toEqual(['0001', '0002']);
    expect(tableNames(db)).toContain('alpha');
    expect(tableNames(db)).toContain('beta');
  });
});
