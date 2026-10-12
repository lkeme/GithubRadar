import { cn } from './cn';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface LabelChipProps {
  name: string;
  color?: string | null | undefined;
  className?: string | undefined;
}

/** 分类标签：等宽紧凑；颜色只作辅助，不单独承载语义。 */
export function LabelChip({ name, color, className }: LabelChipProps) {
  const dotColor = typeof color === 'string' && HEX_COLOR.test(color) ? color : null;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-aux text-text',
        className,
      )}
    >
      {dotColor !== null ? (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
          style={{ backgroundColor: dotColor }}
        />
      ) : null}
      <span className="truncate">{name}</span>
    </span>
  );
}
