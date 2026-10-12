import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useRef } from 'react';

import type { BulkAction, LabelDefinition, RepositoryPatchBody } from '../../lib/api';
import {
  cancelJob as apiCancelJob,
  changePassword as apiChangePassword,
  clearGithubToken as apiClearGithubToken,
  clearJobHistory as apiClearJobHistory,
  createAdminLabel,
  createRepositoryImport,
  deleteAdminLabel,
  deleteJob as apiDeleteJob,
  deleteRepository as apiDeleteRepository,
  patchRepository as apiPatchRepository,
  postBranchRefresh,
  postChecks,
  postRepositoryAction,
  putBranches,
  putPins,
  putProxy,
  putSettings,
  submitToken,
  testProxy,
  updateAdminLabel,
  verifyToken,
  type AdminCheckAccepted,
  type BranchSelectionInput,
  type BulkActionItemInput,
  type BulkItemResult,
  type ProxySubmitInput,
  type ProxyTestInput,
} from '../../lib/api';
import { StaleAuthError, errorMessage } from '../../lib/errors';
import { invalidateAfterWrite, type InvalidationScope } from '../../lib/query';
import { useToast } from '../../components/ui/Toast';
import { useAuth } from '../auth/AuthProvider';

/**
 * 管理写操作：
 * - 所有写操作真实调用受保护 API（前端隐藏按钮不是授权机制）。
 * - 请求发出时捕获 authEpoch；迟到响应（StaleAuthError）静默丢弃，不写缓存、不提示成功。
 * - 成功后显式失效相关公开查询与管理补充查询。
 */

interface AdminMutationConfig<TInput, TResult> {
  mutationFn: (input: TInput, csrfToken: string | null) => Promise<TResult>;
  invalidate?: InvalidationScope | null;
  onSuccessEffect?: ((result: TResult, input: TInput) => void) | undefined;
  errorToToast?: boolean;
}

function useAdminMutation<TInput, TResult>(
  config: AdminMutationConfig<TInput, TResult>,
): UseMutationResult<TResult, Error, TInput> {
  const queryClient = useQueryClient();
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const csrfRef = useRef<string | null>(csrfToken);
  csrfRef.current = csrfToken;
  const configRef = useRef(config);
  configRef.current = config;

  return useMutation<TResult, Error, TInput>({
    mutationFn: (input: TInput) => configRef.current.mutationFn(input, csrfRef.current),
    onSuccess: (result, input) => {
      const invalidate = configRef.current.invalidate;
      if (invalidate !== null && invalidate !== undefined) {
        invalidateAfterWrite(queryClient, invalidate);
      }
      configRef.current.onSuccessEffect?.(result, input);
    },
    onError: (error) => {
      if (error instanceof StaleAuthError) {
        return;
      }
      if (configRef.current.errorToToast !== false) {
        push('error', errorMessage(error));
      }
    },
  });
}

export function useCheckRepositories(): UseMutationResult<AdminCheckAccepted, Error, { ids: string[] }> {
  return useAdminMutation<{ ids: string[] }, AdminCheckAccepted>({
    mutationFn: ({ ids }, csrf) => postChecks('selected', ids, csrf),
    invalidate: 'repositories',
  });
}

export function useCheckAllRepositories(): UseMutationResult<AdminCheckAccepted, Error, void> {
  return useAdminMutation<void, AdminCheckAccepted>({
    mutationFn: (_input, csrf) => postChecks('all', undefined, csrf),
    invalidate: 'repositories',
  });
}

export interface RepositoryActionInput {
  action: BulkAction;
  items: BulkActionItemInput[];
  labelIds?: number[];
}

export function useRepositoryActions(): UseMutationResult<BulkItemResult[], Error, RepositoryActionInput> {
  return useAdminMutation<RepositoryActionInput, BulkItemResult[]>({
    mutationFn: ({ action, items, labelIds }, csrf) => postRepositoryAction(action, items, csrf, labelIds),
    invalidate: 'repositories+labels',
  });
}

