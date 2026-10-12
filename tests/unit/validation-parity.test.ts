import { describe, expect, it } from 'vitest';

import {
  PROXY_HOST_INVALID as CONTRACT_PROXY_HOST_INVALID,
  isValidGithubToken as contractGithubToken,
  isValidLabelColor as contractLabelColor,
  isValidProxyHost as contractProxyHost,
  isValidProxyUsername as contractProxyUsername,
  passwordPolicyViolation as contractPasswordViolation,
} from '@githubradar/contracts';
import {
  PROXY_HOST_INVALID,
  PROXY_PORT_INVALID,
  PROXY_USERNAME_INVALID,
  isValidGithubToken,
  isValidLabelColor,
  isValidPort,
  isValidProxyHost,
  isValidProxyUsername,
  passwordPolicyViolation,
} from '../../apps/web/src/lib/validation.js';

/**
 * 前后端校验同源。
 *
 * 前端不能运行时导入契约（zod 会进浏览器 bundle），所以规则在
 * `packages/contracts/src/network.ts` 与 `apps/web/src/lib/validation.ts` 各有一份。
 * 这个用例是两边的唯一强制绑定：同一输入集必须得到同一结论，文案也必须一致，
 * 任何一边单独改动都会在这里失败。
 */

const HOSTS = [
  '127.0.0.1',
  '10.1.2.3',
  '255.255.255.255',
  '256.1.1.1',
  '1.2.3',
  '1..2.3',
  '::1',
  '[::1]',
  'fe80::1',
  '2001:db8::5',
  '[2001:db8::5]',
  '::ffff:192.168.0.1',
  '2001:0db8:0000:0000:0000:0000:0000:0001',
  '2001:db8:::1',
  '1:2:3:4:5:6:7:8:9',
  'proxy',
  'localhost',
  'host.docker.internal',
  'vpn.example.com',
  '-bad.example',
  'bad-.example',
  'a..b',
  'bad host',
  'http://proxy',
  '',
  '   ',
  `${'x'.repeat(64)}.com`,
  `${'x'.repeat(250)}.com`,
];

const TOKENS = [
  'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
  'github_pat_11AA22BB33CC',
  '  ghp_padded  ',
  'ghp_has space',
  'Bearer ghp_x',
  'gho_oauth_token',
  '',
  'ghp_',
  `ghp_${'a'.repeat(600)}`,
];

const COLORS = ['#fff', '#1D4ED8', '#1d4ed8', '#1D4ED8FF', 'red', '1D4ED8', '#12', '#12345', 'rgb(1,2,3)', ''];

const PASSWORDS = [
  'short',
  'Abcdefg1',
  'Abcdefg1234567890',
  'abcdefg12',
  'TestPass1234!',
  'E2eLocal123!',
  'TestPass1234-',
  'TestPass1~',
  'TestPass1!',
  '测试密码测试密码',
  'a'.repeat(16),
  'Ab1!' + 'c'.repeat(13),
];

const USERNAMES = ['user', 'user name', 'user\u0000name', '', '   ', 'u'.repeat(255), 'u'.repeat(256)];

describe('前后端校验规则逐值一致', () => {
  it('代理主机', () => {
    for (const host of HOSTS) {
      expect(isValidProxyHost(host), host).toBe(contractProxyHost(host));
    }
  });

  it('代理端口：前端字符串版与服务端数值版覆盖同一区间', () => {
    // 契约用数值并在 network.ts 里给出统一文案；前端接收字符串输入，这里锁定拒绝集与文案。
    for (const value of ['0', '1', '80', '65535', '65536', '99999', '-1', '1.5', 'abc', '', ' 80', '00080']) {
      const accepted = isValidPort(value);
      expect(accepted, value).toBe(/^[0-9]{1,5}$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 65535);
    }
    expect(PROXY_PORT_INVALID).toBe('端口需为 1–65535 的整数');
  });

  it('代理账号', () => {
    for (const username of USERNAMES) {
      expect(isValidProxyUsername(username), JSON.stringify(username)).toBe(contractProxyUsername(username));
    }
    expect(PROXY_USERNAME_INVALID).toContain('控制字符');
  });

  it('GitHub Token', () => {
    for (const token of TOKENS) {
      expect(isValidGithubToken(token), token).toBe(contractGithubToken(token));
    }
  });

  it('标签颜色', () => {
    for (const color of COLORS) {
      expect(isValidLabelColor(color), color).toBe(contractLabelColor(color));
    }
  });

  it('密码策略：结论与文案都一致', () => {
    for (const password of PASSWORDS) {
      expect(passwordPolicyViolation(password), password).toBe(contractPasswordViolation(password));
    }
  });

  it('代理主机错误文案与契约一致', () => {
    expect(PROXY_HOST_INVALID).toBe(CONTRACT_PROXY_HOST_INVALID);
  });
});
