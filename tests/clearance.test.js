import { describe, it, expect } from 'vitest';
import { fingerPolys, bodyPolys, findGrasp, mtv, separateBodies, planPush, FINGER } from '../src/robot/clearance.js';
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
    // 长轴沿 X；邻居（横着放）在 +X 端旁边、正好压在手指下方
    const me = P(0, 1, 100, 100, 0);
    const other = P(1, 0, 107, 108.5, 0); // 电阻本体 x 103.85–110.15：中心抓时手指（x 95.5–104.5）压到它
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
  // 照用户截图：三颗 LED 并排紧贴（互相平行、长轴沿 Y），中间没有缝
  const cluster = [P(0, 1, 150, 110, 90, 'green'), P(1, 1, 155.8, 110, 90, 'red'), P(2, 1, 161.6, 110, 90, 'blue')];

  /** 按规划走一遍，检查每次下爪时手指都不碰板上剩下的零件本体，拨开时零件不撞别人 */
  function simulate(parts, tasks) {
    const onBoard = new Map(parts.map((p) => [p.id, { ...p }]));
    for (const t of tasks) {
      const me = onBoard.get(t.partId);
      const others = [...onBoard.values()].filter((o) => o.id !== t.partId).map((o) => bodyPolys(o, fps));
      if (t.kind === 'push') {
        expect([me.x, me.y]).toEqual([t.partFrom[0], t.partFrom[1]]);
        const moved = { ...me, x: t.partTo[0], y: t.partTo[1] };
        // 紧贴着滑过去可以，插进去不行（收缩 0.15 mm 再判断）
        expect(others.some((ob) => anyOv(bodyPolys(moved, fps, -0.15), ob))).toBe(false);
        onBoard.set(t.partId, moved);
      } else {
        const fingers = fingerPolys(t.from, t.gripYaw, t.gap, { grow: 0 });
        expect(others.some((ob) => anyOv(fingers, ob))).toBe(false);
        onBoard.delete(t.partId);
      }
    }
    return onBoard;
  }

  it('三颗紧贴：一颗都下不去时先拨开，最后全部分拣，手指从不碰到别的零件', () => {
    const { tasks, skipped } = plan(cluster, binsFor(cluster), ARM, { footprints: fps });
    expect(skipped).toEqual([]);
    const picks = tasks.filter((t) => t.kind === 'pick');
    const pushes = tasks.filter((t) => t.kind === 'push');
    expect(picks.map((t) => t.partId).sort()).toEqual([0, 1, 2]);
    expect(pushes.length).toBeGreaterThan(0);
    expect(tasks[0].kind).toBe('push'); // 一开始谁都下不去
    for (const t of pushes) expect(t.dist).toBeLessThanOrEqual(16);
    expect(simulate(cluster, tasks).size).toBe(0);
  });

  it('动作序列：拨开时夹爪合拢、下到板面、平移，零件跟着走', () => {
    const { tasks } = plan(cluster, binsFor(cluster), ARM, { footprints: fps });
    const home = [Math.PI / 2, 0.6, -1.4, -0.8, 0];
    const segs = buildSequence(tasks, cluster, ARM, { startAngles: home, homeAngles: home });
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
    const loose = [P(0, 1, 150, 110, 90), P(1, 1, 164, 110, 90), P(2, 1, 178, 110, 90)];
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
