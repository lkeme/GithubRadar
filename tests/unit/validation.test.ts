import { describe, expect, it } from 'vitest';

import {
  GITHUB_TOKEN_INVALID,
  LABEL_COLOR_INVALID,
  PROXY_HOST_INVALID,
  GithubToken,
  LabelColor,
  Password,
  ProxyHost,
  ProxyUsername,
  isValidGithubToken,
  isValidLabelColor,
  isValidProxyHost,
  passwordPolicyViolation,
} from '@githubradar/contracts';
import { AppError, assertPasswordPolicy, generatePassword } from '@githubradar/server';

/**
 * 输入校验规则。
 *
 * 这里锁定的是服务端契约里的规则本身：前端的等价实现
 * （`apps/web/src/lib/validation.ts`）必须与这些用例保持一致的行为。
 */

describe('代理主机校验', () => {
  it('接受 IPv4、IPv6（含方括号）与合法主机名', () => {
    for (const host of [
      '127.0.0.1',
      '10.1.2.3',
      '255.255.255.255',
      'proxy',
      'localhost',
      'host.docker.internal',
      'vpn.example.com',
      '::1',
      'fe80::1',
      '[::1]',
      '[2001:db8::1]',
      '::ffff:192.168.0.1',
      '2001:0db8:0000:0000:0000:0000:0000:0001',
    ]) {
      expect(isValidProxyHost(host), host).toBe(true);
    }
  });

  it('拒绝空值、歧义的纯数字写法、非法字符与超长主机名', () => {
    for (const host of [
      '',
      '   ',
      '1.2.3',
      '256.1.1.1',
      '999.999.999.999',
      'host name',
      'http://proxy',
      '-bad.example',
      'bad-.example',
      'a..b',
      '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9',
      `${'x'.repeat(64)}.com`,
    ]) {
      expect(isValidProxyHost(host), host).toBe(false);
    }
  });

  it('契约 schema 给出可展示的字段错误', () => {
    const invalid = ProxyHost.safeParse('bad host');
    expect(invalid.success).toBe(false);
    expect(invalid.error?.issues[0]?.message).toBe(PROXY_HOST_INVALID);

    expect(ProxyHost.safeParse('proxy.internal').success).toBe(true);
    // 账号同样受边界约束：控制字符会破坏代理握手。
    expect(ProxyUsername.safeParse('user\u0000name').success).toBe(false);
  });
});

describe('GitHub Token 校验', () => {
  it('只接受 ghp_ 与 github_pat_ 前缀且不含空白字符', () => {
    expect(isValidGithubToken('ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(isValidGithubToken('github_pat_11AA22BB33CC')).toBe(true);
    expect(isValidGithubToken('  ghp_padded  ')).toBe(true);
    expect(isValidGithubToken('ghp_has space')).toBe(false);
    expect(isValidGithubToken('Bearer ghp_x')).toBe(false);
    expect(isValidGithubToken('gho_oauth_token')).toBe(false);
    expect(isValidGithubToken('')).toBe(false);

    const result = GithubToken.safeParse('ghp_has space');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(GITHUB_TOKEN_INVALID);
    // 契约会去除首尾空白后再判断，避免"看起来对但存进去带空格"。
    const trimmed = GithubToken.parse('  ghp_0123456789abcdefghijklmnopqrstuvwxyz  ');
    expect(trimmed).toBe('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
  });
});

describe('标签颜色校验', () => {
  it('只接受 #RGB / #RRGGBB / #RRGGBBAA', () => {
    for (const color of ['#fff', '#1D4ED8', '#1d4ed8', '#1D4ED8FF']) {
      expect(isValidLabelColor(color), color).toBe(true);
      expect(LabelColor.safeParse(color).success, color).toBe(true);
    }
    for (const color of ['red', '1D4ED8', '#12', '#12345', 'rgb(1,2,3)']) {
      expect(isValidLabelColor(color), color).toBe(false);
      expect(LabelColor.safeParse(color).success, color).toBe(false);
    }
    const message = LabelColor.safeParse('red').error?.issues[0]?.message;
    expect(message).toBe(LABEL_COLOR_INVALID);
  });
});

describe('密码策略', () => {
  it('长度、字符集合与组成', () => {
    expect(passwordPolicyViolation('Abc123')).toBe('密码至少 8 个字符');
    expect(passwordPolicyViolation('Abcdefg1234567890')).toBe('密码最多 16 个字符');
    // 只含小写与数字：缺大写，拒绝。
    expect(passwordPolicyViolation('abcdefg12')).toContain('大写字母');
    // 三类齐备：通过。
    expect(passwordPolicyViolation('Abcdefg1')).toBeNull();
    expect(passwordPolicyViolation('TestPass1234!')).toBeNull();
    // 特殊字符只允许 !@#$%^&*：连字符与其他符号一律拒绝。
    expect(passwordPolicyViolation('TestPass1234-')).toContain('只能包含');
    expect(passwordPolicyViolation('TestPass1234~')).toContain('只能包含');
    for (const symbol of '!@#$%^&*') {
      expect(passwordPolicyViolation(`TestPass1${symbol}`), symbol).toBeNull();
    }
    // 非 ASCII 字符同样不在允许集合内。
    expect(passwordPolicyViolation('测试密码测试密码')).toContain('只能包含');
  });

  it('哈希入口使用同一规则', () => {
    // 违规按边界校验信封抛出：VALIDATION_FAILED + 字段级说明，而不是独立错误类逃逸成 500。
    let caught: unknown = null;
    try {
      assertPasswordPolicy('weak');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION_FAILED');
    expect((caught as AppError).fields?.['newPassword']).toBe('密码至少 8 个字符');
    expect(() => assertPasswordPolicy('TestPass1234!')).not.toThrowError();
  });

  it('契约拒绝弱密码并接受合规密码', () => {
    expect(Password.safeParse('weak').success).toBe(false);
    expect(Password.safeParse('TestPass1234!').success).toBe(true);
    // 字段错误必须是具体违规说明，而不是笼统的"密码不合规"（前端会原样展示）。
    expect(Password.safeParse('weak').error?.issues[0]?.message).toBe('密码至少 8 个字符');
    expect(Password.safeParse('abcdefg12').error?.issues[0]?.message).toContain('大写字母');
    expect(Password.safeParse('TestPass1234-').error?.issues[0]?.message).toContain('只能包含');
  });

  it('随机生成的密码总是满足策略，且不是固定值', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const password = generatePassword();
      expect(passwordPolicyViolation(password), password).toBeNull();
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(16);
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });
});
