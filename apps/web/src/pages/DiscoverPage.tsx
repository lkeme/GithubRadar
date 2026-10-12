import { Ban, Plus, Radar, Search, SearchX, Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../components/ui/Button';
import { Pagination } from '../components/ui/Pagination';
import { EmptyState, ErrorState } from '../components/ui/States';
import { SelectField } from '../components/ui/Select';
import { OwnerAvatar } from '../components/Avatar';
import { RelativeTime } from '../components/RelativeTime';
import { LanguageMeta } from '../components/dashboard/RepoBits';
import { useAuth } from '../features/auth/AuthProvider';
import { useDashboardUi } from '../features/dashboard/ui-store';
import { useDiscovery } from '../features/repos/queries';
import type { DiscoveryItem } from '../lib/api';
import { ApiError, errorMessage } from '../lib/errors';
import { formatCompactCount, formatExactCount, safeExternalHref } from '../lib/format';
import { PAGE_SIZE, SEARCH_MAX_LENGTH } from '../lib/constants';
import { cn } from '../components/ui/cn';

/**
 * 项目发现：
 * 公开只读；来源记录值与采样时间分开说明；"加入监控"仅在登录时显示。
 * 发现模块是默认能力（无开关），导航常驻，因此这里不判断"是否启用"。
 *
 * 卡片只放"判断要不要关注"需要的字段：身份、简介、语言、来源 Star/Fork、来源分类与主题。
 * 采样时间恒为未知（来源不含该字段），来源首次记录等次要字段不上卡片——
 * 一律展示只会把每张卡压成同一密度的文字堆。
 */

/** 主题标签最多展示 4 个，其余折叠为 +N（完整列表在 title 里）。 */
const MAX_TOPIC_CHIPS = 4;

/** 语言/分类的 URL 参数上限：与看板搜索一致，对齐服务端 discovery 查询 schema。 */
const DISCOVERY_FILTER_MAX_LENGTH = 64;

/** 分类是来源文件名（`AI_Agent.csv`）；只改展示文案，筛选值仍用原始文件名。 */
function categoryLabel(name: string): string {
  return name.replace(/\.csv$/i, '').replace(/_/g, ' ');
}

/** 下拉选项必须含当前生效值：代次切换后某个语言可能不再出现，否则控件会退回占位符而筛选仍在生效。 */
function withActiveValue(options: readonly string[], active: string): string[] {
  if (active.length === 0 || options.includes(active)) return [...options];
  return [active, ...options];
}

function DiscoveryCard({
  item,
  index,
  canImport,
  onImport,
}: {
  item: DiscoveryItem;
  index: number;
  canImport: boolean;
  onImport: (fullName: string) => void;
}) {
  const href = safeExternalHref(item.url);
  const topics = item.topics.slice(0, MAX_TOPIC_CHIPS);
  const hiddenTopics = item.topics.slice(MAX_TOPIC_CHIPS);
  const titleClass = 'line-clamp-2 min-w-0 text-[16px] font-semibold leading-snug tracking-tight text-text wrap-anywhere';

  return (
    <li
      className="gr-card gr-lift gr-rise flex min-w-0 flex-col gap-2.5 p-4"
      style={{ '--gr-rise-delay': `${Math.min(index, 5) * 24}ms` } as CSSProperties}
    >
      <header className="flex min-w-0 items-start gap-3">
        <OwnerAvatar src={`https://avatars.githubusercontent.com/${item.fullName.split('/')[0] ?? ''}`} alt={item.fullName} size={36} />
        <div className="min-w-0 flex-1">
          {href === null ? (
            <span className={titleClass}>{item.fullName}</span>
          ) : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(titleClass, 'underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline')}
              title={`在 GitHub 打开 ${item.fullName}`}
            >
              {item.fullName}
            </a>
          )}
          {item.language !== null && item.language.length > 0 ? (
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 text-aux text-muted">
              <LanguageMeta language={item.language} />
            </p>
          ) : null}
        </div>
        {item.monitored ? (
          <span className="gr-chip shrink-0 border border-border bg-surface-2 text-muted">已在监控</span>
        ) : canImport ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Plus size={15} aria-hidden="true" />}
            onClick={() => {
              onImport(item.fullName);
            }}
          >
            加入监控
          </Button>
        ) : null}
      </header>

      {item.description !== null && item.description.length > 0 ? (
        <p className="line-clamp-2 wrap-break-word text-aux2 leading-relaxed text-muted" title={item.description}>
          {item.description}
        </p>
      ) : null}

      {/* 数据区与标签一起锚底：不同卡片高度不齐时读数仍在同一水平线上。 */}
      <div className="mt-auto flex flex-col gap-2.5 pt-1">
        <dl className="grid grid-cols-2 overflow-hidden rounded-control border border-border bg-inset">
          <SourceCountCell label="来源 Star" value={item.sourceStars} />
          <SourceCountCell label="来源 Fork" value={item.sourceForks} />
        </dl>

        {item.categories.length + topics.length + hiddenTopics.length > 0 ? (
          <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="来源分类与主题">
            {item.categories.map((value) => (
              <li key={`c-${value}`} className="gr-chip border border-accent/30 bg-accent-subtle text-accent-strong">
                {categoryLabel(value)}
              </li>
            ))}
            {topics.map((value) => (
              <li key={`t-${value}`} className="gr-chip border border-border text-muted">
                #{value}
              </li>
            ))}
            {hiddenTopics.length > 0 ? (
              <li
                tabIndex={0}
                title={hiddenTopics.map((value) => `#${value}`).join(' ')}
                className="gr-chip cursor-help border border-dashed border-border-strong text-muted"
              >
                +{hiddenTopics.length}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/** 内衬数据格：overline 标签 + 等宽读数；来源记录值不声明为实时值。 */
function SourceCountCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="min-w-0 border-r border-border px-3 py-2 last:border-r-0">
      <dt className="gr-label">{label}</dt>
      <dd className="mt-1 truncate text-[16px] leading-none">
        {value === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span
            tabIndex={0}
            title={`来源记录值 ${formatExactCount(value)}，采样时间未知`}
            aria-label={`${label} ${formatExactCount(value)} 个`}
            className="font-mono font-semibold tabular-nums text-text"
          >
            {formatCompactCount(value)}
          </span>
        )}
      </dd>
    </div>
  );
}

export function DiscoverPage() {
  const auth = useAuth();
  const ui = useDashboardUi();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL 参数钳制：服务端 discovery 查询 schema 限定 q ≤ 100、language/category ≤ 64，
  // 超长参数会让整个请求被 400 拒绝（整页“发现数据加载失败”），因此按上限截断后再使用与回写。
  const q = (searchParams.get('q') ?? '').slice(0, SEARCH_MAX_LENGTH);
  const language = (searchParams.get('language') ?? '').slice(0, DISCOVERY_FILTER_MAX_LENGTH);
  const category = (searchParams.get('category') ?? '').slice(0, DISCOVERY_FILTER_MAX_LENGTH);
  const rawPage = Number(searchParams.get('page') ?? '1');
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const [searchText, setSearchText] = useState(q);
  const debounceRef = useRef<number | null>(null);

  // URL 外部变化时同步输入框，同时取消防抖中的搜索：否则 400ms 内的浏览器返回会被挂起的定时器覆盖回去。
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const query = useDiscovery({
    q: q.length > 0 ? q : undefined,
    language: language.length > 0 ? language : undefined,
    category: category.length > 0 ? category : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const items = query.data?.data ?? [];
  const meta = query.data?.meta;
  const total = meta?.total ?? 0;

  const languageOptions = useMemo(() => withActiveValue(meta?.filters.languages ?? [], language), [meta?.filters.languages, language]);
  const categoryOptions = useMemo(() => withActiveValue(meta?.filters.categories ?? [], category), [meta?.filters.categories, category]);

  const update = (patch: { q?: string; language?: string; category?: string; page?: number }): void => {
    const next = new URLSearchParams();
    const nextQ = patch.q ?? q;
    const nextLanguage = patch.language ?? language;
    const nextCategory = patch.category ?? category;
    const nextPage = patch.page ?? 1;
    if (nextQ.length > 0) {
      next.set('q', nextQ);
    }
    if (nextLanguage.length > 0) {
      next.set('language', nextLanguage);
    }
    if (nextCategory.length > 0) {
      next.set('category', nextCategory);
    }
    if (nextPage > 1) {
      next.set('page', String(nextPage));
    }
    setSearchParams(next, { replace: patch.page === undefined && patch.q !== undefined });
  };

  // 防抖回调使用"当前"的 update：否则捕获 400ms 前的旧引用，输入期间切换语言/分类会被覆盖回旧值。
  const updateRef = useRef(update);
  updateRef.current = update;

  const cancelSearchDebounce = (): void => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  // 与看板筛选栏一致：键入 400ms 防抖，回车立即提交，避免每个字符都发起请求。
  const commitSearch = (value: string, immediate: boolean): void => {
    cancelSearchDebounce();
    if (immediate) {
      updateRef.current({ q: value });
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      updateRef.current({ q: value });
    }, 400);
  };

  const anomaly = query.error instanceof ApiError && query.error.code === 'SOURCE_DATA_ANOMALY';
  // 只有内部开关被直接改库置 0 时服务端才返回 FEATURE_DISABLED：这时给专门说明。
  const disabled = query.error instanceof ApiError && query.error.code === 'FEATURE_DISABLED';
  const source = meta?.source;
  // 已有数据时的后台重取失败不能把列表换成整页错误：TanStack Query 在保留 data 的同时
  // 会把 status 置为 error，只有"从未成功过"才是真正的加载失败。
  const loadFailed = query.isError && !anomaly && !disabled && query.data === undefined;
  const hasFilters = q.length > 0 || language.length > 0 || category.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-4 px-4 py-5 md:px-6 md:py-7 lg:px-8">
      <header className="gr-rise flex flex-col gap-1.5">
        <h1 className="text-display font-semibold text-text">项目发现</h1>
        <p className="text-aux2 leading-relaxed text-muted">
          按日导入的外部 GitHub 项目候选，不自动加入监控；来源数据与实时采集值分开标注。
        </p>
      </header>

      {source !== undefined && source !== null ? (
        <section
          aria-label="数据来源"
          className={cn(
            'flex flex-col gap-2 rounded-card border p-3.5 text-aux2 shadow-card',
            source.stale || anomaly
              ? 'border-warning/40 bg-warning-subtle text-text'
              : 'border-border bg-surface text-muted',
          )}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden="true" className="gr-icon-tile size-6">
              <Server size={13} />
            </span>
            {safeExternalHref(`https://github.com/${source.repository}`) !== null ? (
              <a
                href={`https://github.com/${source.repository}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {source.repository}
              </a>
            ) : (
              <span className="font-medium text-text">{source.repository}</span>
            )}
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
            <span>
              提交
              {safeExternalHref(source.commitUrl) !== null ? (
                <a
                  href={source.commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 font-mono text-accent underline-offset-2 hover:underline"
                  title="查看来源提交"
                >
                  {source.commit.slice(0, 8)}
                </a>
              ) : (
                <span className="ml-1 font-mono">{source.commit.slice(0, 8)}</span>
              )}
            </span>
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
            <span>
              导入于 <RelativeTime iso={source.importedAt} />
            </span>
            {source.sourceUpdatedAt !== null ? (
              <>
                <span aria-hidden="true" className="text-border-strong">
                  ·
                </span>
                <span>
                  源数据 <RelativeTime iso={source.sourceUpdatedAt} />
                </span>
              </>
            ) : null}
          </div>

          {/* 文件清单与字段口径是"需要时才读"的说明，收进可展开区，不占常驻视觉重量。 */}
          <details className="group">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-[4px] text-aux font-medium text-accent transition-colors duration-150 hover:text-accent-strong">
              <span className="transition-transform duration-150 group-open:rotate-90" aria-hidden="true">
                ›
              </span>
              数据说明
            </summary>
            <p className="mt-1 leading-relaxed text-aux">
              文件：{source.fileNames.join('、')}
              {source.note.length > 0 ? ` · ${source.note}` : ''}
            </p>
          </details>

          {source.stale || anomaly ? (
            <p className="flex items-center gap-1">
              <Ban size={14} aria-hidden="true" />
              源数据超过时限未更新，继续显示上一代数据；导入时间不等于每个项目统计的真实采样时间。
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-label="发现筛选" className="gr-card sticky top-14 z-30 flex flex-wrap items-center gap-2 p-3 shadow-card md:top-16">
        <div className="relative min-w-52 flex-1">
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={searchText}
            aria-label="搜索项目名称或描述"
            placeholder="搜索名称 / 描述"
            className="gr-input h-9 rounded-full pl-9"
            maxLength={SEARCH_MAX_LENGTH}
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
        </div>
        <SelectField
          ariaLabel="按语言筛选"
          className="h-10"
          value={language}
          onValueChange={(value) => {
            update({ language: value, page: 1 });
          }}
          placeholder="全部语言"
          options={[{ value: '', label: '全部语言' }, ...languageOptions.map((value) => ({ value, label: value }))]}
        />
        <SelectField
          ariaLabel="按分类筛选"
          className="h-10"
          value={category}
          onValueChange={(value) => {
            update({ category: value, page: 1 });
          }}
          placeholder="全部分类"
          options={[{ value: '', label: '全部分类' }, ...categoryOptions.map((value) => ({ value, label: categoryLabel(value) }))]}
        />
        {hasFilters ? (
          <Button
            size="sm"
            variant="ghost"
            // 视觉 36px + ::after 扩展 4px = 44px 触控目标，与同排 Select 一致。
            className="relative after:absolute after:inset-0 after:-m-1"
            onClick={() => {
              // 清除筛选同时取消待触发的搜索防抖并清空输入框：q 本来为空时（只筛了语言/分类），
              // 本地未提交的搜索文本不会经由 effect 复位，输入框会残留。
              cancelSearchDebounce();
              setSearchText('');
              setSearchParams(new URLSearchParams(), { replace: false });
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </section>

      {disabled ? (
        // 发现模块是默认能力，界面上没有开关；只有内部开关被直接改库置 0 时才会走到这里，
        // 因此要给出准确原因，而不是笼统的"加载失败"。
        <EmptyState
          icon={Ban}
          title="发现功能已关闭"
          description="发现模块默认启用；当前被内部开关关闭，重新启用后才会读取来源数据，核心监控不受影响。"
        />
      ) : anomaly ? (
        <ErrorState
          title="来源数据异常"
          description="本轮导入未发布新代次，继续展示上一代数据；管理员可检查来源后手动重试。"
          onRetry={() => {
            void query.refetch();
          }}
          retryBusy={query.isFetching}
        />
      ) : loadFailed ? (
        <ErrorState
          title="发现数据加载失败"
          description={errorMessage(query.error)}
          onRetry={() => {
            void query.refetch();
          }}
          retryBusy={query.isFetching}
        />
      ) : query.isPending ? (
        <div aria-hidden="true" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="gr-card flex flex-col gap-2.5 p-4">
              <div className="gr-skeleton h-3.5 w-1/2" />
              <div className="gr-skeleton h-3 w-full" />
              <div className="gr-skeleton h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : source === null || source === undefined ? (
        // 已启用但还没有活跃代次：与"筛选后没有匹配"是两件事，不能都写成"无匹配结果"。
        <EmptyState
          icon={Radar}
          title="尚未完成首次导入"
          description="来源数据尚未导入。服务启动后会自动执行首次导入；导入完成后这里显示候选项目，失败也会自动重试。"
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="无匹配结果"
          description={hasFilters ? '当前筛选条件下没有发现候选。' : '本代来源数据里没有候选。'}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item, index) => (
            <DiscoveryCard
              key={item.githubId}
              item={item}
              index={index}
              canImport={auth.isAuthenticated}
              onImport={(fullName) => {
                ui.openImport(fullName);
              }}
            />
          ))}
        </ul>
      )}

      {total > PAGE_SIZE ? (
        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={(nextPage) => {
            update({ page: nextPage });
          }}
          busy={query.isFetching}
        />
      ) : null}
    </div>
  );
}
