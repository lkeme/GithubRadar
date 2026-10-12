import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * 端到端固定装置 + 真实服务端启动。
 *
 * 由 Playwright 的 webServer 直接执行，顺序是：
 *   0. 先探测 PORT（默认 8787）是否被占用，被占用时给出明确的中文错误并退出；
 *   1. 重建 `.e2e-data/`（真实 SQLite 文件）；
 *   2. 用生产构建产物做迁移并写入可复核的种子数据（见 seedDashboard），
 *      同时播种固定口令的管理员账号（口令经 E2E_ADMIN_PASSWORD 传入——服务端
 *      自身不再提供初始密码配置项，测试用固定口令而不是解析启动日志）；
 *   3. 把工作目录切到 `.e2e-data/` 后加载生产构建的服务端入口：数据库路径固定为
 *      工作目录下的 data/githubradar.sqlite，正好落在上面重建的文件上
 *      （主密钥由服务端自行在库内生成）。
 *
 * 放在这里而不是 globalSetup，是因为 webServer 的启动时机早于 globalSetup，
 * 靠后者准备文件会出现「启动时读不到数据目录」。
 * 生成物都在 `.e2e-data/`，已在 .gitIgnore 中排除。
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = path.join(root, '.e2e-data');
const serverDist = path.join(root, 'apps', 'server', 'dist');

await assertPortAvailable(Number(process.env['PORT'] ?? 8787));

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(path.join(dataDir, 'data'), { recursive: true });

const { openDatabase, runMigrations, hashPassword } = await import(pathToFileURL(path.join(serverDist, 'index.js')).href);

const client = openDatabase({ path: path.join(dataDir, 'data', 'githubradar.sqlite') });
runMigrations(client);
seedDashboard(client);
await seedAdmin(client);
client.close();

// 服务端按工作目录下的 data/githubradar.sqlite 打开数据库，先切到 .e2e-data 再加载入口。
process.chdir(dataDir);
await import(pathToFileURL(path.join(serverDist, 'main.js')).href);

/** 播种固定口令的管理员账号，让用例免于解析一次性打印的随机初始密码。 */
async function seedAdmin(db) {
  const password = process.env['E2E_ADMIN_PASSWORD'] ?? 'E2eLocal123!';
  const hash = await hashPassword(password);
  db.prepare(
    'INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at) VALUES (1, ?, ?, 1, ?)',
  ).run('admin', hash, Date.now());
}

/**
 * 端口占用探测。
 *
 * 固定端口（默认 8787）被别的进程占用时，Playwright 只会报「等待 /health/ready 超时」，
 * 很难定位；这里先尝试 bind 一次，占用时直接以中文原因退出。
 * 不做自动换端口：用例与配置必须始终指向同一个地址，换端口会静默改变测试语义。
 */
function assertPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`[e2e] 端口 ${port} 已被占用，无法启动端到端测试用的服务端（默认 8787，可用 E2E_PORT 覆盖）。`);
        console.error('[e2e] 请先关闭占用该端口的进程后重试；本脚本不会自动更换端口。');
      } else {
        console.error(`[e2e] 探测端口 ${port} 失败：${error.message}`);
      }
      process.exit(1);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve());
    });
  });
}

/**
 * 界面验收需要真实的列表内容与状态分布，否则只能验证空态。
 * 这里直接写数据库（不经 GitHub），数据本身是明确的合成样本，不代表任何真实仓库。
 */
