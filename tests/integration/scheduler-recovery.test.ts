import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRuntimeLock,
  cacheKeyFor,
  createSession,
  CredentialService,
  DISCOVERY_FIRST_RUN_DELAY_MS,
  DISCOVERY_RETRY_DELAY_MS,
  dueStreams,
  encryptSecret,
  GithubClient,
  HOUR_MS,
  MINUTE_MS,
  JobQueue,
  PAT_SECRET_NAME,
  planDiscoverySchedule,
  PROJECTION_VERSION,
  RateBudget,
  releaseRuntimeLock,
  renewRuntimeLock,
  RepositoryService,
  RuntimeLockError,
  RUNTIME_LOCK_LEASE_MS,
  Scheduler,
  type JobRow,
  type SqliteDatabase,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@githubradar/server';

import { createTestDatabase, insertRepository, type TestDatabase } from './support.js';

/**
 * 单实例租约、任务 fencing 与追赶收敛（「二实例/旧租约」「服务停止一天再启动」）。
 */

let context: TestDatabase;
let queue: JobQueue;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  context = createTestDatabase();
  queue = new JobQueue(context.db, 'owner-a', () => NOW);
});

afterEach(() => {
  context.close();
});

function seedRepoWithStream(): { repoId: number; streamId: number } {
  const repoId = insertRepository(context.db, 'owner/scheduled');
  context.db.$client.prepare("UPDATE repositories SET verification_state = 'verified' WHERE id = ?").run(repoId);
  const streamId = Number(
    context.db.$client
      .prepare(
        "INSERT INTO monitor_streams (repo_id, kind, phase_seed, next_due_at, config_revision) VALUES (?, 'metadata', 7, ?, 1)",
      )
      .run(repoId, NOW - 60_000).lastInsertRowid,
  );
  return { repoId, streamId };
}

describe('单实例调度租约', () => {
  it('已有实例持租约时拒绝第二个调度进程启动', () => {
    const first = acquireRuntimeLock(context.db, 'instance-a', NOW);
    expect(first.fence).toBe(1);
    expect(() => acquireRuntimeLock(context.db, 'instance-b', NOW)).toThrowError(RuntimeLockError);

    // 同一 owner 重新取得是允许的（进程内重启），并且 fence 递增。
    const again = acquireRuntimeLock(context.db, 'instance-a', NOW + 1000);
    expect(again.fence).toBe(2);
  });

  it('租约过期后可以接管，且旧 owner 无法再用旧 fence 续租', () => {
    const first = acquireRuntimeLock(context.db, 'instance-a', NOW);
    const later = NOW + RUNTIME_LOCK_LEASE_MS + 1000;
    const second = acquireRuntimeLock(context.db, 'instance-b', later);
    expect(second.fence).toBeGreaterThan(first.fence);

    expect(renewRuntimeLock(context.db, first, later)).toBe(false);
    expect(renewRuntimeLock(context.db, second, later)).toBe(true);
  });

  it('正常释放后其他实例可以立即启动', () => {
    const handle = acquireRuntimeLock(context.db, 'instance-a', NOW);
    releaseRuntimeLock(context.db, handle);
    expect(() => acquireRuntimeLock(context.db, 'instance-b', NOW)).not.toThrow();
  });
});

describe('任务租约与 fencing', () => {
  it('租约可续期，token 不匹配时拒绝续期', () => {
    const { streamId } = seedRepoWithStream();
    queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });
    const job = queue.claimNext();
    expect(job).not.toBeNull();
    const claimed = job as NonNullable<typeof job>;

    const before = context.client.prepare('SELECT lease_until FROM jobs WHERE id = ?').get(claimed.id) as {
      lease_until: number;
    };
    // 调度器每 30 秒本地续期；这里用同一个队列实例验证续期本身生效。
    expect(queue.renew(claimed.id, claimed.attemptToken ?? '')).toBe(true);
    const after = context.client.prepare('SELECT lease_until FROM jobs WHERE id = ?').get(claimed.id) as {
      lease_until: number;
    };
    expect(after.lease_until).toBeGreaterThanOrEqual(before.lease_until);

    // 另一个 owner 或旧 token 不能续期别人的任务。
    const other = new JobQueue(context.db, 'owner-b', () => NOW);
    expect(other.renew(claimed.id, claimed.attemptToken ?? '')).toBe(false);
    expect(queue.renew(claimed.id, 'stale-token')).toBe(false);
  });

  it('过期租约交回队列时更换 attempt_token，旧 token 不能再结束任务', () => {
    const { streamId } = seedRepoWithStream();
    queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });

    const first = queue.claimNext();
    expect(first).not.toBeNull();
    const staleJob = first as NonNullable<typeof first>;

    // 模拟租约到期：只改 lease_until 是不够的，必须换 token 才能防止旧回调写回。
    context.db.$client.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(NOW - 1, staleJob.id);
    expect(queue.releaseExpiredLeases()).toBe(1);

    const otherQueue = new JobQueue(context.db, 'owner-b', () => NOW);
    const second = otherQueue.claimNext();
    expect(second?.id).toBe(staleJob.id);
    expect(second?.attemptToken).not.toBe(staleJob.attemptToken);

    // 旧尝试认为自己还在跑，但提交会被拒（fencing）。
    expect(queue.isCurrentAttempt(staleJob)).toBe(false);
    expect(otherQueue.isCurrentAttempt(second as NonNullable<typeof second>)).toBe(true);

    // 旧 token 的 finish 不改变任何东西。
    queue.finish(staleJob, 'succeeded', null);
    const row = context.db.$client.prepare('SELECT state FROM jobs WHERE id = ?').get(staleJob.id) as {
      state: string;
    };
    expect(row.state).toBe('running');
  });

  it('未结束任务按 dedupe_key 合并；手动意图可以升级已有任务并带上暂停许可', () => {
    const { streamId } = seedRepoWithStream();
    const key = `stream:${String(streamId)}`;
    const first = queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW + 60_000,
      streamId,
      dedupeKey: key,
    });
    expect(first.reused).toBe(false);

    const upgraded = queue.enqueue({
      kind: 'metadata',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: NOW,
      streamId,
      dedupeKey: key,
      pauseOverride: true,
    });
    expect(upgraded.reused).toBe(true);
    expect(upgraded.jobId).toBe(first.jobId);

    const row = context.db.$client
      .prepare('SELECT origin, pause_override, due_at FROM jobs WHERE id = ?')
      .get(first.jobId) as { origin: string; pause_override: number; due_at: number };
    expect(row.origin).toBe('manual');
    expect(row.pause_override).toBe(1);
    expect(row.due_at).toBeLessThanOrEqual(NOW);
  });

  it('周期任务排除暂停仓库，显式单次检测不受用户暂停限制', () => {
    const { repoId, streamId } = seedRepoWithStream();
    context.db.$client.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(repoId);

    queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: 'periodic',
    });
    const pausedQueue = new JobQueue(context.db, 'owner-p', () => NOW);
    expect(pausedQueue.claimNext()).toBeNull();

    queue.enqueue({
      kind: 'metadata',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: NOW,
      streamId,
      pauseOverride: true,
      dedupeKey: 'manual',
    });
    expect(pausedQueue.claimNext()).not.toBeNull();
  });

  it('身份失配等系统阻塞对所有业务类任务生效，控制类任务不受影响', () => {
    const { repoId, streamId } = seedRepoWithStream();
    context.db.$client
      .prepare("UPDATE repositories SET blocked_reason = 'REPOSITORY_IDENTITY_CHANGED' WHERE id = ?")
      .run(repoId);

    queue.enqueue({
      kind: 'metadata',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: NOW,
      streamId,
      pauseOverride: true,
      dedupeKey: 'blocked-manual',
    });
    expect(queue.claimNext()).toBeNull();

    queue.enqueue({
      kind: 'token_verify',
      queueClass: 'control',
      origin: 'control',
      dueAt: NOW,
      operationId: null,
      dedupeKey: 'control',
    });
    expect(queue.claimNext()).not.toBeNull();
  });
});

