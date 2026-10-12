import { ERROR_HTTP_STATUS, type ErrorCode } from '@githubradar/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * 错误信封与响应头规则。
 *
 * 成功 `{ data, meta }`，错误 `{ error: { code, message, fields? } }`。
 * 错误里绝不出现 stack、SQL、磁盘路径或上游响应正文。
 */

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fields: Record<string, string> | undefined;
  /** false 表示原始异常只用于内部日志，对外返回通用文案。 */
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, options: { fields?: Record<string, string>; expose?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = options.fields;
    this.expose = options.expose ?? true;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export function validationFailed(fields: Record<string, string>, message = '请求参数校验失败'): AppError {
  return new AppError('VALIDATION_FAILED', message, { fields });
}

export function unauthenticated(message = '需要管理员会话'): AppError {
  return new AppError('UNAUTHENTICATED', message);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; fields?: Record<string, string> };
}

/** 由 Zod 的扁平化错误构造字段级信息，形式稳定便于前端就近展示。 */
export function zodFields(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '_' : issue.path.map((part) => String(part)).join('.');
    if (fields[key] === undefined) fields[key] = issue.message;
  }
  return fields;
}

export function errorEnvelope(error: AppError): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code: error.code, message: error.message } };
  if (error.fields !== undefined) body.error.fields = error.fields;
  return body;
}

/**
 * 解码路径名后再做前缀/路径判定：Fastify 路由按解码后的段匹配，
 * 用原始 URL 判定会让百分号编码变体（如 `/api/v1/%61dmin/...`）命中路由
 * 却绕过 no-store 与 JSON 404 判定，形成未保护别名。
 * 非法百分号序列按原文返回——这类请求不会匹配任何路由。
 */
export function decodePathname(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 所有 auth/admin 响应都 no-store，包括错误、重定向与自动 HEAD。 */
export function isNoStorePath(url: string): boolean {
  const path = decodePathname(url.split('?')[0] ?? '');
  return path.startsWith('/api/v1/admin') || path.startsWith('/api/v1/auth');
}

export function applyNoStore(request: FastifyRequest, reply: FastifyReply): void {
  if (isNoStorePath(request.url)) {
    void reply.header('cache-control', 'no-store');
  }
}
