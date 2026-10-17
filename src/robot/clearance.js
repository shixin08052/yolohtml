// 零件挤在一起时的夹取（纯函数，不碰 DOM）。都在俯视的平面上用矩形（凸多边形）判断，与 drop.js 一样：
// 1. fingerPolys：夹爪张开下到抓取高度时两根手指（含垫片）占的地方；
// 2. findGrasp：在本体中心、沿长轴前后挪一点的几个抓点，配上大小两档张开量，找第一个手指不碰旁边零件本体的抓法；
// 3. separateBodies：建场景后，本体互相插进去的零件（实拍位置有零点几毫米的误差）沿最小方向各推开一点；
// 4. planPush：一颗都夹不了时，"拨开"——夹爪合拢，从零件背后下到板面，推着它朝空处滑几毫米，直到能下爪。
// 只看零件本体，不看引脚（引脚又细又软，手指压到也无妨）。
import { footprintPolys, polysOverlap } from './drop.js';

/** 手指（scene/arm.js）：沿零件长轴方向宽 9 mm；张开方向上，垫片内侧在开口边缘，手指连垫片厚 5.5 mm；margin 为额外间隙 */
export const FINGER = { len: 9, thick: 5.5, margin: 0.6 };
/** 张开量 = 夹取处宽度 + 下面两档之一（先试大的）：留给手指对准误差的余量 */
export const GRIP_CLEARANCE = [5, 3];
/** 抓点沿长轴的偏移（mm，先试中心），不超过本体半长减 GRASP_END */
const OFFSETS = [0, 1, -1, 2, -2];
const GRASP_END = 2;
/** 拨开：每次最多推多远、步长；合拢的夹爪离零件多远开始推；推完零件离板边至少多远 */
export const PUSH = { maxMm: 16, stepMm: 1, backoffMm: 1.5, boardMargin: 4, minContactMm: 1.5 };
/** 推杆（合拢的夹爪）相对零件中心的横向偏移（mm）：推杆宽 9 mm，比 LED 还宽，偏到外侧才不会顶到旁边的零件 */
const PUSH_SIDE = [0, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5, 3, -3];

const rad = (d) => (d * Math.PI) / 180;

/**
 * 两根手指占的地方（底板坐标，mm）
 * @param {number[]} p 指尖中心 [x, y]
 * @param {number} gripYaw 两指连线方向（弧度）
 * @param {number} gap 两块垫片内侧的间距
 * @returns {number[][][]} 两个四边形
 */
export function fingerPolys([x, y], gripYaw, gap, { grow = FINGER.margin } = {}) {
  const ux = Math.cos(gripYaw);
  const uy = Math.sin(gripYaw);
  const vx = -uy;
  const vy = ux;
  const a = FINGER.thick / 2 + grow;
  const b = FINGER.len / 2 + grow;
  return [-1, 1].map((side) => {
    const off = side * (gap / 2 + FINGER.thick / 2);
    const cx = x + ux * off;
    const cy = y + uy * off;
    return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([s, t]) => [cx + ux * s + vx * t, cy + uy * s + vy * t]);
  });
}

/**
 * 零件本体占的地方（只取占地的第一个矩形——本体）
 * @param {{ x: number, y: number, rotDeg: number, cls: number }} part
 * @param {Record<number, { rects: object[] }>} fps 各类的占地（scene/parts.js 的 partFootprint）
 */
export function bodyPolys(part, fps, grow = 0) {
  const fp = fps[part.cls];
  return footprintPolys({ rects: [fp.rects[0]] }, { x: part.x, y: part.y, yaw: part.rotDeg ?? 0 }, grow);
}

const anyOverlap = (as, bs) => as.some((a) => bs.some((b) => polysOverlap(a, b)));

/**
 * 找一个手指不碰旁边零件本体的抓法
 * @param {object} part
 * @param {object[]} others 板上其他（还没拿走的）零件
 * @param {{ width: number, fps: object, ok?: (point: number[], gripYaw: number) => boolean }} o
 *   width：夹取处宽度；ok：额外检查（例如逆运动学可达）
 * @returns {{ point: number[], gap: number, offset: number, gripYaw: number }|null}
 */
