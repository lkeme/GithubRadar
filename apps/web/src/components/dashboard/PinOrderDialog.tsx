import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { usePutPins } from '../../features/repos/mutations';
import { fetchPublicRepositories } from '../../lib/api';
import { PAGE_SIZE_MAX } from '../../lib/constants';
import { StaleAuthError, errorMessage } from '../../lib/errors';
import { queryKeys } from '../../lib/query';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Dialog';
import { useToast } from '../ui/Toast';

export interface PinOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 置顶读取结果（GET /admin/pins：全部置顶 ID + pinsRevision）；未加载完成时保存按钮不可用。 */
  pins: { pinsRevision: number; ids: string[] } | null;
  /** 置顶读取失败（认证降级等）：给出可解释的错误文案而不是永远停在加载中。 */
  pinsError?: boolean;
  onSaved: () => void;
}

interface PinEntry {
  id: string;
  name: string;
}

/** 打开期间冻结的编辑快照：条目与版本号必须同源，防止“新版本 + 旧条目”绕过乐观锁。 */
interface PinSnapshot {
  readonly pinsRevision: number;
  readonly entries: PinEntry[];
}

/**
 * 公开列表只用于名称展示：分页取全 pinned=true 的仓库（pageSize=100，直到 page*pageSize >= total）。
 */
async function fetchPinnedNames(signal: AbortSignal): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let page = 1;
  for (;;) {
    const result = await fetchPublicRepositories({ pinned: true, pageSize: PAGE_SIZE_MAX, page }, signal);
    for (const repo of result.data) {
      names.set(repo.id, repo.fullName);
    }
    // 防御 total 异常导致的死循环：最多 100 页（10000 条），远超仓库上限。
    if (result.data.length === 0 || page * PAGE_SIZE_MAX >= result.meta.total || page >= 100) {
      break;
    }
    page += 1;
  }
  return names;
}

function buildEntries(ids: string[], names: Map<string, string>): PinEntry[] {
  // 顺序就是服务端的置顶顺序，不能按"名称能否解析"重排：公开列表拿不到名称的
  // 未验证仓库等条目若被挪到末尾，一次未改动的"保存顺序"就会改写真实置顶顺序。
  return ids.map((id) => ({ id, name: names.get(id) ?? `#${id}` }));
}

/**
 * 置顶顺序编辑：提供上移/下移键盘按钮重新排序，不把拖动作为唯一操作方式。
 * 顺序与完整性以 `GET /admin/pins` 的全部置顶 ID 为准（公开列表只有第 1 页时会丢第 101+ 项）；
 * 名称用公开列表分页取全，保存时仍提交完整 ID 列表。
 */
export function PinOrderDialog({ open, onOpenChange, pins, pinsError = false, onSaved }: PinOrderDialogProps) {
  const { push } = useToast();
  const namesQuery = useQuery({
    queryKey: queryKeys.publicRepositories('pin-order-names'),
    queryFn: ({ signal }) => fetchPinnedNames(signal),
    enabled: open,
    staleTime: 0,
  });
  // 失败文案由对话框内的错误槽承担：关掉全局提示，避免同一原因播报两次。
  const putPinsMutation = usePutPins({ errorToToast: false });
  const [snapshot, setSnapshot] = useState<PinSnapshot | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      loadedRef.current = false;
      setSnapshot(null);
      setSaveError(null);
      return;
    }
    // 打开后只按第一批数据构建一次：后台刷新不重置用户正在调整的顺序。
    // 版本号与条目在同一快照里冻结——保存必须用“读取这份条目时”的版本，
    // 否则后台 refetch 带来的新版本配上旧条目会绕过服务端乐观锁，
    // 把其他会话新增/移除的置顶静默覆盖掉。
    if (!loadedRef.current && pins !== null && (namesQuery.data !== undefined || namesQuery.isError)) {
      loadedRef.current = true;
      setSnapshot({
        pinsRevision: pins.pinsRevision,
        entries: buildEntries(pins.ids, namesQuery.data ?? new Map()),
      });
      setSaveError(null);
    }
  }, [open, pins, namesQuery.data, namesQuery.isError]);

  const entries = snapshot?.entries ?? null;

  const move = (index: number, delta: -1 | 1): void => {
    setSnapshot((prev) => {
      if (prev === null) {
        return prev;
      }
      const target = index + delta;
      if (target < 0 || target >= prev.entries.length) {
        return prev;
      }
      const next = [...prev.entries];
      const a = next[index];
      const b = next[target];
      if (a === undefined || b === undefined) {
        return prev;
      }
      next[index] = b;
      next[target] = a;
      return { pinsRevision: prev.pinsRevision, entries: next };
    });
  };

  const save = (): void => {
    if (snapshot === null) {
      return;
    }
    setSaveError(null);
    putPinsMutation.mutate(
      { pinsRevision: snapshot.pinsRevision, ids: snapshot.entries.map((entry) => entry.id) },
      {
        onSuccess: () => {
          push('success', '置顶顺序已保存');
          onSaved();
          onOpenChange(false);
        },
        onError: (error) => {
          // 迟到的结果已按认证代际作废：静默丢弃，不写错误槽。
          if (error instanceof StaleAuthError) {
            return;
          }
          setSaveError(errorMessage(error));
        },
      },
    );
  };

  const disabled = snapshot === null || putPinsMutation.isPending;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="调整置顶顺序"
      description="置顶只改变展示顺序，不改变采集频率或配额。"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => { onOpenChange(false); }} disabled={putPinsMutation.isPending}>
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={disabled} aria-busy={putPinsMutation.isPending}>
            保存顺序
          </Button>
        </>
      }
    >
      {pinsError && entries === null ? (
        <p className="text-aux2 text-danger" role="alert">
          置顶列表加载失败，请稍后重试。
        </p>
      ) : entries === null ? (
        <p className="text-aux2 text-muted" role="status">
          正在加载置顶列表…
        </p>
      ) : entries.length === 0 ? (
        <p className="text-aux2 text-muted">当前没有置顶仓库；可在仓库卡片的“更多”菜单中置顶。</p>
      ) : (
        <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded-control border border-border bg-surface px-2.5 py-2 text-aux2 shadow-card"
            >
              <span className="w-6 shrink-0 text-right font-mono tabular-nums text-muted" aria-hidden="true">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-text" title={entry.name}>
                {entry.name}
              </span>
              <button
                type="button"
                aria-label={`上移 ${entry.name}`}
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
                className="inline-flex size-11 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                <ArrowUp size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`下移 ${entry.name}`}
                disabled={index === entries.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
                className="inline-flex size-11 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                <ArrowDown size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {saveError !== null ? (
        <p role="alert" className="mt-2 text-aux2 text-danger">
          {saveError}
        </p>
      ) : null}
    </Modal>
  );
}
