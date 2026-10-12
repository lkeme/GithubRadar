import { openDatabase } from '../db/open.js';
import { runMigrations } from '../db/migrate.js';
import { generatePassword, hashPassword } from '../security/passwords.js';
import { formatInitialPasswordNotice } from '../startup.js';
import { DATABASE_PATH } from '../config.js';

/**
 * 本地密码重置 CLI。
 *
 * 忘记密码时由本地管理员在容器内执行：生成新的随机密码、写入新哈希、
 * 原子递增 auth_version 并撤销全部会话；新密码只打印到本次终端输出。
 * 数据库是工作目录下的 data/githubradar.sqlite（容器内为 /data 数据卷），
 * 必须与服务端在同一工作目录下运行才会操作同一个库。
 * 这是管理操作，不是数据恢复功能。
 *
 * 用法：
 *   node dist/cli/reset-password.js                     # 重置为随机新密码并打印
 *   node dist/cli/reset-password.js --clear-credentials # 主密钥遗失时显式清空加密凭证
 */

const args = process.argv.slice(2);
const clearCredentials = args.includes('--clear-credentials');

const client = openDatabase({ path: DATABASE_PATH });
runMigrations(client);

try {
  if (clearCredentials) {
    // 主密钥遗失时无法解密旧凭证：由本地管理员显式清空并重新配置，不静默重置。
    client.transaction(() => {
      client.prepare('DELETE FROM secrets').run();
      client
        .prepare(
          `UPDATE github_credential_status
              SET credential_state = 'missing', connectivity = 'unknown', token_type_hint = NULL,
                  expires_at = NULL, expires_observed_at = NULL, classic_scopes_json = NULL,
                  last_error_code = NULL, account_id = NULL, configured_at = NULL,
                  last_verified_at = NULL, last_authenticated_at = NULL, last_attempt_at = NULL,
                  credential_revision = credential_revision + 1,
                  gate_revision = gate_revision + 1
            WHERE id = 1`,
        )
        .run();
      // 代理密码与密文一起被删掉，但 proxy_config.enabled 若仍为 1，出站会继续走
      // 一条已无凭据的坏链路：同一事务里一并关闭代理并递增版本，让界面看到最新配置。
      client.prepare('UPDATE proxy_config SET enabled = 0, revision = revision + 1 WHERE id = 1').run();
    })();
    process.stdout.write('已清空加密凭证并关闭代理，请在管理界面重新配置 PAT 与代理。\n');
  }

  const password = generatePassword();
  const hash = await hashPassword(password);
  const now = Date.now();
  client.transaction(() => {
    const existing = client.prepare('SELECT id FROM admin_account WHERE id = 1').get();
    if (existing === undefined) {
      client
        .prepare(
          'INSERT INTO admin_account (id, username, password_hash, auth_version, password_changed_at) VALUES (1, ?, ?, 1, ?)',
        )
        .run('admin', hash, now);
    } else {
      client
        .prepare(
          'UPDATE admin_account SET password_hash = ?, auth_version = auth_version + 1, password_changed_at = ? WHERE id = 1',
        )
        .run(hash, now);
    }
    client.prepare('DELETE FROM sessions').run();
  })();
  process.stdout.write(formatInitialPasswordNotice(password));
} finally {
  client.close();
}
