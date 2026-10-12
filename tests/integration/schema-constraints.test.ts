import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_BRANCHES_PER_REPO, MAX_LABELS_PER_REPO, REPOSITORY_LIMIT } from '@githubradar/contracts';
import type { SqliteDatabase } from '@githubradar/server';

import { createTestDatabase, insertRepository, TEST_NOW, type TestDatabase } from './support.js';

let context: TestDatabase | undefined;
let db: SqliteDatabase;

beforeEach(() => {
  context = createTestDatabase();
  db = context.client;
});

afterEach(() => {
  context?.close();
  context = undefined;
});

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function insertFixedBranch(repoId: number, name: string): number {
  const info = db
    .prepare("INSERT INTO tracked_branches (repo_id, mode, configured_name) VALUES (?, 'fixed', ?)")
    .run(repoId, name);
  return Number(info.lastInsertRowid);
}

function insertStream(repoId: number, kind: string, branchId: number | null): void {
  db.prepare('INSERT INTO monitor_streams (repo_id, kind, branch_id, phase_seed) VALUES (?, ?, ?, ?)').run(
    repoId,
    kind,
    branchId,
    1,
  );
}

describe('仓库容量', () => {
  it('第 999 条仓库可以写入，第 1000 条被触发器拒绝', () => {
    const insert = db.prepare(
      'INSERT INTO repositories (canonical_name, html_url, created_at) VALUES (?, ?, ?)',
    );
    const seedBulk = db.transaction(() => {
      for (let index = 0; index < REPOSITORY_LIMIT - 1; index += 1) {
        insert.run(`owner/bulk-${index}`, `https://github.com/owner/bulk-${index}`, TEST_NOW);
      }
    });
    seedBulk();

    expect(countRows('repositories')).toBe(REPOSITORY_LIMIT - 1);
    insertRepository(db, 'owner/at-limit');
    expect(countRows('repositories')).toBe(REPOSITORY_LIMIT);

    expect(() => insertRepository(db, 'owner/over-limit')).toThrowError(/REPOSITORY_LIMIT_REACHED/);
    expect(countRows('repositories')).toBe(REPOSITORY_LIMIT);
  });

  it('待验证占位行同样占用名额', () => {
    insertRepository(db, 'owner/pending', { githubId: null });
    expect(countRows('repositories')).toBe(1);
  });

  it('github_id 唯一但允许多条未验证的空值', () => {
    insertRepository(db, 'owner/a', { githubId: 42 });
    expect(() => insertRepository(db, 'owner/b', { githubId: 42 })).toThrowError(/UNIQUE/);
    insertRepository(db, 'owner/c', { githubId: null });
    insertRepository(db, 'owner/d', { githubId: null });
    expect(countRows('repositories')).toBe(3);
  });

  it('归一化名称唯一，重复导入走合并流程而不是插入新行', () => {
    insertRepository(db, 'owner/dup');
    expect(() => insertRepository(db, 'owner/dup')).toThrowError(/UNIQUE/);
  });
});

describe('采集流唯一性（部分唯一索引）', () => {
  it('同一仓库的 release/metadata 流各只能有一条', () => {
    const repoId = insertRepository(db, 'owner/streams');
    insertStream(repoId, 'metadata', null);
    insertStream(repoId, 'release', null);
    expect(() => insertStream(repoId, 'metadata', null)).toThrowError(/UNIQUE/);
    expect(() => insertStream(repoId, 'release', null)).toThrowError(/UNIQUE/);
  });

  it('branch 流必须挂分支，其他流必须不挂分支', () => {
    const repoId = insertRepository(db, 'owner/kinds');
    expect(() => insertStream(repoId, 'branch', null)).toThrowError(/CHECK/);
    const branchId = insertFixedBranch(repoId, 'main');
    expect(() => insertStream(repoId, 'metadata', branchId)).toThrowError(/CHECK/);
    insertStream(repoId, 'branch', branchId);
    expect(() => insertStream(repoId, 'branch', branchId)).toThrowError(/UNIQUE/);
  });

  it('分支流不能引用其他仓库的分支', () => {
    const repoId = insertRepository(db, 'owner/self');
    const otherRepoId = insertRepository(db, 'owner/foreign');
    const foreignBranchId = insertFixedBranch(otherRepoId, 'main');
    expect(() => insertStream(repoId, 'branch', foreignBranchId)).toThrowError(/FOREIGN KEY/);
  });

  it('删除分支时对应流级联清理', () => {
    const repoId = insertRepository(db, 'owner/cascade');
    const branchId = insertFixedBranch(repoId, 'main');
    insertStream(repoId, 'branch', branchId);
    db.prepare('DELETE FROM tracked_branches WHERE id = ?').run(branchId);
    expect(countRows('monitor_streams')).toBe(0);
  });
});

