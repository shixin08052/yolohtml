// 3×3 矩阵与 3 维向量小工具（纯函数，不碰 DOM）。
// 矩阵统一用行优先的二维数组 [[a,b,c],[d,e,f],[g,h,i]]。

/** @typedef {number[][]} Mat3 */
/** @typedef {number[]} Vec3 */

export function identity3() {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

/** @param {Mat3} A @param {Mat3} B @returns {Mat3} */
export function mul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return C;
}

/** 矩阵乘向量 @param {Mat3} A @param {Vec3} v @returns {Vec3} */
export function mulVec3(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

/** @param {Mat3} A @returns {Mat3} */
export function transpose3(A) {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

/** @param {Mat3} A @returns {number} */
export function det3(A) {
  return (
    A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
  );
}

/**
 * 3×3 求逆（伴随矩阵法）。奇异时抛出异常。
 * @param {Mat3} A @returns {Mat3}
 */
export function inv3(A) {
  const d = det3(A);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) throw new Error('矩阵奇异，无法求逆');
  const [[a, b, c], [e, f, g], [h, i, j]] = A;
  return [
    [(f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d],
    [(g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d],
    [(e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d],
  ];
}

/** 取第 k 列 @param {Mat3} A @param {number} k @returns {Vec3} */
export function col3(A, k) {
  return [A[0][k], A[1][k], A[2][k]];
}

/** 由三列拼成矩阵 @param {Vec3} c0 @param {Vec3} c1 @param {Vec3} c2 @returns {Mat3} */
export function fromCols3(c0, c1, c2) {
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
}

export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
export function normalize3(a) {
  const n = norm3(a);
  if (n === 0) throw new Error('零向量无法归一化');
  return scale3(a, 1 / n);
}

/** 二维点距离 */
export const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;
