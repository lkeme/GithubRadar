import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import type { SqliteDatabase } from '../db/open.js';

/**
 * 应用主密钥与凭证加密。
 *
 * AES-256-GCM，每次加密随机 nonce，以字段名和 schema 版本作为 AAD，
 * 使同一段密文无法被挪到另一个字段上复用。主密钥由系统自管理：
 * 首次启动生成 32 字节随机值并写入库内 `app_secret` 单行，之后读回同一值，
 * 部署者不再需要准备或挂载密钥文件。
 */

export const APP_KEY_BYTES = 32;
export const APP_KEY_SECRET_NAME = 'app_key';
export const SECRET_SCHEMA_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

export class AppKeyError extends Error {
  readonly code = 'APP_KEY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AppKeyError';
  }
}

/**
 * 读取或首次生成主密钥。
 *
 * 已存在但长度异常时抛出明确错误，绝不自动替换——换掉密钥会让全部已存凭证不可解密，
 * 这是需要人工介入的状态，不能静默继续。
 */
export function loadOrCreateAppKey(client: SqliteDatabase, now: () => number = Date.now): Buffer {
  const read = (): Buffer | null => {
    const row = client.prepare('SELECT value FROM app_secret WHERE name = ?').get(APP_KEY_SECRET_NAME) as
      | { value: Buffer }
      | undefined;
    if (row === undefined) return null;
    const value = Buffer.from(row.value);
    if (value.length !== APP_KEY_BYTES) {
      throw new AppKeyError(`应用主密钥长度异常：库内为 ${value.length} 字节，期望 ${APP_KEY_BYTES} 字节`);
    }
    return value;
  };

  const existing = read();
  if (existing !== null) return existing;

  const generated = randomBytes(APP_KEY_BYTES);
  client
    .prepare('INSERT OR IGNORE INTO app_secret (name, value, created_at) VALUES (?, ?, ?)')
    .run(APP_KEY_SECRET_NAME, generated, now());
  // 并发或历史数据导致的竞态一概以库内值为准，不做“最后一次写入获胜”。
  const stored = read();
  if (stored === null) {
    throw new AppKeyError('应用主密钥写入失败');
  }
  return stored;
}

/** 从主密钥派生独立的子密钥，避免同一密钥材料被不同用途复用。 */
export function deriveSubKey(appKey: Buffer, purpose: string): Buffer {
  return createHmac('sha256', appKey).update(`githubradar:${purpose}:v${SECRET_SCHEMA_VERSION}`).digest();
}

export interface EncryptedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

function aadFor(fieldName: string): Buffer {
  return Buffer.from(`${fieldName}:v${SECRET_SCHEMA_VERSION}`, 'utf8');
}

export function encryptSecret(appKey: Buffer, fieldName: string, plaintext: string): EncryptedSecret {
  const key = deriveSubKey(appKey, `secret:${fieldName}`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aadFor(fieldName));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: SECRET_SCHEMA_VERSION };
}

export class SecretDecryptError extends Error {
  readonly code = 'SECRET_DECRYPT_FAILED';
  constructor(fieldName: string) {
    super(`凭证解密失败（${fieldName}）；主密钥可能已更换`);
    this.name = 'SecretDecryptError';
  }
}

export function decryptSecret(appKey: Buffer, fieldName: string, secret: EncryptedSecret): string {
  const key = deriveSubKey(appKey, `secret:${fieldName}`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, secret.nonce);
    decipher.setAAD(aadFor(fieldName));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError(fieldName);
  }
}
