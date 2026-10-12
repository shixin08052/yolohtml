// 模块 3：由单应性 H 和内参 K 反推手机位姿（纯函数，不碰 DOM）。
// 约定：Pc = R·Pw + t，光心 C = −Rᵀt；底板平面 Z = 0，所以 H ∝ K·[r1 r2 t]。
import { Matrix, SVD, solve } from 'ml-matrix';
import {
  inv3, mul3, mulVec3, transpose3, col3, fromCols3, cross3, norm3, scale3, det3, rad2deg,
} from '../math/linalg.js';
import { intrinsicsMatrix, project } from '../math/pinhole.js';

/** 用 SVD 把近似旋转矩阵正交化：R = U·Vᵀ（保证 det = +1） */
export function orthonormalize(M) {
  const svd = new SVD(new Matrix(M));
  const U = svd.leftSingularVectors.to2DArray();
  const V = svd.rightSingularVectors.to2DArray();
  let R = mul3(U, transpose3(V));
  if (det3(R) < 0) {
    for (let i = 0; i < 3; i++) U[i][2] = -U[i][2];
    R = mul3(U, transpose3(V));
  }
  return R;
}

/**
 * 由单应性反推位姿
 * @param {number[][]} K 内参矩阵
 * @param {number[][]} H 底板 (X, Y, 1) → 像素 (u, v, 1)
 * @param {number[][]} worldPts 底板坐标 [X, Y]（用于计算重投影误差）
 * @param {number[][]} imagePts 对应像素
 * @param {{refine?: boolean}} [opts] refine：第 1–7 步的解析解之后，再用 LM 最小化重投影误差（默认开启）
 * @returns {import('../state.js').CameraPose}
 */
export function poseFromHomography(K, H, worldPts, imagePts, { refine = true } = {}) {
  // 1. B = K⁻¹H
  const B = mul3(inv3(K), H);
  const b1 = col3(B, 0);
  const b2 = col3(B, 1);
  const b3 = col3(B, 2);
  // 2. λ = 2 / (‖b1‖ + ‖b2‖)
  const lambda = 2 / (norm3(b1) + norm3(b2));
  let r1 = scale3(b1, lambda);
  let r2 = scale3(b2, lambda);
  let t = scale3(b3, lambda);
  // 3. 底板必须在相机前方
  if (t[2] < 0) {
    r1 = scale3(r1, -1);
    r2 = scale3(r2, -1);
    t = scale3(t, -1);
  }
  // 4. r3 = r1 × r2，正交化
  let R = orthonormalize(fromCols3(r1, r2, cross3(r1, r2)));
  // 8.（补充）解析解不是重投影误差最小的解：以它为初值做 LM 优化
  if (refine && worldPts.length >= 4) ({ R, t } = refinePose(K, R, t, worldPts, imagePts));
  // 5. 光心与高度
  const position = /** @type {[number,number,number]} */ (scale3(mulVec3(transpose3(R), t), -1));
  // 6. 光轴 d = Rᵀ·(0,0,1) = R 的第 3 行；俯角 = asin(−d_z)
  const pitchDeg = rad2deg(Math.asin(-R[2][2]));
  // 7. 重投影误差
  let sum = 0;
  for (let i = 0; i < worldPts.length; i++) {
    const [u, v] = project(K, R, t, [worldPts[i][0], worldPts[i][1], 0]);
    sum += Math.hypot(u - imagePts[i][0], v - imagePts[i][1]);
  }
  return { R, t, position, heightMm: position[2], pitchDeg, reprojErrPx: worldPts.length ? sum / worldPts.length : 0 };
}

/** 由 Intrinsics 对象得到 K（方便调用） */
export const Kof = (intr) => intrinsicsMatrix(intr);

/* ------------------------------------------------------------------ */
/* 非线性优化：最小化重投影误差                                          */
/* ------------------------------------------------------------------ */

/** 旋转向量 → 旋转矩阵（Rodrigues 公式） */
export function rodrigues(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [[1, -w[2], w[1]], [w[2], 1, -w[0]], [-w[1], w[0], 1]];
  const [x, y, z] = w.map((v) => v / th);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

/** 重投影残差向量 [du0, dv0, du1, dv1, ...] */
function residuals(K, R, t, worldPts, imagePts) {
  const r = new Array(worldPts.length * 2);
  for (let i = 0; i < worldPts.length; i++) {
    const [u, v] = project(K, R, t, [worldPts[i][0], worldPts[i][1], 0]);
    r[2 * i] = u - imagePts[i][0];
    r[2 * i + 1] = v - imagePts[i][1];
  }
  return r;
}

const sumSq = (r) => r.reduce((a, x) => a + x * x, 0);

/**
 * Levenberg–Marquardt 优化位姿（6 个参数：旋转增量 δω + 平移 t），最小化全部角点的重投影误差。
 * 旋转用增量形式 R = exp([δω]×)·R0，每步接受后并入 R0，避免奇异。
 * @param {number[][]} K
 * @param {number[][]} R0 初始旋转
 * @param {number[]} t0 初始平移
 * @returns {{R:number[][], t:number[], iterations:number}}
 */
export function refinePose(K, R0, t0, worldPts, imagePts, { maxIter = 50 } = {}) {
  let R = R0;
  let t = [...t0];
  let r = residuals(K, R, t, worldPts, imagePts);
  let cost = sumSq(r);
  let lambda = 1e-3;
  let it = 0;
  let converged = false;
  const eps = [1e-6, 1e-6, 1e-6, 1e-3, 1e-3, 1e-3];
  for (; it < maxIter && !converged; it++) {
    // 数值雅可比（2N × 6）
    const J = r.map(() => new Array(6).fill(0));
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0];
      d[k] = eps[k];
      const Rk = k < 3 ? mul3(rodrigues(d.slice(0, 3)), R) : R;
      const tk = k < 3 ? t : t.map((x, i) => x + d[3 + i]);
      const rk = residuals(K, Rk, tk, worldPts, imagePts);
      for (let i = 0; i < r.length; i++) J[i][k] = (rk[i] - r[i]) / eps[k];
    }
    const Jm = new Matrix(J);
    const JtJ = Jm.transpose().mmul(Jm);
    const Jtr = Jm.transpose().mmul(Matrix.columnVector(r));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.clone();
      for (let k = 0; k < 6; k++) A.set(k, k, A.get(k, k) * (1 + lambda) + 1e-12);
      let delta;
      try {
        delta = solve(A, Jtr.clone().mul(-1)).to1DArray();
      } catch {
        lambda *= 10;
        continue;
      }
      const Rn = mul3(rodrigues(delta.slice(0, 3)), R);
      const tn = t.map((x, i) => x + delta[3 + i]);
      const rn = residuals(K, Rn, tn, worldPts, imagePts);
      const cn = sumSq(rn);
      if (cn < cost) {
        const gain = cost - cn;
        R = orthonormalize(Rn);
        t = tn;
        r = residuals(K, R, t, worldPts, imagePts);
        cost = sumSq(r);
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
        converged = gain < 1e-9 * (1 + cost); // 代价几乎不再下降
        break;
      }
      lambda *= 10;
    }
    if (!improved) break; // 任何步长都不能再降低代价
  }
  return { R, t, iterations: it };
}
