import { describe, it, expect } from 'vitest';
import { toThree, fromThree } from '../src/math/coords.js';

describe('coords', () => {
  it('底板点 (297, 210, 10) → Three.js (297, 10, −210)', () => {
    const v = toThree(297, 210, 10);
    expect([v.x, v.y, v.z]).toEqual([297, 10, -210]);
  });

  it('转回底板坐标保持一致', () => {
    expect(fromThree(toThree(297, 210, 10))).toEqual([297, 210, 10]);
  });

  it('Z 缺省为 0，随机点往返一致', () => {
    expect(fromThree(toThree(12.5, -3))).toEqual([12.5, -3, 0]);
    for (let k = 0; k < 50; k++) {
      const p = [Math.random() * 800 - 200, Math.random() * 600 - 150, Math.random() * 500];
      const q = fromThree(toThree(...p));
      for (let i = 0; i < 3; i++) expect(q[i]).toBeCloseTo(p[i], 12);
    }
  });

  it('右手系：Three.js 中 X × Y 方向 = Z 方向', () => {
    const ex = toThree(1, 0, 0);
    const ey = toThree(0, 1, 0);
    const ez = toThree(0, 0, 1);
    const c = ex.clone().cross(ey);
    expect(c.distanceTo(ez)).toBe(0);
  });
});
