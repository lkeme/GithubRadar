import { Plus, RefreshCw, Trash } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { BranchSelectionInput, RepositoryDetailData, RepositoryPatchBody } from '../../lib/api';
import {
  INTERVAL_OPTIONS,
  MAX_BRANCHES_PER_REPO,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
} from '../../lib/constants';
import { ApiError, StaleAuthError, errorMessage } from '../../lib/errors';
import { toLabelIdNumbers } from '../../features/repos/labels';
import { useBranchRefresh, usePatchRepository, usePutBranches } from '../../features/repos/mutations';
import { useAdminLabels, useAvailableBranches, useRepositoryDetail } from '../../features/repos/queries';
import { ErrorState } from '../ui/States';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Dialog';
import { Field, Input, SwitchField, Textarea } from '../ui/Form';
import { SelectField } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { cn } from '../ui/cn';

export interface MonitorEditDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoId: string | null;
  repoName: string;
  returnFocusTo: RefObject<HTMLElement | null>;
  onSaved: () => void;
}

interface BranchRow {
  key: string;
  mode: 'default' | 'fixed';
  name: string;
}

interface FormState {
  editRevision: number;
  displayName: string;
  note: string;
  interval: 'inherit' | '3' | '6' | '12' | '24';
  releaseEnabled: boolean;
  includePrereleases: boolean;
  labelIds: string[];
  branches: BranchRow[];
}

let branchKeySeed = 0;
function nextBranchKey(): string {
  branchKeySeed += 1;
  return `b-${branchKeySeed}`;
}

function buildFormState(detail: RepositoryDetailData): FormState {
  return {
    editRevision: detail.editRevision,
    displayName: detail.displayName ?? '',
    note: detail.note ?? '',
    interval: detail.intervalHours === null ? 'inherit' : (String(detail.intervalHours) as FormState['interval']),
    releaseEnabled: detail.releaseEnabled,
    includePrereleases: detail.includePrereleases,
    labelIds: detail.labels.map((label) => label.id),
    branches: detail.branches.map((branch) => ({
      key: nextBranchKey(),
      mode: branch.mode,
      name: branch.mode === 'default' ? '' : (branch.name ?? ''),
    })),
  };
}

function normalizeBranches(rows: BranchRow[]): BranchSelectionInput[] {
  return rows.map((row) => ({
    mode: row.mode,
    name: row.mode === 'fixed' ? row.name.trim() : null,
  }));
}

/**
 * 编辑监控抽屉：
 * - 右侧抽屉（手机可全屏），包含别名、备注、档位（继承/3/6/12/24）、Release 开关、预发布开关、分支选择与标签。
 * - 保存成功关闭并刷新当前卡片；未保存关闭时提示放弃；失败留在表单并定位错误；返回焦点到原按钮。
 * - 表单注明备注/别名/分类会公开展示。
 */
