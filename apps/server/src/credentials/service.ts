import { and, eq, inArray, lt } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { githubCredentialStatus, jobs, pendingOperations, secrets, sessions } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { SessionRow } from '../security/sessions.js';
import { checkSession } from '../security/sessions.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import { AUTH_FRESHNESS_MS, PENDING_OPERATION_TTL_MS, VERIFY_BACKOFF_MS, VERIFY_STEADY_INTERVAL_MS } from '../scheduler/constants.js';
import type { ProxyProbeStage, ProxySettings } from '../integrations/transport/index.js';
import { tokenTypeHint, type UserVerification } from './verify.js';

/**
 * 强制 Token 门禁与凭证修复通路。
 *
 * 关键语义（不要为了“顺手”简化）：
 * - 门禁失败统一 409 `GITHUB_SETUP_REQUIRED`，匿名请求仍先返回 401。
 * - 未就绪只开放修复白名单：会话生命周期、PAT/代理修复、只读诊断、公开只读与健康探针。
 * - 恢复通路不能被自己的业务暂停锁死：业务硬失败（401/403/404）不带 `control` 队列一起停。
 * - GET 状态只读：可以计算 effectiveState，但不在 GET 里写状态或发网络。
 * - 旧凭证 revision 的在途结果不能修改新凭证状态。
 */

export const PAT_SECRET_NAME = 'github_pat';
export const PROXY_PASSWORD_SECRET_NAME = 'proxy_password';

/** 操作进入终态后候选密文不再需要：清成 0 长度 BLOB，候选凭证不会在库里长期可解密。 */
const CLEARED_CANDIDATE = Buffer.alloc(0);

export type CredentialState = 'missing' | 'unverified' | 'valid' | 'invalid' | 'expired';
export type Connectivity = 'unknown' | 'reachable' | 'unavailable';

export interface CredentialStatusView {
  readonly configured: boolean;
  readonly state: CredentialState;
  readonly effectiveState: CredentialState;
  readonly connectivity: Connectivity;
  readonly tokenTypeHint: 'classic' | 'fine_grained' | null;
  readonly lastVerifiedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastAuthenticatedAt: number | null;
  readonly configuredAt: number | null;
  readonly expiresAt: number | null;
  readonly expiresObservedAt: number | null;
  readonly expiresSource: 'reported' | 'unknown';
  readonly classicScopes: string[] | null;
  readonly lastErrorCode: string | null;
  readonly nextVerificationAt: number | null;
  readonly accountId: string | null;
}

export interface ProxyView {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly scheme: ProxySettings['scheme'] | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly usernameConfigured: boolean;
  readonly revision: number;
}

export interface OperationView {
  /** 候选操作为十进制 ID；显式重新验证活动 PAT 为 `job_<id>`。 */
  readonly id: string;
  readonly kind: 'github_token' | 'proxy_test' | 'proxy_apply';
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resultJson: string | null;
}

export interface CredentialServiceDeps {
  readonly db: Database;
  readonly appKey: Buffer;
  readonly now: () => number;
}

interface StatusRow {
  credentialRevision: number;
  gateRevision: number;
  credentialState: CredentialState;
  connectivity: Connectivity;
  tokenTypeHint: 'classic' | 'fine_grained' | null;
  lastAttemptAt: number | null;
  lastVerifiedAt: number | null;
  lastAuthenticatedAt: number | null;
  expiresAt: number | null;
  expiresObservedAt: number | null;
  classicScopesJson: string | null;
  lastErrorCode: string | null;
  configuredAt: number | null;
  accountId: string | null;
  authObservationSeq: number;
  verificationAttemptSeq: number;
  nextVerificationAt: number | null;
}

export interface VerifySnapshot {
  /** 派发前分配的验证序号。 */
  readonly attemptSeq: number;
  readonly credentialRevision: number;
  readonly token: string | null;
  /** 候选操作 id；验证活动凭证时为 null。 */
  readonly operationId: number | null;
  /** 本次派发之前的上一次尝试时间；退避阶梯的锚点。 */
  readonly previousAttemptAt: number | null;
}

export class CredentialService {
  readonly #db: Database;
  readonly #appKey: Buffer;
  readonly #now: () => number;

  constructor(deps: CredentialServiceDeps) {
    this.#db = deps.db;
    this.#appKey = deps.appKey;
    this.#now = deps.now;
  }

