import { describe, expect, it } from 'vitest';

import { ConfigError, isSameOrigin, loadConfig } from '@githubradar/server';

const baseEnv = {
  PUBLIC_ORIGIN: 'https://radar.example.com',
  HOST: '0.0.0.0',
  PORT: '8080',
  NODE_ENV: 'production',
};

describe('部署配置', () => {
  it('读取完整环境变量并派生 Cookie/管理开关', () => {
    const config = loadConfig({ ...baseEnv });
    // 数据库路径是固定值（容器内为 /data/githubradar.sqlite），不来自部署环境；
    // 主密钥与初始密码同样不来自部署文件：主密钥由系统在库内生成，初始密码随机生成。
    expect(config.databasePath).toBe('data/githubradar.sqlite');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('production');
    expect(config.publicOrigin.cookieSecure).toBe(true);
    expect(config.publicOrigin.managementAllowed).toBe(true);
    expect(isSameOrigin(config.publicOrigin, 'https://radar.example.com')).toBe(true);
  });

  it('HOST、PORT、NODE_ENV 缺省时给出安全默认值', () => {
    const config = loadConfig({
      PUBLIC_ORIGIN: 'https://radar.example.com',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('development');
  });

  it('PUBLIC_ORIGIN 缺失时启动失败并指出字段', () => {
    const env: Record<string, string | undefined> = { ...baseEnv };
    delete env['PUBLIC_ORIGIN'];
    let caught: unknown;
    try {
      loadConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).field).toBe('PUBLIC_ORIGIN');
  });

  it('空字符串与缺省同等对待，不产生半配置状态', () => {
    expect(() => loadConfig({ ...baseEnv, PUBLIC_ORIGIN: '' })).toThrowError(/PUBLIC_ORIGIN/);
  });

  it('非法 PUBLIC_ORIGIN 在启动阶段被拒绝，而不是留到运行期', () => {
    for (const value of ['radar.example.com', 'ftp://radar.example.com', 'http://radar.example.com/app']) {
      let caught: unknown;
      try {
        loadConfig({ ...baseEnv, PUBLIC_ORIGIN: value });
      } catch (error) {
        caught = error;
      }
      expect(caught, value).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).field, value).toBe('PUBLIC_ORIGIN');
    }
  });

  it('端口必须是 1-65535 的十进制整数', () => {
    for (const value of ['0', '65536', 'abc', '80.5', '-1', ' 80']) {
      expect(() => loadConfig({ ...baseEnv, PORT: value }), value).toThrowError(/PORT/);
    }
    expect(loadConfig({ ...baseEnv, PORT: '65535' }).port).toBe(65535);
    expect(loadConfig({ ...baseEnv, PORT: '1' }).port).toBe(1);
  });

  it('NODE_ENV 只接受三个已知取值', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'test' }).nodeEnv).toBe('test');
  });

  it('非回环明文 HTTP 部署下后台登录被关闭，公开只读仍然可用', () => {
    const config = loadConfig({ ...baseEnv, PUBLIC_ORIGIN: 'http://192.168.1.20:8080' });
    expect(config.publicOrigin.managementAllowed).toBe(false);
    expect(config.publicOrigin.cookieSecure).toBe(false);
    expect(isSameOrigin(config.publicOrigin, 'http://192.168.1.20:8080')).toBe(true);
    expect(isSameOrigin(config.publicOrigin, 'http://192.168.1.20')).toBe(false);
  });

  it('受信反向代理默认关闭；只接受显式列出的 IP 或 CIDR', () => {
    // 默认不信任任何转发头：任意请求都不能用 X-Forwarded-For 伪造来源 IP。
    expect(loadConfig({ ...baseEnv }).trustedProxies).toEqual([]);
    expect(loadConfig({ ...baseEnv, TRUSTED_PROXY: '' }).trustedProxies).toEqual([]);

    expect(loadConfig({ ...baseEnv, TRUSTED_PROXY: '127.0.0.1' }).trustedProxies).toEqual(['127.0.0.1']);
    expect(loadConfig({ ...baseEnv, TRUSTED_PROXY: '10.0.0.0/8, ::1' }).trustedProxies).toEqual(['10.0.0.0/8', '::1']);

    // 宽松写法会让来源 IP 可被任意伪造，因此直接拒绝。
    for (const value of ['true', '*', 'all', 'proxy.local']) {
      expect(() => loadConfig({ ...baseEnv, TRUSTED_PROXY: value }), value).toThrowError(/TRUSTED_PROXY/);
    }
  });

  it('登录限速可按部署调整，但必须是正整数', () => {
    expect(loadConfig({ ...baseEnv }).loginRateLimitMax).toBe(5);
    expect(loadConfig({ ...baseEnv, AUTH_LOGIN_RATE_LIMIT: '20' }).loginRateLimitMax).toBe(20);
    for (const value of ['0', '-1', 'abc', '5.5']) {
      expect(() => loadConfig({ ...baseEnv, AUTH_LOGIN_RATE_LIMIT: value }), value).toThrowError(/AUTH_LOGIN_RATE_LIMIT/);
    }
  });
});