describe('保留期与容量保护', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function insertFinishedJob(dedupeKey: string, finishedAt: number): number {
    const info = context.db.$client
      .prepare(
        `INSERT INTO jobs (kind, queue_class, origin, accepted_at, dedupe_key, state, created_at, finished_at)
         VALUES ('metadata', 'periodic', 'scheduler', ?, ?, 'succeeded', ?, ?)`,
      )
      .run(finishedAt, dedupeKey, finishedAt, finishedAt);
    return Number(info.lastInsertRowid);
  }

  it('超过保留期的已完成任务被清理，未完成任务不受影响', () => {
    const oldId = insertFinishedJob('old', NOW - 40 * DAY);
    const freshId = insertFinishedJob('fresh', NOW - 2 * DAY);
    const runningId = Number(
      context.db.$client
        .prepare(
          `INSERT INTO jobs (kind, queue_class, origin, accepted_at, state, created_at)
           VALUES ('metadata', 'periodic', 'scheduler', ?, 'running', ?)`,
        )
        .run(NOW, NOW).lastInsertRowid,
    );

    const removed = queue.purgeFinished(NOW, 30 * DAY, 100_000);
    expect(removed).toBe(1);

    const ids = (
      context.db.$client.prepare('SELECT id FROM jobs').all() as { id: number }[]
    ).map((row) => row.id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(freshId);
    expect(ids).toContain(runningId);
  });

  it('已完成任务超过容量上限时按最旧优先淘汰', () => {
    // ids[0] 最近、ids[3] 最旧。
    const ids = [1, 2, 3, 4].map((index) => insertFinishedJob(`k${String(index)}`, NOW - index * DAY));
    const removed = queue.purgeFinished(NOW, 365 * DAY, 2);
    expect(removed).toBe(2);

    const remaining = (
      context.db.$client.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: number }[]
    ).map((row) => row.id);
    expect(remaining).toEqual([ids[0], ids[1]]);
  });

  it('过期任务组连同逐项结果一起清理', () => {
    const repositoryService = new RepositoryService({ db: context.db, queue, now: () => NOW });
    repositoryService.importBatch('owner/keep\nnot a repo path with spaces/extra', null);
    const group = context.db.$client.prepare('SELECT id, created_at FROM job_groups LIMIT 1').get() as {
      id: number;
      created_at: number;
    };
    expect(
      (context.db.$client.prepare('SELECT COUNT(*) AS count FROM job_group_items WHERE group_id = ?').get(group.id) as {
        count: number;
      }).count,
    ).toBeGreaterThan(0);

    // 未过期时不动。
    expect(queue.purgeFinishedGroups(NOW, 30 * DAY)).toBe(0);
    expect(queue.purgeFinishedGroups(NOW + 40 * DAY, 30 * DAY)).toBe(1);
    expect(
      (context.db.$client.prepare('SELECT COUNT(*) AS count FROM job_group_items').get() as { count: number }).count,
    ).toBe(0);
  });
});

describe('追赶收敛', () => {
  it('到期的流只产生一个任务，重复调用不会叠加', () => {
    const { streamId } = seedRepoWithStream();
    const due = dueStreams(context.db, NOW, 10);
    expect(due.map((item) => item.streamId)).toContain(streamId);

    queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: `stream:${String(streamId)}`,
    });
    // 已有未结束任务时该流不再出现在到期集合里，避免重复请求。
    const again = dueStreams(context.db, NOW, 10);
    expect(again.map((item) => item.streamId)).not.toContain(streamId);
  });

  it('未验证仓库与暂停仓库不参与周期追赶', () => {
    const repoId = insertRepository(context.db, 'owner/pending');
    context.db.$client
      .prepare("INSERT INTO monitor_streams (repo_id, kind, phase_seed, next_due_at, config_revision) VALUES (?, 'metadata', 3, ?, 1)")
      .run(repoId, NOW - 1000);
    expect(dueStreams(context.db, NOW, 10).map((item) => item.repoId)).not.toContain(repoId);

    context.db.$client.prepare("UPDATE repositories SET verification_state = 'verified' WHERE id = ?").run(repoId);
    expect(dueStreams(context.db, NOW, 10).map((item) => item.repoId)).toContain(repoId);

    context.db.$client.prepare('UPDATE repositories SET enabled = 0 WHERE id = ?').run(repoId);
    expect(dueStreams(context.db, NOW, 10).map((item) => item.repoId)).not.toContain(repoId);
  });
});

// ---------------------------------------------------------------------------- 任务领取、重试与公平

