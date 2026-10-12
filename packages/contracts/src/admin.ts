import { z } from 'zod';

import {
  INTERVAL_OPTIONS,
  MAX_BATCH_IDS,
  MAX_BRANCHES_PER_REPO,
  MAX_BRANCH_NAME_BYTES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_IMPORT_INPUT_CHARS,
  MAX_LABELS_PER_REPO,
  MAX_LABEL_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  REPOSITORY_LIMIT,
} from './limits.js';
import { GithubToken, LabelColor, Password, ProxyHost, ProxyPort, ProxyUsername } from './network.js';
import { Iso8601Utc, RepositoryStatus, TrendPoint } from './public.js';

/** 登录与会话。 */
export const LoginRequest = z.strictObject({
  username: z.string().min(1).max(64),
  password: z.string().min(1),
  // 必须是真正的 JSON boolean；不接受字符串 "false"。
  rememberMe: z.boolean(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionResponse = z.strictObject({
  data: z.strictObject({
    authenticated: z.boolean(),
    csrfToken: z.string().nullable(),
    expiresAt: Iso8601Utc.nullable(),
    rememberMe: z.boolean(),
    /** 未就绪时前端只需展示通用状态，不返回 Token 细节。 */
    setupRequired: z.boolean(),
  }),
  meta: z.strictObject({}),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const PasswordChangeRequest = z.strictObject({
  currentPassword: z.string().min(1),
  // 强度规则与服务端哈希入口共用 network.ts 的同一实现。
  newPassword: Password,
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>;

/** 仓库导入。 */
export const RepositoryImportRequest = z.strictObject({
  input: z.string().min(1).max(MAX_IMPORT_INPUT_CHARS),
});
export type RepositoryImportRequest = z.infer<typeof RepositoryImportRequest>;

export const ImportItemStatus = z.enum([
  'pending',
  'queued',
  'succeeded',
  'exists',
  'invalid',
  'limit_reached',
  'denied_or_missing',
  'failed',
  'expired',
]);
export type ImportItemStatus = z.infer<typeof ImportItemStatus>;

export const ImportItem = z.strictObject({
  index: z.number().int().min(0),
  input: z.string(),
  status: ImportItemStatus,
  errorCode: z.string().nullable(),
  repoId: z.string().nullable(),
});
export type ImportItem = z.infer<typeof ImportItem>;

export const ImportProgressResponse = z.strictObject({
  data: z.strictObject({
    groupId: z.string(),
    state: z.enum(['running', 'finished']),
    total: z.number().int().min(0),
    items: z.array(ImportItem),
  }),
  meta: z.strictObject({}),
});
export type ImportProgressResponse = z.infer<typeof ImportProgressResponse>;

/** 当前页管理补充数据（一次最多 100 个 ID，禁止 N+1）。 */
export const RepositoryControl = z.strictObject({
  id: z.string(),
  editRevision: z.number().int().min(1),
  enabled: z.boolean(),
  paused: z.boolean(),
  status: RepositoryStatus,
  verificationState: z.enum(['pending', 'verified', 'failed', 'expired']),
  jobState: z.enum(['idle', 'queued', 'running', 'retry_wait']),
  capabilities: z.strictObject({
    canCheck: z.boolean(),
    canPause: z.boolean(),
    canResume: z.boolean(),
    canRemove: z.boolean(),
    canEdit: z.boolean(),
  }),
});
export type RepositoryControl = z.infer<typeof RepositoryControl>;

export const RepositoryControlsResponse = z.strictObject({
  data: z.array(RepositoryControl),
  meta: z.strictObject({
    /** 门禁未就绪时只读补充数据仍然返回，但能力位全部为 false。 */
    setupRequired: z.boolean(),
  }),
});
export type RepositoryControlsResponse = z.infer<typeof RepositoryControlsResponse>;

export const BranchConfig = z.strictObject({
  id: z.number().int(),
  mode: z.enum(['default', 'fixed']),
  name: z.string().nullable(),
  resolvedName: z.string().nullable(),
  enabled: z.boolean(),
  status: z.enum(['ok', 'unavailable', 'initializing', 'error']),
  committedAt: Iso8601Utc.nullable(),
  url: z.string().nullable(),
});
export type BranchConfig = z.infer<typeof BranchConfig>;

export const StreamStatus = z.strictObject({
  kind: z.enum(['metadata', 'release', 'prerelease', 'branch']),
  branchId: z.number().int().nullable(),
  initialized: z.boolean(),
  detectedChangeAt: Iso8601Utc.nullable(),
  lastSuccessAt: Iso8601Utc.nullable(),
  lastAttemptAt: Iso8601Utc.nullable(),
  lastErrorCode: z.string().nullable(),
  nextDueAt: Iso8601Utc.nullable(),
});
export type StreamStatus = z.infer<typeof StreamStatus>;

export const RepositoryDetail = z.strictObject({
  id: z.string(),
  fullName: z.string(),
  displayName: z.string().nullable(),
  note: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string(),
  htmlUrl: z.string(),
  isPrivate: z.boolean(),
  language: z.string().nullable(),
  stars: z.number().int(),
  forks: z.number().int(),
  archived: z.boolean(),
  enabled: z.boolean(),
  blockedReason: z.string().nullable(),
  intervalHours: z.number().int().nullable(),
  releaseEnabled: z.boolean(),
  includePrereleases: z.boolean(),
  defaultBranch: z.string().nullable(),
  pinOrder: z.number().int().nullable(),
  labels: z.array(z.strictObject({ id: z.string(), name: z.string(), color: z.string().nullable() })),
  branches: z.array(BranchConfig),
  streams: z.array(StreamStatus),
  trends: z.array(TrendPoint),
  editRevision: z.number().int().min(1),
  displayRevision: z.number().int().min(1),
  collectionRevision: z.number().int().min(1),
  identityRevision: z.number().int().min(1),
  verificationState: z.enum(['pending', 'verified', 'failed', 'expired']),
  identityVerifiedAt: Iso8601Utc.nullable(),
  createdAt: Iso8601Utc,
  lastCheckedAt: Iso8601Utc.nullable(),
});
export type RepositoryDetail = z.infer<typeof RepositoryDetail>;

export const RepositoryDetailResponse = z.strictObject({
  data: RepositoryDetail,
  meta: z.strictObject({}),
});
export type RepositoryDetailResponse = z.infer<typeof RepositoryDetailResponse>;

/**
 * PATCH 只接受这些用户可编辑字段。
 * github_id、canonical_name、stars、status、baseline、next_due_at 等一律由服务器维护。
 */
export const RepositoryPatchRequest = z.strictObject({
  /**
   * 缺前置版本由服务端统一返回 428 REVISION_REQUIRED，因此这里声明为可选：
   * 让缺失版本走到同一处版本校验，而不是先在 schema 层变成 400。
   */
  editRevision: z.number().int().min(1).optional(),
  displayName: z.string().max(MAX_DISPLAY_NAME_LENGTH).nullable().optional(),
  note: z.string().max(MAX_NOTE_LENGTH).nullable().optional(),
  enabled: z.boolean().optional(),
  intervalHours: z.union([z.literal(INTERVAL_OPTIONS[0]), z.literal(INTERVAL_OPTIONS[1]), z.literal(INTERVAL_OPTIONS[2]), z.literal(INTERVAL_OPTIONS[3])]).nullable().optional(),
  releaseEnabled: z.boolean().optional(),
  includePrereleases: z.boolean().optional(),
  labelIds: z.array(z.number().int().positive()).max(MAX_LABELS_PER_REPO).optional(),
});
export type RepositoryPatchRequest = z.infer<typeof RepositoryPatchRequest>;

export const BulkAction = z.enum(['pause', 'resume', 'add_labels', 'remove_labels', 'remove', 'check']);
export type BulkAction = z.infer<typeof BulkAction>;

export const BulkActionItem = z.strictObject({
  id: z.string().min(1),
  editRevision: z.number().int().min(1),
});
export type BulkActionItem = z.infer<typeof BulkActionItem>;

export const BulkActionRequest = z.strictObject({
  action: BulkAction,
  items: z.array(BulkActionItem).min(1).max(MAX_BATCH_IDS),
  labelIds: z.array(z.number().int().positive()).max(MAX_LABELS_PER_REPO).optional(),
});
export type BulkActionRequest = z.infer<typeof BulkActionRequest>;

export const BulkItemResult = z.strictObject({
  id: z.string(),
  status: z.enum(['ok', 'conflict', 'failed', 'not_executed_auth', 'not_executed_setup_required']),
  errorCode: z.string().nullable(),
});
export type BulkItemResult = z.infer<typeof BulkItemResult>;

export const BulkActionResponse = z.strictObject({
  data: z.strictObject({ results: z.array(BulkItemResult) }),
  meta: z.strictObject({}),
});
export type BulkActionResponse = z.infer<typeof BulkActionResponse>;

export const BranchSelectionRequest = z.strictObject({
  editRevision: z.number().int().min(1),
  branches: z
    .array(
      z.strictObject({
        mode: z.enum(['default', 'fixed']),
        // `.max` 按 UTF-16 计长，服务端按 UTF-8 字节拒绝，因此这里再按字节口径校验一次。
        name: z
          .string()
          .max(MAX_BRANCH_NAME_BYTES)
          .refine((value) => new TextEncoder().encode(value).length <= MAX_BRANCH_NAME_BYTES, {
            message: '分支名最长 1024 字节（UTF-8）',
          })
          .nullable(),
      }),
    )
    .max(MAX_BRANCHES_PER_REPO),
});
export type BranchSelectionRequest = z.infer<typeof BranchSelectionRequest>;

export const AvailableBranch = z.strictObject({ name: z.string() });
export type AvailableBranch = z.infer<typeof AvailableBranch>;

export const AvailableBranchesResponse = z.strictObject({
  data: z.array(AvailableBranch),
  meta: z.strictObject({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
    cacheStatus: z.enum(['fresh', 'stale', 'missing', 'refreshing']),
    fetchedAt: Iso8601Utc.nullable(),
  }),
});
export type AvailableBranchesResponse = z.infer<typeof AvailableBranchesResponse>;

export const LabelDefinition = z.strictObject({
  id: z.string(),
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH),
  color: z.string().nullable(),
  labelRevision: z.number().int().min(1),
  usedByRepositories: z.number().int().min(0),
});
export type LabelDefinition = z.infer<typeof LabelDefinition>;

export const LabelListAdminResponse = z.strictObject({
  data: z.array(LabelDefinition),
  meta: z.strictObject({}),
});
export type LabelListAdminResponse = z.infer<typeof LabelListAdminResponse>;

export const LabelCreateRequest = z.strictObject({
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH),
  color: LabelColor.nullable().optional(),
});
export type LabelCreateRequest = z.infer<typeof LabelCreateRequest>;

export const LabelUpdateRequest = z.strictObject({
  labelRevision: z.number().int().min(1),
  name: z.string().min(1).max(MAX_LABEL_NAME_LENGTH).optional(),
  color: LabelColor.nullable().optional(),
});
export type LabelUpdateRequest = z.infer<typeof LabelUpdateRequest>;

export const PinsRequest = z.strictObject({
  pinsRevision: z.number().int().min(1),
  ids: z.array(z.string().min(1)).max(REPOSITORY_LIMIT),
});
export type PinsRequest = z.infer<typeof PinsRequest>;

/** 置顶顺序读取端：客户端需要真实 pinsRevision 才能安全提交，不能自行推测。 */
export const PinsResponse = z.strictObject({
  data: z.strictObject({
    pinsRevision: z.number().int().min(1),
    ids: z.array(z.string().min(1)),
  }),
  meta: z.strictObject({}),
});
export type PinsResponse = z.infer<typeof PinsResponse>;

export const CheckRequest = z.strictObject({
  scope: z.enum(['all', 'selected']),
  ids: z.array(z.string().min(1)).max(MAX_BATCH_IDS).optional(),
});
export type CheckRequest = z.infer<typeof CheckRequest>;

export const AcceptedResponse = z.strictObject({
  data: z.strictObject({
    groupId: z.string().nullable(),
    jobIds: z.array(z.string()),
    reused: z.boolean(),
  }),
  meta: z.strictObject({}),
});
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

/** 候选凭证/代理操作用 202 返回操作 ID；结果通过 GET operations/:id 查询。 */
export const OperationAcceptedResponse = z.strictObject({
  data: z.strictObject({ operationId: z.string() }),
  meta: z.strictObject({}),
});
export type OperationAcceptedResponse = z.infer<typeof OperationAcceptedResponse>;

/** 空数据成功响应，用于 DELETE、204 语义的写操作以及标签/置顶更新。 */
export const EmptyResponse = z.strictObject({
  data: z.strictObject({}),
  meta: z.strictObject({}),
});
export type EmptyResponse = z.infer<typeof EmptyResponse>;

export const JobSummary = z.strictObject({
  id: z.string(),
  kind: z.string(),
  queueClass: z.enum(['control', 'initialization', 'periodic', 'manual']),
  origin: z.enum(['scheduler', 'manual', 'import', 'control', 'recovery']),
  state: z.enum(['queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'skipped']),
  repoId: z.string().nullable(),
  repoName: z.string().nullable(),
  attempt: z.number().int().min(0),
  dueAt: Iso8601Utc.nullable(),
  acceptedAt: Iso8601Utc,
  finishedAt: Iso8601Utc.nullable(),
  errorCode: z.string().nullable(),
});
export type JobSummary = z.infer<typeof JobSummary>;

export const JobListResponse = z.strictObject({
  data: z.array(JobSummary),
  meta: z.strictObject({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  }),
});
export type JobListResponse = z.infer<typeof JobListResponse>;

export const SettingsResponse = z.strictObject({
  data: z.strictObject({
    defaultIntervalHours: z.number().int(),
    /** 发现模块恒为启用；保留在响应里只为让界面如实反映服务端状态。 */
    discoveryEnabled: z.boolean(),
    revision: z.number().int().min(1),
  }),
  meta: z.strictObject({}),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const SettingsUpdateRequest = z.strictObject({
  revision: z.number().int().min(1),
  // 档位是闭集；不在契约里限定就会直达数据库 CHECK 并变成 500。
  defaultIntervalHours: z
    .union([
      z.literal(INTERVAL_OPTIONS[0]),
      z.literal(INTERVAL_OPTIONS[1]),
      z.literal(INTERVAL_OPTIONS[2]),
      z.literal(INTERVAL_OPTIONS[3]),
    ])
    .optional(),
  // 项目发现是默认能力，不再接受开关字段。
});
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequest>;

/**
 * Token 状态卡。
 * 只保留界面真正使用的字段：状态、连通性、有效期、最近验证时间、最近错误与配额观测。
 * 类型提示、scope、配置时间、下次计划复核等不再对外暴露（本地交互不再展示，避免误导）。
 */
export const CredentialStatusResponse = z.strictObject({
  data: z.strictObject({
    configured: z.boolean(),
    state: z.enum(['missing', 'unverified', 'valid', 'invalid', 'expired']),
    connectivity: z.enum(['unknown', 'reachable', 'unavailable']),
    lastVerifiedAt: Iso8601Utc.nullable(),
    expiresAt: Iso8601Utc.nullable(),
    lastErrorCode: z.string().nullable(),
    rateLimit: z
      .strictObject({
        resource: z.string(),
        limit: z.number().int().nullable(),
        remaining: z.number().int().nullable(),
        resetAt: Iso8601Utc.nullable(),
        observedAt: Iso8601Utc.nullable(),
        sharedWithAccount: z.literal(true),
      })
      .nullable(),
  }),
  meta: z.strictObject({}),
});
export type CredentialStatusResponse = z.infer<typeof CredentialStatusResponse>;

export const TokenSubmitRequest = z.strictObject({
  token: GithubToken,
});
export type TokenSubmitRequest = z.infer<typeof TokenSubmitRequest>;

export const ProxyRequest = z.strictObject({
  enabled: z.boolean(),
  scheme: z.enum(['http', 'https', 'socks5']).nullable().optional(),
  host: ProxyHost.nullable().optional(),
  port: ProxyPort.nullable().optional(),
  username: ProxyUsername.nullable().optional(),
  password: z.string().max(512).nullable().optional(),
  expectedRevision: z.number().int().min(1),
});
export type ProxyRequest = z.infer<typeof ProxyRequest>;

export const ProxyTestRequest = z.strictObject({
  scheme: z.enum(['http', 'https', 'socks5']),
  host: ProxyHost,
  port: ProxyPort,
  username: ProxyUsername.nullable().optional(),
  password: z.string().max(512).nullable().optional(),
});
export type ProxyTestRequest = z.infer<typeof ProxyTestRequest>;

export const ProxyStatusResponse = z.strictObject({
  data: z.strictObject({
    configured: z.boolean(),
    enabled: z.boolean(),
    scheme: z.enum(['http', 'https', 'socks5']).nullable(),
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    usernameConfigured: z.boolean(),
    revision: z.number().int().min(1),
  }),
  meta: z.strictObject({}),
});
export type ProxyStatusResponse = z.infer<typeof ProxyStatusResponse>;

export const OperationStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);

export const OperationResponse = z.strictObject({
  data: z.strictObject({
    id: z.string(),
    kind: z.enum(['github_token', 'proxy_test', 'proxy_apply']),
    status: OperationStatus,
    errorCode: z.string().nullable(),
    createdAt: Iso8601Utc,
    expiresAt: Iso8601Utc,
    result: z
      .strictObject({
        probeStages: z
          .array(
            z.strictObject({
              stage: z.enum(['dns', 'connect', 'tls', 'http']),
              ok: z.boolean(),
              elapsedMs: z.number().int().min(0),
              detail: z.string().nullable(),
            }),
          )
          .nullable(),
        credentialState: z.enum(['missing', 'unverified', 'valid', 'invalid', 'expired']).nullable(),
      })
      .nullable(),
  }),
  meta: z.strictObject({}),
});
export type OperationResponse = z.infer<typeof OperationResponse>;

export const SystemStatusResponse = z.strictObject({
  data: z.strictObject({
    database: z.strictObject({
      path: z.string(),
      schemaVersion: z.string().nullable(),
      sizeBytes: z.number().int().min(0),
      journalMode: z.string(),
      foreignKeys: z.boolean(),
    }),
    scheduler: z.strictObject({
      running: z.boolean(),
      leaseOwner: z.string().nullable(),
      leaseUntil: Iso8601Utc.nullable(),
      nextWakeAt: Iso8601Utc.nullable(),
      globalNextRequestAt: Iso8601Utc.nullable(),
      backoffUntil: Iso8601Utc.nullable(),
      backoffReason: z.string().nullable(),
    }),
    repositories: z.strictObject({
      total: z.number().int(),
      verified: z.number().int(),
      initializing: z.number().int(),
      healthy: z.number().int(),
      partial: z.number().int(),
      stale: z.number().int(),
      error: z.number().int(),
      paused: z.number().int(),
    }),
    jobs: z.strictObject({
      queued: z.number().int(),
      running: z.number().int(),
      retryWaiting: z.number().int(),
      oldestDueAt: Iso8601Utc.nullable(),
      capacity: z.number().int(),
    }),
    throughput: z.strictObject({
      plannedRequestsPerHour: z.number(),
      // 假设全局档位分别为 3/6/12/24 小时的预计请求速率（单仓覆盖不变，继承仓库按该档位）。
      // 推荐档位必须基于对应档位自身的速率估算，不能把当前速率再乘 24/tier。
      plannedRequestsPerHourByTier: z.strictObject({
        '3': z.number(),
        '6': z.number(),
        '12': z.number(),
        '24': z.number(),
      }),
      observedRequestsPerHour: z.number(),
      notModifiedRatio: z.number().nullable(),
      averageLatencyMs: z.number().nullable(),
    }),
    credential: z.strictObject({
      state: z.enum(['missing', 'unverified', 'valid', 'invalid', 'expired']),
      connectivity: z.enum(['unknown', 'reachable', 'unavailable']),
      lastErrorCode: z.string().nullable(),
    }),
    proxy: z.strictObject({
      enabled: z.boolean(),
      configured: z.boolean(),
    }),
    discovery: z.strictObject({
      enabled: z.boolean(),
      /** 最近一次导入尝试的结论；无活跃代次且最近一次失败时为 anomaly。 */
      state: z.enum(['disabled', 'idle', 'running', 'anomaly']).nullable(),
      lastSuccessAt: Iso8601Utc.nullable(),
      itemsCount: z.number().int().nullable(),
      /** 下一次计划导入时间；尚未登记计划时为 null。 */
      nextRunAt: Iso8601Utc.nullable(),
      /** 最近一次导入尝试（含失败原因码）；从未尝试过为 null。 */
      lastAttempt: z
        .strictObject({
          state: z.enum(['idle', 'running', 'anomaly']),
          errorCode: z.string().nullable(),
          finishedAt: Iso8601Utc.nullable(),
        })
        .nullable(),
    }),
  }),
  meta: z.strictObject({}),
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponse>;
