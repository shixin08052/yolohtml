// YOLO 前处理与后处理（纯函数，不碰 DOM，Web Worker 和单元测试都用）。
// 与 ultralytics 的做法保持一致（training/README.md 第 8 节实测）：
// - 前处理：等比缩放到 S × S（双线性，采样位置与 OpenCV INTER_LINEAR 相同），居中填灰 (114, 114, 114)，
//   RGB、除以 255、NCHW float32。填充量按 ultralytics LetterBox：左 / 上 = round(d − 0.1)
// - 端到端输出 [1, N, 6]：每行 x1, y1, x2, y2（输入图像素）, 置信度, 类别，按置信度过滤
// - 原始输出 [1, 4 + nc, N]：cx, cy, w, h, 各类得分，解码后按类别做 NMS
// - 框还原到原图：减去填充、除以缩放比、裁到图像范围内

/** Python 的 round：恰好 .5 时取偶数（ultralytics 的取整都用它） */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * 等比缩放与填充参数
 * @param {number} W 原图宽
 * @param {number} H 原图高
 * @param {number} S 模型输入边长
 * @returns {{ r: number, nw: number, nh: number, padX: number, padY: number, S: number, gx: number, gy: number }}
 *   gx、gy：横、竖方向实际的缩放比（取整后的 nw / W、nh / H），还原框时用（与 ultralytics scale_boxes 一致）
 */
export function letterboxParams(W, H, S) {
  const r = Math.min(S / W, S / H);
  const nw = pyRound(W * r);
  const nh = pyRound(H * r);
  const padX = pyRound((S - nw) / 2 - 0.1);
  const padY = pyRound((S - nh) / 2 - 0.1);
  return { r, nw, nh, padX, padY, S, gx: nw / W, gy: nh / H };
}

/**
 * 前处理：RGBA 原图 → NCHW float32 输入张量
 * @param {{width:number, height:number, data:ArrayLike<number>}} img RGBA
 * @param {number} S
 * @returns {{ tensor: Float32Array, params: ReturnType<typeof letterboxParams> }}
 */
export function preprocess(img, S) {
  const { width: W, height: H, data } = img;
  const p = letterboxParams(W, H, S);
  const { nw, nh, padX, padY } = p;
  const plane = S * S;
  const out = new Float32Array(3 * plane).fill(114 / 255);
  const sx = W / nw;
  const sy = H / nh;
  // 每列的采样位置（与 OpenCV INTER_LINEAR 相同：x = (dx + 0.5)·s − 0.5，夹在边界内）
  const x0s = new Int32Array(nw);
  const x1s = new Int32Array(nw);
  const fxs = new Float32Array(nw);
  for (let dx = 0; dx < nw; dx++) {
    let x = (dx + 0.5) * sx - 0.5;
    if (x < 0) x = 0;
    let x0 = Math.floor(x);
    if (x0 >= W - 1) {
      x0 = W - 1;
      x = x0;
    }
    x0s[dx] = x0;
    x1s[dx] = Math.min(x0 + 1, W - 1);
    fxs[dx] = x - x0;
  }
  for (let dy = 0; dy < nh; dy++) {
    let y = (dy + 0.5) * sy - 0.5;
    if (y < 0) y = 0;
    let y0 = Math.floor(y);
    if (y0 >= H - 1) {
      y0 = H - 1;
      y = y0;
    }
    const y1 = Math.min(y0 + 1, H - 1);
    const fy = y - y0;
    const r0 = y0 * W * 4;
    const r1 = y1 * W * 4;
    const o = (dy + padY) * S + padX;
    for (let dx = 0; dx < nw; dx++) {
      const a = r0 + x0s[dx] * 4;
      const b = r0 + x1s[dx] * 4;
      const c = r1 + x0s[dx] * 4;
      const d = r1 + x1s[dx] * 4;
      const fx = fxs[dx];
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i = o + dx;
      for (let ch = 0; ch < 3; ch++) {
        out[ch * plane + i] = (data[a + ch] * w00 + data[b + ch] * w01 + data[c + ch] * w10 + data[d + ch] * w11) / 255;
      }
    }
  }
  return { tensor: out, params: p };
}

