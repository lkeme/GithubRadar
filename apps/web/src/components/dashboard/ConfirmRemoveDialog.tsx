import { Button } from '../ui/Button';
import { Modal } from '../ui/Dialog';

export interface RemoveTarget {
  id: string;
  fullName: string;
  displayName: string | null;
}

export interface ConfirmRemoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: RemoveTarget[];
  busy: boolean;
  onConfirm: () => void;
}

/**
 * 移除监控确认：
 * 提交前展示准确数量与可滚动的完整仓库名单；明确只移除本地监控记录与本地趋势。
 */
export function ConfirmRemoveDialog({ open, onOpenChange, targets, busy, onConfirm }: ConfirmRemoveDialogProps) {
  const count = targets.length;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        // 移除在途时不允许关闭图层（Escape、遮罩与右上角关闭都走这里）：
        // 结果落地后页面还要按成功数调整分页并展示逐项结果，中途关闭会让反馈无处呈现。
        if (!next && busy) {
          return;
        }
        onOpenChange(next);
      }}
      title={`移除 ${count} 个仓库的监控`}
      description="仅移除本系统的监控记录与本地趋势数据，不会对 GitHub 上的仓库做任何操作；此操作没有恢复功能。"
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={busy}
          >
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy || count === 0} aria-busy={busy}>
            移除这 {count} 个仓库
          </Button>
        </>
      }
    >
      {count === 0 ? (
        <p className="text-aux2 text-muted">没有可移除的仓库。</p>
      ) : (
        <ul className="max-h-80 overflow-y-auto rounded-control border border-border bg-surface" aria-label="待移除仓库名单">
          {targets.map((target) => (
            <li
              key={target.id}
              className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 text-aux2 last:border-b-0"
            >
              <span className="min-w-0 truncate font-medium text-text" title={target.fullName}>
                {target.fullName}
              </span>
              {target.displayName !== null && target.displayName.length > 0 ? (
                <span className="min-w-0 shrink-0 truncate text-aux text-muted" title={target.displayName}>
                  {target.displayName}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
