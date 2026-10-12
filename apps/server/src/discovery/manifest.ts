import type { Transport, TransportResponse } from '../integrations/transport/index.js';

/**
 * 可选发现模块的来源清单。
 *
 * 来源固定为 `difyz9/github-trend-monitor` 的 5 个分类文件；**绝不接入 `all_repos.csv`**
 * （固定提交实测缺表头，上游消费者也跳过它）。同一 commit 固定 raw URL，
 * 不添加持久化 CSV 副本或格式猜测 fallback。
 *
 * 本文件同时定义模块内部的 `SourceError`：`runDiscoveryImport` 把它转换成
 * `DiscoveryImportResult.errorCode` 后以结果返回；对外的 `DiscoveryError` 定义在
 * `index.ts`（仅 `readActiveDiscovery` 在功能关闭时抛 FEATURE_DISABLED）。
 */

export const SOURCE_REPOSITORY = 'difyz9/github-trend-monitor';

/** 固定优先序：冲突字段以清单靠前的文件为准。 */
export const SOURCE_FILES = [
  'AI_Agent.csv',
  'RAG.csv',
  'Multi-modal.csv',
  'Long_Context.csv',
  'Speculative_Model.csv',
] as const;

export type SourceFileName = (typeof SOURCE_FILES)[number];

/** 解析映射或校验规则变更时递增；blob SHA 与它都没变时才跳过重新下载。 */
export const PARSER_VERSION = 1;

export const SOURCE_DATA_DIR = 'data';

/** 每文件解压后最多 64 MiB。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** 整轮下载合计最多 128 MiB。 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** 源数据超过 72 小时未更新即视为陈旧。 */
export const SOURCE_STALE_AFTER_MS = 72 * 60 * 60 * 1000;

/** 分类 CSV 的 stars/forks 是来源记录值，采样时间未知，不得展示为实时 Star。 */
export const SOURCE_STATS_NOTE = '分类 CSV 的 Star/Fork 为来源记录值，采样时间未知，不代表实时数据';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** 仅用于 GitHub REST 请求；raw 下载不附加 Authorization，也不使用 PAT。 */
const API_HEADERS: Readonly<Record<string, string>> = {
  accept: 'application/vnd.github+json',
  // 实施固定 API 版本，升级时运行契约测试。
  'x-github-api-version': '2026-03-10',
};

/**
 * 发现模块对 GitHub API 的受控访问。
 *
 * - 该源走同一代理；API 部分（`/commits/HEAD`、`/git/trees`）与采集共用 PAT 配额：
 *   请求带 `authorization: Bearer <readToken()>`，响应头回调 `observeRateLimit`，
 *   由接线方解析 `x-ratelimit-*` 后交给 `budget.observe`。
 * - raw 下载不附加 PAT，仍保持匿名。
 * - 未接线（缺省 access）或 `readToken()` 返回 null（未配置凭证）时保持匿名请求：
 *   发现导入本就受业务门禁约束，调用方不会在未就绪时触发。
 * - `shouldAbort()` 用于门禁取消：门禁关闭后中止 raw 下载，本轮不发布。
 */
export interface DiscoveryApiAccess {
  /** 读取当前 PAT；null 表示未配置凭证。 */
  readToken(): string | null;
  /** 每次 API 响应后回调归一化响应头；接线方负责解析 x-ratelimit-* 并记账。 */
  observeRateLimit(headers: Readonly<Record<string, string>>): void;
  /** true 表示应立即中止本轮导入（每下载完一个文件检查一次）。 */
  shouldAbort?(): boolean;
}

export type SourceErrorCode = 'SOURCE_DATA_ANOMALY' | 'UPSTREAM_SCHEMA_CHANGED' | 'SERVICE_UNAVAILABLE';

/** 模块内部错误；`runDiscoveryImport` 捕获并映射为结果中的 errorCode。 */
export class SourceError extends Error {
  readonly code: SourceErrorCode;

  constructor(code: SourceErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SourceError';
    this.code = code;
  }
}

export interface SourceFileEntry {
  readonly name: SourceFileName;
  readonly blobSha: string;
}

/** 写入 `discovery_runs.source_manifest_json` 的来源快照。 */
export interface SourceManifest {
  readonly repository: typeof SOURCE_REPOSITORY;
  readonly commit: string;
  readonly parserVersion: number;
  readonly files: readonly SourceFileEntry[];
  readonly sourceUpdatedAt: number | null;
}