describe('任务领取、重试与公平', () => {
  it('5xx 按 1/5/15 分钟退避，最多重试 3 次（初始尝试 + 3 次重试）', () => {
    let clock = NOW;
    const retryQueue = new JobQueue(context.db, 'retry-owner', () => clock);
    retryQueue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      dedupeKey: 'retry-job',
    });

    const backoffs: number[] = [];
    let attempts = 0;
    for (;;) {
      const job = retryQueue.claimNext();
      expect(job).not.toBeNull();
      const claimed = job as JobRow;
      attempts += 1;
      const result = retryQueue.retryOrFail(claimed, 'SERVICE_UNAVAILABLE');
      if (!result.retried) break;
      backoffs.push((result.dueAt ?? 0) - clock);
      clock = result.dueAt ?? clock;
    }

    // 第 4 次尝试（初始 + 3 次重试）仍失败才结束本轮。
    expect(attempts).toBe(4);
    expect(backoffs).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
    const row = context.db.$client.prepare('SELECT state, attempt, error_code FROM jobs').get() as {
      state: string;
      attempt: number;
      error_code: string | null;
    };
    expect(row).toMatchObject({ state: 'failed', attempt: 4, error_code: 'SERVICE_UNAVAILABLE' });
  });

  it('被 requeue 的常规领取不消耗手动公平额度', () => {
    const fairQueue = new JobQueue(context.db, 'fair-owner', () => NOW);
    const regularIds = [1, 2, 3].map(
      (index) =>
        fairQueue.enqueue({
          kind: 'metadata',
          queueClass: 'periodic',
          origin: 'scheduler',
          dueAt: NOW,
          dedupeKey: `regular-${String(index)}`,
        }).jobId,
    );
    const manualId = fairQueue.enqueue({
      kind: 'metadata',
      queueClass: 'manual',
      origin: 'manual',
      dueAt: NOW,
      pauseOverride: true,
      dedupeKey: 'manual-1',
    }).jobId;

    const first = fairQueue.claimNext() as JobRow;
    expect(first.id).toBe(regularIds[0]);
    // 未执行就入队（例如全局节奏还没到）：这次领取立刻回退，不算"真正执行"。
    fairQueue.requeue(first, NOW);

    // 每完成一个手动请求后至少三个常规请求真正执行：先执行完三个常规。
    for (const expected of regularIds) {
      const job = fairQueue.claimNext() as JobRow;
      expect(job.id).toBe(expected);
      fairQueue.finish(job, 'succeeded', null);
    }
    const manual = fairQueue.claimNext() as JobRow;
    expect(manual.id).toBe(manualId);
  });

  it('被 requeue 的领取不消耗重试阶梯', () => {
    const { jobId } = queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      dedupeKey: 'requeue-attempt',
    });
    // 全局节奏门/门禁未就绪会反复"领取-延后"；这些领取没有出站，不能把 1/5/15 分钟的
    // 重试额度吃光，否则第一次真实故障就会直接终态失败。
    for (let round = 0; round < 5; round += 1) {
      const job = queue.claimNext() as JobRow;
      expect(job.attempt).toBe(1);
      queue.requeue(job, NOW);
    }

    const job = queue.claimNext() as JobRow;
    const result = queue.retryOrFail(job, 'SERVICE_UNAVAILABLE');
    expect(result).toMatchObject({ retried: true, dueAt: NOW + 60_000 });
    const row = context.db.$client.prepare('SELECT attempt FROM jobs WHERE id = ?').get(jobId) as { attempt: number };
    expect(row.attempt).toBe(1);
  });

  it('业务门禁未就绪时只领取控制类任务', () => {
    const { streamId } = seedRepoWithStream();
    const business = queue.enqueue({
      kind: 'metadata',
      queueClass: 'periodic',
      origin: 'scheduler',
      dueAt: NOW,
      streamId,
      dedupeKey: 'business-job',
    });

    expect(queue.claimNext({ onlyControl: true })).toBeNull();
    const stillQueued = context.db.$client.prepare('SELECT state FROM jobs WHERE id = ?').get(business.jobId) as {
      state: string;
    };
    expect(stillQueued.state).toBe('queued');

    queue.enqueue({
      kind: 'token_verify',
      queueClass: 'control',
      origin: 'control',
      dueAt: NOW,
      dedupeKey: 'control-job',
    });
    expect(queue.claimNext({ onlyControl: true })?.kind).toBe('token_verify');
    // 不限定类别时业务任务照常可以领取。
    expect(queue.claimNext()?.id).toBe(business.jobId);
  });
});

// ---------------------------------------------------------------------------- 发现导入门禁

describe('发现导入门禁', () => {
  function readNextRun(): number | null {
    return (context.db.$client.prepare('SELECT discovery_next_run_at AS next FROM settings WHERE id = 1').get() as {
      next: number | null;
    }).next;
  }

  it('业务门禁未就绪时到点的导入顺延一小时；就绪后按下个窗口启动', () => {
    context.db.$client
      .prepare('UPDATE settings SET discovery_enabled = 1, discovery_next_run_at = ? WHERE id = 1')
      .run(NOW - 1000);

    expect(planDiscoverySchedule(context.db, NOW, false)).toBe('defer');
    expect(readNextRun()).toBe(NOW + HOUR_MS);
    // 顺延后不再每 tick 重写计划。
    expect(planDiscoverySchedule(context.db, NOW, false)).toBe('idle');
    expect(readNextRun()).toBe(NOW + HOUR_MS);

    // 修复后到点：推进到下一个窗口并启动。
    expect(planDiscoverySchedule(context.db, NOW + HOUR_MS, true)).toBe('start');
    const next = readNextRun();
    expect(next).not.toBeNull();
    expect(next ?? 0).toBeGreaterThan(NOW + HOUR_MS);
  });

  it('尚无活跃代次时首次导入不等每日窗口，失败后按重试间隔再试', () => {
    context.db.$client
      .prepare('UPDATE settings SET discovery_enabled = 1, discovery_next_run_at = NULL WHERE id = 1')
      .run();

    // 首次登记：还没有任何代次时按“尽快拿到第一份数据”的短延迟，而不是下个每日窗口。
    expect(planDiscoverySchedule(context.db, NOW, true)).toBe('idle');
    expect(readNextRun()).toBe(NOW + DISCOVERY_FIRST_RUN_DELAY_MS);

    // 到点启动，并先把计划推进到重试间隔：导入失败不会等到近 24 小时后。
    const dueAt = NOW + DISCOVERY_FIRST_RUN_DELAY_MS;
    expect(planDiscoverySchedule(context.db, dueAt, true)).toBe('start');
    expect(readNextRun()).toBe(dueAt + MINUTE_MS + DISCOVERY_RETRY_DELAY_MS);
  });

  it('已有活跃代次时回到每日窗口，不再用短延迟', () => {
    context.db.$client
      .prepare(
        `INSERT INTO discovery_runs (
           source_commit, source_manifest_json, parser_version, state, started_at, completed_at,
           source_updated_at, rows_total, rows_valid, error_code
         ) VALUES (?, '{}', 1, 'active', ?, ?, NULL, 0, 0, NULL)`,
      )
      .run('a'.repeat(40), NOW - HOUR_MS, NOW - HOUR_MS);
    const runId = (context.db.$client.prepare('SELECT id FROM discovery_runs').get() as { id: number }).id;
    context.db.$client
      .prepare('UPDATE settings SET discovery_enabled = 1, discovery_next_run_at = NULL, active_discovery_run_id = ? WHERE id = 1')
      .run(runId);

    expect(planDiscoverySchedule(context.db, NOW, true)).toBe('idle');
    const next = readNextRun() ?? 0;
    expect(next).toBeGreaterThan(NOW);
    // 每日窗口：最多等一天，且明显长于首次导入的短延迟。
    expect(next - NOW).toBeLessThanOrEqual(24 * HOUR_MS);
    expect(next - NOW).toBeGreaterThan(DISCOVERY_FIRST_RUN_DELAY_MS);
  });
});

// ---------------------------------------------------------------------------- 真实提交路径（runner）

