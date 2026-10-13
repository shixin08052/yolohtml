// 把 onnxruntime-web 的 wasm 文件复制到 public/ort/（npm run dev / build 前自动执行，不进仓库）。
// - ort-wasm-simd-threaded.jsep.*：带 WebGPU 的版本（设备支持 WebGPU 时用）
// - ort-wasm-simd-threaded.*：纯 WASM 版本（更小，没有 WebGPU 时用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(root, 'public', 'ort');
const files = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
fs.mkdirSync(dst, { recursive: true });
for (const f of files) {
  const a = path.join(src, f);
  const b = path.join(dst, f);
  const sa = fs.statSync(a);
  if (fs.existsSync(b) && fs.statSync(b).size === sa.size && fs.statSync(b).mtimeMs >= sa.mtimeMs) continue;
  fs.copyFileSync(a, b);
  console.log(`复制 ${f}（${(sa.size / 1e6).toFixed(1)} MB）→ public/ort/`);
}
