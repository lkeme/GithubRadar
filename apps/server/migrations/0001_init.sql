-- GithubRadar 初始 schema（主规格 §6.2、§6.3）
--
-- 约定：
--   * 时间列一律以 _at 结尾，存 UTC Unix 毫秒；日期分桶列存北京时间日历日 YYYY-MM-DD。
--   * 枚举用 TEXT + CHECK；布尔用 0/1 INTEGER + CHECK。
--   * 本文件不包含事务控制语句，也不包含 VACUUM / journal_mode 等不可事务化操作；
--     迁移执行器负责把整批待执行迁移与版本记账放进同一个 BEGIN IMMEDIATE 事务。
--   * SQL 保留字冲突：主规格 §6.2 的 rate_state.limit 列在本文件命名为 limit_value。

--------------------------------------------------------------------------------
-- 可选发现代次（先于 settings 建立，因为 settings.active_discovery_run_id 引用它）
--------------------------------------------------------------------------------
CREATE TABLE discovery_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_commit        TEXT    NOT NULL,
  source_manifest_json TEXT    NOT NULL,
  parser_version       INTEGER NOT NULL,
  state                TEXT    NOT NULL CHECK (state IN ('staging', 'active', 'superseded', 'failed')),
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  source_updated_at    INTEGER,
  rows_total           INTEGER NOT NULL DEFAULT 0 CHECK (rows_total >= 0),
  rows_valid           INTEGER NOT NULL DEFAULT 0 CHECK (rows_valid >= 0),
  error_code           TEXT
);

-- 同一时刻只允许一个活跃代次；切换在短事务内完成（§8.1）。
CREATE UNIQUE INDEX discovery_runs_active_uq ON discovery_runs (state) WHERE state = 'active';

--------------------------------------------------------------------------------
-- 管理员单例与会话
--------------------------------------------------------------------------------
CREATE TABLE admin_account (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  username            TEXT    NOT NULL CHECK (length(username) BETWEEN 1 AND 64),
  password_hash       TEXT    NOT NULL,
  auth_version        INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 数据库只保存会话 token 的 SHA256 摘要（§10.1）；id 不是认证凭证。
  token_hash   TEXT    NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL,
  csrf_nonce   TEXT    NOT NULL,
  remember_me  INTEGER NOT NULL DEFAULT 0 CHECK (remember_me IN (0, 1)),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- 绝对期限：普通会话 24 小时，记住我 30 天；空闲期限由 last_seen_at 派生。
  expires_at   INTEGER NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

--------------------------------------------------------------------------------
-- 全局配置、密钥与凭证状态
--------------------------------------------------------------------------------
CREATE TABLE settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  default_interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (default_interval_hours IN (3, 6, 12, 24)),
  discovery_enabled      INTEGER NOT NULL DEFAULT 0 CHECK (discovery_enabled IN (0, 1)),
  active_discovery_run_id INTEGER REFERENCES discovery_runs (id) ON DELETE SET NULL,
  pins_revision          INTEGER NOT NULL DEFAULT 1 CHECK (pins_revision >= 1),
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE secrets (
  name        TEXT    PRIMARY KEY CHECK (name IN ('github_pat', 'proxy_password')),
  ciphertext  BLOB    NOT NULL,
  nonce       BLOB    NOT NULL,
  auth_tag    BLOB    NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

-- 单例状态行：业务就绪门禁、状态卡数据与配额归属（§19.2、§19.5）。
CREATE TABLE github_credential_status (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  credential_revision      INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
  gate_revision            INTEGER NOT NULL DEFAULT 1 CHECK (gate_revision >= 1),
  credential_state         TEXT    NOT NULL DEFAULT 'missing'
                             CHECK (credential_state IN ('missing', 'unverified', 'valid', 'invalid', 'expired')),
  connectivity             TEXT    NOT NULL DEFAULT 'unknown'
                             CHECK (connectivity IN ('unknown', 'reachable', 'unavailable')),
  token_type_hint          TEXT    CHECK (token_type_hint IS NULL OR token_type_hint IN ('classic', 'fine_grained')),
  last_attempt_at          INTEGER,
  last_verified_at         INTEGER,
  last_authenticated_at    INTEGER,
  expires_at               INTEGER,
  expires_observed_at      INTEGER,
  classic_scopes_json      TEXT,
  last_error_code          TEXT,
  configured_at            INTEGER,
  -- 仅内部使用，用于配额归属；不进入公开 DTO，首版状态卡不展示账号身份（§19.4）。
  account_id               TEXT,
  auth_observation_seq     INTEGER NOT NULL DEFAULT 0 CHECK (auth_observation_seq >= 0),
  verification_attempt_seq INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempt_seq >= 0),
  next_verification_at     INTEGER
);

CREATE TABLE proxy_config (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  scheme   TEXT    CHECK (scheme IS NULL OR scheme IN ('http', 'https', 'socks5')),
  host     TEXT,
  port     INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  enabled  INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- 关闭代理是管理员显式选择，因此 enabled=0 时允许字段为空（§5.4.1）。
  CHECK (enabled = 0 OR (scheme IS NOT NULL AND host IS NOT NULL AND port IS NOT NULL))
);

--------------------------------------------------------------------------------
-- 仓库、标签与分支
--------------------------------------------------------------------------------
CREATE TABLE repositories (
  -- 未验证时 github_id 为空；所有行都占用 999 名额，包括暂停与待初始化记录（§1.2 R04）。
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id            INTEGER UNIQUE,
  canonical_name       TEXT    NOT NULL UNIQUE,
  display_name         TEXT    CHECK (display_name IS NULL OR length(display_name) <= 100),
  note                 TEXT    CHECK (note IS NULL OR length(note) <= 1000),
  description          TEXT    CHECK (description IS NULL OR length(description) <= 1000),
  html_url             TEXT    NOT NULL,
  owner_avatar_url     TEXT,
  is_private           INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  language             TEXT,
  stars                INTEGER NOT NULL DEFAULT 0 CHECK (stars >= 0),
  forks                INTEGER NOT NULL DEFAULT 0 CHECK (forks >= 0),
  archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- 系统故障用独立 blocked_reason 表达，不与用户 enabled 开关混为一谈（§2.4）。
  blocked_reason       TEXT,
  pin_order            INTEGER,
  interval_hours       INTEGER CHECK (interval_hours IS NULL OR interval_hours IN (3, 6, 12, 24)),
  release_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (release_enabled IN (0, 1)),
  include_prereleases  INTEGER NOT NULL DEFAULT 0 CHECK (include_prereleases IN (0, 1)),
  default_branch       TEXT,
  verification_state   TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (verification_state IN ('pending', 'verified', 'failed', 'expired')),
  reserved_until       INTEGER,
  identity_verified_at INTEGER,
  -- 编辑版本与采集版本分离：改备注、置顶、档位不重建更新基线（§2.4、§18.3）。
  identity_revision    INTEGER NOT NULL DEFAULT 1 CHECK (identity_revision >= 1),
  display_revision     INTEGER NOT NULL DEFAULT 1 CHECK (display_revision >= 1),
  collection_revision  INTEGER NOT NULL DEFAULT 1 CHECK (collection_revision >= 1),
  edit_revision        INTEGER NOT NULL DEFAULT 1 CHECK (edit_revision >= 1),
  created_at           INTEGER NOT NULL
);

CREATE INDEX repositories_verification_idx ON repositories (verification_state, reserved_until);
CREATE INDEX repositories_pin_idx ON repositories (pin_order);

CREATE TABLE labels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
  color          TEXT,
  label_revision INTEGER NOT NULL DEFAULT 1 CHECK (label_revision >= 1)
);

