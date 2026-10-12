import { z } from 'zod';

/**
 * 上游投影。
 *
 * 只保留判定与展示真正需要的字段：Release 正文、Commit message、作者邮箱等
 * 可能在响应里出现但一律解析后丢弃，不写数据库、日志或调试文件。
 * `current_projection_json` 使用带版本的明确 DTO。
 */

/** 投影 schema 版本；发生变化时缓存键随之变化，旧投影自动失效。 */
export const PROJECTION_VERSION = 1;

/**
 * GitHub 数字 ID 可能超过 JavaScript 安全整数范围，
 * 统一按十进制文本保存，避免精度丢失后判定成“版本变化”。
 */
const githubNumericId = z.union([z.number().int(), z.string()]).transform(String);

export const MetadataProjection = z.object({
  id: githubNumericId,
  fullName: z.string().min(1),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  htmlUrl: z.string().min(1),
  ownerAvatarUrl: z.string().nullable(),
  isPrivate: z.boolean(),
  language: z.string().nullable(),
  stars: z.number().int().min(0),
  forks: z.number().int().min(0),
  archived: z.boolean(),
  defaultBranch: z.string().min(1),
});
export type MetadataProjection = z.infer<typeof MetadataProjection>;

export const BranchHeadProjection = z.object({
  sha: z.string().min(1),
  committedAt: z.string().min(1),
  htmlUrl: z.string().min(1),
});
export type BranchHeadProjection = z.infer<typeof BranchHeadProjection>;

export const ReleaseProjection = z.object({
  id: githubNumericId,
  tagName: z.string().min(1),
  name: z.string(),
  publishedAt: z.string().min(1),
  prerelease: z.boolean(),
  draft: z.boolean(),
  htmlUrl: z.string().min(1),
});
export type ReleaseProjection = z.infer<typeof ReleaseProjection>;

/**
 * 预发布窗口覆盖信息与候选分离存放。
 *
 * 注意：这里的字段必须与 `parseReleaseWindow` 的返回值**逐字对应**——
 * 落库时是 `JSON.stringify` 后的结果，回读走严格解析，少一个字段就会静默变成"没有投影"。
 */
export const PrereleaseProjection = z.object({
  candidate: ReleaseProjection.nullable(),
  windowLimit: z.number().int().positive(),
  observedCount: z.number().int().min(0),
  mayHaveMore: z.boolean(),
  /** 同轮列表请求是否确认了该仓库存在正式发布；用于 latest 404 的辅助确认。 */
  hasAnyPublishedRelease: z.boolean(),
});
export type PrereleaseProjection = z.infer<typeof PrereleaseProjection>;

/** 上游原始字段名到投影字段名的显式映射，不用整体 spread。 */
const RawOwner = z.object({
  login: z.string(),
  avatar_url: z.string().nullable().optional(),
});

const RawRepo = z.object({
  id: z.union([z.number(), z.string()]),
  full_name: z.string(),
  name: z.string().optional(),
  owner: RawOwner,
  html_url: z.string(),
  private: z.boolean().optional(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  archived: z.boolean().optional(),
  default_branch: z.string().optional(),
});

export function parseMetadata(payload: unknown): MetadataProjection {
  const raw = RawRepo.parse(payload);
  // 上游可能返回非 github.com 的 avatar_url；只有在通过白名单校验后才保存。
  return {
    id: String(raw.id),
    fullName: raw.full_name,
    displayName: raw.name ?? null,
    description: raw.description ?? null,
    htmlUrl: normalizeGithubUrl(raw.html_url, repoUrl(raw.full_name)),
    ownerAvatarUrl: normalizeAvatarUrl(raw.owner.avatar_url ?? null),
    isPrivate: raw.private ?? false,
    language: raw.language ?? null,
    stars: raw.stargazers_count ?? 0,
    forks: raw.forks_count ?? 0,
    archived: raw.archived ?? false,
    defaultBranch: raw.default_branch ?? 'HEAD',
  };
}

const AVATAR_HOST = 'avatars.githubusercontent.com';
const GITHUB_HOST = 'github.com';

/** 头像只允许 https://avatars.githubusercontent.com 且无 userinfo、非标准端口。 */
export function normalizeAvatarUrl(candidate: string | null): string | null {
  if (candidate === null) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== AVATAR_HOST) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;
  return url.toString();
}

