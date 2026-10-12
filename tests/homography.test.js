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

describe('由码求底板单应性', async () => {
  const { boardHomography, REPROJ_WARN_PX } = await import('../src/vision/homography.js');
  const markersFrom = (H, ids, noise = () => [0, 0]) =>
    ids.map((id) => ({ id, corners: markerCornersWorld(id).map((p) => { const [u, v] = applyH(H0, p); const [a, b] = noise(); return [u + a, v + b]; }) }));

  it('4 个码：恢复 H，重投影误差 ≈ 0，无提醒', () => {
    const r = boardHomography(markersFrom(H0, [0, 1, 2, 3]), markerCornersWorld);
    expect(r.reprojErrPx).toBeLessThan(1e-6);
    expect(r.warnings).toEqual([]);
    const q = applyH(r.Hinv, applyH(H0, [100, 50]));
    expect(q[0]).toBeCloseTo(100, 6);
    expect(q[1]).toBeCloseTo(50, 6);
  });

  it('少于 4 个码：仍能求解，并提醒精度下降', () => {
    const r = boardHomography(markersFrom(H0, [1, 3]), markerCornersWorld);
    expect(r.reprojErrPx).toBeLessThan(1e-6);
    expect(r.warnings[0]).toContain('只识别到 2 个码');
  });

  it('重投影误差 > 3 像素时提示重拍', () => {
    const r0 = rng(7);
    const r = boardHomography(markersFrom(H0, [0, 1, 2, 3], () => [6 * gauss(r0), 6 * gauss(r0)]), markerCornersWorld);
    expect(r.reprojErrPx).toBeGreaterThan(REPROJ_WARN_PX);
    expect(r.warnings.join('')).toContain('重拍');
  });

  it('没有码时报错', () => {
    expect(() => boardHomography([], markerCornersWorld)).toThrow();
  });
});

describe('正射图', async () => {
  const { rectifyPixels } = await import('../src/vision/homography.js');
  const { BOARD } = await import('../src/config.js');

  // 底板上的图案：每 10 mm 一格的棋盘（黑 / 白），用于检查映射
  const pattern = (X, Y) => ((Math.floor(X / 10) + Math.floor(Y / 10)) % 2 ? 0 : 255);

  /** 用已知 H 把底板图案"拍"成一张原图（逆映射 + 4×4 超采样） */
  function photo(H, W, Hpx) {
    const Hinv = invert3(H);
    const data = new Uint8ClampedArray(W * Hpx * 4);
    for (let v = 0; v < Hpx; v++) {
      for (let u = 0; u < W; u++) {
        let s = 0;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const [X, Y] = applyH(Hinv, [u + (a + 0.5) / 4, v + (b + 0.5) / 4]);
          s += X >= 0 && X <= BOARD.width && Y >= 0 && Y <= BOARD.height ? pattern(X, Y) : 128;
        }
        const p = (v * W + u) * 4;
        data[p] = data[p + 1] = data[p + 2] = s / 16;
        data[p + 3] = 255;
      }
    }
    return { width: W, height: Hpx, data };
  }

  // 约 3 px/mm、带透视的拍摄
  const Hc = [
    [3.0, 0.4, 80],
    [0.2, -2.9, 720],
    [0.0002, 0.0005, 1],
  ];
  const src = photo(Hc, 1100, 800);
  const out = rectifyPixels(src, Hc, { boardW: BOARD.width, boardH: BOARD.height, pxPerMm: 2 });

  it('A4 底板输出 594 × 420', () => {
    expect([out.width, out.height]).toEqual([594, 420]);
  });

  it('画布 (i, j) 对应底板 X = (j+0.5)/2，Y = 210 − (i+0.5)/2：图案对得上', () => {
    let bad = 0;
    let n = 0;
    for (let i = 0; i < out.height; i += 7) {
      for (let j = 0; j < out.width; j += 7) {
        const X = (j + 0.5) / 2;
        const Y = BOARD.height - (i + 0.5) / 2;
        // 跳过格线附近（插值过渡带）
        const fx = X % 10;
        const fy = Y % 10;
        if (fx < 1 || fx > 9 || fy < 1 || fy > 9) continue;
        const g = out.data[(i * out.width + j) * 4];
        if (Math.abs(g - pattern(X, Y)) > 40) bad++;
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it('画布顶部是底板远端（Y 大），左上角对应底板 (0, 210)', () => {
    // 底板 (0..10, 200..210) 一格：floor(0/10)+floor(200/10)=20 → 偶数 → 白
    expect(out.data[(2 * out.width + 2) * 4]).toBeGreaterThan(200);
    // 往右一格 (10..20, 200..210) → 黑
    expect(out.data[(2 * out.width + 30) * 4]).toBeLessThan(55);
  });

  it('原图外的区域为透明', () => {
    const tiny = { width: 10, height: 10, data: new Uint8ClampedArray(400).fill(255) };
    const o = rectifyPixels(tiny, Hc, { boardW: BOARD.width, boardH: BOARD.height, pxPerMm: 1 });
    expect(o.data[(100 * o.width + 100) * 4 + 3]).toBe(0);
  });
});
