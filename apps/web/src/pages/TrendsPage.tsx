import { Minus, Radar, SearchX, Server, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { Pagination } from '../components/ui/Pagination';
import { SelectField } from '../components/ui/Select';
import { EmptyState, ErrorState } from '../components/ui/States';
import { RelativeTime } from '../components/RelativeTime';
import { useTrends } from '../features/repos/queries';
import type { DailyTrendItem } from '../lib/api';
import { ApiError, errorMessage } from '../lib/errors';
import { formatExactCount, safeExternalHref } from '../lib/format';
import { PAGE_SIZE } from '../lib/constants';
import { cn } from '../components/ui/cn';

/**
 * 每日趋势：
 * 公开只读；来源是外部仓库每天生成的一份 Top 20 报告快照，与项目发现的候选全集是
 * 同一上游的两个视图。名次变化只与"上一份可用报告"比较（缺日不补零），
 * 报告里的 Star 是生成时的记录值，不声明为实时数据。
 */

/** 名次变化：上升/下降/新上榜；没有上一份报告时整体不显示变化列。 */
function RankDelta({ rank, previousRank }: { rank: number; previousRank: number | null }) {
  if (previousRank === null) {
    return (
      <span className="inline-flex items-center gap-1 text-aux text-muted">
        <Minus size={12} aria-hidden="true" />
        新上榜
      </span>
    );
  }
  const delta = previousRank - rank;
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-aux text-muted">
        <Minus size={12} aria-hidden="true" />
        持平
      </span>
    );
  }
  const rising = delta > 0;
  return (
    <span className={cn('inline-flex items-center gap-1 text-aux tabular-nums', rising ? 'text-success' : 'text-danger')}>
      {rising ? <TrendingUp size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
      {rising ? `↑${delta}` : `↓${-delta}`}
    </span>
  );
}

