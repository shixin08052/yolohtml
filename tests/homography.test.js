import { describe, it, expect } from 'vitest';
import { solveHomography, applyH, invert3, reprojError } from '../src/vision/homography.js';
import { markerCornersWorld } from '../src/vision/boardLayout.js';

// 一个带透视的已知 H（底板 mm → 像素）
const H0 = [
  [9.1, -1.3, 610],
  [0.8, -7.6, 2650],
  [0.0004, 0.0021, 1],
];

const worldPts = [0, 1, 2, 3].flatMap((id) => markerCornersWorld(id));

/** 固定种子的伪随机数，保证测试可复现 */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

describe('单应性', () => {
  it('无噪声时恢复出 H', () => {
    const imgPts = worldPts.map((p) => applyH(H0, p));
    const H = solveHomography(worldPts, imgPts);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      expect(H[i][j]).toBeCloseTo(H0[i][j], Math.abs(H0[i][j]) > 1 ? 6 : 9);
    }
    expect(reprojError(H, worldPts, imgPts)).toBeLessThan(1e-6);
  });

  it('只有 1 个码（4 点）也能求解', () => {
    const w = markerCornersWorld(2);
    const H = solveHomography(w, w.map((p) => applyH(H0, p)));
    const q = applyH(H, [148.5, 105]);
    const t = applyH(H0, [148.5, 105]);
    expect(Math.hypot(q[0] - t[0], q[1] - t[1])).toBeLessThan(1e-6);
  });

  it('加 0.5 像素噪声后重投影误差 < 1 像素', () => {
    const r = rng(42);
    const imgPts = worldPts.map((p) => {
      const [u, v] = applyH(H0, p);
      return [u + 0.5 * gauss(r), v + 0.5 * gauss(r)];
    });
    const H = solveHomography(worldPts, imgPts);
    expect(reprojError(H, worldPts, imgPts)).toBeLessThan(1);
  });

  it('Hinv 把像素映射回底板坐标', () => {
    const Hinv = invert3(H0);
    const p = [100, 60];
    const back = applyH(Hinv, applyH(H0, p));
    expect(back[0]).toBeCloseTo(100, 9);
    expect(back[1]).toBeCloseTo(60, 9);
  });

  it('点数不足时报错', () => {
    expect(() => solveHomography([[0, 0], [1, 0], [0, 1]], [[0, 0], [1, 0], [0, 1]])).toThrow();
  });
});