export interface DeleteRepositoryInput {
  id: string;
  editRevision: number;
}

export function useDeleteRepository(): UseMutationResult<void, Error, DeleteRepositoryInput> {
  return useAdminMutation<DeleteRepositoryInput, void>({
    mutationFn: ({ id, editRevision }, csrf) => apiDeleteRepository(id, editRevision, csrf),
    invalidate: 'repositories+labels',
  });
}

export interface MutationBehavior {
  /** false 时调用方在表单内自行展示错误（不弹全局提示）。 */
  errorToToast?: boolean;
}

export interface PatchRepositoryInput {
  id: string;
  body: RepositoryPatchBody;
}

export function usePatchRepository(behavior?: MutationBehavior): UseMutationResult<
  { editRevision: number | null },
  Error,
  PatchRepositoryInput
> {
  return useAdminMutation<PatchRepositoryInput, { editRevision: number | null }>({
    mutationFn: ({ id, body }, csrf) => apiPatchRepository(id, body, csrf),
    invalidate: 'repositories+labels',
    errorToToast: behavior?.errorToToast,
  });
}

export function useCreateImport(): UseMutationResult<string, Error, string> {
  return useAdminMutation<string, string>({
    mutationFn: (input, csrf) => createRepositoryImport(input, csrf),
    invalidate: null,
  });
}

export interface PutBranchesInput {
  id: string;
  editRevision: number;
  branches: BranchSelectionInput[];
}

export function usePutBranches(behavior?: MutationBehavior): UseMutationResult<void, Error, PutBranchesInput> {
  return useAdminMutation<PutBranchesInput, void>({
    mutationFn: ({ id, editRevision, branches }, csrf) => putBranches(id, editRevision, branches, csrf),
    invalidate: 'repositories',
    errorToToast: behavior?.errorToToast,
  });
}

export function useBranchRefresh(): UseMutationResult<void, Error, { id: string }> {
  return useAdminMutation<{ id: string }, void>({
    mutationFn: ({ id }, csrf) => postBranchRefresh(id, csrf),
    invalidate: null,
  });
}

export interface PutPinsInput {
  pinsRevision: number;
  ids: string[];
}

export function usePutPins(behavior?: MutationBehavior): UseMutationResult<void, Error, PutPinsInput> {
  return useAdminMutation<PutPinsInput, void>({
    mutationFn: ({ pinsRevision, ids }, csrf) => putPins(pinsRevision, ids, csrf),
    invalidate: 'repositories',
    errorToToast: behavior?.errorToToast,
  });
}

export interface PutSettingsInput {
  revision: number;
  patch: { defaultIntervalHours?: number };
}

export function usePutSettings(behavior?: MutationBehavior): UseMutationResult<unknown, Error, PutSettingsInput> {
  return useAdminMutation<PutSettingsInput, unknown>({
    mutationFn: ({ revision, patch }, csrf) => putSettings(revision, patch, csrf),
    invalidate: 'discovery',
    errorToToast: behavior?.errorToToast,
  });
}

export function useSubmitToken(behavior?: MutationBehavior): UseMutationResult<{ operationId: string | null }, Error, string> {
  return useAdminMutation<string, { operationId: string | null }>({
    mutationFn: (token, csrf) => submitToken(token, csrf),
    // 令牌变更会改变业务门禁：失效管理查询（含 controls），看板的 setupRequired 立即刷新。
    invalidate: 'repositories',
    errorToToast: behavior?.errorToToast,
  });
}

export function useVerifyToken(behavior?: MutationBehavior): UseMutationResult<{ operationId: string | null }, Error, void> {
  return useAdminMutation<void, { operationId: string | null }>({
    mutationFn: (_input, csrf) => verifyToken(csrf),
    invalidate: 'repositories',
    errorToToast: behavior?.errorToToast,
  });
}

