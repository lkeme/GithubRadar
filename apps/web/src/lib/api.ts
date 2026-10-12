import type {
  AcceptedResponse,
  AvailableBranchesResponse,
  BulkAction,
  BulkActionResponse,
  BulkItemResult,
  CredentialStatusResponse,
  DiscoveryResponse,
  ImportProgressResponse,
  JobListResponse,
  JobSummary,
  LabelDefinition,
  ListMeta,
  OperationResponse,
  ProxyStatusResponse,
  PublicConfig,
  PublicLabel,
  PublicRepository,
  RepositoryControl,
  RepositoryDetail,
  RepositoryPatchRequest,
  SessionResponse,
  SettingsResponse,
  SystemStatusResponse,
} from '@githubradar/contracts';

import { getAuthEpoch } from './auth-epoch';
import { recordServerTiming } from './clock';
import { ApiError, StaleAuthError } from './errors';

/**
 * API 访问层：
 * - 只使用同源相对路径 `/api/v1/...`，不硬编码任何后端主机名。
 * - 每个响应读取 `Date`/`Age` 头用于服务器时钟偏差估算。
 * - 会话与管理请求发出时捕获 authEpoch，响应返回时 epoch 不匹配即抛 StaleAuthError 丢弃；
 *   session 类响应同样在保护范围内，否则退出/登录后在途的旧响应会复活已撤销的认证状态。
 * - 只做类型导入契约，不运行时导入。
 */

export type ApiKind = 'public' | 'session' | 'admin';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  csrfToken?: string | null;
  kind?: ApiKind;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export const API_BASE = '/api/v1';

let unauthorizedHandler: (() => void) | null = null;

/** 管理请求收到 401 时安静降级为只读；由 AuthProvider 注册。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export interface Envelope<T, M = unknown> {
  data: T;
  meta: M;
}

/**
 * 写操作后的公开缓存强制重验证：
 * 公开响应带 max-age=30，写后失效触发的 refetch 可能被浏览器缓存直接满足；
 * `invalidateAfterWrite` 在失效公开查询前调用本函数开启一个略长于 max-age 的
 * 时间窗，窗口内的公开请求一律 `cache: 'no-cache'`（发条件请求拿 304/200）。
 * 用时间窗而不是一次性标志：一次写失效会涉及多个查询（repos/labels/config），
 * 其中未挂载的查询可能在稍后才挂载重取——按“响应到达即清除”的标志会被先到的
 * 响应消费掉，让晚到的查询仍然吃到写前的缓存条目。
 */
const PUBLIC_CACHE_MAX_AGE_MS = 30_000;
let publicCacheRevalidationUntil = 0;

export function markPublicCacheRevalidation(): void {
  publicCacheRevalidationUntil = Date.now() + PUBLIC_CACHE_MAX_AGE_MS + 1_000;
}

async function requestRaw<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const kind = options.kind ?? 'public';
  // 会话（登录状态、csrfToken）与管理响应都必须按发出时的认证代际校验。
  const epoch = kind === 'public' ? -1 : getAuthEpoch();
  const revalidatePublicCache = kind === 'public' && Date.now() < publicCacheRevalidationUntil;
  const sentAt = Date.now();

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      // 会话与管理响应必须 no-store；公开响应反而要允许浏览器按服务端给出的
      // max-age/ETag 重新验证，否则服务端的 304 设计在浏览器里完全失效。
      cache: kind === 'public' ? (revalidatePublicCache ? 'no-cache' : 'default') : 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError('网络请求失败，请检查网络连接', 'NETWORK_ERROR', 0);
  }

  recordServerTiming({
    sentAt,
    receivedAt: Date.now(),
    dateHeader: response.headers.get('date'),
    ageHeader: response.headers.get('age'),
  });

  let payload: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  // 响应到达时认证代际已变化：丢弃，不写缓存、不写表单、不提示成功。
  // session 响应同样适用：退出/重新登录后在途的旧会话结果不能复活管理状态。
  if (kind !== 'public' && getAuthEpoch() !== epoch) {
    throw new StaleAuthError();
  }

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null;
    const code = body?.error?.code ?? 'UNKNOWN_ERROR';
    const message = body?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    if (kind === 'admin' && response.status === 401) {
      unauthorizedHandler?.();
    }
    throw new ApiError(message, code as ApiError['code'], response.status, body?.error?.fields);
  }

  if (payload !== null && typeof payload === 'object' && 'data' in payload) {
    const envelope = payload as { data: T; meta?: unknown };
    return { data: envelope.data, meta: envelope.meta };
  }
  // 204 等无信封成功响应；其他无信封响应视为异常，不静默当作空数据。
  if (response.status === 204) {
    return { data: undefined as T, meta: undefined };
  }
  throw new ApiError('服务返回了无法解析的响应', 'UPSTREAM_SCHEMA_CHANGED', response.status);
}

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

