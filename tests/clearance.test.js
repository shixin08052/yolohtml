import { describe, it, expect } from 'vitest';
import { fingerPolys, bodyPolys, leadPolys, partPolys, findGrasp, mtv, separateBodies, planPush, FINGER } from '../src/robot/clearance.js';
import { plan, GRIP_WIDTH } from '../src/robot/planner.js';
import { buildSequence } from '../src/robot/sequence.js';
import { polysOverlap } from '../src/robot/drop.js';
import { binsFor } from '../src/robot/bins.js';
import { partFootprint } from '../src/scene/parts.js';
import { ARM, BOARD, CLASSES } from '../src/config.js';

const fps = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));
const P = (id, cls, x, y, rotDeg = 0, color = 'red') => ({ id, cls, color: cls === 1 ? color : undefined, name: '', score: 0.9, x, y, xPlane: x, yPlane: y, xParallax: x, yParallax: y, rotDeg, heightMm: CLASSES[cls].heightMm, reachable: true });
const anyOv = (as, bs) => as.some((a) => bs.some((b) => polysOverlap(a, b)));

describe('夹爪手指的落点', () => {
  it('两指连线沿 X、开口 10：两根手指在 x = ±(5 … 10.5)，沿 Y 宽 9（含间隙）', () => {
    const [a, b] = fingerPolys([0, 0], 0, 10, { grow: 0 });
    const xs = (q) => q.map((p) => p[0]);
    const ys = (q) => q.map((p) => p[1]);
    expect([Math.min(...xs(a)), Math.max(...xs(a))].map((v) => +v.toFixed(9))).toEqual([-10.5, -5]);
    expect([Math.min(...xs(b)), Math.max(...xs(b))].map((v) => +v.toFixed(9))).toEqual([5, 10.5]);
    expect(Math.max(...ys(a)) - Math.min(...ys(a))).toBeCloseTo(FINGER.len, 9);
  });

  it('单独一颗：在本体中心、按大的那档张开下爪', () => {
    const g = findGrasp(P(0, 1, 100, 100, 30), [], { width: GRIP_WIDTH[1], fps });
    expect(g.offset).toBe(0);
    expect(g.gap).toBe(GRIP_WIDTH[1] + 5);
  });

  it('旁边稍远有零件：张小一点就下得去；紧贴的平行邻居：怎么都下不去', () => {
    // 两颗平行的 LED（长轴沿 Y），中心相距 14 mm：大开口碰到、小开口刚好让开
    const g = findGrasp(P(0, 1, 100, 100, 90), [P(1, 1, 114, 100, 90)], { width: GRIP_WIDTH[1], fps });
    expect(g).not.toBeNull();
    expect(g.gap).toBe(GRIP_WIDTH[1] + 3);
    expect(findGrasp(P(0, 1, 100, 100, 90), [P(1, 1, 105.8, 100, 90)], { width: GRIP_WIDTH[1], fps })).toBeNull();
  });

  it('邻居在长轴一头挡住：沿长轴挪一点抓点就让开', () => {
    // 长轴沿 X；邻居（竖着放的 LED，灯头朝下、引脚朝上伸走）在 +X 端旁边，灯体压在中心抓时的手指（x 95.5–104.5）下方
    const me = P(0, 1, 100, 100, 0);
    const other = P(1, 1, 107, 110, -90);
    const g = findGrasp(me, [other], { width: GRIP_WIDTH[1], fps });
    expect(g).not.toBeNull();
    expect(g.offset).toBeLessThan(0);
  });
});

describe('本体互相插进去时推开', () => {
  it('最小平移向量：两个相交的正方形', () => {
    const a = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const b = [[1.5, 0], [3.5, 0], [3.5, 2], [1.5, 2]];
    const v = mtv(a, b);
    expect(v[0]).toBeCloseTo(-0.5, 9);
    expect(v[1]).toBeCloseTo(0, 9);
    expect(mtv(a, [[3, 0], [4, 0], [4, 1], [3, 1]])).toBeNull();
  });

  it('两颗平行 LED 中心只差 4 mm（灯体宽 5.8，插进去 1.8）：各推开约 1 mm 后不再相交，坐标一起挪', () => {
    const { parts, moved } = separateBodies([P(0, 1, 100, 100, 90), P(1, 1, 104, 100, 90)], fps);
    expect(anyOv(bodyPolys(parts[0], fps), bodyPolys(parts[1], fps))).toBe(false);
    expect(moved.get(0)).toBeLessThan(1.3);
    expect(moved.get(1)).toBeLessThan(1.3);
    expect(parts[0].xParallax).toBeCloseTo(parts[0].x, 9);
    expect(parts[0].x).toBeLessThan(100);
  });

  it('不相交的不动', () => {
    const { moved } = separateBodies([P(0, 1, 100, 100, 90), P(1, 1, 120, 100, 90)], fps);
    expect(moved.size).toBe(0);
  });
});

