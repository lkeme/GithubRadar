import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiscoveryResponse } from '@githubradar/contracts';

import { type Database } from '../../apps/server/src/db/client.js';
import {
  DiscoveryError,
  readActiveDiscovery,
  runDiscoveryImport,
  type DiscoveryApiAccess,
  type DiscoveryImportDeps,
  type DiscoveryImportResult,
} from '../../apps/server/src/discovery/index.js';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../apps/server/src/integrations/transport/index.js';

import { createTestDatabase, TEST_NOW, type TestDatabase } from './support.js';

/**
 * 可选发现模块集成测试（CSV 异常与原子发布行）。
 *
 * 全部使用注入的 fetchSource 或假 transport 提供固定 CSV 内容，不访问真实网络；
 * 数据库是真实临时 SQLite（由 support.ts 的 createTestDatabase 建立并执行迁移）。
 */

const SOURCE_FILES = [
  'AI_Agent.csv',
  'RAG.csv',
  'Multi-modal.csv',
  'Long_Context.csv',
  'Speculative_Model.csv',
] as const;

const HEADER =
  'id,name,description,url,stars,forks,language,topics,created_at,first_seen,is_active,domains';

const SOURCE_REPO = 'difyz9/github-trend-monitor';
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));

function fixtureFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of SOURCE_FILES) {
    files.set(name, readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
  }
  return files;
}

function headerOnlyFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of SOURCE_FILES) {
    files.set(name, `${HEADER}\n`);
  }
  return files;
}

interface RowSpec {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly url?: string;
  readonly stars?: string;
  readonly forks?: string;
  readonly language?: string;
  readonly topics?: string;
  readonly createdAt?: string;
  readonly firstSeen?: string;
  readonly isActive?: string;
  readonly domains?: string;
}

function csvRow(spec: RowSpec): string {
  const quote = (value: string): string =>
    value.includes(',') || value.includes('"') || value.includes('\n')
      ? `"${value.replace(/"/g, '""')}"`
      : value;
  const fields = [
    spec.id ?? '',
    spec.name ?? '',
    spec.description ?? '',
    spec.url ?? '',
    spec.stars ?? '0',
    spec.forks ?? '0',
    spec.language ?? '',
    spec.topics ?? '',
    spec.createdAt ?? '2025-01-01T00:00:00Z',
    spec.firstSeen ?? '2025-01-02',
    spec.isActive ?? 'True',
    spec.domains ?? '',
  ];
  return fields.map(quote).join(',');
}

function generatedFiles(rows: readonly RowSpec[], target = 'AI_Agent.csv'): Map<string, string> {
  const files = headerOnlyFiles();
  files.set(target, `${[HEADER, ...rows.map(csvRow)].join('\n')}\n`);
  return files;
}

function blobShasFor(commit: string): Map<string, string> {
  const shas = new Map<string, string>();
  for (const name of SOURCE_FILES) {
    shas.set(name, createHash('sha256').update(`${commit}:${name}`).digest('hex').slice(0, 40));
  }
  return shas;
}

const DEFAULT_COMMIT = 'a'.repeat(40);
const RECENT_TIME = Date.now() - 60 * 60 * 1000;

interface FakeTransportOptions {
  readonly commit?: string;
  readonly committedAt?: string;
  readonly files: ReadonlyMap<string, string>;
  readonly blobShas?: ReadonlyMap<string, string>;
  readonly omittedPaths?: readonly string[];
  /** 仅附加在 commits/HEAD 与 git/trees 两个 API 响应上的额外响应头（如 x-ratelimit-*）。 */
  readonly apiHeaders?: Readonly<Record<string, string>>;
}

function jsonResponse(
  url: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): TransportResponse {
  const text = JSON.stringify(body);
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    url,
  };
}

function textResponse(url: string, status: number, body: string): TransportResponse {
  return { status, headers: {}, body, bytes: Buffer.byteLength(body, 'utf8'), url };
}

