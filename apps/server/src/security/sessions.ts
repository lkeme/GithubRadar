import { createHmac } from 'node:crypto';
import { and, asc, eq, gt, lt, or } from 'drizzle-orm';

import {
  MAX_ACTIVE_SESSIONS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_REMEMBER_ME_MS,
} from '@githubradar/contracts';

import type { Database } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { deriveSubKey } from './secrets.js';
import { constantTimeEqual, randomToken, sha256Hex } from './tokens.js';

/**
 * 管理会话。
 *
 * - 数据库只保存 token 的 SHA256 摘要与会话绑定的 CSRF nonce。
 * - CSRF token 由服务端密钥 + 会话 nonce 派生，`/auth/session` 可重取，
 *   但绝不可能从不可逆的哈希反推。
 * - 普通会话空闲 12 小时、绝对 24 小时；记住我自登录起绝对 30 天，不套用空闲淘汰。
 */

export const SESSION_COOKIE_NAME = 'gr_session';

/** CSRF 只从这个专用请求头读取，不接受 URL 参数或跨会话 token，也不记录该 header。 */
export const CSRF_TOKEN_HEADER = 'x-csrf-token';

export interface SessionRow {
  readonly id: number;
  readonly authVersion: number;
  readonly csrfNonce: string;
  readonly rememberMe: boolean;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

export interface CreatedSession {
  readonly id: number;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly rememberMe: boolean;
}

export type SessionValidity = 'ok' | 'unknown' | 'expired' | 'stale_auth';

export function csrfTokenFor(appKey: Buffer, session: Pick<SessionRow, 'id' | 'csrfNonce'>): string {
  const key = deriveSubKey(appKey, 'csrf');
  return createHmac('sha256', key).update(`${session.id}.${session.csrfNonce}`).digest('base64url');
}

export function verifyCsrfToken(
  appKey: Buffer,
  session: Pick<SessionRow, 'id' | 'csrfNonce'>,
  candidate: string | undefined,
): boolean {
  if (candidate === undefined || candidate === '') return false;
  return constantTimeEqual(csrfTokenFor(appKey, session), candidate);
}

function absoluteLifetimeMs(rememberMe: boolean): number {
  return rememberMe ? SESSION_REMEMBER_ME_MS : SESSION_ABSOLUTE_MS;
}

export function createSession(
  db: Database,
  appKey: Buffer,
  options: { authVersion: number; rememberMe: boolean; now: number },
): CreatedSession {
  const token = randomToken(32);
  const csrfNonce = randomToken(18);
  const expiresAt = options.now + absoluteLifetimeMs(options.rememberMe);

  // 会话最多 5 个，新增时撤销最旧者。名额只统计"仍然活着"的会话：
  // 已过期与普通会话空闲满 12 小时的行都已被 checkSession 判定失效，只是等清理，
  // 让它们继续占名额会把新登录挤掉（撤销的是早就不可用的行，等于名额被白白占用）。
  const idleCutoff = options.now - SESSION_IDLE_MS;
  const live = db
    .select({ id: sessions.id, rememberMe: sessions.rememberMe, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(gt(sessions.expiresAt, options.now))
    .orderBy(asc(sessions.createdAt), asc(sessions.id))
    .all()
    .filter((row) => row.rememberMe || row.lastSeenAt > idleCutoff);
  const overflow = live.length - (MAX_ACTIVE_SESSIONS - 1);
  for (let index = 0; index < overflow; index += 1) {
    const row = live[index];
    if (row !== undefined) {
      db.delete(sessions).where(eq(sessions.id, row.id)).run();
    }
  }

  const inserted = db
    .insert(sessions)
    .values({
      tokenHash: sha256Hex(token),
      authVersion: options.authVersion,
      csrfNonce,
      rememberMe: options.rememberMe,
      createdAt: options.now,
      lastSeenAt: options.now,
      expiresAt,
    })
    .returning({ id: sessions.id })
    .all();

  const id = inserted[0]?.id;
  if (id === undefined) {
    throw new Error('创建会话失败');
  }

  const session: SessionRow = {
    id,
    authVersion: options.authVersion,
    csrfNonce,
    rememberMe: options.rememberMe,
    createdAt: options.now,
    lastSeenAt: options.now,
    expiresAt,
  };
  return { id, token, csrfToken: csrfTokenFor(appKey, session), expiresAt, rememberMe: options.rememberMe };
}

export function findSessionByToken(db: Database, token: string): (SessionRow & { tokenHash: string }) | null {
  if (token === '') return null;
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(token))).get();
  if (row === undefined) return null;
  return {
    id: row.id,
    authVersion: row.authVersion,
    csrfNonce: row.csrfNonce,
    rememberMe: row.rememberMe,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    tokenHash: row.tokenHash,
  };
}

/**
 * 服务端每个管理请求都重新判定会话；过期会话绝不复活。
 * `currentAuthVersion` 来自 admin_account，密码变更后旧会话立即失效。
 */
export function checkSession(
  session: SessionRow,
  currentAuthVersion: number,
  now: number,
): SessionValidity {
  if (session.authVersion !== currentAuthVersion) return 'stale_auth';
  if (now >= session.expiresAt) return 'expired';
  if (!session.rememberMe && now >= session.lastSeenAt + SESSION_IDLE_MS) return 'expired';
  return 'ok';
}

export function revokeSession(db: Database, id: number): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function touchSession(db: Database, id: number, now: number): void {
  db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();
}

/**
 * 清理到期与空闲超时的会话；过期的候选操作会通过外键级联一并失效。
 * 空闲条件与 checkSession 同一判据：普通会话（非记住我）空闲满 SESSION_IDLE_MS 即失效，
 * 不能只等到期时间——否则"已失效但仍占名额"的行要留到绝对期限才消失。
 */
export function purgeExpiredSessions(db: Database, now: number): number {
  const removed = db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, now + 1),
        // checkSession 的判据是 now >= lastSeenAt + SESSION_IDLE_MS，这里同样用 +1 把边界对齐。
        and(eq(sessions.rememberMe, false), lt(sessions.lastSeenAt, now - SESSION_IDLE_MS + 1)),
      ),
    )
    .run();
  return removed.changes;
}
