import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from './cn';

/**
 * 轻量提示：
 * - 成功反馈短暂展示并通过 aria-live 播报，不永久堆叠。
 * - 失败提示给可执行说明，不暴露内部错误原文；部分成功必须逐项说明（由调用方组织文案）。
 */

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}

interface ToastContextValue {
  push: (tone: Tone, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

const TONE_TIMEOUT: Record<Tone, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

const TONE_ICON: Record<Tone, ReactNode> = {
  success: <CircleCheck size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-success" />,
  error: <CircleAlert size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />,
  info: <Info size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />,
};

const TONE_BAR: Record<Tone, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  info: 'bg-accent',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = nextId;
      nextId += 1;
      setItems((prev) => [...prev.slice(-2), { id, tone, message }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }, TONE_TIMEOUT[tone]);
    },
    [],
  );

  const value = useMemo<ToastContextValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        // 底部悬浮命令条（批量选择）出现时把提示层整体上移：两者都贴右下角，
        // 叠加时提示会盖住命令条按钮且不可点。偏移量由命令条实测写入 CSS 变量。
        style={{ bottom: 'calc(1.25rem + var(--gr-toast-offset, 0px))' }}
        className="pointer-events-none fixed right-5 z-[110] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="gr-card gr-anim-toast pointer-events-auto relative flex items-start gap-2.5 overflow-hidden p-3 pl-4 shadow-pop"
          >
            <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-[3px]', TONE_BAR[item.tone])} />
            {TONE_ICON[item.tone]}
            <p className="flex-1 text-aux2 leading-snug text-text">{item.message}</p>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => {
                dismiss(item.id);
              }}
              className="relative -m-2 inline-flex size-9 shrink-0 items-center justify-center rounded-[6px] text-muted transition-[background-color,color] duration-150 after:absolute after:inset-0 after:-m-1 hover:bg-surface-2 hover:text-text"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return context;
}
