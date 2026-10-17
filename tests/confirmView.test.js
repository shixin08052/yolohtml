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

describe('正视图确认：标签避让', () => {
  it('两个挨着的框：标签互不重叠，也不盖住别的框', async () => {
    const { placeLabels } = await import('../src/ui/confirmView.js');
    const items = [
      { bbox: [100, 100, 140, 130], w: 80, h: 18 },
      { bbox: [145, 105, 185, 135], w: 80, h: 18 },
      { bbox: [120, 60, 160, 75], w: 80, h: 18 }, // 上方还有一个框，挡住第一个标签的默认位置
    ];
    const pos = placeLabels(items, 400, 300);
    const rects = pos.map(([x, y], i) => [x, y, x + items[i].w, y + items[i].h]);
    const ov = (a, b) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i !== j) expect(ov(rects[i], rects[j])).toBe(false);
        if (i !== j) expect(ov(rects[i], items[j].bbox)).toBe(false);
      }
    }
  });

  it('没有冲突时放在框的正上方', async () => {
    const { placeLabels } = await import('../src/ui/confirmView.js');
    expect(placeLabels([{ bbox: [100, 100, 140, 130], w: 40, h: 18 }], 400, 300, 6)).toEqual([[100, 76]]);
  });
});
