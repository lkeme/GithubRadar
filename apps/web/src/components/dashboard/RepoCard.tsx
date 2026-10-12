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
import { BranchLines, CheckedLine, DescriptionBlock, LanguageMeta, NoteLine, PrereleaseLine, ReleaseLine, RepoTitleLink, SelectionCheckbox, StatValue } from './RepoBits';
import { RepoActions } from './RepoActions';

/**
 * 默认卡片网格视图（宽屏 3–4 列 / 中屏 2 列 / 手机 1 列）。
 * 结构分三段：身份区（头像+名称+简介）→ 内衬数据区（发布/分支仪表读数）→ 卡脚（热度、趋势、状态）。
 */
export function RepoCard({ repo, index = 0 }: { repo: PublicRepository; index?: number }) {
  const { browse } = useDashboard();
  useNowTick();
  // 左缘标记与卡脚“近 7 天有更新”同源判定：到期即同时消失。
  const expiresMs = parseIso(repo.changeExpiresAt);
  const changed = repo.hasRecentChange && Number.isFinite(expiresMs) && expiresMs > serverNow();
  return (
    <article
      className={cn(
        'gr-card gr-lift gr-rise relative flex h-full min-w-0 flex-col p-4',
        repo.pinned ? 'border-accent/40' : null,
      )}
      style={{ '--gr-rise-delay': `${Math.min(index, 5) * 24}ms` } as CSSProperties}
    >
      {changed ? <span aria-hidden="true" className="gr-edge" /> : null}
      <header className="flex min-w-0 items-start gap-3">
        {browse.selectionActive ? <SelectionCheckbox id={repo.id} fullName={repo.fullName} /> : null}
        <OwnerAvatar src={repo.ownerAvatarUrl} alt={repo.fullName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-1.5">
            <RepoTitleLink repo={repo} />
            {repo.pinned ? (
              <Pin size={14} role="img" aria-label="已置顶" className="mt-1 shrink-0 text-accent" />
            ) : null}
            {repo.isPrivate ? (
              <Lock size={14} role="img" aria-label="私有仓库" className="mt-1 shrink-0 text-muted" />
            ) : null}
          </div>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 text-aux text-muted">
            {repo.displayName !== null && repo.displayName.length > 0 ? (
              <span className="max-w-52 truncate" title={repo.displayName}>
                {repo.displayName}
              </span>
            ) : null}
            {repo.language !== null && repo.language.length > 0 ? <LanguageMeta language={repo.language} /> : null}
          </p>
        </div>
        <RepoActions repo={repo} />
      </header>

      <DescriptionBlock description={repo.description} />

      <NoteLine note={repo.note} />

      {repo.labels.length > 0 ? (
        <ul className="mt-2 flex min-w-0 flex-wrap gap-1.5" aria-label="分类标签">
          {repo.labels.map((label) => (
            <li key={label} className="min-w-0">
              <LabelChip name={label} color={browse.labelColors.get(label) ?? null} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* 内衬数据区：低饱和底 + overline 标签，把“发布/分支”排成仪表读数。
          外层 mt-auto 锚底 + pt-3 保证与上方标签/简介始终有最小呼吸间距（不因同行高度对齐而贴死）。 */}
      <div className="mt-auto pt-3">
        <div className="flex flex-col gap-1.5 rounded-control border border-border/70 bg-inset p-2.5 pt-2">
          <ReleaseLine repo={repo} />
          <PrereleaseLine repo={repo} />
          <BranchLines repo={repo} />
        </div>
      </div>

      <footer className="mt-3 flex flex-col gap-2 border-t border-border pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex items-center gap-3">
            <StatValue icon={Star} value={repo.stars} label="Star" />
            <StatValue icon={GitFork} value={repo.forks} label="Fork" />
          </div>
          <Sparkline points={repo.trends} days={browse.trendRange} metric="stars" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CheckedLine lastCheckedAt={repo.lastCheckedAt} />
          <div className="flex items-center gap-2.5">
            <UpdateIndicator hasRecentChange={repo.hasRecentChange} changeExpiresAt={repo.changeExpiresAt} />
            <StatusIndicator status={repo.status} />
          </div>
        </div>
      </footer>
    </article>
  );
}