/** 由规范名构造仓库根链接，路径逐段编码。 */
function repoUrl(fullName: string): string {
  return `https://github.com/${fullName.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 仓库/Release/分支外链只接受 https://github.com 且无 userinfo、非标准端口。
 * 与头像同一口径：上游异常值不落库、不外发，按已知字段构造回退链接。
 */
export function normalizeGithubUrl(candidate: string | null | undefined, fallback: string): string {
  if (candidate === null || candidate === undefined || candidate === '') return fallback;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:') return fallback;
  if (url.hostname !== GITHUB_HOST) return fallback;
  if (url.username !== '' || url.password !== '') return fallback;
  if (url.port !== '' && url.port !== '443') return fallback;
  return url.toString();
}

const RawCommit = z.object({
  sha: z.string(),
  commit: z.object({
    committer: z.object({ date: z.string() }).optional(),
    author: z.object({ date: z.string() }).optional(),
  }),
  html_url: z.string().optional(),
});

export function parseBranchHead(payload: unknown, repoFullName: string, branch: string): BranchHeadProjection {
  // commits?sha=...&per_page=1 返回数组；空数组表示该分支没有提交（真正空仓库）。
  const list = z.array(RawCommit).parse(payload);
  const first = list[0];
  if (first === undefined) {
    throw new EmptyBranchError(repoFullName, branch);
  }
  const committedAt = first.commit.committer?.date ?? first.commit.author?.date;
  if (committedAt === undefined) {
    throw new UpstreamSchemaError('提交对象缺少 committer.date');
  }
  return {
    sha: first.sha,
    committedAt,
    htmlUrl: normalizeGithubUrl(first.html_url, `${repoUrl(repoFullName)}/tree/${encodeURIComponent(branch)}`),
  };
}

const RawRelease = z.object({
  id: z.union([z.number(), z.string()]),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  prerelease: z.boolean().optional(),
  draft: z.boolean().optional(),
  html_url: z.string().optional(),
});

function projectRelease(raw: z.infer<typeof RawRelease>, htmlUrlFallback: string): ReleaseProjection {
  if (raw.published_at === null || raw.published_at === undefined || raw.published_at === '') {
    // 非草稿候选缺少 published_at 时按 schema 异常处理，绝不用当前时间替代。
    throw new UpstreamSchemaError(`Release ${raw.tag_name} 缺少 published_at`);
  }
  return {
    id: String(raw.id),
    tagName: raw.tag_name,
    name: raw.name ?? '',
    publishedAt: raw.published_at,
    prerelease: raw.prerelease ?? false,
    draft: raw.draft ?? false,
    htmlUrl: normalizeGithubUrl(raw.html_url, `${htmlUrlFallback}/releases/tag/${encodeURIComponent(raw.tag_name)}`),
  };
}

export class UpstreamSchemaError extends Error {
  readonly code = 'UPSTREAM_SCHEMA_CHANGED';
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamSchemaError';
  }
}

export class EmptyBranchError extends Error {
  readonly code = 'BRANCH_EMPTY';
  constructor(repoFullName: string, branch: string) {
    super(`${repoFullName} 的分支 ${branch} 没有提交`);
    this.name = 'EmptyBranchError';
  }
}

/** 官方 latest：草稿与预发布都不允许作为正式版结果。 */
export function parseLatestRelease(payload: unknown, repoFullName: string): ReleaseProjection {
  const raw = RawRelease.parse(payload);
  const projected = projectRelease(raw, repoUrl(repoFullName));
  if (projected.draft || projected.prerelease) {
    throw new UpstreamSchemaError('官方 latest 返回了草稿或预发布对象，不符合契约');
  }
  return projected;
}

export interface ReleaseWindowProjection {
  readonly candidate: ReleaseProjection | null;
  /** 窗口上限；与 PrereleaseProjection 同名字段一一对应，落库后必须能严格回读。 */
  readonly windowLimit: number;
  readonly observedCount: number;
  readonly mayHaveMore: boolean;
  readonly hasAnyPublishedRelease: boolean;
}

/**
 * 发布列表第一页：固定覆盖前 20 条，草稿也占窗口位置，不跟随 next 链接。
 * 预发布候选在窗口内按 published_at 降序、Release ID 确定性排序取一项。
 */
export function parseReleaseWindow(
  payload: unknown,
  repoFullName: string,
  windowLimit: number,
  hasNextLink: boolean,
): ReleaseWindowProjection {
  const list = z.array(RawRelease).parse(payload);
  const htmlUrlFallback = repoUrl(repoFullName);
  let candidate: ReleaseProjection | null = null;
  let hasAnyPublishedRelease = false;

  for (const raw of list) {
    const draft = raw.draft ?? false;
    const prerelease = raw.prerelease ?? false;
    if (!draft && !prerelease) hasAnyPublishedRelease = true;
    if (draft || !prerelease) continue;
    const projected = projectRelease(raw, htmlUrlFallback);
    if (
      candidate === null ||
      projected.publishedAt > candidate.publishedAt ||
      (projected.publishedAt === candidate.publishedAt && compareNumericId(projected.id, candidate.id) > 0)
    ) {
      candidate = projected;
    }
  }

  return {
    candidate,
    // 字段须与 PrereleaseProjection 逐字对应（原因见该类型注释）。
    windowLimit,
    observedCount: list.length,
    mayHaveMore: list.length >= windowLimit || hasNextLink,
    hasAnyPublishedRelease,
  };
}

/** 十进制文本形式的数字 ID 比较；长度不同先比长度，避免 Number 精度问题。 */
export function compareNumericId(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function parseBranchList(payload: unknown): { name: string }[] {
  const list = z.array(z.object({ name: z.string() })).parse(payload);
  return list.map((entry) => ({ name: entry.name }));
}

/** /user 只提取稳定数字 ID；其余私人字段一律投影丢弃。 */
export function parseAuthenticatedUser(payload: unknown): { accountId: string; login: string } {
  const raw = z
    .object({ id: z.union([z.number(), z.string()]), login: z.string().optional() })
    .parse(payload);
  return { accountId: String(raw.id), login: raw.login ?? '' };
}