describe('挤在一起的分拣', () => {
  // 照用户实拍：电阻 + 四颗 LED 上下叠着、紧贴，方向一左一右交替（蓝、红灯头朝右，透明、绿灯头朝左）
  const photo = [P(0, 0, 169.0, 132.4, 9), P(1, 1, 186.9, 98.5, 1, 'red'), P(2, 1, 187.3, 110.8, 1, 'blue'), P(3, 1, 187.4, 91.8, 172, 'green'), P(4, 1, 186.9, 104.6, 180, 'clear')];
  // 三颗同向并排紧贴（灯头都朝 +Y、引脚都朝 −Y）
  const parallel = [P(0, 1, 150, 110, 90, 'green'), P(1, 1, 155.8, 110, 90, 'red'), P(2, 1, 161.6, 110, 90, 'blue')];

  /**
   * 按规划走一遍，检查：下爪时手指不压到板上剩下的零件本体和引脚（也不压自己的引脚）；
   * 拨开时推杆落点不压任何引脚（不从引脚那一侧推）和别的零件，推的路上零件连同引脚不插进别的零件和引脚
   */
  function simulate(parts, tasks) {
    const onBoard = new Map(parts.map((p) => [p.id, { ...p }]));
    for (const t of tasks) {
      const me = onBoard.get(t.partId);
      const others = [...onBoard.values()].filter((o) => o.id !== t.partId).map((o) => partPolys(o, fps));
      if (t.kind === 'push') {
        expect([me.x, me.y]).toEqual([t.partFrom[0], t.partFrom[1]]);
        const pusher = fingerPolys(t.start, t.gripYaw, 0, { grow: 0 });
        expect(anyOv(pusher, leadPolys(me, fps))).toBe(false);
        expect(anyOv(pusher, bodyPolys(me, fps))).toBe(false);
        expect(others.some((ob) => anyOv(pusher, ob))).toBe(false);
        const moved = { ...me, x: t.partTo[0], y: t.partTo[1] };
        // 紧贴着滑过去可以，插进去不行（收缩 0.15 mm 再判断）
        expect(others.some((ob) => anyOv(partPolys(moved, fps, -0.15), ob))).toBe(false);
        onBoard.set(t.partId, moved);
      } else {
        const fingers = fingerPolys(t.from, t.gripYaw, t.gap, { grow: 0 });
        expect(others.some((ob) => anyOv(fingers, ob))).toBe(false);
        expect(anyOv(fingers, leadPolys(me, fps))).toBe(false);
        onBoard.delete(t.partId);
      }
    }
    return onBoard;
  }

  it('实拍的一叠：先拨开再夹，全部分拣；推杆都顶在灯头一侧，手指和推杆从不碰到别的零件和引脚', () => {
    const { tasks, skipped } = plan(photo, binsFor(photo), ARM, { footprints: fps });
    expect(skipped).toEqual([]);
    const picks = tasks.filter((t) => t.kind === 'pick');
    const pushes = tasks.filter((t) => t.kind === 'push');
    expect(picks.map((t) => t.partId).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(pushes.length).toBeGreaterThan(0);
    for (const t of pushes) {
      expect(t.dist).toBeLessThanOrEqual(20);
      // 推的方向朝着底座（引脚）那一侧：推杆在灯头一侧
      const a = (photo[t.partId].rotDeg * Math.PI) / 180;
      const d = [t.partTo[0] - t.partFrom[0], t.partTo[1] - t.partFrom[1]];
      expect(d[0] * Math.cos(a) + d[1] * Math.sin(a)).toBeLessThan(0);
    }
    expect(simulate(photo, tasks).size).toBe(0);
  });

  it('三颗同向并排紧贴：不碰引脚就拆不开——跳过并说明原因，不做压引脚的动作', () => {
    const { tasks, skipped } = plan(parallel, binsFor(parallel), ARM, { footprints: fps });
    expect(skipped).toHaveLength(3);
    expect(skipped[0].skipReason).toMatch(/引脚/);
    simulate(parallel, tasks);
  });

  it('动作序列：拨开时夹爪合拢、下到板面、平移，零件跟着走', () => {
    const { tasks } = plan(photo, binsFor(photo), ARM, { footprints: fps });
    const home = [Math.PI / 2, 0.6, -1.4, -0.8, 0];
    const segs = buildSequence(tasks, photo, ARM, { startAngles: home, homeAngles: home });
    const pushSeg = segs.find((s) => s.push);
    expect(pushSeg.type).toBe('line');
    const i = segs.indexOf(pushSeg);
    // 拨开之前夹爪已合拢
    const lastGrip = segs.slice(0, i).filter((s) => s.type === 'grip').pop();
    expect(lastGrip.to).toBe(0);
    expect(pushSeg.from[2]).toBeCloseTo(pushSeg.to[2], 9);
    // 每次抓取前夹爪开口等于规划的张开量
    tasks.forEach((t, k) => {
      if (t.kind !== 'pick') return;
      const attach = segs.findIndex((s) => s.type === 'attach' && s.task === k);
      const grips = segs.slice(0, attach).filter((s) => s.type === 'grip');
      expect(grips[grips.length - 1].from).toBeCloseTo(t.gap, 9); // 夹紧是从规划的张开量开始收的
    });
  });

  it('挤在一起但还有缝的（相距 14 mm）：张小一点直接夹，不用拨开', () => {
    // 引脚朝外交替排（相邻两颗的引脚不会伸到对方下面）
    const loose = [P(0, 1, 150, 110, 0), P(1, 1, 150, 124, 180), P(2, 1, 150, 138, 0)];
    const { tasks, skipped } = plan(loose, binsFor(loose), ARM, { footprints: fps });
    expect(skipped).toEqual([]);
    expect(tasks.every((t) => t.kind === 'pick')).toBe(true);
    expect(simulate(loose, tasks).size).toBe(0);
  });

  it('拨开时推到板外不行：贴着板边的一团往板内推', () => {
    const edge = [P(0, 1, 6, 110, 90), P(1, 1, 11.8, 110, 90)];
    const pp = planPush(edge[0], [edge[1]], { width: GRIP_WIDTH[1], fps, board: BOARD });
    if (pp) for (const P2 of bodyPolys(pp.part, fps)) for (const [x] of P2) expect(x).toBeGreaterThanOrEqual(4 - 1e-9);
  });
});