  /**
   * 读取单例状态行。
   *
   * 注意：这里用预编译语句取行，返回的是数据库列名（snake_case）。
   * 必须显式映射到 domain 字段，否则 `row.credentialState` 之类的读取会静默变成
   * undefined，把“未配置”误判成“已配置”。类型系统在这里帮不上忙，映射是唯一防线。
   */
  #statusRow(): StatusRow {
    const raw = this.#db.$client
      .prepare(
        `SELECT credential_revision, gate_revision, credential_state, connectivity, token_type_hint,
                last_attempt_at, last_verified_at, last_authenticated_at, expires_at, expires_observed_at,
                classic_scopes_json, last_error_code, configured_at, account_id,
                auth_observation_seq, verification_attempt_seq, next_verification_at
           FROM github_credential_status WHERE id = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (raw === undefined) {
      throw new AppError('SERVICE_UNAVAILABLE', '凭证状态单例行缺失');
    }
    return {
      credentialRevision: Number(raw['credential_revision']),
      gateRevision: Number(raw['gate_revision']),
      credentialState: raw['credential_state'] as CredentialState,
      connectivity: raw['connectivity'] as Connectivity,
      tokenTypeHint: (raw['token_type_hint'] ?? null) as 'classic' | 'fine_grained' | null,
      lastAttemptAt: (raw['last_attempt_at'] ?? null) as number | null,
      lastVerifiedAt: (raw['last_verified_at'] ?? null) as number | null,
      lastAuthenticatedAt: (raw['last_authenticated_at'] ?? null) as number | null,
      expiresAt: (raw['expires_at'] ?? null) as number | null,
      expiresObservedAt: (raw['expires_observed_at'] ?? null) as number | null,
      classicScopesJson: (raw['classic_scopes_json'] ?? null) as string | null,
      lastErrorCode: (raw['last_error_code'] ?? null) as string | null,
      configuredAt: (raw['configured_at'] ?? null) as number | null,
      accountId: (raw['account_id'] ?? null) as string | null,
      authObservationSeq: Number(raw['auth_observation_seq']),
      verificationAttemptSeq: Number(raw['verification_attempt_seq']),
      nextVerificationAt: (raw['next_verification_at'] ?? null) as number | null,
    };
  }

  /**
   * 时间边界在这里计算，不依赖后台定时器落库：
   * 已知可信到期时间到达即 expired；超过认证新鲜度窗口（48 小时）无可信认证成功即 unverified。
   */
  #effectiveState(row: StatusRow, now: number): CredentialState {
    if (row.credentialState === 'valid') {
      if (row.expiresAt !== null && now >= row.expiresAt) return 'expired';
      if (row.lastAuthenticatedAt === null || now - row.lastAuthenticatedAt > AUTH_FRESHNESS_MS) {
        return 'unverified';
      }
      return 'valid';
    }
    return row.credentialState;
  }

  isReady(): boolean {
    return this.#effectiveState(this.#statusRow(), this.#now()) === 'valid';
  }

  assertReady(): void {
    if (!this.isReady()) {
      throw new AppError('GITHUB_SETUP_REQUIRED', 'GitHub Token 未就绪，请先在设置页完成验证');
    }
  }

  status(): CredentialStatusView {
    const row = this.#statusRow();
    const now = this.#now();
    const configured = row.credentialState !== 'missing';
    let scopes: string[] | null = null;
    if (row.classicScopesJson !== null) {
      try {
        const parsed = JSON.parse(row.classicScopesJson) as unknown;
        if (Array.isArray(parsed)) scopes = parsed.filter((value): value is string => typeof value === 'string');
      } catch {
        scopes = null;
      }
    }
    return {
      configured,
      state: row.credentialState,
      effectiveState: this.#effectiveState(row, now),
      connectivity: row.connectivity,
      tokenTypeHint: row.tokenTypeHint,
      lastVerifiedAt: row.lastVerifiedAt,
      lastAttemptAt: row.lastAttemptAt,
      lastAuthenticatedAt: row.lastAuthenticatedAt,
      configuredAt: row.configuredAt,
      expiresAt: row.expiresAt,
      expiresObservedAt: row.expiresObservedAt,
      expiresSource: row.expiresAt === null ? 'unknown' : 'reported',
      classicScopes: scopes,
      lastErrorCode: row.lastErrorCode,
      nextVerificationAt: row.nextVerificationAt,
      accountId: row.accountId,
    };
  }

  credentialRevision(): number {
    return this.#statusRow().credentialRevision;
  }

  /**
   * 启动时的凭证新鲜度处理。
   *
   * 重启后的已有 PAT 先进入 `unverified`：进程内的旧结论不能跨重启继续当证据，
   * 必须由一个控制任务在线验证后才重新解锁业务。这样既避免重启瞬间就全仓采集，
   * 也保证网络不可达时保持锁定而不是"看起来有效"。
   */
  markRestartStale(): boolean {
    const row = this.#statusRow();
    if (row.credentialState !== 'valid') return false;
    this.#db
      .update(githubCredentialStatus)
      .set({
        credentialState: 'unverified',
        connectivity: 'unknown',
        gateRevision: row.gateRevision + 1,
        nextVerificationAt: this.#now(),
      })
      .where(eq(githubCredentialStatus.id, 1))
      .run();
    return true;
  }

  gateRevision(): number {
    return this.#statusRow().gateRevision;
  }

  /**
   * 把下一次在线复核推到 `now + delayMs`（只延后、不提前）。
   *
   * 用于本地凭证不可读（密文缺失或无法解密）这类自愈不了的情况：验证任务必然失败，
   * 而规划器按 `nextVerificationAt <= now` 每个循环都会重新入队——不留退避就会
   * 形成每秒一次的空转，并把 verification_attempt_seq 一直推高。
   * 管理员重新配置凭证时会写入新的复核时间，因此不需要在这里安排"更早恢复"。
   */
  deferNextVerification(delayMs: number): void {
    const row = this.#statusRow();
    const target = this.#now() + delayMs;
    if (row.nextVerificationAt !== null && row.nextVerificationAt >= target) return;
    this.#db
      .update(githubCredentialStatus)
      .set({ nextVerificationAt: target })
      .where(eq(githubCredentialStatus.id, 1))
      .run();
  }

  /** 业务采集读取活动凭证；只在需要出站时调用，不进入任何缓存或日志。 */
  readActiveToken(): string | null {
    const row = this.#db.select().from(secrets).where(eq(secrets.name, PAT_SECRET_NAME)).get();
    if (row === undefined) return null;
    try {
      return decryptSecret(this.#appKey, PAT_SECRET_NAME, {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      });
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 候选操作

  #cancelStaleOperations(kind: 'github_token' | 'proxy_test' | 'proxy_apply'): void {
    this.#db
      .update(pendingOperations)
      .set({ status: 'expired', encryptedCandidate: CLEARED_CANDIDATE })
      .where(and(eq(pendingOperations.kind, kind), inArray(pendingOperations.status, ['pending', 'running'])))
      .run();
  }

  #createOperation(
    kind: 'github_token' | 'proxy_test' | 'proxy_apply',
    session: SessionRow,
    payload: unknown,
    expectedRevision: number,
  ): number {
    this.#cancelStaleOperations(kind);
    const now = this.#now();
    const encrypted = encryptSecret(this.#appKey, `operation:${kind}`, JSON.stringify(payload));
    // nonce、authTag 与密文在**一次**写入里落库，避免出现只有密文、无法解密的中间行。
    const blob = Buffer.concat([encrypted.nonce, encrypted.authTag, encrypted.ciphertext]);
    const inserted = this.#db
      .insert(pendingOperations)
      .values({
        kind,
        encryptedCandidate: blob,
        initiatingSessionId: session.id,
        authVersion: session.authVersion,
        expectedRevision,
        status: 'pending',
        expiresAt: now + PENDING_OPERATION_TTL_MS,
        createdAt: now,
      })
      .returning({ id: pendingOperations.id })
      .all();
    const id = inserted[0]?.id;
    if (id === undefined) throw new AppError('SERVICE_UNAVAILABLE', '创建候选操作失败');
    return id;
  }

  #decryptCandidate(kind: string, blob: Buffer): unknown {
    const nonce = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const plaintext = decryptSecret(this.#appKey, `operation:${kind}`, {
      ciphertext,
      nonce,
      authTag,
      keyVersion: 1,
    });
    return JSON.parse(plaintext) as unknown;
  }

  /** 提交候选 PAT：加密保存并创建控制任务，激活前必须在同一事务复核发起会话。 */
  submitToken(session: SessionRow, token: string): number {
    const hint = tokenTypeHint(token);
    if (hint === null) {
      throw new AppError('VALIDATION_FAILED', '只接受 classic（ghp_）或 fine-grained（github_pat_）PAT', {
        fields: { token: '前缀不是 ghp_ 或 github_pat_；前缀只作类型提示，仍需在线验证' },
      });
    }
    return this.#createOperation('github_token', session, { token, hint }, this.credentialRevision());
  }

  /**
   * 清除已保存的 PAT（设置页“重置 Token”）。
   *
   * 删除密文、把凭证状态复位为 missing，并同时递增 credential_revision 与 gate_revision：
   * 门禁关闭、在途验证结论作废，业务回到“需要重新配置并在线验证”。代理配置不受影响。
   * 与候选凭证操作不同，这里不额外复核发起会话：清空是同步生效的（不需要像候选激活那样
   * 防止“退出后仍偷偷激活新凭证”），路由层的会话 + CSRF 校验就是全部前提。
   */
  clearToken(): void {
    const row = this.#statusRow();
    if (row.credentialState === 'missing' && this.#db.select().from(secrets).where(eq(secrets.name, PAT_SECRET_NAME)).get() === undefined) {
      return;
    }
    // 候选操作随凭证一起作废；残留控制任务在 streams 里按“候选已销毁”安静结束。
    this.#cancelStaleOperations('github_token');
    this.#db.$client.transaction(() => {
      this.#db.$client.prepare('DELETE FROM secrets WHERE name = ?').run(PAT_SECRET_NAME);
      this.#db
        .update(githubCredentialStatus)
        .set({
          credentialState: 'missing',
          connectivity: 'unknown',
          tokenTypeHint: null,
          lastAttemptAt: null,
          lastVerifiedAt: null,
          lastAuthenticatedAt: null,
          expiresAt: null,
          expiresObservedAt: null,
          classicScopesJson: null,
          lastErrorCode: null,
          configuredAt: null,
          accountId: null,
          verificationAttemptSeq: row.verificationAttemptSeq + 1,
          nextVerificationAt: null,
          credentialRevision: row.credentialRevision + 1,
          gateRevision: row.gateRevision + 1,
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
    })();
  }

  readCandidatePayload(operationId: number): { token: string; hint: 'classic' | 'fine_grained' } | null {
    const row = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (row === undefined || row.kind !== 'github_token') return null;
    if (row.status !== 'pending' && row.status !== 'running') return null;
    try {
      return this.#decryptCandidate('github_token', row.encryptedCandidate) as {
        token: string;
        hint: 'classic' | 'fine_grained';
      };
    } catch {
      return null;
    }
  }

  #beginVerification(): VerifySnapshot {
    const now = this.#now();
    const row = this.#statusRow();
    const seq = row.verificationAttemptSeq + 1;
    this.#db
      .update(githubCredentialStatus)
      .set({ verificationAttemptSeq: seq, lastAttemptAt: now })
      .where(eq(githubCredentialStatus.id, 1))
      .run();
    // 退避锚点：派发前的上一次尝试时间。lastAttemptAt 马上会被本次派发覆写，
    // 不在快照里保存它的话，连续失败之间的间隔就永远测不出来。
    return {
      attemptSeq: seq,
      credentialRevision: this.credentialRevision(),
      token: null,
      operationId: null,
      previousAttemptAt: row.lastAttemptAt,
    };
  }

  /** 后台/显式复核活动凭证（不要求管理员在线，只能更新认证证据）。 */
  beginActiveVerification(): VerifySnapshot {
    const snapshot = this.#beginVerification();
    return { ...snapshot, token: this.readActiveToken() };
  }

  /** 候选凭证验证；激活仍严格要求发起会话有效。 */
  beginCandidateVerification(operationId: number): VerifySnapshot | null {
    const operation = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (operation === undefined) return null;
    if (operation.status !== 'pending' && operation.status !== 'running') return null;
    const payload = this.readCandidatePayload(operationId);
    if (payload === null) return null;
    if (operation.expiresAt < this.#now()) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'expired', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return null;
    }
    this.#db.update(pendingOperations).set({ status: 'running' }).where(eq(pendingOperations.id, operationId)).run();
    const row = this.#statusRow();
    return {
      attemptSeq: row.verificationAttemptSeq,
      credentialRevision: operation.expectedRevision,
      token: payload.token,
      operationId,
      previousAttemptAt: row.lastAttemptAt,
    };
  }

  /**
   * 会话在候选激活前失效时取消候选并销毁密文。
   *
   * "当前 auth_version"必须读 `admin_account`：候选操作自带的 auth_version 是提交时刻的旧值，
   * 拿它当对照等于用旧值比较旧值，改密后未撤销的旧会话会被误判为仍然有效。
   */
  #sessionStillValid(sessionId: number | null): boolean {
    if (sessionId === null) return false;
    const row = this.#db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (row === undefined) return false;
    const account = this.#db.$client
      .prepare('SELECT auth_version FROM admin_account WHERE id = 1')
      .get() as { auth_version: number } | undefined;
    if (account === undefined) return false;
    const validity = checkSession(
      {
        id: row.id,
        authVersion: row.authVersion,
        csrfNonce: row.csrfNonce,
        rememberMe: row.rememberMe,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
      },
      account.auth_version,
      this.#now(),
    );
    return validity === 'ok';
  }

  /**
   * 应用候选验证结果。激活前在同一短事务复核：
   * 发起会话未撤销、未过期、auth_version 一致、期望配置 revision 未变。
   */
  applyCandidateVerification(
    operationId: number,
    verification: UserVerification,
  ): { activated: boolean; reason: string | null } {
    const now = this.#now();
    const operation = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (operation === undefined) return { activated: false, reason: 'OPERATION_NOT_FOUND' };
    if (operation.status !== 'pending' && operation.status !== 'running') {
      return { activated: false, reason: 'OPERATION_CLOSED' };
    }

    const currentRevision = this.credentialRevision();
    const sessionValid =
      operation.initiatingSessionId !== null && this.#sessionStillValid(operation.initiatingSessionId);

    if (!sessionValid) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'cancelled', errorCode: 'UNAUTHENTICATED', resultJson: null, encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return { activated: false, reason: 'SESSION_REVOKED' };
    }

    if (!verification.ok) {
      this.#db
        .update(pendingOperations)
        .set({
          status: 'failed',
          errorCode: verification.errorCode ?? 'GITHUB_TOKEN_INVALID',
          encryptedCandidate: CLEARED_CANDIDATE,
          resultJson: JSON.stringify({
            probeStages: null,
            credentialState: this.#statusRow().credentialState,
          }),
        })
        .where(eq(pendingOperations.id, operationId))
        .run();
      // 有效 PAT 被错误候选替换验证失败时，原凭证继续生效，不全站上锁。
      return { activated: false, reason: verification.errorCode ?? 'VERIFICATION_FAILED' };
    }

    if (operation.expectedRevision !== currentRevision) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'cancelled', errorCode: 'REVISION_CONFLICT', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return { activated: false, reason: 'REVISION_CONFLICT' };
    }

    const payload = this.readCandidatePayload(operationId);
    if (payload === null) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'failed', errorCode: 'IMPORT_EXPIRED', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return { activated: false, reason: 'CANDIDATE_UNAVAILABLE' };
    }

    const encrypted = encryptSecret(this.#appKey, PAT_SECRET_NAME, payload.token);
    const previous = this.#statusRow();
    const expiry = resolveExpiry(previous.expiresAt, verification, now);

    const activate = this.#db.$client.transaction(() => {
      this.#db
        .insert(secrets)
        .values({
          name: PAT_SECRET_NAME,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          revision: currentRevision + 1,
        })
        .onConflictDoUpdate({
          target: secrets.name,
          set: {
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag,
            keyVersion: encrypted.keyVersion,
            revision: currentRevision + 1,
          },
        })
        .run();

      this.#db
        .update(githubCredentialStatus)
        .set({
          credentialRevision: currentRevision + 1,
          // 门禁恢复同样递增版本，旧响应不因当前重新 valid 而生效。
          gateRevision: previous.gateRevision + 1,
          credentialState: expiry.conflict ? 'unverified' : 'valid',
          connectivity: 'reachable',
          tokenTypeHint: payload.hint,
          lastVerifiedAt: now,
          lastAuthenticatedAt: expiry.conflict ? previous.lastAuthenticatedAt : now,
          expiresAt: expiry.expiresAt,
          expiresObservedAt: verification.tokenMetadata?.expiresAt === null ? null : now,
          classicScopesJson:
            verification.tokenMetadata?.classicScopes === null || verification.tokenMetadata === null
              ? null
              : JSON.stringify(verification.tokenMetadata.classicScopes),
          lastErrorCode: expiry.conflict ? 'TOKEN_METADATA_CONFLICT' : null,
          configuredAt: previous.configuredAt ?? now,
          accountId: verification.accountId,
          authObservationSeq: previous.authObservationSeq + 1,
          nextVerificationAt: now + VERIFY_STEADY_INTERVAL_MS,
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();

      this.#db
        .update(pendingOperations)
        .set({
          status: 'succeeded',
          errorCode: null,
          encryptedCandidate: CLEARED_CANDIDATE,
          resultJson: JSON.stringify({
            probeStages: null,
            credentialState: expiry.conflict ? 'unverified' : 'valid',
          }),
        })
        .where(eq(pendingOperations.id, operationId))
        .run();
    });
    activate();

    return { activated: !expiry.conflict, reason: expiry.conflict ? 'TOKEN_METADATA_CONFLICT' : null };
  }

  /**
   * 应用活动凭证的验证结果。
   * 401 → invalid 并递增 gate revision；网络错误只更新 connectivity；
   * 403/404 属于资源级问题，不全局认定 PAT 失效。
   */
  applyActiveVerification(snapshot: VerifySnapshot, verification: UserVerification): void {
    const now = this.#now();
    const row = this.#statusRow();
    // 旧 revision 的响应不能修改新凭证状态。
    if (snapshot.credentialRevision !== row.credentialRevision) return;
    // 同一凭证下，更旧的验证结论不能覆盖更新的结论：
    // 例如在途的 200 不能把已经由更新的 401 判定的 invalid 重新改成 valid。
    if (snapshot.attemptSeq !== row.verificationAttemptSeq) return;
    if (verification.status === 0) {
      // 网络错误同样占用一次复核尝试：安排阶梯退避，避免 next_verification_at
      // 停留在过去导致后台规划每轮都重新入队、断网时持续连接尝试。
      this.#db
        .update(githubCredentialStatus)
        .set({
          connectivity: 'unavailable',
          lastErrorCode: verification.errorCode,
          nextVerificationAt: now + this.#verificationBackoffMs(row, snapshot.previousAttemptAt, now),
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
      return;
    }
    if (verification.ok) {
      const expiry = resolveExpiry(row.expiresAt, verification, now);
      // 门禁开合转换都递增 gate revision：旧响应不因当前重新 valid 而生效；
      // valid→valid 的常规复核不递增，避免每日一次的常规复核无谓地让在途任务全部失效。
      const wasClosed = this.#effectiveState(row, now) !== 'valid' || row.credentialState !== 'valid';
      this.#db
        .update(githubCredentialStatus)
        .set({
          credentialState: expiry.conflict ? 'unverified' : 'valid',
          ...(expiry.conflict || wasClosed ? { gateRevision: row.gateRevision + 1 } : {}),
          connectivity: 'reachable',
          lastVerifiedAt: now,
          lastAuthenticatedAt: expiry.conflict ? row.lastAuthenticatedAt : now,
          expiresAt: expiry.expiresAt,
          expiresObservedAt: verification.tokenMetadata?.expiresAt === null ? null : now,
          lastErrorCode: expiry.conflict ? 'TOKEN_METADATA_CONFLICT' : null,
          accountId: verification.accountId ?? row.accountId,
          classicScopesJson:
            verification.tokenMetadata?.classicScopes === null || verification.tokenMetadata === null
              ? row.classicScopesJson
              : JSON.stringify(verification.tokenMetadata.classicScopes),
          authObservationSeq: row.authObservationSeq + 1,
          nextVerificationAt: now + VERIFY_STEADY_INTERVAL_MS,
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
      return;
    }
    if (verification.errorCode === 'GITHUB_TOKEN_INVALID') {
      this.#markInvalid(verification.errorCode, snapshot.previousAttemptAt);
      return;
    }
    // 其余失败（5xx、403、结构异常）：连通性正常但本次复核没有结论。
    // 这里必须自己安排退避——复核任务不再走任务级重试阶梯（控制任务失败即终态），
    // 不写 next_verification_at 就会让一次 5xx 拖到下一个每日窗口（1/5/15 分钟复核阶梯）。
    this.#db
      .update(githubCredentialStatus)
      .set({
        connectivity: 'reachable',
        lastErrorCode: verification.errorCode,
        nextVerificationAt: now + this.#verificationBackoffMs(row, snapshot.previousAttemptAt, now),
      })
      .where(eq(githubCredentialStatus.id, 1))
      .run();
  }

  #markInvalid(errorCode: string, previousAttemptAt: number | null = null): void {
    const now = this.#now();
    const row = this.#statusRow();
    if (row.credentialState === 'invalid') {
      // 已经 invalid：不重复递增门禁版本，但复核节奏仍要按阶梯推进，
      // 否则 next_verification_at 停留在旧值会让后台规划每轮都重新入队。
      this.#db
        .update(githubCredentialStatus)
        .set({
          lastErrorCode: errorCode,
          nextVerificationAt: now + this.#verificationBackoffMs(row, previousAttemptAt, now),
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
      return;
    }
    this.#db
      .update(githubCredentialStatus)
      .set({
        credentialState: 'invalid',
        gateRevision: row.gateRevision + 1,
        lastErrorCode: errorCode,
        nextVerificationAt: now + this.#verificationBackoffMs(row, previousAttemptAt, now),
      })
      .where(eq(githubCredentialStatus.id, 1))
      .run();
  }

  /**
   * 复核退避（1/5/15 分钟，之后每日一次）。
   * 判定顺序：
   * 1. 上一次尝试刚成功过（lastVerifiedAt 覆盖上一次尝试时间）——这是新一轮失败序列的
   *    第一跳，从 60 秒起步（稳态复核间隔是每日一次的 24 小时，若纯按间隔分档，撤销后的
   *    首次失败会直接跳到 24 小时，违背“1/5/15 分钟”的复核时限）；
   * 2. 连续失败按与上一次尝试的间隔推断阶梯位置：2 分钟内 → 5 分钟档、7 分钟内 →
   *    15 分钟档、更长 → 每日封顶（24 小时）；
   * 3. 超过两个封顶周期没有失败序列视为全新一轮，重新从 60 秒起步。
   * 锚点 previousAttemptAt 来自派发快照（lastAttemptAt 会被本次派发覆写）；
   * 业务 401（noteBusinessUnauthorized）没有快照，锚点按 null 处理。
   */
  #verificationBackoffMs(row: StatusRow, previousAttemptAt: number | null, now: number): number {
    const previousSucceeded =
      row.lastVerifiedAt !== null &&
      (previousAttemptAt === null || row.lastVerifiedAt >= previousAttemptAt - 60_000);
    if (previousSucceeded || previousAttemptAt === null) {
      return VERIFY_BACKOFF_MS[0];
    }
    const gap = now - previousAttemptAt;
    if (gap > 2 * VERIFY_STEADY_INTERVAL_MS) {
      return VERIFY_BACKOFF_MS[0];
    }
    if (gap < 2 * 60 * 1000) return VERIFY_BACKOFF_MS[1] ?? VERIFY_BACKOFF_MS[0];
    if (gap < 7 * 60 * 1000) return VERIFY_BACKOFF_MS[2] ?? VERIFY_BACKOFF_MS[1] ?? VERIFY_BACKOFF_MS[0];
    return VERIFY_STEADY_INTERVAL_MS;
  }

  /**
   * 时间边界落库（GET 只读计算不足以阻止业务，后台负责持久化）。
   * 由调度器周期调用：
   * - 已知可信到期时间已过 → 持久化 expired、递增 gate revision 并安排在线复核；
   * - 超过认证新鲜度窗口（48 小时）无可信认证成功 → 持久化 unverified、递增 gate revision 并安排复核
   *   （新鲜度边界不能只停留在只读计算里，否则转换时刻没有版本变化）。
   */
  persistTimeBoundaries(): void {
    const now = this.#now();
    const row = this.#statusRow();
    if (row.credentialState !== 'valid') return;
    if (row.expiresAt !== null && now >= row.expiresAt) {
      this.#db
        .update(githubCredentialStatus)
        .set({
          credentialState: 'expired',
          gateRevision: row.gateRevision + 1,
          lastErrorCode: 'GITHUB_TOKEN_INVALID',
          nextVerificationAt: now,
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
      return;
    }
    if (row.lastAuthenticatedAt === null || now - row.lastAuthenticatedAt > AUTH_FRESHNESS_MS) {
      this.#db
        .update(githubCredentialStatus)
        .set({
          credentialState: 'unverified',
          gateRevision: row.gateRevision + 1,
          nextVerificationAt: now,
        })
        .where(eq(githubCredentialStatus.id, 1))
        .run();
    }
  }

  /** 活动凭证的业务请求返回 401 时调用：全局锁定并递增门禁版本。 */
  noteBusinessUnauthorized(): void {
    this.#markInvalid('GITHUB_TOKEN_INVALID');
  }

  /**
   * 读取候选操作状态。
   *
   * 显式重新验证活动 PAT 不产生候选密文，因此用 `job_<id>` 形式暴露同一个只读视图；
   * 候选操作仍以数字 ID 查询。两条路径返回同一种形状，前端只需一个轮询实现。
   */
  readOperation(id: string | number): OperationView | null {
    if (typeof id === 'string' && id.startsWith('job_')) {
      const jobId = Number(id.slice(4));
      if (!Number.isInteger(jobId) || jobId < 1) return null;
      const job = this.#db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (job === undefined || job.kind !== 'token_verify') return null;
      const status: OperationView['status'] =
        job.state === 'succeeded'
          ? 'succeeded'
          : job.state === 'failed'
            ? 'failed'
            : job.state === 'running'
              ? 'running'
              : job.state === 'queued' || job.state === 'retry_wait'
                ? 'pending'
                : 'cancelled';
      return {
        id,
        kind: 'github_token',
        status,
        errorCode: job.errorCode,
        createdAt: job.acceptedAt,
        expiresAt: job.acceptedAt + PENDING_OPERATION_TTL_MS,
        resultJson: null,
      };
    }

    const operationId = typeof id === 'number' ? id : Number(id);
    if (!Number.isInteger(operationId) || operationId < 1) return null;
    const row = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (row === undefined) return null;
    return {
      id: String(row.id),
      kind: row.kind as OperationView['kind'],
      status: row.status as OperationView['status'],
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      resultJson: row.resultJson,
    };
  }

  /**
   * 停止候选操作：任务被管理员取消时同步收口，否则操作行会一直停在
   * pending/running，界面只能显示"等待中"直到 1 小时后过期。
   * 只作用于未结束的操作；已出结论的结果不被改写。
   */
  cancelOperation(operationId: number): void {
    if (!Number.isInteger(operationId) || operationId < 1) return;
    this.#db
      .update(pendingOperations)
      .set({ status: 'cancelled', encryptedCandidate: CLEARED_CANDIDATE })
      .where(and(eq(pendingOperations.id, operationId), inArray(pendingOperations.status, ['pending', 'running'])))
      .run();
  }

  // ------------------------------------------------------------------ 代理

  #proxyRow(): { scheme: ProxySettings['scheme'] | null; host: string | null; port: number | null; enabled: number; revision: number } {
    return this.#db.$client
      .prepare('SELECT scheme, host, port, enabled, revision FROM proxy_config WHERE id = 1')
      .get() as { scheme: ProxySettings['scheme'] | null; host: string | null; port: number | null; enabled: number; revision: number };
  }

  readProxy(): ProxyView {
    const row = this.#proxyRow();
    const stored = this.#db
      .select({ name: secrets.name })
      .from(secrets)
      .where(eq(secrets.name, PROXY_PASSWORD_SECRET_NAME))
      .get();
    const configured = row.scheme !== null && row.host !== null && row.port !== null;
    return {
      configured,
      enabled: row.enabled === 1,
      scheme: row.scheme,
      host: row.host,
      port: row.port,
      usernameConfigured: stored !== undefined,
      revision: row.revision,
    };
  }

  /** 活动代理设置；直连时为 null。 */
  activeProxy(): ProxySettings | null {
    const row = this.#proxyRow();
    if (row.enabled !== 1 || row.scheme === null || row.host === null || row.port === null) return null;
    const stored = this.#db.select().from(secrets).where(eq(secrets.name, PROXY_PASSWORD_SECRET_NAME)).get();
    let password: string | null = null;
    let username: string | null = null;
    if (stored !== undefined) {
      try {
        const parsed = JSON.parse(
          decryptSecret(this.#appKey, PROXY_PASSWORD_SECRET_NAME, {
            ciphertext: stored.ciphertext,
            nonce: stored.nonce,
            authTag: stored.authTag,
            keyVersion: stored.keyVersion,
          }),
        ) as { username: string | null; password: string | null };
        username = parsed.username;
        password = parsed.password;
      } catch {
        username = null;
        password = null;
      }
    }
    return { scheme: row.scheme, host: row.host, port: row.port, username, password };
  }

  /** 显式关闭代理，而不是失败后的静默 fallback。 */
  disableProxy(expectedRevision: number): void {
    const row = this.#proxyRow();
    if (row.revision !== expectedRevision) {
      throw new AppError('REVISION_CONFLICT', '代理配置已被其他操作修改');
    }
    this.#db.$client
      .prepare('UPDATE proxy_config SET enabled = 0, revision = revision + 1 WHERE id = 1')
      .run();
  }

  submitProxyTest(session: SessionRow, candidate: ProxySettings & { username: string | null }): number {
    return this.#createOperation('proxy_test', session, candidate, this.#proxyRow().revision);
  }

  submitProxyApply(
    session: SessionRow,
    candidate: ProxySettings & { username: string | null },
    expectedRevision: number,
  ): number {
    if (this.#proxyRow().revision !== expectedRevision) {
      throw new AppError('REVISION_CONFLICT', '代理配置已被其他操作修改');
    }
    return this.#createOperation('proxy_apply', session, candidate, expectedRevision);
  }

  readProxyCandidate(operationId: number): (ProxySettings & { username: string | null }) | null {
    const row = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (row === undefined) return null;
    if (row.status !== 'pending' && row.status !== 'running') return null;
    try {
      return this.#decryptCandidate(row.kind, row.encryptedCandidate) as ProxySettings & { username: string | null };
    } catch {
      return null;
    }
  }

  /** 候选网络验证成功前不替换活动配置；失败保留原配置。 */
  applyProxyResult(operationId: number, probe: { ok: boolean; stages: ProxyProbeStage[]; detail: string | null }): boolean {
    const now = this.#now();
    const row = this.#db.select().from(pendingOperations).where(eq(pendingOperations.id, operationId)).get();
    if (row === undefined) return false;
    // 只有未结束且未过期的候选才能写结论：任务晚到时不能把已被取消/过期的操作
    // 重新改写成 succeeded（与 token_verify 分支同构，过期候选安静丢弃）。
    if (row.status !== 'pending' && row.status !== 'running') return false;
    if (row.expiresAt <= now) return false;

    if (!probe.ok) {
      this.#db
        .update(pendingOperations)
        .set({
          status: 'failed',
          errorCode: 'PROXY_UNREACHABLE',
          encryptedCandidate: CLEARED_CANDIDATE,
          resultJson: JSON.stringify({ probeStages: probe.stages, credentialState: null }),
        })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return false;
    }

    if (row.kind === 'proxy_test') {
      this.#db
        .update(pendingOperations)
        .set({
          status: 'succeeded',
          encryptedCandidate: CLEARED_CANDIDATE,
          resultJson: JSON.stringify({ probeStages: probe.stages, credentialState: null }),
        })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return true;
    }

    const candidate = this.readProxyCandidate(operationId);
    if (candidate === null) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'expired', errorCode: 'IMPORT_EXPIRED', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return false;
    }

    // 激活前复核发起会话：退出、过期或改密后不得再应用候选代理，
    // 与候选 PAT 激活使用同一规则。
    const sessionValid = row.initiatingSessionId !== null && this.#sessionStillValid(row.initiatingSessionId);
    if (!sessionValid) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'cancelled', errorCode: 'UNAUTHENTICATED', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return false;
    }

    const currentRevision = this.#proxyRow().revision;
    if (row.expectedRevision !== currentRevision) {
      this.#db
        .update(pendingOperations)
        .set({ status: 'cancelled', errorCode: 'REVISION_CONFLICT', encryptedCandidate: CLEARED_CANDIDATE })
        .where(eq(pendingOperations.id, operationId))
        .run();
      return false;
    }

    const encrypted = encryptSecret(
      this.#appKey,
      PROXY_PASSWORD_SECRET_NAME,
      JSON.stringify({ username: candidate.username, password: candidate.password }),
    );

    const apply = this.#db.$client.transaction(() => {
      this.#db
        .insert(secrets)
        .values({
          name: PROXY_PASSWORD_SECRET_NAME,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          revision: 1,
        })
        .onConflictDoUpdate({
          target: secrets.name,
          set: {
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag,
            keyVersion: encrypted.keyVersion,
          },
        })
        .run();

      this.#db.$client
        .prepare(
          `UPDATE proxy_config
              SET scheme = ?, host = ?, port = ?, enabled = 1, revision = revision + 1
            WHERE id = 1`,
        )
        .run(candidate.scheme, candidate.host, candidate.port);

      this.#db
        .update(pendingOperations)
        .set({
          status: 'succeeded',
          encryptedCandidate: CLEARED_CANDIDATE,
          resultJson: JSON.stringify({ probeStages: probe.stages, credentialState: null }),
        })
        .where(eq(pendingOperations.id, operationId))
        .run();
    });
    apply();
    return true;
  }

  purgeExpiredOperations(): number {
    const now = this.#now();
    return this.#db
      .update(pendingOperations)
      .set({ status: 'expired', encryptedCandidate: CLEARED_CANDIDATE })
      .where(and(inArray(pendingOperations.status, ['pending', 'running']), lt(pendingOperations.expiresAt, now)))
      .run().changes;
  }
}

/**
 * 到期头规则：
 * - 有新且未来的到期头 → 替换；
 * - 缺头且旧值仍在未来 → 保留旧值并注明观测时间；
 * - 缺头且旧值已过期，而显式 /user 复核成功 → 清除旧值并标未知，不能立刻再锁回 expired；
 * - 同一成功响应仍给出已过期时间 → 保持 unverified 并记录 TOKEN_METADATA_CONFLICT。
 */
export function resolveExpiry(
  previousExpiresAt: number | null,
  verification: Pick<UserVerification, 'tokenMetadata'>,
  now: number,
): { expiresAt: number | null; conflict: boolean } {
  const reported = verification.tokenMetadata?.expiresAt ?? null;
  if (reported !== null) {
    if (reported <= now) return { expiresAt: reported, conflict: true };
    return { expiresAt: reported, conflict: false };
  }
  if (previousExpiresAt !== null && previousExpiresAt > now) {
    return { expiresAt: previousExpiresAt, conflict: false };
  }
  return { expiresAt: null, conflict: false };
}