/** 按路径匹配的假上游；支持同主机 301 跳转，用于改名跟随用例。 */
interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class FakeApiTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  readonly #routes: { path: string; search: string | null; response: () => FakeResponse }[] = [];
  #fallback: () => FakeResponse = () => ({ status: 404, body: { message: 'Not Found' } });

  on(fragment: string, response: FakeResponse | (() => FakeResponse)): void {
    const [path, search] = fragment.split('?');
    const resolvedPath = path ?? fragment;
    const resolvedSearch = search === undefined ? null : `?${search}`;
    const index = this.#routes.findIndex((route) => route.path === resolvedPath && route.search === resolvedSearch);
    if (index >= 0) this.#routes.splice(index, 1);
    this.#routes.push({
      path: resolvedPath,
      search: resolvedSearch,
      response: typeof response === 'function' ? response : () => response,
    });
  }

  setFallback(response: FakeResponse): void {
    this.#fallback = () => response;
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    return this.#handle(request, 0);
  }

  async #handle(request: TransportRequest, hops: number): Promise<TransportResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    const route = this.#routes.find(
      (entry) =>
        entry.path.toLowerCase() === url.pathname.toLowerCase() &&
        (entry.search === null || entry.search === url.search),
    );
    const response = route === undefined ? this.#fallback() : route.response();
    const location = response.headers?.['location'];
    // 与真实 transport 一致：白名单主机内的 301/302 自动跟随，最多 3 跳。
    if (response.status >= 300 && response.status < 400 && location !== undefined && hops < 3) {
      const next = new URL(location, url);
      return this.#handle({ ...request, url: next.toString() }, hops + 1);
    }
    return {
      status: response.status,
      headers: { 'content-type': 'application/json', ...response.headers },
      body: JSON.stringify(response.body ?? {}),
      bytes: 0,
      url: request.url,
    };
  }

  describe(): { mode: 'direct'; proxyScheme: null } {
    return { mode: 'direct', proxyScheme: null };
  }

  close(): void {
    // 无需释放。
  }
}

interface Harness {
  readonly context: TestDatabase;
  readonly client: SqliteDatabase;
  readonly queue: JobQueue;
  readonly credentials: CredentialService;
  readonly budget: RateBudget;
  readonly transport: FakeApiTransport;
  readonly repositoryService: RepositoryService;
  readonly scheduler: Scheduler;
  close(): void;
}

/** 用真实调度器 + 假上游驱动完整提交路径；凭证状态直接置为业务就绪（明显测试占位）。 */
function createHarness(now: () => number): Harness {
  const context = createTestDatabase();
  const db = context.db;
  const client = context.client;
  const appKey = Buffer.alloc(32, 7);
  const queue = new JobQueue(db, 'harness-owner', now);
  const credentials = new CredentialService({ db, appKey, now });
  const budget = new RateBudget(db, now);
  const transport = new FakeApiTransport();
  const github = new GithubClient({ db, transport, now });
  const repositoryService = new RepositoryService({ db, queue, now });
  const scheduler = new Scheduler(
    { db, queue, budget, client: github, transport, credentials, now, repositoryService },
    { ownerId: 'harness-owner' },
  );
  const encrypted = encryptSecret(appKey, PAT_SECRET_NAME, 'ghp_test-placeholder-token');
  // 候选激活前会复核发起会话与 admin_account.auth_version（改密撤销语义），
  // 夹具按生产不变量播种单例管理员行，否则会话永远判失效。
  client
    .prepare(
      `INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at)
       VALUES (1, 'admin', 'harness-placeholder-hash', 1, ?)`,
    )
    .run(now());
  client
    .prepare(
      `INSERT INTO secrets (name, ciphertext, nonce, auth_tag, key_version, revision)
       VALUES (?, ?, ?, ?, 1, 1)`,
    )
    .run(PAT_SECRET_NAME, encrypted.ciphertext, encrypted.nonce, encrypted.authTag);
  client
    .prepare(
      `UPDATE github_credential_status
          SET credential_state = 'valid', connectivity = 'reachable', token_type_hint = 'classic',
              last_verified_at = ?, last_authenticated_at = ?, configured_at = ?,
              last_error_code = NULL, next_verification_at = ?
        WHERE id = 1`,
    )
    .run(now(), now(), now(), now() + 60 * 60 * 1000);
  return {
    context,
    client,
    queue,
    credentials,
    budget,
    transport,
    repositoryService,
    scheduler,
    close: () => context.close(),
  };
}

function repoPayload(input: { id: string | number; fullName: string; defaultBranch?: string }): Record<string, unknown> {
  const [owner = '', name = ''] = input.fullName.split('/');
  return {
    id: input.id,
    full_name: input.fullName,
    name,
    owner: { login: owner, avatar_url: null },
    html_url: `https://github.com/${input.fullName}`,
    private: false,
    description: null,
    language: null,
    stargazers_count: 1,
    forks_count: 0,
    archived: false,
    default_branch: input.defaultBranch ?? 'main',
  };
}

function seedVerifiedRepo(harness: Harness, name: string, githubId: number, now: number): number {
  const repoId = insertRepository(harness.context.db, name, { githubId });
  harness.client
    .prepare(
      `UPDATE repositories SET verification_state = 'verified', identity_verified_at = ?, default_branch = 'main', reserved_until = NULL WHERE id = ?`,
    )
    .run(now, repoId);
  return repoId;
}

function insertHarnessStream(
  harness: Harness,
  repoId: number,
  kind: string,
  options: { branchId?: number | null; nextDueAt?: number } = {},
): number {
  const info = harness.client
    .prepare(
      `INSERT INTO monitor_streams (repo_id, kind, branch_id, next_due_at, phase_seed, config_revision)
       VALUES (?, ?, ?, ?, 7, 1)`,
    )
    .run(repoId, kind, options.branchId ?? null, options.nextDueAt ?? NOW);
  return Number(info.lastInsertRowid);
}

function insertFixedBranch(harness: Harness, repoId: number, name: string): number {
  const info = harness.client
    .prepare(
      `INSERT INTO tracked_branches (repo_id, mode, configured_name, resolved_name, enabled) VALUES (?, 'fixed', ?, ?, 1)`,
    )
    .run(repoId, name, name);
  return Number(info.lastInsertRowid);
}

async function runStreamJob(
  harness: Harness,
  spec: { kind: JobRow['kind']; streamId: number; now: number },
): Promise<JobRow> {
  harness.queue.enqueue({
    kind: spec.kind,
    queueClass: 'periodic',
    origin: 'scheduler',
    dueAt: spec.now,
    streamId: spec.streamId,
    dedupeKey: `stream:${String(spec.streamId)}`,
  });
  const job = harness.queue.claimNext();
  if (job === null) throw new Error('任务未被领取');
  await harness.scheduler.executeJob(job);
  return job;
}

function readStreamRow(
  harness: Harness,
  streamId: number,
): {
  initialized_at: number | null;
  current_projection_json: string | null;
  detected_change_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  next_due_at: number | null;
  branch_id: number | null;
} {
  return harness.client
    .prepare(
      `SELECT initialized_at, current_projection_json, detected_change_at, last_success_at, last_error_code, next_due_at, branch_id
         FROM monitor_streams WHERE id = ?`,
    )
    .get(streamId) as never;
}

