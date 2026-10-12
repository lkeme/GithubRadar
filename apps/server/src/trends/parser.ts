import { TrendsSourceError } from './manifest.js';

/**
 * 日报告 markdown 解析。
 *
 * 报告结构固定为一张三列表格：
 *
 * ```
 * | Repository | Stars | Domain |
 * | --- | ---: | --- |
 * | [owner/name](https://github.com/owner/name) | 2416 | AI Agent |
 * ```
 *
 * 列按表头名字定位而不是按位置，避免上游调整列序后静默错位；
 * 缺列按上游契约变化失败，坏行只跳过并计数，坏行比例超过 5% 时整轮失败。
 * 报告里的同一仓库可能因分类不同出现两次，因此保留行序作为名次，不做去重。
 */

export const EXPORTED_COLUMNS = ['Repository', 'Stars', 'Domain'] as const;

/** 单份报告最多 200 行。 */
export const MAX_REPORT_ROWS = 200;
/** 坏行比例超过 5% 时整轮失败；整数比较避免浮点误差。 */
export const BAD_ROW_RATIO_DENOMINATOR = 20;

export interface ParsedTrendRow {
  /** 报告内名次，从 1 开始，按表格行序。 */
  readonly rank: number;
  readonly fullName: string;
  readonly url: string;
  readonly stars: number;
  readonly domain: string | null;
}

export interface ParsedTrendReport {
  readonly day: string;
  readonly rows: readonly ParsedTrendRow[];
  readonly rowsTotal: number;
  readonly rowsValid: number;
}

const TABLE_ROW = /^\|(.*)\|\s*$/;
const LINK_CELL = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

export function parseTrendReport(day: string, content: string): ParsedTrendReport {
  const lines = content.split(/\r?\n/);
  let header: { repository: number; stars: number; domain: number } | null = null;
  const rows: ParsedTrendRow[] = [];
  let rowsTotal = 0;
  let rowsValid = 0;

  for (const line of lines) {
    const match = TABLE_ROW.exec(line);
    if (match === null) continue;
    const cells = (match[1] ?? '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) continue;

    if (header === null) {
      const headers = cells.map((cell) => cell.toLowerCase());
      const repository = headers.indexOf('repository');
      const stars = headers.indexOf('stars');
      const domain = headers.indexOf('domain');
      if (repository < 0 || stars < 0 || domain < 0) {
        throw new TrendsSourceError(
          'UPSTREAM_SCHEMA_CHANGED',
          `${day} 的报告表头缺少列：${EXPORTED_COLUMNS.join(' / ')}`,
        );
      }
      header = { repository, stars, domain };
      continue;
    }

    rowsTotal += 1;
    if (rowsTotal > MAX_REPORT_ROWS) {
      throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `${day} 的报告行数超过 ${MAX_REPORT_ROWS} 行上限`);
    }

    const parsed = buildRow(cells, header, rows.length + 1);
    if (parsed === null) continue;
    rows.push(parsed);
    rowsValid += 1;
  }

  if (header === null) {
    throw new TrendsSourceError('UPSTREAM_SCHEMA_CHANGED', `${day} 的报告缺少表格表头`);
  }
  if (rowsTotal === 0) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `${day} 的报告没有数据行`);
  }
  const badRows = rowsTotal - rowsValid;
  if (badRows * BAD_ROW_RATIO_DENOMINATOR > rowsTotal) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `${day} 的报告坏行比例超过 5%（${badRows}/${rowsTotal}）`);
  }
  if (rows.length === 0) {
    throw new TrendsSourceError('SOURCE_DATA_ANOMALY', `${day} 的报告没有有效行`);
  }
  return { day, rows, rowsTotal, rowsValid };
}

function buildRow(
  cells: readonly string[],
  header: { repository: number; stars: number; domain: number },
  rank: number,
): ParsedTrendRow | null {
  const linkCell = cells[header.repository];
  const starsCell = cells[header.stars];
  if (linkCell === undefined || starsCell === undefined) return null;

  const link = LINK_CELL.exec(linkCell);
  if (link === null) return null;
  const url = normalizeRepoUrl(link[2] ?? '');
  if (url === null) return null;
  const fullName = url.slice('https://github.com/'.length);

  const starsText = starsCell.replace(/[,_\s]/g, '');
  if (!/^[0-9]+$/.test(starsText)) return null;
  const stars = Number(starsText);
  if (!Number.isSafeInteger(stars) || stars < 0) return null;

  const domainText = (cells[header.domain] ?? '').trim();
  return { rank, fullName, url, stars, domain: domainText === '' ? null : domainText };
}

/** 只要 `https://github.com/{owner}/{repo}`；其余形态按坏行跳过。 */
function normalizeRepoUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;
  if (parsed.port !== '' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const segments = parsed.pathname.split('/');
  if (segments.length !== 3 || segments[0] !== '') return null;
  const owner = segments[1];
  const repo = segments[2];
  if (owner === undefined || repo === undefined) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}