/** 重置 Token：清空已保存的 PAT，业务回到门禁锁定（凭证明细由调用方刷新）。 */
export function useClearToken(behavior?: MutationBehavior): UseMutationResult<void, Error, void> {
  return useAdminMutation<void, void>({
    mutationFn: (_input, csrf) => apiClearGithubToken(csrf),
    invalidate: 'repositories',
    errorToToast: behavior?.errorToToast,
  });
}

/** 清空任务历史：只删除终态任务，进行中的任务保留。 */
export function useClearJobHistory(): UseMutationResult<void, Error, void> {
  return useAdminMutation<void, void>({
    mutationFn: (_input, csrf) => apiClearJobHistory(csrf),
    invalidate: null,
    errorToToast: false,
  });
}

/**
 * 停止单个任务：误发起的检测与一直延后重试的任务就地终止。
 * 用 repositories 作用域失效：仓库卡片上的"排队中/检测中"补充状态直接取自任务，
 * 不失效会让刚停掉的任务在卡片上继续显示最多 60 秒。
 */
export function useCancelJob(): UseMutationResult<void, Error, { id: string }> {
  return useAdminMutation<{ id: string }, void>({
    mutationFn: ({ id }, csrf) => apiCancelJob(id, csrf),
    invalidate: 'repositories',
    errorToToast: false,
  });
}

/** 移除单条已结束的任务记录；只影响历史，不改动仓库或公开数据。 */
export function useDeleteJob(): UseMutationResult<void, Error, { id: string }> {
  return useAdminMutation<{ id: string }, void>({
    mutationFn: ({ id }, csrf) => apiDeleteJob(id, csrf),
    invalidate: null,
    errorToToast: false,
  });
}

export function usePutProxy(behavior?: MutationBehavior): UseMutationResult<{ operationId: string | null }, Error, ProxySubmitInput> {
  return useAdminMutation<ProxySubmitInput, { operationId: string | null }>({
    mutationFn: (input, csrf) => putProxy(input, csrf),
    invalidate: null,
    errorToToast: behavior?.errorToToast,
  });
}

export function useTestProxy(behavior?: MutationBehavior): UseMutationResult<{ operationId: string | null }, Error, ProxyTestInput> {
  return useAdminMutation<ProxyTestInput, { operationId: string | null }>({
    mutationFn: (input, csrf) => testProxy(input, csrf),
    invalidate: null,
    errorToToast: behavior?.errorToToast,
  });
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** 修改密码：成功后服务端撤销全部旧会话，本地立即按退出处理（调用方负责收敛状态）。 */
export function useChangePassword(): UseMutationResult<void, Error, ChangePasswordInput> {
  return useAdminMutation<ChangePasswordInput, void>({
    mutationFn: ({ currentPassword, newPassword }, csrf) => apiChangePassword(currentPassword, newPassword, csrf),
    invalidate: null,
    errorToToast: false,
  });
}

// ---------- 分类标签定义 ----------

export function useCreateLabel(): UseMutationResult<LabelDefinition, Error, { name: string; color: string | null }> {
  return useAdminMutation<{ name: string; color: string | null }, LabelDefinition>({
    mutationFn: (input, csrf) => createAdminLabel(input, csrf),
    invalidate: 'labels',
  });
}

export interface UpdateLabelInput {
  id: string;
  labelRevision: number;
  name?: string;
  color?: string | null;
}

export function useUpdateLabel(): UseMutationResult<LabelDefinition, Error, UpdateLabelInput> {
  return useAdminMutation<UpdateLabelInput, LabelDefinition>({
    mutationFn: ({ id, labelRevision, ...patch }, csrf) => updateAdminLabel(id, labelRevision, patch, csrf),
    invalidate: 'labels',
  });
}

export interface DeleteLabelInput {
  id: string;
  labelRevision: number;
}

export function useDeleteLabel(): UseMutationResult<void, Error, DeleteLabelInput> {
  return useAdminMutation<DeleteLabelInput, void>({
    mutationFn: ({ id, labelRevision }, csrf) => deleteAdminLabel(id, labelRevision, csrf),
    invalidate: 'labels',
  });
}
