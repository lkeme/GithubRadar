import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DailyTrendQuery,
  DailyTrendResponse,
  DAILY_TREND_STATS_NOTE,
  TRENDS_MAX_PAGE,
} from '@githubradar/contracts';

import {
  createTestDatabase,
  TEST_NOW,
  type TestDatabase,
} from './support.js';
import {
  isTrendReportStale,
  parseTrendReport,
  readTrends,
  runTrendsImport,
  TrendsAdapter,
  TrendsSourceError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@githubradar/server';

/**
 * 每日趋势：报告解析、导入编排与公开读取。
 *
 * 全部使用假 transport 提供固定报告文本，不访问真实网络；
 * 数据库是真实临时 SQLite（迁移由 createTestDatabase 执行）。
 */

const SOURCE_REPO = 'difyz9/github-trend-monitor';
const COMMIT = 'b'.repeat(40);

const HEADERS = '| Repository | Stars | Domain |\n| --- | ---: | --- |\n';

function reportMarkdown(rows: readonly { name: string; stars: number; domain?: string }[]): string {
  const body = rows
    .map((row) => `| [${row.name}](https://github.com/${row.name}) | ${String(row.stars)} | ${row.domain ?? 'AI Agent'} |`)
    .join('\n');
  return `# GitHub AI Trend Daily Report\n\nGenerated: 2026-10-24 01:30 UTC\n\n## Top Repositories\n\n${HEADERS}${body}\n`;
}

/** 报告清单 + 各报告文本的假上游。 */
class TrendTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  reports = new Map<string, string>();
  failDays = new Set<string>();
  headSha = COMMIT;
  truncateTree = false;

  setReports(reports: Record<string, readonly { name: string; stars: number; domain?: string }[]>): void {
    this.reports = new Map(
      Object.entries(reports).map(([day, rows]) => [day, reportMarkdown(rows)]),
    );
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    const respond = (status: number, body: unknown): Promise<TransportResponse> =>
      Promise.resolve({
        status,
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        bytes: 0,
        url: request.url,
      });

    if (url.pathname === `/repos/${SOURCE_REPO}/commits/HEAD`) {
      return respond(200, { sha: this.headSha });
    }
    if (url.pathname === `/repos/${SOURCE_REPO}/git/trees/${this.headSha}`) {
      const tree = [...this.reports.entries()].map(([day, body]) => ({
        type: 'blob',
        path: `reports/daily-trends-${day}.md`,
        // blob SHA 必须反映内容：内容变化时导入器要能识别出"同一日期被上游重写"。
        sha: createHash('sha256').update(body).digest('hex').slice(0, 40),
      }));
      return respond(200, { tree, truncated: this.truncateTree });
    }
    const match = /^\/difyz9\/github-trend-monitor\/[0-9a-f]+\/reports\/daily-trends-(\d{4}-\d{2}-\d{2})\.md$/.exec(
      url.pathname,
    );
    if (match !== null) {
      const day = match[1] as string;
      if (this.failDays.has(day)) return respond(500, 'boom');
      const body = this.reports.get(day);
      if (body === undefined) return respond(404, { message: 'Not Found' });
      // 报告是纯文本而不是 JSON。
      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body,
        bytes: body.length,
        url: request.url,
      });
    }
    return respond(404, { message: 'Not Found' });
  }

  describe(): { mode: 'direct'; proxyScheme: null } {
    return { mode: 'direct', proxyScheme: null };
  }

  close(): void {
    // 无需释放。
  }
}

let context: TestDatabase;
let transport: TrendTransport;

beforeEach(() => {
  context = createTestDatabase();
  transport = new TrendTransport();
});

afterEach(() => {
  context.close();
});

function importReports(): ReturnType<typeof runTrendsImport> {
  return runTrendsImport({ db: context.db, transport, now: () => TEST_NOW });
}