function createFakeTransport(options: FakeTransportOptions): {
  transport: Transport;
  requests: TransportRequest[];
} {
  const commit = options.commit ?? DEFAULT_COMMIT;
  const committedAt = options.committedAt ?? new Date(RECENT_TIME).toISOString();
  const requests: TransportRequest[] = [];
  const blobShas = options.blobShas ?? blobShasFor(commit);
  const apiHeaders = options.apiHeaders ?? {};

  const tree = [
    ...[...options.files.keys()].map((name) => ({
      path: `data/${name}`,
      type: 'blob',
      sha: blobShas.get(name) ?? 'e'.repeat(40),
    })),
    // 上游还有 all_repos.csv；发现模块必须忽略它（固定提交实测缺表头）。
    { path: 'data/all_repos.csv', type: 'blob', sha: 'f'.repeat(40) },
  ].filter((node) => !(options.omittedPaths ?? []).includes(node.path));

  const transport: Transport = {
    async request(request: TransportRequest): Promise<TransportResponse> {
      requests.push(request);
      const { url } = request;
      if (url === `https://api.github.com/repos/${SOURCE_REPO}/commits/HEAD`) {
        return jsonResponse(url, { sha: commit, commit: { committer: { date: committedAt } } }, apiHeaders);
      }
      if (url.startsWith(`https://api.github.com/repos/${SOURCE_REPO}/git/trees/${commit}`)) {
        return jsonResponse(url, { sha: commit, truncated: false, tree }, apiHeaders);
      }
      const rawPrefix = `https://raw.githubusercontent.com/${SOURCE_REPO}/${commit}/data/`;
      if (url.startsWith(rawPrefix)) {
        const body = options.files.get(url.slice(rawPrefix.length));
        if (body === undefined) return textResponse(url, 404, 'Not Found');
        return textResponse(url, 200, body);
      }
      return textResponse(url, 404, 'Not Found');
    },
    describe() {
      return { mode: 'direct', proxyScheme: null };
    },
    close() {
      // 假 transport 没有需要释放的资源。
    },
  };
  return { transport, requests };
}

let context: TestDatabase | undefined;
let db: Database;

beforeEach(() => {
  context = createTestDatabase();
  db = context.db;
});

afterEach(() => {
  context?.close();
  context = undefined;
});

function enableDiscovery(): void {
  db.$client.prepare('UPDATE settings SET discovery_enabled = 1 WHERE id = 1').run();
}

function disableDiscovery(): void {
  db.$client.prepare('UPDATE settings SET discovery_enabled = 0 WHERE id = 1').run();
}

function activeRunId(): number | null {
  const row = db.$client
    .prepare('SELECT active_discovery_run_id AS id FROM settings WHERE id = 1')
    .get() as { id: number | null };
  return row.id;
}

interface RunRecord {
  readonly id: number;
  readonly state: string;
  readonly error_code: string | null;
  readonly rows_total: number;
  readonly rows_valid: number;
  readonly source_commit: string;
}

function runRecords(): RunRecord[] {
  return db.$client
    .prepare('SELECT id, state, error_code, rows_total, rows_valid, source_commit FROM discovery_runs ORDER BY id')
    .all() as RunRecord[];
}

function itemCount(runId: number): number {
  const row = db.$client
    .prepare('SELECT COUNT(*) AS n FROM discovery_items WHERE run_id = ?')
    .get(runId) as { n: number };
  return row.n;
}

function totalItemCount(): number {
  const row = db.$client.prepare('SELECT COUNT(*) AS n FROM discovery_items').get() as { n: number };
  return row.n;
}

function countByGithubId(githubId: number): number {
  const row = db.$client
    .prepare('SELECT COUNT(*) AS n FROM discovery_items WHERE github_id = ?')
    .get(githubId) as { n: number };
  return row.n;
}

interface ImportOptions {
  readonly files?: ReadonlyMap<string, string>;
  readonly fetchFiles?: ReadonlyMap<string, string>;
  readonly commit?: string;
  readonly committedAt?: string;
  readonly blobShas?: ReadonlyMap<string, string>;
  readonly omittedPaths?: readonly string[];
  readonly injectFetchSource?: boolean;
  readonly now?: () => number;
  readonly access?: DiscoveryApiAccess;
  readonly apiHeaders?: Readonly<Record<string, string>>;
}

interface ImportHarness {
  readonly result: Promise<DiscoveryImportResult>;
  readonly requests: TransportRequest[];
  readonly fetchSource: ReturnType<typeof vi.fn>;
}

function startImport(options: ImportOptions = {}): ImportHarness {
  const files = options.files ?? fixtureFiles();
  const fetchFiles = options.fetchFiles ?? files;
  const fake = createFakeTransport({
    commit: options.commit,
    committedAt: options.committedAt,
    files,
    blobShas: options.blobShas,
    omittedPaths: options.omittedPaths,
    apiHeaders: options.apiHeaders,
  });
  const fetchSource = vi.fn(async (_commit: string) => fetchFiles);
  const deps: DiscoveryImportDeps = {
    db,
    transport: fake.transport,
    now: options.now ?? (() => TEST_NOW),
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.injectFetchSource === false ? {} : { fetchSource }),
  };
  return { result: runDiscoveryImport(deps), requests: fake.requests, fetchSource };
}