function TrendRow({ item, showDelta }: { item: DailyTrendItem; showDelta: boolean }) {
  const href = safeExternalHref(item.url);
  return (
    <li className="grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 sm:grid-cols-[3rem_1fr_6rem]">
      <span className="font-mono text-[15px] font-semibold tabular-nums text-muted">{item.rank}</span>
      <div className="min-w-0">
        {href === null ? (
          <span className="block min-w-0 truncate text-[15px] font-medium text-text">{item.fullName}</span>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="block min-w-0 truncate text-[15px] font-medium text-text underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline"
            title={`在 GitHub 打开 ${item.fullName}`}
          >
            {item.fullName}
          </a>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-aux text-muted">
          {item.domain !== null ? <span className="gr-chip border border-border text-muted">{item.domain}</span> : null}
          {showDelta ? <RankDelta rank={item.rank} previousRank={item.previousRank} /> : null}
        </p>
      </div>
      <span
        tabIndex={0}
        title={`报告记录值 ${formatExactCount(item.stars)}`}
        aria-label={`Star ${formatExactCount(item.stars)} 个`}
        className="justify-self-end font-mono text-aux2 font-semibold tabular-nums text-text"
      >
        {formatExactCount(item.stars)}
      </span>
    </li>
  );
}

/** 报告日期形状；与契约 DailyTrendQuery 的 day 校验同源，不合法的 URL 参数不发给服务端。 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function TrendsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawDay = (searchParams.get('day') ?? '').trim();
  // URL 是用户可编辑的输入：形状不符时按"未指定"处理（回落到最新），
  // 不能把 `day=abc` 原样发给服务端——那会让整个请求被 400 拒绝、页面变成加载失败。
  const day = DAY_PATTERN.test(rawDay) ? rawDay : '';
  const rawPage = Number(searchParams.get('page') ?? '1');
  const page = Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const query = useTrends({
    ...(day.length > 0 ? { day } : {}),
    page,
    pageSize: PAGE_SIZE,
  });

  const items = query.data?.data ?? [];
  const meta = query.data?.meta;
  const total = meta?.total ?? 0;
  const days = meta?.days ?? [];

  /** 日期选项只来自服务端返回的完整清单，不从前页数据猜。 */
  const dayOptions = useMemo(() => days.map((value) => ({ value, label: value })), [days]);

  // 服务端会把不存在的日期回落到最新一份：URL 必须跟着收敛，否则"选中态"与实际数据不一致。
  // 形状非法（如 day=abc）的取值同样要清掉，避免 URL 与页面内容长期不一致。
  const effectiveDay = meta?.day ?? null;
  useEffect(() => {
    if (rawDay !== '' && day === '') {
      const next = new URLSearchParams(searchParams);
      next.delete('day');
      next.delete('page');
      setSearchParams(next, { replace: true });
      return;
    }
    if (effectiveDay === null || day === '' || day === effectiveDay) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('page');
    if (effectiveDay === days[0]) {
      next.delete('day');
    } else {
      next.set('day', effectiveDay);
    }
    setSearchParams(next, { replace: true });
  }, [day, days, effectiveDay, rawDay, searchParams, setSearchParams]);

  const updateDay = (value: string): void => {
    const next = new URLSearchParams();
    if (value.length > 0) {
      next.set('day', value);
    }
    setSearchParams(next, { replace: false });
  };

  const disabled = query.error instanceof ApiError && query.error.code === 'FEATURE_DISABLED';
  const loadFailed = query.isError && !disabled && query.data === undefined;
  const source = meta?.source;
  // 只有确实存在更早的报告时才展示名次变化：否则每一行都会显示"新上榜"。
  const showDelta = meta?.hasPrevious ?? false;

  return (
    <div className="mx-auto flex w-full max-w-[112rem] flex-col gap-4 px-4 py-5 md:px-6 md:py-7 lg:px-8">
      <header className="gr-rise flex flex-col gap-1.5">
        <h1 className="text-display font-semibold text-text">每日趋势</h1>
        <p className="text-aux2 leading-relaxed text-muted">
          外部趋势报告每天生成一份 Top 20 快照；名次变化只与上一份报告比较，缺日不补零。
        </p>
      </header>

      {source !== null && source !== undefined ? (
        <section
          aria-label="数据来源"
          className={cn(
            'flex flex-col gap-2 rounded-card border p-3.5 text-aux2 shadow-card',
            source.stale ? 'border-warning/40 bg-warning-subtle text-text' : 'border-border bg-surface text-muted',
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
              报告日期 <span className="font-mono">{meta?.day ?? '—'}</span>
            </span>
            <span aria-hidden="true" className="text-border-strong">
              ·
            </span>
            <span>
              导入于 <RelativeTime iso={source.importedAt} />
            </span>
          </div>
          <details className="group">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-[4px] text-aux font-medium text-accent transition-colors duration-150 hover:text-accent-strong">
              <span className="transition-transform duration-150 group-open:rotate-90" aria-hidden="true">
                ›
              </span>
              数据说明
            </summary>
            <p className="mt-1 leading-relaxed text-aux">{source.note}</p>
          </details>
          {source.stale ? (
            <p className="flex items-center gap-1">
              <TrendingDown size={14} aria-hidden="true" />
              最新报告已超过两天未更新，继续显示已有数据。
            </p>
          ) : null}
        </section>
      ) : null}

      {days.length > 0 ? (
        <section aria-label="趋势筛选" className="gr-card sticky top-14 z-30 flex flex-wrap items-center gap-2 p-3 shadow-card md:top-16">
          <SelectField
            ariaLabel="选择报告日期"
            className="h-10"
            value={day}
            onValueChange={updateDay}
            placeholder={dayOptions[0]?.label ?? '最新报告'}
            options={dayOptions}
          />
          <span className="text-aux text-muted">共 {days.length} 份报告</span>
        </section>
      ) : null}

      {disabled ? (
        <EmptyState icon={Radar} title="每日趋势未启用" description="当前部署未接入每日趋势读取端口，核心监控不受影响。" />
      ) : loadFailed ? (
        <ErrorState
          title="趋势数据加载失败"
          description={errorMessage(query.error)}
          onRetry={() => {
            void query.refetch();
          }}
          retryBusy={query.isFetching}
        />
      ) : query.isPending ? (
        <div aria-hidden="true" className="gr-card flex flex-col divide-y divide-border">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 p-3.5">
              <div className="gr-skeleton h-4 w-6" />
              <div className="gr-skeleton h-3.5 w-40" />
              <div className="gr-skeleton ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      ) : source === null || source === undefined ? (
        <EmptyState
          icon={Radar}
          title="尚未导入趋势报告"
          description="服务启动后会自动抓取最近的日报告；首次导入完成后这里显示榜单。"
        />
      ) : items.length === 0 ? (
        <EmptyState icon={SearchX} title="该日期没有数据" description="所选报告日期没有可展示的条目。" />
      ) : (
        <ul aria-label="每日趋势榜单" className="gr-card divide-y divide-border">
          {items.map((item) => (
            <TrendRow key={`${String(item.rank)}-${item.fullName}`} item={item} showDelta={showDelta} />
          ))}
        </ul>
      )}

      {total > PAGE_SIZE ? (
        <Pagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          onPageChange={(nextPage) => {
            const next = new URLSearchParams(searchParams);
            if (nextPage > 1) {
              next.set('page', String(nextPage));
            } else {
              next.delete('page');
            }
            setSearchParams(next, { replace: false });
          }}
          busy={query.isFetching}
        />
      ) : null}
    </div>
  );
}
