// 颜色分割找零件（纯函数，不碰 DOM），用来补 YOLO 的漏检。做法与 training/autolabel.py 相同：
// 1. 只在零件区域（WORK_AREA：板内缩 12 mm、挖掉 4 个码）里找，桌面、码和板边文字不会误检
// 2. HSV（OpenCV 约定：H 0–180，S、V 0–255）里取红色、绿色（LED 灯体）和蓝色（电阻本体或蓝色 LED）像素
// 3. 闭运算把色环、高光连成一块，每个连通块的外接矩形是一个候选框；红、绿像素多算 LED；
//    蓝色的块按面积分：电阻本体约 6.3 × 2.4 mm（≈ 15 mm²），躺平的 LED 约 8.5 × 5.8 mm（≈ 45 mm²），大于 blueLedMm2 算 LED
// 透明 LED 没有颜色，这里找不到，只能靠模型。
// 引脚是银灰色、饱和度低，自然不会被框进去。
// 特点：几乎不漏，但框常常偏大（阴影、反光、两个零件挨在一起会连成一块），所以只用来补 YOLO 没框到的零件。
import { inWorkArea } from './mapping.js';

/** 默认参数（与 autolabel.py 一致） */
export const COLOR_SEG = { redSat: 100, redVal: 50, blueSat: 60, greenSat: 80, greenVal: 50, closeMm: 1.5, minMm: 2, blueLedMm2: 28 };

const RESISTOR = 0;
const LED = 1;

/**
 * OpenCV 约定的 HSV
 * @returns {[number, number, number]} H 0–180、S 0–255、V 0–255
 */
export function rgbToHsv(r, g, b) {
  const v = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = v - mn;
  const s = v === 0 ? 0 : (255 * d) / v;
  let h = 0;
  if (d > 0) {
    if (v === r) h = (60 * (g - b)) / d;
    else if (v === g) h = 120 + (60 * (b - r)) / d;
    else h = 240 + (60 * (r - g)) / d;
    if (h < 0) h += 360;
  }
  return [h / 2, s, v];
}

/**
 * 一维的滑动最大 / 最小（窗口 2r+1，超出图像的部分不计），用来做方形核的膨胀 / 腐蚀。
 * 用滑动计数：窗口里 1 的个数随窗口移动增减，每个像素 O(1)，与逐个扫描窗口的结果完全相同
 */
function slide(src, w, h, r, horizontal, isMax) {
  const out = new Uint8Array(src.length);
  const [n, m] = horizontal ? [h, w] : [w, h];
  const step = horizontal ? 1 : w;
  for (let a = 0; a < n; a++) {
    const base = horizontal ? a * w : a;
    let ones = 0; // 窗口 [b − r, b + r]（裁到 0..m−1）里 1 的个数
    for (let k = 0; k <= Math.min(m - 1, r); k++) ones += src[base + k * step];
    for (let b = 0; b < m; b++) {
      const lo = Math.max(0, b - r);
      const hi = Math.min(m - 1, b + r);
      out[base + b * step] = isMax ? (ones > 0 ? 1 : 0) : ones === hi - lo + 1 ? 1 : 0;
      // 窗口右移一格
      if (b + r + 1 <= m - 1) ones += src[base + (b + r + 1) * step];
      if (b - r >= 0) ones -= src[base + (b - r) * step];
    }
  }
  return out;
}

/** 闭运算（方形核，边长 2r+1）：先膨胀再腐蚀 */
export function closeMask(mask, w, h, r) {
  const dil = slide(slide(mask, w, h, r, true, true), w, h, r, false, true);
  return slide(slide(dil, w, h, r, true, false), w, h, r, false, false);
}

/**
 * 在照片里按颜色找零件
 * @param {{width:number, height:number, data:ArrayLike<number>}} img RGBA（可以是缩小后的图）
 * @param {number[][]} Hinv 该图像素 → 底板 mm（用来判断是否在零件区域内）
 * @param {number} pxPerMm 板中心附近 1 mm 对应的像素数（定闭运算核和最小面积）
 * @param {Partial<typeof COLOR_SEG>} [opts]
 * @returns {{ cls: number, box: number[], area: number, red: number, blue: number }[]} 框为该图像素
 */
