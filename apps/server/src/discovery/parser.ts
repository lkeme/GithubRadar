import { Readable } from 'node:stream';

import { parse } from 'csv-parse';

import { MAX_DESCRIPTION_LENGTH } from '@githubradar/contracts';

import { MAX_FILE_BYTES, SourceError, type SourceFileName } from './manifest.js';

/**
 * 分类 CSV 解析。
 *
 * - 用 `csv-parse` 的流式 `parse` 处理引号、内嵌逗号、跨行字段与 UTF-8 BOM，
 *   不得手写 `split(',')`。
 * - 表头逐文件校验：12 个约定列必须齐全（缺列 = 上游 schema 变化，整轮失败）；
 *   额外列忽略，行内列数与表头不一致的行按坏行统计。
 * - 字段映射使用固定提交实测的真实表头：
 *   `id/name/description/url/stars/forks/language/topics/created_at/first_seen/is_active/domains`。
 * - 只读取原始仓库字段，不加载上游 AI 内容；文本按普通字符串处理，不解释 HTML。
 * - `is_active` 按要求解析但不上库（表无此列），也**不**把 false 解释为仓库已归档或不存在。
 */

export const EXPECTED_COLUMNS = [
  'id',
  'name',
  'description',
  'url',
  'stars',
  'forks',
  'language',
  'topics',
  'created_at',
  'first_seen',
  'is_active',
  'domains',
] as const;

/** 整轮合计最多解析 200,000 行。 */
export const MAX_TOTAL_ROWS = 200_000;
/** 单记录最大 1 MiB。 */
export const MAX_RECORD_BYTES = 1024 * 1024;
/** 描述落库截断（按 Unicode 码点计），与契约 MAX_DESCRIPTION_LENGTH 同一数值。 */
export const MAX_DESCRIPTION_CHARS = MAX_DESCRIPTION_LENGTH;
/** topics/domains 各最多 50 项。 */
export const MAX_LIST_ITEMS = 50;
/** 坏行比例超过 5% 时整轮失败；用整数比较避免浮点误差。 */
export const BAD_ROW_RATIO_DENOMINATOR = 20;

/**
 * 日期列形状：`YYYY-MM-DD`（first_seen）或带明确时区的 ISO 8601 时间（created_at）。
 * 不符的取值按未知（null）落库，不把上游任意字符串透传到对外展示字段。
 */
const SOURCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export interface ParsedCandidate {
  readonly githubId: number;
  readonly canonicalName: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stars: number | null;
  readonly forks: number | null;
  readonly topics: readonly string[];
  readonly domains: readonly string[];
  readonly firstSeen: string | null;
  readonly sourceCreatedAt: string | null;
  /** 按要求解析；下表无对应列，不参与发布，也不当作归档标志。 */
  readonly isActive: boolean | null;
}

export interface ParsedFile {
  readonly file: SourceFileName;
  /** 数据行（不含表头，含坏行）。 */
  readonly rowsTotal: number;
  readonly rowsValid: number;
  readonly rows: readonly ParsedCandidate[];
}

const INVALID_NUMBER = Symbol('invalid-number');

/** 解析输入按 1 MiB 字符分块推送：64 MiB 级文件解析期间事件循环在块之间仍可调度。 */
const PARSE_CHUNK_CHARS = 1024 * 1024;

function* contentChunks(content: string): Generator<string> {
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + PARSE_CHUNK_CHARS, content.length);
    // 不把代理对从中间切开：块尾是高位代理时后移一个码元，配对留给下一块。
    const codePoint = content.codePointAt(end - 1);
    if (codePoint !== undefined && codePoint > 0xffff) end -= 1;
    if (end <= offset) end = offset + 1;
    yield content.slice(offset, end);
    offset = end;
  }
}

/**
 * 流式解析一个分类文件。
 *
 * @param maxRows 本次调用允许解析的最大数据行数（整轮预算的剩余量）；
 *                超出即整轮失败，避免先解析再统计导致的额外内存占用。
 */