export function findGrasp(part, others, { width, fps, ok = () => true }) {
  const a = rad(part.rotDeg ?? 0);
  const gripYaw = a + Math.PI / 2;
  const body = fps[part.cls].rects[0];
  const maxOff = Math.max(0, Math.min(-body.minX, body.maxX) - GRASP_END);
  const obst = others.map((o) => bodyPolys(o, fps));
  for (const s of OFFSETS) {
    if (Math.abs(s) > maxOff + 1e-9) continue;
    const point = [part.x + s * Math.cos(a), part.y + s * Math.sin(a)];
    for (const c of GRIP_CLEARANCE) {
      const gap = width + c;
      const fingers = fingerPolys(point, gripYaw, gap);
      if (obst.some((ob) => anyOverlap(fingers, ob))) continue;
      if (!ok(point, gripYaw)) continue;
      return { point, gap, offset: s, gripYaw };
    }
  }
  return null;
}

/**
 * 两个凸多边形的最小平移向量：把 A 沿它移开就不再与 B 相交；不相交时 null
 * @returns {number[]|null} [dx, dy]
 */
export function mtv(A, B) {
  let best = Infinity;
  let axis = null;
  for (const P of [A, B]) {
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i];
      const [x1, y1] = P[(i + 1) % P.length];
      let nx = y0 - y1;
      let ny = x1 - x0;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const proj = (Q) => Q.map(([x, y]) => x * nx + y * ny);
      const pa = proj(A);
      const pb = proj(B);
      const o = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
      if (o <= 0) return null;
      if (o < best) {
        best = o;
        axis = [nx, ny];
      }
    }
  }
  // 方向：从 B 指向 A
  const c = (Q) => [Q.reduce((s, p) => s + p[0], 0) / Q.length, Q.reduce((s, p) => s + p[1], 0) / Q.length];
  const [ax, ay] = c(A);
  const [bx, by] = c(B);
  const sgn = (ax - bx) * axis[0] + (ay - by) * axis[1] >= 0 ? 1 : -1;
  return [axis[0] * best * sgn, axis[1] * best * sgn];
}

/**
 * 本体互相插进去的零件沿最小方向各推开一半（每个零件累计最多 maxMove），返回新的零件数组和各零件挪了多少
 * x、y 与两种方法的坐标（xPlane / xParallax）一起挪，切换方法时不会又插回去
 * @param {object[]} parts
 * @param {object} fps
 * @returns {{ parts: object[], moved: Map<number, number> }} moved：零件 id → 挪动距离（mm）
 */
export function separateBodies(parts, fps, { maxMove = 2, gapMm = 0.3, iters = 24 } = {}) {
  const ps = parts.map((p) => ({ ...p }));
  const shift = new Map(ps.map((p) => [p.id, [0, 0]]));
  const total = (id) => Math.hypot(...shift.get(id));
  for (let it = 0; it < iters; it++) {
    let any = false;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const A = bodyPolys(ps[i], fps, gapMm / 2);
        const B = bodyPolys(ps[j], fps, gapMm / 2);
        let v = null;
        for (const a of A) for (const b of B) v = v ?? mtv(a, b);
        if (!v) continue;
        any = true;
        for (const [p, k] of [[ps[i], 0.5], [ps[j], -0.5]]) {
          const s = shift.get(p.id);
          let dx = v[0] * k;
          let dy = v[1] * k;
          // 每个零件累计不超过 maxMove
          const room = maxMove - total(p.id);
          if (room <= 1e-6) continue;
          const l = Math.hypot(dx, dy);
          if (l > room) {
            dx *= room / l;
            dy *= room / l;
          }
          s[0] += dx;
          s[1] += dy;
          for (const [kx, ky] of [['x', 'y'], ['xPlane', 'yPlane'], ['xParallax', 'yParallax']]) {
            if (typeof p[kx] === 'number') {
              p[kx] += dx;
              p[ky] += dy;
            }
          }
        }
      }
    }
    if (!any) break;
  }
  const moved = new Map();
  for (const p of ps) {
    const d = total(p.id);
    if (d > 0.05) moved.set(p.id, d);
  }
  return { parts: ps, moved };
}

