// 模块 2：单应性（纯函数，不碰 DOM）。
// H 的方向：底板 (X, Y, 1) → 像素 (u, v, 1)；Hinv 方向相反。
// 矩阵为行优先的 3×3 二维数组。
import { Matrix, SVD } from 'ml-matrix';
import { inv3 } from '../math/linalg.js';

/**
 * 归一化变换：平移到质心、缩放到平均距离 √2
 * @param {number[][]} pts
 * @returns {number[][]} 3×3 矩阵 T，使 T·p 为归一化后的点
 */
function normalizer(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const md = pts.reduce((a, p) => a + Math.hypot(p[0] - mx, p[1] - my), 0) / n;
  const s = md > 0 ? Math.SQRT2 / md : 1;
  return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
}

/**
 * 归一化 DLT 求单应性
 * @param {number[][]} worldPts 底板坐标 [X, Y]（mm），至少 4 个，且不能三点共线
 * @param {number[][]} imagePts 对应的像素 [u, v]
 * @returns {number[][]} H（H[2][2] = 1）
 */
export function solveHomography(worldPts, imagePts) {
  const n = worldPts.length;
  if (n < 4 || imagePts.length !== n) throw new Error('求单应性至少需要 4 对点');
  const Tw = normalizer(worldPts);
  const Ti = normalizer(imagePts);

  // 2N × 9；不足 9 行时补零行（不改变解，避免 SVD 处理"列多于行"）
  const rows = Math.max(2 * n, 9);
  const A = Matrix.zeros(rows, 9);
  for (let k = 0; k < n; k++) {
    const [x, y] = applyH(Tw, worldPts[k]);
    const [u, v] = applyH(Ti, imagePts[k]);
    A.setRow(2 * k, [-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    A.setRow(2 * k + 1, [0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }
  // 奇异值按从大到小排列，最小奇异值对应 V 的最后一列
  const h = new SVD(A).rightSingularVectors.getColumn(8);
  const Hn = [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)];

  // 反归一化：H = Ti⁻¹ · Hn · Tw
  const H = mul(mul(inv3(Ti), Hn), Tw);
  const k = H[2][2];
  if (Math.abs(k) < 1e-12) throw new Error('单应性退化（点可能共线）');
  return H.map((r) => r.map((x) => x / k));
}

function mul(A, B) {
  return A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
}

/**
 * 用 H 变换一个二维点
 * @param {number[][]} H
 * @param {number[]} p [x, y]
 * @returns {[number, number]}
 */
export function applyH(H, p) {
  const [x, y] = p;
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}

/** 3×3 求逆 */
export function invert3(H) {
  return inv3(H);
}

/**
 * 平均重投影误差（像素）
 * @param {number[][]} H
 * @param {number[][]} worldPts
 * @param {number[][]} imagePts
 * @returns {number}
 */
export function reprojError(H, worldPts, imagePts) {
  let sum = 0;
  for (let k = 0; k < worldPts.length; k++) {
    const [u, v] = applyH(H, worldPts[k]);
    sum += Math.hypot(u - imagePts[k][0], v - imagePts[k][1]);
  }
  return sum / worldPts.length;
}

/* ------------------------------------------------------------------ */
/* 由识别到的码求底板单应性                                              */
/* ------------------------------------------------------------------ */

/** 重投影误差超过此值（像素）时提示重拍 */
export const REPROJ_WARN_PX = 3;

/**
 * 用识别到的全部码角点求 H（底板 mm → 像素）
 * @param {import('../state.js').Marker[]} markers 至少 1 个
 * @param {(id:number) => number[][]} cornersWorld 码 ID → 4 个角点的底板坐标（与 corners 同序）
 * @returns {{ H:number[][], Hinv:number[][], reprojErrPx:number, warnings:string[] }}
 */
export function boardHomography(markers, cornersWorld) {
  if (!markers.length) throw new Error('没有识别到码，无法求单应性');
  const world = [];
  const image = [];
  for (const m of markers) {
    world.push(...cornersWorld(m.id));
    image.push(...m.corners);
  }
  const H = solveHomography(world, image);
  const Hinv = invert3(H);
  const reprojErrPx = reprojError(H, world, image);
  const warnings = [];
  if (markers.length < 4) {
    warnings.push(`只识别到 ${markers.length} 个码，单应性精度会下降（离这些码越远误差越大）。`);
  }
  if (reprojErrPx > REPROJ_WARN_PX) {
    warnings.push(`重投影误差 ${reprojErrPx.toFixed(2)} 像素，偏大（> ${REPROJ_WARN_PX}），建议把纸压平后重拍。`);
  }
  return { H, Hinv, reprojErrPx, warnings };
}

/* ------------------------------------------------------------------ */
/* 正射图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成正射图像素（纯函数）。画布第 i 行第 j 列的像素中心对应底板坐标
 * X = (j + 0.5) / pxPerMm，Y = boardH − (i + 0.5) / pxPerMm（画布顶部是底板远端），
 * 用 H 找到原图位置后双线性插值取色。原图像素 (x, y) 的中心在 (x + 0.5, y + 0.5)。
 * @param {{width:number, height:number, data:ArrayLike<number>}} src 原图 RGBA
 * @param {number[][]} H 底板 mm → 原图像素
 * @param {{boardW:number, boardH:number, pxPerMm?:number}} opts
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function rectifyPixels(src, H, { boardW, boardH, pxPerMm = 2 }) {
  const W = Math.round(boardW * pxPerMm);
  const Hh = Math.round(boardH * pxPerMm);
  const out = new Uint8ClampedArray(W * Hh * 4);
  const sw = src.width;
  const sh = src.height;
  const d = src.data;
  for (let i = 0; i < Hh; i++) {
    const Y = boardH - (i + 0.5) / pxPerMm;
    for (let j = 0; j < W; j++) {
      const X = (j + 0.5) / pxPerMm;
      const w = H[2][0] * X + H[2][1] * Y + H[2][2];
      const x = (H[0][0] * X + H[0][1] * Y + H[0][2]) / w - 0.5;
      const y = (H[1][0] * X + H[1][1] * Y + H[1][2]) / w - 0.5;
      const o = (i * W + j) * 4;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        out[o + 3] = 0; // 超出原图：透明
        continue;
      }
      const fx = x - x0;
      const fy = y - y0;
      const p00 = (y0 * sw + x0) * 4;
      const p10 = p00 + 4;
      const p01 = p00 + sw * 4;
      const p11 = p01 + 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] =
          d[p00 + c] * (1 - fx) * (1 - fy) + d[p10 + c] * fx * (1 - fy) +
          d[p01 + c] * (1 - fx) * fy + d[p11 + c] * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: W, height: Hh, data: out };
}

/** 最近一张照片的像素（同一张照片要做两次正射变换：正射图小窗、底板贴图，只读一次全尺寸像素） */
let pixelCache = null; // { bitmap, data }

/**
 * ImageBitmap 的 RGBA 像素（缓存最近一张）
 * @param {ImageBitmap} bitmap
 * @returns {ImageData}
 */
export function bitmapPixels(bitmap) {
  if (pixelCache?.bitmap !== bitmap) {
    pixelCache = null; // 先放掉上一张，避免同时占两份内存
    const src = document.createElement('canvas');
    src.width = bitmap.width;
    src.height = bitmap.height;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bitmap, 0, 0);
    pixelCache = { bitmap, data: sctx.getImageData(0, 0, src.width, src.height) };
  }
  return pixelCache.data;
}

/**
 * 正射图（需要浏览器环境）：输出 canvas
 * @param {CanvasImageSource & {width:number, height:number}} bitmap 原图
 * @param {number[][]} H
 * @param {number} [pxPerMm=2]
 * @param {{boardW:number, boardH:number}} board
 * @returns {HTMLCanvasElement}
 */
export function rectify(bitmap, H, pxPerMm = 2, { boardW, boardH }) {
  const pix = rectifyPixels(bitmapPixels(bitmap), H, { boardW, boardH, pxPerMm });
  const out = document.createElement('canvas');
  out.width = pix.width;
  out.height = pix.height;
  out.getContext('2d').putImageData(new ImageData(pix.data, pix.width, pix.height), 0, 0);
  return out;
}
