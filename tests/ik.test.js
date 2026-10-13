import { describe, it, expect } from 'vitest';
import { ik, fk, fkChain, ikWorld, fkWorld, toBase, lerpAngles, checkPose, pathClear, segmentDistance, gripLineAngle, ARM_SHAPE } from '../src/robot/ik.js';
import { ARM, BINS, BOARD, WORK_AREA } from '../src/config.js';
import { inWorkArea } from '../src/vision/mapping.js';

/** 固定种子的伪随机数 */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const angDiff = (a, b, period) => {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
};

describe('逆运动学 / 正运动学', () => {
  const { L0, L1, L2, L3 } = ARM;

  it('可达范围内随机 200 个点：fk(ik(p)) 与 p 的误差 < 0.01 mm，夹爪竖直向下（只算几何，不查碰撞）', () => {
    const r = rng(11);
    let n = 0;
    while (n < 200) {
      // 腕关节在以肩关节为圆心、半径 (|L1 − L2|, L1 + L2) 的球壳内即可达
      const rho = Math.abs(L1 - L2) + 1 + (L1 + L2 - Math.abs(L1 - L2) - 2) * r();
      const elev = (r() - 0.5) * Math.PI * 0.9;
      const az = (r() - 0.5) * 2 * Math.PI;
      const rr = rho * Math.cos(elev);
      if (rr < 1) continue;
      const p = [rr * Math.cos(az), rr * Math.sin(az), L0 + rho * Math.sin(elev) - L3];
      const s = ik(p, ARM, { check: false });
      expect(s.reachable).toBe(true);
      expect(dist(fk(s.angles, ARM), p)).toBeLessThan(0.01);
      const [, t1, t2, t3] = s.angles;
      expect(t1 + t2 + t3).toBeCloseTo(-Math.PI / 2, 12);
      expect(t2).toBeLessThanOrEqual(0); // 肘部朝上
      n++;
    }
  });

  it('工作区内随机 200 个点（板面到上方 approach 高度）：都可达且不碰撞，fk 误差 < 0.01 mm', () => {
    const r = rng(7);
    let n = 0;
    while (n < 200) {
      const P = [BOARD.width * r(), BOARD.height * r(), ARM.approach * r()];
      if (!inWorkArea(P[0], P[1])) continue;
      const s = ikWorld(P, ARM);
      expect(s.reachable, `${P.map((x) => x.toFixed(1))}：${s.reason}`).toBe(true);
      expect(dist(fkWorld(s.angles, ARM), P)).toBeLessThan(0.01);
      n++;
    }
  });

  it('明显超出范围的点返回不可达', () => {
    for (const p of [[500, 0, 0], [0, -450, 50], [0, 0, L0 + L1 + L2], [300, 300, 0]]) {
      const s = ik(p, ARM);
      expect(s.reachable).toBe(false);
      expect(s.reason).toMatch(/够不到/);
    }
  });

  it('太靠近底座、太低的点返回不可达并说明原因（不穿模）', () => {
    for (const p of [[20, 0, 60], [0, 40, 30], [50, 50, 0], [0, -35, 100]]) {
      const s = ik(p, ARM);
      expect(s.reachable).toBe(false);
      expect(s.reason).toMatch(/底座|大臂|肘关节/);
    }
    expect(ik([200, 0, -5], ARM).reason).toMatch(/桌面/);
  });

  it('fkChain：各段连杆长度不变', () => {
    const { angles } = ik([120, -150, 30], ARM);
    const c = fkChain(angles, ARM);
    expect(dist(c.shoulder, [0, 0, L0])).toBeCloseTo(0, 9);
    expect(dist(c.shoulder, c.elbow)).toBeCloseTo(L1, 9);
    expect(dist(c.elbow, c.wrist)).toBeCloseTo(L2, 9);
    expect(dist(c.wrist, c.tip)).toBeCloseTo(L3, 9);
    // 夹爪竖直向下：指尖在腕关节正下方
    expect(c.tip[0]).toBeCloseTo(c.wrist[0], 9);
    expect(c.tip[1]).toBeCloseTo(c.wrist[1], 9);
    expect(c.wrist[2] - c.tip[2]).toBeCloseTo(L3, 9);
  });

  it('夹爪转动：两指连线方向 = gripYaw（周期 180°），θ₄ 在 ±90° 内；不影响指尖位置', () => {
    const P = [180, 90, 20];
    const base = ikWorld(P, ARM);
    expect(base.angles[4]).toBe(0);
    for (const deg of [0, 20, 80, 100, -35, 170]) {
      const yaw = (deg * Math.PI) / 180;
      const s = ikWorld(P, ARM, { gripYaw: yaw });
      expect(angDiff(gripLineAngle(s.angles), yaw, Math.PI)).toBeLessThan(1e-9);
      expect(Math.abs(s.angles[4])).toBeLessThanOrEqual(Math.PI / 2 + 1e-12);
      expect(dist(fkWorld(s.angles, ARM), P)).toBeLessThan(1e-9);
    }
  });

  it('底板坐标版本与相对底座版本一致', () => {
    const P = [200, 120, 10];
    const s = ikWorld(P, ARM);
    expect(s.angles).toEqual(ik(toBase(P, ARM), ARM).angles);
    expect(dist(fkWorld(s.angles, ARM), P)).toBeLessThan(1e-9);
  });

  it('插值途中夹爪始终竖直向下，θ₀ 走最短方向，θ₄ 线性过渡', () => {
    const a = ik([-100, -150, 60], ARM, { gripYaw: 0.3 }).angles;
    const b = ik([100, -150, 60], ARM, { gripYaw: -0.4 }).angles;
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      const m = lerpAngles(a, b, k);
      expect(m[1] + m[2] + m[3]).toBeCloseTo(-Math.PI / 2, 12);
      expect(m[4]).toBeCloseTo(a[4] + (b[4] - a[4]) * k, 12);
    }
    expect(lerpAngles(a, b, 1)[0]).toBeCloseTo(b[0], 12);
    // 从 170° 转到 −170° 只转 20°
    const m = lerpAngles([(170 * Math.PI) / 180, 0, 0, 0], [(-170 * Math.PI) / 180, 0, 0, 0], 0.5);
    expect(Math.abs(Math.cos(m[0]) + 1)).toBeLessThan(1e-9);
  });
});

