import { describe, it, expect } from 'vitest';
import { boardToPage, markerRectOnPage, markerCornersOnPage } from '../src/vision/boardLayout.js';

describe('标定板版面', () => {
  it('底板原点在页面左下角，+Y 朝页面顶部', () => {
    expect(boardToPage(0, 0)).toEqual([0, 297]);
    expect(boardToPage(420, 297)).toEqual([420, 0]);
  });

  it('4 个码的位置：ID0 左下、ID1 右下、ID2 右上、ID3 左上，距板边 15 mm', () => {
    expect(markerRectOnPage(0)).toEqual({ x: 15, y: 232, size: 50 });
    expect(markerRectOnPage(1)).toEqual({ x: 355, y: 232, size: 50 });
    expect(markerRectOnPage(2)).toEqual({ x: 355, y: 15, size: 50 });
    expect(markerRectOnPage(3)).toEqual({ x: 15, y: 15, size: 50 });
  });

  it('角点顺序：码自身左上、右上、右下、左下', () => {
    expect(markerCornersOnPage(3)).toEqual([[15, 15], [65, 15], [65, 65], [15, 65]]);
  });
});
