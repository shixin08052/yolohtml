import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 多页面：index（主页面）；board.html、synth.html 在后续步骤加入
export default defineConfig({
  // 相对路径，便于部署到 GitHub Pages 的子路径（/yolohtml/）
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
