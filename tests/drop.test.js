import { describe, it, expect } from 'vitest';
import { rng, footprintPolys, polysOverlap, insideBin, settle, dropPose, DROP } from '../src/robot/drop.js';
import { BIN_WALL } from '../src/config.js';

const bin = { center: [0, 0], size: [60, 66, 35] };
// 类似躺平 LED 的占地：本体 8.5 × 5.8，引脚 20 mm
const LED = { rects: [{ minX: -4.25, maxX: 4.25, halfW: 2.9 }, { minX: -24, maxX: -4, halfW: 1.5 }], height: 5.8 };

describe('落进料盒', () => {
  it('伪随机数可复现、在 [0, 1) 内', () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(Array.from({ length: 100 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('矩形相交判断（分离轴）', () => {
    const fp = { rects: [{ minX: -5, maxX: 5, halfW: 1 }] };
    const A = footprintPolys(fp, { x: 0, y: 0, yaw: 0 })[0];
    expect(polysOverlap(A, footprintPolys(fp, { x: 0, y: 1.5, yaw: 0 })[0])).toBe(true);
    expect(polysOverlap(A, footprintPolys(fp, { x: 0, y: 2.5, yaw: 0 })[0])).toBe(false);
    // 十字交叉
    expect(polysOverlap(A, footprintPolys(fp, { x: 0, y: 0, yaw: 90 })[0])).toBe(true);
    // 斜着错开：外接框相交但矩形本身不相交
    expect(polysOverlap(A, footprintPolys(fp, { x: 8.5, y: 5, yaw: 45 })[0])).toBe(false);
  });

  it('盒内判断按盒壁内侧', () => {
    const fp = { rects: [{ minX: -5, maxX: 5, halfW: 1 }] };
    const lim = bin.size[0] / 2 - BIN_WALL;
    expect(insideBin(footprintPolys(fp, { x: lim - 5.01, y: 0, yaw: 0 }), bin)).toBe(true);
    expect(insideBin(footprintPolys(fp, { x: lim - 4.9, y: 0, yaw: 0 }), bin)).toBe(false);
  });

  it('在同一个点连续丢 8 个 LED：全部落在盒底、在盒内、互不重叠，离松开点不远', () => {
    const placed = [];
    for (let i = 0; i < 8; i++) {
      const r = settle(bin, placed, LED, { x: -8 + 16 * (i % 2), y: 0, yaw: 90 }, { seed: i + 1 });
      const polys = footprintPolys(LED, r);
      expect(insideBin(polys, bin)).toBe(true);
      for (const o of placed) expect(polys.some((P) => footprintPolys(o.fp, o).some((Q) => polysOverlap(P, Q)))).toBe(false);
      expect(r.z).toBe(BIN_WALL);
      expect(Math.hypot(r.x, r.y)).toBeLessThan(40);
      placed.push({ fp: LED, ...r, height: LED.height });
    }
  });

  it('第一个零件只带一点随机偏移和转角；同样的种子结果相同', () => {
    const r = settle(bin, [], LED, { x: 8, y: 0, yaw: 90 }, { seed: 7 });
    expect(Math.abs(r.x - 8)).toBeLessThanOrEqual(DROP.jitterMm);
    expect(Math.abs(r.y)).toBeLessThanOrEqual(DROP.jitterMm);
    expect(Math.abs(r.yaw - 90)).toBeLessThanOrEqual(DROP.jitterDeg + 1e-9);
    expect(settle(bin, [], LED, { x: 8, y: 0, yaw: 90 }, { seed: 7 })).toEqual(r);
  });

  it('盒底放不下时叠到上一层', () => {
    const tiny = { center: [0, 0], size: [16, 40, 20] }; // 内侧 12 × 36，只放得下一个
    const fp = { rects: [{ minX: -15, maxX: 15, halfW: 3 }], height: 4 };
    const a = settle(tiny, [], fp, { x: 0, y: 0, yaw: 90 }, { seed: 1 });
    const b = settle(tiny, [{ fp, ...a, height: 4 }], fp, { x: 0, y: 0, yaw: 90 }, { seed: 2 });
    expect(a.z).toBe(BIN_WALL);
    expect(b.z).toBe(BIN_WALL + 4);
  });

  it('下落动画：起止位姿正确，全程不低于落点，落地后弹起又落回', () => {
    const d = { from: [0, 0, 14, 90], to: [6, -3, 2, 120] };
    expect(dropPose(d, 0)).toEqual([0, 0, 14, 90]);
    const end = dropPose(d, 1);
    end.forEach((v, i) => expect(v).toBeCloseTo(d.to[i], 9));
    const zs = Array.from({ length: 101 }, (_, i) => dropPose(d, i / 100)[2]);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(2 - 1e-9);
    // 很快落到底（0.3），之后有一段高于盒底（弹起）；前一半时间里一直在往下掉，不会停在半空
    expect(zs[30]).toBeCloseTo(2, 6);
    expect(Math.max(...zs.slice(32, 55))).toBeGreaterThan(2.5);
    for (let i = 1; i <= 30; i++) expect(zs[i]).toBeLessThan(zs[i - 1]);
    // 角度走最短方向
    expect(dropPose({ from: [0, 0, 5, 170], to: [0, 0, 2, -170] }, 1)[3]).toBeCloseTo(190, 9);
  });
});
