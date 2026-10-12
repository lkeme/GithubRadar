import { describe, expect, it } from 'vitest';

import {
  parseRepositoryInput,
  parseRepositoryInputs,
  splitRepositoryInputRows,
} from '../../apps/server/src/domain/input.js';

/**
 * 输入解析。
 * 合法的 5 种写法、URL 变体、错误码与单批 999 行上限。
 */

describe('parseRepositoryInput：合法写法', () => {
  it('接受 owner/repo 简写并保留展示大小写，去重键为小写', () => {
    const result = parseRepositoryInput('Owner/Repo');
    expect(result).toEqual({
      ok: true,
      value: {
        owner: 'Owner',
        repo: 'Repo',
        key: 'owner/repo',
        htmlUrl: 'https://github.com/Owner/Repo',
      },
    });
  });

  it('接受完整 URL 并去除查询参数与 fragment', () => {
    expect(parseRepositoryInput('https://github.com/owner/repo')).toEqual({
      ok: true,
      value: {
        owner: 'owner',
        repo: 'repo',
        key: 'owner/repo',
        htmlUrl: 'https://github.com/owner/repo',
      },
    });
    expect(parseRepositoryInput('https://github.com/owner/repo?tab=readme#install')).toEqual({
      ok: true,
      value: {
        owner: 'owner',
        repo: 'repo',
        key: 'owner/repo',
        htmlUrl: 'https://github.com/owner/repo',
      },
    });
  });

  it('接受末尾 .git 与末尾斜杠', () => {
    for (const raw of [
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo/',
      'https://github.com/owner/repo.git/',
      'owner/repo.git',
      'owner/repo/',
    ]) {
      const result = parseRepositoryInput(raw);
      expect(result, raw).toEqual({
        ok: true,
        value: {
          owner: 'owner',
          repo: 'repo',
          key: 'owner/repo',
          htmlUrl: 'https://github.com/owner/repo',
        },
      });
    }
  });

  it('去除首尾空白', () => {
    expect(parseRepositoryInput('  owner/repo  ')).toMatchObject({ ok: true });
  });
});

describe('parseRepositoryInput：错误码', () => {
  const cases: [string, string][] = [
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['\t', 'EMPTY'],
    ['owner', 'INVALID_FORMAT'],
    ['https://gitlab.com/owner/repo', 'BAD_HOST'],
    ['https://www.github.com/owner/repo', 'BAD_HOST'],
    ['http://github.com/owner/repo', 'INVALID_FORMAT'],
    ['ftp://github.com/owner/repo', 'INVALID_FORMAT'],
    ['https://user@github.com/owner/repo', 'USERINFO'],
    ['https://user:pass@github.com/owner/repo', 'USERINFO'],
    ['https://github.com:8443/owner/repo', 'BAD_PORT'],
    ['http://github.com:80/owner/repo', 'INVALID_FORMAT'],
    ['https://github.com/owner%2frepo', 'ENCODED_SLASH'],
    ['https://github.com/owner/re%5cpo', 'ENCODED_SLASH'],
    ['owner%2frepo', 'ENCODED_SLASH'],
    ['https://github.com/owner/repo/tree/main', 'SUB_PATH'],
    ['https://github.com/owner/repo/issues/1', 'SUB_PATH'],
    ['https://github.com/owner/repo/releases/latest', 'SUB_PATH'],
    ['owner/repo/extra', 'SUB_PATH'],
    ['https://github.com/owner', 'INVALID_FORMAT'],
    ['https://github.com/owner//repo', 'INVALID_FORMAT'],
    ['owner//repo', 'INVALID_FORMAT'],
    ['..', 'INVALID_FORMAT'],
    ['../repo', 'INVALID_FORMAT'],
    ['owner/..', 'INVALID_FORMAT'],
    ['owner/repo$', 'INVALID_FORMAT'],
    ['owner/re po', 'INVALID_FORMAT'],
    ['git@github.com:owner/repo', 'INVALID_FORMAT'],
  ];

  for (const [raw, error] of cases) {
    it(`${JSON.stringify(raw)} → ${error}`, () => {
      expect(parseRepositoryInput(raw)).toEqual({ ok: false, error });
    });
  }
});

describe('parseRepositoryInputs：批量与边界', () => {
  it('去除空行且合法/非法行分别归类，下标按非空行递增', () => {
    const result = parseRepositoryInputs('  owner/a  \n\nhttps://github.com/owner/b\nnot a repo\n', 999);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]?.key).toBe('owner/a');
    expect(result.accepted[1]?.key).toBe('owner/b');
    expect(result.rejected).toEqual([{ index: 2, raw: 'not a repo', error: 'INVALID_FORMAT' }]);
    expect(result.overflowCount).toBe(0);
  });

  it('批内重复行不去重（去重由导入批次按规范键合并）', () => {
    const result = parseRepositoryInputs('owner/a\nOWNER/A\n', 999);
    expect(result.accepted.map((item) => item.key)).toEqual(['owner/a', 'owner/a']);
    expect(result.rejected).toEqual([]);
  });

  it('超过 999 行的部分进入 overflowCount，不再解析', () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `owner/repo-${index}`);
    const result = parseRepositoryInputs(lines.join('\n'), 999);
    expect(result.accepted).toHaveLength(999);
    expect(result.rejected).toEqual([]);
    expect(result.overflowCount).toBe(1);
  });

  it('溢出行的原文保留下标连续，供导入批次逐项反馈', () => {
    const rows = splitRepositoryInputRows('owner/a\nowner/b\nowner/c', 2);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ index: 2, raw: 'owner/c', overflow: true, result: null });
  });

  it('空输入不产生任何行', () => {
    expect(parseRepositoryInputs('\n\n   \n', 999)).toEqual({
      accepted: [],
      rejected: [],
      overflowCount: 0,
    });
  });
});
