// 针孔相机模型（纯函数，不碰 DOM）。
// 位姿约定：底板点 Pw 变换到相机坐标为 Pc = R·Pw + t；手机光心 C = −Rᵀt。
// OpenCV 相机坐标：x 右，y 下，z 沿拍摄方向。
// 像素坐标为连续坐标：像素 (i, j) 覆盖 [i, i+1) × [j, j+1)，中心在 (i+0.5, j+0.5)；
// 因此主点在图像中心时 cx = W/2、cy = H/2。
import { mulVec3, add3, sub3, scale3, cross3, normalize3, transpose3, deg2rad, rad2deg } from './linalg.js';

/**
 * 内参矩阵 K
 * @param {{fx:number, fy:number, cx:number, cy:number}} k
 * @returns {number[][]}
 */
export function intrinsicsMatrix({ fx, fy, cx, cy }) {
  return [[fx, 0, cx], [0, fy, cy], [0, 0, 1]];
}

/**
 * 把底板坐标系中的点投影到像素：K·(R·P + t)
 * @param {number[][]} K
 * @param {number[][]} R
 * @param {number[]} t
 * @param {number[]} P [X, Y, Z]（mm）
 * @returns {[number, number, number]} [u, v, 深度 z_c]
 */
export function project(K, R, t, P) {
  const pc = add3(mulVec3(R, P), t);
  const q = mulVec3(K, pc);
  return [q[0] / q[2], q[1] / q[2], pc[2]];
}

/**
 * 由"看向目标点"的参数构造相机位姿。
 * 相机位于目标点的操作者一侧（−Y）斜上方，图像上方 = 底板远端（+Y）。
 * @param {{target:number[], distance:number, pitchDeg:number, yawDeg?:number, rollDeg?:number}} p
 *   pitchDeg：光轴俯角，90° = 垂直向下拍；yawDeg：绕竖直轴转动相机所在方位（俯视逆时针为正）；
 *   rollDeg：绕光轴旋转（顺时针为正，从相机后方看）
 * @returns {{R:number[][], t:number[], position:[number,number,number]}}
 */
export function lookAtPose({ target, distance, pitchDeg, yawDeg = 0, rollDeg = 0 }) {
  const p = deg2rad(pitchDeg);
  const y = deg2rad(yawDeg);
  const r = deg2rad(rollDeg);
  const h = [Math.sin(y), -Math.cos(y), 0]; // 目标点指向相机的水平方向
  const C = add3(target, add3(scale3(h, distance * Math.cos(p)), [0, 0, distance * Math.sin(p)]));
  const z = normalize3(sub3(target, C)); // 光轴
  const x0 = [Math.cos(y), Math.sin(y), 0]; // 图像向右 = 水平方向
  const y0 = cross3(z, x0); // 图像向下
  // 绕光轴转 roll
  const x = add3(scale3(x0, Math.cos(r)), scale3(y0, Math.sin(r)));
  const yy = cross3(z, x);
  const R = [x, yy, z];
  const t = scale3(mulVec3(R, C), -1);
  return { R, t, position: /** @type {[number,number,number]} */ (C) };
}

/** 光心位置 C = −Rᵀt */
export function cameraCenter(R, t) {
  return scale3(mulVec3(transpose3(R), t), -1);
}

/**
 * 俯角（度）：光轴方向 d = Rᵀ·(0,0,1)，pitch = asin(−d_z)；90° 表示垂直向下拍
 * @param {number[][]} R
 */
export function pitchDegFromR(R) {
  return rad2deg(Math.asin(-R[2][2]));
}

/**
 * 像素 (u, v) 对应的视线：从光心 C 出发，方向 d = Rᵀ·K⁻¹·(u, v, 1)（底板坐标，已归一化）
 * @returns {{origin:number[], dir:number[]}}
 */
export function pixelRay(K, R, t, [u, v]) {
  const x = (u - K[0][2]) / K[0][0];
  const y = (v - K[1][2]) / K[1][1];
  const Rt = transpose3(R);
  const d = normalize3(mulVec3(Rt, [x, y, 1]));
  return { origin: cameraCenter(R, t), dir: d };
}

/**
 * 视线与水平面 Z = z0 的交点；视线不朝下（打不到该平面）时返回 null
 * @returns {number[]|null}
 */
export function rayHitPlaneZ(origin, dir, z0 = 0) {
  if (!(dir[2] < -1e-9)) return null;
  const s = (z0 - origin[2]) / dir[2];
  if (s <= 0) return null;
  return add3(origin, scale3(dir, s));
}

/**
 * 照片四角（左上、右上、右下、左下）的视线落到底板平面上的位置。
 * 打不到底板平面的角，给出沿视线方向 fallbackLen 长的端点，并标记 hit = false。
 * @returns {{hit:boolean, point:number[]}[]}
 */
export function photoFootprint(K, R, t, W, H, fallbackLen = 600) {
  return [[0, 0], [W, 0], [W, H], [0, H]].map((uv) => {
    const { origin, dir } = pixelRay(K, R, t, uv);
    const p = rayHitPlaneZ(origin, dir, 0);
    return p ? { hit: true, point: p } : { hit: false, point: add3(origin, scale3(dir, fallbackLen)) };
  });
}
