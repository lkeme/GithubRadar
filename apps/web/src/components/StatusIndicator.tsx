import { CircleCheck, CirclePause, CircleX, Clock, ClockAlert, TriangleAlert } from 'lucide-react';

import type { RepositoryStatus } from '../lib/api';
import { serverNow, useNowTick } from '../lib/clock';
import { parseIso } from '../lib/relative-time';
import { cn } from './ui/cn';

/**
 * 状态指示：
 * - 图标 + 文字 + 颜色三重表达，不只用红绿区分；线性小尺寸维持“小面积变化提示”。
 * - 更新标记与陈旧标记可并存；失败说明不遮盖最后已知内容。
 */

export type RepositoryStatusValue = RepositoryStatus;

type StatusTone = 'success' | 'warning' | 'danger' | 'muted';

const STATUS_MAP: Record<RepositoryStatusValue, { label: string; tone: StatusTone; Icon: typeof Clock }> = {
  pending: { label: '初始化中', tone: 'muted', Icon: Clock },
  healthy: { label: '正常', tone: 'success', Icon: CircleCheck },
  partial: { label: '部分完成', tone: 'warning', Icon: TriangleAlert },
  stale: { label: '数据可能陈旧', tone: 'warning', Icon: ClockAlert },
  error: { label: '检测失败', tone: 'danger', Icon: CircleX },
  paused: { label: '已暂停', tone: 'muted', Icon: CirclePause },
};

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-muted',
};

export function StatusIndicator({ status, className }: { status: RepositoryStatusValue; className?: string }) {
  const entry = STATUS_MAP[status] ?? STATUS_MAP.pending;
  const { Icon } = entry;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-aux font-medium', TONE_CLASS[entry.tone], className)}>
      <Icon size={13} aria-hidden="true" className="shrink-0" />
      {entry.label}
    </span>
  );
}

/** 7 天更新标记：按校正后的服务器时间到期移除，过期视为无标记。 */
export function UpdateIndicator({
  hasRecentChange,
  changeExpiresAt,
  className,
}: {
  hasRecentChange: boolean;
  changeExpiresAt: string | null | undefined;
  className?: string;
}) {
  useNowTick();
  const expiresMs = parseIso(changeExpiresAt);
  const active = hasRecentChange && Number.isFinite(expiresMs) && expiresMs > serverNow();
  if (!active) {
    return null;
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-aux font-medium text-warning', className)}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning ring-[3px] ring-warning/20" />
      近 7 天有更新
    </span>
  );
}

/** 区分“尚未完成检测”与“检查于…”：null 时返回占位文案，由调用方决定排版。 */
export function NotCheckedYet({ className }: { className?: string }) {
  return <span className={cn('text-aux text-muted', className)}>尚未完成检测</span>;
}
