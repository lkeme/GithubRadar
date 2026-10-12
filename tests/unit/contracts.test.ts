import { describe, expect, it } from 'vitest';

import {
  ApiError,
  CHANGE_WINDOW_DAYS,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  isDbConstraintCode,
  MAX_BATCH_IDS,
  MAX_BRANCHES_PER_REPO,
  MAX_LABELS_PER_REPO,
  PAGE_SIZE_MAX,
  PRERELEASE_WINDOW_LIMIT,
  PublicRepository,
  REPOSITORY_LIMIT,
  RepositoryListQuery,
} from '@githubradar/contracts';

const validRepository = {
  id: 'repo_123',
  fullName: 'owner/example',
  displayName: 'Example',
  note: '自用监控',
  description: '示例仓库',
  url: 'https://github.com/owner/example',
  ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  isPrivate: false,
  language: 'TypeScript',
  labels: ['开发工具'],
  pinned: true,
  stars: 12800,
  forks: 640,
  status: 'healthy' as const,
  hasRecentChange: true,
  lastChangeDetectedAt: '2026-10-09T01:00:00Z',
  changeExpiresAt: '2026-10-16T01:00:00Z',
  latestRelease: {
    version: 'v2.0.0',
    publishedAt: '2026-10-08T02:00:00Z',
    url: 'https://github.com/owner/example/releases/tag/v2.0.0',
  },
  recentPrerelease: {
    candidate: {
      version: 'v2.1.0-rc.1',
      publishedAt: '2026-10-09T00:00:00Z',
      url: 'https://github.com/owner/example/releases/tag/v2.1.0-rc.1',
    },
    coverage: { limit: PRERELEASE_WINDOW_LIMIT, observedCount: 20, mayHaveMore: true },
  },
  branches: [
    { name: 'main', committedAt: '2026-10-07T08:00:00Z', url: 'https://github.com/owner/example/tree/main' },
  ],
  lastCheckedAt: '2026-10-09T01:00:00Z',
  trends: [{ day: '2026-10-08', stars: 12780, forks: 639 }],
};

describe('错误码契约', () => {
  it('每个错误码都有唯一且合法的 HTTP 状态映射', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      const status = ERROR_HTTP_STATUS[code];
      expect(status, `${code} 缺少状态映射`).toBeTypeOf('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('门禁与版本类错误落到固定状态码', () => {
    expect(ERROR_HTTP_STATUS.GITHUB_SETUP_REQUIRED).toBe(409);
    expect(ERROR_HTTP_STATUS.REVISION_REQUIRED).toBe(428);
    expect(ERROR_HTTP_STATUS.REVISION_CONFLICT).toBe(409);
    expect(ERROR_HTTP_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_HTTP_STATUS.CSRF_REJECTED).toBe(403);
    expect(ERROR_HTTP_STATUS.SERVICE_UNAVAILABLE).toBe(503);
  });

  it('错误响应拒绝未知错误码，也拒绝多余字段', () => {
    expect(ApiError.safeParse({ code: 'SOMETHING_ELSE', message: 'x' }).success).toBe(false);
    expect(ApiError.safeParse({ code: 'NOT_FOUND', message: 'x', extra: 1 }).success).toBe(false);
    expect(
      ApiError.safeParse({ code: 'VALIDATION_FAILED', message: 'x', fields: { page: '必须是正整数' } }).success,
    ).toBe(true);
  });

  it('数据库触发器码与业务错误码使用同一组名字', () => {
    expect(isDbConstraintCode('REPOSITORY_LIMIT_REACHED')).toBe(true);
    expect(isDbConstraintCode('BRANCH_LIMIT_REACHED')).toBe(true);
    expect(isDbConstraintCode('LABEL_LIMIT_REACHED')).toBe(true);
    expect(isDbConstraintCode('SOME_OTHER')).toBe(false);
  });
});

