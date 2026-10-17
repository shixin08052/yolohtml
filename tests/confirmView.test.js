import { describe, it, expect } from 'vitest';
import { outlineCorners, countByClass } from '../src/ui/confirmView.js';

describe('正视图确认：元件轮廓', () => {
  it('不转时是以方法 1 位置为中心、外扩 pad 的矩形', () => {
    const c = outlineCorners({ xPlane: 100, yPlane: 50, rotDeg: 0 }, { minX: -3, maxX: 3, halfW: 1 }, 1);
    expect(c).toEqual([[96, 48], [104, 48], [104, 52], [96, 52]]);
  });

  it('转 90°：长轴变成沿 Y', () => {
    const c = outlineCorners({ xPlane: 0, yPlane: 0, rotDeg: 90 }, { minX: -4, maxX: 4, halfW: 1 }, 0);
    const xs = c.map((p) => p[0]);
    const ys = c.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(8, 9);
  });
});

describe('正视图确认：按类别计数', () => {
  it('只列出有的类别，按类别顺序', () => {
    const classes = [{ id: 0, name: '色环电阻', color: '#00f' }, { id: 1, name: 'LED', color: '#f00' }];
    expect(countByClass([{ cls: 1 }, { cls: 1 }], classes).map((c) => [c.name, c.n])).toEqual([['LED', 2]]);
    expect(countByClass([{ cls: 1 }, { cls: 0 }, { cls: 1 }], classes).map((c) => c.n)).toEqual([1, 2]);
  });
});
