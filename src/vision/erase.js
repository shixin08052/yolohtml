// 从底板贴图上擦掉零件（纯函数，不碰 DOM）。
// 底板贴图是照片的正射图：照片里的零件也被"压"到了板面上，而且越高的部位沿视线往后偏得越远，
// 在 3D 模型旁边形成重影。检测框包含零件在照片里的全部像素，框落到板面上的四边形就盖住了
// 这块压扁的图像；用四边形外一圈纸面的颜色填上（上下、左右各取中值再插值，能跟上光照渐变），
// 边缘羽化，避免出现硬边。
import { applyH } from './homography.js';

/** 检测框每边外扩的比例（真实照片里零件的阴影、模糊边缘会超出框） */
export const ERASE_EXPAND = 0.12;

/**
 * 检测框 → 贴图像素上的四边形
 * @param {[number,number,number,number]} box 原图像素
 * @param {number[][]} toLocal 原图像素 → 纸张局部坐标 (u, v)（mm，原点在纸张左下角）
 * @param {{ pxPerMm: number, paperH: number }} tex 贴图分辨率与纸张高度（贴图顶部 = 纸张远端）
 * @param {number} [expand=ERASE_EXPAND]
 * @returns {number[][]} 四个角（贴图像素，连续坐标）
 */
export function boxToTexture([x1, y1, x2, y2], toLocal, { pxPerMm, paperH }, expand = ERASE_EXPAND) {
  const ex = Math.max(3, (x2 - x1) * expand);
  const ey = Math.max(3, (y2 - y1) * expand);
  const corners = [[x1 - ex, y1 - ey], [x2 + ex, y1 - ey], [x2 + ex, y2 + ey], [x1 - ex, y2 + ey]];
  return corners.map((p) => {
    const [u, v] = applyH(toLocal, p);
    return [u * pxPerMm, (paperH - v) * pxPerMm];
  });
}

/**
 * 点到凸多边形的有符号距离（内部为正）。外部用"到各边所在直线的最大外侧距离"近似，羽化够用。
 * @param {number[][]} poly
 * @param {number} x
 * @param {number} y
 */
export function signedDistance(poly, x, y) {
  // 顶点顺序可能是顺时针也可能是逆时针：按面积符号统一
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    area += ax * by - bx * ay;
  }
  const sgn = area >= 0 ? 1 : -1;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // 左侧为内部（面积为正时）
    const side = (sgn * ((bx - ax) * (y - ay) - (by - ay) * (x - ax))) / len;
    d = Math.min(d, side);
  }
  return d;
}

/** 中值（空数组返回 null） */
function median(a) {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

/**
 * 在 RGBA 图像上擦掉若干个四边形区域（原地修改）
 * @param {{width:number, height:number, data:Uint8ClampedArray}} img 贴图（alpha < 255 的像素不参与取色）
 * @param {number[][][]} polys 每个四边形的四个角（像素）
 * @param {{ featherPx?: number, ringPx?: number }} [opts] 羽化宽度、取色环宽度
 * @returns {number} 实际擦掉的区域个数
 */
export function erasePolygons(img, polys, { featherPx = 6, ringPx = 8 } = {}) {
  const { width: W, height: H, data } = img;
  let done = 0;
  for (const poly of polys) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    // 要处理的矩形（含羽化）
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - featherPx));
    const x1 = Math.min(W, Math.ceil(Math.max(...xs) + featherPx));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - featherPx));
    const y1 = Math.min(H, Math.ceil(Math.max(...ys) + featherPx));
    if (x1 <= x0 || y1 <= y0) continue;

    // 矩形外一圈的上、下、左、右四条带，各通道取中值
    const strip = (ax, ay, bx, by) => {
      const ch = [[], [], []];
      for (let y = Math.max(0, ay); y < Math.min(H, by); y++) {
        for (let x = Math.max(0, ax); x < Math.min(W, bx); x++) {
          const o = (y * W + x) * 4;
          if (data[o + 3] < 255) continue;
          for (let c = 0; c < 3; c++) ch[c].push(data[o + c]);
        }
      }
      return ch[0].length ? ch.map(median) : null;
    };
    const top = strip(x0, y0 - ringPx, x1, y0);
    const bottom = strip(x0, y1, x1, y1 + ringPx);
    const left = strip(x0 - ringPx, y0, x0, y1);
    const right = strip(x1, y0, x1 + ringPx, y1);
    const avail = [top, bottom, left, right].filter(Boolean);
    if (!avail.length) continue;
    const mean = [0, 1, 2].map((c) => avail.reduce((s, a) => s + a[c], 0) / avail.length);
    const T = top ?? mean;
    const B = bottom ?? mean;
    const L = left ?? mean;
    const R = right ?? mean;

    const w = x1 - x0;
    const h = y1 - y0;
    for (let y = y0; y < y1; y++) {
      const v = (y + 0.5 - y0) / h;
      for (let x = x0; x < x1; x++) {
        const o = (y * W + x) * 4;
        if (data[o + 3] < 255) continue;
        const d = signedDistance(poly, x + 0.5, y + 0.5);
        const a = Math.min(1, Math.max(0, 1 + d / featherPx)); // 内部 1，往外 featherPx 内降到 0
        if (a <= 0) continue;
        const u = (x + 0.5 - x0) / w;
        for (let c = 0; c < 3; c++) {
          const fill = 0.5 * (L[c] + (R[c] - L[c]) * u + T[c] + (B[c] - T[c]) * v);
          data[o + c] = data[o + c] * (1 - a) + fill * a;
        }
      }
    }
    done++;
  }
  return done;
}