CREATE TABLE repository_labels (
  repo_id  INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (repo_id, label_id)
);

CREATE INDEX repository_labels_label_idx ON repository_labels (label_id);

CREATE TABLE tracked_branches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  -- default 为跟随模式（configured_name 为空），fixed 为固定名称模式；分支名区分大小写。
  mode            TEXT    NOT NULL CHECK (mode IN ('default', 'fixed')),
  configured_name TEXT    CHECK (configured_name IS NULL OR length(CAST(configured_name AS BLOB)) <= 1024),
  resolved_name   TEXT    CHECK (resolved_name IS NULL OR length(CAST(resolved_name AS BLOB)) <= 1024),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  CHECK ((mode = 'default' AND configured_name IS NULL)
      OR (mode = 'fixed'   AND configured_name IS NOT NULL))
);

-- 每仓至多一个 default 跟随；fixed 按配置名唯一。
CREATE UNIQUE INDEX tracked_branches_default_uq ON tracked_branches (repo_id) WHERE mode = 'default';
CREATE UNIQUE INDEX tracked_branches_fixed_uq   ON tracked_branches (repo_id, configured_name) WHERE mode = 'fixed';
-- 供 monitor_streams 的复合外键使用，禁止流引用其他仓库的分支。
CREATE UNIQUE INDEX tracked_branches_id_repo_uq ON tracked_branches (id, repo_id);

