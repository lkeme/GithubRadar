import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AppError, zodFields } from '../http/errors.js';

/**
 * 边界校验。
 *
 * 契约就是 Zod schema：这里直接用它解析，不额外手写一套 JSON Schema，
 * 避免出现两份不一致的契约。未知字段、重复键与类型错误一律 400。
 */

export function parseBody<T extends z.ZodType>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '请求体校验失败', { fields: zodFields(result.error.issues) });
  }
  return result.data;
}

export function parseQuery<T extends z.ZodType>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '查询参数校验失败', { fields: zodFields(result.error.issues) });
  }
  return result.data;
}

export function parseParams<T extends z.ZodType>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.params);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', '路径参数校验失败', { fields: zodFields(result.error.issues) });
  }
  return result.data;
}

/** If-Match 携带版本号；缺版本 428。 */
export function parseIfMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') {
    throw new AppError('REVISION_REQUIRED', '缺少 If-Match 版本号');
  }
  const trimmed = value.replace(/^W\//, '').replace(/^"|"$/g, '');
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('VALIDATION_FAILED', 'If-Match 必须是正整数版本号');
  }
  return parsed;
}
