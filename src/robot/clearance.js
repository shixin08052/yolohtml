// 零件挤在一起时的夹取（纯函数，不碰 DOM）。都在俯视的平面上用矩形（凸多边形）判断，与 drop.js 一样：
// 1. fingerPolys：夹爪张开下到抓取高度时两根手指（含垫片）占的地方；
// 2. findGrasp：在本体中心、沿长轴前后挪一点的几个抓点，配上大小两档张开量，找第一个手指不碰旁边零件本体的抓法；
// 3. separateBodies：建场景后，本体互相插进去的零件（实拍位置有零点几毫米的误差）沿最小方向各推开一点；
// 4. planPush：一颗都夹不了时，"拨开"——夹爪合拢，从零件背后下到板面，推着它朝空处滑几毫米，直到能下爪。
// 引脚也不能碰：手指压到引脚会把它压弯、夹住；推杆只能顶本体（LED 的灯头或侧面、电阻的侧面），不能落在引脚上——
// 所以从 LED 的底座一侧（引脚从那里伸出来）、电阻的两端推都不行；推的路上零件连同引脚不能压到别的零件和别人的引脚。
import { footprintPolys, polysOverlap } from './drop.js';

/** 手指（scene/arm.js）：沿零件长轴方向宽 9 mm；张开方向上，垫片内侧在开口边缘，手指连垫片厚 5.5 mm；margin 为额外间隙 */
export const FINGER = { len: 9, thick: 5.5, margin: 0.6 };
/** 张开量 = 夹取处宽度 + 下面两档之一（先试大的）：留给手指对准误差的余量 */
export const GRIP_CLEARANCE = [5, 3];
/** 抓点沿长轴的偏移（mm，先试中心），不超过本体半长减 GRASP_END */
const OFFSETS = [0, 1, -1, 2, -2];
const GRASP_END = 2;
/** 拨开：每次最多推多远、步长；合拢的夹爪离零件多远开始推；推完零件离板边至少多远 */
export const PUSH = { maxMm: 35, stepMm: 1, backoffMm: 1.5, boardMargin: 4, minContactMm: 1.5, openGap: 34 };
// openGap：单指拨时夹爪张到最大（与 robot/sequence.js 的 GRIP_MAX 相同，有单元测试核对）
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

/**
 * 引脚占的地方（占地里本体之后的矩形；没有引脚时为空）
 * @param {{ x: number, y: number, rotDeg: number, cls: number }} part
 * @param {Record<number, { rects: object[] }>} fps
 */
export function leadPolys(part, fps, grow = 0) {
  const fp = fps[part.cls];
  if (fp.rects.length < 2) return [];
  return footprintPolys({ rects: fp.rects.slice(1) }, { x: part.x, y: part.y, yaw: part.rotDeg ?? 0 }, grow);
}

/**
 * 本体的精确外形（占地的 outline，几个矩形；没有时用本体外接矩形）：只用来判断本体是否互相插进去，
 * 夹爪、拨开的避让仍用外接矩形（宁可保守）
 */
export function outlinePolys(part, fps, grow = 0) {
  const fp = fps[part.cls];
  return footprintPolys({ rects: fp.outline ?? [fp.rects[0]] }, { x: part.x, y: part.y, yaw: part.rotDeg ?? 0 }, grow);
}

/** 本体和引脚 */
export const partPolys = (part, fps, grow = 0) => [...bodyPolys(part, fps, grow), ...leadPolys(part, fps, grow)];

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
  // 手指不能压到旁边零件的本体和引脚，也不能压到自己的引脚
  const obst = [...others.map((o) => partPolys(o, fps)), leadPolys(part, fps)];
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
 * 两组凸多边形（一个零件的外形由几个矩形组成）的平移向量：把 A 整体沿它移开，A 的每一块都不再插进 B 的任何一块；
 * 不相交时 null。逐对求最小平移向量再拼不行（底边只有 1 mm 长，两块底边之间最近的出路是顺着长轴挪 1 mm，
 * 挪完灯体还插着，来回推不收敛）：这里对每个候选方向（各块的边的法向，正反两向）求"让所有相交的块对都分开"
 * 要挪多远，取最短的方向
 * @param {number[][][]} As
 * @param {number[][][]} Bs
 * @returns {number[]|null}
 */
