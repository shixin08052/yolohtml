// 分拣指令导出（纯函数，不碰 DOM）：把分拣规划整理成"执行"这一步的输出——
// 每个零件的抓取点、夹爪方向和开口、抓取 / 放置时的关节角、放进哪个料盒，可以拿去驱动真实机械臂。
// 坐标都是底板坐标（mm，原点在底板左下角，X 向右、Y 向远处、Z 向上），角度为度。
import { ikWorld } from './ik.js';
import { GRIP_WIDTH } from './planner.js';
import { partName } from './bins.js';
import { toCsv } from '../experiment.js';

const deg = (r) => (r * 180) / Math.PI;
const r2 = (v) => Math.round(v * 100) / 100;
const pt = (P) => P.map(r2);

/**
 * 关节角（度）
 * @returns {number[]|null} θ₀–θ₄；不可达时为 null
 */
function anglesDeg(P, arm, gripYaw) {
  const s = ikWorld(P, arm, { gripYaw });
  return s.reachable ? s.angles.map((a) => r2(deg(a))) : null;
}

/**
 * 分拣指令（按执行顺序）
 * @param {ReturnType<import('./planner.js').plan>} planResult
 * @param {import('../state.js').Part[]} parts
 * @param {{ id: number, cls: number, center: number[] }[]} bins
 * @param {{ id: number, name: string }[]} classes
 * @param {object} arm
 */
export function sortInstructions({ tasks, skipped }, parts, bins, classes, arm) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const steps = tasks.map((t, i) => {
    const p = byId.get(t.partId);
    const bin = bins.find((b) => b.id === t.binId);
    const placeYaw = t.placeYaw ?? t.gripYaw;
    return {
      order: i + 1,
      partId: t.partId,
      number: t.partId + 1, // 显示编号（与零件图片一致）
      cls: p.cls,
      name: partName(p),
      color: p.color ?? null,
      part: { x: r2(p.x), y: r2(p.y), rotDeg: r2(p.rotDeg), score: r2(p.score) },
      pick: {
        hover: pt(t.hoverFrom),
        point: pt(t.from),
        gripYawDeg: t.gripYaw == null ? null : r2(deg(t.gripYaw)),
        gripWidthMm: GRIP_WIDTH[p.cls] ?? null,
        angles: anglesDeg(t.from, arm, t.gripYaw),
      },
      place: {
        bin: bin ? { id: bin.id, key: bin.key, name: `${bin.label ?? classes[bin.cls]?.name ?? bin.cls}盒` } : null,
        hover: pt(t.hoverTo),
        point: pt(t.to),
        gripYawDeg: placeYaw == null ? null : r2(deg(placeYaw)),
        angles: anglesDeg(t.to, arm, placeYaw),
      },
      rest: t.drop ? { x: r2(t.drop.to[0]), y: r2(t.drop.to[1]), z: r2(t.drop.to[2]), yawDeg: r2(t.drop.to[3]) } : null,
    };
  });
  const skip = skipped.map((p) => ({ partId: p.id, number: p.id + 1, cls: p.cls, name: partName(p), x: r2(p.x), y: r2(p.y), reason: p.skipReason }));
  return { steps, skipped: skip };
}

/**
 * JSON（带说明）
 * @param {ReturnType<typeof sortInstructions>} ins
 * @param {{ photo?: string, time?: string, arm: object }} meta
 */
export function instructionsJson(ins, { photo = '', time = '', arm }) {
  return JSON.stringify(
    {
      说明: '分拣指令：按 steps 的顺序执行。每一步：移到 pick.hover → 竖直下降到 pick.point → 夹爪收到 gripWidthMm 夹紧 → 抬回 pick.hover → 移到 place.hover → 下降到 place.point → 松开 → 抬起。',
      坐标系: '底板坐标，mm：原点在底板左下角，X 向右、Y 向远处（离操作者）、Z 向上；point 为指尖位置。角度单位为度',
      关节: 'angles = [θ₀ 底座转角, θ₁ 大臂, θ₂ 小臂, θ₃ 腕部俯仰, θ₄ 腕部转动]（逆运动学结果）',
      照片: photo,
      时间: time,
      机械臂: arm,
      steps: ins.steps,
      skipped: ins.skipped,
    },
    null,
    2,
  );
}

const ang = (a) => (a ? a : [null, null, null, null, null]);

/**
 * CSV（每个零件一行，Excel 直接打开）
 * @param {ReturnType<typeof sortInstructions>} ins
 */
export function instructionsCsv(ins) {
  const J = ['θ₀', 'θ₁', 'θ₂', 'θ₃', 'θ₄'];
  const header = [
    '顺序', '零件编号', '类别', '零件 X (mm)', '零件 Y (mm)', '零件朝向 (°)',
    '抓取点 X', '抓取点 Y', '抓取点 Z', '夹爪方向 (°)', '夹爪开口 (mm)', ...J.map((j) => `抓取 ${j} (°)`),
    '料盒', '松开点 X', '松开点 Y', '松开点 Z', '放置夹爪方向 (°)', ...J.map((j) => `放置 ${j} (°)`),
    '预计落点 X', '预计落点 Y', '备注',
  ];
  const rows = ins.steps.map((s) => [
    s.order, s.number, s.name, s.part.x, s.part.y, s.part.rotDeg,
    ...s.pick.point, s.pick.gripYawDeg, s.pick.gripWidthMm, ...ang(s.pick.angles),
    s.place.bin?.name ?? '', ...s.place.point, s.place.gripYawDeg, ...ang(s.place.angles),
    s.rest?.x ?? '', s.rest?.y ?? '', '',
  ]);
  for (const k of ins.skipped) {
    rows.push(['跳过', k.number, k.name, k.x, k.y, ...Array(header.length - 6).fill(''), k.reason]);
  }
  return toCsv(header, rows);
}
