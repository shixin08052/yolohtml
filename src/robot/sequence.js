// 分拣动作序列（纯函数，不碰 DOM）：把规划好的任务展开成一段段可播放的动作。
// 每个零件：张开夹爪 → 移到零件正上方 → 竖直下降到夹取高度 → 夹紧 → 挂到夹爪上 → 竖直抬起
//         → 移到料盒上方（途中转动夹爪，长条零件转成沿料盒长边）→ 竖直下降 → 松开 → 零件落下、散开 → 竖直抬起
// 全部完成后回到初始姿态。
// 段的类型：
//   move   关节空间插值（θ₃ 由 θ₁、θ₂ 推出，途中夹爪竖直向下）
//   line   指尖走直线（每帧解一次逆运动学），用于竖直下降 / 抬起
//   grip   夹爪开口变化（两指内侧间距，mm）
//   attach / detach  零件挂到夹爪上 / 放回场景（瞬间完成）
//   drop   零件从松开处落到盒里（robot/drop.js 的 dropPose）；带 grip 字段时夹爪同时张开
//          （松开是一个动作：手指一离开零件就开始往下掉，不能等夹爪张到最大再掉，否则零件会悬在半空）
import { ikWorld, pathClear } from './ik.js';
import { GRIP_WIDTH } from './planner.js';
import { DROP } from './drop.js';

/** 夹爪最大开口（mm），与 scene/arm.js 一致 */
export const GRIP_MAX = 34;
/** 夹爪开合时长（ms） */
export const GRIP_MS = 250;
/** 松开时夹爪张开的时长（ms），与零件下落同时进行 */
export const RELEASE_GRIP_MS = 150;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 关节空间运动时长：按转动最多的关节，0.4–0.8 秒 */
export function moveMs(a, b) {
  const d0 = Math.abs(Math.atan2(Math.sin(b[0] - a[0]), Math.cos(b[0] - a[0])));
  const d = Math.max(d0, Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), Math.abs((b[4] ?? 0) - (a[4] ?? 0)));
  return clamp(400 + 250 * d, 400, 800);
}

/** 直线运动时长：按距离，0.4–0.8 秒 */
export function lineMs(p, q) {
  return clamp(400 + 3 * Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]), 400, 800);
}

/**
 * 展开动作序列
 * @param {ReturnType<import('./planner.js').plan>['tasks']} tasks
 * @param {import('../state.js').Part[]} parts
 * @param {import('./ik.js').ArmDims & { base: number[] }} arm
 * @param {{ startAngles: number[], homeAngles: number[], startGap?: number }} opts
 * @returns {{ type: string, task: number|null, phase: string, ms: number, [k: string]: any }[]}
 */
export function buildSequence(tasks, parts, arm, { startAngles, homeAngles, startGap = GRIP_MAX }) {
  const segs = [];
  let cur = [...startAngles];
  let gap = startGap;
  const byId = new Map(parts.map((p) => [p.id, p]));

  /** 关节空间运动；直接过去途中会碰撞时先经过初始姿态 */
  const move = (to, task, phase) => {
    const via = !pathClear(cur, to, arm) && pathClear(cur, homeAngles, arm) && pathClear(homeAngles, to, arm);
    for (const target of via ? [homeAngles, to] : [to]) {
      segs.push({ type: 'move', task, phase, from: cur, to: target, ms: moveMs(cur, target) });
      cur = target;
    }
  };
  const solve = (P, gripYaw) => {
    const s = ikWorld(P, arm, { gripYaw });
    if (!s.reachable) throw new Error(`动作序列中的位置不可达：${P.map((x) => x.toFixed(1))}（${s.reason}）`);
    return s.angles;
  };
  const line = (from, to, gripYaw, task, phase) => {
    segs.push({ type: 'line', task, phase, from, to, gripYaw, ms: lineMs(from, to) });
    cur = solve(to, gripYaw);
  };
  const grip = (to, task, phase) => {
    segs.push({ type: 'grip', task, phase, from: gap, to, ms: GRIP_MS });
    gap = to;
  };

  tasks.forEach((t, i) => {
    const part = byId.get(t.partId);
    const width = GRIP_WIDTH[part.cls] ?? 5;
    const open = Math.min(GRIP_MAX, width + 12);
    if (gap < open) grip(open, i, '张开夹爪');
    move(solve(t.hoverFrom, t.gripYaw), i, '移到零件上方');
    line(t.hoverFrom, t.from, t.gripYaw, i, '下降');
    grip(width, i, '夹紧');
    segs.push({ type: 'attach', task: i, phase: '夹起', partId: t.partId, ms: 0 });
    line(t.from, t.hoverFrom, t.gripYaw, i, '抬起');
    const placeYaw = t.placeYaw === undefined ? t.gripYaw : t.placeYaw;
    move(solve(t.hoverTo, placeYaw), i, '移到料盒上方');
    line(t.hoverTo, t.to, placeYaw, i, '放入料盒');
    if (t.drop) {
      // 先放开零件，再在零件下落的同时张开夹爪
      segs.push({ type: 'detach', task: i, phase: '松开', partId: t.partId, ms: 0 });
      segs.push({ type: 'drop', task: i, phase: '松开 · 落下', partId: t.partId, from: t.drop.from, to: t.drop.to, grip: { from: gap, to: open, ms: RELEASE_GRIP_MS }, ms: DROP.ms });
      gap = open;
    } else {
      grip(open, i, '松开');
      segs.push({ type: 'detach', task: i, phase: '放下', partId: t.partId, ms: 0 });
    }
    line(t.to, t.hoverTo, placeYaw, i, '离开');
  });
  move(homeAngles, null, '回到初始姿态');
  return segs;
}
