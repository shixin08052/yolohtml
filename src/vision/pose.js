// 模块 3：由单应性 H 和内参 K 反推手机位姿（纯函数，不碰 DOM）。
// 约定：Pc = R·Pw + t，光心 C = −Rᵀt；底板平面 Z = 0，所以 H ∝ K·[r1 r2 t]。
import { Matrix, SVD } from 'ml-matrix';
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
 * @returns {import('../state.js').CameraPose}
 */
export function poseFromHomography(K, H, worldPts, imagePts) {
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
  const R = orthonormalize(fromCols3(r1, r2, cross3(r1, r2)));
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
