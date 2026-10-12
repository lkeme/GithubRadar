/**
 * 前端本地数值常量：契约只能类型导入（运行时导入会把 zod 打进 bundle），
 * 所以数值在这里复制一份，必须与 `packages/contracts/src/limits.ts` 保持一致。
 */

export const REPOSITORY_LIMIT = 999;
export const MAX_BRANCHES_PER_REPO = 20;
export const MAX_LABELS_PER_REPO = 20;
export const MAX_IMPORT_ROWS = 999;
export const MAX_IMPORT_INPUT_CHARS = MAX_IMPORT_ROWS * 256; // 契约同一上限
export const PAGE_SIZE = 30; // PAGE_SIZE_DEFAULT
export const PAGE_SIZE_MAX = 100; // PAGE_SIZE_MAX
export const SEARCH_MAX_LENGTH = 100;
export const INTERVAL_OPTIONS = [3, 6, 12, 24] as const;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_LABEL_NAME_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 16;
export const PASSWORD_ALLOWED_SYMBOLS = '!@#$%^&*';

/** 未来超出 5 分钟容差的源时间显示“时间异常”。 */
export const CLOCK_ANOMALY_TOLERANCE_MS = 5 * 60 * 1000;

/** 公开查询 staleTime 60 秒，可见时每 60 秒刷新。 */
export const PUBLIC_STALE_MS = 60 * 1000;
export const PUBLIC_REFRESH_MS = 60 * 1000;

/** 存在进行中任务时每 3 秒合并轮询一次。 */
export const ACTIVE_JOB_POLL_MS = 3000;

/** 默认展示近 30 天，选项 7/30/90/365。 */
export const TREND_RANGE_OPTIONS = [7, 30, 90, 365] as const;
export const DEFAULT_TREND_RANGE = 30;

/** 到期前 7 天/1 天在状态卡提示。 */
export const EXPIRY_WARN_DAYS = 7;
export const EXPIRY_URGENT_DAYS = 1;

/** 本地 UI 缓存的 key 前缀；只允许主题偏好与视图偏好。 */
export const STORAGE_PREFIX = 'githubradar:';
export const STORAGE_THEME_KEY = 'theme';
export const STORAGE_VIEW_KEY = 'view';
export const STORAGE_TREND_RANGE_KEY = 'trendRange';
