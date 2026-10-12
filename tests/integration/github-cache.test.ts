import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyStatus,
  GithubClient,
  parseBranchHead,
  purgeStaleHttpCache,
  releaseWindowProjection,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@githubradar/server';

import { createTestDatabase, type TestDatabase } from './support.js';

/**
 * 条件缓存。
 *
 * 这里检查的是最容易出错的三条：304 只有在投影完整且版本一致时才可复用；
 * 没有可用投影时必须安排一次无条件重取，绝不能把 304 当成空响应；
 * 缓存键必须随凭证 revision 变化，且键里不出现凭证明文。
 */

class ScriptedTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  readonly #responses: (() => Omit<TransportResponse, 'url'>)[] = [];

  push(response: () => Omit<TransportResponse, 'url'>): void {
    this.#responses.push(response);
  }

  request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) throw new Error('没有更多预设响应');
    return Promise.resolve({ ...next(), url: request.url });
  }

  describe(): { mode: 'direct'; proxyScheme: null } {
    return { mode: 'direct', proxyScheme: null };
  }

  close(): void {
    // 无需释放。
  }
}

const NOW = 1_700_000_000_000;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 3600),
    'x-ratelimit-resource': 'core',
    ...extra,
  };
}

const projection = {
  parse: (payload: unknown): { id: string } => ({ id: String((payload as { id: string }).id) }),
};

/** 与真实投影一致：结构不符时直接抛错，由客户端映射成 UPSTREAM_SCHEMA_CHANGED。 */
const strictProjection = {
  parse: (payload: unknown): { id: string } => {
    const value = payload as { id?: unknown };
    if (typeof value.id !== 'string') throw new Error('缺少 id 字段');
    return { id: value.id };
  },
};

let context: TestDatabase;
let transport: ScriptedTransport;
let client: GithubClient;

beforeEach(() => {
  context = createTestDatabase();
  transport = new ScriptedTransport();
  client = new GithubClient({ db: context.db, transport, now: () => NOW });
});

afterEach(() => {
  context.close();
});

function get(options: { token?: string | null; credentialRevision?: number } = {}): ReturnType<GithubClient['get']> {
  return client.get({
    path: '/repos/owner/repo',
    projection,
    repoId: null,
    credentialRevision: options.credentialRevision ?? 1,
    token: options.token === undefined ? 'ghp_secret_value' : options.token,
  });
}

describe('条件请求与投影缓存', () => {
  it('200 保存投影与校验器，第二次请求带上 If-None-Match', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    const first = await get();
    expect(first.kind).toBe('ok');
    expect(first.data).toEqual({ id: '42' });

    const cached = context.client.prepare('SELECT key, etag, projection_json FROM http_cache').get() as {
      key: string;
      etag: string;
      projection_json: string;
    };
    expect(cached.etag).toBe('W/"abc"');
    expect(cached.projection_json).toBe('{"id":"42"}');
    // 缓存键只包含凭证 revision，不包含凭证明文。
    expect(cached.key).toContain('cred=1');
    expect(cached.key).not.toContain('ghp_');
    expect(JSON.stringify(context.client.prepare('SELECT * FROM http_cache').all())).not.toContain('ghp_');

    transport.push(() => ({ status: 304, headers: headers(), body: '', bytes: 0 }));
    const second = await get();
    expect(second.kind).toBe('not_modified');
    expect(second.fromCache).toBe(true);
    expect(transport.requests[1]?.headers?.['if-none-match']).toBe('W/"abc"');
  });

  it('304 但本地没有可用投影时，安排一次无条件重取而不是当成空响应', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    await get();

    // 模拟投影损坏/缺失：校验器还在，但内容没了。
    context.client.prepare('UPDATE http_cache SET projection_json = NULL').run();

    transport.push(() => ({ status: 304, headers: headers(), body: '', bytes: 0 }));
    transport.push(() => ({ status: 200, headers: headers(), body: '{"id":"99"}', bytes: 12 }));

    const outcome = await get();
    expect(outcome.kind).toBe('ok');
    expect(outcome.data).toEqual({ id: '99' });
    expect(transport.requests).toHaveLength(3);
    // 第二次请求（重取）必须不带条件头。
    expect(transport.requests[2]?.headers?.['if-none-match']).toBeUndefined();
  });

  it('凭证 revision 变化后不复用旧缓存', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    await get({ credentialRevision: 1 });

    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"def"' }), body: '{"id":"43"}', bytes: 12 }));
    await get({ credentialRevision: 2 });
    // 新 revision 是独立键，因此第二次请求不会携带条件头。
    expect(transport.requests[1]?.headers?.['if-none-match']).toBeUndefined();
    const rows = context.client.prepare('SELECT COUNT(*) AS count FROM http_cache').get() as { count: number };
    expect(rows.count).toBe(2);
  });
});

