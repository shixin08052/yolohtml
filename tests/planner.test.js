import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { plan, gripYawFor, graspPoint, GRASP_Z } from '../src/robot/planner.js';
import { footprintPolys, polysOverlap, insideBin, DROP } from '../src/robot/drop.js';
import { ikWorld } from '../src/robot/ik.js';
import { createPartMesh, partFootprint } from '../src/scene/parts.js';
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
      // 抓取点：指尖略高于板面；LED 夹在灯体上
      expect(t.from).toEqual(graspPoint(p));
      expect(t.from[2]).toBe(GRASP_Z);
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

  const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));

  /** 每个料盒里落定的零件：全部在盒内、互不重叠（占地矩形） */
  const checkBins = (list, tasks) => {
    for (const bin of BINS) {
      const inBin = tasks.filter((t) => t.binId === bin.id);
      const polys = inBin.map((t) => {
        const [x, y, , yaw] = t.drop.to;
        return footprintPolys(footprints[list[t.partId].cls], { x, y, yaw });
      });
      polys.forEach((p) => expect(insideBin(p, bin)).toBe(true));
      for (let a = 0; a < polys.length; a++) {
        for (let b = a + 1; b < polys.length; b++) {
          const same = Math.abs(inBin[a].drop.to[2] - inBin[b].drop.to[2]) < 1e-9;
          if (same) expect(polys[a].some((P) => polys[b].some((Q) => polysOverlap(P, Q)))).toBe(false);
        }
      }
    }
  };

  it('同类多个零件放进同一料盒：落下后散开，全部躺在盒底、在盒内、互不重叠', () => {
    const many = makeParts([0, 1, 2, 3, 4, 5].map((i) => ({ cls: 1, x: 50 + i * 35, y: 100, rotDeg: i * 20 })));
    const { tasks } = plan(many, BINS, ARM, { footprints });
    expect(tasks).toHaveLength(6);
    checkBins(many, tasks);
    expect(tasks.every((t) => t.drop.to[2] === BIN_WALL)).toBe(true);
    const res = makeParts([0, 1, 2, 3, 4, 5].map((i) => ({ cls: 0, x: 50 + i * 35, y: 100, rotDeg: -i * 25 })));
    const r = plan(res, BINS, ARM, { footprints });
    checkBins(res, r.tasks);
    expect(r.tasks.every((t) => t.drop.to[2] === BIN_WALL)).toBe(true);
  });

  it('松开点在盒底上方 DROP.height（盒里最高零件之上），左右交替；落点结果可复现', () => {
    const many = makeParts([0, 1, 2].map((i) => ({ cls: 1, x: 80 + i * 40, y: 100 })));
    const { tasks } = plan(many, BINS, ARM, { footprints });
    expect(tasks[0].drop.from[2]).toBeCloseTo(BIN_WALL + DROP.height, 9);
    expect(tasks[1].drop.from[2]).toBeCloseTo(BIN_WALL + footprints[1].height + DROP.height, 9);
    expect(tasks[0].drop.from[0]).not.toBeCloseTo(tasks[1].drop.from[0], 3);
    expect(plan(many, BINS, ARM, { footprints }).tasks.map((t) => t.drop)).toEqual(tasks.map((t) => t.drop));
  });

  it('夹在本体中心（检测框中心），LED 也不再偏移', () => {
    const [led] = makeParts([{ cls: 1, x: 150, y: 100, rotDeg: 30 }]);
    expect(graspPoint(led)).toEqual([150, 100, GRASP_Z]);
  });

  it('松开时零件中心正好在松开点上、沿料盒长边（Y）', () => {
    const list = makeParts([
      { cls: 1, x: 212, y: 82, rotDeg: 30 }, { cls: 1, x: 60, y: 100, rotDeg: -70 }, { cls: 1, x: 150, y: 150, rotDeg: 160 },
      { cls: 0, x: 72, y: 122, rotDeg: -35 }, { cls: 0, x: 188, y: 176, rotDeg: 80 },
    ]);
    const { tasks } = plan(list, BINS, ARM, { footprints });
    expect(tasks).toHaveLength(5);
    for (const t of tasks) {
      const p = list[t.partId];
      // 模拟搬运：零件随夹爪转过 Δ = (θ₀ + θ₄)放 − (θ₀ + θ₄)取
      const a = ikWorld(t.from, ARM, { gripYaw: t.gripYaw }).angles;
      const b = ikWorld(t.to, ARM, { gripYaw: t.placeYaw }).angles;
      const d = Math.atan2(Math.sin(b[0] - a[0]), Math.cos(b[0] - a[0])) + (b[4] - a[4]);
      const yaw = (p.rotDeg * Math.PI) / 180 + d;
      expect(Math.abs(Math.cos(yaw))).toBeLessThan(1e-6);
      expect(t.drop.from[0]).toBeCloseTo(t.to[0], 9);
      expect(t.drop.from[1]).toBeCloseTo(t.to[1], 9);
      expect(t.drop.from[3]).toBeCloseTo((yaw * 180) / Math.PI, 6);
      // 松开时整个模型（含引脚）在盒内
      const full = new THREE.Box3().setFromObject(createPartMesh(p.cls));
      const bin = BINS.find((q) => q.id === t.binId);
      expect(Math.abs(t.to[1] - bin.center[1]) + Math.max(-full.min.x, full.max.x)).toBeLessThan(bin.size[1] / 2 - BIN_WALL);
    }
    checkBins(list, tasks);
  });

  it('不可达零件放进"已跳过"并给出原因', () => {
    const bad = makeParts([{ cls: 0, x: 148.5, y: 240 }, { cls: 1, x: 100, y: 100 }]);
    const { tasks, skipped } = plan(bad, BINS, ARM);
    expect(tasks.map((t) => t.partId)).toEqual([1]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe(0);
    expect(skipped[0].reachable).toBe(false);
    expect(skipped[0].skipReason).toMatch(/底座/);
  });

  it('夹爪方向：长条零件（电阻、LED）垂直于长轴', () => {
    expect(gripYawFor({ cls: 0, rotDeg: 20 })).toBeCloseTo((110 * Math.PI) / 180, 12);
    expect(gripYawFor({ cls: 0, rotDeg: -35 })).toBeCloseTo((55 * Math.PI) / 180, 12);
    expect(gripYawFor({ cls: 1, rotDeg: 30 })).toBeCloseTo((120 * Math.PI) / 180, 12);
  });
});
