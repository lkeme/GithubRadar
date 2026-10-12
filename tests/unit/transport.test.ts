import { describe, expect, it } from 'vitest';

import { buildProxyUrl } from '@githubradar/server';

/**
 * 代理 URL 构造。
 *
 * 校验层接受 IPv4、带/不带方括号的 IPv6 与主机名，这里锁定"通过校验的取值
 * 一定能拼出合法 URL"：裸 IPv6 必须归一化，认证明文必须编码，SOCKS 固定 socks5h。
 */

describe('buildProxyUrl', () => {
  it('IPv6 归一化为带方括号的 host', () => {
    for (const host of ['::1', '[::1]', '2001:db8::5', '[2001:db8::5]']) {
      const url = buildProxyUrl({ scheme: 'http', host, port: 3128, username: null, password: null });
      expect(url, host).toMatch(/^http:\/\/\[[0-9a-fA-F:]+\]:3128$/);
      // 拼出来的 URL 必须能被 URL 解析器接受（解析失败会直接抛）。
      expect(new URL(url).port).toBe('3128');
    }
    expect(buildProxyUrl({ scheme: 'http', host: '::1', port: 3128, username: null, password: null })).toBe(
      'http://[::1]:3128',
    );
  });

  it('主机名与 IPv4 保持原样', () => {
    expect(buildProxyUrl({ scheme: 'https', host: 'host.docker.internal', port: 8443, username: null, password: null })).toBe(
      'https://host.docker.internal:8443',
    );
    expect(buildProxyUrl({ scheme: 'http', host: '172.17.0.1', port: 3128, username: null, password: null })).toBe(
      'http://172.17.0.1:3128',
    );
  });

  it('SOCKS5 固定为 socks5h，认证字符按 URL 规则编码', () => {
    const url = buildProxyUrl({
      scheme: 'socks5',
      host: 'proxy.local',
      port: 1080,
      username: 'user name',
      password: 'p@ss:word',
    });
    expect(url.startsWith('socks5h://')).toBe(true);
    expect(url).toContain('user%20name:p%40ss%3Aword@');
    expect(url.endsWith('@proxy.local:1080')).toBe(true);
  });
});
