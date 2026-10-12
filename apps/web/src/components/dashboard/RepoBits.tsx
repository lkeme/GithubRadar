import { Checkbox } from 'radix-ui';
import { Check, ChevronRight, ExternalLink, GitBranch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { PublicRepository } from '../../lib/api';
import { formatCompactCount, formatExactCount, safeExternalHref } from '../../lib/format';
import { languageColor } from '../../lib/language-colors';
import { cn } from '../ui/cn';
import { RelativeTime } from '../RelativeTime';
import { NotCheckedYet } from '../StatusIndicator';
import { useDashboard } from './DashboardContext';

/** 卡片与列表共用的展示片段。 */

export function SelectionCheckbox({ id, fullName }: { id: string; fullName: string }) {
  const { browse } = useDashboard();
  return (
    <Checkbox.Root
      checked={browse.selected.has(id)}
      onCheckedChange={() => {
        browse.toggleSelected(id);
      }}
      aria-label={`选择 ${fullName}`}
      className={cn(
        'relative mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-surface shadow-card',
        // 触控目标：视觉 20px + ::after 外扩 12px = 44px；相邻的只有头像与简介文本，不与可点目标重叠。
        'after:absolute after:inset-0 after:-m-3 after:rounded-[5px]',
        'transition-[background-color,border-color] duration-150',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-contrast',
      )}
    >
      <Checkbox.Indicator>
        <Check size={13} aria-hidden="true" />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function RepoTitleLink({ repo }: { repo: PublicRepository }) {
  const href = safeExternalHref(repo.url);
  const classes = 'min-w-0 text-[16px] font-semibold leading-snug tracking-tight text-text line-clamp-2 wrap-anywhere';
  if (href === null) {
    return <span className={classes}>{repo.fullName}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(classes, 'underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline')}
      title={`在 GitHub 打开 ${repo.fullName}`}
    >
      {repo.fullName}
    </a>
  );
}

/** 语言色点：静态 linguist 色板辅助扫读，未知语言回落中性点；颜色不承载状态。 */
export function LanguageMeta({ language }: { language: string }) {
  const color = languageColor(language);
  return (
    <span className="inline-flex items-center gap-1.5 text-aux text-muted">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          color === null ? 'border border-border-strong bg-surface-2' : 'ring-1 ring-inset ring-black/10 dark:ring-white/15',
        )}
        style={color !== null ? { backgroundColor: color } : undefined}
      />
      {language}
    </span>
  );
}

export function StatValue({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-aux text-muted">
      <Icon size={14} aria-hidden="true" className="shrink-0" />
      <span
        tabIndex={0}
        title={`${formatExactCount(value)} ${label}`}
        aria-label={`${label} ${formatExactCount(value)} 个`}
        className="rounded-[4px] font-mono text-aux2 tabular-nums text-text"
      >
        {formatCompactCount(value)}
      </span>
    </span>
  );
}

/** 简介单行截断，可展开原文，不隐藏或丢弃核心数据。 */
export function DescriptionBlock({ description }: { description: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (description === null || description.length === 0) {
    return null;
  }
  const long = description.length > 60;
  return (
    <div className="min-w-0 text-aux leading-relaxed text-muted">
      <p className={cn('wrap-break-word', !expanded && 'line-clamp-1')}>{description}</p>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((value) => !value);
          }}
          className="mt-0.5 inline-flex min-h-11 items-center gap-0.5 rounded-[4px] text-aux font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
        >
          {expanded ? '收起简介' : '展开简介'}
          <ChevronRight size={12} aria-hidden="true" className={cn('transition-transform duration-150', expanded && 'rotate-90')} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 公开备注：卡片与列表共用的单行展示（与“简介”同为低对比文本行）。
 * 编辑抽屉承诺备注会公开展示，因此两个视图都要渲染；单行截断 + title 给出完整文本。
 */
export function NoteLine({ note, className }: { note: string | null; className?: string }) {
  if (note === null || note.length === 0) {
    return null;
  }
  return (
    <p className={cn('min-w-0 truncate text-aux leading-relaxed text-muted', className)} title={note}>
      {note}
    </p>
  );
}

/**
 * 数据格行：overline 标签 + 等宽值 + 相对时间。
 * 标签列固定宽度，发布/分支/预发布在纵向对齐成仪表读数（克制的小面积信息提示）。
 */
function DataCell({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('flex min-w-0 items-baseline gap-2', className)}>
      <span className="gr-label w-10 shrink-0">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">{children}</span>
    </p>
  );
}

const VERSION_CLASS =
  'max-w-44 truncate font-mono text-aux2 font-medium text-text underline-offset-2 transition-colors duration-150 hover:text-accent hover:underline';