// ---------- 派生类型（契约类型别名） ----------

export type SessionData = SessionResponse['data'];
export type DiscoveryMeta = DiscoveryResponse['meta'];
export type ImportProgressData = ImportProgressResponse['data'];
export type ImportItemData = ImportProgressData['items'][number];
export type CredentialStatusData = CredentialStatusResponse['data'];
export type ProxyStatusData = ProxyStatusResponse['data'];
export type OperationData = OperationResponse['data'];
export type SystemStatusData = SystemStatusResponse['data'];
export type SettingsData = SettingsResponse['data'];
export type RepositoryDetailData = RepositoryDetail;
export type RepositoryPatchBody = RepositoryPatchRequest;
export type BulkActionResults = BulkActionResponse['data']['results'];
export type AvailableBranchesMeta = AvailableBranchesResponse['meta'];
export type { BulkAction, BulkItemResult, DiscoveryItem, JobSummary, LabelDefinition, PublicConfig, PublicLabel, PublicRepository, RepositoryControl, RepositoryDetail, TrendPoint, ReleaseSummary, PrereleaseSummary, BranchSummary, RepositoryStatus } from '@githubradar/contracts';

// ---------- 公开接口 ----------

export interface PublicRepoListParams {
  q?: string | undefined;
  labels?: string[] | undefined;
  pinned?: boolean | undefined;
  changed?: boolean | undefined;
  sort?: string | undefined;
  /** 趋势窗口天数；服务端在同一响应里返回该窗口内的降采样点。 */
  days?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function fetchPublicRepositories(
  params: PublicRepoListParams,
  signal?: AbortSignal,
): Promise<{ data: PublicRepository[]; meta: ListMeta }> {
  const query = encodeQuery({
    q: params.q && params.q.length > 0 ? params.q : undefined,
    labels: params.labels && params.labels.length > 0 ? params.labels.join(',') : undefined,
    pinned: params.pinned ? 'true' : undefined,
    changed: params.changed ? 'true' : undefined,
    sort: params.sort && params.sort !== 'default' ? params.sort : undefined,
    days: params.days !== undefined ? String(params.days) : undefined,
    page: params.page && params.page > 1 ? params.page : undefined,
    pageSize: params.pageSize,
  });
  const envelope = await requestRaw<PublicRepository[]>(`${API_BASE}/public/repositories${query}`, {
    kind: 'public',
    signal,
  });
  return {
    data: Array.isArray(envelope.data) ? envelope.data : [],
    meta: envelope.meta as ListMeta,
  };
}

export async function fetchPublicLabels(signal?: AbortSignal): Promise<PublicLabel[]> {
  const envelope = await requestRaw<PublicLabel[]>(`${API_BASE}/public/labels`, { kind: 'public', signal });
  return Array.isArray(envelope.data) ? envelope.data : [];
}

export async function fetchPublicConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const envelope = await requestRaw<PublicConfig>(`${API_BASE}/public/config`, { kind: 'public', signal });
  return envelope.data;
}

