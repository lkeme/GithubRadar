import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from './cn';

export interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  busy?: boolean;
}

export function Pagination({ page, total, pageSize, onPageChange, busy = false }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < pageCount;
  const buttonClass = cn(
    // 视觉 36px + ::after 外扩 4px = 44px 触控目标。
    'relative inline-flex size-9 items-center justify-center rounded-control border border-border-strong bg-surface shadow-card',
    'after:absolute after:inset-0 after:-m-1 after:rounded-control',
    'text-text transition-[background-color,border-color,transform] duration-150 hover:border-muted/60 hover:bg-surface-2 active:translate-y-px',
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0',
  );
  return (
    <nav aria-label="分页" className="flex items-center justify-center gap-4 py-5">
      <button
        type="button"
        className={buttonClass}
        aria-label="上一页"
        disabled={!canPrev || busy}
        onClick={() => {
          onPageChange(page - 1);
        }}
      >
        <ChevronLeft size={17} aria-hidden="true" />
      </button>
      <p className="text-aux2 text-muted" aria-live="polite">
        <span className="font-mono tabular-nums text-text">
          {page} / {pageCount}
        </span>{' '}
        页 · 共 <span className="font-mono tabular-nums">{total}</span> 条
      </p>
      <button
        type="button"
        className={buttonClass}
        aria-label="下一页"
        disabled={!canNext || busy}
        onClick={() => {
          onPageChange(page + 1);
        }}
      >
        <ChevronRight size={17} aria-hidden="true" />
      </button>
    </nav>
  );
}
