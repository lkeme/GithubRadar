import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-accent text-accent-contrast shadow-card hover:bg-accent-strong',
  secondary: 'border border-border-strong bg-surface text-text shadow-card hover:border-muted/60 hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger text-danger-contrast shadow-card hover:opacity-90',
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-aux2',
  md: 'h-11 px-4 text-aux2',
};

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
  leadingIcon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  asChild = false,
  leadingIcon,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  const classes = cn(
    'relative inline-flex select-none items-center justify-center gap-2 rounded-control font-medium',
    'transition-[background-color,border-color,opacity,transform] duration-150 ease-gr active:translate-y-px',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0',
    // sm 档视觉 36px；::after 向四周扩 4px 补足 44px 触控目标，不侵占相邻控件。
    'after:absolute after:inset-0 after:-m-1 after:rounded-control after:content-[""]',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  );
  if (asChild) {
    return (
      <Slot.Root className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button className={classes} type={type ?? 'button'} {...rest}>
      {leadingIcon}
      {children}
    </button>
  );
}
