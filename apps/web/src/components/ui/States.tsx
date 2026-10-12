import { CircleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from './Button';
import { cn } from './cn';

/**
 * 空态与失败态分开设计：
 * “暂无Release”“暂无提交”“尚未完成检测”“无匹配结果”等不同语义由调用方传入不同文案，
 * 不混成同一句话。
 */

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon: Icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'gap-2 rounded-control border border-dashed border-border py-8' : 'gap-3 rounded-card border border-dashed border-border py-16',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'gr-icon-tile',
          compact ? 'size-9' : 'size-11',
        )}
      >
        <Icon size={compact ? 17 : 20} aria-hidden="true" />
      </span>
      <p className={cn(compact ? 'text-aux2' : 'text-aux2 font-semibold tracking-tight', 'text-text')}>{title}</p>
      {description !== undefined ? (
        <div className="max-w-md px-6 text-aux2 leading-relaxed text-muted">{description}</div>
      ) : null}
      {action !== undefined ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: ReactNode;
  onRetry?: (() => void) | undefined;
  retryBusy?: boolean;
  compact?: boolean;
}

export function ErrorState({
  title = '加载失败',
  description,
  onRetry,
  retryBusy = false,
  compact = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={
        compact
          ? 'flex flex-col items-start gap-1.5 py-3 text-left'
          : 'flex flex-col items-center gap-3 rounded-card py-14 text-center'
      }
    >
      {compact ? null : (
        <span
          aria-hidden="true"
          className="flex size-11 items-center justify-center rounded-control border border-danger/30 bg-danger-subtle text-danger"
        >
          <CircleAlert size={20} aria-hidden="true" />
        </span>
      )}
      <p className={compact ? 'text-aux2 font-medium text-danger' : 'text-aux2 font-semibold tracking-tight text-danger'}>{title}</p>
      {description !== undefined ? (
        <div className="max-w-md px-6 text-aux2 leading-relaxed text-muted">{description}</div>
      ) : null}
      {onRetry !== undefined ? (
        <Button size="sm" onClick={onRetry} disabled={retryBusy} aria-busy={retryBusy} className="mt-1">
          重试
        </Button>
      ) : null}
    </div>
  );
}