export interface DiscoveryListParams {
  q?: string | undefined;
  language?: string | undefined;
  category?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export async function fetchDiscovery(
  params: DiscoveryListParams,
  signal?: AbortSignal,
): Promise<Envelope<DiscoveryResponse['data'], DiscoveryMeta>> {
  const query = encodeQuery({
    q: params.q && params.q.length > 0 ? params.q : undefined,
    language: params.language,
    category: params.category,
    page: params.page && params.page > 1 ? params.page : undefined,
    pageSize: params.pageSize,
  });
  const envelope = await requestRaw<DiscoveryResponse['data']>(`${API_BASE}/public/discovery${query}`, {
    kind: 'public',
    signal,
  });
  return { data: Array.isArray(envelope.data) ? envelope.data : [], meta: envelope.meta as DiscoveryMeta };
}

// ---------- 认证与会话 ----------

export async function fetchSession(signal?: AbortSignal): Promise<SessionData> {
  const envelope = await requestRaw<SessionData>(`${API_BASE}/auth/session`, { kind: 'session', signal });
  return envelope.data;
}

/** 登录并返回登录响应携带的会话数据（csrfToken/期限），供会话端点暂时不可达时兜底。 */
export async function login(password: string, rememberMe: boolean, signal?: AbortSignal): Promise<SessionData> {
  const envelope = await requestRaw<SessionData>(`${API_BASE}/auth/login`, {
    kind: 'session',
    method: 'POST',
    body: { username: 'admin', password, rememberMe },
    signal,
  });
  return envelope.data;
}

export async function logout(csrfToken: string | null, signal?: AbortSignal): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/auth/logout`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
    signal,
  });
}

/**
 * 受保护的活跃心跳：仅浏览器可见且近期有用户输入时发送，最多每 5 分钟一次；
 * 被动轮询不续期，过期会话不会被复活（服务端在事务内复核后决定）。
 */
export async function postAuthActivity(csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/auth/activity`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
  });
}

// ---------- 管理：当前页补充数据与仓库操作 ----------

export async function fetchRepositoryControls(
  ids: string[],
  signal?: AbortSignal,
): Promise<{ data: RepositoryControl[]; setupRequired: boolean }> {
  const query = encodeQuery({ ids: ids.join(',') });
  const envelope = await requestRaw<RepositoryControl[]>(`${API_BASE}/admin/repository-controls${query}`, {
    kind: 'admin',
    signal,
  });
  const meta = envelope.meta as { setupRequired?: boolean } | undefined;
  return {
    data: Array.isArray(envelope.data) ? envelope.data : [],
    setupRequired: meta?.setupRequired === true,
  };
}

export interface AdminCheckAccepted {
  groupId: string | null;
  jobIds: string[];
  reused: boolean;
}

export async function postChecks(
  scope: 'all' | 'selected',
  ids: string[] | undefined,
  csrfToken: string | null,
): Promise<AdminCheckAccepted> {
  const envelope = await requestRaw<AcceptedResponse['data']>(`${API_BASE}/admin/checks`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
    body: { scope, ...(ids ? { ids } : {}) },
  });
  const data = envelope.data;
  return {
    groupId: data?.groupId ?? null,
    jobIds: Array.isArray(data?.jobIds) ? data.jobIds : [],
    reused: data?.reused === true,
  };
}

export interface BulkActionItemInput {
  id: string;
  editRevision: number;
}

export async function postRepositoryAction(
  action: BulkAction,
  items: BulkActionItemInput[],
  csrfToken: string | null,
  labelIds?: number[],
): Promise<BulkItemResult[]> {
  const envelope = await requestRaw<BulkActionResponse['data']>(`${API_BASE}/admin/repository-actions`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
    body: { action, items, ...(labelIds ? { labelIds } : {}) },
  });
  return Array.isArray(envelope.data?.results) ? envelope.data.results : [];
}

export async function fetchRepositoryDetail(id: string, signal?: AbortSignal): Promise<RepositoryDetailData> {
  const envelope = await requestRaw<RepositoryDetailData>(`${API_BASE}/admin/repositories/${encodeURIComponent(id)}`, {
    kind: 'admin',
    signal,
  });
  return envelope.data;
}

