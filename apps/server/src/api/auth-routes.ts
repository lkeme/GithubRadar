import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';

import { LoginRequest, PasswordChangeRequest, type SessionResponse } from '@githubradar/contracts';

import { adminAccount, sessions } from '../db/schema.js';
import { AppError, isAppError, unauthenticated } from '../http/errors.js';
import { registerRoute, type RoutePolicyGuard } from '../http/policy.js';
import { readSessionCookie } from '../http/policy.js';
import type { RouteContext } from '../http/route-context.js';
import {
  SESSION_COOKIE_NAME,
  checkSession,
  createSession,
  csrfTokenFor,
  findSessionByToken,
  purgeExpiredSessions,
  revokeSession,
  touchSession,
} from '../security/sessions.js';
import { assertPasswordPolicy, hashPassword, verifyAgainstDummy, verifyPassword } from '../security/passwords.js';
import { parseBody } from './validation.js';

/**
 * 登录与会话。
 *
 * 登录自身也防跨站：精确 Origin 与 application/json 由策略层强制。
 * 未知用户名同样执行等成本验证并返回统一失败信息，不泄露账号是否存在。
 */

export function registerAuthRoutes(app: FastifyInstance, guard: RoutePolicyGuard, context: RouteContext): void {
  const sessionPolicy = { access: 'session_read', tokenGate: 'exempt', tokenGateExemptReason: 'session_lifecycle' } as const;
  const lifecyclePolicy = { access: 'admin_write', tokenGate: 'exempt', tokenGateExemptReason: 'session_lifecycle' } as const;

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/auth/login',
    policy: { access: 'login', tokenGate: 'exempt', tokenGateExemptReason: 'session_lifecycle' },
    // 登录默认每 IP 5 次/分钟（可用 AUTH_LOGIN_RATE_LIMIT 调整）。
    rateLimit: { max: context.config.loginRateLimitMax, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      const body = parseBody(request, LoginRequest);
      const account = context.db.select().from(adminAccount).where(eq(adminAccount.id, 1)).get();
      if (account === undefined) {
        throw new AppError('SERVICE_UNAVAILABLE', '部署尚未完成管理员初始化');
      }
      const passwordOk =
        account.username === body.username
          ? await verifyPassword(body.password, account.passwordHash)
          : await verifyAgainstDummy(body.password, account.passwordHash);

      if (account.username !== body.username || !passwordOk) {
        throw new AppError('UNAUTHENTICATED', '用户名或密码不正确');
      }

      // 等价成本验证期间账号可能被并发修改（改密/CLI 重置）：用当前哈希复核，
      // 旧密码不能在改密后换取新会话；复核通过则以新的 auth_version 建会话。
      let authVersion = account.authVersion;
      if (account.authVersion !== context.authVersion()) {
        const fresh = context.db.select().from(adminAccount).where(eq(adminAccount.id, 1)).get();
        if (
          fresh === undefined ||
          fresh.username !== body.username ||
          !(await verifyPassword(body.password, fresh.passwordHash))
        ) {
          throw new AppError('UNAUTHENTICATED', '用户名或密码不正确');
        }
        authVersion = fresh.authVersion;
      }

      // 读取随请求携带的旧会话 Cookie 必须在创建新会话**之前**，
      // 登录场景对"同名 Cookie 出现多次"按未携带旧会话处理：重复 Cookie 让登录直接 403
      // 会与"新会话已经落库"叠加成孤儿会话（认证路径上同类请求仍按 403 拒绝，语义不变）。
      let carriedToken: string | null = null;
      try {
        carriedToken = readSessionCookie(request);
      } catch (error) {
        // readSessionCookie 只会在重复同名 Cookie 时抛 FORBIDDEN，这里是唯一的放行点。
        if (!isAppError(error) || error.code !== 'FORBIDDEN') throw error;
      }

      purgeExpiredSessions(context.db, context.now());
      const created = createSession(context.db, context.appKey, {
        authVersion,
        rememberMe: body.rememberMe,
        now: context.now(),
      });
      // 成功登录轮换请求携带的旧会话：曾被植入/窃取的旧 Cookie
      // 不得在重新登录后继续有效，最长可再存活 12 小时空闲/24 小时/30 天。
      if (carriedToken !== null && carriedToken !== '') {
        const carried = findSessionByToken(context.db, carriedToken);
        if (carried !== null && carried.id !== created.id) {
          revokeSession(context.db, carried.id);
        }
      }
      setSessionCookie(context, reply, created.token, created.rememberMe, created.expiresAt);
      // 登录成功也要如实回报当前门禁状态，否则前端的"业务尚未解锁"提示要等下一次会话刷新才出现。
      sendSession(reply, true, created.csrfToken, created.expiresAt, created.rememberMe, !context.gate.isReady());
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/api/v1/auth/session',
    policy: sessionPolicy,
    handler: async (request, reply) => {
      const session = request.session;
      const setupRequired = !context.gate.isReady();
      if (session === undefined) {
        sendSession(reply, false, null, null, false, setupRequired);
        return;
      }
      if (checkSession(session, context.authVersion(), context.now()) !== 'ok') {
        // 过期会话不复活：不更新 last_seen_at，也不复活 Cookie。
        revokeSession(context.db, session.id);
        sendSession(reply, false, null, null, false, setupRequired);
        return;
      }
      sendSession(
        reply,
        true,
        csrfTokenFor(context.appKey, session),
        session.expiresAt,
        session.rememberMe,
        setupRequired,
      );
    },
  });

  // 受保护的活跃心跳：只有浏览器可见且近期有用户输入时才发；公开轮询不续期。
  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/auth/activity',
    policy: lifecyclePolicy,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw unauthenticated();
      touchSession(context.db, session.id, context.now());
      void reply.status(204).send();
    },
  });

  registerRoute(app, guard, {
    method: 'POST',
    url: '/api/v1/auth/logout',
    policy: lifecyclePolicy,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw unauthenticated();
      // 只撤销当前会话；已接受的普通采集继续，未激活的凭证候选随会话级联取消。
      revokeSession(context.db, session.id);
      clearSessionCookie(context, reply);
      void reply.status(204).send();
    },
  });

  registerRoute(app, guard, {
    method: 'PUT',
    url: '/api/v1/admin/password',
    policy: lifecyclePolicy,
    handler: async (request, reply) => {
      const session = request.session;
      if (session === undefined) throw unauthenticated();
      const body = parseBody(request, PasswordChangeRequest);
      const account = context.db.select().from(adminAccount).where(eq(adminAccount.id, 1)).get();
      if (account === undefined) throw new AppError('SERVICE_UNAVAILABLE', '管理员账号未初始化');

      // 在耗时哈希之前记录 auth_version，最终事务再校验，避免并发改密都成功。
      const beforeVersion = account.authVersion;
      if (session.authVersion !== beforeVersion) {
        throw new AppError('UNAUTHENTICATED', '会话已失效，请重新登录');
      }
      if (!(await verifyPassword(body.currentPassword, account.passwordHash))) {
        throw new AppError('FORBIDDEN', '原密码不正确');
      }
      assertPasswordPolicy(body.newPassword);
      const newHash = await hashPassword(body.newPassword);
      const now = context.now();

      const commit = context.db.$client.transaction(() => {
        const fresh = context.db.$client
          .prepare('SELECT auth_version FROM admin_account WHERE id = 1')
          .get() as { auth_version: number };
        if (fresh.auth_version !== beforeVersion) {
          throw new AppError('REVISION_CONFLICT', '密码已被其他请求修改');
        }
        // 耗时哈希期间会话可能已被撤销（logout/改密/过期）：最终事务必须复核
        // 发起会话仍然存在且未失效，“撤销先提交则后续写拒绝”。
        const freshSession = context.db.select().from(sessions).where(eq(sessions.id, session.id)).get();
        if (
          freshSession === undefined ||
          freshSession.authVersion !== beforeVersion ||
          checkSession(freshSession, fresh.auth_version, context.now()) !== 'ok'
        ) {
          throw new AppError('UNAUTHENTICATED', '会话已失效，请重新登录');
        }
        context.db.$client
          .prepare(
            'UPDATE admin_account SET password_hash = ?, auth_version = auth_version + 1, password_changed_at = ? WHERE id = 1',
          )
          .run(newHash, now);
        // 修改密码原子递增 auth_version 并撤销全部会话与未激活凭证操作。
        context.db.delete(sessions).run();
      });
      commit();
      clearSessionCookie(context, reply);
      void reply.status(204).send();
    },
  });
}

function sendSession(
  reply: FastifyReply,
  authenticated: boolean,
  csrfToken: string | null,
  expiresAt: number | null,
  rememberMe: boolean,
  setupRequired = false,
): void {
  const payload: SessionResponse = {
    data: {
      authenticated,
      csrfToken,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      rememberMe,
      setupRequired,
    },
    meta: {},
  };
  void reply.status(200).send(payload);
}

function setSessionCookie(
  context: RouteContext,
  reply: FastifyReply,
  token: string,
  rememberMe: boolean,
  expiresAt: number,
): void {
  const secure = context.config.publicOrigin.cookieSecure;
  if (rememberMe) {
    // 记住我：持久 Cookie，与服务端一致地绝对 30 天过期，不因轮询顺延。
    void reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure,
      maxAge: Math.max(1, Math.floor((expiresAt - context.now()) / 1000)),
    });
    return;
  }
  // 默认记住我不勾选：无 Max-Age 的会话 Cookie。
  void reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
  });
}

function clearSessionCookie(context: RouteContext, reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: context.config.publicOrigin.cookieSecure,
  });
}
