/**
 * 全项目反复出现的硬性数值边界，服务端校验、数据库触发器与契约共用同一组常量，
 * 避免同一上限在 SQL、API 和前端各写一遍后漂移。
 */

/** 数据库中仓库记录最多 999 条，含暂停与待初始化占位。 */
export const REPOSITORY_LIMIT = 999;

/** 每仓 20 个唯一有效分支（含默认分支），属容量护栏。 */
export const MAX_BRANCHES_PER_REPO = 20;

/** 字段边界：每仓最多 20 个标签。 */
export const MAX_LABELS_PER_REPO = 20;

/** 字段边界。 */
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LABEL_NAME_LENGTH = 32;
export const MAX_BRANCH_NAME_BYTES = 1024;

/** 批量管理读写一次最多 100 个 ID。 */
export const MAX_BATCH_IDS = 100;

/** 单次批量导入最多 999 行、请求体最大 256 KiB。 */
export const MAX_IMPORT_ROWS = 999;
export const MAX_IMPORT_BODY_BYTES = 256 * 1024;

/**
 * 导入输入框的字符上限（契约校验与前端提示共用同一数值）。
 * 按每行 256 字符推导：`MAX_IMPORT_ROWS × 256 = 255,744`，纯 ASCII 下低于
 * `MAX_IMPORT_BODY_BYTES`（256 KiB = 262,144 字节）的请求体预算，
 * 避免出现「契约放行、bodyLimit 必拒」的矛盾。
 */
export const MAX_IMPORT_INPUT_CHARS = MAX_IMPORT_ROWS * 256;

/** 分页与搜索上限。 */
export const PAGE_SIZE_DEFAULT = 30;
export const PAGE_SIZE_MAX = 100;
export const SEARCH_MAX_LENGTH = 100;

/**
 * 管理员密码 8–16 个字符。
 * 必含大写字母、小写字母与数字；特殊字符可选，且只允许 `PASSWORD_ALLOWED_SYMBOLS` 中的这几个
 * （其余字符一律拒绝，避免出现无法在部分终端输入的符号）。代理密码是外部系统的凭据，不套用本策略。
 */
export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_CHARS = 16;
export const PASSWORD_ALLOWED_SYMBOLS = '!@#$%^&*';

/** 默认 24 小时，档位 3/6/12/24。 */
export const INTERVAL_OPTIONS = [3, 6, 12, 24] as const;
export const DEFAULT_INTERVAL_HOURS = 24;
export type IntervalHours = (typeof INTERVAL_OPTIONS)[number];

/** 预发布只读取发布列表前 20 条。 */
export const PRERELEASE_WINDOW_LIMIT = 20;

/** 变化标记保留 7 天，再次变化重新计时。 */
export const CHANGE_WINDOW_DAYS = 7;

/** 会话期限。 */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const SESSION_REMEMBER_ME_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS = 5;

/** 任务租约与请求超时。 */
export const JOB_LEASE_MS = 120 * 1000;
export const JOB_LEASE_RENEW_MS = 30 * 1000;
export const REQUEST_TIMEOUT_MS = 20 * 1000;

/** 不访问的缓存 30 天清理；趋势保留 365 天、诊断 30 天。 */
export const HTTP_CACHE_RETENTION_DAYS = 30;
export const DAILY_METRICS_RETENTION_DAYS = 365;
export const DIAGNOSTICS_RETENTION_DAYS = 30;
export const COMPLETED_JOB_CAPACITY = 100_000;
