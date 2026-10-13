import { describe, it, expect } from 'vitest';
import { buildSequence, moveMs, lineMs, GRIP_MAX } from '../src/robot/sequence.js';
import { plan, GRIP_WIDTH } from '../src/robot/planner.js';
import { ikWorld, fkWorld, lerpAngles, checkPose } from '../src/robot/ik.js';
import { ARM, BINS, CLASSES } from '../src/config.js';
import { ARM_HOME } from '../src/scene/arm.js';
import layout from '../src/synth/layout.json';

const parts = layout.parts.map((p, i) => ({
  id: i, cls: p.cls, name: CLASSES[p.cls].name, score: 1, x: p.x, y: p.y, heightMm: CLASSES[p.cls].heightMm,
  xPlane: p.x, yPlane: p.y, xParallax: p.x, yParallax: p.y, rotDeg: p.rotDeg, detIndex: i, reachable: true,
}));
const home = ikWorld(ARM_HOME, ARM).angles;
const { tasks } = plan(parts, BINS, ARM);
const segs = buildSequence(tasks, parts, ARM, { startAngles: home, homeAngles: home });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** 段结束时的关节角 */
const endAngles = (s) => (s.type === 'move' ? s.to : ikWorld(s.to, ARM, { gripYaw: s.gripYaw }).angles);
const startAngles = (s) => (s.type === 'move' ? s.from : ikWorld(s.from, ARM, { gripYaw: s.gripYaw }).angles);

describe('分拣动作序列', () => {
  it('每个任务都有夹起和放下，且先夹起后放下；最后回到初始姿态', () => {
    tasks.forEach((t, i) => {
      const a = segs.findIndex((s) => s.type === 'attach' && s.task === i);
      const d = segs.findIndex((s) => s.type === 'detach' && s.task === i);
      expect(a).toBeGreaterThan(-1);
      expect(d).toBeGreaterThan(a);
      expect(segs[a].partId).toBe(t.partId);
    });
    const last = segs[segs.length - 1];
    expect(last.type).toBe('move');
    expect(last.to).toEqual(home);
  });

  it('运动段首尾相接：每段的起点就是上一段的终点', () => {
    let cur = home;
    for (const s of segs) {
      if (s.type !== 'move' && s.type !== 'line') continue;
      const a = startAngles(s);
      expect(dist(fkWorld(a, ARM), fkWorld(cur, ARM))).toBeLessThan(1e-6);
      for (const k of [0, 1, 2, 4]) expect(Math.abs(Math.atan2(Math.sin(a[k] - cur[k]), Math.cos(a[k] - cur[k])))).toBeLessThan(1e-6);
      cur = endAngles(s);
    }
  });

  it('夹起时夹爪正好夹紧零件宽度，放下前松开；直线段是竖直的', () => {
    tasks.forEach((t, i) => {
      const a = segs.findIndex((s) => s.type === 'attach' && s.task === i);
      const g = segs[a - 1];
      expect(g.type).toBe('grip');
      expect(g.to).toBe(GRIP_WIDTH[parts[t.partId].cls]);
      const d = segs.findIndex((s) => s.type === 'detach' && s.task === i);
      expect(segs[d - 1].type).toBe('grip');
      expect(segs[d - 1].to).toBeGreaterThan(GRIP_WIDTH[parts[t.partId].cls]);
      expect(segs[d - 1].to).toBeLessThanOrEqual(GRIP_MAX);
      // 松开后零件从夹爪下（零件底面 = 指尖高度 − 夹取高度）落到规划的位置
      const f = segs[d + 1];
      expect(f).toMatchObject({ type: 'drop', partId: t.partId, from: t.drop.from, to: t.drop.to });
      expect(f.from[2]).toBeCloseTo(t.to[2] - t.graspZ, 9);
    });
    for (const s of segs.filter((q) => q.type === 'line')) {
      expect(s.from[0]).toBeCloseTo(s.to[0], 9);
      expect(s.from[1]).toBeCloseTo(s.to[1], 9);
    }
  });

  it('全程不碰撞：每段运动取若干中间姿态检查', () => {
    for (const s of segs) {
      for (const k of [0.25, 0.5, 0.75]) {
        let a;
        if (s.type === 'move') a = lerpAngles(s.from, s.to, k);
        else if (s.type === 'line') {
          const P = s.from.map((x, i) => x + (s.to[i] - x) * k);
          a = ikWorld(P, ARM, { gripYaw: s.gripYaw, check: false }).angles;
        } else continue;
        expect(checkPose(a, ARM).ok).toBe(true);
      }
    }
  });

  it('每段运动 0.4–0.8 秒', () => {
    for (const s of segs.filter((q) => q.type === 'move' || q.type === 'line')) {
      expect(s.ms).toBeGreaterThanOrEqual(400);
      expect(s.ms).toBeLessThanOrEqual(800);
    }
    expect(moveMs([0, 0, 0, 0, 0], [3, 0, 0, 0, 0])).toBe(800);
    expect(lineMs([0, 0, 0], [0, 0, 0])).toBe(400);
  });
});
