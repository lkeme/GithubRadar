import { Popover } from 'radix-ui';
import {
  Check,
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { PublicLabel } from '../../lib/api';
import { SEARCH_MAX_LENGTH, TREND_RANGE_OPTIONS } from '../../lib/constants';
import type { RepoView, TrendRange } from '../../lib/preferences';
import { cn } from '../ui/cn';
import { SelectField } from '../ui/Select';
import type { DashboardFilters } from '../../features/repos/filters';
import { hasActiveFilters } from '../../features/repos/filters';

/**
 * 筛选栏：搜索、分类标签、置顶、近 7 天变化、排序；条件写入 URL（由页面负责）。
 * 右侧为趋势区间与卡片/列表视图切换（视图偏好只存 localStorage）。
 * 桌面支持按 “/” 聚焦搜索（不拦截输入态按键与打开的弹层）。
 */

export interface FilterBarProps {
  filters: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>, options?: { replace?: boolean }) => void;
  onClear: () => void;
  labels: PublicLabel[];
  view: RepoView;
  onViewChange: (view: RepoView) => void;
  trendRange: TrendRange;
  onTrendRangeChange: (range: TrendRange) => void;
}

const SORT_OPTIONS = [
  { value: 'default', label: '默认排序' },
  { value: 'stars', label: '按 Star' },
  { value: 'name', label: '按名称' },
  { value: 'sourceActivity', label: '按来源时间' },
];

