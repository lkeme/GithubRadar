import { eq } from 'drizzle-orm';

import { AppKeyError } from './security/secrets.js';
import { generatePassword } from './security/passwords.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';

/**
 * 启动辅助：管理员初始化、初始密码提示与致命错误格式化；
 * 启动顺序的编排在 main.ts。
 *
 * Token 未配置不会让容器无限重启：采集停止并显示待配置，业务由门禁锁定。
 * 主密钥与初始密码都不依赖部署文件：主密钥由系统在库内生成并自管理，
 * 初始密码由系统随机生成并只打印在首次启动日志里。
 */

export interface AdminInitDeps {
  readonly db: import('./db/client.js').Database;
  readonly now: () => number;
}

export interface AdminInitResult {
  readonly created: boolean;
  /** 本次创建实际生效的初始密码；`created` 为 false 时为 null。 */
  readonly initialPassword: string | null;
}

/**
 * 空库时建立管理员：初始密码由系统随机生成；已有账号不被启动流程覆盖。
 */
export async function ensureAdminAccount(
  deps: AdminInitDeps,
  options: {
    readonly hashPassword: (password: string) => Promise<string>;
  },
): Promise<AdminInitResult> {
  const existing = deps.db.$client.prepare('SELECT id FROM admin_account WHERE id = 1').get();
  if (existing !== undefined) {
    return { created: false, initialPassword: null };
  }
  const password = generatePassword();
  const hash = await options.hashPassword(password);
  deps.db.$client
    .prepare(
      'INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at) VALUES (1, ?, ?, 1, ?)',
    )
    .run('admin', hash, deps.now());
  return { created: true, initialPassword: password };
}

/** 首次初始化时打印到启动日志的初始密码提示（只在创建当次输出，不落盘）。 */
export function formatInitialPasswordNotice(password: string): string {
  return [
    '',
    '================ 初始管理员账号 ================',
    '  用户名：admin',
    `  初始密码：${password}`,
    '  该密码只在本次启动日志中出现，请登录后立即在“系统设置”中修改。',
    '================================================',
    '',
    '',
  ].join('\n');
}

export function describeFatal(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof AppKeyError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export { loadConfig, type AppConfig, eq };
