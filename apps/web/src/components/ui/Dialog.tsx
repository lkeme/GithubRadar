import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

/** 对话框与右侧抽屉（编辑监控使用右侧抽屉，手机可全屏）。 */

const MODAL_SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const;

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  size?: keyof typeof MODAL_SIZES;
  children: ReactNode;
  footer?: ReactNode;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  children,
  footer,
  onCloseAutoFocus,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="gr-anim-overlay fixed inset-0 z-[80] bg-scrim backdrop-blur-[3px]" />
        <Dialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'gr-anim-content fixed left-1/2 top-1/2 z-[90] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'gr-card max-h-[85vh] overflow-y-auto p-6 shadow-pop',
            MODAL_SIZES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] font-semibold tracking-tight text-text">{title}</Dialog.Title>
              {description !== undefined ? (
                <Dialog.Description className="mt-1.5 text-aux2 leading-relaxed text-muted">{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="关闭"
              className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 after:absolute after:inset-0 after:-m-1 hover:bg-surface-2 hover:text-text"
            >
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="mt-5">{children}</div>
          {footer !== undefined ? (
            <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-border pt-4">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function Drawer({ open, onOpenChange, title, description, children, footer, onCloseAutoFocus }: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="gr-anim-overlay fixed inset-0 z-[80] bg-scrim backdrop-blur-[3px]" />
        <Dialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'gr-anim-drawer fixed inset-y-0 right-0 z-[90] flex w-full flex-col border-l border-border bg-surface',
            'shadow-pop sm:w-[32rem] sm:border-l-0 sm:rounded-l-2xl',
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] font-semibold tracking-tight text-text">{title}</Dialog.Title>
              {description !== undefined ? (
                <Dialog.Description className="mt-1.5 text-aux2 leading-relaxed text-muted">{description}</Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="关闭"
              className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition-[background-color,color] duration-150 after:absolute after:inset-0 after:-m-1 hover:bg-surface-2 hover:text-text"
            >
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer !== undefined ? <footer className="border-t border-border bg-inset px-6 py-4">{footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
