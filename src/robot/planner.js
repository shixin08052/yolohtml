// 分拣规划（纯函数，不碰 DOM）。
// 1. 每个零件：指尖下到离板面 GRASP_Z 处夹取（指尖垫片高 10 mm，正好包住躺平零件的中部）；
//    长条零件（电阻、LED）两指连线垂直于长轴；夹在本体中心（检测框只框本体，框中心就是本体中心）；
//    圆形零件夹爪不转。
//    抓取点和正上方 approach 高度处都要可达（含碰撞检查），否则跳过
// 2. 放进对应类别的料盒：长条零件搬运途中转动夹爪，放下时沿料盒长边（Y）摆放，每层 2 个；
//    圆形零件每层 2 × 2 个；放满一层往上叠一层。放置点和盒口上方悬停点都要可达
// 3. 顺序：贪心最近邻——从当前夹爪位置出发，每次选水平距离最近的零件；放下后从料盒上方继续
import { BIN_WALL } from '../config.js';
import { ikWorld } from './ik.js';

/** 每类零件被夹住处的宽度（mm）：电阻本体 Φ2.9、LED 灯体 Φ5 */
export const GRIP_WIDTH = { 0: 2.9, 1: 5 };

/** 夹取时指尖离零件底面的高度（mm）：指尖略高于板面 */
export const GRASP_Z = 0.5;

/** 有长轴的类别（夹爪两指连线要垂直于长轴） */
const LONG = new Set([0, 1]);

/** 料盒内的放置位置（相对盒中心，mm）：圆形零件 2 × 2；长条零件沿 Y 摆放、左右两个 */
export const BIN_SLOTS = [[-12, -14], [12, -14], [-12, 14], [12, 14]];
export const BIN_SLOTS_LONG = [[-10, 0], [10, 0]];

/** 料盒上方悬停高度：盒口再往上 approach */
export const binHoverZ = (bin, arm) => bin.size[2] + arm.approach;

const rad = (d) => (d * Math.PI) / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * 两指连线方向（弧度）：长条零件垂直于长轴，圆形零件 null（夹爪不转）
 * @param {import('../state.js').Part} part
 */
export function gripYawFor(part) {
  return LONG.has(part.cls) ? rad((part.rotDeg ?? 0) + 90) : null;
}

/**
 * 夹取点（底板坐标）：零件本体中心，高度 GRASP_Z
 * @param {import('../state.js').Part} part
 */
export function graspPoint(part) {
  return [part.x, part.y, GRASP_Z];
}

/**
 * 第 k 个放进某料盒的零件放在哪：盒内位置与底面高度（叠放时往上一层）
 * @param {{center:number[], size:number[]}} bin
 * @param {number} k 该料盒里已有的零件数
 * @param {number} layerH 每层高度（取该类零件高度）
 * @param {boolean} [long=false] 是否长条零件
 * @returns {{ x: number, y: number, floor: number }}
 */
export function binSlot(bin, k, layerH, long = false) {
  const slots = long ? BIN_SLOTS_LONG : BIN_SLOTS;
  const [ox, oy] = slots[k % slots.length];
  const layer = Math.floor(k / slots.length);
  return { x: bin.center[0] + ox, y: bin.center[1] + oy, floor: BIN_WALL + layer * layerH };
}

/**
 * 放置点：夹在本体中心，所以指尖落在 slot 上，零件中心就在 slot 上。
 * 零件挂在夹爪上随夹爪转动，搬运途中转过的角度 Δ = (θ₀ + θ₄)放 − (θ₀ + θ₄)取（θ₀ 走最短方向，与 lerpAngles 一致）；
 * 长条零件放下时要沿料盒长边（Y），所以放下时的夹爪方向比抓取时多转 (90° − 朝向)。
 * @returns {{ to: number[], placeYaw: number|null, partYawDeg: number } | { error: string }}
 */