describe('真实提交路径：导入验证、改名跟随与默认分支', () => {
  it('导入验证成功后创建默认分支行与分支流', async () => {
    const harness = createHarness(() => NOW);
    try {
      harness.transport.on('/repos/owner/newrepo', {
        status: 200,
        headers: { etag: 'W/"m1"' },
        body: repoPayload({ id: 1001, fullName: 'owner/newrepo', defaultBranch: 'main' }),
      });
      const batch = harness.repositoryService.importBatch('owner/newrepo', null);
      expect(batch.accepted).toBe(1);

      const job = harness.queue.claimNext();
      expect(job?.kind).toBe('metadata');
      await harness.scheduler.executeJob(job as JobRow);

      const repo = harness.client
        .prepare("SELECT id, verification_state FROM repositories WHERE canonical_name = 'owner/newrepo'")
        .get() as { id: number; verification_state: string };
      expect(repo.verification_state).toBe('verified');

      const branches = harness.client
        .prepare('SELECT * FROM tracked_branches WHERE repo_id = ?')
        .all(repo.id) as {
        id: number;
        mode: string;
        configured_name: string | null;
        resolved_name: string | null;
        enabled: number;
      }[];
      expect(branches).toHaveLength(1);
      expect(branches[0]).toMatchObject({
        mode: 'default',
        configured_name: null,
        resolved_name: 'main',
        enabled: 1,
      });

      const branchStream = readStreamRow(
        harness,
        Number(
          (
            harness.client
              .prepare("SELECT id FROM monitor_streams WHERE repo_id = ? AND kind = 'branch'")
              .get(repo.id) as { id: number }
          ).id,
        ),
      );
      expect(branchStream.branch_id).toBe(branches[0]?.id);
      // 新流按"未初始化"的新基线开始：首轮不产生更新提示。
      expect(branchStream.initialized_at).toBeNull();
      // 首轮检查在秒级确定性错峰内（首次初始化 3–4 个请求应在 10 秒级完成），
      // 不能被周期相位推到最长一个整周期之后。
      expect(branchStream.next_due_at).not.toBeNull();
      expect(branchStream.next_due_at ?? 0).toBeLessThanOrEqual(NOW + 10_000);

      // 再来一轮 metadata：已有 default 行时不重复插入。
      const metadataStreamId = (
        harness.client.prepare("SELECT id FROM monitor_streams WHERE repo_id = ? AND kind = 'metadata'").get(repo.id) as {
          id: number;
        }
      ).id;
      await runStreamJob(harness, { kind: 'metadata', streamId: metadataStreamId, now: NOW });
      const branchCount = harness.client
        .prepare("SELECT COUNT(*) AS count FROM tracked_branches WHERE repo_id = ? AND mode = 'default'")
        .get(repo.id) as { count: number };
      expect(branchCount.count).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('已有 20 个分支时不再强插 default 行（容量护栏不触发触发器 ABORT）', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/full', 1100, NOW);
      for (let index = 0; index < 20; index += 1) insertFixedBranch(harness, repoId, `b${String(index)}`);
      const streamId = insertHarnessStream(harness, repoId, 'metadata');
      harness.transport.on('/repos/owner/full', {
        status: 200,
        body: repoPayload({ id: 1100, fullName: 'owner/full' }),
      });

      const job = await runStreamJob(harness, { kind: 'metadata', streamId, now: NOW });
      const jobRow = harness.client.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string };
      expect(jobRow.state).toBe('succeeded');
      const defaults = harness.client
        .prepare("SELECT COUNT(*) AS count FROM tracked_branches WHERE repo_id = ? AND mode = 'default'")
        .get(repoId) as { count: number };
      expect(defaults.count).toBe(0);
      expect(readStreamRow(harness, streamId).last_success_at).toBe(NOW);
    } finally {
      harness.close();
    }
  });

  it('上游改名（301→200 新名、数字 ID 相同）跟随更新规范名；ID 不同暂停', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/old', 4242, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'metadata');
      harness.transport.on('/repos/owner/old', {
        status: 301,
        headers: { location: 'https://api.github.com/repos/owner/new' },
      });
      harness.transport.on('/repos/owner/new', {
        status: 200,
        headers: { etag: 'W/"n1"' },
        body: repoPayload({ id: 4242, fullName: 'owner/new' }),
      });

      await runStreamJob(harness, { kind: 'metadata', streamId, now: NOW });

      const repo = harness.client
        .prepare('SELECT canonical_name, blocked_reason FROM repositories WHERE id = ?')
        .get(repoId) as { canonical_name: string; blocked_reason: string | null };
      expect(repo.canonical_name).toBe('owner/new');
      expect(repo.blocked_reason).toBeNull();
      const stream = readStreamRow(harness, streamId);
      expect(stream.last_success_at).toBe(NOW);
      expect(stream.last_error_code).toBeNull();
      expect(harness.transport.requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/repos/owner/old',
        '/repos/owner/new',
      ]);

      // ID 不同：这是另一个仓库占用了旧名字，禁止自动换仓库。
      harness.transport.on('/repos/owner/new', {
        status: 200,
        headers: { etag: 'W/"n2"' },
        body: repoPayload({ id: 9999, fullName: 'owner/new' }),
      });
      const failed = await runStreamJob(harness, { kind: 'metadata', streamId, now: NOW });
      const after = harness.client
        .prepare('SELECT blocked_reason, canonical_name FROM repositories WHERE id = ?')
        .get(repoId) as { blocked_reason: string | null; canonical_name: string };
      expect(after.blocked_reason).toBe('REPOSITORY_IDENTITY_CHANGED');
      expect(after.canonical_name).toBe('owner/new');
      const jobRow = harness.client
        .prepare('SELECT state, error_code FROM jobs WHERE id = ?')
        .get(failed.id) as { state: string; error_code: string | null };
      expect(jobRow).toMatchObject({ state: 'failed', error_code: 'REPOSITORY_IDENTITY_CHANGED' });
    } finally {
      harness.close();
    }
  });

  it('超出安全整数或非十进制的 GitHub ID 不写库', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/badid', 1200, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'metadata');
      harness.transport.on('/repos/owner/badid', {
        status: 200,
        body: repoPayload({ id: '99999999999999999999', fullName: 'owner/badid' }),
      });

      const job = await runStreamJob(harness, { kind: 'metadata', streamId, now: NOW });
      const jobRow = harness.client
        .prepare('SELECT state, error_code FROM jobs WHERE id = ?')
        .get(job.id) as { state: string; error_code: string | null };
      expect(jobRow).toMatchObject({ state: 'failed', error_code: 'UPSTREAM_SCHEMA_CHANGED' });
      // 不写库：既有仓库行保持原 github_id，不被精度截断后的值覆盖。
      const repo = harness.client
        .prepare('SELECT github_id, canonical_name FROM repositories WHERE id = ?')
        .get(repoId) as { github_id: number | null; canonical_name: string };
      expect(repo.github_id).toBe(1200);
      expect(repo.canonical_name).toBe('owner/badid');
      expect(readStreamRow(harness, streamId).last_success_at).toBeNull();
    } finally {
      harness.close();
    }
  });
});

