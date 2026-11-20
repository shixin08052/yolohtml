// Single-thread WASM and the exact frontend pixel pipeline, with one warmup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import * as ort from 'onnxruntime-web';
import { preprocess, postprocess, selectDetections } from '../src/vision/yolo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const img = jpeg.decode(fs.readFileSync(path.join(root, 'public/samples/real/IMG_9902.jpg')),
  { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
ort.env.wasm.numThreads = 1;
const rows = [];
for (const file of process.argv.slice(2)) {
  const metadata = JSON.parse(fs.readFileSync(file.replace(/\.onnx$/, '.json'), 'utf8'));
  const size = metadata.imgsz;
  const session = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'] });
  const start = performance.now();
  const { tensor, params } = preprocess(img, size);
  const prepMs = performance.now() - start;
  const feeds = { images: new ort.Tensor('float32', tensor, [1, 3, size, size]) };
  await session.run(feeds);
  const durations = [];
  let out;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const result = await session.run(feeds);
    durations.push(performance.now() - t);
    out = result[session.outputNames[0]];
  }
  const raw = postprocess(out.data, out.dims, params, img.width, img.height, { scoreThreshold: 0.25, iouThreshold: 0.5 });
  const dets = selectDetections(raw, { scoreThreshold: 0.4, lowThreshold: 0.25, dedupIou: 0.7, lowMaxIou: 0.3 });
  rows.push({ model: file, imgsz: size, prepMs, inferMs: durations.reduce((a, b) => a + b, 0) / durations.length,
    detections: dets.length, minScore: Math.min(...dets.map((d) => d.score)) });
  await session.release();
}
console.log(JSON.stringify(rows, null, 2));
