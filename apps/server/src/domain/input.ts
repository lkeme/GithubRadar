/**
 * GitHub 仓库输入解析。
 *
 * - 接受 `owner/repo`、`https://github.com/owner/repo`、末尾 `.git` 与末尾斜杠；
 *   只接受仓库根路径，不猜测 Issue / Release / tree 子路径的含义。
 * - 去除空行、首尾空白、查询参数与 fragment；用 `URL` 解析器验证协议（只 https）、
 *   精确 host（只 github.com），拒绝 userinfo、非标准端口、编码斜杠与空路径段。
 * - 去重键用规则化小写 `owner/repo`，展示大小写按输入原样保留（验证成功后由
 *   GitHub 返回的规范名覆盖）。
 */

export interface ParsedRepositoryInput {
  readonly owner: string;
  readonly repo: string;
  /** 去重用的规范化小写键（`owner/repo`）。 */
  readonly key: string;
  /** 规范化后的仓库根 URL（`https://github.com/{owner}/{repo}`）。 */
  readonly htmlUrl: string;
}

export type InputParseError =
  | 'EMPTY'
  | 'INVALID_FORMAT'
  | 'SUB_PATH'
  | 'USERINFO'
  | 'BAD_HOST'
  | 'BAD_PORT'
  | 'ENCODED_SLASH';

export type ParsedRepositoryResult =
  | { readonly ok: true; readonly value: ParsedRepositoryInput }
  | { readonly ok: false; readonly error: InputParseError };

/** 批量解析中的一行；`result` 为 null 表示该行超出单批行数上限、未再解析。 */
export interface ParsedInputRow {
  readonly index: number;
  readonly raw: string;
  readonly overflow: boolean;
  readonly result: ParsedRepositoryResult | null;
}

const GITHUB_HOST = 'github.com';
/** GitHub 合法字符：字母数字、`-`、`_`、`.`。 */
const LEGAL_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ENCODED_SLASH_PATTERN = /%2f|%5c/i;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 末尾 `.git` 后缀（大小写不敏感）在比较与展示中都被去掉。 */
function stripGitSuffix(segment: string): string {
  return /\.git$/i.test(segment) ? segment.slice(0, -4) : segment;
}

function normalizeSegment(segment: string): string | null {
  const name = stripGitSuffix(segment);
  if (name === '') return null;
  if (!LEGAL_SEGMENT.test(name)) return null;
  // 拒绝 `.`、`..` 与全点名称，不把路径穿越写法当成仓库名。
  if (/^\.+$/.test(name)) return null;
  return name;
}

function buildParsed(owner: string, repo: string): ParsedRepositoryInput {
  return {
    owner,
    repo,
    key: `${owner}/${repo}`.toLowerCase(),
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

function parseSegments(segments: readonly string[]): ParsedRepositoryResult {
  if (segments.length === 0) return { ok: false, error: 'INVALID_FORMAT' };
  if (segments.some((segment) => segment === '')) return { ok: false, error: 'INVALID_FORMAT' };
  if (segments.length > 2) return { ok: false, error: 'SUB_PATH' };
  if (segments.length < 2) return { ok: false, error: 'INVALID_FORMAT' };

  const [ownerSegment = '', repoSegment = ''] = segments;
  const owner = normalizeSegment(ownerSegment);
  const repo = normalizeSegment(repoSegment);
  if (owner === null || repo === null) return { ok: false, error: 'INVALID_FORMAT' };
  return { ok: true, value: buildParsed(owner, repo) };
}

/** 完整 URL 形式：查询参数与 fragment 由 URL 解析器自然剥离。 */
function parseUrlForm(raw: string): ParsedRepositoryResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'INVALID_FORMAT' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'USERINFO' };
  // `http://` 与其它协议一律拒绝；只接受 https。
  if (url.protocol !== 'https:') return { ok: false, error: 'INVALID_FORMAT' };
  // 默认 https 端口会被 URL 规范化去掉，非空即非标准端口。
  if (url.port !== '') return { ok: false, error: 'BAD_PORT' };
  if (url.hostname !== GITHUB_HOST) return { ok: false, error: 'BAD_HOST' };
  if (ENCODED_SLASH_PATTERN.test(url.pathname)) return { ok: false, error: 'ENCODED_SLASH' };

  // pathname 以 `/` 开头；去掉首个空段后按 owner/repo 校验。
  const segments = stripTrailingSlashes(url.pathname).split('/').slice(1);
  return parseSegments(segments);
}

/** 简写形式：`owner/repo`，同样支持查询参数、fragment 与末尾斜杠。 */
function parseShorthand(raw: string): ParsedRepositoryResult {
  const withoutFragment = raw.split('#', 1)[0] ?? '';
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? '';
  if (ENCODED_SLASH_PATTERN.test(withoutQuery)) return { ok: false, error: 'ENCODED_SLASH' };
  return parseSegments(stripTrailingSlashes(withoutQuery).split('/'));
}

export function parseRepositoryInput(raw: string): ParsedRepositoryResult {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'EMPTY' };
  if (SCHEME_PATTERN.test(text)) return parseUrlForm(text);
  return parseShorthand(text);
}

/**
 * 按行拆分输入：空行（含纯空白行）被移除，既不解析也不占用行数上限；
 * 超过 `maxRows` 的剩余行标记为 overflow，由调用方计入 overflowCount。
 */
export function splitRepositoryInputRows(text: string, maxRows: number): ParsedInputRow[] {
  const rows: ParsedInputRow[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const raw = line.trim();
    if (raw === '') continue;
    const index = rows.length;
    if (index >= maxRows) {
      rows.push({ index, raw, overflow: true, result: null });
      continue;
    }
    rows.push({ index, raw, overflow: false, result: parseRepositoryInput(raw) });
  }
  return rows;
}

/**
 * 批量解析：`accepted` 不去重，重复行保留原顺序与下标，由导入批次按规范键合并并逐项反馈。
 */
export function parseRepositoryInputs(
  text: string,
  maxRows: number,
): {
  accepted: ParsedRepositoryInput[];
  rejected: { index: number; raw: string; error: InputParseError }[];
  overflowCount: number;
} {
  const accepted: ParsedRepositoryInput[] = [];
  const rejected: { index: number; raw: string; error: InputParseError }[] = [];
  let overflowCount = 0;

  for (const row of splitRepositoryInputRows(text, maxRows)) {
    if (row.overflow || row.result === null) {
      overflowCount += 1;
      continue;
    }
    if (row.result.ok) {
      accepted.push(row.result.value);
    } else {
      rejected.push({ index: row.index, raw: row.raw, error: row.result.error });
    }
  }
  return { accepted, rejected, overflowCount };
}