describe('真实提交路径：缓存基线与空结果', () => {
  it('删除分支后重新添加：http_cache 保留同键时新流首轮不被 304 卡住', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/readd', 5000, NOW);
      const branchId = insertFixedBranch(harness, repoId, 'dev');
      const streamId = insertHarnessStream(harness, repoId, 'branch', { branchId });

      // 分支删除前的缓存行仍在：同键、同凭证 revision、投影完好。
      const credentialRevision = harness.credentials.credentialRevision();
      const key = cacheKeyFor({
        path: '/repos/owner/readd/commits',
        query: { sha: 'dev', per_page: '1' },
        credentialRevision,
        token: null,
      });
      harness.client
        .prepare(
          `INSERT INTO http_cache (key, repo_id, etag, projection_json, validated_at, credential_revision, projection_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          repoId,
          'W/"old"',
          JSON.stringify({ sha: 'oldsha', committedAt: '2026-01-01T00:00:00Z', htmlUrl: 'x' }),
          NOW,
          credentialRevision,
          PROJECTION_VERSION,
        );

      // 服务端只在收到条件请求时返回 304，否则返回当前 HEAD。
      const commitPayload = {
        sha: 'newsha',
        commit: { committer: { date: '2026-02-01T00:00:00Z' } },
        html_url: 'https://github.com/owner/readd/commit/newsha',
      };
      harness.transport.on('/repos/owner/readd/commits', () => {
        const last = harness.transport.requests[harness.transport.requests.length - 1];
        if (last?.headers?.['if-none-match'] !== undefined) return { status: 304, body: {} };
        return { status: 200, headers: { etag: 'W/"new"' }, body: [commitPayload] };
      });

      await runStreamJob(harness, { kind: 'branch', streamId, now: NOW });

      // 基线缺失时必须无条件取实体投影：首轮不得携带校验器，否则 304 会让流停在未初始化。
      const commits = harness.transport.requests.filter((request) => request.url.includes('/commits'));
      expect(commits).toHaveLength(1);
      expect(commits[0]?.headers?.['if-none-match']).toBeUndefined();
      const stream = readStreamRow(harness, streamId);
      expect(stream.initialized_at).toBe(NOW);
      expect(JSON.parse(stream.current_projection_json ?? '{}')).toMatchObject({ sha: 'newsha' });
      expect(stream.last_error_code).toBeNull();

      // 已有基线后恢复条件请求：命中 304 只更新时间，不清基线。
      await runStreamJob(harness, { kind: 'branch', streamId, now: NOW });
      const commitsAgain = harness.transport.requests.filter((request) => request.url.includes('/commits'));
      expect(commitsAgain[1]?.headers?.['if-none-match']).toBe('W/"new"');
      const after = readStreamRow(harness, streamId);
      expect(after.initialized_at).toBe(NOW);
      expect(after.current_projection_json).toContain('newsha');
    } finally {
      harness.close();
    }
  });

  it('空分支（空数组或 409）写空基线而不是上游异常，变化标记只记一次', async () => {
    let clock = NOW;
    const harness = createHarness(() => clock);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/empty', 6000, NOW);
      const branchId = insertFixedBranch(harness, repoId, 'dev');
      const streamId = insertHarnessStream(harness, repoId, 'branch', { branchId });
      // 此前有 HEAD 投影：确定变空时属于一次状态变化。
      harness.client
        .prepare(
          `UPDATE monitor_streams SET initialized_at = ?, current_projection_json = ?, detected_change_at = ? WHERE id = ?`,
        )
        .run(
          NOW - 1000,
          JSON.stringify({ sha: 'old', committedAt: '2026-01-01T00:00:00Z', htmlUrl: 'x' }),
          NOW - 500,
          streamId,
        );

      // 情况一：200 + 空数组（EmptyBranchError 由客户端透出 BRANCH_EMPTY）。
      harness.transport.on('/repos/owner/empty/commits', {
        status: 200,
        headers: { etag: 'W/"e1"' },
        body: [],
      });
      await runStreamJob(harness, { kind: 'branch', streamId, now: clock });
      let stream = readStreamRow(harness, streamId);
      expect(stream.current_projection_json).toBeNull();
      expect(stream.last_success_at).toBe(NOW);
      expect(stream.last_error_code).toBeNull();
      expect(stream.detected_change_at).toBe(NOW);

      // 下一轮仍为空：7 天变化标记不被每轮刷新。
      clock = NOW + 2 * HOUR_MS;
      await runStreamJob(harness, { kind: 'branch', streamId, now: clock });
      stream = readStreamRow(harness, streamId);
      expect(stream.detected_change_at).toBe(NOW);
      expect(stream.last_success_at).toBe(clock);

      // 情况二：409（GitHub 对空仓库的 commits 返回 409）同样按"确定为空"处理。
      const repo2 = seedVerifiedRepo(harness, 'owner/empty2', 6001, clock);
      const branch2 = insertFixedBranch(harness, repo2, 'dev');
      const stream2 = insertHarnessStream(harness, repo2, 'branch', { branchId: branch2 });
      harness.transport.on('/repos/owner/empty2/commits', {
        status: 409,
        body: { message: 'Git Repository is empty.' },
      });
      await runStreamJob(harness, { kind: 'branch', streamId: stream2, now: clock });
      const second = readStreamRow(harness, stream2);
      expect(second.current_projection_json).toBeNull();
      expect(second.initialized_at).toBe(clock);
      expect(second.last_success_at).toBe(clock);
      expect(second.last_error_code).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('latest 404 且无预发布流：同轮补一次列表确认，窗口内无正式发布则写空基线', async () => {
    let clock = NOW;
    const harness = createHarness(() => clock);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/norelease', 7000, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'release');
      // 上一轮曾有 latest 投影，本轮 latest 404 后经列表确认变空。
      harness.client
        .prepare(
          `UPDATE monitor_streams SET initialized_at = ?, current_projection_json = ?, detected_change_at = ?, last_error_code = 'LATEST_NOT_FOUND' WHERE id = ?`,
        )
        .run(
          NOW - 10 * HOUR_MS,
          JSON.stringify({
            id: '1',
            tagName: 'v1',
            name: 'v1',
            publishedAt: '2026-01-01T00:00:00Z',
            prerelease: false,
            draft: false,
            htmlUrl: 'x',
          }),
          NOW - 10 * HOUR_MS,
          streamId,
        );

      harness.transport.on('/repos/owner/norelease/releases/latest', { status: 404, body: { message: 'Not Found' } });
      // 与 GitHub 一致：列表带校验器且内容未变时返回 304。
      harness.transport.on('/repos/owner/norelease/releases?per_page=20&page=1', () => {
        const last = harness.transport.requests[harness.transport.requests.length - 1];
        if (last?.headers?.['if-none-match'] !== undefined) return { status: 304, body: {} };
        return { status: 200, headers: { etag: 'W/"list-1"' }, body: [] };
      });

      await runStreamJob(harness, { kind: 'release', streamId, now: clock });

      // 本轮 latest 已 404：列表请求恰好一次。
      const listRequests = harness.transport.requests.filter((request) => request.url.includes('/releases?'));
      expect(listRequests).toHaveLength(1);

      let stream = readStreamRow(harness, streamId);
      expect(stream.current_projection_json).toBeNull();
      expect(stream.last_error_code).toBeNull();
      expect(stream.last_success_at).toBe(NOW);
      // 曾有 latest、现在确定为空：记录一次性状态变化。
      expect(stream.detected_change_at).toBe(NOW);

      // 下一轮确认仍为空：变化标记不被刷新。
      clock = NOW + 3 * HOUR_MS;
      await runStreamJob(harness, { kind: 'release', streamId, now: clock });
      stream = readStreamRow(harness, streamId);
      expect(stream.detected_change_at).toBe(NOW);
      expect(stream.last_success_at).toBe(clock);
      expect(stream.last_error_code).toBeNull();
      // 确认判定必须拿到本轮窗口数据：第二轮也不携带校验器，避免被 304 卡住待确认标记。
      const listRequestsAgain = harness.transport.requests.filter((request) => request.url.includes('/releases?'));
      expect(listRequestsAgain).toHaveLength(2);
      expect(listRequestsAgain[1]?.headers?.['if-none-match']).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it('latest 404 的列表确认在窗口内发现正式发布：标记上游异常，不自行提升为 latest', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/haspub', 7100, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'release');
      harness.transport.on('/repos/owner/haspub/releases/latest', { status: 404, body: { message: 'Not Found' } });
      harness.transport.on('/repos/owner/haspub/releases?per_page=20&page=1', {
        status: 200,
        body: [
          {
            id: 9,
            tag_name: 'v9',
            name: 'v9',
            published_at: '2026-03-01T00:00:00Z',
            prerelease: false,
            draft: false,
            html_url: 'https://github.com/owner/haspub/releases/tag/v9',
          },
        ],
      });

      await runStreamJob(harness, { kind: 'release', streamId, now: NOW });

      const stream = readStreamRow(harness, streamId);
      expect(stream.last_error_code).toBe('UPSTREAM_SCHEMA_CHANGED');
      // 不写基线，也不自行把窗口内的正式发布提升为 latest。
      expect(stream.current_projection_json).toBeNull();
      expect(stream.initialized_at).toBeNull();
      expect(stream.next_due_at).toBe(NOW + 24 * HOUR_MS);
    } finally {
      harness.close();
    }
  });
});

describe('真实提交路径：限流、导入释放与维护', () => {
  it('限流响应：Retry-After 与配额 reset 取较晚时间，并记录 Date 头时钟偏差', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/limited', 8000, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'release');
      harness.transport.on('/repos/owner/limited/releases/latest', {
        status: 403,
        headers: {
          'retry-after': '120',
          date: new Date(NOW + 30_000).toUTCString(),
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 60),
          'x-ratelimit-resource': 'core',
        },
        body: { message: 'rate limited' },
      });

      const job = await runStreamJob(harness, { kind: 'release', streamId, now: NOW });

      // reset 在 60 秒后、Retry-After 是 120 秒：退避必须取较晚的 120 秒。
      expect(harness.budget.backoffUntil()).toBeGreaterThanOrEqual(NOW + 120_000);
      // 响应 Date 头用于校正宿主时钟偏差（这里本地时钟慢 30 秒）。
      expect(harness.budget.clockSkewMs).toBe(30_000);
      expect(readStreamRow(harness, streamId).last_error_code).toBe('GITHUB_RATE_LIMITED');
      const jobRow = harness.client.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string };
      expect(jobRow.state).toBe('retry_wait');
    } finally {
      harness.close();
    }
  });

  it('导入 404 仓库：占位立即释放、批次项为 denied_or_missing、名额可复用', async () => {
    const harness = createHarness(() => NOW);
    try {
      const batch = harness.repositoryService.importBatch('owner/gone', null);
      expect(batch.accepted).toBe(1);
      const job = harness.queue.claimNext();
      expect(job?.kind).toBe('metadata');
      await harness.scheduler.executeJob(job as JobRow);

      expect(
        (harness.client.prepare('SELECT COUNT(*) AS count FROM repositories').get() as { count: number }).count,
      ).toBe(0);
      const item = harness.client
        .prepare('SELECT status, error_code, repo_id FROM job_group_items WHERE group_id = ?')
        .get(batch.groupId) as { status: string; error_code: string | null; repo_id: number | null };
      expect(item).toMatchObject({
        status: 'failed',
        error_code: 'GITHUB_ACCESS_DENIED_OR_MISSING',
        repo_id: null,
      });
      expect(harness.repositoryService.importProgress(batch.groupId)?.items[0]?.status).toBe('denied_or_missing');

      // 占位删除后名额立即可复用。
      const again = harness.repositoryService.importBatch('owner/fine', null);
      expect(again.accepted).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('维护周期持久化凭证到期边界并递增门禁版本，且幂等', async () => {
    const harness = createHarness(() => NOW);
    try {
      harness.client
        .prepare(
          `UPDATE github_credential_status SET expires_at = ?, next_verification_at = ? WHERE id = 1`,
        )
        .run(NOW - 1, NOW - 1);
      const before = (
        harness.client.prepare('SELECT gate_revision AS revision FROM github_credential_status WHERE id = 1').get() as {
          revision: number;
        }
      ).revision;

      await harness.scheduler.runMaintenance(NOW);

      const row = harness.client
        .prepare(
          'SELECT credential_state, gate_revision, next_verification_at FROM github_credential_status WHERE id = 1',
        )
        .get() as { credential_state: string; gate_revision: number; next_verification_at: number | null };
      expect(row.credential_state).toBe('expired');
      expect(row.gate_revision).toBe(before + 1);
      expect(row.next_verification_at).toBe(NOW);

      // 幂等：已持久化后再次维护不再重复递增门禁版本。
      await harness.scheduler.runMaintenance(NOW);
      const after = harness.client
        .prepare('SELECT gate_revision AS revision FROM github_credential_status WHERE id = 1')
        .get() as { revision: number };
      expect(after.revision).toBe(row.gate_revision);
    } finally {
      harness.close();
    }
  });
});

describe('预发布 304 确认、默认分支不复活、孤儿控制任务与确认节奏门', () => {
  it('预发布流的 304 同样消解 latest 404 待确认：只发预发布的仓库不再永久 partial', async () => {
    let clock = NOW;
    const harness = createHarness(() => clock);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/pronly', 7300, NOW);
      harness.client
        .prepare('UPDATE repositories SET release_enabled = 1, include_prereleases = 1 WHERE id = ?')
        .run(repoId);
      const releaseStream = insertHarnessStream(harness, repoId, 'release');
      const prereleaseStream = insertHarnessStream(harness, repoId, 'prerelease');
      // release 流曾有 latest 投影（已初始化），本轮 latest 404 后需要列表确认。
      harness.client
        .prepare('UPDATE monitor_streams SET initialized_at = ?, current_projection_json = ? WHERE id = ?')
        .run(
          NOW - 10 * HOUR_MS,
          JSON.stringify({
            id: '1',
            tagName: 'v1',
            name: 'v1',
            publishedAt: '2026-01-01T00:00:00Z',
            prerelease: false,
            draft: false,
            htmlUrl: 'x',
          }),
          releaseStream,
        );

      harness.transport.on('/repos/owner/pronly/releases/latest', { status: 404, body: { message: 'Not Found' } });
      harness.transport.on('/repos/owner/pronly/releases?per_page=20&page=1', () => {
        const last = harness.transport.requests[harness.transport.requests.length - 1];
        if (last?.headers?.['if-none-match'] !== undefined) return { status: 304, body: {} };
        return {
          status: 200,
          headers: { etag: 'W/"prlist"' },
          body: [
            {
              id: 91,
              tag_name: 'v0.1.0-rc.1',
              name: 'v0.1.0-rc.1',
              published_at: '2026-01-02T00:00:00Z',
              prerelease: true,
              draft: false,
              html_url: 'https://github.com/owner/pronly/releases/tag/v0.1.0-rc.1',
            },
          ],
        };
      });

      // 轮 1：预发布 200（建立缓存与基线；此刻尚无待确认标记）。
      await runStreamJob(harness, { kind: 'prerelease', streamId: prereleaseStream, now: clock });
      // latest 404：有预发布流，同轮不发列表，只挂 LATEST_NOT_FOUND 待确认。
      await runStreamJob(harness, { kind: 'release', streamId: releaseStream, now: clock });
      expect(readStreamRow(harness, releaseStream).last_error_code).toBe('LATEST_NOT_FOUND');
      expect(harness.transport.requests.filter((request) => request.url.includes('/releases?'))).toHaveLength(1);

      // 轮 2：预发布 304——确认此前只挂在 200 路径，列表稳定后待确认会永久停摆。
      clock = NOW + 3 * HOUR_MS;
      await runStreamJob(harness, { kind: 'prerelease', streamId: prereleaseStream, now: clock });
      const release = readStreamRow(harness, releaseStream);
      expect(release.last_error_code).toBeNull();
      expect(release.current_projection_json).toBeNull();
      expect(release.last_success_at).toBe(clock);
    } finally {
      harness.close();
    }
  });

  it('已验证仓库的 metadata 成功不补建默认分支行：用户删除的配置不被周期任务还原', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/nodefault', 7301, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'metadata');
      harness.transport.on('/repos/owner/nodefault', {
        status: 200,
        body: repoPayload({ id: 7301, fullName: 'owner/nodefault' }),
      });
      await runStreamJob(harness, { kind: 'metadata', streamId, now: NOW });
      const defaults = harness.client
        .prepare("SELECT COUNT(*) AS count FROM tracked_branches WHERE repo_id = ? AND mode = 'default'")
        .get(repoId) as { count: number };
      expect(defaults.count).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('候选操作被级联删除后的遗留控制任务不串到活动凭证验证', async () => {
    const harness = createHarness(() => NOW);
    try {
      const created = createSession(harness.context.db, Buffer.alloc(32, 7), {
        authVersion: 1,
        rememberMe: false,
        now: NOW,
      });
      // submitToken 只消费 id 与 authVersion；这里补全 SessionRow 形状。
      const session = {
        id: created.id,
        authVersion: 1,
        csrfNonce: 'test-nonce',
        rememberMe: false,
        createdAt: NOW,
        lastSeenAt: NOW,
        expiresAt: created.expiresAt,
      } as const;
      const operationId = harness.credentials.submitToken(session, 'ghp_orphan_candidate_token');
      harness.queue.enqueue({
        kind: 'token_verify',
        queueClass: 'control',
        origin: 'manual',
        dueAt: NOW,
        operationId,
        dedupeKey: `operation:${String(operationId)}`,
      });
      // 发起会话撤销 → pending_operations 级联删除 → jobs.operation_id 被 FK 置 NULL。
      harness.client.prepare('DELETE FROM sessions').run();
      const job = harness.queue.claimNext();
      expect(job).not.toBeNull();
      expect(job?.operationId).toBeNull();
      expect(job?.dedupeKey).toBe(`operation:${String(operationId)}`);
      await harness.scheduler.executeJob(job as JobRow);
      // 没有任何上游请求：候选已销毁，也绝不转成活动凭证的 /user 验证。
      expect(harness.transport.requests).toHaveLength(0);
      const row = harness.client.prepare('SELECT state FROM jobs WHERE id = ?').get((job as JobRow).id) as {
        state: string;
      };
      expect(row.state).toBe('succeeded');
    } finally {
      harness.close();
    }
  });

  it('预算耗尽时同轮列表确认让位：不发第二个请求，待确认标记保留到下一轮', async () => {
    const harness = createHarness(() => NOW);
    try {
      const repoId = seedVerifiedRepo(harness, 'owner/paced', 7302, NOW);
      const streamId = insertHarnessStream(harness, repoId, 'release');
      harness.client
        .prepare('UPDATE monitor_streams SET initialized_at = ? WHERE id = ?')
        .run(NOW - HOUR_MS, streamId);
      harness.transport.on('/repos/owner/paced/releases/latest', { status: 404, body: { message: 'Not Found' } });
      harness.transport.on('/repos/owner/paced/releases?per_page=20&page=1', { status: 200, body: [] });

      // 上一个响应已把配额耗尽：next_request_at 被推到 reset 之后。
      harness.budget.observe({
        resource: 'core',
        limit: 5000,
        remaining: 0,
        resetAt: Date.now() + 60 * 60 * 1000,
        observedAt: Date.now(),
      });

      await runStreamJob(harness, { kind: 'release', streamId, now: NOW });
      const urls = harness.transport.requests.map((request) => request.url);
      expect(urls.filter((url) => url.includes('/releases/latest'))).toHaveLength(1);
      expect(urls.some((url) => url.includes('/releases?'))).toBe(false);
      expect(readStreamRow(harness, streamId).last_error_code).toBe('LATEST_NOT_FOUND');
    } finally {
      harness.close();
    }
  });

  it('真实调度循环执行提交的候选验证：领取-重排不再互相踩踏（本机部署暴露的缺陷）', async () => {
    const harness = createHarness(() => Date.now());
    try {
      harness.transport.on('/user', { status: 200, body: { id: 777, login: 'octocat' } });
      harness.scheduler.start();
      const created = createSession(harness.context.db, Buffer.alloc(32, 7), {
        authVersion: 1,
        rememberMe: false,
        now: Date.now(),
      });
      // submitToken 只消费 id 与 authVersion；这里补全 SessionRow 形状。
      const session = {
        id: created.id,
        authVersion: 1,
        csrfNonce: 'loop-nonce',
        rememberMe: false,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: created.expiresAt,
      } as const;
      const operationId = harness.credentials.submitToken(session, 'ghp_loop_candidate');
      harness.queue.enqueue({
        kind: 'token_verify',
        queueClass: 'control',
        origin: 'manual',
        dueAt: Date.now(),
        operationId,
        dedupeKey: `operation:${String(operationId)}`,
      });
      harness.scheduler.notify();

      // 修复前：所有节奏门空闲时 dispatchAt 恒为"几毫秒后的现在"（#nextDispatchAt
      // 自己再读了一次时钟），任务被无限领取→重排→再睡一个唤醒间隔，
      // 操作永远停在 pending——即设置页"保存并验证"一直显示等待中。
      const deadline = Date.now() + 8000;
      let status = 'pending';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const operation = harness.credentials.readOperation(operationId);
        status = operation?.status ?? 'missing';
        if (status !== 'pending' && status !== 'running') break;
      }
      expect(status).toBe('succeeded');
      expect(harness.credentials.status().state).toBe('valid');
      expect(harness.transport.requests.some((request) => request.url.endsWith('/user'))).toBe(true);
    } finally {
      await harness.scheduler.stop();
      harness.close();
    }
  });
});
