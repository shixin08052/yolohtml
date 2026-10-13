// 机械臂逆运动学 / 正运动学与碰撞检查（纯函数，不碰 DOM）。
// 结构：底座绕 Z 旋转（θ₀）→ 肩关节（θ₁，大臂与水平面夹角）→ 肘关节（θ₂，小臂相对大臂）
//       → 腕关节俯仰（θ₃，夹爪相对小臂）→ 腕关节转动（θ₄，夹爪绕自身竖直轴转）。
// 三个俯仰关节都在过 Z 轴的竖直平面内。
// 坐标都相对底座：原点在底座底面中心，轴向与底板坐标相同（X 右、Y 远离操作者、Z 向上），单位 mm。
// 角度一律弧度；θ₁ + θ₂ + θ₃ = −π/2 时夹爪竖直向下。
// 两指连线（夹紧方向）在水平面内的方向 = θ₀ + π/2 + θ₄。

/**
 * @typedef {{ L0: number, L1: number, L2: number, L3: number }} ArmDims
 * @typedef {[number, number, number, number, number]} ArmAngles  [θ₀, θ₁, θ₂, θ₃, θ₄]
 */

/**
 * 碰撞检查用的形状：每段连杆近似为胶囊体（线段 + 半径，mm），与 scene/arm.js 的外形对应并留有余量。
 * 大臂是两片侧板夹着小臂的叉形结构，小臂可以折进两片侧板之间，所以大臂与小臂之间只限制折叠角。
 */