describe('共享边界常量', () => {
  it('仓库、分支、标签、批量上限与数据库约束一致', () => {
    expect(REPOSITORY_LIMIT).toBe(999);
    expect(MAX_BRANCHES_PER_REPO).toBe(20);
    expect(MAX_LABELS_PER_REPO).toBe(20);
    expect(MAX_BATCH_IDS).toBe(100);
    expect(PRERELEASE_WINDOW_LIMIT).toBe(20);
    expect(CHANGE_WINDOW_DAYS).toBe(7);
  });
});

describe('公开仓库 DTO 白名单', () => {
  it('接受完整的公开投影', () => {
    expect(PublicRepository.safeParse(validRepository).success).toBe(true);
  });

  it('管理者才有的字段不得随公开 DTO 返回', () => {
    for (const field of ['editRevision', 'canManage', 'operationId', 'credentialRevision', 'lastErrorCode']) {
      const result = PublicRepository.safeParse({ ...validRepository, [field]: 1 });
      expect(result.success, `${field} 不应被公开 DTO 接受`).toBe(false);
    }
  });

  it('白名单字段必须显式给出，包括取值为 null 的可选信息', () => {
    const missingKey: Record<string, unknown> = { ...validRepository };
    delete missingKey['recentPrerelease'];
    expect(PublicRepository.safeParse(missingKey).success).toBe(false);
    expect(
      PublicRepository.safeParse({ ...validRepository, recentPrerelease: null, latestRelease: null }).success,
    ).toBe(true);
  });

  it('状态枚举只接受聚合状态机取值', () => {
    expect(PublicRepository.safeParse({ ...validRepository, status: 'refreshing' }).success).toBe(false);
    expect(PublicRepository.safeParse({ ...validRepository, status: 'partial' }).success).toBe(true);
  });

  it('时间字段必须是 ISO 8601 UTC，不能塞本地时间或毫秒时间戳', () => {
    expect(PublicRepository.safeParse({ ...validRepository, lastCheckedAt: '2026-10-09 09:00:00' }).success).toBe(
      false,
    );
    expect(PublicRepository.safeParse({ ...validRepository, lastCheckedAt: 1_760_000_000_000 }).success).toBe(false);
  });

  it('趋势点日期必须是日历日格式', () => {
    expect(
      PublicRepository.safeParse({ ...validRepository, trends: [{ day: '2026/10/08', stars: 1, forks: 1 }] })
        .success,
    ).toBe(false);
  });
});

describe('公开列表查询', () => {
  it('解析合法分页与筛选参数', () => {
    const parsed = RepositoryListQuery.parse({
      page: '2',
      pageSize: '30',
      sort: 'stars',
      monitoring: 'active',
      pinned: 'true',
      changed: 'false',
      q: 'radar',
    });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(30);
    expect(parsed.sort).toBe('stars');
    expect(parsed.monitoring).toBe('active');
    expect(parsed.pinned).toBe(true);
    expect(parsed.changed).toBe(false);
  });

  it('缺省参数交由服务端补默认值，不由契约静默编造', () => {
    const parsed = RepositoryListQuery.parse({});
    expect(parsed.page).toBeUndefined();
    expect(parsed.pageSize).toBeUndefined();
    expect(parsed.monitoring).toBeUndefined();
  });

  it('拒绝非法分页，避免落到 SQL 或触发大页查询', () => {
    expect(RepositoryListQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ page: '-1' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ page: '1.5' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ page: 'abc' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ pageSize: String(PAGE_SIZE_MAX + 1) }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ pageSize: String(PAGE_SIZE_MAX) }).success).toBe(true);
  });

  it('未知筛选参数与未知参数直接拒绝', () => {
    expect(RepositoryListQuery.safeParse({ sort: 'created' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ monitoring: 'disabled' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ force: '1' }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(RepositoryListQuery.safeParse({ pinned: 'yes' }).success).toBe(false);
  });
});
