// 分拣规划（纯函数，不碰 DOM）。
// 1. 每个零件：抓取点 = 零件中心半高处；夹爪转到两指连线垂直于零件长轴（圆形零件不转）；
//    抓取点和正上方 approach 高度处都要可达（含碰撞检查），否则跳过
// 2. 每个零件放进对应类别的料盒：盒内 2 × 2 个位置依次错开，放满一层再往上叠一层；
//    放置点和盒口上方悬停点都要可达
// 3. 顺序：贪心最近邻——从当前夹爪位置出发，每次选水平距离最近的零件；放下后从料盒上方继续
import { BIN_WALL } from '../config.js';
import { ikWorld } from './ik.js';

/** 每类零件被夹住处的宽度（mm）：电阻本体 Φ2.9、电容 Φ8、LED Φ5、螺丝杆 Φ2.5（抓在杆的中部） */
export const GRIP_WIDTH = { 0: 2.9, 1: 8, 2: 5, 3: 2.5 };

/** 有长轴的类别（夹爪两指连线要垂直于长轴） */
const LONG = new Set([0, 3]);

/** 料盒内 2 × 2 的放置位置（相对盒中心，mm） */
export const BIN_SLOTS = [[-12, -14], [12, -14], [-12, 14], [12, 14]];

/** 料盒上方悬停高度：盒口再往上 approach */
export const binHoverZ = (bin, arm) => bin.size[2] + arm.approach;

/**
 * 两指连线方向（弧度）：长条零件垂直于长轴，圆形零件 null（夹爪不转）
 * @param {import('../state.js').Part} part
 */
export function gripYawFor(part) {
  return LONG.has(part.cls) ? (((part.rotDeg ?? 0) + 90) * Math.PI) / 180 : null;
}

/**
 * 第 k 个放进某料盒的零件放在哪：盒内位置与底面高度（叠放时往上一层）
 * @param {{center:number[], size:number[]}} bin
 * @param {number} k 该料盒里已有的零件数
 * @param {number} layerH 每层高度（取该类零件高度）
 * @returns {{ x: number, y: number, floor: number }}
 */
export function binSlot(bin, k, layerH) {
  const [ox, oy] = BIN_SLOTS[k % BIN_SLOTS.length];
  const layer = Math.floor(k / BIN_SLOTS.length);
  return { x: bin.center[0] + ox, y: bin.center[1] + oy, floor: BIN_WALL + layer * layerH };
}

/**
 * 分拣规划
 * @param {import('../state.js').Part[]} parts
 * @param {{id:number, cls:number, center:number[], size:number[]}[]} bins
 * @param {import('./ik.js').ArmDims & { base: number[], approach: number }} arm
 * @param {{ start?: number[] }} [opts] start：夹爪当前位置（底板坐标），默认机械臂底座正上方
 * @returns {{ tasks: (import('../state.js').PickTask & { gripYaw: number|null, hoverFrom: number[], hoverTo: number[] })[],
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
    const from = [p.x, p.y, p.heightMm / 2];
    const hoverFrom = [p.x, p.y, from[2] + arm.approach];
    const a = ikWorld(from, arm, { gripYaw });
    const b = a.reachable ? ikWorld(hoverFrom, arm, { gripYaw }) : a;
    if (!a.reachable || !b.reachable) {
      skipped.push({ ...p, reachable: false, skipReason: (a.reachable ? b : a).reason });
      continue;
    }
    candidates.push({ part: p, bin, gripYaw, from, hoverFrom });
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
    const slot = binSlot(c.bin, k, c.part.heightMm);
    const to = [slot.x, slot.y, slot.floor + c.part.heightMm / 2];
    const hoverTo = [slot.x, slot.y, Math.max(binHoverZ(c.bin, arm), to[2] + arm.approach)];
    const pa = ikWorld(to, arm, { gripYaw: c.gripYaw });
    const pb = pa.reachable ? ikWorld(hoverTo, arm, { gripYaw: c.gripYaw }) : pa;
    if (!pa.reachable || !pb.reachable) {
      skipped.push({ ...c.part, reachable: false, skipReason: `料盒里够不到：${(pa.reachable ? pb : pa).reason}` });
      continue;
    }
    fill.set(c.bin.id, k + 1);
    tasks.push({ partId: c.part.id, binId: c.bin.id, from: c.from, to, gripYaw: c.gripYaw, hoverFrom: c.hoverFrom, hoverTo });
    cur = hoverTo;
  }
  return { tasks, skipped };
}
