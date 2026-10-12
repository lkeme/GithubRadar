/** 调度与预算的共享常量。 */

export const PERIODIC_BUDGET_RATIO = 0.6;
export const RESERVE_BUDGET_RATIO = 0.2;

/** 请求起始间隔下限，防止 W/U 算出过小的值造成突发。 */
export const MIN_REQUEST_INTERVAL_MS = 1000;

/** 次级限流且无明确时间：全局至少等待 60 秒，再指数退避带抖动，最多 1 小时。 */
export const SECONDARY_LIMIT_FLOOR_MS = 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** 5xx / 网络超时：1/5/15 分钟退避，最多 3 次重试（初始尝试 + 3 次重试），然后结束本轮。 */
export const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const;
export const MAX_JOB_RETRIES = 3;

/** 管理发起操作（PAT 验证、候选代理测试）每分钟最多 2 个。 */
export const CONTROL_OPERATIONS_PER_MINUTE = 2;
/** 上述上限的计时窗口。 */
export const CONTROL_OPERATION_WINDOW_MS = 60 * 1000;

/** 手动任务插队：每完成一个手动请求，至少允许三个已到期常规请求。 */
export const MANUAL_FAIRNESS_RATIO = 3;

/** 成功检查后 5 分钟内重复手动检测复用最近结果，不新增请求。 */
export const MANUAL_REUSE_WINDOW_MS = 5 * 60 * 1000;

/** 导入占位最长 24 小时后以“验证超时”结束并释放名额。 */
export const IMPORT_RESERVATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** 候选操作有效期 1 小时。 */
export const PENDING_OPERATION_TTL_MS = 60 * 60 * 1000;

/** 分支选择器缓存 24 小时。 */
export const BRANCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 命令轮询合并：管理任务页快速轮询间隔。 */
export const ACTIVE_JOB_POLL_MS = 3000;

/** 调度器空转唤醒上限，保证配置变化与定时清理仍能被唤醒。 */
export const IDLE_WAKE_MS = 30 * 1000;

/** 单实例调度租约。 */
export const RUNTIME_LOCK_LEASE_MS = 120 * 1000;
export const RUNTIME_LOCK_RENEW_MS = 30 * 1000;

/** 关闭时最多等待在途请求的时间。 */
export const SHUTDOWN_GRACE_MS = 30 * 1000;

/**
 * 凭证新鲜度：连续 48 小时无可信认证成功则关闭业务门禁。
 * 稳态复核为每日一次，这里留出一次漏检余量：定时复核短暂失败不应立刻锁死业务，
 * 真正的失效由业务请求的 401 立即判定（noteBusinessUnauthorized）。
 */
export const AUTH_FRESHNESS_MS = 48 * 60 * 60 * 1000;

/** 复核退避：失败后 1/5/15 分钟，之后每日一次。 */
export const VERIFY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const;
export const VERIFY_STEADY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 到期前 7 天 / 1 天在管理员状态卡提示。 */
export const EXPIRY_WARN_DAYS = [7, 1] as const;