/** PATCH 只提交契约允许的用户可编辑字段，返回最新 editRevision（如服务端返回）。 */
export async function patchRepository(
  id: string,
  body: RepositoryPatchBody,
  csrfToken: string | null,
): Promise<{ editRevision: number | null }> {
  const envelope = await requestRaw<Partial<RepositoryDetail> | undefined>(
    `${API_BASE}/admin/repositories/${encodeURIComponent(id)}`,
    { kind: 'admin', method: 'PATCH', csrfToken, body },
  );
  const revision = envelope.data?.editRevision;
  return { editRevision: typeof revision === 'number' ? revision : null };
}

export async function deleteRepository(
  id: string,
  editRevision: number,
  csrfToken: string | null,
): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/repositories/${encodeURIComponent(id)}`, {
    kind: 'admin',
    method: 'DELETE',
    csrfToken,
    headers: { 'If-Match': String(editRevision) },
  });
}

// ---------- 管理：批量导入 ----------

export async function createRepositoryImport(input: string, csrfToken: string | null): Promise<string> {
  const envelope = await requestRaw<AcceptedResponse['data'] | { groupId?: string | null }>(
    `${API_BASE}/admin/repository-imports`,
    { kind: 'admin', method: 'POST', csrfToken, body: { input } },
  );
  const groupId = envelope.data?.groupId;
  if (typeof groupId !== 'string' || groupId.length === 0) {
    throw new ApiError('服务未返回导入批次标识', 'INTERNAL_ERROR', 0);
  }
  return groupId;
}

export async function fetchImportProgress(groupId: string, signal?: AbortSignal): Promise<ImportProgressData> {
  const envelope = await requestRaw<ImportProgressData>(
    `${API_BASE}/admin/repository-imports/${encodeURIComponent(groupId)}`,
    { kind: 'admin', signal },
  );
  return envelope.data;
}

// ---------- 管理：编辑监控与分支 ----------

export async function fetchAvailableBranches(
  id: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ data: AvailableBranchesResponse['data']; meta: AvailableBranchesMeta }> {
  const query = encodeQuery({ page, pageSize: 100 });
  const envelope = await requestRaw<AvailableBranchesResponse['data']>(
    `${API_BASE}/admin/repositories/${encodeURIComponent(id)}/available-branches${query}`,
    { kind: 'admin', signal },
  );
  return {
    data: Array.isArray(envelope.data) ? envelope.data : [],
    meta: envelope.meta as AvailableBranchesMeta,
  };
}

export async function postBranchRefresh(id: string, csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/repositories/${encodeURIComponent(id)}/branch-refreshes`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
  });
}

export interface BranchSelectionInput {
  mode: 'default' | 'fixed';
  name: string | null;
}

export async function putBranches(
  id: string,
  editRevision: number,
  branches: BranchSelectionInput[],
  csrfToken: string | null,
): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/repositories/${encodeURIComponent(id)}/branches`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: { editRevision, branches },
  });
}

// ---------- 管理：标签与置顶 ----------

export async function fetchAdminLabels(signal?: AbortSignal): Promise<LabelDefinition[]> {
  const envelope = await requestRaw<LabelDefinition[]>(`${API_BASE}/admin/labels`, { kind: 'admin', signal });
  return Array.isArray(envelope.data) ? envelope.data : [];
}

export async function createAdminLabel(
  input: { name: string; color: string | null },
  csrfToken: string | null,
): Promise<LabelDefinition> {
  const envelope = await requestRaw<LabelDefinition>(`${API_BASE}/admin/labels`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
    body: { name: input.name, color: input.color },
  });
  return envelope.data;
}

export async function updateAdminLabel(
  id: string,
  labelRevision: number,
  patch: { name?: string; color?: string | null },
  csrfToken: string | null,
): Promise<LabelDefinition> {
  const envelope = await requestRaw<LabelDefinition>(`${API_BASE}/admin/labels/${encodeURIComponent(id)}`, {
    kind: 'admin',
    method: 'PATCH',
    csrfToken,
    body: { labelRevision, ...patch },
  });
  return envelope.data;
}

/** 删除标签定义同样要求前置版本（缺版本 428、冲突 409），用 If-Match 携带。 */
export async function deleteAdminLabel(
  id: string,
  labelRevision: number,
  csrfToken: string | null,
): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/labels/${encodeURIComponent(id)}`, {
    kind: 'admin',
    method: 'DELETE',
    csrfToken,
    headers: { 'If-Match': String(labelRevision) },
  });
}