export function FilterBar({
  filters,
  onChange,
  onClear,
  labels,
  view,
  onViewChange,
  trendRange,
  onTrendRangeChange,
}: FilterBarProps) {
  const [searchText, setSearchText] = useState(filters.q);
  const debounceRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // “/” 聚焦搜索：只在焦点不在可输入元素上、且没有打开的弹层时生效，避免拦截正常输入。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      // 打开的 Radix 弹层（对话框/菜单）会接管键盘：此时“/”不抢焦点，避免把输入打到弹层外。
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]') !== null) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // URL 外部变化（浏览器返回/清除筛选）时同步输入框，同时取消防抖中的搜索：
  // 否则 400ms 内的浏览器返回会被挂起的定时器用 replace 覆盖回去。
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSearchText(filters.q);
  }, [filters.q]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // 防抖回调必须在触发时使用“当前”的 onChange：它在 DashboardPage 里用闭包里的 filters 合并补丁，
  // 若捕获 400ms 前的旧引用，输入期间点击其他筛选会被随后的回调覆盖回旧值。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const cancelDebounce = (): void => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  const commitSearch = (value: string, immediate: boolean): void => {
    cancelDebounce();
    if (immediate) {
      onChangeRef.current({ q: value, page: 1 }, { replace: true });
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      onChangeRef.current({ q: value, page: 1 }, { replace: true });
    }, 400);
  };

  const toggleLabel = (name: string): void => {
    const next = filters.labels.includes(name)
      ? filters.labels.filter((label) => label !== name)
      : [...filters.labels, name];
    onChange({ labels: next, page: 1 });
  };

  const active = hasActiveFilters(filters);
  // 视觉高度 36px 与搜索框对齐；用 ::after 向四周扩展 4px，使有效触控区达到 44px。
  const toggleClass = (pressed: boolean): string =>
    cn(
      'relative inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-aux2',
      'after:absolute after:inset-0 after:-m-1 after:rounded-full',
      'transition-[background-color,border-color,color] duration-150',
      pressed
        ? 'border-accent/50 bg-accent-subtle font-medium text-accent-strong'
        : 'border-border-strong bg-surface text-muted hover:border-muted/60 hover:bg-surface-2 hover:text-text',
    );

  return (
    <section aria-label="筛选" className="gr-card flex flex-col gap-2.5 p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            type="search"
            value={searchText}
            maxLength={SEARCH_MAX_LENGTH}
            aria-label="搜索仓库名称、别名或描述"
            placeholder="搜索名称 / 别名 / 描述"
            className="gr-input h-9 rounded-full pl-9 pr-10"
            onChange={(event) => {
              const value = event.target.value;
              setSearchText(value);
              commitSearch(value, false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitSearch(searchText, true);
              }
            }}
          />
          {/* “/” 快捷键提示：仅桌面且无输入时展示。 */}
          {searchText.length === 0 ? (
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-inset px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted sm:block"
            >
              /
            </kbd>
          ) : null}
        </div>

        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className={toggleClass(filters.labels.length > 0)} aria-label="按分类标签筛选">
              <SlidersHorizontal size={14} aria-hidden="true" />
              分类标签
              {filters.labels.length > 0 ? (
                <span className="rounded-full bg-accent px-1.5 font-mono text-aux leading-5 text-accent-contrast">
                  {filters.labels.length}
                </span>
              ) : null}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content sideOffset={6} align="start" className="gr-popover gr-anim-content z-[70] w-64 p-1.5">
              {labels.length === 0 ? (
                <p className="px-2.5 py-2 text-aux2 text-muted">暂无分类标签</p>
              ) : (
                <ul className="max-h-72 overflow-y-auto">
                  {labels.map((label) => {
                    const checked = filters.labels.includes(label.name);
                    return (
                      <li key={label.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() => {
                            toggleLabel(label.name);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left text-aux2 text-text transition-colors duration-100 hover:bg-surface-2"
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-150',
                              checked ? 'border-accent bg-accent text-accent-contrast' : 'border-border-strong bg-surface',
                            )}
                          >
                            {checked ? <Check size={12} /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{label.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <button
          type="button"
          className={toggleClass(filters.pinned)}
          aria-pressed={filters.pinned}
          aria-label="只看置顶仓库"
          onClick={() => {
            onChange({ pinned: !filters.pinned, page: 1 });
          }}
        >
          置顶
        </button>

        <button
          type="button"
          className={toggleClass(filters.changed)}
          aria-pressed={filters.changed}
          aria-label="只看近 7 天发现变化的仓库"
          onClick={() => {
            onChange({ changed: !filters.changed, page: 1 });
          }}
        >
          近 7 天变化
        </button>

        <SelectField
          ariaLabel="排序方式"
          className="h-9 rounded-full"
          value={filters.sort}
          onValueChange={(value) => {
            onChange({ sort: value as DashboardFilters['sort'], page: 1 });
          }}
          options={SORT_OPTIONS}
        />

        {active ? (
          <button
            type="button"
            onClick={() => {
              // 清除筛选同时取消待触发的搜索防抖并清空输入框：filters.q 本来为空时
              // （例如只筛了分类标签），本地未提交的搜索文本不会经由 effect 复位，输入框会残留。
              cancelDebounce();
              setSearchText('');
              onClear();
            }}
            className="relative inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-aux2 text-accent transition-[background-color,color] duration-150 after:absolute after:inset-0 after:-m-1 after:rounded-full hover:bg-surface-2 hover:text-accent-strong"
          >
            <X size={14} aria-hidden="true" />
            清除筛选
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="已选分类标签">
          {filters.labels.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-inset px-2.5 py-1 text-aux text-text"
            >
              {label}
              <button
                type="button"
                aria-label={`移除标签筛选 ${label}`}
                // 图标保持 12px 紧凑，::after 扩展命中区。刻意只用 10px 而不是拉满 44px：
                // 相邻 chip 间距只有 6px，更大的隐形命中区会把点击落到邻居上、误删其他标签；
                // 38px 是“可点中”与“不误伤邻居”之间的折中（触控目标以不破坏相邻
                // 目标为前提）。
                className="relative rounded-full text-muted transition-colors duration-150 after:absolute after:inset-0 after:-m-2.5 hover:text-text"
                onClick={() => {
                  toggleLabel(label);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-aux text-muted" htmlFor="trend-range-select">
            趋势区间
          </label>
          <SelectField
            id="trend-range-select"
            ariaLabel="趋势区间"
            className="h-9"
            value={String(trendRange)}
            onValueChange={(value) => {
              onTrendRangeChange(Number(value) as TrendRange);
            }}
            options={TREND_RANGE_OPTIONS.map((days) => ({ value: String(days), label: `${days} 天` }))}
          />
          <div
            role="group"
            aria-label="视图切换"
            className="relative inline-flex items-center gap-0.5 rounded-control border border-border bg-inset p-0.5"
          >
            {/* 滑块：仅 transform 位移，宽 = 两个等宽按钮之一。 */}
            <span
              aria-hidden="true"
              className={cn(
                'absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[6px] bg-surface shadow-card',
                'transition-transform duration-150 ease-gr',
                view === 'list' && 'translate-x-[calc(100%+2px)]',
              )}
            />
            <button
              type="button"
              aria-pressed={view === 'cards'}
              aria-label="卡片视图"
              onClick={() => {
                onViewChange('cards');
              }}
              className={cn(
                'relative z-10 inline-flex size-8 items-center justify-center rounded-[6px] transition-colors duration-150',
                'after:absolute after:inset-0 after:-m-1.5 after:rounded-[6px]',
                view === 'cards' ? 'text-accent' : 'text-muted hover:text-text',
              )}
            >
              <LayoutGrid size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={view === 'list'}
              aria-label="紧凑列表视图"
              onClick={() => {
                onViewChange('list');
              }}
              className={cn(
                'relative z-10 inline-flex size-8 items-center justify-center rounded-[6px] transition-colors duration-150',
                'after:absolute after:inset-0 after:-m-1.5 after:rounded-[6px]',
                view === 'list' ? 'text-accent' : 'text-muted hover:text-text',
              )}
            >
              <List size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
