import type { FastifyInstance } from 'fastify';

import { probeDatabase, readDatabasePragmas, type SqliteDatabase } from '../db/open.js';
import type { RoutePolicyGuard } from '../http/policy.js';
import { registerRoute } from '../http/policy.js';
import type { AppDependencies } from '../app.js';

/**
 * 容器探针。
 *
 * live 只确认进程响应；ready 确认数据库可读和迁移完成。
 * 两者都只有最小状态码与 ok，无版本、路径或配置细节，也不依赖 GitHub 在线。
 * 部署 readiness 不等于业务就绪，二者不可混淆。
 */

export interface HealthDependencies {
  readonly db: SqliteDatabase;
  readonly schemaVersion: string | null;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  guard: RoutePolicyGuard,
  deps: Pick<AppDependencies, 'db' | 'schemaVersion'>,
): void {
  const healthDeps: HealthDependencies = { db: deps.db.$client, schemaVersion: deps.schemaVersion };

  registerRoute(app, guard, {
    method: 'GET',
    url: '/health/live',
    policy: { access: 'health', tokenGate: 'exempt', tokenGateExemptReason: 'static_and_health' },
    handler: async (_request, reply) => {
      void reply.status(200).send({ status: 'ok' });
    },
  });

  registerRoute(app, guard, {
    method: 'GET',
    url: '/health/ready',
    policy: { access: 'health', tokenGate: 'exempt', tokenGateExemptReason: 'static_and_health' },
    handler: async (_request, reply) => {
      const ok = healthReady(healthDeps);
      void reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
    },
  });
}

export function healthReady(deps: HealthDependencies): boolean {
  try {
    if (!probeDatabase(deps.db)) return false;
    const pragmas = readDatabasePragmas(deps.db);
    if (!pragmas.foreignKeys) return false;
    if (deps.schemaVersion === null) return false;
    const row = deps.db
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { count: number };
    return row.count === 1;
  } catch {
    return false;
  }
}
