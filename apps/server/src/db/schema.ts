import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle ORM 类型化查询层，与 `migrations/*.sql` 一一对应。
 *
 * 事实来源约定：**列、约束、索引、触发器、CHECK 全部以审核过的 SQL 迁移为唯一来源**，
 * 这里只镜像表与列供查询层使用。部分唯一索引、容量触发器和 CHECK 无法用本文件表达，
 * 也不在此重复声明，避免出现两套不一致的 schema 定义。
 * `tests/integration/schema-drift.test.ts` 会比对两边的列集合，防止此处漏改。
 *
 * 时间列一律 UTC 毫秒（`mode: 'number'`，不做 Date 转换）；布尔列是 0/1。
 */

export const discoveryRuns = sqliteTable('discovery_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceCommit: text('source_commit').notNull(),
  sourceManifestJson: text('source_manifest_json').notNull(),
  parserVersion: integer('parser_version').notNull(),
  state: text('state').notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  sourceUpdatedAt: integer('source_updated_at'),
  rowsTotal: integer('rows_total').notNull(),
  rowsValid: integer('rows_valid').notNull(),
  errorCode: text('error_code'),
});

export const adminAccount = sqliteTable('admin_account', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  authVersion: integer('auth_version').notNull(),
  passwordChangedAt: integer('password_changed_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenHash: text('token_hash').notNull().unique(),
    authVersion: integer('auth_version').notNull(),
    csrfNonce: text('csrf_nonce').notNull(),
    rememberMe: integer('remember_me', { mode: 'boolean' }).notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_expires_at_idx').on(table.expiresAt)],
);

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  defaultIntervalHours: integer('default_interval_hours').notNull(),
  discoveryEnabled: integer('discovery_enabled', { mode: 'boolean' }).notNull(),
  activeDiscoveryRunId: integer('active_discovery_run_id'),
  pinsRevision: integer('pins_revision').notNull(),
  revision: integer('revision').notNull(),
  /** 部署稳定的每日导入偏移，避免所有实例同时打上游。 */
  discoveryOffsetSeconds: integer('discovery_offset_seconds').notNull(),
  discoveryNextRunAt: integer('discovery_next_run_at'),
  trendsNextRunAt: integer('trends_next_run_at'),
  trendsLastAttemptState: text('trends_last_attempt_state'),
  trendsLastAttemptError: text('trends_last_attempt_error'),
  trendsLastAttemptAt: integer('trends_last_attempt_at'),
  trendsLastFailureError: text('trends_last_failure_error'),
  trendsLastFailureAt: integer('trends_last_failure_at'),
});

