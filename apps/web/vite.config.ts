import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 构建产物由后端同源提供，因此 base 固定为 '/'，代码内一律使用相对路径 /api/v1/...。
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    // 禁止生产 source map 公开。
    sourcemap: false,
  },
});
