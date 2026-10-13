import { describe, it, expect } from 'vitest';
import { plan, binSlot, gripYawFor, BIN_SLOTS } from '../src/robot/planner.js';
import { ikWorld } from '../src/robot/ik.js';
import { ARM, BINS, BIN_WALL, CLASSES } from '../src/config.js';
import layout from '../src/synth/layout.json';

/** 由布局造零件（与 mapping.js 输出的字段一致） */
const makeParts = (list) =>
  list.map((p, i) => ({
    id: i, cls: p.cls, name: CLASSES[p.cls].name, score: 1, x: p.x, y: p.y, heightMm: CLASSES[p.cls].heightMm,
    xPlane: p.x, yPlane: p.y, xParallax: p.x, yParallax: p.y, rotDeg: p.rotDeg ?? 0, detIndex: i, reachable: true,
  }));

describe('分拣规划', () => {
  const parts = makeParts(layout.parts);

  it('每个可达零件恰好出现一次，料盒与类别对应', () => {
    const { tasks, skipped } = plan(parts, BINS, ARM);
    expect(skipped).toHaveLength(0);
    expect(tasks.map((t) => t.partId).sort((a, b) => a - b)).toEqual(parts.map((p) => p.id));
    for (const t of tasks) {
      const p = parts[t.partId];
      expect(BINS.find((b) => b.id === t.binId).cls).toBe(p.cls);
      // 抓取点：零件中心半高处
      expect(t.from).toEqual([p.x, p.y, p.heightMm / 2]);
      expect(t.hoverFrom[2]).toBeCloseTo(t.from[2] + ARM.approach, 9);
    }
  });

  it('相同输入得到相同顺序；输入顺序打乱也一样', () => {
    const a = plan(parts, BINS, ARM).tasks.map((t) => t.partId);
    const b = plan(parts, BINS, ARM).tasks.map((t) => t.partId);
    const c = plan([...parts].reverse(), BINS, ARM).tasks.map((t) => t.partId);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('贪心最近邻：第一个是离起点最近的零件，之后从料盒上方选最近的', () => {
    const start = [148.5, 290, 0];
    const { tasks } = plan(parts, BINS, ARM, { start });
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const first = parts.reduce((b, p) => (d([p.x, p.y], start) < d([b.x, b.y], start) ? p : b));
    expect(tasks[0].partId).toBe(first.id);
    for (let i = 1; i < tasks.length; i++) {
      const cur = tasks[i - 1].hoverTo;
      const rest = tasks.slice(i).map((t) => parts[t.partId]);
      const nearest = Math.min(...rest.map((p) => d([p.x, p.y], cur)));
      const chosen = parts[tasks[i].partId];
      expect(d([chosen.x, chosen.y], cur)).toBeCloseTo(nearest, 9);
    }
  });

  it('所有关键位置都可达（含碰撞检查），夹爪转向一致', () => {
    const { tasks } = plan(parts, BINS, ARM);
    for (const t of tasks) {
      for (const P of [t.from, t.hoverFrom, t.to, t.hoverTo]) {
        expect(ikWorld(P, ARM, { gripYaw: t.gripYaw }).reachable).toBe(true);
      }
    }
  });

  it('同一料盒内的零件依次错开，放满 4 个后叠到上一层', () => {
    const bin = BINS[0];
    const s = [0, 1, 2, 3, 4].map((k) => binSlot(bin, k, 3));
    expect(new Set(s.slice(0, 4).map((q) => `${q.x},${q.y}`)).size).toBe(4);
    expect(s.slice(0, 4).every((q) => q.floor === BIN_WALL)).toBe(true);
    expect(s[4].floor).toBe(BIN_WALL + 3);
    expect([s[4].x, s[4].y]).toEqual([s[0].x, s[0].y]);
    // 放置位置在盒内（考虑零件半宽）
    for (const [ox, oy] of BIN_SLOTS) {
      expect(Math.abs(ox) + 12).toBeLessThan(bin.size[0] / 2);
      expect(Math.abs(oy) + 12).toBeLessThan(bin.size[1] / 2);
    }
  });

  it('同类多个零件放进同一料盒的不同位置；放置点在盒底上方半个零件高', () => {
    const many = makeParts([0, 1, 2, 3, 4].map((i) => ({ cls: 1, x: 60 + i * 40, y: 100 })));
    const { tasks } = plan(many, BINS, ARM);
    expect(tasks).toHaveLength(5);
    const keys = tasks.map((t) => t.to.join(','));
    expect(new Set(keys).size).toBe(5);
    expect(tasks.filter((t) => t.to[2] === BIN_WALL + 6)).toHaveLength(4);
  });

  it('不可达零件放进"已跳过"并给出原因', () => {
    const bad = makeParts([{ cls: 0, x: 148.5, y: 240 }, { cls: 2, x: 100, y: 100 }]);
    const { tasks, skipped } = plan(bad, BINS, ARM);
    expect(tasks.map((t) => t.partId)).toEqual([1]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe(0);
    expect(skipped[0].reachable).toBe(false);
    expect(skipped[0].skipReason).toMatch(/底座/);
  });

  it('夹爪方向：长条零件垂直于长轴，圆形零件不转', () => {
    expect(gripYawFor({ cls: 0, rotDeg: 20 })).toBeCloseTo((110 * Math.PI) / 180, 12);
    expect(gripYawFor({ cls: 3, rotDeg: -35 })).toBeCloseTo((55 * Math.PI) / 180, 12);
    expect(gripYawFor({ cls: 1, rotDeg: 0 })).toBeNull();
  });
});