export const ARM_SHAPE = {
  plinth: { h: 22, r: 52 },   // 底座圆盘
  column: { r: 30 },          // 立柱（从地面到肩关节）
  shoulderKnuckle: 20,        // 肩关节轴套半径
  upper: 22,                  // 大臂（叉形，含两片侧板）
  fore: 12,                   // 小臂
  gripper: 24,                // 夹爪（腕关节到指尖，含掌板宽度）
  margin: 2,                  // 额外间隙
  maxFold: (165 * Math.PI) / 180, // 肘关节最大折叠角 |θ₂|
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** 两条线段之间的最短距离 */
export function segmentDistance(p1, q1, p2, q2) {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s;
  let t;
  if (a < 1e-12 && e < 1e-12) return Math.sqrt(dot(r, r));
  if (a < 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e < 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const w = sub(c1, c2);
  return Math.sqrt(dot(w, w));
}

/**
 * 正运动学：各关节位置（相对底座）
 * @param {number[]} angles
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
 * @param {number[]} angles
 * @param {ArmDims} arm
 * @returns {number[]}
 */
export function fk(angles, arm) {
  return fkChain(angles, arm).tip;
}

/**
 * 姿态检查：关节限位、自身碰撞、不低于桌面
 * @param {number[]} angles
 * @param {ArmDims} arm
 * @param {typeof ARM_SHAPE} [shape]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPose(angles, arm, shape = ARM_SHAPE) {
  const { shoulder, elbow, wrist, tip } = fkChain(angles, arm);
  const m = shape.margin;
  if (Math.abs(angles[2]) > shape.maxFold) return { ok: false, reason: '太靠近底座，肘关节折不了这么多' };
  if (elbow[2] < shape.upper + m || wrist[2] < shape.fore + m || tip[2] < -1e-6) {
    return { ok: false, reason: '太低，手臂会碰到桌面' };
  }
  const base0 = [0, 0, 0];
  const plinthTop = [0, 0, shape.plinth.h];
  const colTop = [0, 0, arm.L0];
  const near = (p, q, r1, a, b, r2) => segmentDistance(p, q, a, b) < r1 + r2 + m;
  // 夹爪与底座、立柱、大臂
  if (near(wrist, tip, shape.gripper, base0, plinthTop, shape.plinth.r) || near(wrist, tip, shape.gripper, base0, colTop, shape.column.r)) {
    return { ok: false, reason: '太靠近底座，夹爪会碰到底座' };
  }
  if (near(wrist, tip, shape.gripper, shoulder, elbow, shape.upper)) {
    return { ok: false, reason: '太靠近底座，夹爪会碰到大臂' };
  }
  // 小臂与底座、立柱、肩关节轴套
  if (
    near(elbow, wrist, shape.fore, base0, plinthTop, shape.plinth.r) ||
    near(elbow, wrist, shape.fore, base0, colTop, shape.column.r) ||
    near(elbow, wrist, shape.fore, shoulder, shoulder, shape.shoulderKnuckle)
  ) {
    return { ok: false, reason: '太靠近底座，小臂会碰到底座' };
  }
  return { ok: true };
}

/** 角度归一化到 (−π/2, π/2]（夹爪两指对称，转 180° 等价） */
function wrapHalf(a) {
  let x = Math.atan2(Math.sin(a), Math.cos(a)); // (−π, π]
  if (x > Math.PI / 2) x -= Math.PI;
  else if (x <= -Math.PI / 2) x += Math.PI;
  return x;
}

/**
 * 逆运动学：指尖到达 target（夹爪竖直向下，肘部朝上），并检查限位与碰撞
 * @param {number[]} target [x, y, z]，相对底座
 * @param {ArmDims} arm
 * @param {{ gripYaw?: number, check?: boolean }} [opts]
 *   gripYaw：两指连线在水平面内的方向（底板坐标，弧度）；不给时腕部不转（θ₄ = 0）。
 *   check：是否检查限位与碰撞（默认 true）
 * @returns {{ reachable: true, angles: ArmAngles } | { reachable: false, reason: string }}
 */
export function ik([x, y, z], arm, { gripYaw = null, check = true } = {}) {
  const { L0, L1, L2, L3 } = arm;
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
  const theta4 = gripYaw == null ? 0 : wrapHalf(gripYaw - theta0 - Math.PI / 2);
  const angles = /** @type {ArmAngles} */ ([theta0, theta1, theta2, theta3, theta4]);
  if (check) {
    const c = checkPose(angles, arm);
    if (!c.ok) return { reachable: false, reason: c.reason };
  }
  return { reachable: true, angles };
}

/** 两指连线在水平面内的方向（底板坐标，弧度） */
export function gripLineAngle(angles) {
  return angles[0] + Math.PI / 2 + (angles[4] ?? 0);
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
 * @param {{ gripYaw?: number, check?: boolean }} [opts]
 */
export function ikWorld(P, arm, opts) {
  return ik(toBase(P, arm), arm, opts);
}

/**
 * 底板坐标下的正运动学：指尖位置
 * @param {number[]} angles
 * @param {ArmDims & { base: number[] }} arm
 */
export function fkWorld(angles, arm) {
  return fromBase(fk(angles, arm), arm);
}

/**
 * 两组关节角之间插值（θ₀ 走最短的方向）；θ₃ 由 θ₁、θ₂ 推出，保证途中夹爪始终竖直向下
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} k 0 → 1
 * @returns {ArmAngles}
 */
export function lerpAngles(a, b, k) {
  let d0 = b[0] - a[0];
  d0 = Math.atan2(Math.sin(d0), Math.cos(d0));
  const t1 = a[1] + (b[1] - a[1]) * k;
  const t2 = a[2] + (b[2] - a[2]) * k;
  const a4 = a[4] ?? 0;
  const t4 = a4 + ((b[4] ?? 0) - a4) * k;
  return [a[0] + d0 * k, t1, t2, -Math.PI / 2 - t1 - t2, t4];
}

/**
 * 关节空间直线插值的路径是否全程不碰撞（取 n 个中间姿态检查）
 * @param {number[]} a
 * @param {number[]} b
 * @param {ArmDims} arm
 * @param {number} [n=24]
 */
export function pathClear(a, b, arm, n = 24) {
  for (let i = 1; i < n; i++) {
    if (!checkPose(lerpAngles(a, b, i / n), arm).ok) return false;
  }
  return true;
}