describe('报告解析', () => {
  it('按表头名字定位列，保留行序作为名次', () => {
    const parsed = parseTrendReport(
      '2026-10-24',
      reportMarkdown([
        { name: 'yetone/cumora', stars: 2416 },
        { name: 'ccch1mneyyy/dsh-TUI', stars: 1984, domain: 'Multi-modal' },
      ]),
    );
    expect(parsed.rows).toEqual([
      {
        rank: 1,
        fullName: 'yetone/cumora',
        url: 'https://github.com/yetone/cumora',
        stars: 2416,
        domain: 'AI Agent',
      },
      {
        rank: 2,
        fullName: 'ccch1mneyyy/dsh-TUI',
        url: 'https://github.com/ccch1mneyyy/dsh-TUI',
        stars: 1984,
        domain: 'Multi-modal',
      },
    ]);
  });

  it('列顺序变化仍按表头解析，不按位置猜', () => {
    const content = [
      '| Domain | Repository | Stars |',
      '| --- | --- | ---: |',
      '| AI Agent | [owner/a](https://github.com/owner/a) | 10 |',
    ].join('\n');
    const parsed = parseTrendReport('2026-10-24', content);
    expect(parsed.rows[0]).toMatchObject({ fullName: 'owner/a', stars: 10, domain: 'AI Agent' });
  });

  it('缺列按上游契约变化失败，坏行只跳过并计数', () => {
    expect(() => parseTrendReport('2026-10-24', '| Repository | Stars |\n| --- | --- |\n| [a/b](https://github.com/a/b) | 1 |')).toThrowError(
      TrendsSourceError,
    );
    // 20 行里 1 行坏 = 5%，刚好不超过阈值：坏行只跳过并计数。
    const rows = ['| [owner/a](https://github.com/owner/a) | 10 | AI Agent |'];
    rows.push('| 不是链接 | 20 | AI Agent |');
    for (let index = 0; index < 18; index += 1) {
      rows.push(`| [owner/r${String(index)}](https://github.com/owner/r${String(index)}) | 1 | AI Agent |`);
    }
    const parsed = parseTrendReport('2026-10-24', `${HEADERS}${rows.join('\n')}`);
    expect(parsed.rows).toHaveLength(19);
    expect(parsed.rowsTotal).toBe(20);
    expect(parsed.rowsValid).toBe(19);
    expect(parsed.rows[0]?.fullName).toBe('owner/a');
  });

  it('坏行比例超过 5% 时整轮失败', () => {
    const rows = ['| [owner/a](https://github.com/owner/a) | 10 | AI Agent |'];
    for (let index = 0; index < 3; index += 1) rows.push('| 坏行 | x | AI Agent |');
    expect(() => parseTrendReport('2026-10-24', `${HEADERS}${rows.join('\n')}`)).toThrowError(/坏行比例/);
  });

  it('同一天同一仓库出现两次时保留两行（名次才是唯一键）', () => {
    const parsed = parseTrendReport(
      '2026-10-24',
      reportMarkdown([
        { name: 'ysr666/dsh-vision-router', stars: 767, domain: 'Multi-modal' },
        { name: 'ysr666/dsh-vision-router', stars: 766, domain: 'AI Agent' },
      ]),
    );
    expect(parsed.rows.map((row) => [row.rank, row.domain])).toEqual([
      [1, 'Multi-modal'],
      [2, 'AI Agent'],
    ]);
  });
});

describe('趋势导入', () => {
  it('导入全部日期，重复执行不产生新数据', async () => {
    transport.setReports({
      '2026-10-23': [{ name: 'owner/a', stars: 10 }],
      '2026-10-24': [{ name: 'owner/a', stars: 12 }, { name: 'owner/b', stars: 5 }],
    });

    const first = await importReports();
    expect(first.state).toBe('published');
    expect(first.importedDays).toEqual(['2026-10-24', '2026-10-23']);
    expect(first.rowsImported).toBe(3);

    const second = await importReports();
    expect(second.state).toBe('skipped');
    expect(second.importedDays).toEqual([]);
  });

  it('已导入日期在上游内容变化后重新导入，不因日期相同而跳过', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    await importReports();

    // 同一日期上游重写了报告（blob 变化）：必须重新抓取并覆盖。
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 99 }] });
    transport.headSha = 'd'.repeat(40);
    const again = await importReports();
    expect(again.state).toBe('published');
    expect(again.importedDays).toEqual(['2026-10-24']);

    const page = readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW);
    expect(page.items[0]?.stars).toBe(99);
  });

  it('内容与解析版本都未变时不再下载（只发清单请求）', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    await importReports();
    const before = transport.requests.length;

    await importReports();
    const after = transport.requests.slice(before);
    // 只剩 HEAD 与 tree 两个清单请求，没有报告下载。
    expect(after).toHaveLength(2);
  });

  it('解析器版本变化时即使 blob 相同也重新导入', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    await importReports();
    context.client.prepare('UPDATE daily_trend_runs SET parser_version = 0').run();

    const again = await importReports();
    expect(again.state).toBe('published');
    expect(again.importedDays).toEqual(['2026-10-24']);
  });

  it('单日失败不影响其他日期，结果里说明失败日期', async () => {
    transport.setReports({
      '2026-10-23': [{ name: 'owner/a', stars: 10 }],
      '2026-10-24': [{ name: 'owner/a', stars: 12 }],
    });
    transport.failDays.add('2026-10-23');

    const result = await importReports();
    expect(result.state).toBe('published');
    expect(result.importedDays).toEqual(['2026-10-24']);
    expect(result.failedDays).toEqual(['2026-10-23']);
    expect(result.reason).toContain('2026-10-23');
  });

  it('全部失败时返回失败且不写入任何数据', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    transport.failDays.add('2026-10-24');

    const result = await importReports();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SOURCE_DATA_ANOMALY');
    const count = context.client.prepare('SELECT COUNT(*) AS n FROM daily_trend_runs').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('目录树被截断时拒绝导入，不把缺失日期误判为已删除', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    transport.truncateTree = true;
    const result = await importReports();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('UPSTREAM_SCHEMA_CHANGED');
  });

  it('reports 目录为空时按来源异常失败', async () => {
    transport.setReports({});
    const result = await importReports();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SOURCE_DATA_ANOMALY');
  });
});