export interface PinsData {
  pinsRevision: number;
  ids: string[];
}

/**
 * 置顶顺序与 pinsRevision。
 * 顺序与完整性以 `GET /admin/pins` 为唯一真源（全部置顶 ID，按 pin_order 排序）；
 * 不从公开列表推导——公开列表分页截断会丢第 101+ 项。
 */
export async function fetchPins(signal?: AbortSignal): Promise<PinsData> {
  const envelope = await requestRaw<{ pinsRevision?: number; ids?: string[] }>(`${API_BASE}/admin/pins`, {
    kind: 'admin',
    signal,
  });
  const revision = envelope.data?.pinsRevision;
  if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 1) {
    return {
      pinsRevision: revision,
      ids: Array.isArray(envelope.data?.ids) ? envelope.data.ids : [],
    };
  }
  throw new ApiError('置顶读取响应缺少版本', 'UPSTREAM_SCHEMA_CHANGED', 200);
}

export async function putPins(pinsRevision: number, ids: string[], csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/pins`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: { pinsRevision, ids },
  });
}

// ---------- 管理：任务与系统状态 ----------

export async function fetchJobs(
  page: number,
  signal?: AbortSignal,
): Promise<{ data: JobSummary[]; meta: ListMeta }> {
  const query = encodeQuery({ page, pageSize: 30 });
  const envelope = await requestRaw<JobListResponse['data']>(`${API_BASE}/admin/jobs${query}`, {
    kind: 'admin',
    signal,
  });
  return {
    data: Array.isArray(envelope.data) ? envelope.data : [],
    meta: envelope.meta as ListMeta,
  };
}

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatusData> {
  const envelope = await requestRaw<SystemStatusData>(`${API_BASE}/admin/system-status`, { kind: 'admin', signal });
  return envelope.data;
}

/** 清空任务历史：只删除终态任务，排队/执行中/延后重试的任务保留。 */
export async function clearJobHistory(csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/jobs`, {
    kind: 'admin',
    method: 'DELETE',
    csrfToken,
  });
}

/** 停止单个任务：误发起的检测与一直延后重试的任务就地终止。 */
export async function cancelJob(id: string, csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/jobs/${encodeURIComponent(id)}/cancel`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
  });
}

/** 移除单条已结束的任务记录；未结束的任务由服务端拒绝。 */
export async function deleteJob(id: string, csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/jobs/${encodeURIComponent(id)}`, {
    kind: 'admin',
    method: 'DELETE',
    csrfToken,
  });
}

export async function fetchSettings(signal?: AbortSignal): Promise<SettingsData> {
  const envelope = await requestRaw<SettingsData>(`${API_BASE}/admin/settings`, { kind: 'admin', signal });
  return envelope.data;
}

export async function putSettings(
  revision: number,
  patch: { defaultIntervalHours?: number },
  csrfToken: string | null,
): Promise<SettingsData> {
  const envelope = await requestRaw<SettingsData>(`${API_BASE}/admin/settings`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: { revision, ...patch },
  });
  return envelope.data;
}

// ---------- 管理：Token、代理、操作与密码 ----------

function pickOperationId(data: unknown): string | null {
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['id', 'operationId']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

export async function submitToken(token: string, csrfToken: string | null): Promise<{ operationId: string | null }> {
  const envelope = await requestRaw<unknown>(`${API_BASE}/admin/github-token`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: { token },
  });
  return { operationId: pickOperationId(envelope.data) };
}

