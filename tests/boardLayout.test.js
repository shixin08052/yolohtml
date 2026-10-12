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
