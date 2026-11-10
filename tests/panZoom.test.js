import { describe, it, expect } from 'vitest';
import { clampView, zoomAt, ZOOM_MAX } from '../src/ui/panZoom.js';
import { labelScale } from '../src/ui/confirmView.js';

// 画布 360 × 400，内容 328 × 232 居中
const fit = { ox: 16, oy: 84, w: 328, h: 232 };
const W = 360;
const H = 400;

describe('正视图缩放：范围限制', () => {
  it('不放大时内容居中，拖不动', () => {
    expect(clampView({ z: 1, tx: 50, ty: -80 }, fit, W, H)).toEqual({ z: 1, tx: 0, ty: 0 });
  });

  it('缩放限制在 1 到最大倍数之间', () => {
    expect(clampView({ z: 0.3, tx: 0, ty: 0 }, fit, W, H).z).toBe(1);
    expect(clampView({ z: 99, tx: 0, ty: 0 }, fit, W, H).z).toBe(ZOOM_MAX);
  });

  it('放大后不能把内容拖出空白：边缘最多贴到画布边', () => {
    const z = 3;
    const left = clampView({ z, tx: 9999, ty: 9999 }, fit, W, H);
    expect(fit.ox * z + left.tx).toBeCloseTo(0, 9); // 内容左边贴画布左边
    expect(fit.oy * z + left.ty).toBeCloseTo(0, 9);
    const right = clampView({ z, tx: -9999, ty: -9999 }, fit, W, H);
    expect((fit.ox + fit.w) * z + right.tx).toBeCloseTo(W, 9);
    expect((fit.oy + fit.h) * z + right.ty).toBeCloseTo(H, 9);
  });

  it('只有一个方向比画布大时，另一个方向仍居中', () => {
    const v = clampView({ z: 1.5, tx: -100, ty: 123 }, fit, W, H); // 宽 492 > 360，高 348 < 400
    expect(fit.oy * 1.5 + v.ty).toBeCloseTo((H - fit.h * 1.5) / 2, 9);
    expect(v.tx).toBe(-100);
  });
});

describe('正视图缩放：以一点为中心', () => {
  it('缩放前后该点下的内容不动', () => {
    const v0 = { z: 1.2, tx: -30, ty: 10 };
    const [mx, my] = [200, 150];
    const before = [(mx - v0.tx) / v0.z, (my - v0.ty) / v0.z];
    const v1 = zoomAt(v0, mx, my, 3);
    expect(v1.z).toBe(3);
    expect((mx - v1.tx) / v1.z).toBeCloseTo(before[0], 9);
    expect((my - v1.ty) / v1.z).toBeCloseTo(before[1], 9);
  });
});

describe('正视图标签大小', () => {
  it('宽画布不变，窄画布缩小但不小于 0.78', () => {
    expect(labelScale(1000)).toBe(1);
    expect(labelScale(504)).toBeCloseTo(0.9, 9);
    expect(labelScale(200)).toBe(0.78);
  });
});
