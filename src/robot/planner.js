// 分拣规划（纯函数，不碰 DOM）。
// 1. 每个零件：指尖下到离板面 GRASP_Z 处夹取（指尖垫片高 10 mm，正好包住躺平零件的中部）；
//    长条零件（电阻、LED）两指连线垂直于长轴；夹在本体中心（检测框只框本体，框中心就是本体中心）；
//    圆形零件夹爪不转。
//    抓取点和正上方 approach 高度处都要可达（含碰撞检查），否则跳过
// 2. 放进对应类别的料盒：长条零件搬运途中转动夹爪，转成沿料盒长边（Y）；夹爪在盒底上方松开（左右交替），
//    零件落下后按 drop.js 散开到不与盒里已有零件重叠的位置。松开点和盒口上方悬停点都要可达
// 3. 顺序：贪心最近邻——从当前夹爪位置出发，每次选水平距离最近的零件；放下后从料盒上方继续
// 4. 零件挤在一起：只挑手指下得去的；一颗都下不去时先拨开一颗（robot/clearance.js）
import { BIN_WALL, BOARD } from '../config.js';
import { ikWorld } from './ik.js';
import { DROP, settle } from './drop.js';
import { binKey } from './bins.js';
import { findGrasp, planPush } from './clearance.js';

/** 每类零件被夹住处的宽度（mm）：电阻本体中部 Φ2.0（两头的端帽 Φ2.4）、LED 灯体 Φ5 */
export const GRIP_WIDTH = { 0: 2, 1: 5 };

/** 夹取时指尖离零件底面的高度（mm）：指尖略高于板面 */
export const GRASP_Z = 0.5;

/** 有长轴的类别（夹爪两指连线要垂直于长轴） */
const LONG = new Set([0, 1]);

/** 松开点（相对盒中心，mm）：左右交替 */
export const RELEASE_OFFSETS = [[-8, 0], [8, 0]];

/** 没给占地时的默认占地（8 × 4 mm 的块） */
const DEFAULT_FOOTPRINT = { rects: [{ minX: -4, maxX: 4, halfW: 2 }], height: 4 };

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
 * 松开点：夹在本体中心，所以指尖在 slot 正上方时，零件中心就在 slot 上。
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

/** 拨开时合拢的指尖离板面的高度（mm）：低于所有零件本体的顶面，推得到 */
export const PUSH_Z = 1;
/** 每个零件最多拨几次 */
const MAX_PUSHES = 2;

/**
 * 分拣规划
 * 零件挤在一起时（robot/clearance.js）：每一步只在"手指下得去"的零件里挑最近的（张开小一点、抓点沿长轴挪一点也算）；
 * 外侧的拿走后，被挡住的往往就空出来了。一颗都下不去时先拨开一颗（夹爪合拢、推着它滑到空处），再接着规划。
 * @param {import('../state.js').Part[]} parts
 * @param {{id:number, cls:number, center:number[], size:number[]}[]} bins
 * @param {import('./ik.js').ArmDims & { base: number[], approach: number }} arm
 * @param {{ start?: number[], footprints?: Record<number, { rects: object[], height: number }>, board?: { width: number, height: number } }} [opts]
 *   start：夹爪当前位置（底板坐标），默认机械臂底座正上方；footprints：各类零件的占地（scene/parts.js 的 partFootprint）
 * @returns {{ tasks: object[], skipped: (import('../state.js').Part & { skipReason: string })[] }}
 *   tasks 按执行顺序，两种：
 *   - 抓取放入（kind 'pick'）：PickTask + { gripYaw, placeYaw, graspZ, gap, offset, hoverFrom, hoverTo, partYawDeg, drop: { from, to } }
 *     gap：下爪时的张开量；offset：抓点沿长轴偏离本体中心多少（mm）
 *   - 拨开（kind 'push'）：{ partId, gripYaw, start, end, hoverStart, hoverEnd, partFrom, partTo, dist, gap, mode }
 *     gap：推时夹爪的开口（0 合拢；张到最大时只用一根手指拨）
 *     start / end：合拢的指尖推的起止点；partFrom / partTo：零件的 [x, y, z, 朝向°]
 */
