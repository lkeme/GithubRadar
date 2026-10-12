import type { ImportItemStatus } from '@githubradar/contracts';
import { Copy, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ImportItemData } from '../../lib/api';
import { MAX_IMPORT_INPUT_CHARS, MAX_IMPORT_ROWS } from '../../lib/constants';
import { errorCodeMessage } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Dialog';
import { Field, Textarea } from '../ui/Form';
import { useToast } from '../ui/Toast';
import { cn } from '../ui/cn';
import { useCreateImport } from '../../features/repos/mutations';
import { useImportProgress } from '../../features/repos/queries';

export interface BulkImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入批次完成（含部分失败）后通知页面刷新公开列表。 */
  onFinished: () => void;
  /** 从项目发现“加入监控”带入的初始输入。 */
  initialInput?: string | undefined;
}

const STATUS_TEXT: Record<ImportItemStatus, string> = {
  pending: '待处理',
  queued: '排队中',
  succeeded: '成功',
  exists: '已存在',
  invalid: '格式错误',
  limit_reached: '数量超限',
  denied_or_missing: '无权访问或不存在',
  failed: '暂时失败',
  expired: '验证超时（名额已释放）',
};

const FAILED_STATUSES: readonly ImportItemStatus[] = ['invalid', 'failed', 'limit_reached', 'denied_or_missing', 'expired'];

function statusChipTone(status: ImportItemStatus): string {
  if (status === 'succeeded') {
    return 'bg-success-subtle text-success';
  }
  if (status === 'exists' || status === 'pending' || status === 'queued') {
    return 'bg-surface-2 text-muted';
  }
  return 'bg-danger-subtle text-danger';
}

/**
 * 批量添加仓库：
 * 提交后在看板面板内展示逐项结果（成功/已存在/格式错误/数量超限/无权访问或不存在/暂时失败），可复制失败输入。
 */
