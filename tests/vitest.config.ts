import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts', 'integration/**/*.test.ts'],
    environment: 'node',
    // 迁移与约束测试使用真实临时 SQLite 文件，Windows 上首次 WAL 提交略慢。
    testTimeout: 30_000,
  },
});