function seedDashboard(db) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const insertRepo = db.prepare(
    `INSERT INTO repositories
       (github_id, canonical_name, display_name, note, description, html_url, owner_avatar_url,
        is_private, language, stars, forks, archived, enabled, pin_order,
        interval_hours, release_enabled, include_prereleases, default_branch, verification_state,
        identity_verified_at, created_at, blocked_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?, 'verified', ?, ?, ?)`,
  );

  const repos = [
    {
      githubId: 900001,
      name: 'sample/active-project',
      displayName: '活跃示例',
      note: 'e2e 合成样本',
      description: '带正式版与分支变化的示例仓库',
      private: 0,
      language: 'TypeScript',
      stars: 12800,
      forks: 640,
      enabled: 1,
      pinOrder: 0,
      intervalHours: 3,
      includePrerelease: 1,
      branch: 'main',
      release: {
        id: '5001',
        tagName: 'v2.4.0',
        name: 'v2.4.0',
        publishedAt: iso(now - 2 * dayMs),
        prerelease: false,
        draft: false,
        htmlUrl: 'https://github.com/sample/active-project/releases/tag/v2.4.0',
      },
      prerelease: {
        candidate: {
          id: '5002',
          tagName: 'v2.5.0-rc.1',
          name: 'v2.5.0-rc.1',
          publishedAt: iso(now - 6 * 60 * 60 * 1000),
          prerelease: true,
          draft: false,
          htmlUrl: 'https://github.com/sample/active-project/releases/tag/v2.5.0-rc.1',
        },
        windowLimit: 20,
        observedCount: 20,
        mayHaveMore: true,
        hasAnyPublishedRelease: true,
      },
      head: { sha: 'a'.repeat(40), committedAt: iso(now - 5 * 60 * 60 * 1000) },
      change: now - 5 * 60 * 60 * 1000,
    },
    {
      githubId: 900002,
      name: 'sample/quiet-library',
      displayName: null,
      note: null,
      description: '只有正式版、没有近期变化的示例仓库',
      private: 1,
      language: 'Rust',
      stars: 3200,
      forks: 120,
      enabled: 1,
      pinOrder: null,
      intervalHours: null,
      includePrerelease: 0,
      branch: 'trunk',
      release: {
        id: '6001',
        tagName: 'v0.9.1',
        name: 'v0.9.1',
        publishedAt: iso(now - 40 * dayMs),
        prerelease: false,
        draft: false,
        htmlUrl: 'https://github.com/sample/quiet-library/releases/tag/v0.9.1',
      },
      prerelease: null,
      head: { sha: 'b'.repeat(40), committedAt: iso(now - 30 * dayMs) },
      change: null,
    },
    {
      githubId: 900003,
      name: 'sample/paused-tool',
      displayName: '暂停示例',
      note: null,
      description: null,
      private: 0,
      language: 'Go',
      stars: 750,
      forks: 33,
      enabled: 0,
      pinOrder: null,
      intervalHours: 24,
      includePrerelease: 0,
      branch: 'main',
      release: null,
      prerelease: null,
      head: { sha: 'c'.repeat(40), committedAt: iso(now - 9 * dayMs) },
      change: null,
    },
  ];

  for (const repo of repos) {
    const info = insertRepo.run(
      repo.githubId,
      repo.name,
      repo.displayName,
      repo.note,
      repo.description,
      `https://github.com/${repo.name}`,
      repo.private,
      repo.language,
      repo.stars,
      repo.forks,
      repo.enabled,
      repo.pinOrder,
      repo.intervalHours,
      repo.includePrerelease,
      repo.branch,
      now - dayMs,
      now - 30 * dayMs,
      null,
    );
    const repoId = Number(info.lastInsertRowid);

    const branchInfo = db
      .prepare("INSERT INTO tracked_branches (repo_id, mode, resolved_name, enabled) VALUES (?, 'default', ?, 1)")
      .run(repoId, repo.branch);
    const branchId = Number(branchInfo.lastInsertRowid);

    const insertStream = db.prepare(
      `INSERT INTO monitor_streams
         (repo_id, kind, branch_id, initialized_at, current_projection_json, detected_change_at,
          last_attempt_at, last_success_at, next_due_at, phase_seed, config_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    const lastSuccess = repo.change ?? now - 2 * 60 * 60 * 1000;

    insertStream.run(
      repoId,
      'metadata',
      null,
      now - 30 * dayMs,
      JSON.stringify({
        id: String(repo.githubId),
        fullName: repo.name,
        displayName: repo.displayName,
        description: repo.description,
        htmlUrl: `https://github.com/${repo.name}`,
        ownerAvatarUrl: null,
        isPrivate: repo.private === 1,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        archived: false,
        defaultBranch: repo.branch,
      }),
      null,
      lastSuccess,
      lastSuccess,
      now + dayMs,
      repo.githubId % 100000,
    );

    if (repo.release !== null) {
      insertStream.run(
        repoId,
        'release',
        null,
        now - 30 * dayMs,
        JSON.stringify(repo.release),
        repo.change,
        lastSuccess,
        lastSuccess,
        now + dayMs,
        (repo.githubId % 100000) + 7,
      );
    }
    if (repo.prerelease !== null) {
      insertStream.run(
        repoId,
        'prerelease',
        null,
        now - 30 * dayMs,
        JSON.stringify(repo.prerelease),
        repo.change,
        lastSuccess,
        lastSuccess,
        now + dayMs,
        (repo.githubId % 100000) + 11,
      );
    }

    insertStream.run(
      repoId,
      'branch',
      branchId,
      now - 30 * dayMs,
      JSON.stringify({
        sha: repo.head.sha,
        committedAt: repo.head.committedAt,
        htmlUrl: `https://github.com/${repo.name}/tree/${repo.branch}`,
      }),
      repo.change,
      lastSuccess,
      lastSuccess,
      now + dayMs,
      (repo.githubId % 100000) + 3,
    );

    // 趋势：近 14 天，缺失的日子不补零。
    const insertMetric = db.prepare(
      'INSERT INTO daily_metrics (repo_id, day, stars, forks, sampled_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let offset = 13; offset >= 0; offset -= 1) {
      if (offset === 6) continue;
      const sampledAt = now - offset * dayMs;
      const day = new Date(sampledAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      insertMetric.run(
        repoId,
        day,
        repo.stars - offset * 7,
        repo.forks - Math.floor(offset / 2),
        sampledAt,
        sampledAt,
      );
    }
  }
}