describe('上游错误分类与缓存卫生', () => {
  it('401 / 429 / 403 限流 / 非限流 403 / 5xx 分别落到正确的错误码', async () => {
    const cases: { status: number; extra: Record<string, string>; code: string; retryable: boolean }[] = [
      { status: 401, extra: {}, code: 'GITHUB_TOKEN_INVALID', retryable: false },
      { status: 429, extra: {}, code: 'GITHUB_RATE_LIMITED', retryable: true },
      { status: 403, extra: { 'x-ratelimit-remaining': '0' }, code: 'GITHUB_RATE_LIMITED', retryable: true },
      { status: 403, extra: {}, code: 'GITHUB_ACCESS_DENIED_OR_MISSING', retryable: false },
      { status: 404, extra: {}, code: 'GITHUB_ACCESS_DENIED_OR_MISSING', retryable: false },
      { status: 503, extra: {}, code: 'SERVICE_UNAVAILABLE', retryable: true },
    ];

    for (const testCase of cases) {
      transport.push(() => ({
        status: testCase.status,
        headers: headers(testCase.extra),
        body: '{}',
        bytes: 2,
      }));
      const outcome = await get();
      expect(outcome.kind, String(testCase.status)).toBe('error');
      expect(outcome.errorCode, String(testCase.status)).toBe(testCase.code);
      expect(outcome.retryable, String(testCase.status)).toBe(testCase.retryable);
    }

    // 分类函数本身与客户端保持一致。
    expect(classifyStatus(403, {}).errorCode).toBe('GITHUB_ACCESS_DENIED_OR_MISSING');
  });

  it('响应结构不符合契约时标记 UPSTREAM_SCHEMA_CHANGED，且不覆盖已有投影', async () => {
    const strictGet = (): ReturnType<GithubClient['get']> =>
      client.get({
        path: '/repos/owner/repo',
        projection: strictProjection,
        repoId: null,
        credentialRevision: 1,
        token: 'ghp_secret_value',
      });

    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    expect((await strictGet()).kind).toBe('ok');

    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"zzz"' }), body: '{"nope":true}', bytes: 13 }));
    const outcome = await strictGet();
    expect(outcome.kind).toBe('error');
    expect(outcome.errorCode).toBe('UPSTREAM_SCHEMA_CHANGED');

    const cached = context.client.prepare('SELECT projection_json FROM http_cache').get() as {
      projection_json: string;
    };
    expect(cached.projection_json).toBe('{"id":"42"}');
  });

  it('不访问的缓存 30 天后被清理', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    await get();
    expect(purgeStaleHttpCache(context.db, NOW + 10 * 24 * 60 * 60 * 1000)).toBe(0);
    expect(purgeStaleHttpCache(context.db, NOW + 31 * 24 * 60 * 60 * 1000)).toBe(1);
  });
});

