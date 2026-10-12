import type { RateLimitSnapshot, TokenMetadata } from '../integrations/github/client.js';
import {
  ACCEPT_GITHUB_JSON,
  GITHUB_API_HOST,
  GITHUB_API_VERSION,
  classifyStatus,
  extractRateLimit,
  extractTokenMetadata,
  type GithubErrorCode,
} from '../integrations/github/client.js';
import { parseAuthenticatedUser } from '../integrations/github/projections.js';
import type { Transport } from '../integrations/transport/index.js';

/**
 * GET /user 在线认证。
 *
 * 这一步**必须走真实在线请求**：不接受 PAT 前缀、字符串非空、`/rate_limit` 返回 200
 * 或公开 endpoint 匿名 200 作为解锁依据，也不使用条件缓存短路（304 不能证明凭证有效）。
 */

export interface UserVerification {
  readonly ok: boolean;
  readonly accountId: string | null;
  readonly status: number;
  readonly errorCode: GithubErrorCode | null;
  readonly errorMessage: string | null;
  readonly tokenMetadata: TokenMetadata | null;
  readonly rateLimit: RateLimitSnapshot | null;
  readonly connectivity: 'reachable' | 'unavailable';
}

export async function verifyUserToken(
  transport: Transport,
  token: string,
  now: () => number = Date.now,
  timeoutMs = 20_000,
): Promise<UserVerification> {
  const url = `https://${GITHUB_API_HOST}/user`;
  try {
    const response = await transport.request({
      url,
      headers: {
        accept: ACCEPT_GITHUB_JSON,
        'x-github-api-version': GITHUB_API_VERSION,
        authorization: `Bearer ${token}`,
      },
      allowedHosts: [GITHUB_API_HOST],
      timeoutMs,
      maxBytes: 512 * 1024,
    });

    const rateLimit = extractRateLimit(response.headers, now());
    const tokenMetadata = extractTokenMetadata(response.headers);

    if (response.status === 200) {
      try {
        const user = parseAuthenticatedUser(JSON.parse(response.body) as unknown);
        return {
          ok: true,
          accountId: user.accountId,
          status: 200,
          errorCode: null,
          errorMessage: null,
          tokenMetadata,
          rateLimit,
          connectivity: 'reachable',
        };
      } catch {
        // 200 但结构不符合契约：不激活，也不当作网络失败。
        return {
          ok: false,
          accountId: null,
          status: 200,
          errorCode: 'UPSTREAM_SCHEMA_CHANGED',
          errorMessage: '认证响应结构不符合契约',
          tokenMetadata,
          rateLimit,
          connectivity: 'reachable',
        };
      }
    }

    const classified = classifyStatus(response.status, response.headers);
    return {
      ok: false,
      accountId: null,
      status: response.status,
      errorCode: classified.errorCode,
      errorMessage: classified.message,
      tokenMetadata,
      rateLimit,
      connectivity: 'reachable',
    };
  } catch (error) {
    // 超时/DNS/代理错误只更新 connectivity，绝不因此把 invalid 变成 valid，也不反向把 valid 变成 invalid。
    return {
      ok: false,
      accountId: null,
      status: 0,
      errorCode: 'PROXY_UNREACHABLE',
      errorMessage: error instanceof Error ? error.message : '网络不可达',
      tokenMetadata: null,
      rateLimit: null,
      connectivity: 'unavailable',
    };
  }
}

/** 首版只接收 classic 与 fine-grained PAT；前缀仅作类型初筛，仍需在线验证。 */
export function tokenTypeHint(token: string): 'classic' | 'fine_grained' | null {
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('github_pat_')) return 'fine_grained';
  return null;
}
