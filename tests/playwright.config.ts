import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端验收。
 *
 * 直接启动真实服务端（生产构建产物 + 真实临时 SQLite），不 mock 应用路由；
 * PUBLIC_ORIGIN 使用回环地址，因此明文 HTTP 下后台管理可用，与本地开发部署一致。
 * 启动前由 `e2e/start-server.mjs` 重建 `.e2e-data/` 下的数据库、写入合成种子数据
 * 并播种固定口令的管理员账号（主密钥由服务端启动时自行生成）。
 */

const PORT = Number(process.env['E2E_PORT'] ?? 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * 端到端固定口令：可用 `E2E_ADMIN_PASSWORD` 覆盖。
 * 同一取值既传给 start-server.mjs 播种管理员账号，也被 e2e 用例用于登录，
 * 避免两处各写一份常量后漂移。
 */
export const E2E_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? 'E2eLocal123!';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node "${ROOT}/tests/e2e/start-server.mjs"`,
    cwd: ROOT,
    url: `${ORIGIN}/health/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      PUBLIC_ORIGIN: ORIGIN,
      TZ: 'Asia/Shanghai',
      // 服务端不再提供初始密码配置项，管理员固定口令由 start-server.mjs 直接播种到空库里。
      E2E_ADMIN_PASSWORD: E2E_PASSWORD,
      // 端到端用例都从 127.0.0.1 登录，远超生产默认的 5 次/分钟；
      // 限速本身由集成用例单独验证，这里只提高本测试实例的上限。
      AUTH_LOGIN_RATE_LIMIT: '200',
    },
  },
});

export const E2E_ORIGIN = ORIGIN;
export const E2E_PORT = PORT;
