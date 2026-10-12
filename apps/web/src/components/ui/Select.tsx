import { Select } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from './cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  id?: string | undefined;
  ariaLabel: string;
  placeholder?: string | undefined;
  disabled?: boolean;
  className?: string | undefined;
}

/** 统一的 Select 外观封装：基于 Radix 基础能力。 */
export function SelectField({
  value,
  onValueChange,
  options,
  id,
  ariaLabel,
  placeholder,
  disabled,
  className,
}: SelectFieldProps) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled ?? false}>
      <Select.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'relative inline-flex h-9 items-center justify-between gap-2 rounded-control border border-border-strong',
          'bg-surface px-3 text-aux2 text-text shadow-card',
          'transition-[border-color,background-color] duration-150 hover:border-muted/60 hover:bg-surface-2',
          'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted',
          // 视觉高度保持紧凑；::after 向四周扩展 6px，使 h-9 触发器的有效触控区 ≥44px。
          'after:absolute after:inset-0 after:-m-1.5',
          className,
        )}
      >
        <Select.Value placeholder={placeholder ?? ariaLabel} />
        <Select.Icon className="text-muted">
          <ChevronDown size={15} aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        {/*
          弹层挂在 body 上，必须高于对话框（overlay z-80 / content z-90），
          否则在编辑抽屉里打开的下拉会被抽屉面板盖住、选项点不到。
        */}
        <Select.Content
          position="popper"
          sideOffset={6}
          className="gr-popover gr-anim-content z-[100] overflow-hidden"
        >
          <Select.Viewport className="p-1.5">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className={cn(
                  'relative flex h-9 cursor-default select-none items-center gap-2 rounded-[7px] pl-8 pr-3 text-aux2 text-text outline-none',
                  'transition-colors duration-100 data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50',
                )}
              >
                <Select.ItemIndicator className="absolute left-2.5 flex items-center text-accent">
                  <Check size={14} aria-hidden="true" />
                </Select.ItemIndicator>
                <Select.ItemText>{option.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
