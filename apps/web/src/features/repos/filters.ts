import type { RepositorySort } from '@githubradar/contracts';

import { MAX_LABELS_PER_REPO, MAX_LABEL_NAME_LENGTH, SEARCH_MAX_LENGTH } from '../../lib/constants';

/**
 * 看板筛选条件：
 * 搜索 / 分类标签 / 置顶 / 近 7 天变化 / 排序 / 页码写入 URL，浏览器返回可恢复。
 */

export interface DashboardFilters {
  q: string;
  labels: string[];
  pinned: boolean;
  changed: boolean;
  sort: RepositorySort;
  page: number;
}

export const DEFAULT_FILTERS: DashboardFilters = {
  q: '',
  labels: [],
  pinned: false,
  changed: false,
  sort: 'default',
  page: 1,
};

const SORT_VALUES: readonly RepositorySort[] = ['default', 'stars', 'name', 'sourceActivity'];

function isSort(value: string | null): value is RepositorySort {
  return value !== null && (SORT_VALUES as readonly string[]).includes(value);
}

function parsePage(value: string | null): number {
  if (value === null) {
    return 1;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export function parseFilters(search: URLSearchParams): DashboardFilters {
  const rawQ = search.get('q') ?? '';
  const q = rawQ.slice(0, SEARCH_MAX_LENGTH);
  const rawLabels = search.get('labels') ?? '';
  const labels = Array.from(
    new Set(
      rawLabels
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label.length > 0 && label.length <= MAX_LABEL_NAME_LENGTH),
    ),
  ).slice(0, MAX_LABELS_PER_REPO);
  const sort = isSort(search.get('sort')) ? (search.get('sort') as RepositorySort) : 'default';
  return {
    q,
    labels,
    pinned: search.get('pinned') === 'true',
    changed: search.get('changed') === 'true',
    sort,
    page: parsePage(search.get('page')),
  };
}

export function filtersToSearch(filters: DashboardFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.q.length > 0) {
    search.set('q', filters.q);
  }
  if (filters.labels.length > 0) {
    search.set('labels', filters.labels.join(','));
  }
  if (filters.pinned) {
    search.set('pinned', 'true');
  }
  if (filters.changed) {
    search.set('changed', 'true');
  }
  if (filters.sort !== 'default') {
    search.set('sort', filters.sort);
  }
  if (filters.page > 1) {
    search.set('page', String(filters.page));
  }
  return search;
}

/**
 * 查询键。趋势窗口参与请求（列表按该窗口返回趋势点），因此必须计入键，
 * 否则切换区间会命中旧缓存、显示与所选区间不符的数据。
 */
export function filtersKey(filters: DashboardFilters, trendDays: number): string {
  return [
    filters.q,
    filters.labels.join('\u0001'),
    filters.pinned ? '1' : '0',
    filters.changed ? '1' : '0',
    filters.sort,
    String(filters.page),
    `d${String(trendDays)}`,
  ].join('\u0002');
}

export function hasActiveFilters(filters: DashboardFilters): boolean {
  return (
    filters.q.length > 0 || filters.labels.length > 0 || filters.pinned || filters.changed || filters.sort !== 'default'
  );
}