describe('趋势读取', () => {
  it('缺省返回最新一份，并给出与上一份比较的名次变化', async () => {
    transport.setReports({
      '2026-10-22': [{ name: 'owner/a', stars: 10 }, { name: 'owner/b', stars: 9 }],
      '2026-10-24': [{ name: 'owner/b', stars: 12 }, { name: 'owner/a', stars: 11 }, { name: 'owner/c', stars: 3 }],
    });
    await importReports();

    const page = readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW);
    expect(page.day).toBe('2026-10-24');
    expect(page.days).toEqual(['2026-10-24', '2026-10-22']);
    expect(page.total).toBe(3);
    // owner/a 上一份报告是第 1 名、现在第 2 名；owner/b 从第 2 到第 1；owner/c 新上榜。
    expect(page.items.map((item) => [item.fullName, item.previousRank])).toEqual([
      ['owner/b', 2],
      ['owner/a', 1],
      ['owner/c', null],
    ]);
    expect(page.source).toMatchObject({ repository: SOURCE_REPO, commit: COMMIT, note: DAILY_TREND_STATS_NOTE });
  });

  it('查看历史日期时，名次变化相对该日期的上一份报告，而不是最新一份', async () => {
    transport.setReports({
      '2026-10-22': [{ name: 'owner/a', stars: 1 }, { name: 'owner/b', stars: 2 }],
      '2026-10-23': [{ name: 'owner/b', stars: 3 }, { name: 'owner/a', stars: 2 }],
      '2026-10-24': [{ name: 'owner/a', stars: 4 }, { name: 'owner/b', stars: 3 }],
    });
    await importReports();

    // 10-23 相对 10-22：b 从第 2 升到第 1，a 从第 1 降到第 2。
    const mid = readTrends(context.db, { day: '2026-10-23', page: 1, pageSize: 30 }, TEST_NOW);
    expect(mid.day).toBe('2026-10-23');
    expect(mid.hasPrevious).toBe(true);
    expect(mid.items.map((item) => [item.fullName, item.previousRank])).toEqual([
      ['owner/b', 2],
      ['owner/a', 1],
    ]);

    // 最早一份没有更早的报告可比较。
    const earliest = readTrends(context.db, { day: '2026-10-22', page: 1, pageSize: 30 }, TEST_NOW);
    expect(earliest.hasPrevious).toBe(false);
    expect(earliest.items.every((item) => item.previousRank === null)).toBe(true);
  });

  it('没有最新报告时，超大 page 不会抛错（公开参数可被匿名构造）', () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    return importReports().then(() => {
      // 走读取层的独立收口：即使路由层被绕过，也不能把 1e20 这类值绑定给 SQLite。
      const page = readTrends(context.db, { page: Number.MAX_SAFE_INTEGER, pageSize: 30 }, TEST_NOW);
      expect(page.items).toEqual([]);
      expect(page.day).toBe('2026-10-24');
    });
  });

  it('公开查询拒绝超出安全整数范围或过大的页码', () => {
    expect(DailyTrendQuery.safeParse({ page: '99999999999999999999' }).success).toBe(false);
    expect(DailyTrendQuery.safeParse({ page: String(TRENDS_MAX_PAGE + 1) }).success).toBe(false);
    expect(DailyTrendQuery.safeParse({ page: String(TRENDS_MAX_PAGE) }).success).toBe(true);
    expect(DailyTrendQuery.safeParse({ pageSize: '99999999999999999999' }).success).toBe(false);
  });

  it('指定不存在的日期回落到最新，并在 meta.day 里给出实际日期', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    await importReports();
    const page = readTrends(context.db, { day: '2000-01-01', page: 1, pageSize: 30 }, TEST_NOW);
    expect(page.day).toBe('2026-10-24');
  });

  it('没有任何报告时返回空结构而不是抛错', () => {
    const page = readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW);
    expect(page).toEqual({ items: [], day: null, days: [], hasPrevious: false, total: 0, source: null });
  });

  it('只有一份报告时 hasPrevious 为 false，界面不会把整榜标成新上榜', async () => {
    transport.setReports({ '2026-10-24': [{ name: 'owner/a', stars: 12 }] });
    await importReports();
    const page = readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW);
    expect(page.hasPrevious).toBe(false);
    expect(page.items[0]?.previousRank).toBeNull();

    // 补上更早的一份后，比较才有依据。
    transport.setReports({
      '2026-10-23': [{ name: 'owner/b', stars: 1 }],
      '2026-10-24': [{ name: 'owner/a', stars: 12 }],
    });
    await importReports();
    expect(readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW).hasPrevious).toBe(true);
  });

  it('最新报告超过两天未更新即标记陈旧', () => {
    const now = Date.parse('2026-10-25T02:00:00Z');
    expect(isTrendReportStale('2026-10-24', now)).toBe(false);
    expect(isTrendReportStale('2026-10-21', now)).toBe(true);
    expect(isTrendReportStale(null, now)).toBe(true);
  });
});