export const appSecret = sqliteTable('app_secret', {
  name: text('name').primaryKey(),
  value: blob('value', { mode: 'buffer' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  nonce: blob('nonce', { mode: 'buffer' }).notNull(),
  authTag: blob('auth_tag', { mode: 'buffer' }).notNull(),
  keyVersion: integer('key_version').notNull(),
  revision: integer('revision').notNull(),
});

export const githubCredentialStatus = sqliteTable('github_credential_status', {
  id: integer('id').primaryKey(),
  credentialRevision: integer('credential_revision').notNull(),
  gateRevision: integer('gate_revision').notNull(),
  credentialState: text('credential_state').notNull(),
  connectivity: text('connectivity').notNull(),
  tokenTypeHint: text('token_type_hint'),
  lastAttemptAt: integer('last_attempt_at'),
  lastVerifiedAt: integer('last_verified_at'),
  lastAuthenticatedAt: integer('last_authenticated_at'),
  expiresAt: integer('expires_at'),
  expiresObservedAt: integer('expires_observed_at'),
  classicScopesJson: text('classic_scopes_json'),
  lastErrorCode: text('last_error_code'),
  configuredAt: integer('configured_at'),
  accountId: text('account_id'),
  authObservationSeq: integer('auth_observation_seq').notNull(),
  verificationAttemptSeq: integer('verification_attempt_seq').notNull(),
  nextVerificationAt: integer('next_verification_at'),
});

export const proxyConfig = sqliteTable('proxy_config', {
  id: integer('id').primaryKey(),
  scheme: text('scheme'),
  host: text('host'),
  port: integer('port'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  revision: integer('revision').notNull(),
});

export const repositories = sqliteTable(
  'repositories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    githubId: integer('github_id').unique(),
    canonicalName: text('canonical_name').notNull().unique(),
    displayName: text('display_name'),
    note: text('note'),
    description: text('description'),
    htmlUrl: text('html_url').notNull(),
    ownerAvatarUrl: text('owner_avatar_url'),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull(),
    language: text('language'),
    stars: integer('stars').notNull(),
    forks: integer('forks').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    blockedReason: text('blocked_reason'),
    pinOrder: integer('pin_order'),
    intervalHours: integer('interval_hours'),
    releaseEnabled: integer('release_enabled', { mode: 'boolean' }).notNull(),
    includePrereleases: integer('include_prereleases', { mode: 'boolean' }).notNull(),
    defaultBranch: text('default_branch'),
    verificationState: text('verification_state').notNull(),
    reservedUntil: integer('reserved_until'),
    identityVerifiedAt: integer('identity_verified_at'),
    identityRevision: integer('identity_revision').notNull(),
    displayRevision: integer('display_revision').notNull(),
    collectionRevision: integer('collection_revision').notNull(),
    editRevision: integer('edit_revision').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('repositories_verification_idx').on(table.verificationState, table.reservedUntil),
    index('repositories_pin_idx').on(table.pinOrder),
  ],
);

export const labels = sqliteTable('labels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color'),
  labelRevision: integer('label_revision').notNull(),
});

export const repositoryLabels = sqliteTable(
  'repository_labels',
  {
    repoId: integer('repo_id').notNull(),
    labelId: integer('label_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.labelId] }),
    index('repository_labels_label_idx').on(table.labelId),
  ],
);

export const trackedBranches = sqliteTable(
  'tracked_branches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id').notNull(),
    mode: text('mode').notNull(),
    configuredName: text('configured_name'),
    resolvedName: text('resolved_name'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  },
  (table) => [
    uniqueIndex('tracked_branches_id_repo_uq').on(table.id, table.repoId),
  ],
);

export const monitorStreams = sqliteTable(
  'monitor_streams',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id').notNull(),
    kind: text('kind').notNull(),
    branchId: integer('branch_id'),
    initializedAt: integer('initialized_at'),
    currentProjectionJson: text('current_projection_json'),
    detectedChangeAt: integer('detected_change_at'),
    lastAttemptAt: integer('last_attempt_at'),
    lastSuccessAt: integer('last_success_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: integer('last_error_at'),
    nextDueAt: integer('next_due_at'),
    phaseSeed: integer('phase_seed').notNull(),
    configRevision: integer('config_revision').notNull(),
  },
  (table) => [index('monitor_streams_due_idx').on(table.nextDueAt)],
);