export function groupMtv(As, Bs) {
  const pairs = [];
  for (const a of As) for (const b of Bs) if (mtv(a, b)) pairs.push([a, b]);
  if (!pairs.length) return null;
  const axes = [];
  for (const P of [...As, ...Bs]) {
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i];
      const [x1, y1] = P[(i + 1) % P.length];
      const l = Math.hypot(x1 - x0, y1 - y0) || 1;
      const n = [(y0 - y1) / l, (x1 - x0) / l];
      if (!axes.some((m) => Math.abs(m[0] * n[1] - m[1] * n[0]) < 1e-6)) axes.push(n);
    }
  }
  let best = null;
  for (const n of axes) {
    for (const sg of [1, -1]) {
      const d = [n[0] * sg, n[1] * sg];
      const proj = (Q) => Q.map(([x, y]) => x * d[0] + y * d[1]);
      // A 沿 d 挪 t：每一对都要 A 的最小投影 ≥ B 的最大投影
      const t = Math.max(...pairs.map(([a, b]) => Math.max(...proj(b)) - Math.min(...proj(a))));
      if (!best || t < best.t) best = { t, d };
    }
  }
  return [best.d[0] * best.t, best.d[1] * best.t];
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
export function separateBodies(parts, fps, { maxMove = 2, gapMm = 0, iters = 24 } = {}) {
  const ps = parts.map((p) => ({ ...p }));
  const shift = new Map(ps.map((p) => [p.id, [0, 0]]));
  const reach = (p) => Math.max(...(fps[p.cls].outline ?? [fps[p.cls].rects[0]]).map((r) => Math.hypot(Math.max(-r.minX, r.maxX), r.halfW)));
  const total = (id) => Math.hypot(...shift.get(id));
  for (let it = 0; it < iters; it++) {
    let any = false;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        // 中心隔得比两者外接圆半径之和还远：不可能相交
        if (Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) > reach(ps[i]) + reach(ps[j]) + gapMm) continue;
        const A = outlinePolys(ps[i], fps, gapMm / 2);
        const B = outlinePolys(ps[j], fps, gapMm / 2);
        const v = groupMtv(A, B);
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
 * 规划一次拨开：试若干方向（背离旁边零件、垂直于长轴两侧、沿长轴两头、每 15° 一个方位）和三种拨法：
 *   closed：夹爪合拢，两根手指一起顶（推杆沿推的方向厚 11 mm、横向宽 9 mm）；
 *   front ：夹爪张到最大，用前面那根手指的外侧顶，另一根手指在后面跟着（手指只有 5.5 mm 厚，插得进零件之间的窄缝）；
 *   back  ：夹爪张到最大、跨住零件，用后面那根手指的垫片顶，前面那根手指从零件另一侧走（零件在两指之间）。
 * 每种按 1 mm 一步往外推：推的路上零件（连同引脚）不能插进别的零件和别人的引脚、两根手指扫过的地方不能有别的零件和引脚、
 * 零件留在板内；手指落下的地方也不能压到任何引脚（包括被推那颗自己的——不从引脚那一侧推）。推到能下爪就停，取推得最短的。
 * @param {object} part
 * @param {object[]} others
 * @param {{ width: number, fps: object, board: { width: number, height: number },
 *           ok?: (point: number[], gripYaw: number) => boolean, reach?: (p: number[], pushYaw: number) => boolean }} o
 *   ok：抓法的额外检查（传给 findGrasp）；reach：指尖中心推的起点、终点是否够得着
 * @returns {{ dir: number[], dist: number, start: number[], end: number[], pushYaw: number, gap: number, mode: string, part: object }|null}
 *   start / end：指尖中心（两指中间）的起止位置；gap：推时夹爪的开口
 */
export function planPush(part, others, { width, fps, board, ok = () => true, reach = () => true }) {
  const obst = others.map((o) => partPolys(o, fps));
  // 零件与零件之间按本体的精确外形（LED 灯体比底边细）：并排贴着的两颗外接矩形本来就有一点重叠，按外接矩形会哪儿都推不动
  const shape = (p, grow) => [...outlinePolys(p, fps, grow), ...leadPolys(p, fps, grow)];
  const aabb = (polys) => {
    const xs = polys.flat().map((q) => q[0]);
    const ys = polys.flat().map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const hit = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  // 外接框先筛一遍（外形有好几段，逐段判断慢），离得远的不用细看
  const obstShape = others.map((o) => {
    const polys = shape(o, 0);
    return { polys, box: aabb(polys) };
  });
  const ownLeads = leadPolys(part, fps);
  const ownBody = bodyPolys(part, fps);
  const near = others.filter((o) => Math.hypot(o.x - part.x, o.y - part.y) < 15);
  const dirs = [];
  if (near.length) {
    const cx = near.reduce((s, o) => s + o.x, 0) / near.length;
    const cy = near.reduce((s, o) => s + o.y, 0) / near.length;
    if (Math.hypot(part.x - cx, part.y - cy) > 1e-6) dirs.push(Math.atan2(part.y - cy, part.x - cx));
  }
  const a = rad(part.rotDeg ?? 0);
  dirs.push(a + Math.PI / 2, a - Math.PI / 2, a, a + Math.PI);
  for (let k = 0; k < 24; k++) dirs.push((k * Math.PI) / 12);

  const inBoard = (polys) => polys.every((P) => P.every(([x, y]) => x >= PUSH.boardMargin && y >= PUSH.boardMargin && x <= board.width - PUSH.boardMargin && y <= board.height - PUSH.boardMargin));
  // 推的路上零件与别的零件只要不插进去就行（紧贴着滑过去可以）：本体收缩一点再判断，免得擦边被算成相撞
  const slide = (p) => shape(p, -0.15);
  const G = PUSH.openGap;
  const T = FINGER.thick;
  // 三种拨法：开口、指尖中心相对"顶住零件的那个面"往后退多少（沿推的方向）
  const modes = [
    { mode: 'closed', gap: 0, back: T },
    { mode: 'front', gap: G, back: G / 2 + T },
    { mode: 'back', gap: G, back: -G / 2 },
  ];
  const body = ownBody[0];
  let best = null;
  for (const th of dirs) {
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    const vx = -uy;
    const vy = ux;
    const fingers = (p, gap) => fingerPolys(p, th, gap, { grow: 0.2 });
    // 零件在推的方向上的背面、在横向上的宽度
    const back = Math.max(...body.map(([x, y]) => -((x - part.x) * ux + (y - part.y) * uy)));
    const side = body.map(([x, y]) => (x - part.x) * vx + (y - part.y) * vy);
    const [s0, s1] = [Math.min(...side), Math.max(...side)];
    for (const m of modes) {
      // 顶住零件的那个面在零件背面后 backoff；指尖中心再往后 m.back
      const off = back + PUSH.backoffMm + m.back;
      for (const t of PUSH_SIDE) {
        // 手指面宽 FINGER.len，横向偏 t 后与零件宽度的重叠要够，才推得动
        const contact = Math.min(t + FINGER.len / 2, s1) - Math.max(t - FINGER.len / 2, s0);
        if (contact < PUSH.minContactMm) continue;
        const start = [part.x - ux * off + vx * t, part.y - uy * off + vy * t];
        // 手指落下的地方不能压到别的零件和任何引脚，也不能压到被推那颗自己（跨住它时前面那根手指在它另一侧）
        const f0 = fingers(start, m.gap);
        if (obst.some((ob) => anyOverlap(f0, ob)) || anyOverlap(f0, ownLeads) || anyOverlap(f0, ownBody)) continue;
        for (let d = PUSH.stepMm; d <= PUSH.maxMm + 1e-9; d += PUSH.stepMm) {
          if (best && d >= best.dist) break;
          const moved = { ...part, x: part.x + ux * d, y: part.y + uy * d };
          const end = [start[0] + ux * d, start[1] + uy * d];
          // 推的路上零件（连同引脚）撞到别的零件或别人的引脚、手指扫到别的零件或引脚：这个方向不行
          const f1 = fingers(end, m.gap);
          const sm = slide(moved);
          const smBox = aabb(sm);
          if (obstShape.some((ob) => hit(smBox, ob.box) && anyOverlap(sm, ob.polys)) || obst.some((ob) => anyOverlap(f1, ob))) break;
          if (!inBoard(bodyPolys(moved, fps))) break;
          // 能下爪了吗（夹的时候推的手指已经抬走，不用管它）
          if (!findGrasp(moved, others, { width, fps, ok })) continue;
          if (!reach(start, th) || !reach(end, th)) break;
          best = { dir: [ux, uy], dist: d, start, end, pushYaw: th, gap: m.gap, mode: m.mode, part: moved };
          break;
        }
      }
    }
  }
  return best;
}
