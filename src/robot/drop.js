// 零件落进料盒（纯函数，不碰 DOM）：不用物理引擎，用很简单的几何做出"碰撞散落"的效果。
// 1. 落点：夹爪在盒底上方松开，零件先带一点随机偏移和转角落下；
//    落点与盒里已有的零件重叠（俯视的占地矩形相交）或碰到盒壁时，就近找一个不重叠的位置（像被弹开）。
//    盒底实在放不下时才叠到上一层。
// 2. 下落动画：先自由落体，接近盒底时开始滑向落点、转到最终角度，落地后弹两下停住。
// 零件的占地用几个矩形表示（局部坐标：x 沿零件长轴，halfW 为垂直长轴的半宽），本体和引脚各一个。
import { BIN_WALL } from '../config.js';

/** 参数：松开时零件底面离盒底的高度、占地矩形之间留的间隙、落点随机偏移、动画时长 */
export const DROP = { height: 12, margin: 0.4, jitterMm: 3, jitterDeg: 12, ms: 700 };

/** 可复现的伪随机数（mulberry32），返回 [0, 1) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 占地矩形在底板坐标下的四个角
 * @param {{ rects: {minX:number, maxX:number, halfW:number}[] }} fp
 * @param {{ x: number, y: number, yaw: number }} pose yaw 为角度（°）
 * @param {number} [grow=0] 每边外扩
 * @returns {number[][][]}
 */
export function footprintPolys(fp, { x, y, yaw }, grow = 0) {
  const a = (yaw * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return fp.rects.map(({ minX, maxX, halfW }) =>
    [[minX - grow, -halfW - grow], [maxX + grow, -halfW - grow], [maxX + grow, halfW + grow], [minX - grow, halfW + grow]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]),
  );
}

/** 两个凸多边形是否相交（分离轴定理） */
export function polysOverlap(A, B) {
  for (const P of [A, B]) {
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i];
      const [x1, y1] = P[(i + 1) % P.length];
      const nx = y0 - y1;
      const ny = x1 - x0;
      let aMin = Infinity;
      let aMax = -Infinity;
      for (const [x, y] of A) {
        const d = x * nx + y * ny;
        aMin = Math.min(aMin, d);
        aMax = Math.max(aMax, d);
      }
      let bMin = Infinity;
      let bMax = -Infinity;
      for (const [x, y] of B) {
        const d = x * nx + y * ny;
        bMin = Math.min(bMin, d);
        bMax = Math.max(bMax, d);
      }
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

/** 两组占地矩形是否有任意一对相交 */
const anyOverlap = (as, bs) => as.some((a) => bs.some((b) => polysOverlap(a, b)));

/** 是否全部在盒内（盒壁内侧再留 margin） */
export function insideBin(polys, bin, margin = 0) {
  const hx = bin.size[0] / 2 - BIN_WALL - margin;
  const hy = bin.size[1] / 2 - BIN_WALL - margin;
  return polys.every((P) => P.every(([x, y]) => Math.abs(x - bin.center[0]) <= hx && Math.abs(y - bin.center[1]) <= hy));
}

/**
 * 零件落在盒里的哪里
 * @param {{ center: number[], size: number[] }} bin
 * @param {{ fp: object, x: number, y: number, yaw: number, z: number, height: number }[]} placed 盒里已有的零件（z 为底面高度）
 * @param {{ rects: object[], height: number }} fp 这个零件的占地与高度
 * @param {{ x: number, y: number, yaw: number }} release 松开时零件中心的位置与朝向（°）
 * @param {{ seed?: number }} [opts]
 * @returns {{ x: number, y: number, yaw: number, z: number, layer: number }}
 */
export function settle(bin, placed, fp, release, { seed = 1 } = {}) {
  const rand = rng(seed);
  const jx = (rand() * 2 - 1) * DROP.jitterMm;
  const jy = (rand() * 2 - 1) * DROP.jitterMm;
  const jYaw = (rand() * 2 - 1) * DROP.jitterDeg;
  const phase = rand() * Math.PI * 2;
  const start = { x: release.x + jx, y: release.y + jy, yaw: release.yaw + jYaw };
  // 每层：先试带随机偏移的落点，再由近到远绕圈找；转角先保持，不行再多转一点
  const yaws = [0, 8, -8, 16, -16, 25, -25, 40, -40, 60, -60, 90].map((d) => start.yaw + d);
  const free = (pose, others) => {
    const polys = footprintPolys(fp, pose);
    if (!insideBin(polys, bin)) return false;
    const grown = footprintPolys(fp, pose, DROP.margin);
    return !others.some((o) => anyOverlap(grown, footprintPolys(o.fp, o)));
  };
  // 从盒里已有零件的最高一层开始找：不能钻到上层零件下面去（随机偏移可能在下层空出一点地方）
  let floor = Math.max(BIN_WALL, ...placed.map((o) => o.z));
  const firstLayer = new Set(placed.filter((o) => o.z < floor - 1e-6).map((o) => o.z.toFixed(3))).size;
  for (let layer = firstLayer; layer < firstLayer + 4; layer++) {
    const others = placed.filter((o) => Math.abs(o.z - floor) < 1e-6);
    for (let r = 0; r <= 45; r += 1.5) {
      const n = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / 1.5));
      for (let i = 0; i < n; i++) {
        const t = phase + (2 * Math.PI * i) / n;
        for (const yaw of yaws) {
          const pose = { x: start.x + r * Math.cos(t), y: start.y + r * Math.sin(t), yaw };
          if (free(pose, others)) return { ...pose, z: floor, layer };
        }
      }
    }
    // 这一层放不下：叠到上一层（取这一层零件中最高的）
    floor += Math.max(fp.height, ...others.map((o) => o.height));
  }
  return { ...start, z: floor, layer: firstLayer + 4 };
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) ** 3);

/**
 * 下落动画在进度 k（0–1）时的位姿：自由落体 → 落地弹两下；水平位置和角度在快落地时开始滑向落点
 * @param {{ from: number[], to: number[] }} d from / to：[x, y, 底面高度 z, 朝向°]
 * @param {number} k
 * @returns {number[]} [x, y, z, yaw]
 */
export function dropPose({ from, to }, k) {
  const [x0, y0, z0, a0] = from;
  const [x1, y1, z1, a1] = to;
  const fall = 0.45; // 落地时刻
  const h = Math.max(0, z0 - z1);
  let z;
  if (k < fall) {
    z = z0 - (z0 - z1) * (k / fall) ** 2;
  } else {
    const b1 = Math.min(2.5, 0.2 * h);
    const bump = (u, b) => b * 4 * u * (1 - u);
    if (k < 0.72) z = z1 + bump((k - fall) / (0.72 - fall), b1);
    else if (k < 0.88) z = z1 + bump((k - 0.72) / 0.16, b1 * 0.35);
    else z = z1;
  }
  // 离盒底还剩约 1/3 高度时开始滑动（像擦着下面的零件弹开），落地弹跳期间滑到位
  const s = easeOut((k - 0.6 * fall) / (0.9 - 0.6 * fall));
  const da = ((((a1 - a0) % 360) + 540) % 360) - 180;
  return [x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, z, a0 + da * smooth(s)];
}
