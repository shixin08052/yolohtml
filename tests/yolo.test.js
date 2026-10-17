import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import * as ort from 'onnxruntime-web';
import { pyRound, letterboxParams, preprocess, unletterbox, iou, nmsByClass, outputLayout, postprocess } from '../src/vision/yolo.js';

describe('前处理参数', () => {
  it('Python 的 round：.5 取偶数', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, 127.9].map(pyRound)).toEqual([0, 2, 2, 2, 3, 128]);
  });

  it('4032 × 3024 → 1024：宽铺满、上下各填 128', () => {
    const p = letterboxParams(4032, 3024, 1024);
    expect([p.nw, p.nh, p.padX, p.padY]).toEqual([1024, 768, 0, 128]);
    const q = letterboxParams(3024, 4032, 1024);
    expect([q.nw, q.nh, q.padX, q.padY]).toEqual([768, 1024, 128, 0]);
  });

  it('前处理：填充为灰 114，NCHW 排列，RGB 顺序，除以 255', () => {
    // 4 × 2 的图（每个像素 R = 10·x, G = 100, B = 200），缩放到 4 × 4：宽不变，上下各填 1 行
    const W = 4;
    const H = 2;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([10 * x, 100, 200, 255], (y * W + x) * 4);
    const { tensor, params } = preprocess({ width: W, height: H, data }, 4);
    expect([params.nw, params.nh, params.padX, params.padY]).toEqual([4, 2, 0, 1]);
    const at = (c, y, x) => tensor[c * 16 + y * 4 + x];
    expect(at(0, 0, 0)).toBeCloseTo(114 / 255, 6); // 填充行
    expect(at(2, 3, 3)).toBeCloseTo(114 / 255, 6);
    expect(at(0, 1, 2)).toBeCloseTo(20 / 255, 6); // R
    expect(at(1, 2, 3)).toBeCloseTo(100 / 255, 6); // G
    expect(at(2, 1, 0)).toBeCloseTo(200 / 255, 6); // B
  });

  it('缩小时的采样位置与 OpenCV INTER_LINEAR 一致：x = (dx + 0.5)·s − 0.5', () => {
    // 1 行 8 像素，R = 0..70，缩到 4 像素：采样位置 0.5, 2.5, 4.5, 6.5 → 值 5, 25, 45, 65
    const data = new Uint8ClampedArray(8 * 4);
    for (let x = 0; x < 8; x++) data.set([10 * x, 0, 0, 255], x * 4);
    const { tensor } = preprocess({ width: 8, height: 1, data }, 4);
    // 8 × 1 → 4 × 1（pyRound(0.5) = 0 高度… 用 8 × 2 更稳）
    expect(tensor.length).toBe(3 * 16);
    const data2 = new Uint8ClampedArray(8 * 2 * 4);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) data2.set([10 * x, 0, 0, 255], (y * 8 + x) * 4);
    const t2 = preprocess({ width: 8, height: 2, data: data2 }, 4);
    expect([t2.params.nw, t2.params.nh]).toEqual([4, 1]);
    const row = t2.params.padY * 4;
    expect([0, 1, 2, 3].map((x) => Math.round(t2.tensor[row + x] * 255))).toEqual([5, 25, 45, 65]);
  });

  it('框还原到原图：减填充、除以缩放比、裁到图内', () => {
    const p = letterboxParams(4032, 3024, 1024);
    const b = unletterbox([0, 128, 512, 512], p, 4032, 3024);
    expect(b.map((v) => +v.toFixed(6))).toEqual([0, 0, 2016, 1512]);
    expect(unletterbox([-10, 100, 2000, 1000], p, 4032, 3024)).toEqual([0, 0, 4032, 3024]);
  });
});

describe('后处理', () => {
  const p = letterboxParams(1024, 1024, 1024);

  it('IoU 与同类去重：同类重叠的只留高分，不同类不互相去掉', () => {
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3, 9);
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    const dets = [
      { cls: 2, score: 0.73, box: [0, 0, 100, 50] },
      { cls: 2, score: 0.57, box: [1, 0, 100, 50] },
      { cls: 0, score: 0.6, box: [0, 0, 100, 50] },
      { cls: 2, score: 0.9, box: [300, 0, 400, 50] },
    ];
    const k = nmsByClass(dets, 0.7);
    expect(k.map((d) => d.score)).toEqual([0.9, 0.73, 0.6]);
  });

  it('输出形状判断', () => {
    expect(outputLayout([1, 300, 6])).toBe('end2end');
    expect(outputLayout([1, 84, 21504])).toBe('raw');
    expect(outputLayout([1, 8, 21504])).toBe('raw');
    expect(outputLayout([1, 10])).toBe('unknown');
  });

  it('端到端输出：按置信度过滤、排序', () => {
    const out = new Float32Array([
      10, 20, 30, 40, 0.5, 1,
      50, 60, 70, 80, 0.9, 2,
      0, 0, 1, 1, 0.1, 0,
    ]);
    const d = postprocess(out, [1, 3, 6], p, 1024, 1024, { scoreThreshold: 0.4, iouThreshold: 0.5 });
    expect(d).toEqual([
      { cls: 2, score: expect.closeTo(0.9, 6), box: [50, 60, 70, 80] },
      { cls: 1, score: 0.5, box: [10, 20, 30, 40] },
    ]);
  });

  it('原始输出：解码 cx, cy, w, h 并按类别 NMS', () => {
    // nc = 2，N = 3：两个重叠的类别 0 框 + 一个类别 1 框
    const N = 3;
    const rows = [
      [50, 52, 200], // cx
      [50, 50, 200], // cy
      [20, 20, 10], // w
      [20, 20, 10], // h
      [0.9, 0.8, 0.1], // 类别 0 得分
      [0.05, 0.1, 0.7], // 类别 1 得分
    ];
    const out = new Float32Array(rows.flat());
    const d = postprocess(out, [1, 6, N], p, 1024, 1024, { scoreThreshold: 0.4, iouThreshold: 0.5 });
    expect(d).toHaveLength(2);
    expect(d[0]).toEqual({ cls: 0, score: expect.closeTo(0.9, 6), box: [40, 40, 60, 60] });
    expect(d[1].cls).toBe(1);
  });

  it('不认识的输出形状报错', () => {
    expect(() => postprocess(new Float32Array(10), [1, 10], p, 1, 1, { scoreThreshold: 0.4, iouThreshold: 0.5 })).toThrow(/输出形状/);
  });
});