export function ReleaseLine({ repo }: { repo: PublicRepository }) {
  const release = repo.latestRelease;
  if (release === null) {
    return (
      <DataCell label="发布">
        <span className="text-aux text-muted">暂无Release</span>
      </DataCell>
    );
  }
  const href = safeExternalHref(release.url);
  return (
    <DataCell label="发布">
      {href !== null ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={VERSION_CLASS} title={`${release.version} 的 Release 页面`}>
          {release.version}
        </a>
      ) : (
        <span className="max-w-44 truncate font-mono text-aux2 font-medium text-text">{release.version}</span>
      )}
      <RelativeTime iso={release.publishedAt} prefix="发布于" className="text-aux text-muted" />
    </DataCell>
  );
}

export function PrereleaseLine({ repo }: { repo: PublicRepository }) {
  const prerelease = repo.recentPrerelease;
  if (prerelease === null) {
    return null;
  }
  const candidate = prerelease.candidate;
  return (
    <DataCell label="预发布">
      {candidate !== null ? (
        <>
          <span className="max-w-44 truncate font-mono text-aux2 font-medium text-text" title="独立于最新正式版；固定覆盖发布列表前 20 条">
            {candidate.version}
          </span>
          <RelativeTime iso={candidate.publishedAt} prefix="发布于" className="text-aux text-muted" />
        </>
      ) : (
        <span className="text-aux text-muted" title="固定覆盖发布列表前 20 条，不代表全仓最新预发布">
          窗口内无预发布
        </span>
      )}
      {prerelease.coverage.mayHaveMore ? (
        <span
          className="text-aux text-muted"
          title={`窗口内观测到 ${prerelease.coverage.observedCount} 条，可能还有更早的发布未覆盖`}
        >
          可能超出覆盖
        </span>
      ) : null}
    </DataCell>
  );
}

export function BranchLines({ repo }: { repo: PublicRepository }) {
  // 已初始化但尚无提交（空基线）的 committedAt 为 null，排在最后。
  const branches = [...repo.branches].sort((a, b) => {
    if (a.committedAt === null) {
      return b.committedAt === null ? 0 : 1;
    }
    if (b.committedAt === null) {
      return -1;
    }
    return a.committedAt < b.committedAt ? 1 : -1;
  });
  if (branches.length === 0) {
    return (
      <DataCell label="分支">
        <span className="inline-flex items-center gap-1.5 text-aux text-muted">
          <GitBranch size={13} aria-hidden="true" className="shrink-0" />
          暂无提交
        </span>
      </DataCell>
    );
  }
  const visible = branches.slice(0, 2);
  const hidden = branches.slice(2);
  return (
    <div className="flex flex-col gap-1">
      {visible.map((branch) => (
        <BranchLine key={branch.name} label="分支" name={branch.name} committedAt={branch.committedAt} url={branch.url} />
      ))}
      {hidden.length > 0 ? (
        <details className="group ml-12">
          <summary className="inline-flex cursor-pointer select-none items-center gap-0.5 rounded-[4px] text-aux font-medium text-accent transition-colors duration-150 hover:text-accent-strong [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} aria-hidden="true" className="transition-transform duration-150 group-open:rotate-90" />
            展开 {hidden.length} 个分支
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {hidden.map((branch) => (
              <BranchLine key={branch.name} label="" name={branch.name} committedAt={branch.committedAt} url={branch.url} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function BranchLine({
  label,
  name,
  committedAt,
  url,
}: {
  label: string;
  name: string;
  committedAt: string | null;
  url: string;
}) {
  const href = safeExternalHref(url);
  return (
    <DataCell label={label}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="max-w-52 truncate font-mono text-aux text-text" title={name}>
          {name}
        </span>
        {committedAt !== null ? (
          <RelativeTime iso={committedAt} prefix="提交于" className="text-aux text-muted" />
        ) : (
          <span className="text-aux text-muted">暂无提交</span>
        )}
        {href !== null ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`在 GitHub 打开分支 ${name}`}
            // 触控目标：视觉 24px + ::after 外扩 10px = 44px。分支数据格行距 4px，
            // 相邻行的链接在纵向会有重叠区，但同一行的可点目标只有这一处、行内其余是文本。
            className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted transition-[background-color,color] duration-150 after:absolute after:inset-0 after:-m-2.5 hover:bg-surface-2 hover:text-accent"
          >
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
      </span>
    </DataCell>
  );
}

export function CheckedLine({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  if (!lastCheckedAt) {
    return <NotCheckedYet />;
  }
  return <RelativeTime iso={lastCheckedAt} prefix="检查于" className="text-aux text-muted" />;
}
