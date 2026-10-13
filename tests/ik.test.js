import { describe, it, expect } from 'vitest';
import { ik, fk, fkChain, ikWorld, fkWorld, toBase, lerpAngles } from '../src/robot/ik.js';
import { ARM, BINS, BOARD, WORK_AREA } from '../src/config.js';

/** 固定种子的伪随机数 */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('逆运动学 / 正运动学', () => {
  const { L0, L1, L2, L3 } = ARM;

  it('可达范围内随机 200 个点：fk(ik(p)) 与 p 的误差 < 0.01 mm，夹爪竖直向下', () => {
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
      const s = ik(p, ARM);
      expect(s.reachable).toBe(true);
      expect(dist(fk(s.angles, ARM), p)).toBeLessThan(0.01);
      const [, t1, t2, t3] = s.angles;
      expect(t1 + t2 + t3).toBeCloseTo(-Math.PI / 2, 12);
      // 肘部朝上：θ₂ ≤ 0，肘关节在肩—腕连线上方
      expect(t2).toBeLessThanOrEqual(0);
      n++;
    }
  });

  it('明显超出范围的点返回不可达', () => {
    for (const p of [[500, 0, 0], [0, -450, 50], [0, 0, L0 + L1 + L2], [300, 300, 0]]) {
      const s = ik(p, ARM);
      expect(s.reachable).toBe(false);
      expect(s.reason).toMatch(/够不到/);
    }
    // 腕关节离肩关节太近（< |L1 − L2|）
    const close = ik([5, 0, L0 - L3], ARM);
    expect(close.reachable).toBe(false);
  });

  it('fkChain：各段连杆长度不变', () => {
    const { angles } = ik([120, 150, 30], ARM);
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

  it('底板坐标版本与相对底座版本一致', () => {
    const P = [200, 120, 10];
    const s = ikWorld(P, ARM);
    expect(s.angles).toEqual(ik(toBase(P, ARM), ARM).angles);
    expect(dist(fkWorld(s.angles, ARM), P)).toBeLessThan(1e-9);
  });

  it('插值途中夹爪始终竖直向下，θ₀ 走最短方向', () => {
    const a = ik([-100, 50, 60], ARM).angles;
    const b = ik([100, 50, 60], ARM).angles;
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      const m = lerpAngles(a, b, k);
      expect(m[1] + m[2] + m[3]).toBeCloseTo(-Math.PI / 2, 12);
    }
    expect(lerpAngles(a, b, 1)[0]).toBeCloseTo(b[0], 12);
    // 从 170° 转到 −170° 只转 20°
    const m = lerpAngles([(170 * Math.PI) / 180, 0, 0, 0], [(-170 * Math.PI) / 180, 0, 0, 0], 0.5);
    expect(Math.abs(Math.cos(m[0]) + 1)).toBeLessThan(1e-9);
  });
});

describe('工作范围', () => {
  it('工作区四角和中心：板面和上方 approach 高度处都可达', () => {
    const m = WORK_AREA.margin;
    const pts = [[m, m], [BOARD.width - m, m], [BOARD.width - m, BOARD.height - m], [m, BOARD.height - m], [BOARD.width / 2, BOARD.height / 2]];
    for (const [x, y] of pts) {
      for (const z of [0, ARM.approach]) expect(ikWorld([x, y, z], ARM).reachable).toBe(true);
    }
  });

  it('6 个料盒：盒口中心上方 approach 高度处和盒底都可达', () => {
    for (const b of BINS) {
      const [cx, cy] = b.center;
      expect(ikWorld([cx, cy, b.size[2] + ARM.approach], ARM).reachable).toBe(true);
      expect(ikWorld([cx, cy, 5], ARM).reachable).toBe(true);
    }
  });
});
