// 机械臂逆运动学 / 正运动学（纯函数，不碰 DOM）。
// 结构：底座绕 Z 旋转（θ₀）→ 肩关节（θ₁，大臂与水平面夹角）→ 肘关节（θ₂，小臂相对大臂）
//       → 腕关节（θ₃，夹爪相对小臂）。三个俯仰关节都在过 Z 轴的竖直平面内。
// 坐标都相对底座：原点在底座底面中心，轴向与底板坐标相同（X 右、Y 远离操作者、Z 向上），单位 mm。
// 角度一律弧度；θ₁ + θ₂ + θ₃ = −π/2 时夹爪竖直向下。

/**
 * @typedef {{ L0: number, L1: number, L2: number, L3: number }} ArmDims
 * @typedef {[number, number, number, number]} ArmAngles  [θ₀, θ₁, θ₂, θ₃]
 */

/**
 * 逆运动学：指尖到达 target（夹爪竖直向下，肘部朝上）
 * @param {number[]} target [x, y, z]，相对底座
 * @param {ArmDims} arm
 * @returns {{ reachable: true, angles: ArmAngles } | { reachable: false, reason: string }}
 */
export function ik([x, y, z], { L0, L1, L2, L3 }) {
  const theta0 = Math.atan2(y, x);
  const r = Math.hypot(x, y);
  const zp = z + L3 - L0; // 腕关节相对肩关节的高度
  const D = (r * r + zp * zp - L1 * L1 - L2 * L2) / (2 * L1 * L2);
  if (!(Math.abs(D) <= 1)) {
    return { reachable: false, reason: D > 1 ? '太远，手臂伸直也够不到' : '太近，手臂折叠后仍够不到' };
  }
  const theta2 = -Math.acos(D);
  const theta1 = Math.atan2(zp, r) - Math.atan2(L2 * Math.sin(theta2), L1 + L2 * Math.cos(theta2));
  const theta3 = -Math.PI / 2 - theta1 - theta2;
  return { reachable: true, angles: [theta0, theta1, theta2, theta3] };
}

/**
 * 正运动学：各关节位置（相对底座）
 * @param {ArmAngles} angles
 * @param {ArmDims} arm
 * @returns {{ shoulder: number[], elbow: number[], wrist: number[], tip: number[] }}
 */
export function fkChain([t0, t1, t2, t3], { L0, L1, L2, L3 }) {
  const c0 = Math.cos(t0);
  const s0 = Math.sin(t0);
  // 竖直平面内的 (径向 r, 高度 z) → 三维
  const at = (r, z) => [r * c0, r * s0, z];
  const a1 = t1;
  const a2 = t1 + t2;
  const a3 = t1 + t2 + t3;
  const re = L1 * Math.cos(a1);
  const ze = L0 + L1 * Math.sin(a1);
  const rw = re + L2 * Math.cos(a2);
  const zw = ze + L2 * Math.sin(a2);
  return {
    shoulder: at(0, L0),
    elbow: at(re, ze),
    wrist: at(rw, zw),
    tip: at(rw + L3 * Math.cos(a3), zw + L3 * Math.sin(a3)),
  };
}

/**
 * 正运动学：指尖位置（相对底座）
 * @param {ArmAngles} angles
 * @param {ArmDims} arm
 * @returns {number[]}
 */
export function fk(angles, arm) {
  return fkChain(angles, arm).tip;
}

/** 底板坐标 → 相对底座 */
export function toBase(P, { base }) {
  return [P[0] - base[0], P[1] - base[1], P[2] - base[2]];
}

/** 相对底座 → 底板坐标 */
export function fromBase(p, { base }) {
  return [p[0] + base[0], p[1] + base[1], p[2] + base[2]];
}

/**
 * 底板坐标下的逆运动学
 * @param {number[]} P 底板坐标
 * @param {ArmDims & { base: number[] }} arm
 */
export function ikWorld(P, arm) {
  return ik(toBase(P, arm), arm);
}

/**
 * 底板坐标下的正运动学：指尖位置
 * @param {ArmAngles} angles
 * @param {ArmDims & { base: number[] }} arm
 */
export function fkWorld(angles, arm) {
  return fromBase(fk(angles, arm), arm);
}

/**
 * 两组关节角之间插值（θ₀ 走最短的方向）；θ₃ 由 θ₁、θ₂ 推出，保证途中夹爪始终竖直向下
 * @param {ArmAngles} a
 * @param {ArmAngles} b
 * @param {number} k 0 → 1
 * @returns {ArmAngles}
 */
export function lerpAngles(a, b, k) {
  let d0 = b[0] - a[0];
  d0 = Math.atan2(Math.sin(d0), Math.cos(d0));
  const t1 = a[1] + (b[1] - a[1]) * k;
  const t2 = a[2] + (b[2] - a[2]) * k;
  return [a[0] + d0 * k, t1, t2, -Math.PI / 2 - t1 - t2];
}
