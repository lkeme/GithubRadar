import { z } from 'zod';

/**
 * API 级错误码（HTTP 状态映射）的唯一来源：服务端、契约测试和前端都从这里取值。
 *
 * 注意：业务对象上的 `errorCode` 字段不止这些。导入行诊断（EMPTY、INVALID_FORMAT、SUB_PATH、
 * USERINFO、BAD_HOST、BAD_PORT、ENCODED_SLASH）、任务/流诊断（STREAM_MISSING、STREAM_UNAVAILABLE、
 * LEASE_LOST、REPOSITORY_DELETED、REPOSITORY_MISSING、REPOSITORY_NOT_READY、LATEST_NOT_FOUND、
 * TOKEN_METADATA_CONFLICT）等内部诊断码以自由字符串形式流入 `ImportItem.errorCode`、jobs 与凭证
 * 状态字段，它们不参与 HTTP 状态映射，因此不列在本表里。
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'REVISION_REQUIRED',
  'REPOSITORY_LIMIT_REACHED',
  'REPOSITORY_ALREADY_EXISTS',
  'REPOSITORY_IDENTITY_CHANGED',
  'BRANCH_LIMIT_REACHED',
  'LABEL_LIMIT_REACHED',
  'LABEL_IN_USE',
  'IMPORT_EXPIRED',
  'SOURCE_DATA_ANOMALY',
  'GITHUB_TOKEN_REQUIRED',
  'GITHUB_TOKEN_INVALID',
  'GITHUB_ACCESS_DENIED_OR_MISSING',
  'GITHUB_RATE_LIMITED',
  'GITHUB_SETUP_REQUIRED',
  'PROXY_UNREACHABLE',
  'UPSTREAM_SCHEMA_CHANGED',
  'FEATURE_DISABLED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 错误码到 HTTP 状态码的映射。
 * 门禁失败统一 409；缺前置版本 428、冲突 409。
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  REVISION_REQUIRED: 428,
  REPOSITORY_LIMIT_REACHED: 409,
  REPOSITORY_ALREADY_EXISTS: 409,
  REPOSITORY_IDENTITY_CHANGED: 409,
  BRANCH_LIMIT_REACHED: 409,
  LABEL_LIMIT_REACHED: 409,
  /** 标签仍被仓库使用：必须先解除关联再删除定义。 */
  LABEL_IN_USE: 409,
  IMPORT_EXPIRED: 410,
  SOURCE_DATA_ANOMALY: 502,
  GITHUB_TOKEN_REQUIRED: 409,
  GITHUB_TOKEN_INVALID: 409,
  GITHUB_ACCESS_DENIED_OR_MISSING: 403,
  GITHUB_RATE_LIMITED: 429,
  GITHUB_SETUP_REQUIRED: 409,
  PROXY_UNREACHABLE: 502,
  UPSTREAM_SCHEMA_CHANGED: 502,
  FEATURE_DISABLED: 404,
  /** 入站限速（登录、公开 API），与本系统对上游客额的 GITHUB_RATE_LIMITED 区分开。 */
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export const ApiError = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const ApiErrorEnvelope = z.strictObject({ error: ApiError });
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelope>;

/**
 * 数据库触发器与迁移脚本使用同一组稳定码（容量触发器示意）。
 * 触发器只允许 ASCII 与下划线，业务层据此映射到上表。
 */
export const DB_CONSTRAINT_CODES = [
  'REPOSITORY_LIMIT_REACHED',
  'BRANCH_LIMIT_REACHED',
  'LABEL_LIMIT_REACHED',
] as const;
export type DbConstraintCode = (typeof DB_CONSTRAINT_CODES)[number];

export function isDbConstraintCode(value: string): value is DbConstraintCode {
  return (DB_CONSTRAINT_CODES as readonly string[]).includes(value);
}