describe('分支护栏', () => {
  it('每仓至多一个 default 跟随分支', () => {
    const repoId = insertRepository(db, 'owner/default-branch');
    db.prepare("INSERT INTO tracked_branches (repo_id, mode) VALUES (?, 'default')").run(repoId);
    expect(() =>
      db.prepare("INSERT INTO tracked_branches (repo_id, mode) VALUES (?, 'default')").run(repoId),
    ).toThrowError(/UNIQUE/);
  });

  it('fixed 模式必须带分支名，default 模式必须不带', () => {
    const repoId = insertRepository(db, 'owner/modes');
    expect(() =>
      db.prepare('INSERT INTO tracked_branches (repo_id, mode) VALUES (?, ?)').run(repoId, 'fixed'),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.prepare('INSERT INTO tracked_branches (repo_id, mode, configured_name) VALUES (?, ?, ?)').run(
        repoId,
        'default',
        'main',
      ),
    ).toThrowError(/CHECK/);
  });

  it('同一仓库的固定分支名唯一，但大小写不同视为不同分支', () => {
    const repoId = insertRepository(db, 'owner/case');
    insertFixedBranch(repoId, 'main');
    expect(() => insertFixedBranch(repoId, 'main')).toThrowError(/UNIQUE/);
    expect(() => insertFixedBranch(repoId, 'Main')).not.toThrow();
  });

  it('分支数量上限由触发器兜底', () => {
    const repoId = insertRepository(db, 'owner/many');
    db.prepare("INSERT INTO tracked_branches (repo_id, mode) VALUES (?, 'default')").run(repoId);
    for (let index = 0; index < MAX_BRANCHES_PER_REPO - 1; index += 1) {
      insertFixedBranch(repoId, `branch-${index}`);
    }
    expect(countRows('tracked_branches')).toBe(MAX_BRANCHES_PER_REPO);
    expect(() => insertFixedBranch(repoId, 'branch-overflow')).toThrowError(/BRANCH_LIMIT_REACHED/);
  });

  it('分支名超长被拒绝', () => {
    const repoId = insertRepository(db, 'owner/long-branch');
    expect(() => insertFixedBranch(repoId, 'x'.repeat(1025))).toThrowError(/CHECK/);
    expect(() => insertFixedBranch(repoId, '中文'.repeat(341))).toThrowError(/CHECK/);
  });
});

describe('标签护栏', () => {
  it('每仓最多 20 个标签，标签定义本身不删除', () => {
    const repoId = insertRepository(db, 'owner/labels');
    const insertLabel = db.prepare('INSERT INTO labels (name) VALUES (?)');
    const linkLabel = db.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, ?)');

    for (let index = 0; index < MAX_LABELS_PER_REPO + 1; index += 1) {
      insertLabel.run(`label-${index}`);
    }
    for (let index = 0; index < MAX_LABELS_PER_REPO; index += 1) {
      linkLabel.run(repoId, index + 1);
    }
    expect(() => linkLabel.run(repoId, MAX_LABELS_PER_REPO + 1)).toThrowError(/LABEL_LIMIT_REACHED/);
    expect(countRows('labels')).toBe(MAX_LABELS_PER_REPO + 1);
  });

  it('标签名长度受 32 字符约束', () => {
    expect(() => db.prepare('INSERT INTO labels (name) VALUES (?)').run('x'.repeat(33))).toThrowError(/CHECK/);
  });

  it('删除仓库时标签关系级联清理，标签定义保留', () => {
    const repoId = insertRepository(db, 'owner/label-cascade');
    db.prepare('INSERT INTO labels (name) VALUES (?)').run('开发工具');
    db.prepare('INSERT INTO repository_labels (repo_id, label_id) VALUES (?, 1)').run(repoId);
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
    expect(countRows('repository_labels')).toBe(0);
    expect(countRows('labels')).toBe(1);
  });
});

