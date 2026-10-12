import { useEffect, useRef, useState } from 'react';

import { toLabelIdNumbers } from '../../features/repos/labels';
import { usePatchRepository } from '../../features/repos/mutations';
import { useAdminLabels, useRepositoryDetail } from '../../features/repos/queries';
import { ApiError, StaleAuthError, errorMessage } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

export interface RepoLabelsDialogProps {
  repo: { id: string; name: string };
  onClose: () => void;
}

/** 设置标签：直接对当前仓库 ID 调用受保护 API，不跳转其他列表。 */
export function RepoLabelsDialog({ repo, onClose }: RepoLabelsDialogProps) {
  const { push } = useToast();
  const detailQuery = useRepositoryDetail(repo.id);
  const labelsQuery = useAdminLabels();
  const patchMutation = usePatchRepository({ errorToToast: false });
  const [selected, setSelected] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 用户改过勾选后就不再被后台刷新重置：任何管理写操作都会让 detail 重新取数，
  // 无脏值保护时正在编辑的勾选会被静默清空。保存仍使用最新一次读取的 editRevision。
  const editedRef = useRef(false);

  const detail = detailQuery.data;

  useEffect(() => {
    if (detail !== undefined && !editedRef.current) {
      setSelected(detail.labels.map((label) => label.id));
    }
  }, [detail]);

  const save = async (): Promise<void> => {
    if (selected === null || detail === undefined) {
      return;
    }
    setError(null);
    try {
      await patchMutation.mutateAsync({
        id: repo.id,
        body: { editRevision: detail.editRevision, labelIds: toLabelIdNumbers(selected) },
      });
      push('success', `标签已保存：${repo.name}`);
      onClose();
    } catch (caught) {
      if (caught instanceof StaleAuthError) {
        return;
      }
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.code === 'REVISION_CONFLICT') {
        void detailQuery.refetch();
      }
    }
  };

  const saving = patchMutation.isPending;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={`设置标签：${repo.name}`}
      description="分类标签会公开展示；移除标签只会解除本仓库引用，不删除全局标签定义。"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={saving || detail === undefined || selected === null}
            aria-busy={saving}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {detailQuery.isPending ? (
        <p className="text-aux2 text-muted" role="status">
          正在加载当前标签…
        </p>
      ) : detailQuery.isError ? (
        <p role="alert" className="text-aux2 text-danger">
          {errorMessage(detailQuery.error)}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {error !== null ? (
            <p role="alert" className="rounded-control border border-danger/40 bg-danger-subtle p-2 text-aux2 text-danger">
              {error}
            </p>
          ) : null}
          {(labelsQuery.data ?? []).length === 0 ? (
            <p className="text-aux2 text-muted">暂无可用分类标签。</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {(labelsQuery.data ?? []).map((label) => {
                const checked = selected?.includes(label.id) ?? false;
                return (
                  <li key={label.id}>
                    <label className="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-aux2 text-text transition-colors duration-150 hover:bg-surface-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--gr-accent)]"
                        checked={checked}
                        onChange={() => {
                          editedRef.current = true;
                          setSelected((prev) => {
                            const current = prev ?? [];
                            return checked ? current.filter((id) => id !== label.id) : [...current, label.id];
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{label.name}</span>
                      <span className="shrink-0 text-aux text-muted">{label.usedByRepositories} 个仓库在用</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
