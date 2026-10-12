// 底板坐标 ↔ Three.js 坐标的唯一转换处。
// 底板：X 向右，Y 远离操作者，Z 垂直板面向上（mm）
// Three.js：x = X，y = Z，z = −Y（1 单位 = 1 mm）
import { Vector3, Matrix4, Quaternion } from 'three';

/**
 * 底板坐标 → Three.js 坐标
 * @param {number} X
 * @param {number} Y
 * @param {number} [Z=0]
 * @returns {Vector3}
 */
export function toThree(X, Y, Z = 0) {
  // 加 0 把 −0 规整为 0
  return new Vector3(X, Z, -Y + 0);
}

/**
 * Three.js 坐标 → 底板坐标
 * @param {{x:number, y:number, z:number}} v
 * @returns {[number, number, number]} [X, Y, Z]
 */
export function fromThree(v) {
  return [v.x, -v.z + 0, v.y];
}

/**
 * 相机位姿（OpenCV 约定，Pc = R·Pw + t）→ Three.js 相机的朝向。
 * OpenCV 相机轴 x 右、y 下、z 向前；Three.js 相机 x 右、y 上、看向 −z。
 * 所以 Three.js 相机三个轴在底板坐标系里 = Rᵀ·diag(1, −1, −1) 的三列，再各自 toThree。
 * @param {number[][]} R
 * @returns {Quaternion}
 */
export function cameraQuaternionFromR(R) {
  // Rᵀ 的第 k 列 = R 的第 k 行
  const ax = toThree(R[0][0], R[0][1], R[0][2]);
  const ay = toThree(-R[1][0], -R[1][1], -R[1][2]);
  const az = toThree(-R[2][0], -R[2][1], -R[2][2]);
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(ax, ay, az));
}