function placeFor(part, pickAngles, slot, z, arm) {
  const rot = rad(part.rotDeg ?? 0);
  const placeYaw = LONG.has(part.cls) ? gripYawFor(part) + (Math.PI / 2 - rot) : null;
  const to = [slot.x, slot.y, z];
  const s = ikWorld(to, arm, { gripYaw: placeYaw });
  if (!s.reachable) return { error: s.reason };
  const delta = wrapPi(s.angles[0] - pickAngles[0]) + (s.angles[4] - pickAngles[4]);
  return { to, placeYaw, partYawDeg: ((rot + delta) * 180) / Math.PI };
}

/**
 * 分拣规划
 * @param {import('../state.js').Part[]} parts
 * @param {{id:number, cls:number, center:number[], size:number[]}[]} bins
 * @param {import('./ik.js').ArmDims & { base: number[], approach: number }} arm
 * @param {{ start?: number[] }} [opts] start：夹爪当前位置（底板坐标），默认机械臂底座正上方
 * @returns {{ tasks: (import('../state.js').PickTask & { gripYaw: number|null, placeYaw: number|null, graspZ: number,
 *                     hoverFrom: number[], hoverTo: number[], partYawDeg: number })[],
 *             skipped: (import('../state.js').Part & { skipReason: string })[] }}
 */
export function plan(parts, bins, arm, { start = [arm.base[0], arm.base[1], 0] } = {}) {
  const skipped = [];
  const candidates = [];
  for (const p of parts) {
    const bin = bins.find((b) => b.cls === p.cls);
    if (!bin) {
      skipped.push({ ...p, reachable: false, skipReason: '没有对应的料盒' });
      continue;
    }
    const gripYaw = gripYawFor(p);
    const from = graspPoint(p);
    const hoverFrom = [from[0], from[1], from[2] + arm.approach];
    const a = ikWorld(from, arm, { gripYaw });
    const b = a.reachable ? ikWorld(hoverFrom, arm, { gripYaw }) : a;
    if (!a.reachable || !b.reachable) {
      skipped.push({ ...p, reachable: false, skipReason: (a.reachable ? b : a).reason });
      continue;
    }
    candidates.push({ part: p, bin, gripYaw, from, hoverFrom, pickAngles: a.angles });
  }

  // 贪心最近邻；距离相同按零件 id 排
  const tasks = [];
  const fill = new Map(); // binId → 已放入的零件数
  let cur = start;
  const left = [...candidates].sort((a, b) => a.part.id - b.part.id);
  while (left.length) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((c, i) => {
      const d = Math.hypot(c.from[0] - cur[0], c.from[1] - cur[1]);
      if (d < bestD - 1e-9) {
        bestD = d;
        best = i;
      }
    });
    const c = left.splice(best, 1)[0];
    const k = fill.get(c.bin.id) ?? 0;
    const slot = binSlot(c.bin, k, c.part.heightMm, LONG.has(c.part.cls));
    const pl = placeFor(c.part, c.pickAngles, slot, slot.floor + GRASP_Z, arm);
    let reason = pl.error;
    let hoverTo = null;
    if (!reason) {
      hoverTo = [pl.to[0], pl.to[1], Math.max(binHoverZ(c.bin, arm), pl.to[2] + arm.approach)];
      const h = ikWorld(hoverTo, arm, { gripYaw: pl.placeYaw });
      if (!h.reachable) reason = h.reason;
    }
    if (reason) {
      skipped.push({ ...c.part, reachable: false, skipReason: `料盒里够不到：${reason}` });
      continue;
    }
    fill.set(c.bin.id, k + 1);
    tasks.push({
      partId: c.part.id,
      binId: c.bin.id,
      from: c.from,
      to: pl.to,
      gripYaw: c.gripYaw,
      placeYaw: pl.placeYaw,
      graspZ: GRASP_Z,
      hoverFrom: c.hoverFrom,
      hoverTo,
      partYawDeg: pl.partYawDeg,
    });
    cur = hoverTo;
  }
  return { tasks, skipped };
}