export function BulkImportDialog({ open, onOpenChange, onFinished, initialInput }: BulkImportDialogProps) {
  const { push } = useToast();
  const [input, setInput] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [closingConfirm, setClosingConfirm] = useState(false);
  const createImport = useCreateImport();
  // 关闭对话框即停止该批次的进度轮询；导入任务本身在服务端继续，可在任务页查看。
  const progress = useImportProgress(open ? groupId : null);
  const progressData = progress.data;
  // 进度读取本身失败时不能一直按"进行中"处理：那会让关闭永远停在二次确认、
  // "重新输入"永远禁用，用户只能走二次确认里的红色关闭。
  const progressUnavailable = progress.isError;
  const running = progressData?.state === 'running' || (groupId !== null && progressData === undefined && !progressUnavailable);
  const finished = progressData?.state === 'finished';
  const items = useMemo<ImportItemData[]>(() => progressData?.items ?? [], [progressData]);

  useEffect(() => {
    if (open) {
      setInput(initialInput ?? '');
      setGroupId(null);
      setClosingConfirm(false);
    }
  }, [open, initialInput]);

  // 同一个批次只播报一次并只失效一次查询：onFinished 由父组件内联传入，引用每次渲染都会变，
  // 直接放进依赖会让"导入完成"在父组件重渲染时被反复重放。
  const notifiedGroupRef = useRef<string | null>(null);
  useEffect(() => {
    if (!finished || groupId === null || notifiedGroupRef.current === groupId) {
      return;
    }
    notifiedGroupRef.current = groupId;
    onFinished();
    const succeeded = items.filter((item) => item.status === 'succeeded').length;
    const failed = items.filter((item) => FAILED_STATUSES.includes(item.status)).length;
    if (succeeded > 0 || failed > 0) {
      push(
        failed > 0 ? 'info' : 'success',
        failed > 0 ? `导入完成：成功 ${succeeded} 项，失败 ${failed} 项` : `导入完成：成功 ${succeeded} 项`,
      );
    }
  }, [finished, groupId, items, onFinished, push]);

  const failedInputs = useMemo(
    () => items.filter((item) => FAILED_STATUSES.includes(item.status)).map((item) => item.input),
    [items],
  );

  // 输入阶段就给出上限结论：粘贴一大段时立刻知道超没超，而不是提交后才被拒。
  const typed = input.trim();
  const inputLines = typed.length === 0 ? 0 : typed.split('\n').length;
  const tooManyLines = inputLines > MAX_IMPORT_ROWS;
  const tooLongChars = typed.length > MAX_IMPORT_INPUT_CHARS;
  const inputError = tooLongChars
    ? `输入过长，一次最多 ${MAX_IMPORT_ROWS} 行，请分批提交`
    : tooManyLines
      ? `一次最多 ${MAX_IMPORT_ROWS} 行（当前 ${inputLines} 行），请分批提交`
      : undefined;

  const submit = (): void => {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return;
    }
    // 与服务端契约同一上限（MAX_IMPORT_INPUT_CHARS）：超限时服务端只会给出笼统的
    // 校验失败，这里先给出可执行的提示，避免"粘贴了一大段却不知道为什么被拒"。
    if (inputError !== undefined) {
      push('error', inputError);
      return;
    }
    createImport.mutate(trimmed, {
      onSuccess: (newGroupId) => {
        setGroupId(newGroupId);
        push('info', '已开始导入，正在逐项验证');
      },
      onError: () => {
        // 全局错误提示已由 mutation 处理。
      },
    });
  };

  const copyFailed = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(failedInputs.join('\n'));
      push('success', `已复制 ${failedInputs.length} 条失败输入`);
    } catch {
      push('error', '复制失败，请手动选择并复制文本');
    }
  };

  const requestClose = (): void => {
    if (running && !closingConfirm) {
      setClosingConfirm(true);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else {
          requestClose();
        }
      }}
      title="批量添加仓库"
      description="支持 owner/repo、https://github.com/owner/repo；单次最多 999 行。重复输入不会重复占用名额。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={requestClose}>
            {finished || groupId === null ? '关闭' : '后台继续'}
          </Button>
          {groupId === null ? (
            <Button variant="primary" onClick={submit} disabled={createImport.isPending || input.trim().length === 0 || inputError !== undefined} aria-busy={createImport.isPending}>
              {createImport.isPending ? '提交中…' : '开始导入'}
            </Button>
          ) : (
            <Button
              variant="secondary"
              leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
              onClick={() => {
                setGroupId(null);
                setClosingConfirm(false);
              }}
              disabled={running}
            >
              重新输入
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {groupId === null ? (
          <Field
            label="仓库列表"
            htmlFor="import-input"
            error={inputError}
            hint={
              inputLines === 0
                ? '只接受仓库根路径（owner/repo），不接受子路径。'
                : `只接受仓库根路径（owner/repo），不接受子路径。已输入 ${inputLines} 行。`
            }
          >
            <Textarea
              id="import-input"
              value={input}
              rows={10}
              invalid={inputError !== undefined}
              placeholder={'每行一个，例如：\nowner/repo\nhttps://github.com/owner/another-repo'}
              onChange={(event) => {
                setInput(event.target.value);
              }}
              disabled={createImport.isPending}
            />
          </Field>
        ) : (
          <section aria-label="导入结果" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-aux2 text-text" role="status" aria-live="polite">
                {progress.isError
                  ? '导入进度读取失败'
                  : finished
                    ? `导入完成，共 ${items.length} 项`
                    : `正在逐项验证… 已完成 ${items.filter((item) => item.status !== 'pending' && item.status !== 'queued').length} / ${items.length || '…'}`}
              </p>
              <span className="flex items-center gap-2">
                {progress.isError ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void progress.refetch();
                    }}
                    disabled={progress.isFetching}
                  >
                    重试读取进度
                  </Button>
                ) : null}
                {failedInputs.length > 0 ? (
                  <Button size="sm" variant="secondary" leadingIcon={<Copy size={15} aria-hidden="true" />} onClick={() => void copyFailed()}>
                    复制失败输入（{failedInputs.length}）
                  </Button>
                ) : null}
              </span>
            </div>
            <ul className="max-h-80 overflow-y-auto rounded-control border border-border bg-surface">
              {items.map((item) => (
                <li
                  key={`${item.index}-${item.input}`}
                  className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5 text-aux2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 break-all font-mono text-aux text-text" title={item.input}>
                    {item.input}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-right">
                    <span className={cn('gr-chip', statusChipTone(item.status))}>{STATUS_TEXT[item.status]}</span>
                    {/* 逐项原因必须都给出：已知码与内部码都有文案，未知码也保留原始码，不能整条不渲染。 */}
                    {item.errorCode !== null ? (
                      <span className="max-w-48 text-aux text-muted" title={item.errorCode}>
                        {errorCodeMessage(item.errorCode)}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {closingConfirm ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-warning/40 bg-warning-subtle p-3 text-aux2 text-text">
            <span>导入仍在进行，关闭后不再显示进度；结果可在任务与诊断页查看。</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setClosingConfirm(false); }}>
                继续查看
              </Button>
              <Button size="sm" variant="danger" onClick={() => { onOpenChange(false); }}>
                关闭
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
