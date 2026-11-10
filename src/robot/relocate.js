// 把可夹取的障碍元件暂放在板上空位，不送入料盒。保持朝向及抓点偏移不变。
import { MARKERS, WORK_AREA } from '../config.js';
import { partPolys, fingerPolys } from './clearance.js';
import { polysOverlap } from './drop.js';
import { ikWorld } from './ik.js';

/** 找最近的可达空位；完整本体、引脚、张开的夹爪都避让，且不遮挡剩余目标。 */
export function planRelocation(part, others, targets, grasp, { fps, arm, board, graspZ, clearance = 30 }) {
  const yaw = grasp.gripYaw;
  const a = ((part.rotDeg ?? 0) * Math.PI) / 180;
  const offset = [grasp.offset * Math.cos(a), grasp.offset * Math.sin(a)];
  const obstacles = others.flatMap((o) => partPolys(o, fps, 0.8));
  const slots = [];
  const margin = WORK_AREA.margin;
  for (let x = margin; x <= board.width - margin; x += 8) {
    for (let y = margin; y <= board.height - margin; y += 8) {
      if (targets.some((t) => Math.hypot(t.x - x, t.y - y) <= clearance)) continue;
      slots.push({ x, y, d: Math.hypot(part.x - x, part.y - y) });
    }
  }
  slots.sort((p, q) => p.d - q.d || p.x - q.x || p.y - q.y);
  // 保留板上所有元件的抓取通道（含 ±2 mm 抓点偏移），避免暂放后又挡住外层障碍。
  const reserved = others.flatMap((t) => {
    const th = (((t.rotDeg ?? 0) + 90) * Math.PI) / 180;
    const w = fps[t.cls].rects[0].halfW * 2;
    return fingerPolys([t.x, t.y], th, w + 5, { grow: 2.6 });
  });
  const overlap = (as, bs) => as.some((p) => bs.some((q) => polysOverlap(p, q)));
  for (const slot of slots) {
    const moved = { ...part, x: slot.x, y: slot.y };
    const polys = partPolys(moved, fps, 0.6);
    if (!polys.every((P) => P.every(([x, y]) => x >= margin && y >= margin && x <= board.width - margin && y <= board.height - margin))) continue;
    if (polys.some((P) => Object.values(MARKERS.centers).some(([cx, cy]) => {
      const r = MARKERS.size / 2 + WORK_AREA.markerPadding;
      return polysOverlap(P, [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]);
    }))) continue;
    const point = [slot.x + offset[0], slot.y + offset[1], graspZ];
    if (overlap(polys, obstacles) || overlap(polys, reserved) || overlap(fingerPolys(point, yaw, grasp.gap), obstacles)) continue;
    const hoverTo = [point[0], point[1], graspZ + arm.approach];
    if (![point, hoverTo].every((P) => ikWorld(P, arm, { gripYaw: yaw }).reachable)) continue;
    const from = [grasp.point[0], grasp.point[1], graspZ];
    return {
      kind: 'relocate', partId: part.id, from, to: point,
      hoverFrom: [from[0], from[1], graspZ + arm.approach], hoverTo,
      gripYaw: yaw, placeYaw: yaw, gap: grasp.gap, offset: grasp.offset, graspZ,
      partFrom: [part.x, part.y, 0, part.rotDeg ?? 0],
      partTo: [slot.x, slot.y, 0, part.rotDeg ?? 0],
    };
  }
  return null;
}
