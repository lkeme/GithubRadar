import type { Transport, TransportResponse } from '../integrations/transport/index.js';

/**
 * 每日趋势报告来源。
 *
 * 来源固定为 `difyz9/github-trend-monitor` 的 `reports/daily-trends-YYYY-MM-DD.md`：
 * 每份报告是当天 Top 20 的快照，与 `data/*.csv` 的候选全集是同一上游的两个视图。
 * 这里只读取报告的 blob 清单与文本，不解析 CSV，也不猜测报告缺失的原因。
 */

export const TRENDS_SOURCE_REPOSITORY = 'difyz9/github-trend-monitor';
export const TRENDS_REPORTS_DIR = 'reports';
export const TRENDS_FILE_PATTERN = /^daily-trends-(\d{4}-\d{2}-\d{2})\.md$/;

/** 解析规则变化时递增；blob SHA 与它都没变时才跳过重新下载。 */
export const TRENDS_PARSER_VERSION = 1;

/** 单份报告最多 1 MiB；只保留最近 120 天（报告按日生成，更早的没有展示价值）。 */
export const MAX_REPORT_BYTES = 1024 * 1024;
export const MAX_TREND_DAYS = 120;
/** 单轮最多补录的日期数，与保留窗口一致：首次部署最多回填 120 天。 */
export const MAX_REPORT_FILES = MAX_TREND_DAYS;

/** 最新报告日期落后当前北京时间 2 天以上即视为陈旧。 */
export const TRENDS_STALE_AFTER_DAYS = 2;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** 与项目发现一致：commits/trees 走 PAT 配额，raw 下载匿名。 */
export interface TrendsApiAccess {
  readToken(): string | null;
  observeRateLimit(headers: Readonly<Record<string, string>>): void;
  shouldAbort?(): boolean;
}

export type TrendsSourceErrorCode = 'SOURCE_DATA_ANOMALY' | 'UPSTREAM_SCHEMA_CHANGED' | 'SERVICE_UNAVAILABLE';

export class TrendsSourceError extends Error {
  readonly code: TrendsSourceErrorCode;

  constructor(code: TrendsSourceErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TrendsSourceError';
    this.code = code;
  }
}

export interface TrendReportFile {
  readonly day: string;
  readonly blobSha: string;
}

export interface RemoteTrendReports {
  readonly commit: string;
  readonly files: readonly TrendReportFile[];
}

export function trendReportUrl(commit: string, day: string): string {
  return `https://raw.githubusercontent.com/${TRENDS_SOURCE_REPOSITORY}/${commit}/${TRENDS_REPORTS_DIR}/daily-trends-${day}.md`;
}

export function trendCommitUrl(commit: string): string {
  return `https://github.com/${TRENDS_SOURCE_REPOSITORY}/commit/${commit}`;
}

/**
 * 解析默认分支最新 commit 与 `reports/` 下的日报告清单。
 * 清单按日期倒序，只保留最近 `MAX_TREND_DAYS` 份；同一天出现重复路径时保留首个。
 *
 * 上游目录树目前只有一百多个节点、远低于 GitHub 的截断阈值，所以这里用 `recursive=1`
 * 一次取全；截断时无法证明清单完整，按上游契约异常失败而不是猜"哪些日期不存在"。
 */
export async function resolveRemoteTrendReports(
  transport: Transport,
  access?: TrendsApiAccess,
): Promise<RemoteTrendReports> {
  const headUrl = `https://api.github.com/repos/${TRENDS_SOURCE_REPOSITORY}/commits/HEAD`;
  const head = await getJson(transport, headUrl, '解析每日趋势来源提交', access);
  if (!isRecord(head) || typeof head.sha !== 'string' || !SHA_PATTERN.test(head.sha)) {
    throw new TrendsSourceError('UPSTREAM_SCHEMA_CHANGED', '提交响应缺少可用的 sha');
  }
  const commit = head.sha;

  const treeUrl = `https://api.github.com/repos/${TRENDS_SOURCE_REPOSITORY}/git/trees/${commit}?recursive=1`;
  const tree = await getJson(transport, treeUrl, '解析 reports 目录树', access);
  if (!isRecord(tree) || !Array.isArray(tree.tree)) {
    throw new TrendsSourceError('UPSTREAM_SCHEMA_CHANGED', '目录树响应缺少 tree 数组');
  }
  if (tree.truncated === true) {
    // 截断的树无法证明清单完整，不能据此把已有日期误判为“已删除”。
    throw new TrendsSourceError('UPSTREAM_SCHEMA_CHANGED', '上游目录树被截断，无法确认报告清单');
  }

  const byDay = new Map<string, string>();
  const prefix = `${TRENDS_REPORTS_DIR}/`;
  for (const node of tree.tree) {
    if (!isRecord(node) || node.type !== 'blob') continue;
    if (typeof node.path !== 'string' || typeof node.sha !== 'string') continue;
    if (!node.path.startsWith(prefix)) continue;
    const match = TRENDS_FILE_PATTERN.exec(node.path.slice(prefix.length));
    if (match === null) continue;
    const day = match[1] as string;
    if (!SHA_PATTERN.test(node.sha)) continue;
    if (!byDay.has(day)) byDay.set(day, node.sha);
  }

  const files = [...byDay.entries()]
    .map(([day, blobSha]) => ({ day, blobSha }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, MAX_TREND_DAYS);
  if (files.length === 0) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', 'reports/ 下没有找到任何日报告');
  }
  return { commit, files };
}

/** 下载单份报告文本；非 200 或超限都按来源异常处理。 */
export async function downloadTrendReport(
  transport: Transport,
  commit: string,
  day: string,
  access?: TrendsApiAccess,
): Promise<string> {
  const url = trendReportUrl(commit, day);
  let response: TransportResponse;
  try {
    response = await transport.request({ url, maxBytes: MAX_REPORT_BYTES });
  } catch (error) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `报告 ${day} 下载失败`, { cause: error });
  }
  if (response.status !== 200) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `报告 ${day} 下载失败：HTTP ${response.status}`);
  }
  if (Buffer.byteLength(response.body, 'utf8') > MAX_REPORT_BYTES) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `报告 ${day} 超过 1 MiB 上限`);
  }
  if (access?.shouldAbort?.() === true) {
    throw new TrendsSourceError('SERVICE_UNAVAILABLE', '导入已被取消');
  }
  return response.body;
}

const API_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2026-03-10',
};

async function getJson(
  transport: Transport,
  url: string,
  context: string,
  access?: TrendsApiAccess,
): Promise<unknown> {
  const token = access?.readToken() ?? null;
  const headers: Record<string, string> = { ...API_HEADERS };
  if (token !== null && token !== '') headers['authorization'] = `Bearer ${token}`;
  const response = await transport.request({ url, headers });
  access?.observeRateLimit(response.headers);
  if (response.status === 404) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `${context}：上游返回 404`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new TrendsSourceError('SERVICE_UNAVAILABLE', `${context}：上游 HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new TrendsSourceError('UPSTREAM_SCHEMA_CHANGED', `${context}：响应不是有效 JSON`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
