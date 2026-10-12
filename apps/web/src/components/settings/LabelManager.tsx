import { useState } from 'react';
import { Plus, Tags, Trash2 } from 'lucide-react';

import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Form';
import { IconButton, TooltipHint } from '../ui/IconButton';
import { ErrorState } from '../ui/States';
import { useToast } from '../ui/Toast';
import { ApiError, StaleAuthError, errorMessage } from '../../lib/errors';
import { LABEL_COLOR_INVALID, isValidLabelColor } from '../../lib/validation';
import { filterHexColorInput } from '../../lib/input-filters';
import { MAX_LABEL_NAME_LENGTH } from '../../lib/constants';
import { useAdminLabels } from '../../features/repos/queries';
import { useCreateLabel, useDeleteLabel, useUpdateLabel } from '../../features/repos/mutations';

/**
 * 分类标签定义管理。
 *
 * 看板上给仓库「设置标签」的前提是先有标签定义；这一节提供创建、改名与删除（颜色只在创建时设定）。
 * 仍被仓库使用的标签不能删除（服务端同样拒绝）；改名与删除都携带 labelRevision，
 * 服务端在事务内比较版本，缺版本 428、冲突 409。
 */
export function LabelManager({ disabled = false }: { readonly disabled?: boolean }): React.ReactNode {
  const labelsQuery = useAdminLabels();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();
  const deleteLabel = useDeleteLabel();
  const { push } = useToast();

  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  /** 创建表单的逐字段错误 + 兜底文案；重命名的失败有自己的行内错误（renameError）。 */
  const [createErrors, setCreateErrors] = useState<{ name?: string; color?: string; general?: string }>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  /** 重命名行的行内错误：与输入同行显示，不占用创建表单的错误槽。 */
  const [renameError, setRenameError] = useState<string | null>(null);

  const submitting = createLabel.isPending || updateLabel.isPending || deleteLabel.isPending;

  async function submitCreate(): Promise<void> {
    const trimmed = name.trim();
    const trimmedColor = color.trim();
    const errors: { name?: string; color?: string } = {};
    if (trimmed === '') {
      errors.name = '标签名不能为空';
    } else if ([...trimmed].length > MAX_LABEL_NAME_LENGTH) {
      errors.name = `标签名最多 ${MAX_LABEL_NAME_LENGTH} 个字符`;
    }
    if (trimmedColor !== '' && !isValidLabelColor(trimmedColor)) {
      errors.color = LABEL_COLOR_INVALID;
    }
    setCreateErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    try {
      await createLabel.mutateAsync({ name: trimmed, color: trimmedColor === '' ? null : trimmedColor });
      setName('');
      setColor('');
      setCreateErrors({});
      push('success', '标签已创建');
    } catch (error) {
      // 服务端返回的字段级冲突/校验直接落到对应输入（如“标签名称已存在”），其余给兜底提示。
      const fields = error instanceof ApiError && error.fields !== undefined ? error.fields : {};
      setCreateErrors(
        Object.keys(fields).length > 0
          ? { name: fields['name'], color: fields['color'] }
          : { general: errorMessage(error) },
      );
    }
  }

  async function submitRename(id: string, labelRevision: number): Promise<void> {
    const trimmed = editingName.trim();
    if (trimmed === '') {
      setRenameError('标签名不能为空');
      return;
    }
    if ([...trimmed].length > MAX_LABEL_NAME_LENGTH) {
      setRenameError(`标签名最多 ${MAX_LABEL_NAME_LENGTH} 个字符`);
      return;
    }
    try {
      await updateLabel.mutateAsync({ id, labelRevision, name: trimmed });
      setEditingId(null);
      setEditingName('');
      setRenameError(null);
    } catch (error) {
      if (error instanceof StaleAuthError) {
        return;
      }
      // 失败同时由全局提示说明；这里只把原因留在该行内，不写创建表单的错误槽，也不重复播报。
      setRenameError(errorMessage(error));
    }
  }

  async function submitDelete(id: string, labelRevision: number, labelName: string): Promise<void> {
    try {
      await deleteLabel.mutateAsync({ id, labelRevision });
      push('success', `已删除标签「${labelName}」`);
      setCreateErrors({});
    } catch {
      // 同上：删除失败由全局提示承担（例如另一会话刚把标签挂到仓库）。
    }
  }

  return (
    <section aria-label="分类标签" className="gr-card flex flex-col gap-5 p-5 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-4">
        <h2 className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-text">
          <span aria-hidden="true" className="gr-icon-tile size-8">
            <Tags size={15} />
          </span>
          分类标签
        </h2>
        {disabled ? <span className="text-aux text-muted">Token 验证完成后可修改</span> : null}
      </header>

      {/*
        创建动作跟着表单走：它是这一组输入的唯一出口，放在章节右上会与输入分散；
        名称自适应 + 颜色固定列 + 动作列（最大化窗口下右侧不留空档）。
      */}
      <div className="grid grid-cols-1 items-end gap-x-3 gap-y-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <Field label="标签名" htmlFor="label-name" error={createErrors.name}>
          <Input
            id="label-name"
            value={name}
            maxLength={MAX_LABEL_NAME_LENGTH}
            disabled={disabled}
            invalid={createErrors.name !== undefined}
            placeholder={`最多 ${MAX_LABEL_NAME_LENGTH} 个字符`}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              // 输入阶段即时结算：非空且超长时立刻提示，符合时立刻收回提示；
              // 上一次提交的兜底错误同时作废（它描述的是旧值）。
              setCreateErrors((prev) => ({
                ...prev,
                general: undefined,
                name: next.trim().length === 0 || [...next].length <= MAX_LABEL_NAME_LENGTH
                  ? undefined
                  : `标签名最多 ${MAX_LABEL_NAME_LENGTH} 个字符`,
              }));
            }}
          />
        </Field>
        <Field label="颜色" htmlFor="label-color" error={createErrors.color}>
          <Input
            id="label-color"
            value={color}
            inputMode="text"
            disabled={disabled}
            invalid={createErrors.color !== undefined}
            placeholder="#1D4ED8"
            spellCheck={false}
            onChange={(event) => {
              const next = filterHexColorInput(event.target.value);
              setColor(next);
              setCreateErrors((prev) => ({
                ...prev,
                general: undefined,
                color: next === '' || isValidLabelColor(next) ? undefined : LABEL_COLOR_INVALID,
              }));
            }}
          />
        </Field>
        <div className="pb-0.5">
          <IconButton
            icon={Plus}
            tone="accent"
            label="创建标签"
            tooltip="创建标签"
            disabled={disabled || submitting}
            aria-busy={createLabel.isPending}
            onClick={() => {
              void submitCreate();
            }}
          />
        </div>
      </div>

      {createErrors.general !== undefined ? (
        <p role="alert" className="text-aux2 text-danger">
          {createErrors.general}
        </p>
      ) : null}

      {labelsQuery.isPending ? (
        <p className="text-aux text-muted" role="status">
          正在读取标签…
        </p>
      ) : labelsQuery.isError ? (
        <ErrorState
          title="标签读取失败"
          description={errorMessage(labelsQuery.error)}
          retryBusy={labelsQuery.isFetching}
          onRetry={() => {
            void labelsQuery.refetch();
          }}
        />
      ) : labelsQuery.data.length === 0 ? (
        <p className="text-aux text-muted">还没有标签。创建后即可在仓库卡片上通过「设置标签」使用。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {labelsQuery.data.map((label) => (
            <li key={label.id} className="flex flex-wrap items-center gap-2 py-2">
              {editingId === label.id ? (
                <>
                  <div className="flex min-w-40 flex-1 items-center gap-2">
                    <Input
                      aria-label={`重命名标签 ${label.name}`}
                      value={editingName}
                      maxLength={MAX_LABEL_NAME_LENGTH}
                      invalid={renameError !== null}
                      className="min-w-0 flex-1"
                      onChange={(event) => {
                        setEditingName(event.target.value);
                        // 输入阶段作废上一次提交的错误：它描述的是旧值。
                        setRenameError(null);
                      }}
                    />
                    {/* 错误与输入同行显示（不放预留槽）：行高恒定，也不写 role="alert" 重复播报（全局提示已播报）。 */}
                    {renameError !== null ? (
                      <span title={renameError} className="min-w-0 max-w-48 truncate text-aux text-danger">
                        {renameError}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={disabled || submitting}
                    onClick={() => {
                      void submitRename(label.id, label.labelRevision);
                    }}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(null);
                      setRenameError(null);
                    }}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-2 text-body text-text">
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full border border-border"
                      style={label.color === null ? undefined : { backgroundColor: label.color }}
                    />
                    {label.name}
                  </span>
                  <span className="text-aux2 text-muted">{label.usedByRepositories} 个仓库在用</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || submitting}
                    onClick={() => {
                      setEditingId(label.id);
                      setEditingName(label.name);
                      setRenameError(null);
                    }}
                  >
                    重命名
                  </Button>
                  {label.usedByRepositories > 0 ? (
                    // 删除能力由服务端拒绝（LABEL_IN_USE）：这里用可聚焦的 aria-disabled 控件，
                    // 键盘焦点与悬停都能读到原因；若用原生 disabled，指针与键盘都拿不到提示。
                    <TooltipHint label={`仍有 ${label.usedByRepositories} 个仓库在用，先解除关联`}>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-disabled="true"
                        aria-label={`删除标签 ${label.name}（不可用：仍有 ${label.usedByRepositories} 个仓库在用）`}
                        className="relative inline-flex size-9 shrink-0 cursor-not-allowed items-center justify-center rounded-control text-muted opacity-50"
                        onClick={(event) => {
                          event.preventDefault();
                        }}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </span>
                    </TooltipHint>
                  ) : (
                    <IconButton
                      icon={Trash2}
                      tone="danger"
                      label={`删除标签 ${label.name}`}
                      disabled={disabled || submitting}
                      onClick={() => {
                        void submitDelete(label.id, label.labelRevision, label.name);
                      }}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
