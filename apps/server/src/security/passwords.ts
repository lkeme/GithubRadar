import { scrypt as scryptCallback, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import {
  PASSWORD_ALLOWED_SYMBOLS,
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  passwordPolicyViolation,
} from '@githubradar/contracts';
import { promisify } from 'node:util';

import { validationFailed } from '../http/errors.js';

/**
 * 管理员密码哈希。
 *
 * 异步 scrypt + 每密码随机盐；显式设置足够大的 maxmem，不依赖可能低于参数需要的默认上限。
 * 参数与算法版本一起写进哈希串。验证时按**哈希串里记录的参数**派生（而不是模块常量），
 * 因此后续提升参数只会影响新哈希，既有账号仍按各自记录的成本校验。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 3 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 128 * 1024 * 1024;
/** scrypt 单次派发允许申请的内存上限：参数异常放大时不让进程真的去申请巨量内存。 */
const MAXMEM_CAP = 1024 * 1024 * 1024;
/** 解析哈希串时的参数上限（2^22 / 1024 / 256 量级）：手工注入的异常参数不能驱动派生。 */
const PARAM_LIMITS = { N: 2 ** 22, r: 1024, p: 256 } as const;
const ALGORITHM = 'scrypt';
const SCHEMA_VERSION = 1;

/** 密码计算并发上限 2，超出排队，避免登录请求耗尽线程池。 */
const MAX_CONCURRENT = 2;

/**
 * 密码策略与契约共用同一实现（`packages/contracts/src/network.ts`）：
 * 8–16 个字符、只允许字母数字与 `!@#$%^&*`，且必须同时包含大写、小写与数字。
 * 登录不套用强度规则（只验证既有密码），修改密码与哈希入口套用。
 * 代理密码是外部系统的凭据，不受本策略约束（契约里单独限制长度）。
 *
 * 违规按边界校验处理：抛 `VALIDATION_FAILED`（fields.newPassword 带具体说明），
 * 与其余参数错误同一种信封，而不是逃逸成 500。
 */
export { PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS };

export function assertPasswordPolicy(password: string): void {
  const violation = passwordPolicyViolation(password);
  if (violation !== null) {
    throw validationFailed({ newPassword: violation });
  }
}

/** 字符池：大写、小写、数字、符号各取一段，随机取位使用 randomInt 保证均匀分布。 */
const PASSWORD_CLASS_POOLS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  PASSWORD_ALLOWED_SYMBOLS,
] as const;

function pick(pool: string): string {
  return pool[randomInt(pool.length)] as string;
}

/**
 * 生成满足密码策略的随机密码（初始管理员密码、本地密码重置使用）。
 * 长度钳制在策略区间内（默认取上限 16）；先各取一个字符保证类别覆盖，
 * 再用全字符池填充，最后洗牌——避免类别字符固定出现在前几位。
 */
export function generatePassword(length = PASSWORD_MAX_CHARS): string {
  // 下限取策略最小值（8）而不是类别数（4）：生成结果必须总是通过策略校验。
  const size = Math.min(Math.max(PASSWORD_MIN_CHARS, length), PASSWORD_MAX_CHARS);
  const chars: string[] = PASSWORD_CLASS_POOLS.map((pool) => pick(pool));
  const all = PASSWORD_CLASS_POOLS.join('');
  while (chars.length < size) {
    chars.push(pick(all));
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const current = chars[index] as string;
    chars[index] = chars[swap] as string;
    chars[swap] = current;
  }
  return chars.join('');
}

let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiting.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active -= 1;
  const next = waiting.shift();
  if (next !== undefined) next();
}

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * scrypt 至少需要 128·N·r 字节内存；maxmem 随 N 缩放并留 2 倍余量，封顶 1 GiB。
 * 初始参数（N=32768、r=8）下结果仍是 128 MiB，保持原有语义。
 */
function maxmemFor(N: number, r: number): number {
  return Math.min(Math.max(MAXMEM, 128 * N * r * 2), MAXMEM_CAP);
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  await acquireSlot();
  try {
    return await scrypt(password, salt, KEY_LENGTH, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: maxmemFor(params.N, params.r),
    });
  } finally {
    releaseSlot();
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, SCRYPT_PARAMS);
  return [
    ALGORITHM,
    SCHEMA_VERSION,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly derived: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 7) return null;
  const [algorithm, version, n, r, p, salt, derived] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM || version !== String(SCHEMA_VERSION)) return null;
  const N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  // N 必须是 2 的幂；三个参数都要在可接受的量级内。解析出的参数会真的用于派生，
  // 手工构造的异常哈希串（例如 N=2^30）必须在这里被挡掉，不能让它去申请内存后抛错。
  if (!Number.isInteger(N) || N < 2 || N > PARAM_LIMITS.N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(rr) || rr < 1 || rr > PARAM_LIMITS.r) return null;
  if (!Number.isInteger(pp) || pp < 1 || pp > PARAM_LIMITS.p) return null;
  return { params: { N, r: rr, p: pp }, salt: Buffer.from(salt, 'base64'), derived: Buffer.from(derived, 'base64') };
}

/**
 * 未知用户名也执行等成本验证，避免用响应时间枚举账号。
 * 该函数在哈希串不可解析时同样返回 false，不抛异常。
 * 派生成本按哈希串里记录的参数执行：提升 SCRYPT_PARAMS 不会让旧密码验证失败。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;
  let derived: Buffer;
  try {
    derived = await derive(password, parsed.salt, parsed.params);
  } catch {
    // 参数虽在界内但超出可分配范围等派生异常一律按验证失败处理，
    // 登录与改密路径不能因此变成 500。
    return false;
  }
  if (derived.length !== parsed.derived.length) return false;
  return timingSafeEqual(derived, parsed.derived);
}

/** 账号不存在时使用：制造与真实校验相同的计算成本，然后一律返回 false。 */
export async function verifyAgainstDummy(password: string, dummyHash: string): Promise<false> {
  await verifyPassword(password, dummyHash);
  return false;
}
