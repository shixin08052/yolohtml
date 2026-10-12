// 底板坐标 ↔ Three.js 坐标的唯一转换处。
// 底板：X 向右，Y 远离操作者，Z 垂直板面向上（mm）
// Three.js：x = X，y = Z，z = −Y（1 单位 = 1 mm）
import { Vector3 } from 'three';

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