/**
 * 规划一次拨开：试若干方向（背离旁边零件、垂直于长轴两侧、沿长轴两头、八个方位），每个方向按 1 mm 一步往外推，
 * 推的路上零件不能撞到别的零件、合拢的夹爪落点和推完的位置也不能压到别的零件，零件留在板内；
 * 推到某处能下爪就停。取所有方向里推得最短的。
 * @param {object} part
 * @param {object[]} others
 * @param {{ width: number, fps: object, board: { width: number, height: number },
 *           ok?: (point: number[], gripYaw: number) => boolean, reach?: (p: number[]) => boolean }} o
 *   ok：抓法的额外检查（传给 findGrasp）；reach：夹爪合拢推的起点、终点是否够得着
 * @returns {{ dir: number[], dist: number, start: number[], end: number[], pushYaw: number, part: object }|null}
 *   start / end：合拢夹爪指尖中心的起止位置；part：推完后的零件
 */
export function planPush(part, others, { width, fps, board, ok = () => true, reach = () => true }) {
  const obst = others.map((o) => bodyPolys(o, fps));
  const near = others.filter((o) => Math.hypot(o.x - part.x, o.y - part.y) < 15);
  const dirs = [];
  if (near.length) {
    const cx = near.reduce((s, o) => s + o.x, 0) / near.length;
    const cy = near.reduce((s, o) => s + o.y, 0) / near.length;
    if (Math.hypot(part.x - cx, part.y - cy) > 1e-6) dirs.push(Math.atan2(part.y - cy, part.x - cx));
  }
  const a = rad(part.rotDeg ?? 0);
  dirs.push(a + Math.PI / 2, a - Math.PI / 2, a, a + Math.PI);
  for (let k = 0; k < 8; k++) dirs.push((k * Math.PI) / 4);

  const inBoard = (polys) => polys.every((P) => P.every(([x, y]) => x >= PUSH.boardMargin && y >= PUSH.boardMargin && x <= board.width - PUSH.boardMargin && y <= board.height - PUSH.boardMargin));
  // 推的路上零件与别的零件只要不插进去就行（紧贴着滑过去可以）：本体收缩一点再判断，免得擦边被算成相撞
  const slideBody = (p) => bodyPolys(p, fps, -0.15);
  const pusher = (p, th) => fingerPolys(p, th, 0, { grow: 0.2 });
  const body = bodyPolys(part, fps)[0];
  let best = null;
  for (const th of dirs) {
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    const vx = -uy;
    const vy = ux;
    // 零件在推的方向上的背面、在横向上的宽度
    const back = Math.max(...body.map(([x, y]) => -((x - part.x) * ux + (y - part.y) * uy)));
    const side = body.map(([x, y]) => (x - part.x) * vx + (y - part.y) * vy);
    const [s0, s1] = [Math.min(...side), Math.max(...side)];
    const off = back + PUSH.backoffMm + FINGER.thick;
    for (const t of PUSH_SIDE) {
      // 推杆（两指连线沿推的方向）的面宽 FINGER.len，横向偏 t 后与零件宽度的重叠要够，才推得动
      const contact = Math.min(t + FINGER.len / 2, s1) - Math.max(t - FINGER.len / 2, s0);
      if (contact < PUSH.minContactMm) continue;
      const start = [part.x - ux * off + vx * t, part.y - uy * off + vy * t];
      if (obst.some((ob) => anyOverlap(pusher(start, th), ob))) continue;
      for (let d = PUSH.stepMm; d <= PUSH.maxMm + 1e-9; d += PUSH.stepMm) {
        if (best && d >= best.dist) break;
        const moved = { ...part, x: part.x + ux * d, y: part.y + uy * d };
        const end = [start[0] + ux * d, start[1] + uy * d];
        // 推的路上撞到别的零件（或推杆压到别的零件）：这个方向不行
        if (obst.some((ob) => anyOverlap(slideBody(moved), ob) || anyOverlap(pusher(end, th), ob))) break;
        if (!inBoard(bodyPolys(moved, fps))) break;
        // 能下爪了吗（夹的时候推杆已经抬走，不用管它）
        if (!findGrasp(moved, others, { width, fps, ok })) continue;
        if (!reach(start) || !reach(end)) break;
        best = { dir: [ux, uy], dist: d, start, end, pushYaw: th, part: moved };
        break;
      }
    }
  }
  return best;
}