--------------------------------------------------------------------------------
-- 采集流与条件缓存
--------------------------------------------------------------------------------
CREATE TABLE monitor_streams (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id                 INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  kind                    TEXT    NOT NULL CHECK (kind IN ('metadata', 'release', 'prerelease', 'branch')),
  branch_id               INTEGER,
  -- 每个采集流独立拥有 initialized_at，不能以 SHA 是否非空判断是否初始化（§3.2）。
  initialized_at          INTEGER,
  current_projection_json TEXT,
  detected_change_at      INTEGER,
  last_attempt_at         INTEGER,
  last_success_at         INTEGER,
  last_error_code         TEXT,
  last_error_at           INTEGER,
  next_due_at             INTEGER,
  phase_seed              INTEGER NOT NULL,
  config_revision         INTEGER NOT NULL DEFAULT 1 CHECK (config_revision >= 1),
  -- branch 流必须挂分支，其余类型必须不挂分支。
  CHECK ((kind = 'branch') = (branch_id IS NOT NULL)),
  FOREIGN KEY (branch_id, repo_id) REFERENCES tracked_branches (id, repo_id) ON DELETE CASCADE
);

-- SQLite 允许唯一键中包含 NULL 的多行，所以 release/metadata 唯一性必须用部分索引保证。
CREATE UNIQUE INDEX monitor_streams_resource_uq ON monitor_streams (repo_id, kind) WHERE branch_id IS NULL;
CREATE UNIQUE INDEX monitor_streams_branch_uq   ON monitor_streams (repo_id, branch_id) WHERE kind = 'branch';
CREATE INDEX monitor_streams_due_idx ON monitor_streams (next_due_at);

CREATE TABLE http_cache (
  -- 键包含 host、API 版本、方法、规范化路径/查询、Accept、凭证版本与投影 schema 版本；不含明文 Token。
  key                 TEXT    PRIMARY KEY,
  repo_id             INTEGER REFERENCES repositories (id) ON DELETE CASCADE,
  etag                TEXT,
  last_modified       TEXT,
  projection_json     TEXT,
  next_link           TEXT,
  validated_at        INTEGER,
  credential_revision INTEGER,
  projection_version  INTEGER NOT NULL
);

CREATE INDEX http_cache_repo_idx ON http_cache (repo_id);
CREATE INDEX http_cache_validated_idx ON http_cache (validated_at);

--------------------------------------------------------------------------------
-- 候选凭证操作与任务
--------------------------------------------------------------------------------
CREATE TABLE pending_operations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                  TEXT    NOT NULL CHECK (kind IN ('github_token', 'proxy_test', 'proxy_apply')),
  -- 候选秘密加密存放；jobs 只引用 operation id，secret 不进入 job payload（§5.4.1）。
  encrypted_candidate   BLOB    NOT NULL,
  initiating_session_id INTEGER REFERENCES sessions (id) ON DELETE CASCADE,
  auth_version          INTEGER NOT NULL,
  expected_revision     INTEGER NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  expires_at            INTEGER NOT NULL,
  error_code            TEXT,
  created_at            INTEGER NOT NULL
);

CREATE INDEX pending_operations_expires_idx ON pending_operations (expires_at);
-- 同类最多一个未完成的候选操作。
CREATE UNIQUE INDEX pending_operations_active_uq ON pending_operations (kind) WHERE status IN ('pending', 'running');

CREATE TABLE jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id             INTEGER REFERENCES monitor_streams (id) ON DELETE SET NULL,
  operation_id          INTEGER REFERENCES pending_operations (id) ON DELETE SET NULL,
  kind                  TEXT    NOT NULL CHECK (kind IN ('metadata', 'release', 'prerelease', 'branch', 'branch_list', 'token_verify', 'proxy_test')),
  queue_class           TEXT    NOT NULL CHECK (queue_class IN ('control', 'initialization', 'periodic', 'manual')),
  -- 来源、受理时间与暂停许可以由服务器产生，客户端不能直接赋值（§18.3）。
  origin                TEXT    NOT NULL CHECK (origin IN ('scheduler', 'manual', 'import', 'control', 'recovery')),
  accepted_at           INTEGER NOT NULL,
  accepted_auth_version INTEGER,
  pause_override        INTEGER NOT NULL DEFAULT 0 CHECK (pause_override IN (0, 1)),
  dedupe_key            TEXT,
  state                 TEXT    NOT NULL CHECK (state IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'skipped')),
  due_at                INTEGER,
  lease_owner           TEXT,
  lease_until           INTEGER,
  attempt_token         TEXT,
  attempt               INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  continuation_json     TEXT,
  config_revision       INTEGER,
  created_at            INTEGER NOT NULL,
  finished_at           INTEGER
);

-- 去重只在未结束状态生效，已结束任务保留记录不阻塞后续同类任务。
CREATE UNIQUE INDEX jobs_active_dedupe_uq ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running', 'retry_wait');
CREATE INDEX jobs_state_due_idx ON jobs (state, due_at);
CREATE INDEX jobs_stream_idx ON jobs (stream_id);
CREATE INDEX jobs_finished_idx ON jobs (finished_at);