describe('任务去重与状态', () => {
  const insertJob = (dedupeKey: string, state = 'queued'): void => {
    db.prepare(
      `INSERT INTO jobs (kind, queue_class, origin, accepted_at, dedupe_key, state, created_at)
       VALUES ('metadata', 'periodic', 'scheduler', ?, ?, ?, ?)`,
    ).run(TEST_NOW, dedupeKey, state, TEST_NOW);
  };

  it('未结束任务按 dedupe_key 唯一，已结束任务不阻塞后续同类任务', () => {
    insertJob('repo:1:metadata');
    expect(() => insertJob('repo:1:metadata')).toThrowError(/UNIQUE/);
    expect(() => insertJob('repo:1:metadata', 'running')).toThrowError(/UNIQUE/);

    db.prepare('UPDATE jobs SET state = ?, finished_at = ? WHERE dedupe_key = ?').run(
      'succeeded',
      TEST_NOW,
      'repo:1:metadata',
    );
    expect(() => insertJob('repo:1:metadata')).not.toThrow();
  });

  it('枚举列拒绝计划外取值', () => {
    const insertWith = (kind: string, queueClass: string, origin: string): void => {
      db.prepare(
        `INSERT INTO jobs (kind, queue_class, origin, accepted_at, state, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      ).run(kind, queueClass, origin, TEST_NOW, TEST_NOW);
    };
    // 不存在 AI 摘要类任务，也不存在枚举之外的队列与来源。
    expect(() => insertWith('ai_summary', 'periodic', 'scheduler')).toThrowError(/CHECK/);
    expect(() => insertWith('metadata', 'background', 'scheduler')).toThrowError(/CHECK/);
    expect(() => insertWith('metadata', 'periodic', 'browser')).toThrowError(/CHECK/);
    expect(() => insertWith('metadata', 'periodic', 'scheduler')).not.toThrow();
  });

  it('删除仓库时任务与流不级联删除对象，只解除引用', () => {
    const repoId = insertRepository(db, 'owner/jobs');
    insertStream(repoId, 'metadata', null);
    const streamId = (db.prepare('SELECT id FROM monitor_streams LIMIT 1').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO jobs (stream_id, kind, queue_class, origin, accepted_at, state, created_at)
       VALUES (?, 'metadata', 'periodic', 'scheduler', ?, 'queued', ?)`,
    ).run(streamId, TEST_NOW, TEST_NOW);

    db.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
    expect(countRows('monitor_streams')).toBe(0);
    expect(countRows('jobs')).toBe(1);
    const job = db.prepare('SELECT stream_id FROM jobs LIMIT 1').get() as { stream_id: number | null };
    expect(job.stream_id).toBeNull();
  });
});

describe('候选凭证操作', () => {
  it('同类未完成候选最多一个，结束后可再次提交', () => {
    const sessionId = Number(
      db
        .prepare(
          'INSERT INTO sessions (token_hash, auth_version, csrf_nonce, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('hash-1', 1, 'nonce-1', TEST_NOW, TEST_NOW, TEST_NOW + 1000).lastInsertRowid,
    );
    const insertOperation = db.prepare(
      `INSERT INTO pending_operations (kind, encrypted_candidate, initiating_session_id, auth_version, expected_revision, status, expires_at, created_at)
       VALUES ('github_token', x'00', ?, 1, 1, ?, ?, ?)`,
    );

    insertOperation.run(sessionId, 'pending', TEST_NOW + 3_600_000, TEST_NOW);
    expect(() => insertOperation.run(sessionId, 'running', TEST_NOW + 3_600_000, TEST_NOW)).toThrowError(/UNIQUE/);

    db.prepare("UPDATE pending_operations SET status = 'cancelled'").run();
    expect(() => insertOperation.run(sessionId, 'pending', TEST_NOW + 3_600_000, TEST_NOW)).not.toThrow();
  });

  it('发起会话被删除时候选操作一并取消，不留下待激活密文', () => {
    const sessionId = Number(
      db
        .prepare(
          'INSERT INTO sessions (token_hash, auth_version, csrf_nonce, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('hash-2', 1, 'nonce-2', TEST_NOW, TEST_NOW, TEST_NOW + 1000).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO pending_operations (kind, encrypted_candidate, initiating_session_id, auth_version, expected_revision, status, expires_at, created_at)
       VALUES ('github_token', x'00', ?, 1, 1, 'pending', ?, ?)`,
    ).run(sessionId, TEST_NOW + 3_600_000, TEST_NOW);

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(countRows('pending_operations')).toBe(0);
  });
});

describe('趋势与配额', () => {
  it('同一天同一仓库只有一条快照，重复观察覆盖当日有效值', () => {
    const repoId = insertRepository(db, 'owner/trend');
    const upsert = db.prepare(
      `INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, day) DO UPDATE SET stars = excluded.stars, forks = excluded.forks, sampled_at = excluded.sampled_at, verified_at = excluded.verified_at`,
    );
    upsert.run(repoId, '2026-10-09', 10, 1, TEST_NOW, TEST_NOW);
    upsert.run(repoId, '2026-10-09', 12, 2, TEST_NOW + 1000, TEST_NOW + 1000);

    expect(countRows('daily_metrics')).toBe(1);
    const row = db.prepare('SELECT stars, forks FROM daily_metrics').get() as { stars: number; forks: number };
    expect(row).toEqual({ stars: 12, forks: 2 });
  });

  it('日期列必须是北京时间日历日格式', () => {
    const repoId = insertRepository(db, 'owner/day-format');
    expect(() =>
      db
        .prepare('INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, 1, 1, ?, ?)')
        .run(repoId, '2026-10-09T00:00:00Z', TEST_NOW, TEST_NOW),
    ).toThrowError(/CHECK/);
  });

  it('删除仓库时趋势一并清理', () => {
    const repoId = insertRepository(db, 'owner/trend-cascade');
    db.prepare(
      'INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, 1, 1, ?, ?)',
    ).run(repoId, '2026-10-09', TEST_NOW, TEST_NOW);
    db.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
    expect(countRows('daily_metrics')).toBe(0);
  });

  it('配额按 account/resource/reset 归属，同一 reset 周期只有一行', () => {
    const insert = db.prepare(
      'INSERT INTO rate_state (account_id, resource, reset_at, limit_value, remaining) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('acct-1', 'core', 100, 5000, 4999);
    expect(() => insert.run('acct-1', 'core', 100, 5000, 4998)).toThrowError(/UNIQUE/);
    expect(() => insert.run('acct-1', 'core', 200, 5000, 5000)).not.toThrow();
    expect(() => insert.run('acct-2', 'core', 100, 5000, 5000)).not.toThrow();
  });
});

describe('发现代次与条目', () => {
  it('同一时刻只允许一个活跃代次', () => {
    const insertRun = db.prepare(
      `INSERT INTO discovery_runs (source_commit, source_manifest_json, parser_version, state, started_at)
       VALUES (?, '{}', 1, ?, ?)`,
    );
    insertRun.run('commit-1', 'active', TEST_NOW);
    expect(() => insertRun.run('commit-2', 'active', TEST_NOW)).toThrowError(/UNIQUE/);
    insertRun.run('commit-2', 'staging', TEST_NOW);
    insertRun.run('commit-3', 'superseded', TEST_NOW);
  });

  it('同代次内按 GitHub ID 唯一，切换代次时旧数据随代次删除', () => {
    db.prepare(
      `INSERT INTO discovery_runs (source_commit, source_manifest_json, parser_version, state, started_at)
       VALUES ('commit-1', '{}', 1, 'active', ?)`,
    ).run(TEST_NOW);
    const insertItem = db.prepare(
      `INSERT INTO discovery_items (run_id, github_id, canonical_name, html_url, source_file)
       VALUES (?, ?, ?, ?, 'AI_Agent.csv')`,
    );
    insertItem.run(1, 42, 'owner/a', 'https://github.com/owner/a');
    expect(() => insertItem.run(1, 42, 'owner/a-dup', 'https://github.com/owner/a')).toThrowError(/UNIQUE/);

    db.prepare('DELETE FROM discovery_runs WHERE id = 1').run();
    expect(countRows('discovery_items')).toBe(0);
  });

  it('来源统计采样时间未知时保持 NULL，不用导入时间填充', () => {
    db.prepare(
      `INSERT INTO discovery_runs (source_commit, source_manifest_json, parser_version, state, started_at)
       VALUES ('commit-1', '{}', 1, 'active', ?)`,
    ).run(TEST_NOW);
    db.prepare(
      `INSERT INTO discovery_items (run_id, github_id, canonical_name, html_url, source_file)
       VALUES (1, 7, 'owner/x', 'https://github.com/owner/x', 'RAG.csv')`,
    ).run();
    const row = db.prepare('SELECT stats_sampled_at FROM discovery_items').get() as {
      stats_sampled_at: number | null;
    };
    expect(row.stats_sampled_at).toBeNull();
  });
});

describe('单例约束', () => {
  it('settings、credential status、proxy、runtime_lock 都只能有一行', () => {
    expect(() => db.prepare('INSERT INTO settings (id) VALUES (2)').run()).toThrowError(/CHECK/);
    expect(() => db.prepare('INSERT INTO github_credential_status (id) VALUES (2)').run()).toThrowError(/CHECK/);
    expect(() => db.prepare('INSERT INTO proxy_config (id) VALUES (2)').run()).toThrowError(/CHECK/);
    expect(() => db.prepare('INSERT INTO runtime_lock (id) VALUES (2)').run()).toThrowError(/CHECK/);
  });

  it('档位只接受 3/6/12/24，仓库可用 NULL 表示继承全局', () => {
    expect(() => db.prepare('UPDATE settings SET default_interval_hours = 5 WHERE id = 1').run()).toThrowError(
      /CHECK/,
    );
    const repoId = insertRepository(db, 'owner/interval');
    const setInterval = db.prepare('UPDATE repositories SET interval_hours = ? WHERE id = ?');

    expect(() => setInterval.run(5, repoId)).toThrowError(/CHECK/);
    expect(() => setInterval.run(0, repoId)).toThrowError(/CHECK/);
    expect(() => setInterval.run(3, repoId)).not.toThrow();
    expect(() => setInterval.run(null, repoId)).not.toThrow();
  });

  it('启用代理时必须同时具备 scheme/host/port，关闭时允许为空', () => {
    expect(() => db.prepare('UPDATE proxy_config SET enabled = 1 WHERE id = 1').run()).toThrowError(/CHECK/);
    expect(() =>
      db
        .prepare("UPDATE proxy_config SET scheme = 'socks5', host = '192.168.1.10', port = 1080, enabled = 1 WHERE id = 1")
        .run(),
    ).not.toThrow();
  });

  it('凭证状态只接受已定义的状态机取值', () => {
    expect(() =>
      db.prepare("UPDATE github_credential_status SET credential_state = 'refreshing' WHERE id = 1").run(),
    ).toThrowError(/CHECK/);
    expect(() =>
      db
        .prepare(
          "UPDATE github_credential_status SET credential_state = 'invalid', last_error_code = 'GITHUB_TOKEN_INVALID' WHERE id = 1",
        )
        .run(),
    ).not.toThrow();
  });
});

describe('字段边界', () => {
  it('别名与备注长度受限', () => {
    const repoId = insertRepository(db, 'owner/length');
    expect(() =>
      db.prepare('UPDATE repositories SET display_name = ? WHERE id = ?').run('x'.repeat(101), repoId),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.prepare('UPDATE repositories SET note = ? WHERE id = ?').run('x'.repeat(1001), repoId),
    ).toThrowError(/CHECK/);
    expect(() =>
      db.prepare('UPDATE repositories SET note = ? WHERE id = ?').run('x'.repeat(1000), repoId),
    ).not.toThrow();
  });
});
