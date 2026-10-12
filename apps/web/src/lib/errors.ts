import type { ErrorCode } from '@githubradar/contracts';

/**
 * 错误处理：
 * - 展示服务器清洗后的 message 或本地错误码说明；不打印、不展示内部错误原文、堆栈与磁盘路径。
 * - 只做类型导入契约，错误码说明在本地按错误码清单维护。
 */

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN_ERROR';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly fields: Record<string, string> | undefined;

  constructor(message: string, code: ApiErrorCode, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

/** 认证状态已变化（epoch 不匹配）时抛出：调用方必须静默丢弃，不写缓存、不提示成功。 */
export class StaleAuthError extends Error {
  constructor() {
    super('认证状态已变化，迟到的响应已丢弃');
    this.name = 'StaleAuthError';
  }
}

export const ERROR_CODE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '输入校验失败，请检查填写内容',
  UNAUTHENTICATED: '登录状态已失效，请重新登录',
  FORBIDDEN: '没有执行该操作的权限',
  CSRF_REJECTED: '会话校验失败，请刷新页面后重试',
  UNSUPPORTED_MEDIA_TYPE: '请求格式不被支持，请刷新页面后重试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  NOT_FOUND: '请求的对象不存在',
  REVISION_CONFLICT: '配置已被其他操作更新，请刷新后重试',
  REVISION_REQUIRED: '缺少版本信息，请刷新后重试',
  REPOSITORY_LIMIT_REACHED: '已达到仓库数量上限（999 条）',
  REPOSITORY_ALREADY_EXISTS: '该仓库已在监控列表中',
  REPOSITORY_IDENTITY_CHANGED: '仓库身份与原记录不一致，相关检测已暂停',
  BRANCH_LIMIT_REACHED: '已达到每仓分支上限（20 个）',
  LABEL_LIMIT_REACHED: '已达到每仓标签上限（20 个）',
  LABEL_IN_USE: '标签仍被仓库使用，需先解除关联再删除',
  IMPORT_EXPIRED: '导入批次已过期，请重新提交',
  SOURCE_DATA_ANOMALY: '来源数据异常，继续展示上一代数据',
  GITHUB_TOKEN_REQUIRED: '尚未配置 GitHub Token，请先在系统设置完成验证',
  GITHUB_TOKEN_INVALID: 'GitHub Token 无效或已被撤销',
  GITHUB_ACCESS_DENIED_OR_MISSING: '无权访问该仓库，或仓库不存在',
  GITHUB_RATE_LIMITED: '已触发 GitHub 配额限制，任务将延后重试',
  GITHUB_SETUP_REQUIRED: '业务尚未解锁，请先在系统设置完成 Token 验证',
  PROXY_UNREACHABLE: '代理不可达，请检查代理配置',
  UPSTREAM_SCHEMA_CHANGED: '上游返回结构异常，已保留旧数据',
  FEATURE_DISABLED: '该功能当前已关闭',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试',
  INTERNAL_ERROR: '服务内部错误，请稍后重试',
};

const KNOWN_CODES = new Set<string>(Object.keys(ERROR_CODE_MESSAGES));

/**
 * 领域内部错误码（任务停止原因、导入行原因、令牌元数据等）：
 * 不属于接口级错误码清单（ErrorCode），但会在任务行与导入结果里原样下发，因此也要有中文文案。
 */
const INTERNAL_CODE_MESSAGES: Readonly<Record<string, string>> = {
  LATEST_NOT_FOUND: '官方 latest 不可用',
  STREAM_MISSING: '采集流不可用',
  STREAM_UNAVAILABLE: '采集流不可用',
  LEASE_LOST: '任务租约失效',
  REPOSITORY_DELETED: '仓库已删除',
  REPOSITORY_MISSING: '仓库不存在',
  REPOSITORY_NOT_READY: '仓库未就绪',
  TOKEN_METADATA_CONFLICT: '令牌元数据冲突',
  // 导入行输入解析原因（与服务端 domain/input.ts 的 InputParseError 一一对应）。
  EMPTY: '空行',
  INVALID_FORMAT: '格式错误',
  SUB_PATH: '不是仓库根路径',
  USERINFO: '含用户信息',
  BAD_HOST: '非 GitHub 地址',
  BAD_PORT: '非标准端口',
  ENCODED_SLASH: '路径含编码斜杠',
};

export function isKnownErrorCode(code: string): code is ErrorCode {
  return KNOWN_CODES.has(code);
}

/**
 * 按错误码取展示文案：接口级错误码用本地说明，内部码用领域文案；
 * 未知码给兜底文案并保留原始码（不静默丢弃，便于排查）。
 */
export function errorCodeMessage(code: string): string {
  if (isKnownErrorCode(code)) {
    return ERROR_CODE_MESSAGES[code];
  }
  return INTERNAL_CODE_MESSAGES[code] ?? `未知错误（${code}）`;
}

/** 面向用户的错误文案：优先使用本地错误码说明（避免泄露上游细节），其次服务器 message。 */
export function errorMessage(error: unknown): string {
  if (error instanceof StaleAuthError) {
    return '认证状态已变化，操作结果已忽略';
  }
  if (error instanceof ApiError) {
    if (isKnownErrorCode(error.code)) {
      return ERROR_CODE_MESSAGES[error.code];
    }
    return error.message;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return '请求已取消';
  }
  return '操作失败，请稍后重试';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
