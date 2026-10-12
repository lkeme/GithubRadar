import { Checkbox, RadioGroup, Switch } from 'radix-ui';
import { Check, Eye, EyeOff } from 'lucide-react';
import { cloneElement, isValidElement, useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react';

import { cn } from './cn';

/** 表单基础件：可见标签与邻近错误。 */

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
  requiredMark?: boolean;
}

/**
 * 把错误文案挂到控件上，让屏幕阅读器在复查该字段时也能读到原因。
 * `role="alert"` 只在错误出现的那一刻播报一次，`aria-invalid` 只说"无效"不说为什么。
 * 控件自带的 aria-describedby（如提示文案）保留，不覆盖。
 */
function withDescribedBy(node: ReactNode, id: string): ReactNode {
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ 'aria-describedby'?: string }>;
  // 调用方可能已经自己挂上了同一个 id（例如登录表单）：按空格拆分去重，同一段说明不重复播报。
  const ids = (element.props['aria-describedby'] ?? '').split(/\s+/).filter((value) => value.length > 0);
  if (!ids.includes(id)) {
    ids.push(id);
  }
  return cloneElement(element, { 'aria-describedby': ids.join(' ') });
}

/**
 * 字段容器：标签行（含错误）+ 控件 + 可选提示。
 *
 * 错误信息显示在**标签行的右侧**——这一行本来就有，占位为 0，
 * 因此错误出现既不改变自身高度，也不会顶开相邻字段；
 * 标签行放不下时按尾省略并保留 `title` 与可访问名称（截断只影响视觉，朗读仍是完整文案）。
 * 提示（hint）是静态内容，按需在下方占位，不会随交互出现或消失。
 */
export function Field({ label, htmlFor, error, hint, children, requiredMark = false }: FieldProps) {
  const errorId = `${htmlFor}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <label htmlFor={htmlFor} className="shrink-0 text-aux2 font-medium text-text">
          {label}
          {requiredMark ? (
            <span className="text-danger" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </label>
        {error !== undefined ? (
          <span id={errorId} role="alert" title={error} className="min-w-0 flex-1 truncate text-aux text-danger">
            {error}
          </span>
        ) : null}
      </div>
      {error === undefined ? children : withDescribedBy(children, errorId)}
      {hint !== undefined ? <div className="text-aux leading-relaxed text-muted">{hint}</div> : null}
    </div>
  );
}

export interface InputProps extends ComponentPropsWithRef<'input'> {
  invalid?: boolean;
}

export function Input({ invalid = false, className, ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn('gr-input h-10 font-mono', className)}
      {...rest}
    />
  );
}

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid = false, className, ...rest }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn('gr-input min-h-24 font-mono leading-relaxed', className)}
      {...rest}
    />
  );
}

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** 显示/隐藏按钮的可访问名称前缀，如 “代理密码”。 */
  revealLabel: string;
}

/** 密码输入：显示/隐藏切换按钮嵌在输入框内右缘（敏感字段）。 */
export function PasswordInput({ revealLabel, className, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        className={cn('pr-12', className)}
        {...rest}
      />
      <button
        type="button"
        aria-label={visible ? `隐藏${revealLabel}` : `显示${revealLabel}`}
        onClick={() => {
          setVisible((value) => !value);
        }}
        className={cn(
          'absolute right-1.5 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-control',
          // 触控目标：视觉 32px + ::after 外扩 6px = 44px。
          'after:absolute after:inset-0 after:-m-1.5 after:rounded-control',
          'text-muted transition-[background-color,color] duration-150 hover:bg-surface-2 hover:text-text',
        )}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}

export interface CheckboxFieldProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function CheckboxField({ id, checked, onCheckedChange, label, disabled, className }: CheckboxFieldProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <Checkbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(value) => {
          onCheckedChange(value === true);
        }}
        disabled={disabled ?? false}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-surface',
          'transition-[background-color,border-color] duration-150',
          'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-contrast',
        )}
      >
        <Checkbox.Indicator>
          <Check size={13} aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <label htmlFor={id} className="text-aux2 text-text">
        {label}
      </label>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupFieldProps {
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RadioOption[];
  disabled?: boolean;
}

/** 分段式单选组：选项等宽排布，适合档位这类固定枚举（比下拉框更易一眼比较）。 */
export function RadioGroupField({ ariaLabel, value, onValueChange, options, disabled }: RadioGroupFieldProps) {
  return (
    <RadioGroup.Root
      aria-label={ariaLabel}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled ?? false}
      className="flex flex-wrap gap-2"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'group relative inline-flex h-10 select-none items-center gap-2 rounded-control border border-border-strong bg-surface px-3.5 text-aux2 text-text',
            // 触控目标：视觉 40px + ::after 外扩 2px = 44px。
            'after:absolute after:inset-0 after:-m-0.5 after:rounded-control',
            'transition-[background-color,border-color,color] duration-150 ease-gr',
            'hover:border-muted/60 hover:bg-surface-2',
            'data-[state=checked]:border-accent data-[state=checked]:bg-accent-subtle data-[state=checked]:font-medium data-[state=checked]:text-accent-strong',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 rounded-full border border-border-strong bg-surface',
              'transition-[background-color,border-color] duration-150',
              'group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent',
            )}
          />
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export interface SwitchControlProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 无可见文字标签时提供可访问名称（如“启用代理”）。 */
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/** 裸开关：视觉 44×24，::after 向上下扩展至 44×44 触控目标。 */
export function SwitchControl({ checked, onCheckedChange, label, id, disabled, className }: SwitchControlProps) {
  return (
    <Switch.Root
      {...(id === undefined ? {} : { id })}
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled ?? false}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border border-border-strong bg-surface-2',
        'after:absolute after:inset-0 after:-m-2.5 after:rounded-full',
        'transition-[background-color,border-color] duration-150 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <Switch.Thumb
        className={cn(
          'block size-4.5 translate-x-0.5 rounded-full bg-text shadow-card transition-transform duration-150 ease-gr',
          'data-[state=checked]:translate-x-[1.4rem] data-[state=checked]:bg-accent-contrast',
        )}
      />
    </Switch.Root>
  );
}

export interface SwitchFieldProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function SwitchField({ id, checked, onCheckedChange, label, hint, disabled }: SwitchFieldProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-aux2 font-medium text-text">
          {label}
        </label>
        {hint !== undefined ? <div className="text-aux leading-relaxed text-muted">{hint}</div> : null}
      </div>
      <SwitchControl id={id} label={label} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
