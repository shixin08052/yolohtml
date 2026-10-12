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