describe('Link 头与列表覆盖度', () => {
  const listGet = (
    projection: { parse: (payload: unknown, context: { nextLink: string | null }) => unknown },
  ): ReturnType<GithubClient['get']> =>
    client.get({
      path: '/repos/owner/repo/releases',
      query: { per_page: '20', page: '1' },
      projection,
      repoId: null,
      credentialRevision: 1,
      token: 'ghp_secret_value',
    });

  it('校验通过的 rel="next" 解析、传给投影并写入 http_cache，不跟随翻页', async () => {
    transport.push(() => ({
      status: 200,
      headers: headers({
        etag: 'W/"abc"',
        link: '<https://api.github.com/repos/owner/repo/releases?per_page=20&page=2>; rel="next", <https://api.github.com/repos/owner/repo/releases?per_page=20&page=5>; rel="last"',
      }),
      body: '{"id":"42"}',
      bytes: 12,
    }));
    let seenNextLink: string | null = 'unset';
    const outcome = await listGet({
      parse: (payload, context) => {
        seenNextLink = context.nextLink;
        return payload;
      },
    });
    expect(outcome.kind).toBe('ok');
    const expected = 'https://api.github.com/repos/owner/repo/releases?per_page=20&page=2';
    expect(seenNextLink).toBe(expected);
    expect(outcome.nextLink).toBe(expected);

    const cached = context.client.prepare('SELECT next_link FROM http_cache').get() as { next_link: string | null };
    expect(cached.next_link).toBe(expected);
    // 不跟随 next：只发出一次请求。
    expect(transport.requests).toHaveLength(1);
  });

  it('主机、协议或路径不符的 next 链接一律丢弃', async () => {
    const hostileLinks = [
      '<http://api.github.com/repos/owner/repo/releases?page=2>; rel="next"',
      '<https://evil.example.com/repos/owner/repo/releases?page=2>; rel="next"',
      '<https://api.github.com/repos/other/repo/releases?page=2>; rel="next"',
    ];
    for (const link of hostileLinks) {
      transport.push(() => ({ status: 200, headers: headers({ link }), body: '{"id":"42"}', bytes: 12 }));
      const outcome = await listGet(projection);
      expect(outcome.nextLink, link).toBeNull();
      const cached = context.client.prepare('SELECT next_link FROM http_cache LIMIT 1').get() as {
        next_link: string | null;
      };
      expect(cached.next_link, link).toBeNull();
    }
  });

  it('GitHub 真实分页 Link 使用 /repositories/{id}/ 数字 ID 形式，同 endpoint 后缀时放行', async () => {
    // 官方分页文档示例：仓库子资源的 Link 是 /repositories/{id}/... 而不是
    // /repos/{owner}/{repo}/...；只放行 endpoint 后缀一致的变体。
    const accepted = '<https://api.github.com/repositories/1300192/releases?per_page=20&page=2>; rel="next"';
    transport.push(() => ({
      status: 200,
      headers: headers({ etag: 'W/"idform"', link: accepted }),
      body: '{"id":"42"}',
      bytes: 12,
    }));
    const outcome = await listGet(projection);
    expect(outcome.nextLink).toBe('https://api.github.com/repositories/1300192/releases?per_page=20&page=2');

    // endpoint 后缀不一致（例如 issues 的 next 混进 releases 响应）仍然丢弃。
    const rejected = '<https://api.github.com/repositories/1300192/issues?per_page=20&page=2>; rel="next"';
    transport.push(() => ({
      status: 200,
      headers: headers({ etag: 'W/"idform2"', link: rejected }),
      body: '{"id":"43"}',
      bytes: 12,
    }));
    const outcome2 = await listGet(projection);
    expect(outcome2.nextLink).toBeNull();
  });

  it('列表恰好 20 条或存在 next 链接时标记可能超出覆盖', async () => {
    // 少于 20 条且无 next：窗口已读完。
    transport.push(() => ({
      status: 200,
      headers: headers({ etag: 'W/"a"' }),
      body: JSON.stringify([{ id: 1, tag_name: 'v1', prerelease: true, draft: false, published_at: '2026-01-01T00:00:00Z' }]),
      bytes: 8,
    }));
    let outcome = await listGet(releaseWindowProjection('owner/repo'));
    expect((outcome.data as { mayHaveMore: boolean }).mayHaveMore).toBe(false);

    // 少于 20 条但存在 next 链接：同样按可能超出覆盖处理。
    transport.push(() => ({
      status: 200,
      headers: headers({
        etag: 'W/"b"',
        link: '<https://api.github.com/repos/owner/repo/releases?per_page=20&page=2>; rel="next"',
      }),
      body: JSON.stringify([{ id: 1, tag_name: 'v1', prerelease: true, draft: false, published_at: '2026-01-01T00:00:00Z' }]),
      bytes: 8,
    }));
    outcome = await listGet(releaseWindowProjection('owner/repo'));
    expect((outcome.data as { mayHaveMore: boolean }).mayHaveMore).toBe(true);
  });
});

describe('基线缺失时的 304 与空分支', () => {
  it('requiresProjection：基线缺失时不携带条件头，即使服务端返回 304 也安排无条件重取', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"abc"' }), body: '{"id":"42"}', bytes: 12 }));
    await get();

    // 服务端（异常地）仍返回 304：不能复用缓存投影，必须重取。
    transport.push(() => ({ status: 304, headers: headers(), body: '', bytes: 0 }));
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"def"' }), body: '{"id":"99"}', bytes: 12 }));
    const outcome = await client.get({
      path: '/repos/owner/repo',
      projection,
      repoId: null,
      credentialRevision: 1,
      token: 'ghp_secret_value',
      requiresProjection: true,
    });
    expect(outcome.kind).toBe('ok');
    expect(outcome.data).toEqual({ id: '99' });
    // 两次请求都不带条件头：304 不构成可用结果。
    expect(transport.requests[1]?.headers?.['if-none-match']).toBeUndefined();
    expect(transport.requests[2]?.headers?.['if-none-match']).toBeUndefined();
  });

  it('空分支结果单独透出 BRANCH_EMPTY，不与 schema 异常混为一谈', async () => {
    transport.push(() => ({ status: 200, headers: headers({ etag: 'W/"e"' }), body: '[]', bytes: 2 }));
    const outcome = await client.get({
      path: '/repos/owner/repo/commits',
      query: { sha: 'main', per_page: '1' },
      projection: { parse: (payload) => parseBranchHead(payload, 'owner/repo', 'main') },
      repoId: null,
      credentialRevision: 1,
      token: 'ghp_secret_value',
    });
    expect(outcome.kind).toBe('error');
    expect(outcome.errorCode).toBe('BRANCH_EMPTY');
    expect(outcome.retryable).toBe(false);
    expect(outcome.status).toBe(200);
  });
});
