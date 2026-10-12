import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { registerRoute, type RoutePolicyGuard } from './http/policy.js';

/**
 * 同源静态服务。
 *
 * 设计要点：
 * - 只注册 web 构建目录里**真实存在**的文件路由（`wildcard: false`），不使用 `/*` 通配。
 *   通配会把未知 `/api/*` 也吞进静态服务，导致未知接口返回文件服务的 404/500 而不是
 *   JSON 信封，也违背「未知 API 不回退静态服务」。
 * - 关闭目录列表与点文件访问；生产 source map 不进入构建产物。
 * - SPA shell 只对明确允许的页面路径返回，并且是声明过策略的正常路由。
 */

/** 与 `dist/static.js` 相隔两级即仓库/容器中的 web 构建目录。 */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export const SPA_ROUTES: readonly string[] = ['/', '/discover', '/trends', '/login', '/settings', '/jobs'];

/** 递归列出可公开的静态文件（相对 webDist 的 POSIX 路径），跳过点文件与 source map。 */
export function listPublicAssets(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listPublicAssets(root, relative));
      continue;
    }
    if (relative.endsWith('.map')) continue;
    files.push(relative);
  }
  return files;
}

export interface StaticOptions {
  readonly webDist?: string;
  readonly enabled?: boolean;
}

export const MISSING_SHELL =
  '<!doctype html><meta charset="utf-8"><title>Github雷达</title><p>前端尚未构建。</p>';

/**
 * 注册静态资源与 SPA shell。
 *
 * 返回是否真的提供了前端资源；未构建时服务端仍可启动，健康探针与 API 不受影响，
 * 页面路由返回 503 并说明原因，而不是伪装成正常页面。
 */
export function registerStaticRoutes(
  app: FastifyInstance,
  guard: RoutePolicyGuard,
  options: StaticOptions,
): boolean {
  const webDist = options.webDist ?? process.env['WEB_DIST_PATH'] ?? DEFAULT_WEB_DIST;
  const indexPath = path.join(webDist, 'index.html');
  const enabled = options.enabled !== false && existsSync(indexPath);

  const pagePolicy = {
    access: 'public_read',
    tokenGate: 'exempt',
    tokenGateExemptReason: 'static_and_health',
  } as const;

  if (!enabled) {
    for (const route of SPA_ROUTES) {
      registerRoute(app, guard, {
        method: 'GET',
        url: route,
        policy: pagePolicy,
        handler: async (_request, reply) => {
          void reply.status(503).type('text/html; charset=utf-8').send(MISSING_SHELL);
        },
      });
    }
    return false;
  }

  const shell = readFileSync(indexPath, 'utf8');

  // 先逐个文件声明策略，再交给插件注册：任何新增文件都会被覆盖，未列出的路径不会命中静态服务。
  // index.html 也在列表里——插件会为它注册 HEAD，因此同样需要显式策略。
  for (const asset of listPublicAssets(webDist)) {
    guard.allowPluginRoute('GET', `/${asset}`, pagePolicy);
    guard.allowPluginRoute('HEAD', `/${asset}`, pagePolicy);
  }

  void app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    index: false,
    list: false,
    dotfiles: 'deny',
    wildcard: false,
    serveDotFiles: false,
    // 构建产物文件名带内容 hash，可以长期 immutable。
    maxAge: '1y',
    immutable: true,
    // 但只有 `assets/` 这类内容哈希目录能套用上面的 immutable；白名单之外
    // （index.html、顶层 public/ 原样拷贝的文件、未来出现的未知子目录）一律回到
    // 协商缓存。用黑名单反过来写的话，任何新增的未哈希文件都会默认被缓存一年。
    setHeaders: (reply, filePath) => {
      const relative = path.relative(webDist, filePath).split(path.sep).join('/');
      if (relative.startsWith('assets/')) return;
      reply.header('cache-control', 'no-cache');
    },
  });

  for (const route of SPA_ROUTES) {
    registerRoute(app, guard, {
      method: 'GET',
      url: route,
      policy: pagePolicy,
      handler: async (_request, reply) => {
        void reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').status(200).send(shell);
      },
    });
  }

  return true;
}
