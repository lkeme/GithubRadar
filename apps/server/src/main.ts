import { randomUUID } from 'node:crypto';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadOrCreateAppKey } from './security/secrets.js';
import { hashPassword } from './security/passwords.js';
import { createDatabase } from './db/client.js';
import { loadMigrations, runMigrations } from './db/migrate.js';
import { openDatabase } from './db/open.js';
import { describeFatal, ensureAdminAccount, formatInitialPasswordNotice } from './startup.js';
import { CredentialService } from './credentials/service.js';
import { GithubClient, extractRateLimit } from './integrations/github/client.js';
import { TransportProvider } from './integrations/transport/provider.js';
import { RateBudget } from './scheduler/budget.js';
import { JobQueue } from './scheduler/queue.js';
import { Scheduler } from './scheduler/runner.js';
import { RepositoryService } from './domain/repositories.js';
import { LabelService } from './domain/labels.js';
import { DiscoveryAdapter } from './api/discovery-adapter.js';
import { SHUTDOWN_GRACE_MS } from './scheduler/constants.js';

/**
 * 服务端入口。
 *
 * 启动顺序：配置验证 → 数据库打开 → 迁移 → 管理员初始化 → HTTP 监听 → 调度恢复。
 * 任一前置步骤失败都在监听之前以明确错误退出，不进入半初始化状态。
 */

async function main(): Promise<void> {
  const config = loadConfig();

  let client;
  try {
    client = openDatabase({ path: config.databasePath });
  } catch (error) {
    process.stderr.write(`${describeFatal(error)}\n`);
    process.exit(1);
  }

  // 生产迁移使用已审核的 SQL，在 HTTP 监听和调度启动前整体事务化执行。
  let migrationResult;
  try {
    migrationResult = runMigrations(client, loadMigrations());
  } catch (error) {
    process.stderr.write(`${describeFatal(error)}\n`);
    client.close();
    process.exit(1);
  }

  // 主密钥由系统自管理：首次启动生成并写入库内，之后读回同一值。
  let appKey: Buffer;
  try {
    appKey = loadOrCreateAppKey(client);
  } catch (error) {
    process.stderr.write(`${describeFatal(error)}\n`);
    client.close();
    process.exit(1);
  }

  const db = createDatabase(client);
  const now = (): number => Date.now();

  try {
    const admin = await ensureAdminAccount({ db, now }, { hashPassword });
    if (admin.initialPassword !== null) {
      process.stdout.write(formatInitialPasswordNotice(admin.initialPassword));
    }
  } catch (error) {
    process.stderr.write(`${describeFatal(error)}\n`);
    client.close();
    process.exit(1);
  }

  const credentials = new CredentialService({ db, appKey, now });
  // 重启后的已有 PAT 先置为 unverified，由第一个控制任务在线复核后再解锁业务。
  credentials.markRestartStale();
  const transport = new TransportProvider({
    credentials,
    describeProxy: () => {
      const view = credentials.readProxy();
      return { enabled: view.enabled, revision: view.revision };
    },
  });
  const budget = new RateBudget(db, now);
  budget.bindAccount(credentials.status().accountId);
  const queue = new JobQueue(db, randomUUID(), now);
  const clientGithub = new GithubClient({ db, transport, now });
  const repositoryService = new RepositoryService({
    db,
    queue,
    now,
    isBusinessReady: () => credentials.isReady(),
  });
  const labelService = new LabelService({ db, now });

  const discoveryEnabled = (): boolean => {
    const row = db.$client.prepare('SELECT discovery_enabled AS enabled FROM settings WHERE id = 1').get() as
      | { enabled: number }
      | undefined;
    return row?.enabled === 1;
  };
  const discovery = new DiscoveryAdapter({
    db,
    transport,
    now,
    isEnabled: discoveryEnabled,
    access: {
      readToken: () => credentials.readActiveToken(),
      observeRateLimit: (headers) => {
        const snapshot = extractRateLimit(headers, now());
        if (snapshot !== null) budget.observe(snapshot);
      },
      shouldAbort: () => !credentials.isReady(),
    },
  });

  const scheduler = new Scheduler(
    {
      db,
      queue,
      budget,
      client: clientGithub,
      transport,
      credentials,
      now,
      repositoryService,
      // 发现导入由调度器按每日窗口触发，走独立下载通道。
      discovery,
    },
    { ownerId: randomUUID() },
  );

  const app = await buildApp({
    config,
    db,
    appKey,
    now,
    gate: credentials,
    credentials,
    repositoryService,
    labelService,
    scheduler,
    budget,
    schemaVersion: migrationResult.schemaVersion,
    databasePath: config.databasePath,
    discovery,
    logger: true,
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    process.stderr.write(`${describeFatal(error)}\n`);
    transport.close();
    client.close();
    process.exit(1);
  }

  try {
    scheduler.start();
  } catch (error) {
    // 第二个实例会被 runtime_lock 拒绝；已监听的进程退出，不静默降级。
    process.stderr.write(`${describeFatal(error)}\n`);
    await app.close();
    transport.close();
    client.close();
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`收到 ${signal}，开始优雅停止\n`);
    const deadline = setTimeout(() => {
      client.close();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    try {
      // 先停止领取任务与关闭 HTTP 接收，再等待在途请求收尾。
      await scheduler.stop();
      await app.close();
      transport.close();
      client.close();
    } finally {
      clearTimeout(deadline);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
