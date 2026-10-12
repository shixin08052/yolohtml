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