describe('导入状态记录', () => {
  it('recordAttempt 落库后 status 能区分“抓取一直失败”与“上游没更新”', async () => {
    const adapter = new TrendsAdapter({ db: context.db, transport, now: () => TEST_NOW });
    expect(adapter.status(TEST_NOW)).toMatchObject({ state: 'idle', lastAttemptAt: null, daysCount: 0 });

    adapter.recordAttempt({
      state: 'failed',
      importedDays: [],
      failedDays: ['2026-10-24'],
      rowsImported: 0,
      errorCode: 'SOURCE_DATA_ANOMALY',
      reason: '上游 500',
    });
    const failed = adapter.status(TEST_NOW);
    expect(failed.state).toBe('anomaly');
    expect(failed.lastErrorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(failed.lastAttemptAt).toBe(TEST_NOW);
    expect(failed.lastFailureAt).toBe(TEST_NOW);

    // 之后成功一次就恢复 idle，但旧数据的"陈旧"仍按最新报告日期独立判断。
    adapter.recordAttempt({
      state: 'published',
      importedDays: ['2026-10-24'],
      failedDays: [],
      rowsImported: 20,
      errorCode: null,
      reason: null,
    });
    expect(adapter.status(TEST_NOW).state).toBe('idle');
    expect(adapter.status(TEST_NOW).lastFailureAt).toBeNull();
  });

  it('失败之后的 skipped 不会把持续失败显示成已恢复', () => {
    const adapter = new TrendsAdapter({ db: context.db, transport, now: () => TEST_NOW });
    adapter.recordAttempt({
      state: 'failed',
      importedDays: [],
      failedDays: ['2026-10-24'],
      rowsImported: 0,
      errorCode: 'SOURCE_DATA_ANOMALY',
      reason: '上游 500',
    });
    // 次日清单没变（什么都没抓）：这是 skipped，不能证明上游已恢复。
    adapter.recordAttempt({
      state: 'skipped',
      importedDays: [],
      failedDays: [],
      rowsImported: 0,
      errorCode: null,
      reason: '报告清单与已导入内容一致，未产生新数据',
    });
    const status = adapter.status(TEST_NOW);
    expect(status.state).toBe('anomaly');
    expect(status.lastErrorCode).toBe('SOURCE_DATA_ANOMALY');
  });

  it('status 反映已导入天数与最新日期', async () => {
    transport.setReports({
      '2026-10-23': [{ name: 'owner/a', stars: 10 }],
      '2026-10-24': [{ name: 'owner/a', stars: 12 }],
    });
    await importReports();
    const adapter = new TrendsAdapter({ db: context.db, transport, now: () => TEST_NOW });
    // TEST_NOW 是固定夹具时间，报告日期相对它可能已"陈旧"，因此这里只断言数据维度。
    expect(adapter.status(TEST_NOW)).toMatchObject({
      daysCount: 2,
      latestDay: '2026-10-24',
      nextRunAt: null,
    });
  });
});

describe('公开 DTO 形状', () => {
  it('读取结果可以直接通过契约校验', async () => {
    transport.setReports({
      '2026-10-24': [{ name: 'owner/a', stars: 12 }, { name: 'owner/a', stars: 11, domain: 'Multi-modal' }],
    });
    await importReports();
    const page = readTrends(context.db, { page: 1, pageSize: 30 }, TEST_NOW);
    const parsed = DailyTrendResponse.safeParse({
      data: page.items,
      meta: {
        day: page.day,
        days: page.days,
        hasPrevious: page.hasPrevious,
        page: 1,
        pageSize: 30,
        total: page.total,
        source: page.source,
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
