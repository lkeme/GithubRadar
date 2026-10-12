import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceDueAt,
  applyBaseline,
  classifyStatus,
  compareNumericId,
  initialDueAt,
  parseTokenExpiration,
  phaseSeedFor,
  plannedCapacity,
  reservedBudget,
  RateBudget,
  type StreamRow,
} from '@githubradar/server';

import { createTestDatabase, type TestDatabase } from '../integration/support.js';

const HOUR = 60 * 60 * 1000;

describe('相位规划', () => {
  it('相位种子对同一仓库稳定，不同仓库几乎不碰撞', () => {
    expect(phaseSeedFor(42)).toBe(phaseSeedFor(42));
    expect(phaseSeedFor(42)).not.toBe(phaseSeedFor(43));
    expect(phaseSeedFor(0)).toBeGreaterThanOrEqual(0);
  });

  it('按原计划相位推进，不按完成时间漂移，也不补执行全部错过的周期', () => {
    const due = 1_000_000;
    // 提前完成不改变相位。
    expect(advanceDueAt(due, HOUR, due - 1000)).toBe(due);
    // 错过 3 个周期只前进到下一个相位。
    const now = due + 3 * HOUR + 60_000;
    expect(advanceDueAt(due, HOUR, now)).toBe(due + 4 * HOUR);
  });

  it('首次入队落在当前时间之后、一个周期之内', () => {
    const now = 1_700_000_000_000;
    for (const seed of [1, 77, 4242, 999_999]) {
      const due = initialDueAt(seed, now, 24 * HOUR);
      expect(due).toBeGreaterThanOrEqual(now);
      expect(due).toBeLessThanOrEqual(now + 24 * HOUR);
    }
  });

  it('60%/20% 预算切分', () => {
    expect(plannedCapacity(5000)).toBe(3000);
    expect(reservedBudget(5000)).toBe(1000);
    expect(plannedCapacity(null)).toBeNull();
  });
});

describe('基线状态机', () => {
  const stream = (overrides: Partial<StreamRow> = {}): StreamRow => ({
    id: 1,
    repoId: 1,
    kind: 'branch',
    branchId: 1,
    initializedAt: null,
    projectionJson: null,
    detectedChangeAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    configRevision: 1,
    nextDueAt: null,
    ...overrides,
  });

  it('未初始化时保存基线但不提示更新', () => {
    const result = applyBaseline(stream(), { sha: 'aaa' }, 1000);
    expect(result.initialized).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.detectedChangeAt).toBeNull();
  });

  it('相同 SHA 只更新时间，不延长变化标记', () => {
    const existing = stream({
      initializedAt: 1,
      projectionJson: JSON.stringify({ sha: 'aaa' }),
      detectedChangeAt: 500,
    });
    const result = applyBaseline(existing, { sha: 'aaa' }, 2000);
    expect(result.changed).toBe(false);
    expect(result.detectedChangeAt).toBe(500);
  });

  it('不同 SHA 视为分支变化，包括回退与 force-push', () => {
    const existing = stream({ initializedAt: 1, projectionJson: JSON.stringify({ sha: 'aaa' }) });
    const result = applyBaseline(existing, { sha: 'bbb' }, 2000);
    expect(result.changed).toBe(true);
    expect(result.detectedChangeAt).toBe(2000);
  });

  it('Release 以 ID 与 tag_name 判断变化，标题修改不触发', () => {
    const existing = stream({
      kind: 'release',
      branchId: null,
      initializedAt: 1,
      projectionJson: JSON.stringify({
        id: '10',
        tagName: 'v1.0.0',
        name: 'old title',
        publishedAt: '2026-01-01T00:00:00Z',
        prerelease: false,
        draft: false,
        htmlUrl: 'https://github.com/o/r/releases/tag/v1.0.0',
      }),
    });

    const titleOnly = applyBaseline(
      existing,
      { id: '10', tagName: 'v1.0.0', name: 'new title', publishedAt: '2026-01-01T00:00:00Z', prerelease: false, draft: false, htmlUrl: 'x' },
      3000,
    );
    expect(titleOnly.changed).toBe(false);

    const retagged = applyBaseline(
      existing,
      { id: '11', tagName: 'v2.0.0', name: 'v2', publishedAt: '2026-02-01T00:00:00Z', prerelease: false, draft: false, htmlUrl: 'x' },
      3000,
    );
    expect(retagged.changed).toBe(true);
  });

  it('损坏的既有投影不会让判定抛错，而是按变化处理', () => {
    const existing = stream({ initializedAt: 1, projectionJson: '{not json' });
    const result = applyBaseline(existing, { sha: 'ccc' }, 4000);
    expect(result.changed).toBe(true);
  });
});