function readPage(overrides: Partial<{ q: string; language: string; category: string; page: number; pageSize: number }> = {}) {
  return readActiveDiscovery(db, { page: 1, pageSize: 30, ...overrides });
}

describe('发现导入', () => {
  it('正常导入：发布活跃代次，同 ID 跨文件只出现一次并合并分类', async () => {
    enableDiscovery();
    const harness = startImport();
    const result = await harness.result;

    expect(result.state).toBe('published');
    expect(result.errorCode).toBeNull();
    expect(result.rowsTotal).toBe(8);
    expect(result.rowsValid).toBe(8);
    expect(result.uniqueCandidates).toBe(7);
    expect(result.reason).toContain('跨文件冲突 1');

    const runs = runRecords();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('active');
    expect(activeRunId()).toBe(result.runId);
    expect(itemCount(result.runId)).toBe(7);

    const page = readPage();
    expect(page.total).toBe(7);
    expect(page.items.map((item) => item.githubId)).toEqual([
      100007, 100001, 100005, 100004, 100002, 100006, 100003,
    ]);

    const alpha = page.items.find((item) => item.githubId === 100001);
    expect(alpha?.sourceStars).toBe(120); // 优先序靠前的 AI_Agent.csv 胜出，而不是 RAG.csv 的 999
    expect(alpha?.sourceForks).toBe(15);
    expect(alpha?.canonicalName).toBe('alpha/agent-lab');
    expect(alpha?.htmlUrl).toBe('https://github.com/alpha/agent-lab');
    expect(alpha?.categories).toEqual(['AI_Agent.csv', 'RAG.csv']);
    expect(alpha?.sourceFile).toBe('AI_Agent.csv');
    expect(alpha?.domains).toEqual(['AI', 'Agent']);
    expect(alpha?.topics).toEqual(['agent', 'llm', 'automation']);
    expect(alpha?.firstSeen).toBe('2025-01-03');
    expect(alpha?.sourceCreatedAt).toBe('2025-01-02T03:04:05Z');
    expect(alpha?.statsSampledAt).toBeNull();

    expect(countByGithubId(100001)).toBe(1);

    // 统计采样时间未知时必须保持 NULL，不能用导入时间填充。
    const sample = db.$client
      .prepare('SELECT stats_sampled_at FROM discovery_items WHERE github_id = 100005')
      .get() as { stats_sampled_at: number | null };
    expect(sample.stats_sampled_at).toBeNull();

    expect(page.source?.repository).toBe(SOURCE_REPO);
    expect(page.source?.commit).toBe(DEFAULT_COMMIT);
    expect(page.source?.commitUrl).toBe(`https://github.com/${SOURCE_REPO}/commit/${DEFAULT_COMMIT}`);
    expect(page.source?.importedAt).toBe(TEST_NOW);
    expect(page.source?.sourceUpdatedAt).toBe(Date.parse(new Date(RECENT_TIME).toISOString()));
    expect(page.source?.stale).toBe(false);
    expect(page.source?.fileNames).toEqual([...SOURCE_FILES]);
    expect(page.source?.note).toContain('来源记录值');
  });

  it('同一 commit（blob 未变）不重新下载、不产生新代次；文档提交变化但 blob 未变也跳过', async () => {
    enableDiscovery();
    const first = await startImport().result;
    expect(first.state).toBe('published');

    const second = startImport();
    const secondResult = await second.result;
    expect(secondResult.state).toBe('skipped');
    expect(secondResult.runId).toBe(first.runId);
    expect(secondResult.uniqueCandidates).toBe(7);
    expect(second.fetchSource).not.toHaveBeenCalled();
    // 只解析了提交与目录树两个 API 请求。
    expect(second.requests.map((request) => request.url)).toHaveLength(2);
    expect(runRecords()).toHaveLength(1);
    expect(activeRunId()).toBe(first.runId);

    // 新 commit 只改了文档：blob SHA 未变，仍不下载、不发布。
    const third = startImport({
      commit: 'b'.repeat(40),
      blobShas: blobShasFor(DEFAULT_COMMIT),
    });
    const thirdResult = await third.result;
    expect(thirdResult.state).toBe('skipped');
    expect(third.fetchSource).not.toHaveBeenCalled();
    expect(runRecords()).toHaveLength(1);
  });

  it('必需文件缺失时不发布新代次，旧代次仍可读', async () => {
    enableDiscovery();
    const first = await startImport().result;
    expect(first.state).toBe('published');
    const oldId = activeRunId();
    expect(oldId).not.toBeNull();

    // 变体 A：目录树里缺少 RAG.csv。
    const missingTree = startImport({ commit: 'c'.repeat(40), omittedPaths: ['data/RAG.csv'] });
    const resultA = await missingTree.result;
    expect(resultA.state).toBe('failed');
    expect(resultA.errorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(resultA.reason).toContain('RAG.csv');
    expect(resultA.runId).toBe(0);
    expect(runRecords()).toHaveLength(1);

    // 变体 B：目录树完整，但注入的内容地图缺少 RAG.csv。
    const withoutRag = fixtureFiles();
    withoutRag.delete('RAG.csv');
    const missingContent = startImport({ commit: 'd'.repeat(40), fetchFiles: withoutRag });
    const resultB = await missingContent.result;
    expect(resultB.state).toBe('failed');
    expect(resultB.errorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(runRecords()).toHaveLength(2);
    expect(runRecords()[1]?.state).toBe('failed');
    expect(runRecords()[1]?.error_code).toBe('SOURCE_DATA_ANOMALY');

    // 旧代次仍然可读，指针未动。
    expect(activeRunId()).toBe(oldId);
    const page = readPage();
    expect(page.total).toBe(7);
    expect(page.source?.commit).toBe(DEFAULT_COMMIT);
  });

  it('本轮全空时不发布，旧代次保留', async () => {
    enableDiscovery();
    const first = await startImport().result;
    expect(first.state).toBe('published');
    const oldId = activeRunId();

    const empty = startImport({ commit: 'e'.repeat(40), files: headerOnlyFiles() });
    const result = await empty.result;
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(result.uniqueCandidates).toBe(0);

    expect(activeRunId()).toBe(oldId);
    expect(readPage().total).toBe(7);
  });

  it('合法唯一候选比上一轮下降超过 80% 时不发布', async () => {
    enableDiscovery();
    const first = await startImport().result;
    expect(first.state).toBe('published');
    const oldId = activeRunId();

    const tiny = generatedFiles([
      { id: '900001', name: 'solo/one', url: 'https://github.com/solo/one', stars: '5' },
    ]);
    const result = await startImport({ commit: 'f'.repeat(40), files: tiny }).result;
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(result.reason).toContain('下降超过 80%');

    expect(activeRunId()).toBe(oldId);
    expect(readPage().total).toBe(7);
  });

  it('恰好下降 80%（未超过）仍正常发布', async () => {
    enableDiscovery();
    const five = generatedFiles([
      { id: '910001', name: 'keep/a', url: 'https://github.com/keep/a', stars: '5' },
      { id: '910002', name: 'keep/b', url: 'https://github.com/keep/b', stars: '4' },
      { id: '910003', name: 'keep/c', url: 'https://github.com/keep/c', stars: '3' },
      { id: '910004', name: 'keep/d', url: 'https://github.com/keep/d', stars: '2' },
      { id: '910005', name: 'keep/e', url: 'https://github.com/keep/e', stars: '1' },
    ]);
    const first = await startImport({ files: five }).result;
    expect(first.state).toBe('published');
    expect(first.uniqueCandidates).toBe(5);

    const one = generatedFiles([
      { id: '910001', name: 'keep/a', url: 'https://github.com/keep/a', stars: '6' },
    ]);
    const result = await startImport({ commit: '9'.repeat(40), files: one }).result;
    expect(result.state).toBe('published');
    expect(result.uniqueCandidates).toBe(1);
    expect(readPage().total).toBe(1);
  });

  it('引号、内嵌逗号、跨行字段、BOM 与 all_repos.csv 形态', async () => {
    enableDiscovery();
    const files = fixtureFiles();
    // 给 AI_Agent.csv 加上 UTF-8 BOM，解析时必须被剥离。
    files.set('AI_Agent.csv', `﻿${files.get('AI_Agent.csv') ?? ''}`);
    // all_repos.csv 形态：第一行就是数据、没有表头；它不在 5 个目标文件里，必须被忽略。
    files.set(
      'all_repos.csv',
      '900099,ghost/headerless,Not a category file,https://github.com/ghost/headerless,1,1,,,,,,,\n',
    );

    const result = await startImport({ files }).result;
    expect(result.state).toBe('published');
    const page = readPage();
    expect(page.total).toBe(7);
    expect(page.items.some((item) => item.githubId === 900099)).toBe(false);

    const vlm = page.items.find((item) => item.githubId === 100005);
    expect(vlm?.description).toBe('Vision language demo\nwith a second line');

    const zh = page.items.find((item) => item.githubId === 100003);
    expect(zh?.description).toBe('中文描述，含逗号与引号"示例"');
    expect(zh?.language).toBeNull();
    expect(zh?.statsSampledAt).toBeNull();

    const beta = page.items.find((item) => item.githubId === 100002);
    expect(beta?.description).toBe('Toolkit with a comma, and more');
  });

  it('无表头的分类文件不会被按位置解释，整轮失败', async () => {
    enableDiscovery();
    const files = fixtureFiles();
    files.set(
      'AI_Agent.csv',
      `${csvRow({ id: '900098', name: 'ghost/no-header', url: 'https://github.com/ghost/no-header' })}\n`,
    );
    const result = await startImport({ commit: '1'.repeat(40), files }).result;
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('UPSTREAM_SCHEMA_CHANGED');
    expect(activeRunId()).toBeNull();
  });

  it('超过 20,000 候选时按来源 stars 降序 + 规范名确定性截断', async () => {
    enableDiscovery();
    const rows: RowSpec[] = [];
    for (let index = 1; index <= 20_010; index += 1) {
      rows.push({
        id: String(1_000_000 + index),
        name: `bulk/repo-${index}`,
        url: `https://github.com/bulk/repo-${index}`,
        stars: String(index),
        forks: '1',
        language: 'Go',
        domains: 'Bulk',
      });
    }
    const result = await startImport({ files: generatedFiles(rows) }).result;
    expect(result.state).toBe('published');
    expect(result.uniqueCandidates).toBe(20_000);
    expect(result.reason).toContain('截断');

    const page = readPage({ pageSize: 100 });
    expect(page.total).toBe(20_000);
    expect(page.items[0]?.githubId).toBe(1_000_000 + 20_010);
    // stars 升序生成，降序截断后保留 stars 11 及以上；stars 10 及以下被丢弃。
    expect(countByGithubId(1_000_011)).toBe(1);
    expect(countByGithubId(1_000_010)).toBe(0);
  });

  it('非法 URL、缺 id 行按坏行统计（5% 以内不失败）；超过 5% 整轮失败', async () => {
    enableDiscovery();

    // 40 行里 2 行坏行 = 5%，未超过阈值：发布，坏行跳过并计数。
    const rows: RowSpec[] = [];
    for (let index = 1; index <= 38; index += 1) {
      rows.push({
        id: String(960_000 + index),
        name: `ok/repo-${index}`,
        url: `https://github.com/ok/repo-${index}`,
        stars: '10',
      });
    }
    rows.push({ id: '950001', name: 'bad/url', url: 'https://gitlab.com/bad/url', stars: '10' });
    rows.push({ id: '', name: 'bad/missing-id', url: 'https://github.com/bad/missing-id', stars: '10' });
    const result = await startImport({ files: generatedFiles(rows) }).result;
    expect(result.state).toBe('published');
    expect(result.rowsTotal).toBe(40);
    expect(result.rowsValid).toBe(38);
    expect(readPage().total).toBe(38);
    expect(countByGithubId(950001)).toBe(0);

    // 10 行里 2 行坏（非法 URL + 非数字 stars）= 20%，超过 5%：不发布。
    const badFiles = generatedFiles([
      { id: '970001', name: 'ok/a', url: 'https://github.com/ok/a', stars: '3' },
      { id: '970002', name: 'ok/b', url: 'https://github.com/ok/b', stars: '4' },
      { id: '970003', name: 'ok/c', url: 'https://github.com/ok/c', stars: '5' },
      { id: '970004', name: 'ok/d', url: 'https://github.com/ok/d', stars: '6' },
      { id: '970005', name: 'ok/e', url: 'https://github.com/ok/e', stars: '7' },
      { id: '970006', name: 'ok/f', url: 'https://github.com/ok/f', stars: '8' },
      { id: '970007', name: 'ok/g', url: 'https://github.com/ok/g', stars: '9' },
      { id: '970008', name: 'ok/h', url: 'https://github.com/ok/h', stars: '10' },
      { id: '970009', name: 'bad/stars', url: 'https://github.com/bad/stars', stars: 'abc' },
      { id: '970010', name: 'bad/scheme', url: 'http://github.com/bad/scheme', stars: '2' },
    ]);
    const failed = await startImport({ commit: '2'.repeat(40), files: badFiles }).result;
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('SOURCE_DATA_ANOMALY');
    expect(failed.reason).toContain('坏行比例超过 5%');
    expect(readPage().total).toBe(38);
  });

  it('表头缺关键列时整轮失败（UPSTREAM_SCHEMA_CHANGED）', async () => {
    enableDiscovery();
    const files = fixtureFiles();
    files.set('RAG.csv', 'id,name,url,stars\n1,x,https://github.com/x/y,1\n');
    const result = await startImport({ commit: '3'.repeat(40), files }).result;
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('UPSTREAM_SCHEMA_CHANGED');
    expect(result.reason).toContain('缺');
    expect(runRecords()).toHaveLength(1);
    expect(runRecords()[0]?.state).toBe('failed');
  });

  it('原子性：切换代次失败时清理半份数据，指针仍指向旧代次', async () => {
    enableDiscovery();
    const first = await startImport().result;
    expect(first.state).toBe('published');
    const oldId = activeRunId();
    expect(oldId).not.toBeNull();

    db.$client.exec(
      "CREATE TRIGGER block_settings_update BEFORE UPDATE OF active_discovery_run_id ON settings BEGIN SELECT RAISE(ABORT, 'BLOCKED'); END;",
    );
    const blocked = await startImport({ commit: '4'.repeat(40) }).result;
    db.$client.exec('DROP TRIGGER block_settings_update');

    expect(blocked.state).toBe('failed');
    expect(blocked.errorCode).toBe('SERVICE_UNAVAILABLE');

    // 指针与旧代次数据不变，没有 staging 残留，也没有新代次的条目。
    expect(activeRunId()).toBe(oldId);
    const runs = runRecords();
    const oldRun = runs.find((run) => run.id === oldId);
    expect(oldRun?.state).toBe('active');
    expect(itemCount(oldId as number)).toBe(7);
    expect(totalItemCount()).toBe(7);
    expect(runs.filter((run) => run.state === 'staging')).toHaveLength(0);

    const failedRuns = runs.filter((run) => run.state === 'failed');
    expect(failedRuns).toHaveLength(1);
    expect(itemCount(failedRuns[0]?.id as number)).toBe(0);

    // 阻塞解除后重试同一 commit 可以正常发布。
    const retry = await startImport({ commit: '4'.repeat(40) }).result;
    expect(retry.state).toBe('published');
    expect(readPage().total).toBe(7);
  });

  it('发现默认启用，首次导入直接发布', async () => {
    expect(activeRunId()).toBeNull();
    const first = startImport();
    const firstResult = await first.result;
    expect(firstResult.state).toBe('published');
    expect(first.requests.length).toBeGreaterThan(0);
    expect(readPage().total).toBe(7);
    expect(activeRunId()).not.toBeNull();
  });

  it('内部开关被直改数据库置 0 时短路且不清空数据', async () => {
    // 该列已无接口可改（管理契约不再接受该字段、界面没有开关），保留的是防御性短路：
    // 若运维直接改库把它置 0，导入与读取都只做拒绝，不触碰既有代次数据。
    disableDiscovery();
    const disabled = startImport();
    const disabledResult = await disabled.result;
    expect(disabledResult.state).toBe('skipped');
    expect(disabledResult.errorCode).toBe('FEATURE_DISABLED');
    expect(disabled.requests).toHaveLength(0);
    expect(disabled.fetchSource).not.toHaveBeenCalled();
    expect(runRecords()).toHaveLength(0);

    let caught: unknown;
    try {
      readPage();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiscoveryError);
    expect((caught as DiscoveryError).code).toBe('FEATURE_DISABLED');

    // 恢复默认值 → 导入 → 再次置 0：读取仍抛 FEATURE_DISABLED，但数据保留。
    enableDiscovery();
    const imported = await startImport().result;
    expect(imported.state).toBe('published');
    disableDiscovery();
    expect(() => readPage()).toThrowError(DiscoveryError);
    enableDiscovery();
    expect(readPage().total).toBe(7);
  });

  it('默认 fetchSource 走固定 raw URL、不附加 Authorization，第二次相同 blob 不下载', async () => {
    enableDiscovery();
    const first = startImport({ injectFetchSource: false });
    const result = await first.result;
    expect(result.state).toBe('published');

    const rawRequests = first.requests.filter((request) =>
      request.url.startsWith(`https://raw.githubusercontent.com/${SOURCE_REPO}/`),
    );
    expect(rawRequests.map((request) => request.url)).toEqual(
      SOURCE_FILES.map(
        (name) => `https://raw.githubusercontent.com/${SOURCE_REPO}/${DEFAULT_COMMIT}/data/${name}`,
      ),
    );
    expect(
      first.requests.every((request) =>
        Object.keys(request.headers ?? {}).every((header) => header.toLowerCase() !== 'authorization'),
      ),
    ).toBe(true);
    const head = first.requests.find((request) => request.url.endsWith('/commits/HEAD'));
    expect(head?.headers?.accept).toBe('application/vnd.github+json');
    expect(first.requests.some((request) => request.url.includes('all_repos'))).toBe(false);

    const again = startImport({ injectFetchSource: false });
    const second = await again.result;
    expect(second.state).toBe('skipped');
    expect(
      again.requests.filter((request) =>
        request.url.startsWith('https://raw.githubusercontent.com/'),
      ),
    ).toHaveLength(0);
  });

  it('读取支持 q/language/category 过滤与稳定分页', async () => {
    enableDiscovery();
    await startImport().result;

    const byCategory = readPage({ category: 'RAG.csv' });
    expect(byCategory.total).toBe(2);
    expect(byCategory.items.map((item) => item.githubId).sort()).toEqual([100001, 100004]);

    const byLanguage = readPage({ language: 'Go' });
    expect(byLanguage.total).toBe(1);
    expect(byLanguage.items[0]?.githubId).toBe(100004);

    const search = readPage({ q: 'agent' });
    expect(search.items.map((item) => item.githubId)).toEqual([100001]);

    const pageTwo = readPage({ page: 2, pageSize: 3 });
    expect(pageTwo.total).toBe(7);
    expect(pageTwo.items).toHaveLength(3);
    const pageThree = readPage({ page: 3, pageSize: 3 });
    expect(pageThree.items).toHaveLength(1);

    // page/pageSize 非法时收敛到默认；pageSize 上限 100。
    const clamped = readPage({ page: 0, pageSize: 1000 });
    expect(clamped.items).toHaveLength(7);

    expect(readPage({ language: 'COBOL' }).total).toBe(0);
    expect(readPage({ category: 'No_Such.csv' }).total).toBe(0);

    // 读取不产生新 run，也不改变指针。
    expect(runRecords()).toHaveLength(1);
  });

  it('筛选取值来自整代数据，不随当前页或筛选条件缩水', async () => {
    enableDiscovery();
    await startImport().result;

    const all = readPage({});
    const firstPage = readPage({ pageSize: 3 });
    expect(firstPage.items).toHaveLength(3);
    // 前 3 条里只可能出现部分语言；选项集合仍必须是整代的。
    expect(firstPage.filters).toEqual(all.filters);
    expect(all.filters.languages).toEqual([...all.filters.languages].sort());
    expect(all.filters.languages.length).toBeGreaterThan(1);
    // 分类按来源文件的固定优先序，不退化成字典序。
    expect(all.filters.categories).toEqual(
      [...SOURCE_FILES].filter((name) => all.filters.categories.includes(name)),
    );

    // 筛选后的选项集合与未筛选时一致：否则选中后其它选项会从下拉里消失。
    expect(readPage({ language: 'Go' }).filters).toEqual(all.filters);
    expect(readPage({ category: 'RAG.csv' }).filters).toEqual(all.filters);
  });

  it('启用但没有活跃代次时返回空且 source 为 null', () => {
    enableDiscovery();
    const page = readPage();
    expect(page).toEqual({ items: [], total: 0, source: null, filters: { languages: [], categories: [] } });
  });

  it('源数据超过 72 小时未更新时标记为陈旧', async () => {
    enableDiscovery();
    const result = await startImport({ committedAt: '2020-01-02T03:04:05Z' }).result;
    expect(result.state).toBe('published');
    const page = readPage();
    expect(page.source?.sourceUpdatedAt).toBe(Date.parse('2020-01-02T03:04:05Z'));
    expect(page.source?.stale).toBe(true);
  });
});

describe('发现模块的受控访问', () => {
  const RATE_HEADERS = {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '1700000000',
    'x-ratelimit-resource': 'core',
  } as const;

  it('commits/trees 请求带 PAT 并回调配额头；raw 下载保持匿名', async () => {
    enableDiscovery();
    const observed: Readonly<Record<string, string>>[] = [];
    const access: DiscoveryApiAccess = {
      readToken: () => 'ghp_test_token',
      observeRateLimit: (headers) => {
        observed.push(headers);
      },
    };
    const harness = startImport({ injectFetchSource: false, access, apiHeaders: RATE_HEADERS });
    const result = await harness.result;
    expect(result.state).toBe('published');

    // 两个 API 请求都带上当前 PAT（与采集共用配额）。
    const apiRequests = harness.requests.filter((request) =>
      request.url.startsWith('https://api.github.com/'),
    );
    expect(apiRequests).toHaveLength(2);
    for (const request of apiRequests) {
      expect(request.headers?.['authorization']).toBe('Bearer ghp_test_token');
    }

    // raw 下载不附加 Authorization，也不回调配额。
    const rawRequests = harness.requests.filter((request) =>
      request.url.startsWith('https://raw.githubusercontent.com/'),
    );
    expect(rawRequests).toHaveLength(SOURCE_FILES.length);
    for (const request of rawRequests) {
      expect(request.headers?.['authorization']).toBeUndefined();
    }

    // 每个 API 响应都把 x-ratelimit-* 头交给接线方（接到 budget.observe）。
    expect(observed).toHaveLength(2);
    for (const headers of observed) {
      expect(headers['x-ratelimit-remaining']).toBe('4999');
    }
  });

  it('未配置凭证（readToken 为 null）时 API 请求保持匿名', async () => {
    enableDiscovery();
    const harness = startImport({
      access: { readToken: () => null, observeRateLimit: () => {} },
      apiHeaders: RATE_HEADERS,
    });
    const result = await harness.result;
    expect(result.state).toBe('published');
    expect(harness.requests.length).toBeGreaterThan(0);
    for (const request of harness.requests) {
      expect(request.headers?.['authorization']).toBeUndefined();
    }
  });

  it('shouldAbort 为 true 时每下载完一个文件即中止，本轮不发布代次', async () => {
    enableDiscovery();
    const access: DiscoveryApiAccess = {
      readToken: () => null,
      observeRateLimit: () => {},
      shouldAbort: () => true,
    };
    const harness = startImport({ injectFetchSource: false, access });
    const result = await harness.result;

    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SERVICE_UNAVAILABLE');
    expect(result.reason).toContain('取消');
    // 下载完第一个文件后立即中止，剩余文件不再请求。
    const rawRequests = harness.requests.filter((request) =>
      request.url.startsWith('https://raw.githubusercontent.com/'),
    );
    expect(rawRequests).toHaveLength(1);

    // 没有发布代次，也没有残留 staged 条目。
    expect(activeRunId()).toBeNull();
    expect(totalItemCount()).toBe(0);
    const failedRuns = runRecords().filter((run) => run.state === 'failed');
    expect(failedRuns).toHaveLength(1);
    expect(itemCount(failedRuns[0]?.id as number)).toBe(0);
  });
});

describe('发现契约 source 可空', () => {
  it('启用但尚无活跃代次时 source 为 null，契约接受该形状', () => {
    enableDiscovery();
    const page = readPage();
    expect(page.source).toBeNull();
    const payload = {
      data: [],
      meta: { page: 1, pageSize: 30, total: page.total, source: page.source, filters: page.filters },
    };
    expect(DiscoveryResponse.safeParse(payload).success).toBe(true);
  });

  it('有来源信息时仍接受完整对象（nullable 不是 null-only）', () => {
    const payload = {
      data: [],
      meta: {
        page: 1,
        pageSize: 30,
        total: 0,
        source: {
          repository: SOURCE_REPO,
          commit: DEFAULT_COMMIT,
          commitUrl: `https://github.com/${SOURCE_REPO}/commit/${DEFAULT_COMMIT}`,
          importedAt: new Date(TEST_NOW).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          sourceUpdatedAt: null,
          fileNames: [...SOURCE_FILES],
          stale: false,
          note: 'note',
        },
        filters: { languages: ['Go'], categories: ['RAG.csv'] },
      },
    };
    expect(DiscoveryResponse.safeParse(payload).success).toBe(true);
  });
});
