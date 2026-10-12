import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 会话 token、nonce 与不透明 ID 的生成。 */

/** 至少 256 位随机会话 token，URL 安全编码。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 数据库只保存摘要，绝不保存 token 本身。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 定长十六进制/摘要比较必须走常量时间，避免通过响应时间区分前缀。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