describe('数字 ID 比较', () => {
  it('超过安全整数范围时按文本长度与字典序比较', () => {
    expect(compareNumericId('9', '10')).toBe(-1);
    expect(compareNumericId('10', '9')).toBe(1);
    expect(compareNumericId('90071992547409910', '9007199254740999')).toBe(1);
    expect(compareNumericId('123', '123')).toBe(0);
    expect(compareNumericId('007', '7')).toBe(0);
  });
});

describe('凭证到期头与状态分类', () => {
  it('只识别带明确时区的到期时间，其余记为未知', () => {
    expect(parseTokenExpiration('2026-11-01 12:00:00 UTC')).toBe(Date.UTC(2026, 10, 1, 12, 0, 0));
    expect(parseTokenExpiration('2026-11-01T12:00:00Z')).toBeNull();
    expect(parseTokenExpiration('2026-11-01')).toBeNull();
    expect(parseTokenExpiration('')).toBeNull();
  });

  it('401、429、非限流 403、404 与 5xx 分类正确', () => {
    expect(classifyStatus(401, {}).errorCode).toBe('GITHUB_TOKEN_INVALID');
    expect(classifyStatus(429, {}).errorCode).toBe('GITHUB_RATE_LIMITED');
    expect(classifyStatus(403, { 'x-ratelimit-remaining': '0' }).errorCode).toBe('GITHUB_RATE_LIMITED');
    expect(classifyStatus(403, { 'retry-after': '30' }).errorCode).toBe('GITHUB_RATE_LIMITED');
    expect(classifyStatus(403, {}).errorCode).toBe('GITHUB_ACCESS_DENIED_OR_MISSING');
    expect(classifyStatus(404, {}).errorCode).toBe('GITHUB_ACCESS_DENIED_OR_MISSING');
    expect(classifyStatus(503, {}).retryable).toBe(true);
  });
});

describe('出站配额节奏', () => {
  let context: TestDatabase;
  let budget: RateBudget;

  beforeEach(() => {
    context = createTestDatabase();
    budget = new RateBudget(context.db, () => Date.now());
  });

  afterEach(() => {
    context.close();
  });

  it('U=0 时等到 reset，而不是继续请求', () => {
    const now = Date.now();
    budget.observe({
      resource: 'core',
      limit: 5000,
      remaining: 0,
      resetAt: now + 30 * 60 * 1000,
      observedAt: now,
    });
    expect(budget.nextRequestAt()).toBeGreaterThanOrEqual(now + 30 * 60 * 1000 - 1);
  });

  it('请求起始间隔为 max(1秒, W/U)，不叠加按小时估算的全局间隔', () => {
    const now = Date.now();
    budget.observe({
      resource: 'core',
      limit: 5000,
      remaining: 4000,
      resetAt: now + 3600 * 1000,
      observedAt: now,
    });
    // usable = 4000 - 1000 = 3000，W=3600s → 间隔约 1.2 秒，远小于 3600/请求数。
    const interval = budget.nextRequestAt() - now;
    expect(interval).toBeGreaterThanOrEqual(1000);
    expect(interval).toBeLessThan(5000);
  });

  it('次级限流至少退避 60 秒且不超过 1 小时', () => {
    budget.applySecondaryBackoff();
    const backoff = budget.backoffUntil() - Date.now();
    expect(backoff).toBeGreaterThanOrEqual(60_000);
    expect(backoff).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  it('真实 remaining=0 时不能动用保留额度；仍有余额时修复请求可用保留额度', () => {
    const now = Date.now();
    budget.observe({ resource: 'core', limit: 5000, remaining: 0, resetAt: now + 600_000, observedAt: now });
    expect(budget.canUseReservedBudget()).toBe(false);
    // 剩余 300 < 保留 1000：业务节奏等到 reset，但修复类控制请求不被保留阈值锁死。
    budget.observe({ resource: 'core', limit: 5000, remaining: 300, resetAt: now + 600_000, observedAt: now });
    expect(budget.canUseReservedBudget()).toBe(true);
  });

  it('Retry-After 与 reset 取较晚时间', () => {
    const now = Date.now();
    budget.observe({ resource: 'core', limit: 5000, remaining: 100, resetAt: now + 600_000, observedAt: now });
    budget.applyRetryAfter('60');
    expect(budget.backoffUntil()).toBeGreaterThanOrEqual(now + 600_000 - 1);
  });

  it('响应头缺失时保留最近可信状态并按最坏一次计费', () => {
    const now = Date.now();
    budget.observe({ resource: 'core', limit: 5000, remaining: 100, resetAt: now + 600_000, observedAt: now });
    budget.observe(null);
    expect(budget.state().remaining).toBe(100);
  });
});