/** 输入图上的框 → 原图像素，并裁到图像范围内 */
export function unletterbox([x1, y1, x2, y2], { gx, gy, padX, padY }, W, H) {
  const c = (v, m) => Math.min(m, Math.max(0, v));
  return [c((x1 - padX) / gx, W), c((y1 - padY) / gy, H), c((x2 - padX) / gx, W), c((y2 - padY) / gy, H)];
}

/** 两个框的 IoU */
export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/**
 * 同类 NMS / 去重：按置信度从高到低，同一类别里与已保留的框 IoU 大于阈值的框丢掉
 * @param {{cls:number, score:number, box:number[]}[]} dets
 * @param {number} thr
 */
export function nmsByClass(dets, thr) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of sorted) {
    if (keep.every((k) => k.cls !== d.cls || iou(k.box, d.box) <= thr)) keep.push(d);
  }
  return keep;
}

/**
 * 从原始框里选出检测结果（两档置信度）：
 * - 置信度 ≥ scoreThreshold 的：同类去重（IoU > dedupIou 只留高分）后全部保留；
 * - 介于 lowThreshold 和 scoreThreshold 之间的：只有与已保留的框（不论类别）都几乎不重叠（IoU ≤ lowMaxIou）时才补上，
 *   标记 low。透明 LED 在白纸上反差小，模型给的分常常只有 0.3 多；而低分里更多的是同一零件的重复框（与高分框重叠 0.7 以上），
 *   这样能补上漏掉的零件，又不会多出重复的。
 * @param {{cls:number, score:number, box:number[]}[]} raw
 * @param {{ scoreThreshold: number, lowThreshold?: number, dedupIou: number, lowMaxIou?: number }} o
 */
export function selectDetections(raw, { scoreThreshold, lowThreshold = scoreThreshold, dedupIou, lowMaxIou = 0.3 }) {
  const keep = nmsByClass(raw.filter((d) => d.score >= scoreThreshold), dedupIou);
  const lows = raw.filter((d) => d.score >= lowThreshold && d.score < scoreThreshold).sort((a, b) => b.score - a.score);
  for (const d of lows) {
    if (keep.every((k) => iou(k.box, d.box) <= lowMaxIou)) keep.push({ ...d, low: true });
  }
  return keep;
}

/**
 * 输出形状 → 格式
 * @param {number[]} dims
 * @returns {'end2end'|'raw'|'unknown'}
 */
export function outputLayout(dims) {
  if (dims.length === 3 && dims[2] === 6) return 'end2end';
  if (dims.length === 3 && dims[1] > 4) return 'raw';
  return 'unknown';
}

/**
 * 后处理：模型输出 → 原图像素上的检测框
 * @param {Float32Array} out 输出数据
 * @param {number[]} dims 输出形状
 * @param {ReturnType<typeof letterboxParams>} params
 * @param {number} W 原图宽
 * @param {number} H 原图高
 * @param {{ scoreThreshold: number, iouThreshold: number }} opts iouThreshold 只用于原始输出的 NMS
 * @returns {{cls:number, score:number, box:number[]}[]} 按置信度从高到低
 */
export function postprocess(out, dims, params, W, H, { scoreThreshold, iouThreshold }) {
  const layout = outputLayout(dims);
  const dets = [];
  if (layout === 'end2end') {
    const n = dims[1];
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const score = out[o + 4];
      if (!(score >= scoreThreshold)) continue;
      dets.push({ cls: Math.round(out[o + 5]), score, box: unletterbox([out[o], out[o + 1], out[o + 2], out[o + 3]], params, W, H) });
    }
    return dets.sort((a, b) => b.score - a.score);
  }
  if (layout === 'raw') {
    const nc = dims[1] - 4;
    const n = dims[2];
    for (let i = 0; i < n; i++) {
      let best = -1;
      let score = -Infinity;
      for (let c = 0; c < nc; c++) {
        const s = out[(4 + c) * n + i];
        if (s > score) {
          score = s;
          best = c;
        }
      }
      if (!(score >= scoreThreshold)) continue;
      const cx = out[i];
      const cy = out[n + i];
      const w = out[2 * n + i];
      const h = out[3 * n + i];
      dets.push({ cls: best, score, box: unletterbox([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], params, W, H) });
    }
    return nmsByClass(dets, iouThreshold);
  }
  throw new Error(`无法识别的模型输出形状 [${dims.join(', ')}]`);
}