/** GitHub API 解析结果；data/ 下缺失的目标文件为 null（不产生完整 manifest）。 */
export interface RemoteSource {
  readonly commit: string;
  readonly sourceUpdatedAt: number | null;
  /** 与 SOURCE_FILES 一一对应。 */
  readonly blobShas: readonly (string | null)[];
}

export function commitUrl(commit: string): string {
  return `https://github.com/${SOURCE_REPOSITORY}/commit/${commit}`;
}

/** 同一 commit 固定 raw URL（不含 PAT）。 */
export function rawFileUrl(commit: string, name: SourceFileName): string {
  return `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${commit}/${SOURCE_DATA_DIR}/${name}`;
}

export function serializeManifest(manifest: SourceManifest): string {
  return JSON.stringify(manifest);
}

/**
 * 解析已存的 manifest JSON；形状不完整或不是本来源时返回 null。
 * 调用方把 null 当作“没有可比对的上一代次”，而不是猜测缺失内容。
 */
export function parseStoredManifest(json: string): SourceManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.repository !== SOURCE_REPOSITORY) return null;
  if (typeof value.commit !== 'string' || value.commit === '') return null;
  if (typeof value.parserVersion !== 'number') return null;
  if (!Array.isArray(value.files)) return null;

  const byName = new Map<string, string>();
  for (const entry of value.files) {
    if (!isRecord(entry)) return null;
    if (typeof entry.name !== 'string' || typeof entry.blobSha !== 'string' || entry.blobSha === '') return null;
    byName.set(entry.name, entry.blobSha);
  }

  const files: SourceFileEntry[] = [];
  for (const name of SOURCE_FILES) {
    const blobSha = byName.get(name);
    if (blobSha === undefined) return null;
    files.push({ name, blobSha });
  }

  const sourceUpdatedAt =
    typeof value.sourceUpdatedAt === 'number' && Number.isFinite(value.sourceUpdatedAt)
      ? value.sourceUpdatedAt
      : null;

  return {
    repository: SOURCE_REPOSITORY,
    commit: value.commit,
    parserVersion: value.parserVersion,
    files,
    sourceUpdatedAt,
  };
}

/** 只有 5 个目标 blob SHA 与 parser 版本都没变才跳过重新下载；文档提交变化不触发重载。 */
export function isSamePublishedData(stored: SourceManifest | null, remote: SourceManifest): boolean {
  if (stored === null || stored.parserVersion !== remote.parserVersion) return false;
  const storedShas = new Map(stored.files.map((entry) => [entry.name, entry.blobSha]));
  return remote.files.every((entry) => storedShas.get(entry.name) === entry.blobSha);
}

/**
 * 解析默认分支最新 commit 及该 commit 下 data/ 的 5 个目标文件 blob SHA。
 * 只做形状校验，不做“猜测修复”：上游响应不符合 GitHub REST 约定时按
 * UPSTREAM_SCHEMA_CHANGED 失败。
 *
 * 两个 API 请求都走 `access` 注入的凭证与配额观测。
 */
export async function resolveRemoteSource(
  transport: Transport,
  access?: DiscoveryApiAccess,
): Promise<RemoteSource> {
  const headUrl = `https://api.github.com/repos/${SOURCE_REPOSITORY}/commits/HEAD`;
  const head = await getJson(transport, headUrl, '解析默认分支提交', access);
  if (!isRecord(head) || typeof head.sha !== 'string' || !SHA_PATTERN.test(head.sha)) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', '提交响应缺少可用的 sha');
  }
  const commit = head.sha;

  let sourceUpdatedAt: number | null = null;
  const commitNode = isRecord(head.commit) ? head.commit : null;
  const committer = commitNode !== null && isRecord(commitNode.committer) ? commitNode.committer : null;
  if (committer !== null && typeof committer.date === 'string') {
    const parsed = Date.parse(committer.date);
    if (!Number.isNaN(parsed)) sourceUpdatedAt = parsed;
  }

  const treeUrl = `https://api.github.com/repos/${SOURCE_REPOSITORY}/git/trees/${commit}?recursive=1`;
  const tree = await getJson(transport, treeUrl, '解析 data 目录树', access);
  if (!isRecord(tree) || !Array.isArray(tree.tree)) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', '目录树响应缺少 tree 数组');
  }
  if (tree.truncated === true) {
    // 截断的树无法证明目标文件缺失还是未被列出，不能据此发布。
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', '上游目录树被截断，无法确认目标文件');
  }

  const blobsByPath = new Map<string, string>();
  for (const node of tree.tree) {
    if (!isRecord(node) || node.type !== 'blob') continue;
    if (typeof node.path !== 'string' || typeof node.sha !== 'string') continue;
    if (!SHA_PATTERN.test(node.sha)) continue;
    blobsByPath.set(node.path, node.sha);
  }

  const blobShas = SOURCE_FILES.map((name) => blobsByPath.get(`${SOURCE_DATA_DIR}/${name}`) ?? null);
  return { commit, sourceUpdatedAt, blobShas };
}

