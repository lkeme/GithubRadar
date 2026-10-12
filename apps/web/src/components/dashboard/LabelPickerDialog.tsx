import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { LabelDefinition } from '../../lib/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Dialog';
import { cn } from '../ui/cn';

export interface LabelPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | undefined;
  labels: LabelDefinition[];
  /** 当前已选标签的字符串 ID（与 LabelDefinition.id 同一空间）。 */
  initialSelectedIds: string[];
  confirmLabel: string;
  busy: boolean;
  onConfirm: (labelIds: string[]) => void;
}

/** 分类标签多选（设置标签；批量区分添加/移除）。 */
export function LabelPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  labels,
  initialSelectedIds,
  confirmLabel,
  busy,
  onConfirm,
}: LabelPickerDialogProps) {
  const [selected, setSelected] = useState<string[]>(initialSelectedIds);
  const initialKey = initialSelectedIds.join(',');

  useEffect(() => {
    if (open) {
      setSelected(initialKey.length > 0 ? initialKey.split(',') : []);
    }
  }, [open, initialKey]);

  const toggle = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              onConfirm(selected);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {labels.length === 0 ? (
        <p className="text-aux2 text-muted">暂无分类标签。</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto">
          {labels.map((label) => {
            const checked = selected.includes(label.id);
            return (
              <li key={label.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => {
                    toggle(label.id);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-aux2 text-text transition-colors duration-150 hover:bg-surface-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4.5 shrink-0 items-center justify-center rounded-[4px] border',
                      checked ? 'border-accent bg-accent text-accent-contrast' : 'border-border-strong bg-surface',
                    )}
                  >
                    {checked ? <Check size={12} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label.name}</span>
                  <span className="shrink-0 text-aux text-muted">{label.usedByRepositories} 个仓库在用</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
