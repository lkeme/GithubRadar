import { describe, expect, it } from 'vitest';

import { isAllowedHost, isSameOrigin, parsePublicOrigin } from '@githubradar/server';

describe('PUBLIC_ORIGIN 解析', () => {
  it('HTTPS 部署：Secure Cookie 与后台登录都允许', () => {
    const origin = parsePublicOrigin('https://radar.example.com');
    expect(origin.origin).toBe('https://radar.example.com');
    expect(origin.protocol).toBe('https:');
    expect(origin.hostname).toBe('radar.example.com');
    expect(origin.port).toBe(443);
    expect(origin.isLoopback).toBe(false);
    expect(origin.cookieSecure).toBe(true);
    expect(origin.managementAllowed).toBe(true);
  });

  it('非默认端口保留在规范化 origin 中，默认 443 被省略', () => {
    expect(parsePublicOrigin('https://radar.example.com:8443/').origin).toBe('https://radar.example.com:8443');
    expect(parsePublicOrigin('https://radar.example.com:443').origin).toBe('https://radar.example.com');
    expect(parsePublicOrigin('http://localhost:80').origin).toBe('http://localhost');
  });

  it('主机名按小写规范化', () => {
    expect(parsePublicOrigin('https://RADAR.Example.COM').origin).toBe('https://radar.example.com');
  });

  it('回环地址的明文 HTTP 只允许本机部署', () => {
    for (const raw of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://127.9.9.9', 'http://[::1]:8080']) {
      const origin = parsePublicOrigin(raw);
      expect(origin.isLoopback, raw).toBe(true);
      expect(origin.managementAllowed, raw).toBe(true);
      expect(origin.cookieSecure, raw).toBe(false);
    }
  });

  it('非回环的明文 HTTP 只提供公开只读面板，不允许后台登录', () => {
    const origin = parsePublicOrigin('http://radar.example.com');
    expect(origin.isLoopback).toBe(false);
    expect(origin.managementAllowed).toBe(false);
    expect(origin.cookieSecure).toBe(false);
  });

  it('拒绝协议、userinfo、路径、查询、fragment 与空白', () => {
    for (const raw of [
      'ftp://radar.example.com',
      'radar.example.com',
      'https://user:pass@radar.example.com',
      'https://radar.example.com/dashboard',
      'https://radar.example.com/?a=1',
      'https://radar.example.com#top',
      ' https://radar.example.com',
      'https://radar.example.com ',
      '',
    ]) {
      expect(() => parsePublicOrigin(raw), raw).toThrowError();
    }
  });
});

describe('Host 校验的边界形态', () => {
  it('IPv6、回环与端口写法都被钉死', () => {
    const loopbackV6 = parsePublicOrigin('http://[::1]:9000');
    // 回环 Host 分支还要求直连来源是回环地址（容器健康探针场景）。
    expect(isAllowedHost(loopbackV6, '[::1]:9000', 9000, '127.0.0.1')).toBe(true);
    expect(isAllowedHost(loopbackV6, 'localhost:9000', 9000, '::1')).toBe(true);
    expect(isAllowedHost(loopbackV6, '127.0.0.1:9000', 9000, '127.8.8.8')).toBe(true);
    expect(isAllowedHost(loopbackV6, '[::1]', 9000, '127.0.0.1')).toBe(false);
    expect(isAllowedHost(loopbackV6, '[::1]:9001', 9000, '127.0.0.1')).toBe(false);

    const remoteV6 = parsePublicOrigin('https://[2400:db8::1]:9000');
    expect(isAllowedHost(remoteV6, '[2400:db8::1]:9000', 8080, '203.0.113.9')).toBe(true);
    expect(isAllowedHost(remoteV6, '2400:db8::1:9000', 8080, '203.0.113.9')).toBe(false);
    expect(isAllowedHost(remoteV6, '[2400:db8::2]:9000', 8080, '203.0.113.9')).toBe(false);

    // 默认端口可省略也可显式写出；其他端口必须一致。
    const https = parsePublicOrigin('https://radar.example.com');
    expect(isAllowedHost(https, 'radar.example.com', 8080, '203.0.113.9')).toBe(true);
    expect(isAllowedHost(https, 'radar.example.com:443', 8080, '203.0.113.9')).toBe(true);
    expect(isAllowedHost(https, 'radar.example.com:8443', 8080, '203.0.113.9')).toBe(false);

    // 监听端口上的回环探针始终允许（容器健康检查），但仅限回环来源。
    expect(isAllowedHost(https, '127.0.0.1:8080', 8080, '127.0.0.1')).toBe(true);
    expect(isAllowedHost(https, '127.0.0.1:8081', 8080, '127.0.0.1')).toBe(false);
  });

  it('回环 Host 不能成为外部流量的通行证', () => {
    const https = parsePublicOrigin('https://radar.example.com');
    // 反代默认转发 `Host: 127.0.0.1:PORT` 时，来源是真实客户端：拒绝。
    expect(isAllowedHost(https, '127.0.0.1:8080', 8080, '203.0.113.9')).toBe(false);
    expect(isAllowedHost(https, 'localhost:8080', 8080, '192.0.2.10')).toBe(false);
    // IPv4 映射形式的回环来源同样视为回环。
    expect(isAllowedHost(https, '127.0.0.1:8080', 8080, '::ffff:127.0.0.1')).toBe(true);
  });
});

describe('Origin 精确比较', () => {
  const expected = parsePublicOrigin('https://radar.example.com');

  it('同源通过，默认端口写法差异不影响', () => {
    expect(isSameOrigin(expected, 'https://radar.example.com')).toBe(true);
    expect(isSameOrigin(expected, 'https://radar.example.com:443')).toBe(true);
    expect(isSameOrigin(expected, 'https://RADAR.example.com')).toBe(true);
  });

  it('后缀与子域伪造一律拒绝，不做前缀/后缀匹配', () => {
    for (const candidate of [
      'https://radar.example.com.evil.com',
      'https://evil-radar.example.com',
      'https://evil.com/radar.example.com',
      'http://radar.example.com',
      'https://radar.example.com:8443',
    ]) {
      expect(isSameOrigin(expected, candidate), candidate).toBe(false);
    }
  });

  it('缺失、null、空值、含空白与非法值一律拒绝', () => {
    for (const candidate of [null, undefined, '', 'null', ' https://radar.example.com', 'not a url']) {
      expect(isSameOrigin(expected, candidate), String(candidate)).toBe(false);
    }
  });

  it('带 userinfo 的候选不通过', () => {
    expect(isSameOrigin(expected, 'https://user@radar.example.com')).toBe(false);
  });
});