export async function parseCategoryCsv(
  file: SourceFileName,
  content: string,
  maxRows: number = MAX_TOTAL_ROWS,
): Promise<ParsedFile> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new SourceError('SOURCE_DATA_ANOMALY', `${file} 超过单文件 64 MiB 上限`);
  }

  const parser = parse({
    bom: true,
    columns: false,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: MAX_RECORD_BYTES,
    raw: true,
  });
  const source = Readable.from(contentChunks(content));
  source.pipe(parser);

  const rows: ParsedCandidate[] = [];
  let header: ReadonlyMap<string, number> | null = null;
  let headerLength = 0;
  let rowsTotal = 0;
  let rowsValid = 0;

  try {
    for await (const emitted of parser as AsyncIterable<{ record: unknown; raw: unknown }>) {
      const record = emitted.record;
      if (!Array.isArray(record) || !record.every((cell): cell is string => typeof cell === 'string')) {
        throw new SourceError('UPSTREAM_SCHEMA_CHANGED', `${file} 出现了非字符串记录`);
      }
      const raw = typeof emitted.raw === 'string' ? emitted.raw : record.join(',');

      if (header === null) {
        header = validateHeader(file, record);
        headerLength = record.length;
        continue;
      }

      rowsTotal += 1;
      if (rowsTotal > maxRows) {
        throw new SourceError(
          'SOURCE_DATA_ANOMALY',
          `${file} 使本轮解析行数超过 ${MAX_TOTAL_ROWS} 行上限`,
        );
      }
      if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) {
        throw new SourceError('SOURCE_DATA_ANOMALY', `${file} 存在超过 1 MiB 的单条记录`);
      }
      if (record.length !== headerLength) {
        // 坏行：列数与表头不一致（relax_column_count 让它出现在这里而不是抛错）。
        continue;
      }

      const candidate = buildCandidate(record, header);
      if (candidate === null) continue;
      rows.push(candidate);
      rowsValid += 1;
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SourceError('SOURCE_DATA_ANOMALY', `${file} CSV 解析失败：${detail}`, { cause: error });
  }

  if (header === null) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', `${file} 缺少表头，不能按位置解释数据`);
  }
  return { file, rowsTotal, rowsValid, rows };
}

function validateHeader(file: SourceFileName, header: readonly string[]): ReadonlyMap<string, number> {
  const normalized = header.map((cell) => cell.trim());
  const indexes = new Map<string, number>();
  normalized.forEach((name, index) => {
    if (!indexes.has(name)) indexes.set(name, index);
  });

  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const name of EXPECTED_COLUMNS) {
    const count = normalized.filter((cell) => cell === name).length;
    if (count === 0) missing.push(name);
    else if (count > 1) duplicated.push(name);
  }
  if (duplicated.length > 0) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', `${file} 表头列重复：${duplicated.join(', ')}`);
  }
  if (missing.length > 0) {
    throw new SourceError('UPSTREAM_SCHEMA_CHANGED', `${file} 表头缺少关键列：${missing.join(', ')}`);
  }
  return indexes;
}

function buildCandidate(
  record: readonly string[],
  indexes: ReadonlyMap<string, number>,
): ParsedCandidate | null {
  const cell = (name: string): string => {
    const index = indexes.get(name);
    return index === undefined ? '' : (record[index] ?? '');
  };

  const rawId = cell('id').trim();
  if (!/^[0-9]+$/.test(rawId)) return null;
  const githubId = Number(rawId);
  if (!Number.isSafeInteger(githubId) || githubId < 0) return null;

  const htmlUrl = normalizeRepositoryUrl(cell('url'));
  if (htmlUrl === null) return null;
  const canonicalName = htmlUrl.slice('https://github.com/'.length);

  const stars = parseCount(cell('stars'));
  if (stars === INVALID_NUMBER) return null;
  const forks = parseCount(cell('forks'));
  if (forks === INVALID_NUMBER) return null;

  return {
    githubId,
    canonicalName,
    htmlUrl,
    description: normalizedText(cell('description'), MAX_DESCRIPTION_CHARS),
    language: emptyToNull(cell('language')),
    stars,
    forks,
    topics: parseList(cell('topics')),
    domains: parseList(cell('domains')),
    firstSeen: sourceDate(cell('first_seen')),
    sourceCreatedAt: sourceDate(cell('created_at')),
    isActive: parseIsActive(cell('is_active')),
  };
}

/** URL 必须是 `https://github.com/{owner}/{repo}`；其余形态按坏行跳过并统计。 */
function normalizeRepositoryUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  if (url.port !== '' || url.search !== '' || url.hash !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  const segments = url.pathname.split('/');
  if (segments.length !== 3 || segments[0] !== '') return null;
  const owner = segments[1];
  const repo = segments[2];
  if (owner === undefined || repo === undefined) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}

/** 空 → null；存在但格式非法（负数、非整数、超出安全范围）→ INVALID_NUMBER（坏行）。 */
function parseCount(raw: string): number | null | typeof INVALID_NUMBER {
  const value = raw.trim();
  if (value === '') return null;
  if (!/^[0-9]+$/.test(value)) return INVALID_NUMBER;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : INVALID_NUMBER;
}

/** 上游写 `True`/`False`，按大小写不敏感解析；既非 true 也非 false 时为 null。 */
function parseIsActive(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** 上游把 topics/domains 写成逗号分隔字符串；去空、去重、最多 50 项。 */
function parseList(raw: string): readonly string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
    if (items.length >= MAX_LIST_ITEMS) break;
  }
  return items;
}

function emptyToNull(raw: string): string | null {
  const value = raw.trim();
  return value === '' ? null : value;
}

/** 日期列：空 → null；形状不符 → null（未知），不透传上游任意字符串。 */
function sourceDate(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  return SOURCE_DATE_PATTERN.test(value) ? value : null;
}

function normalizedText(raw: string, maxChars: number): string | null {
  const value = raw.trim();
  if (value === '') return null;
  const chars = [...value];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : value;
}
