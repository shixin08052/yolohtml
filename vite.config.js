import { defineConfig, defaultClientConditions } from 'vite';
import { resolve } from 'node:path';

/**
 * js-aruco2 的源码用顶层 `this.AR = AR`、`this.CV || require(...)` 导出，
 * Node 按 CommonJS 加载没问题，但打包器把它当成 ES 模块（顶层 this 为 undefined）。
 * 这里把这几处 `this.X` 改成 `exports.X`，让打包器识别为 CommonJS。不改动 npm 包本身。
 */
function jsArucoCommonJS() {
  const filter = /js-aruco2[\\/]src[\\/].*\.js$/;
  return {
    name: 'js-aruco2-commonjs',
    transform(code, id) {
      if (!filter.test(id)) return null;
      return { code: code.replace(/^(\s*(?:var \w+ = )?)this\.(AR|CV|POS|SVD)\b/gm, '$1exports.$2'), map: null };
    },
  };
}

// 多页面：index（主页面）、board（标定板）、synth（合成测试图）
export default defineConfig({
  // 相对路径，便于部署到 GitHub Pages 的子路径（/yolohtml/）
  base: './',
  plugins: [jsArucoCommonJS()],
  resolve: {
    // onnxruntime-web 默认入口会把 wasm 文件一起打包进 assets（约 42 MB）；这个条件选用"外部 wasm"版本，
    // 运行时从 public/ort/ 按 env.wasm.wasmPaths 加载（scripts/copy-ort.mjs 复制），避免重复
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  // Worker 里有动态 import（按设备选 WebGPU / WASM 版本），需要 ES 模块格式
  worker: { format: 'es' },
  optimizeDeps: {
    // 开发模式的依赖预打包不走上面的 plugins，需要单独挂一次
    rolldownOptions: { plugins: [jsArucoCommonJS()] },
    // 提前声明深层引入的文件，避免开发时首次用到才发现、触发整页刷新
    include: ['js-aruco2', 'js-aruco2/src/cv.js', 'js-aruco2/src/dictionaries/aruco_4x4_1000.js'],
  },
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        board: resolve(import.meta.dirname, 'board.html'),
        synth: resolve(import.meta.dirname, 'synth.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
});