describe('碰撞检查', () => {
  it('线段距离', () => {
    expect(segmentDistance([0, 0, 0], [10, 0, 0], [5, 3, 0], [5, 8, 0])).toBeCloseTo(3, 12);
    expect(segmentDistance([0, 0, 0], [10, 0, 0], [12, 0, 4], [20, 0, 4])).toBeCloseTo(Math.hypot(2, 4), 12);
    expect(segmentDistance([0, 0, 0], [0, 0, 0], [1, 1, 0], [1, 1, 0])).toBeCloseTo(Math.SQRT2, 12);
    // 平行线段
    expect(segmentDistance([0, 0, 0], [10, 0, 0], [0, 5, 0], [10, 5, 0])).toBeCloseTo(5, 12);
  });

  it('夹爪伸进底座：判为碰撞', () => {
    const s = ik([60, 0, 40], ARM, { check: false });
    expect(s.reachable).toBe(true);
    expect(checkPose(s.angles, ARM).ok).toBe(false);
  });

  it('肘关节折叠超过上限：判为碰撞', () => {
    const t2 = -(ARM_SHAPE.maxFold + 0.05);
    const t1 = 2.0;
    expect(checkPose([0, t1, t2, -Math.PI / 2 - t1 - t2, 0], ARM).ok).toBe(false);
  });

  it('工作区内两点之间的直接运动多数不碰撞；初始姿态到工作区各点都不碰撞', async () => {
    const { ARM_HOME } = await import('../src/scene/arm.js');
    const home = ikWorld(ARM_HOME, ARM).angles;
    const m = WORK_AREA.margin;
    for (const [x, y] of [[m + 30, m + 30], [BOARD.width - m - 30, m + 30], [BOARD.width / 2, BOARD.height - m], [BOARD.width / 2, BOARD.height / 2]]) {
      const s = ikWorld([x, y, ARM.approach], ARM);
      expect(pathClear(home, s.angles, ARM)).toBe(true);
    }
  });
});

describe('工作范围', () => {
  it('工作区四角、中心、离底座最近的远边中点：板面和上方 approach 高度处都可达', () => {
    const m = WORK_AREA.margin;
    const pts = [
      [m, m], [BOARD.width - m, m], [BOARD.width - m, BOARD.height - m], [m, BOARD.height - m],
      [BOARD.width / 2, BOARD.height / 2], [BOARD.width / 2, BOARD.height - m],
    ];
    for (const [x, y] of pts) {
      for (const z of [0, ARM.approach]) {
        const s = ikWorld([x, y, z], ARM);
        expect(s.reachable, `(${x}, ${y}, ${z})：${s.reason}`).toBe(true);
      }
    }
  });

  it('料盒：盒口中心上方 approach 高度处和盒底都可达', () => {
    for (const b of BINS) {
      const [cx, cy] = b.center;
      expect(ikWorld([cx, cy, b.size[2] + ARM.approach], ARM).reachable).toBe(true);
      expect(ikWorld([cx, cy, 5], ARM).reachable).toBe(true);
    }
  });

  it('机械臂底座在底板远端（远离拍摄者一侧）', () => {
    expect(ARM.base[1]).toBeGreaterThan(BOARD.height);
  });
});