// 集成测试：用训练好的模型（public/models/best.onnx）跑 3 张真实照片，与 Python（predict_dump.py，onnxruntime CPU）的结果比较。
// 这里用纯 JS 的 jpeg-js 解码，和 Python（PIL / libjpeg-turbo）解码出的像素平均差 0.5、最大 17；
// 模型对同一零件给出的重复框（分数 0.3–0.75）对这点差异很敏感，所以先两边都做同类去重再比，
// 置信度高（≥ 0.8）的框要求坐标差 < 2 像素。浏览器（与 PIL 用同一个解码库）里逐框比较原始输出见 Playwright 测试。
const ROOT = path.resolve(__dirname, '..');
const MODEL = path.join(ROOT, 'public/models/best.onnx');
const REAL = path.join(ROOT, 'public/samples/real');
const samples = fs.existsSync(REAL) ? fs.readdirSync(REAL).filter((f) => f.endsWith('.jpg')) : [];

describe.skipIf(!fs.existsSync(MODEL) || !samples.length)('真实模型：与 Python 推理结果一致', () => {
  let session;
  const results = {};

  it('加载模型（onnxruntime-web，wasm 后端）', async () => {
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(fs.readFileSync(MODEL), { executionProviders: ['wasm'] });
    expect(session.inputNames).toEqual(['images']);
  }, 60000);

  for (const f of samples) {
    it(`${f}：同类去重后框数相同、类别相同；高置信度的框坐标差 < 2 像素、置信度差 < 0.02`, async () => {
      const img = jpeg.decode(fs.readFileSync(path.join(REAL, f)), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
      const { tensor, params } = preprocess(img, 1024);
      const res = await session.run({ images: new ort.Tensor('float32', tensor, [1, 3, 1024, 1024]) });
      const out = res[session.outputNames[0]];
      const raw = postprocess(out.data, out.dims, params, img.width, img.height, { scoreThreshold: 0.4, iouThreshold: 0.5 });
      const dets = nmsByClass(raw, 0.7);
      const refJson = JSON.parse(fs.readFileSync(path.join(REAL, f.replace(/\.jpg$/, '.detections.json')), 'utf8'));
      const ref = nmsByClass(refJson.detections, 0.7);
      expect([img.width, img.height]).toEqual([refJson.width, refJson.height]);
      expect(dets.length).toBe(ref.length);
      let maxDiff = 0;
      let maxScore = 0;
      for (const r of ref) {
        const m = dets.reduce((b, d) => (d.cls === r.cls && (!b || iou(d.box, r.box) > iou(b.box, r.box)) ? d : b), null);
        expect(m).not.toBeNull();
        expect(iou(m.box, r.box)).toBeGreaterThan(0.9);
        if (r.score < 0.8) continue;
        maxDiff = Math.max(maxDiff, ...m.box.map((v, i) => Math.abs(v - r.box[i])));
        maxScore = Math.max(maxScore, Math.abs(m.score - r.score));
      }
      results[f] = { raw: raw.length, rawPy: refJson.detections.length, dedup: dets.length, maxDiff: +maxDiff.toFixed(3), maxScore: +maxScore.toFixed(4) };
      expect(maxDiff).toBeLessThan(2);
      expect(maxScore).toBeLessThan(0.02);
    }, 60000);
  }

  it('同类去重不会多出框（第一版模型在旧照片上有重复框会被去掉；第二版模型在这几张照片上没有重复框）', () => {
    console.log('与 Python 对比：', JSON.stringify(results));
    const total = Object.values(results).reduce((s, r) => s + r.raw, 0);
    const dedup = Object.values(results).reduce((s, r) => s + r.dedup, 0);
    expect(dedup).toBeLessThanOrEqual(total);
    expect(dedup).toBeGreaterThan(0);
  });
});