export function plan(parts, bins, arm, { start = [arm.base[0], arm.base[1], 0], footprints = {}, board = BOARD } = {}) {
  const skipped = [];
  const candidates = [];
  const fps = {};
  for (const p of parts) fps[p.cls] = footprints[p.cls] ?? DEFAULT_FOOTPRINT;
  const reachable = (P, gripYaw) => ikWorld(P, arm, { gripYaw }).reachable;
  for (const p of parts) {
    // 料盒按 binKey 对应（LED 按颜色）；没有 key 的旧式料盒按类别对应
    const bin = bins.find((b) => (b.key ? b.key === binKey(p) : b.cls === p.cls));
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
    candidates.push({ part: p, bin });
  }

  // 板上还没拿走的零件（够不到、没有料盒的也一直留在板上，挡着别人）；拨开后位置会变
  const onBoard = new Map(parts.map((p) => [p.id, { ...p }]));
  const others = (id) => [...onBoard.values()].filter((o) => o.id !== id);
  const width = (p) => GRIP_WIDTH[p.cls] ?? 5;
  // 抓点及其正上方都要够得着
  const graspOk = (pt, gripYaw) => reachable([pt[0], pt[1], GRASP_Z], gripYaw) && reachable([pt[0], pt[1], GRASP_Z + arm.approach], gripYaw);
  const graspOf = (id) => {
    const part = onBoard.get(id);
    return findGrasp(part, others(id), { width: width(part), fps, ok: (pt) => graspOk(pt, gripYawFor(part)) });
  };

  // 贪心最近邻（只在下得去的零件里挑）；距离相同按零件 id 排
  const tasks = [];
  const fill = new Map(); // binId → 已落在盒里的零件 [{ fp, x, y, yaw, z, height }]
  const pushes = new Map(); // 零件 id → 拨过几次
  let cur = start;
  const left = [...candidates].sort((a, b) => a.part.id - b.part.id);
  while (left.length) {
    let best = -1;
    let bestD = Infinity;
    let grasp = null;
    left.forEach((c, i) => {
      const g = graspOf(c.part.id);
      if (!g) return;
      const d = Math.hypot(g.point[0] - cur[0], g.point[1] - cur[1]);
      if (d < bestD - 1e-9) {
        bestD = d;
        best = i;
        grasp = g;
      }
    });
    if (best < 0) {
      // 一颗都下不去：拨开推得最短的那颗（一样短时离夹爪近的）
      let push = null;
      let pushI = -1;
      left.forEach((c, i) => {
        if ((pushes.get(c.part.id) ?? 0) >= MAX_PUSHES) return;
        const part = onBoard.get(c.part.id);
        const pp = planPush(part, others(part.id), {
          width: width(part),
          fps,
          board,
          ok: (pt) => graspOk(pt, gripYawFor(part)),
          reach: (q, th) => [th, th + Math.PI].some((y) => [PUSH_Z, PUSH_Z + arm.approach].every((z) => reachable([q[0], q[1], z], y))),
        });
        if (!pp) return;
        const key = pp.dist + 1e-3 * Math.hypot(pp.start[0] - cur[0], pp.start[1] - cur[1]);
        if (!push || key < push.key) {
          push = { ...pp, key };
          pushI = i;
        }
      });
      if (!push) {
        for (const c of left) skipped.push({ ...onBoard.get(c.part.id), reachable: false, skipReason: '与旁边的零件挤得太紧：夹爪下不去，拨开又会碰到引脚，请手动分开' });
        break;
      }
      const c = left[pushI];
      const before = onBoard.get(c.part.id);
      // 合拢的两指连线沿推的方向（推杆的形状按这个方向算过避让）；两指对称，转 180° 形状不变，取够得着的那个
      const yaws = [push.pushYaw, push.pushYaw + Math.PI];
      const pushYaw = yaws.find((y) => [push.start, push.end].every((q) => reachable([q[0], q[1], PUSH_Z], y) && reachable([q[0], q[1], PUSH_Z + arm.approach], y)));
      if (pushYaw === undefined) {
        pushes.set(c.part.id, MAX_PUSHES); // 这颗拨不了，下一轮试别的
        continue;
      }
      tasks.push({
        kind: 'push',
        partId: c.part.id,
        gripYaw: pushYaw,
        start: [push.start[0], push.start[1], PUSH_Z],
        end: [push.end[0], push.end[1], PUSH_Z],
        hoverStart: [push.start[0], push.start[1], PUSH_Z + arm.approach],
        hoverEnd: [push.end[0], push.end[1], PUSH_Z + arm.approach],
        partFrom: [before.x, before.y, 0, before.rotDeg ?? 0],
        partTo: [push.part.x, push.part.y, 0, before.rotDeg ?? 0],
        dist: push.dist,
        gap: push.gap, // 推时夹爪的开口：0 = 合拢两指一起顶；张到最大 = 只用一根手指拨
        mode: push.mode,
      });
      onBoard.set(c.part.id, { ...before, x: push.part.x, y: push.part.y });
      pushes.set(c.part.id, (pushes.get(c.part.id) ?? 0) + 1);
      cur = [push.end[0], push.end[1], PUSH_Z + arm.approach];
      continue;
    }
    const c = left.splice(best, 1)[0];
    const part = onBoard.get(c.part.id);
    const gripYaw = gripYawFor(part);
    const from = [grasp.point[0], grasp.point[1], GRASP_Z];
    const hoverFrom = [from[0], from[1], from[2] + arm.approach];
    const pickAngles = ikWorld(from, arm, { gripYaw }).angles;
    const placed = fill.get(c.bin.id) ?? [];
    const [ox, oy] = RELEASE_OFFSETS[placed.length % RELEASE_OFFSETS.length];
    const slot = { x: c.bin.center[0] + ox, y: c.bin.center[1] + oy };
    // 松开时零件底面在盒里最高的零件上方 DROP.height
    const releaseZ = Math.max(BIN_WALL, ...placed.map((o) => o.z + o.height)) + DROP.height;
    const pl = placeFor(part, pickAngles, slot, releaseZ + GRASP_Z, arm);
    let reason = pl.error;
    let hoverTo = null;
    if (!reason) {
      hoverTo = [pl.to[0], pl.to[1], Math.max(binHoverZ(c.bin, arm), pl.to[2] + arm.approach)];
      const h = ikWorld(hoverTo, arm, { gripYaw: pl.placeYaw });
      if (!h.reachable) reason = h.reason;
    }
    if (reason) {
      skipped.push({ ...part, reachable: false, skipReason: `料盒里够不到：${reason}` });
      continue;
    }
    // 抓点偏离本体中心 offset 时，松开那一刻零件中心在指尖下方沿零件长轴反方向 offset 处
    const ya = (pl.partYawDeg * Math.PI) / 180;
    const center = { x: slot.x - grasp.offset * Math.cos(ya), y: slot.y - grasp.offset * Math.sin(ya) };
    // 落下后散开到哪（随机偏移按零件 id 取种子，结果可复现）
    const fp = fps[part.cls];
    const rest = settle(c.bin, placed, fp, { x: center.x, y: center.y, yaw: pl.partYawDeg }, { seed: part.id * 7919 + c.bin.id * 104729 + 1 });
    fill.set(c.bin.id, [...placed, { fp, x: rest.x, y: rest.y, yaw: rest.yaw, z: rest.z, height: fp.height }]);
    tasks.push({
      kind: 'pick',
      partId: part.id,
      binId: c.bin.id,
      from,
      to: pl.to,
      gripYaw,
      placeYaw: pl.placeYaw,
      graspZ: GRASP_Z,
      gap: grasp.gap,
      offset: grasp.offset,
      hoverFrom,
      hoverTo,
      partYawDeg: pl.partYawDeg,
      drop: { from: [center.x, center.y, releaseZ, pl.partYawDeg], to: [rest.x, rest.y, rest.z, rest.yaw] },
    });
    onBoard.delete(part.id);
    cur = hoverTo;
  }
  return { tasks, skipped };
}