export async function verifyToken(csrfToken: string | null): Promise<{ operationId: string | null }> {
  const envelope = await requestRaw<unknown>(`${API_BASE}/admin/github-token/verify`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
  });
  return { operationId: pickOperationId(envelope.data) };
}

/** 重置 Token：清除密文并把业务复位到门禁锁定；代理配置不受影响。 */
export async function clearGithubToken(csrfToken: string | null): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/github-token`, {
    kind: 'admin',
    method: 'DELETE',
    csrfToken,
  });
}

export async function fetchCredentialStatus(signal?: AbortSignal): Promise<CredentialStatusData> {
  const envelope = await requestRaw<CredentialStatusData>(`${API_BASE}/admin/github-token/status`, {
    kind: 'admin',
    signal,
  });
  return envelope.data;
}

export async function fetchOperation(id: string, signal?: AbortSignal): Promise<OperationData> {
  const envelope = await requestRaw<OperationData>(`${API_BASE}/admin/operations/${encodeURIComponent(id)}`, {
    kind: 'admin',
    signal,
  });
  return envelope.data;
}

export interface ProxySubmitInput {
  enabled: boolean;
  scheme?: 'http' | 'https' | 'socks5' | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  expectedRevision: number;
}

export type ProxyStatus = ProxyStatusData & {
  /** endpoint：服务端提供代理读取接口；tracked：按本会话已知写入镜像跟踪的保守版本。 */
  revisionSource: 'endpoint' | 'tracked';
};

let trackedProxyRevision = 1;

/** proxy_apply 操作成功后由设置页调用：服务端激活时把 revision 恰好 +1。 */
export function noteProxyApplied(expectedRevision: number): void {
  trackedProxyRevision = expectedRevision + 1;
}

export async function putProxy(input: ProxySubmitInput, csrfToken: string | null): Promise<{ operationId: string | null }> {
  const envelope = await requestRaw<unknown>(`${API_BASE}/admin/proxy`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: input,
  });
  const data = envelope.data;
  if (data !== null && typeof data === 'object') {
    const revision = (data as { revision?: unknown }).revision;
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 1) {
      // 关闭代理会直接返回最新代理状态，可同步真实版本。
      trackedProxyRevision = revision;
    }
  }
  return { operationId: pickOperationId(data) };
}

export interface ProxyTestInput {
  scheme: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

export async function testProxy(input: ProxyTestInput, csrfToken: string | null): Promise<{ operationId: string | null }> {
  const envelope = await requestRaw<unknown>(`${API_BASE}/admin/proxy/test`, {
    kind: 'admin',
    method: 'POST',
    csrfToken,
    body: input,
  });
  return { operationId: pickOperationId(envelope.data) };
}

/**
 * 代理状态：优先 `GET /admin/proxy`；服务端未提供该读取端时回退为
 * system-status 的代理摘要 + 本会话镜像跟踪的 revision（初始 1，与配置行默认一致）。
 */
export async function fetchProxyStatus(signal?: AbortSignal): Promise<ProxyStatus> {
  try {
    const envelope = await requestRaw<ProxyStatusData>(`${API_BASE}/admin/proxy`, { kind: 'admin', signal });
    const revision = envelope.data?.revision;
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 1) {
      trackedProxyRevision = revision;
      return { ...envelope.data, revisionSource: 'endpoint' };
    }
    throw new ApiError('代理状态响应缺少版本', 'UPSTREAM_SCHEMA_CHANGED', 200);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      const status = await fetchSystemStatus(signal);
      return {
        configured: status.proxy.configured,
        enabled: status.proxy.enabled,
        scheme: null,
        host: null,
        port: null,
        usernameConfigured: false,
        revision: trackedProxyRevision,
        revisionSource: 'tracked',
      };
    }
    throw error;
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  csrfToken: string | null,
): Promise<void> {
  await requestRaw<unknown>(`${API_BASE}/admin/password`, {
    kind: 'admin',
    method: 'PUT',
    csrfToken,
    body: { currentPassword, newPassword },
  });
}