/** 5 个目标文件齐全才得到完整 manifest；否则返回 null（由调用方按缺失处理）。 */
export function buildManifest(remote: RemoteSource): SourceManifest | null {
  const files: SourceFileEntry[] = [];
  for (let index = 0; index < SOURCE_FILES.length; index += 1) {
    const name = SOURCE_FILES[index];
    const blobSha = remote.blobShas[index] ?? null;
    if (name === undefined || blobSha === null) return null;
    files.push({ name, blobSha });
  }
  return {
    repository: SOURCE_REPOSITORY,
    commit: remote.commit,
    parserVersion: PARSER_VERSION,
    files,
    sourceUpdatedAt: remote.sourceUpdatedAt,
  };
}

export function missingFileNames(remote: RemoteSource): readonly SourceFileName[] {
  return SOURCE_FILES.filter((_, index) => (remote.blobShas[index] ?? null) === null);
}

/**
 * 默认的来源下载：逐文件串行请求固定 raw URL（并发 1），不附加 Authorization。
 * 任一必需文件失败（网络错误或非 200）都按 SOURCE_DATA_ANOMALY 处理。
 * 每下载完一个文件检查 `access.shouldAbort()`；为 true 时立即中止本轮。
 */
export async function downloadSourceFiles(
  transport: Transport,
  commit: string,
  access?: DiscoveryApiAccess,
): Promise<Map<SourceFileName, string>> {
  const files = new Map<SourceFileName, string>();
  for (const name of SOURCE_FILES) {
    const url = rawFileUrl(commit, name);
    let response: TransportResponse;
    try {
      response = await transport.request({ url, maxBytes: MAX_FILE_BYTES });
    } catch (error) {
      throw new SourceError('SOURCE_DATA_ANOMALY', `必需文件 ${name} 下载失败`, { cause: error });
    }
    if (response.status !== 200) {
      throw new SourceError('SOURCE_DATA_ANOMALY', `必需文件 ${name} 下载失败：HTTP ${response.status}`);
    }
    if (Buffer.byteLength(response.body, 'utf8') > MAX_FILE_BYTES) {
      throw new SourceError('SOURCE_DATA_ANOMALY', `必需文件 ${name} 超过 64 MiB 上限`);
    }
    files.set(name, response.body);
    if (access?.shouldAbort?.() === true) {
      throw new SourceError('SERVICE_UNAVAILABLE', '导入已被取消，未完成的代次不会发布');
    }
  }
  return files;
}

async function getJson(
  transport: Transport,
  url: string,
  context: string,
  access?: DiscoveryApiAccess,
): Promise<unknown> {
  // TransportError 直接向上抛，由 runDiscoveryImport 统一映射为出站错误码。
  const token = access?.readToken() ?? null;
  const headers: Record<string, string> = { ...API_HEADERS };
  if (token !== null && token !== '') headers['authorization'] = `Bearer ${token}`;
  const response = await transport.request({ url, headers });
  // 无论成功与否都回调配额观测；接线方按 x-ratelimit-* 是否有值决定是否记账。
  access?.observeRateLimit(response.headers);
  if (response.status === 404) {
    throw new SourceError('SOURCE_DATA_ANOMALY', `${context}：上游返回 404`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SourceError('SERVICE_UNAVAILABLE', `${context}：上游 HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', `${context}：响应不是有效 JSON`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