export function segmentParts(img, Hinv, pxPerMm, opts = {}) {
  const o = { ...COLOR_SEG, ...opts };
  const { width: W, height: H, data } = img;
  const red = new Uint8Array(W * H);
  const blue = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const p = i * 4;
      // 像素中心对应的底板坐标
      const u = x + 0.5;
      const v = y + 0.5;
      const w = Hinv[2][0] * u + Hinv[2][1] * v + Hinv[2][2];
      const X = (Hinv[0][0] * u + Hinv[0][1] * v + Hinv[0][2]) / w;
      const Y = (Hinv[1][0] * u + Hinv[1][1] * v + Hinv[1][2]) / w;
      if (!inWorkArea(X, Y)) continue;
      const [hh, s, vv] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
      if ((hh <= 10 || hh >= 170) && s >= o.redSat && vv >= o.redVal) red[i] = 1;
      else if (hh >= 35 && hh < 80 && s >= o.greenSat && vv >= o.greenVal) red[i] = 1; // 绿色 LED：与红色一样算 LED 像素
      else if (hh >= 80 && hh <= 130 && s >= o.blueSat) blue[i] = 1;
      mask[i] = red[i] | blue[i];
    }
  }
  const r = Math.max(1, Math.round((pxPerMm * o.closeMm) / 2));
  const closed = closeMask(mask, W, H, r);

  // 连通块（8 连通）
  const label = new Int32Array(W * H);
  const parts = [];
  const minArea = (o.minMm * pxPerMm) ** 2;
  const stack = [];
  let next = 0;
  for (let i0 = 0; i0 < closed.length; i0++) {
    if (!closed[i0] || label[i0]) continue;
    next++;
    label[i0] = next;
    stack.push(i0);
    let area = 0;
    let nr = 0;
    let nb = 0;
    // 外接框只取原始颜色像素（不含闭运算补出来的部分），框更紧
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    while (stack.length) {
      const i = stack.pop();
      area++;
      const x = i % W;
      const y = (i - x) / W;
      if (mask[i]) {
        nr += red[i];
        nb += blue[i];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (closed[j] && !label[j]) {
            label[j] = next;
            stack.push(j);
          }
        }
      }
    }
    if (area < minArea || !(x1 >= x0)) continue;
    // 蓝色为主的块：面积大的是蓝色 LED，小的是电阻本体
    const cls = nr > nb || area / (pxPerMm * pxPerMm) > o.blueLedMm2 ? LED : RESISTOR;
    parts.push({ cls, box: [x0, y0, x1 + 1, y1 + 1], area, red: nr, blue: nb });
  }
  return parts;
}

/** 两个框的 IoU */
function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
}

const inside = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/**
 * 合并 YOLO 与颜色分割：以 YOLO 为准；颜色分割的候选框附近没有任何 YOLO 框时（不论类别），
 * 当作 YOLO 漏检的零件补上（origin = 'color'）。"附近"指 IoU > minIou，或者一个框的中心落在另一个框里。
 * @param {import('../state.js').Detection[]} yolo
 * @param {{cls:number, box:number[]}[]} color 原图像素
 * @param {{ minIou?: number, score?: number, names?: (cls:number) => string }} [opts] score：补上的框记的置信度
 * @returns {{ dets: (import('../state.js').Detection & { origin?: string })[], added: number }}
 */
export function fuseDetections(yolo, color, { minIou = 0.1, score = 0.5, names = (c) => String(c) } = {}) {
  const out = yolo.map((d) => ({ ...d, origin: d.origin ?? 'yolo' }));
  let added = 0;
  for (const c of color) {
    const covered = out.some((d) => iou(d.box, c.box) > minIou || inside(center(d.box), c.box) || inside(center(c.box), d.box));
    if (covered) continue;
    out.push({ cls: c.cls, name: names(c.cls), score, box: [...c.box], origin: 'color' });
    added++;
  }
  return { dets: out, added };
}
