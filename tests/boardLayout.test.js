import { describe, it, expect } from 'vitest';
import { boardToPage, markerRectOnPage, markerCornersOnPage } from '../src/vision/boardLayout.js';

describe('标定板版面', () => {
  it('底板原点在页面左下角，+Y 朝页面顶部', () => {
    expect(boardToPage(0, 0)).toEqual([0, 210]);
    expect(boardToPage(297, 210)).toEqual([297, 0]);
  });

  it('4 个码的位置：ID0 左下、ID1 右下、ID2 右上、ID3 左上，距板边 12 mm', () => {
    expect(markerRectOnPage(0)).toEqual({ x: 12, y: 158, size: 40 });
    expect(markerRectOnPage(1)).toEqual({ x: 245, y: 158, size: 40 });
    expect(markerRectOnPage(2)).toEqual({ x: 245, y: 12, size: 40 });
    expect(markerRectOnPage(3)).toEqual({ x: 12, y: 12, size: 40 });
  });

  it('角点顺序：码自身左上、右上、右下、左下', () => {
    expect(markerCornersOnPage(3)).toEqual([[12, 12], [52, 12], [52, 52], [12, 52]]);
  });
});

describe('码角点的底板坐标', async () => {
  const { markerCornersWorld } = await import('../src/vision/boardLayout.js');
  it('左上 (cx − s/2, cy + s/2) 起顺时针', () => {
    expect(markerCornersWorld(0)).toEqual([[12, 52], [52, 52], [52, 12], [12, 12]]);
  });
  it('与页面坐标一致（页面 y = 210 − Y）', () => {
    for (let id = 0; id < 4; id++) {
      const w = markerCornersWorld(id);
      const pg = markerCornersOnPage(id);
      w.forEach(([X, Y], i) => expect([X, 210 - Y]).toEqual(pg[i]));
    }
  });
});

describe('纸张坐标框', async () => {
  const { paperFrame, frameMatrix, designFrame } = await import('../src/vision/boardLayout.js');
  const apply = (M, [u, v]) => [M[0][0] * u + M[0][1] * v + M[0][2], M[1][0] * u + M[1][1] * v + M[1][2]];

  it('设计尺寸：局部坐标与底板坐标相同', () => {
    const M = frameMatrix(designFrame());
    expect(apply(M, [0, 0])).toEqual([0, 0]);
    const p = apply(M, [297, 210]);
    expect(p[0]).toBeCloseTo(297, 9);
    expect(p[1]).toBeCloseTo(210, 9);
  });

  it('偏移并旋转 0.5° 的纸张：四角往返一致', () => {
    const a = (0.5 * Math.PI) / 180;
    const rot = ([x, y]) => [148 + Math.cos(a) * (x - 148.5) - Math.sin(a) * (y - 105), 106.7 + Math.sin(a) * (x - 148.5) + Math.cos(a) * (y - 105)];
    const corners = [[0, 0], [297, 0], [297, 210], [0, 210]].map(rot);
    const f = paperFrame(corners);
    expect(f.w).toBeCloseTo(297, 9);
    expect(f.h).toBeCloseTo(210, 9);
    expect(f.theta).toBeCloseTo(a, 12);
    expect([f.cx, f.cy].map((x) => +x.toFixed(9))).toEqual([148, 106.7]);
    const M = frameMatrix(f);
    [[0, 0], [297, 0], [297, 210], [0, 210]].forEach((uv, i) => {
      const p = apply(M, uv);
      expect(p[0]).toBeCloseTo(corners[i][0], 9);
      expect(p[1]).toBeCloseTo(corners[i][1], 9);
    });
  });
});
