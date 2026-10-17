// 零件检测 Web Worker：在后台线程里加载 ONNX 模型、前处理、推理、后处理，不卡界面。
// 设备支持 WebGPU 时加载带 WebGPU 的 onnxruntime-web（executionProviders: ['webgpu', 'wasm']），
// 不支持或 WebGPU 初始化失败时用纯 WASM 版本。wasm 文件在 public/ort/（scripts/copy-ort.mjs 复制）。
//
// 消息：
//   { id, type: 'init', modelUrl, ortBase, prefer }  → { backend, loadMs, fetchMs, createMs, modelBytes, inputs, outputs }
//   { id, type: 'detect', bitmap, scoreThreshold, lowThreshold, lowMaxIou, iouThreshold, dedupIou } → { raw, dets, dims, width, height, prepMs, inferMs, postMs }
//   raw 为置信度 ≥ lowThreshold 的原始框；dets 按 yolo.js 的 selectDetections 选出
import { preprocess, postprocess, selectDetections } from './yolo.js';

let ort = null;
let session = null;
let inputSize = 1024;

async function hasWebGPU() {
  try {
    if (!self.navigator?.gpu) return false;
    return !!(await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function init({ modelUrl, ortBase, prefer = 'auto' }) {
  const t0 = performance.now();
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`读取模型失败（${res.status}）：${modelUrl}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const t1 = performance.now();

  const tryGPU = prefer !== 'wasm' && (await hasWebGPU());
  let backend = 'wasm';
  if (tryGPU) {
    try {
      ort = await import('onnxruntime-web');
      configure(ortBase);
      session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
      backend = 'webgpu';
    } catch (err) {
      console.warn('WebGPU 初始化失败，改用 WASM：', err);
      session = null;
    }
  }
  if (!session) {
    ort = await import('onnxruntime-web/wasm');
    configure(ortBase);
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  const t2 = performance.now();
  const meta = (names, md) => names.map((n, i) => ({ name: n, shape: md?.[i]?.shape ?? null }));
  const inputs = meta(session.inputNames, session.inputMetadata);
  const outputs = meta(session.outputNames, session.outputMetadata);
  const s = inputs[0]?.shape;
  if (Array.isArray(s) && typeof s[2] === 'number') inputSize = s[2];
  return { backend, loadMs: t2 - t0, fetchMs: t1 - t0, createMs: t2 - t1, modelBytes: buf.byteLength, inputs, outputs, inputSize, threads: ort.env.wasm.numThreads };
}

function configure(ortBase) {
  ort.env.wasm.wasmPaths = ortBase;
  // WebGPU 下 onnxruntime 会把形状相关的小算子有意放到 CPU 上并打警告，不影响结果，只保留错误日志
  ort.env.logLevel = 'error';
  // 多线程需要页面跨源隔离（COOP / COEP），GitHub Pages 设置不了这两个响应头，这时只能单线程
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1;
}

async function detect({ bitmap, scoreThreshold, lowThreshold = scoreThreshold, lowMaxIou, iouThreshold, dedupIou }) {
  const W = bitmap.width;
  const H = bitmap.height;
  const t0 = performance.now();
  let img;
  try {
    if (!session) throw new Error('模型还没加载');
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    img = ctx.getImageData(0, 0, W, H);
  } finally {
    bitmap.close(); // 1200 万像素的照片约 48 MB，出错时也立即释放
  }
  const { tensor, params } = preprocess(img, inputSize);
  const t1 = performance.now();
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, inputSize, inputSize]) };
  const out = (await session.run(feeds))[session.outputNames[0]];
  const t2 = performance.now();
  const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  const raw = postprocess(data, out.dims, params, W, H, { scoreThreshold: Math.min(scoreThreshold, lowThreshold), iouThreshold });
  const dets = selectDetections(raw, { scoreThreshold, lowThreshold, dedupIou, lowMaxIou });
  const t3 = performance.now();
  return { raw, dets, dims: out.dims, width: W, height: H, prepMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2 };
}

async function handle(e) {
  const { id, type } = e.data;
  try {
    const result = type === 'init' ? await init(e.data) : type === 'detect' ? await detect(e.data) : null;
    if (result === null) throw new Error(`未知消息 ${type}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
}

// 消息逐条处理：同一个推理会话不能同时跑两次（WebGPU 下 session.run 会让出执行，两次交错会互相破坏）
let queue = Promise.resolve();
self.onmessage = (e) => {
  queue = queue.then(() => handle(e));
};
