import { describe, it, expect } from 'vitest';
import { fingerPolys, bodyPolys, leadPolys, partPolys, outlinePolys, findGrasp, mtv, separateBodies, planPush, FINGER, PUSH } from '../src/robot/clearance.js';
import { plan, GRIP_WIDTH } from '../src/robot/planner.js';
import { buildSequence, GRIP_MAX } from '../src/robot/sequence.js';
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

  it('两颗同向平行 LED 中心只差 4 mm（底边宽 5.8，插进去 1.8）：各推开约 1 mm 后不再相交，坐标一起挪', () => {
    const { parts, moved } = separateBodies([P(0, 1, 100, 100, 90), P(1, 1, 104, 100, 90)], fps);
    expect(anyOv(outlinePolys(parts[0], fps), outlinePolys(parts[1], fps))).toBe(false);
    expect(moved.get(0)).toBeLessThan(1.3);
    expect(moved.get(1)).toBeLessThan(1.3);
    expect(parts[0].xParallax).toBeCloseTo(parts[0].x, 9);
    expect(parts[0].x).toBeLessThan(100);
  });

  it('两颗头尾相反并排贴着（中心隔 5.5 mm）：灯体 Φ5、只有底边 Φ5.8，本来就没插进去，不推开（之前按 5.8 宽的外接矩形会推出缝）', () => {
    const { moved } = separateBodies([P(0, 1, 100, 100, 0), P(1, 1, 100, 105.5, 180)], fps);
    expect(moved.size).toBe(0);
    // 同向的底边对着底边，5.5 就插进去了
    expect(separateBodies([P(0, 1, 100, 100, 0), P(1, 1, 100, 105.5, 0)], fps).moved.size).toBe(2);
  });

  it('头尾相反、沿长轴错开 1.1 mm、中心隔 5.05 mm（用户实拍的两颗黄色 LED）：底边挨着对方灯头收窄的地方，不推开', () => {
    const { moved } = separateBodies([P(0, 1, 100, 100, 0), P(1, 1, 101.1, 105.05, 180)], fps);
    expect(moved.size).toBe(0);
    // 真插进去（隔 4.6 mm）才推，推到灯体刚好贴上（约 5 mm）为止，不留缝
    const r = separateBodies([P(0, 1, 100, 100, 0), P(1, 1, 101.1, 104.6, 180)], fps);
    const d = r.parts[1].y - r.parts[0].y;
    expect(d).toBeGreaterThan(4.9);
    expect(d).toBeLessThan(5.15);
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
        const pusher = fingerPolys(t.start, t.gripYaw, t.gap ?? 0, { grow: 0 });
        expect(anyOv(pusher, leadPolys(me, fps))).toBe(false);
        expect(anyOv(pusher, bodyPolys(me, fps))).toBe(false);
        expect(others.some((ob) => anyOv(pusher, ob))).toBe(false);
        expect(others.some((ob) => anyOv(fingerPolys(t.end, t.gripYaw, t.gap ?? 0, { grow: 0 }), ob))).toBe(false);
        const moved = { ...me, x: t.partTo[0], y: t.partTo[1] };
        // 紧贴着滑过去可以，插进去不行（收缩 0.15 mm 再判断）
        // 零件与零件按本体的精确外形 + 引脚
        const shape = (q, g) => [...outlinePolys(q, fps, g), ...leadPolys(q, fps, g)];
        const rest = [...onBoard.values()].filter((o) => o.id !== t.partId).map((o) => shape(o, 0));
        expect(rest.some((ob) => anyOv(shape(moved, -0.15), ob))).toBe(false);
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

  // 独立测试集照片里识别出的位置：IMG_9899 五颗灯头朝中心、引脚向外散开的"花瓣"；IMG_9902 五颗上下叠着紧贴
  const flower = [P(0, 1, 149.8, 49.5, 24, 'red'), P(1, 1, 163.8, 49.0, 132, 'green'), P(2, 1, 152.5, 57.2, 346, 'clear'), P(3, 1, 157.8, 64.3, 274, 'clear'), P(4, 1, 162.5, 57.3, 198, 'clear')];
  const stack = [P(0, 1, 146.7, 78.2, 358, 'red'), P(1, 1, 145.9, 103.5, 190, 'green'), P(2, 1, 144.8, 90.8, 357, 'clear'), P(3, 1, 146.8, 84.3, 172, 'clear'), P(4, 1, 146.5, 97.1, 181, 'clear')];

  for (const [name, set] of [['三颗同向并排紧贴', parallel], ['花瓣形（IMG_9899）', flower], ['五颗叠着（IMG_9902）', stack]]) {
    it(`${name}：合拢夹爪推不进去的缝用一根手指拨，全部分拣，手指从不碰到别的零件和引脚`, () => {
      const { tasks, skipped } = plan(set, binsFor(set), ARM, { footprints: fps });
      expect(skipped).toEqual([]);
      expect(tasks.filter((t) => t.kind === 'pick')).toHaveLength(set.length);
      expect(simulate(set, tasks).size).toBe(0);
    });
  }

  it('单指拨时夹爪张到最大：开口与 GRIP_MAX 一致；拨开前夹爪调到对应开口', () => {
    expect(PUSH.openGap).toBe(GRIP_MAX);
    const { tasks } = plan(flower, binsFor(flower), ARM, { footprints: fps });
    const single = tasks.filter((t) => t.kind === 'push' && t.gap > 0);
    expect(single.length).toBeGreaterThan(0);
    const home = [Math.PI / 2, 0.6, -1.4, -0.8, 0];
    const segs = buildSequence(tasks, flower, ARM, { startAngles: home, homeAngles: home });
    for (const s of segs.filter((q) => q.push)) {
      const t = tasks[s.task];
      const lastGrip = segs.slice(0, segs.indexOf(s)).filter((q) => q.type === 'grip').pop();
      expect(lastGrip?.to ?? GRIP_MAX).toBe(t.gap);
    }
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
