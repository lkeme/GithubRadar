import { DropdownMenu } from 'radix-ui';
import { Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

/** 菜单：图标＋文字，不依赖悬停即可操作。 */

export interface MenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string | undefined;
}

export function Menu({ trigger, children, align = 'start', ariaLabel }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* 与下拉选择同一层：弹层必须高于对话框（overlay z-80 / content z-90），否则在抽屉内被盖住。 */}
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          aria-label={ariaLabel}
          className="gr-popover gr-anim-content z-[100] min-w-52 p-1.5"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface MenuItemProps {
  icon?: LucideIcon | undefined;
  onSelect: () => void;
  children: ReactNode;
  tone?: 'default' | 'danger' | undefined;
  disabled?: boolean;
  checked?: boolean | undefined;
}

export function MenuItem({ icon: Icon, onSelect, children, tone = 'default', disabled = false, checked }: MenuItemProps) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={() => {
        onSelect();
      }}
      className={cn(
        'flex h-9 cursor-default select-none items-center gap-2.5 rounded-[7px] px-2.5 text-aux2 outline-none',
        'transition-[background-color,color] duration-100 data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50',
        tone === 'danger'
          ? 'text-danger data-[highlighted]:bg-danger-subtle data-[highlighted]:text-danger'
          : 'text-text data-[highlighted]:text-text',
      )}
    >
      {Icon !== undefined ? (
        <Icon
          size={16}
          aria-hidden="true"
          className={cn('shrink-0', tone === 'default' && 'text-muted')}
        />
      ) : null}
      <span className="flex-1">{children}</span>
      {checked === true ? <Check size={14} aria-hidden="true" className="shrink-0 text-accent" /> : null}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="gr-label px-2.5 pb-1 pt-2">{children}</DropdownMenu.Label>;
}