export const httpCache = sqliteTable(
  'http_cache',
  {
    key: text('key').primaryKey(),
    repoId: integer('repo_id'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    projectionJson: text('projection_json'),
    nextLink: text('next_link'),
    validatedAt: integer('validated_at'),
    credentialRevision: integer('credential_revision'),
    projectionVersion: integer('projection_version').notNull(),
  },
  (table) => [
    index('http_cache_repo_idx').on(table.repoId),
    index('http_cache_validated_idx').on(table.validatedAt),
  ],
);

export const pendingOperations = sqliteTable(
  'pending_operations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    encryptedCandidate: blob('encrypted_candidate', { mode: 'buffer' }).notNull(),
    initiatingSessionId: integer('initiating_session_id'),
    authVersion: integer('auth_version').notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    status: text('status').notNull(),
    expiresAt: integer('expires_at').notNull(),
    errorCode: text('error_code'),
    resultJson: text('result_json'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('pending_operations_expires_idx').on(table.expiresAt)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    streamId: integer('stream_id'),
    operationId: integer('operation_id'),
    kind: text('kind').notNull(),
    queueClass: text('queue_class').notNull(),
    origin: text('origin').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
    acceptedAuthVersion: integer('accepted_auth_version'),
    pauseOverride: integer('pause_override', { mode: 'boolean' }).notNull(),
    dedupeKey: text('dedupe_key'),
    state: text('state').notNull(),
    dueAt: integer('due_at'),
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until'),
    attemptToken: text('attempt_token'),
    attempt: integer('attempt').notNull(),
    continuationJson: text('continuation_json'),
    configRevision: integer('config_revision'),
    errorCode: text('error_code'),
    createdAt: integer('created_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    index('jobs_state_due_idx').on(table.state, table.dueAt),
    index('jobs_stream_idx').on(table.streamId),
    index('jobs_finished_idx').on(table.finishedAt),
  ],
);

export const runtimeLock = sqliteTable('runtime_lock', {
  id: integer('id').primaryKey(),
  ownerId: text('owner_id'),
  leaseUntil: integer('lease_until'),
  fence: integer('fence').notNull(),
});

export const jobGroups = sqliteTable('job_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
});

export const jobGroupItems = sqliteTable(
  'job_group_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: integer('group_id').notNull(),
    inputIndex: integer('input_index').notNull(),
    normalizedInput: text('normalized_input'),
    repoId: integer('repo_id'),
    jobId: integer('job_id'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
  },
  (table) => [
    uniqueIndex('job_group_items_group_input_uq').on(table.groupId, table.inputIndex),
    index('job_group_items_repo_idx').on(table.repoId),
  ],
);

export const dailyMetrics = sqliteTable(
  'daily_metrics',
  {
    repoId: integer('repo_id').notNull(),
    day: text('day').notNull(),
    stars: integer('stars').notNull(),
    forks: integer('forks').notNull(),
    sampledAt: integer('sampled_at').notNull(),
    verifiedAt: integer('verified_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.day] }),
    index('daily_metrics_day_idx').on(table.day),
  ],
);

export const discoveryItems = sqliteTable(
  'discovery_items',
  {
    runId: integer('run_id').notNull(),
    githubId: integer('github_id').notNull(),
    canonicalName: text('canonical_name').notNull(),
    htmlUrl: text('html_url').notNull(),
    description: text('description'),
    language: text('language'),
    stars: integer('stars'),
    forks: integer('forks'),
    domainsJson: text('domains_json'),
    topicsJson: text('topics_json'),
    firstSeen: text('first_seen'),
    sourceCreatedAt: text('source_created_at'),
    sourceFile: text('source_file').notNull(),
    statsSampledAt: integer('stats_sampled_at'),
  },
  (table) => [primaryKey({ columns: [table.runId, table.githubId] })],
);

export const dailyTrendRuns = sqliteTable(
  'daily_trend_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reportDay: text('report_day').notNull(),
    sourceCommit: text('source_commit').notNull(),
    sourceManifestJson: text('source_manifest_json').notNull(),
    parserVersion: integer('parser_version').notNull(),
    importedAt: integer('imported_at').notNull(),
  },
  (table) => [
    uniqueIndex('daily_trend_runs_day_uq').on(table.reportDay),
    index('daily_trend_runs_imported_idx').on(table.importedAt),
  ],
);

export const dailyTrendItems = sqliteTable(
  'daily_trend_items',
  {
    runId: integer('run_id').notNull(),
    rank: integer('rank').notNull(),
    fullName: text('full_name').notNull(),
    htmlUrl: text('html_url').notNull(),
    stars: integer('stars').notNull(),
    domain: text('domain'),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.rank] }),
    index('daily_trend_items_name_idx').on(table.fullName),
  ],
);

export const rateState = sqliteTable(
  'rate_state',
  {
    accountId: text('account_id').notNull(),
    resource: text('resource').notNull(),
    resetAt: integer('reset_at').notNull(),
    observedCredentialRevision: integer('observed_credential_revision'),
    limitValue: integer('limit_value'),
    remaining: integer('remaining'),
    localUsageJson: text('local_usage_json'),
    observedAt: integer('observed_at'),
    backoffUntil: integer('backoff_until'),
    nextRequestAt: integer('next_request_at'),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.resource, table.resetAt] })],
);