export function MonitorEditDrawer({
  open,
  onOpenChange,
  repoId,
  repoName,
  returnFocusTo,
  onSaved,
}: MonitorEditDrawerProps) {
  const { push } = useToast();
  const detailQuery = useRepositoryDetail(open ? repoId : null);
  const labelsQuery = useAdminLabels();
  const branchesQuery = useAvailableBranches(open ? repoId : null);
  const patchMutation = usePatchRepository({ errorToToast: false });
  const branchesMutation = usePutBranches({ errorToToast: false });
  const refreshMutation = useBranchRefresh();

  const [form, setForm] = useState<FormState | null>(null);
  const [snapshot, setSnapshot] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** 已装载的服务端目标与版本；服务端版本变化时要重新装载表单。 */
  const loadedRef = useRef<{ id: string; editRevision: number } | null>(null);
  const formRef = useRef<FormState | null>(null);
  formRef.current = form;
  const snapshotRef = useRef('');
  snapshotRef.current = snapshot;
  const displayNameRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const branchRefs = useRef(new Map<string, HTMLInputElement | null>());

  const detail = detailQuery.data;

  useEffect(() => {
    if (!open) {
      loadedRef.current = null;
      setForm(null);
      setSnapshot('');
      setFormError(null);
      setFieldErrors({});
      setConfirmDiscard(false);
      return;
    }
    const loaded = loadedRef.current;
    if (detailQuery.data === undefined) {
      return;
    }
    const data = detailQuery.data;
    const current = formRef.current;
    /** 用户手上有未保存的编辑时，任何后台刷新都不覆盖表单。 */
    const editing =
      current !== null && snapshotRef.current.length > 0 && JSON.stringify(current) !== snapshotRef.current;
    // 版本没变，或正在编辑：不重建表单。
    // 只看 id 会让"保存后重开抽屉"命中缓存里的旧值——详情在重新订阅前先返回上一次的数据，
    // 于是刚改完的档位仍显示旧值，看起来像"改了也不生效"。
    if (loaded !== null && loaded.id === data.id && (loaded.editRevision === data.editRevision || editing)) {
      return;
    }
    loadedRef.current = { id: data.id, editRevision: data.editRevision };
    const built = buildFormState(data);
    setForm(built);
    setSnapshot(JSON.stringify(built));
    setFormError(null);
    setFieldErrors({});
  }, [open, detailQuery.data]);

  useEffect(() => {
    if (!refreshing) {
      return;
    }
    const refetch = branchesQuery.refetch;
    const timer = window.setInterval(() => {
      void refetch();
    }, 2000);
    const stop = window.setTimeout(() => {
      setRefreshing(false);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [refreshing, branchesQuery.refetch]);

  const dirty = useMemo(() => (form !== null && snapshot.length > 0 ? JSON.stringify(form) !== snapshot : false), [form, snapshot]);

  const availableBranchNames = useMemo(
    () => (branchesQuery.data?.data ?? []).map((branch) => branch.name),
    [branchesQuery.data],
  );

  if (!open) {
    return null;
  }

  const requestClose = (): void => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const validate = (current: FormState): Record<string, string> => {
    const issues: Record<string, string> = {};
    if (current.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      issues['displayName'] = `别名最长 ${MAX_DISPLAY_NAME_LENGTH} 个字符`;
    }
    if (current.note.length > MAX_NOTE_LENGTH) {
      issues['note'] = `备注最长 ${MAX_NOTE_LENGTH} 个字符`;
    }
    if (current.branches.length > MAX_BRANCHES_PER_REPO) {
      issues['branches'] = `每仓最多 ${MAX_BRANCHES_PER_REPO} 个分支（含默认分支）`;
    }
    const fixedNames = new Set<string>();
    let seenDefault = 0;
    current.branches.forEach((row, index) => {
      if (row.mode === 'default') {
        seenDefault += 1;
        if (seenDefault > 1) {
          issues[`branches.${index}.name`] = '只能有一个“默认跟随”行';
        }
        return;
      }
      const name = row.name.trim();
      if (name.length === 0) {
        issues[`branches.${index}.name`] = '固定分支需要填写分支名';
        return;
      }
      if (fixedNames.has(name)) {
        issues[`branches.${index}.name`] = '固定分支名不能重复（区分大小写）';
        return;
      }
      fixedNames.add(name);
    });
    return issues;
  };

  const focusFirstError = (issues: Record<string, string>, current: FormState): void => {
    if (issues['displayName'] !== undefined) {
      displayNameRef.current?.focus();
      return;
    }
    if (issues['note'] !== undefined) {
      noteRef.current?.focus();
      return;
    }
    for (let index = 0; index < current.branches.length; index += 1) {
      const row = current.branches[index];
      if (row !== undefined && issues[`branches.${index}.name`] !== undefined) {
        branchRefs.current.get(row.key)?.focus();
        return;
      }
    }
  };

  const handleSave = async (): Promise<void> => {
    if (form === null || detail === undefined) {
      return;
    }
    const issues = validate(form);
    if (Object.keys(issues).length > 0) {
      setFieldErrors(issues);
      setFormError('请先修正表单中的错误');
      focusFirstError(issues, form);
      return;
    }
    setFieldErrors({});
    setFormError(null);
    const initialForm = buildFormStateFromSnapshot(snapshot);
    const branchesChanged =
      initialForm === null ||
      JSON.stringify(normalizeBranches(form.branches)) !== JSON.stringify(normalizeBranches(initialForm.branches));
    const body: RepositoryPatchBody = {
      editRevision: form.editRevision,
      displayName: form.displayName.trim().length === 0 ? null : form.displayName.trim(),
      note: form.note.trim().length === 0 ? null : form.note.trim(),
      intervalHours: form.interval === 'inherit' ? null : (Number(form.interval) as 3 | 6 | 12 | 24),
      releaseEnabled: form.releaseEnabled,
      includePrereleases: form.includePrereleases,
      labelIds: toLabelIdNumbers(form.labelIds),
    };
    try {
      const patchResult = await patchMutation.mutateAsync({ id: detail.id, body });
      // PATCH 成功后版本已经推进：立刻写回表单，否则分支提交失败后重试会拿旧 revision
      // 撞乐观锁，界面还会把它误报成"配置已被其他操作更新"。
      const patchedRevision = patchResult.editRevision;
      if (patchedRevision !== null) {
        setForm((prev) => (prev === null ? prev : { ...prev, editRevision: patchedRevision }));
      }
      if (branchesChanged) {
        let revision = patchResult.editRevision;
        if (revision === null) {
          const refreshed = await detailQuery.refetch();
          revision = refreshed.data?.editRevision ?? null;
        }
        if (revision === null) {
          // 拿不到最新 editRevision 时不能跳过分支提交把部分成功当作成功；
          // 成功 Toast 只在全部变更真实提交后报告。
          setFormError('无法确认最新版本，分支变更未提交；请刷新后重试');
          return;
        }
        await branchesMutation.mutateAsync({
          id: detail.id,
          editRevision: revision,
          branches: normalizeBranches(form.branches),
        });
      }
      push('success', '监控配置已保存');
      onSaved();
    } catch (error) {
      if (error instanceof StaleAuthError) {
        return;
      }
      if (error instanceof ApiError) {
        if (error.fields !== undefined) {
          setFieldErrors(error.fields);
        }
        setFormError(errorMessage(error));
        if (error.code === 'REVISION_CONFLICT') {
          const refreshed = await detailQuery.refetch();
          const fresh = refreshed.data;
          if (fresh !== undefined) {
            setForm((prev) => (prev === null ? prev : { ...prev, editRevision: fresh.editRevision }));
          }
        }
        return;
      }
      setFormError('保存失败，请稍后重试');
    }
  };

  const saving = patchMutation.isPending || branchesMutation.isPending;

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          // 保存/分支提交在途时不允许关闭图层：请求落地后还有部分成功、版本回写等收尾，
          // 中途关闭会让结果无处呈现（Escape、遮罩与右上角关闭都走这里）。
          if (saving) {
            return;
          }
          requestClose();
          return;
        }
        onOpenChange(true);
      }}
      title={`编辑监控：${repoName}`}
      description="别名、备注与分类标签会公开展示在公开看板（含私有仓库的展示字段）。"
      onCloseAutoFocus={(event) => {
        // 打开抽屉的入口可能是"更多"菜单里的一项，菜单关闭后该 DOM 已移除；
        // 此时不能 preventDefault，否则焦点会掉到 body——交给 Radix 的默认返回逻辑。
        const target = returnFocusTo.current;
        if (target === null || !target.isConnected) {
          return;
        }
        event.preventDefault();
        target.focus();
      }}
      footer={
        <div className="flex flex-col gap-3">
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-warning/40 bg-warning-subtle p-3 text-aux2 text-text">
              <span>有未保存的更改，确定放弃？</span>
              <span className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setConfirmDiscard(false); }}>
                  继续编辑
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={saving}
                  onClick={() => {
                    setConfirmDiscard(false);
                    onOpenChange(false);
                  }}
                >
                  放弃更改
                </Button>
              </span>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={saving || form === null} aria-busy={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      }
    >
      {detailQuery.isPending ? (
        <p className="text-aux2 text-muted" role="status">
          正在加载监控配置…
        </p>
      ) : detailQuery.isError ? (
        <ErrorState
          title="加载监控配置失败"
          description={errorMessage(detailQuery.error)}
          onRetry={() => {
            void detailQuery.refetch();
          }}
          retryBusy={detailQuery.isFetching}
        />
      ) : form === null || detail === undefined ? (
        <p className="text-aux2 text-muted">暂无配置数据。</p>
      ) : (
        <div className="flex flex-col gap-5">
          {formError !== null ? (
            <p role="alert" className="rounded-control border border-danger/40 bg-danger-subtle p-3 text-aux2 text-danger">
              {formError}
            </p>
          ) : null}

          <Field label="别名" htmlFor="monitor-display-name" error={fieldErrors['displayName']}>
            <Input
              id="monitor-display-name"
              ref={displayNameRef}
              value={form.displayName}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              placeholder={`最长 ${MAX_DISPLAY_NAME_LENGTH} 字符`}
              invalid={fieldErrors['displayName'] !== undefined}
              className="font-sans"
              onChange={(event) => {
                setForm({ ...form, displayName: event.target.value });
              }}
            />
          </Field>

          <Field label="备注" htmlFor="monitor-note" error={fieldErrors['note']}>
            <Textarea
              id="monitor-note"
              ref={noteRef}
              value={form.note}
              maxLength={MAX_NOTE_LENGTH}
              rows={3}
              placeholder={`最长 ${MAX_NOTE_LENGTH} 字符`}
              invalid={fieldErrors['note'] !== undefined}
              className="font-sans"
              onChange={(event) => {
                setForm({ ...form, note: event.target.value });
              }}
            />
          </Field>

          <Field label="检测档位" htmlFor="monitor-interval" hint="“继承”跟随全局默认档位。">
            <SelectField
              id="monitor-interval"
              ariaLabel="检测档位"
              value={form.interval}
              onValueChange={(value) => {
                setForm({ ...form, interval: value as FormState['interval'] });
              }}
              options={[
                { value: 'inherit', label: '继承（跟随全局）' },
                ...INTERVAL_OPTIONS.map((hours) => ({ value: String(hours), label: `${hours} 小时` })),
              ]}
              className="w-52"
            />
          </Field>

          <fieldset className="flex flex-col gap-4 rounded-control border border-border p-4">
            <legend className="px-1.5 text-aux2 font-medium text-text">发布监控</legend>
            <SwitchField
              id="monitor-release"
              checked={form.releaseEnabled}
              onCheckedChange={(checked) => {
                setForm({ ...form, releaseEnabled: checked });
              }}
              label="监控 Release"
              hint="以 GitHub 官方 latest 正式版为准；关闭后再开启会重建对应基线。"
            />
            <SwitchField
              id="monitor-prerelease"
              checked={form.includePrereleases}
              onCheckedChange={(checked) => {
                setForm({ ...form, includePrereleases: checked });
              }}
              label="包含预发布"
              hint="固定检查发布列表前 20 条；关闭不影响正式版监控。"
              disabled={!form.releaseEnabled}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-control border border-border p-4">
            <legend className="px-1.5 text-aux2 font-medium text-text">分支监控</legend>
            <p className="text-aux text-muted">
              默认分支使用“默认跟随”，其余分支为固定名称（区分大小写）；最多 {MAX_BRANCHES_PER_REPO} 个分支（含默认分支）。
            </p>
            {fieldErrors['branches'] !== undefined ? (
              <p role="alert" className="text-aux text-danger">
                {fieldErrors['branches']}
              </p>
            ) : null}
            {form.branches.length === 0 ? (
              <p className="text-aux2 text-muted">当前没有分支监控项。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {form.branches.map((row, index) => {
                  const rowError = fieldErrors[`branches.${index}.name`];
                  return (
                    <li key={row.key} className="flex flex-wrap items-start gap-2">
                      <SelectField
                        ariaLabel={`第 ${index + 1} 个分支的模式`}
                        className="h-10"
                        value={row.mode}
                        onValueChange={(value) => {
                          const next = [...form.branches];
                          next[index] = { ...row, mode: value as 'default' | 'fixed' };
                          setForm({ ...form, branches: next });
                        }}
                        options={[
                          { value: 'default', label: '默认跟随' },
                          { value: 'fixed', label: '固定分支' },
                        ]}
                      />
                      <div className="flex min-w-40 flex-1 items-center gap-2">
                        <Input
                          aria-label={`第 ${index + 1} 个分支名称`}
                          placeholder={row.mode === 'default' ? '（自动跟随默认分支）' : '例如 main'}
                          list="monitor-branch-options"
                          ref={(element) => {
                            branchRefs.current.set(row.key, element);
                          }}
                          value={row.name}
                          disabled={row.mode === 'default'}
                          invalid={rowError !== undefined}
                          className="min-w-0 flex-1"
                          onChange={(event) => {
                            const next = [...form.branches];
                            next[index] = { ...row, name: event.target.value };
                            setForm({ ...form, branches: next });
                          }}
                        />
                        {/* 错误与输入同行显示（不放预留槽）：行高恒定，也不额外撑开分支列表。 */}
                        {rowError !== undefined ? (
                          <span role="alert" title={rowError} className="min-w-0 max-w-48 truncate text-aux text-danger">
                            {rowError}
                          </span>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        aria-label={`移除第 ${index + 1} 个分支监控项`}
                        onClick={() => {
                          setForm({ ...form, branches: form.branches.filter((item) => item.key !== row.key) });
                        }}
                      >
                        <Trash size={16} aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <datalist id="monitor-branch-options">
              {availableBranchNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Plus size={15} aria-hidden="true" />}
                disabled={form.branches.length >= MAX_BRANCHES_PER_REPO}
                onClick={() => {
                  setForm({ ...form, branches: [...form.branches, { key: nextBranchKey(), mode: 'fixed', name: '' }] });
                }}
              >
                添加分支
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<RefreshCw size={15} aria-hidden="true" className={cn(refreshing && 'motion-safe:animate-spin')} />}
                disabled={refreshMutation.isPending}
                onClick={() => {
                  if (repoId === null) {
                    return;
                  }
                  refreshMutation.mutate(
                    { id: repoId },
                    {
                      onSuccess: () => {
                        setRefreshing(true);
                        push('info', '已请求刷新分支缓存，稍后自动更新');
                      },
                    },
                  );
                }}
              >
                刷新分支列表
              </Button>
              {branchesQuery.data !== undefined ? (
                <span className="text-aux text-muted">
                  {branchesQuery.data.meta.cacheStatus === 'missing'
                    ? '本地分支缓存未建立'
                    : branchesQuery.data.meta.cacheStatus === 'stale'
                      ? '分支缓存可能过期'
                      : branchesQuery.data.meta.cacheStatus === 'refreshing'
                        ? '分支缓存刷新中'
                        : '分支缓存已就绪'}
                </span>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-control border border-border p-4">
            <legend className="px-1.5 text-aux2 font-medium text-text">分类标签</legend>
            <p className="text-aux text-muted">分类标签会公开展示。移除标签只解除本仓库引用，不删除全局标签定义。</p>
            {labelsQuery.data === undefined || labelsQuery.data.length === 0 ? (
              <p className="text-aux2 text-muted">暂无可用标签。</p>
            ) : (
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {labelsQuery.data.map((label) => {
                  const checked = form.labelIds.includes(label.id);
                  return (
                    <li key={label.id}>
                      <label className="flex items-center gap-2 rounded-control px-2.5 py-2 text-aux2 text-text transition-colors duration-150 hover:bg-surface-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--gr-accent)]"
                          checked={checked}
                          onChange={() => {
                            setForm({
                              ...form,
                              labelIds: checked
                                ? form.labelIds.filter((id) => id !== label.id)
                                : [...form.labelIds, label.id],
                            });
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">{label.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-aux text-muted">
            <dt>仓库规范名</dt>
            <dd className="truncate text-right font-mono text-text" title={detail.fullName}>
              {detail.fullName}
            </dd>
            <dt>身份验证</dt>
            <dd className="text-right text-text">
              {detail.verificationState === 'verified'
                ? '已验证'
                : detail.verificationState === 'pending'
                  ? '待验证'
                  : detail.verificationState === 'failed'
                    ? '验证失败'
                    : '验证过期'}
            </dd>
          </dl>
        </div>
      )}
    </Drawer>
  );
}

function buildFormStateFromSnapshot(snapshot: string): FormState | null {
  if (snapshot.length === 0) {
    return null;
  }
  try {
    return JSON.parse(snapshot) as FormState;
  } catch {
    return null;
  }
}
