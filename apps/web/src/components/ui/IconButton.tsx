import { Tooltip } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';

import { cn } from './cn';

/**
 * 工具提示：所有仅图标按钮必须有可访问名称，并提供 hover/focus Tooltip。
 * 触控区至少 44×44px；图标 17–20px。
 */

export function TooltipRoot({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delayDuration={300}>{children}</Tooltip.Provider>;
}

export function TooltipHint({ label, children }: { label: string; children: ReactNode }) {
  // 指针来源的回焦（菜单关闭后 trigger.focus()）不应触发 Tooltip；键盘焦点与悬停保持触发。
  const [suppress, setSuppress] = useState(false);
  return (
    <Tooltip.Root open={suppress ? false : undefined}>
      <Tooltip.Trigger
        asChild
        onFocus={() => {
          setSuppress(document.documentElement.dataset['focusSource'] === 'pointer');
        }}
        onBlur={() => {
          setSuppress(false);
        }}
        onMouseEnter={() => {
          setSuppress(false);
        }}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="gr-popover gr-anim-content z-[130] max-w-64 rounded-control px-2.5 py-1.5 text-aux text-text"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  icon: LucideIcon;
  /** 无障碍名称兼默认 Tooltip 文案。 */
  label: string;
  tooltip?: string;
  tone?: 'default' | 'danger' | 'accent';
  spinning?: boolean;
}

export function IconButton({
  icon: Icon,
  label,
  tooltip,
  tone = 'default',
  spinning = false,
  className,
  type,
  ...rest
}: IconButtonProps) {
  const toneClass =
    tone === 'danger'
      ? 'text-danger hover:bg-danger-subtle'
      : tone === 'accent'
        ? 'text-accent hover:bg-accent-subtle'
        : 'text-muted hover:bg-surface-2 hover:text-text';
  return (
    <TooltipHint label={tooltip ?? label}>
      <button
        type={type ?? 'button'}
        aria-label={label}
        className={cn(
          // 视觉 36px + ::after 外扩 4px = 44px 触控目标。
          'relative inline-flex size-9 shrink-0 items-center justify-center rounded-control',
          'after:absolute after:inset-0 after:-m-1 after:rounded-control',
          'transition-[background-color,color,opacity,transform] duration-150 ease-gr active:translate-y-px',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
          toneClass,
          className,
        )}
        {...rest}
      >
        <Icon aria-hidden="true" size={18} className={cn(spinning && 'motion-safe:animate-spin')} />
      </button>
    </TooltipHint>
  );
}
