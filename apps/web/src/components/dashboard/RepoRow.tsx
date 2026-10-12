import { GitFork, Lock, Pin, Star } from 'lucide-react';
import type { CSSProperties } from 'react';

import type { PublicRepository } from '../../lib/api';
import { serverNow, useNowTick } from '../../lib/clock';
import { parseIso } from '../../lib/relative-time';
import { OwnerAvatar } from '../Avatar';
import { Sparkline } from '../Sparkline';
import { LabelChip } from '../ui/LabelChip';
import { StatusIndicator, UpdateIndicator } from '../StatusIndicator';
import { cn } from '../ui/cn';
import { useDashboard } from './DashboardContext';
import {
  BranchLines,
  CheckedLine,
  LanguageMeta,
  NoteLine,
  PrereleaseLine,
  ReleaseLine,
  RepoTitleLink,
  SelectionCheckbox,
  StatValue,
} from './RepoBits';
import { RepoActions } from './RepoActions';

/**
 * 紧凑列表视图：
 * 桌面为表格式行（仓库 | 发布 | 分支 | 状态与操作），手机为纵向分组行；
 * 与卡片展示相同核心字段与操作，不隐藏核心字段、不横向滚动。
 */
export function RepoRow({ repo, index = 0 }: { repo: PublicRepository; index?: number }) {
  const { browse } = useDashboard();
  useNowTick();
  const expiresMs = parseIso(repo.changeExpiresAt);
  const changed = repo.hasRecentChange && Number.isFinite(expiresMs) && expiresMs > serverNow();
  return (
    <article
      className={cn(
        'gr-rise relative flex min-w-0 flex-col gap-2.5 p-4 lg:grid',
        'lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_13rem] lg:items-center lg:gap-4',
        'transition-[background-color] duration-150 hover:bg-inset',
        repo.pinned ? 'bg-accent-subtle/25' : null,
      )}
      style={{ '--gr-rise-delay': `${Math.min(index, 5) * 20}ms` } as CSSProperties}
    >
      {changed ? <span aria-hidden="true" className="gr-edge" /> : null}

      {/* 仓库：身份 + 热度统计（lg 以下统计留在本列，桌面端移入分支列）。 */}
      <div className="flex min-w-0 items-start gap-3">
        {browse.selectionActive ? <SelectionCheckbox id={repo.id} fullName={repo.fullName} /> : null}
        <OwnerAvatar src={repo.ownerAvatarUrl} alt={repo.fullName} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-1.5">
            <RepoTitleLink repo={repo} />
            {repo.pinned ? <Pin size={13} role="img" aria-label="已置顶" className="mt-1 shrink-0 text-accent" /> : null}
            {repo.isPrivate ? <Lock size={13} role="img" aria-label="私有仓库" className="mt-1 shrink-0 text-muted" /> : null}
          </div>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 text-aux text-muted">
            {repo.displayName !== null && repo.displayName.length > 0 ? (
              <span className="max-w-40 truncate" title={repo.displayName}>
                {repo.displayName}
              </span>
            ) : null}
            {repo.language !== null && repo.language.length > 0 ? <LanguageMeta language={repo.language} /> : null}
          </p>
          {repo.note !== null && repo.note.length > 0 ? <NoteLine note={repo.note} className="mt-0.5" /> : null}
          {repo.labels.length > 0 ? (
            <ul className="mt-1.5 flex min-w-0 flex-wrap gap-1" aria-label="分类标签">
              {repo.labels.map((label) => (
                <li key={label} className="min-w-0">
                  <LabelChip name={label} color={browse.labelColors.get(label) ?? null} />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-1.5 flex items-center gap-3 lg:hidden">
            <StatValue icon={Star} value={repo.stars} label="Star" />
            <StatValue icon={GitFork} value={repo.forks} label="Fork" />
          </div>
        </div>
      </div>

      {/* 发布：release + 预发布数据格。 */}
      <div className="flex flex-col gap-1 lg:pt-0.5">
        <ReleaseLine repo={repo} />
        <PrereleaseLine repo={repo} />
      </div>

      {/* 分支：分支数据格 + 桌面端热度统计。 */}
      <div className="flex flex-col gap-1 lg:pt-0.5">
        <BranchLines repo={repo} />
        <div className="mt-1.5 hidden items-center gap-3 lg:flex">
          <StatValue icon={Star} value={repo.stars} label="Star" />
          <StatValue icon={GitFork} value={repo.forks} label="Fork" />
        </div>
      </div>

      {/* 状态与操作：操作行 + 状态行 + 趋势，右对齐。 */}
      <div className="flex flex-col items-start gap-2 lg:items-end">
        <RepoActions repo={repo} />
        <div className="flex flex-col gap-1 lg:items-end">
          <div className="flex items-center gap-2.5">
            <UpdateIndicator hasRecentChange={repo.hasRecentChange} changeExpiresAt={repo.changeExpiresAt} />
            <StatusIndicator status={repo.status} />
          </div>
          <CheckedLine lastCheckedAt={repo.lastCheckedAt} />
        </div>
        <Sparkline points={repo.trends} days={browse.trendRange} metric="stars" />
      </div>
    </article>
  );
}