CREATE TABLE runtime_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id    TEXT,
  lease_until INTEGER,
  fence       INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0)
);

CREATE TABLE job_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('repository_import', 'manual_check', 'discovery_import')),
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE job_group_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id         INTEGER NOT NULL REFERENCES job_groups (id) ON DELETE CASCADE,
  input_index      INTEGER NOT NULL CHECK (input_index >= 0),
  normalized_input TEXT,
  -- 仓库/任务被删除时保留输入与最终结果，不能因释放失败占位而丢失导入反馈（§6.2）。
  repo_id          INTEGER REFERENCES repositories (id) ON DELETE SET NULL,
  job_id           INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  status           TEXT    NOT NULL CHECK (status IN ('pending', 'queued', 'succeeded', 'failed', 'skipped')),
  error_code       TEXT,
  UNIQUE (group_id, input_index)
);

CREATE INDEX job_group_items_repo_idx ON job_group_items (repo_id);

--------------------------------------------------------------------------------
-- 趋势、发现条目与配额
--------------------------------------------------------------------------------
CREATE TABLE daily_metrics (
  repo_id     INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  -- 北京时间日历日；一天最后一次有效观察覆盖（§6.2、§7）。
  day         TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  stars       INTEGER NOT NULL CHECK (stars >= 0),
  forks       INTEGER NOT NULL CHECK (forks >= 0),
  sampled_at  INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, day)
);

CREATE INDEX daily_metrics_day_idx ON daily_metrics (day);

CREATE TABLE discovery_items (
  run_id            INTEGER NOT NULL REFERENCES discovery_runs (id) ON DELETE CASCADE,
  github_id         INTEGER NOT NULL,
  canonical_name    TEXT    NOT NULL,
  html_url          TEXT    NOT NULL,
  description       TEXT,
  language          TEXT,
  stars             INTEGER,
  forks             INTEGER,
  domains_json      TEXT,
  topics_json       TEXT,
  first_seen        TEXT,
  source_created_at TEXT,
  source_file       TEXT    NOT NULL,
  -- 来源统计采样时间未知时为 NULL，不能用导入时间填充（§8.1）。
  stats_sampled_at  INTEGER,
  PRIMARY KEY (run_id, github_id)
);

CREATE INDEX discovery_items_rank_idx ON discovery_items (run_id, stars DESC, canonical_name);

CREATE TABLE rate_state (
  -- 预算按 account_id + resource + reset_at 归属，换同账号 PAT 不重置计费（§5.2）。
  account_id                   TEXT    NOT NULL,
  resource                     TEXT    NOT NULL,
  reset_at                     INTEGER NOT NULL,
  observed_credential_revision INTEGER,
  -- 主规格 §6.2 的 limit 与 SQL 保留字冲突，此处列名为 limit_value。
  limit_value                  INTEGER,
  remaining                    INTEGER,
  local_usage_json             TEXT,
  observed_at                  INTEGER,
  backoff_until                INTEGER,
  next_request_at              INTEGER,
  PRIMARY KEY (account_id, resource, reset_at)
);

--------------------------------------------------------------------------------
-- 容量与数量护栏（应用层仍需先在同一短事务内检查并预留，触发器只做并发兜底）
--------------------------------------------------------------------------------
CREATE TRIGGER repositories_capacity
BEFORE INSERT ON repositories
WHEN (SELECT COUNT(*) FROM repositories) >= 999
BEGIN
  SELECT RAISE(ABORT, 'REPOSITORY_LIMIT_REACHED');
END;

CREATE TRIGGER tracked_branches_capacity
BEFORE INSERT ON tracked_branches
WHEN (SELECT COUNT(*) FROM tracked_branches WHERE repo_id = NEW.repo_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'BRANCH_LIMIT_REACHED');
END;

CREATE TRIGGER repository_labels_capacity
BEFORE INSERT ON repository_labels
WHEN (SELECT COUNT(*) FROM repository_labels WHERE repo_id = NEW.repo_id) >= 20
BEGIN
  SELECT RAISE(ABORT, 'LABEL_LIMIT_REACHED');
END;

--------------------------------------------------------------------------------
-- 单例默认行
--------------------------------------------------------------------------------
-- 管理员账号不在此初始化：空库由启动序列建立（admin，随机初始密码只在首次启动日志打印一次）。
INSERT INTO settings (id, default_interval_hours, discovery_enabled, active_discovery_run_id, pins_revision, revision)
VALUES (1, 24, 0, NULL, 1, 1);

INSERT INTO github_credential_status (id) VALUES (1);
INSERT INTO proxy_config (id) VALUES (1);
INSERT INTO runtime_lock (id, owner_id, lease_until, fence) VALUES (1, NULL, 0, 0);
