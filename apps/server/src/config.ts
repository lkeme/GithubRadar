import { OriginConfigError, parsePublicOrigin, type PublicOrigin } from './origin.js';

/**
 * 部署环境配置。
 *
 * 这里只做环境变量的读取与校验，不读取 secret 文件内容，也不建立连接；
 * 密钥的实际使用在启动序列和凭证模块中完成，初始密码由启动序列随机生成。
 */

export type NodeEnv = 'development' | 'test' | 'production';

/**
 * 单文件数据库路径：固定值，不提供部署级覆盖。
 * 相对进程工作目录解析——容器内工作目录为 /（见 Dockerfile），落在数据卷
 * /data/githubradar.sqlite；本地开发从仓库根运行，落在 ./data/githubradar.sqlite。
 */
export const DATABASE_PATH = 'data/githubradar.sqlite';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  /** 单文件数据库路径，固定为 DATABASE_PATH。 */
  readonly databasePath: string;
  readonly publicOrigin: PublicOrigin;
  readonly host: string;
  readonly port: number;
  /** 登录接口的每 IP 每分钟上限；默认 5，部署可按需调整，端到端测试会提高它。 */
  readonly loginRateLimitMax: number;
  /**
   * 受信反向代理的地址列表；只有直连方是这些地址时才采用 `X-Forwarded-For`。
   * 为空表示完全不信任转发头（只信任部署明确配置的反向代理 IP）。
   */
  readonly trustedProxies: readonly string[];
}

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ConfigError';
    this.field = field;
  }
}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

function readRequired(env: NodeJS.ProcessEnv, field: string): string {
  const value = env[field];
  if (value === undefined || value === '') {
    throw new ConfigError(field, '必填环境变量缺失');
  }
  return value;
}

function readNodeEnv(env: NodeJS.ProcessEnv): NodeEnv {
  const value = env['NODE_ENV'];
  if (value === undefined || value === '') return 'development';
  if ((NODE_ENVS as readonly string[]).includes(value)) return value as NodeEnv;
  throw new ConfigError('NODE_ENV', `只支持 ${NODE_ENVS.join('/')}`);
}

function readPort(env: NodeJS.ProcessEnv): number {
  const value = env['PORT'];
  if (value === undefined || value === '') return 8080;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new ConfigError('PORT', '必须是 1-65535 的十进制整数');
  }
  const port = Number(value);
  if (port > 65535) {
    throw new ConfigError('PORT', '必须是 1-65535 的十进制整数');
  }
  return port;
}

function readPublicOrigin(env: NodeJS.ProcessEnv): PublicOrigin {
  const raw = readRequired(env, 'PUBLIC_ORIGIN');
  try {
    return parsePublicOrigin(raw);
  } catch (error) {
    if (error instanceof OriginConfigError) {
      throw new ConfigError('PUBLIC_ORIGIN', error.message.replace('PUBLIC_ORIGIN: ', ''));
    }
    throw error;
  }
}

function readLoginRateLimit(env: NodeJS.ProcessEnv): number {
  const value = env['AUTH_LOGIN_RATE_LIMIT'];
  if (value === undefined || value === '') return 5;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new ConfigError('AUTH_LOGIN_RATE_LIMIT', '必须是正整数（每分钟允许的登录次数）');
  }
  return Number(value);
}

function readTrustedProxies(env: NodeJS.ProcessEnv): readonly string[] {
  const value = env['TRUSTED_PROXY'];
  if (value === undefined || value.trim() === '') return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return [];
  for (const entry of entries) {
    // 只接受 IP 或 CIDR 形式；'true'、'*' 之类的宽松配置会让任意请求伪造来源 IP。
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry)) {
      throw new ConfigError('TRUSTED_PROXY', `只接受逗号分隔的 IP 或 CIDR，收到：${entry}`);
    }
  }
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    nodeEnv: readNodeEnv(env),
    databasePath: DATABASE_PATH,
    publicOrigin: readPublicOrigin(env),
    host: env['HOST'] === undefined || env['HOST'] === '' ? '0.0.0.0' : env['HOST'],
    port: readPort(env),
    loginRateLimitMax: readLoginRateLimit(env),
    trustedProxies: readTrustedProxies(env),
  };
}
