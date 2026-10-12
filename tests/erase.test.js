import { describe, it, expect } from 'vitest';
import { boxToTexture, signedDistance, erasePolygons } from '../src/vision/erase.js';

describe('signedDistance', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  it('内部为正、外部为负，与顶点顺序无关', () => {
    for (const poly of [sq, [...sq].reverse()]) {
      expect(signedDistance(poly, 5, 5)).toBeCloseTo(5, 9);
      expect(signedDistance(poly, 2, 5)).toBeCloseTo(2, 9);
      expect(signedDistance(poly, 15, 5)).toBeCloseTo(-5, 9);
      expect(signedDistance(poly, 5, -3)).toBeCloseTo(-3, 9);
    }
  });
});

describe('boxToTexture', () => {
  it('像素 → 纸张局部坐标 → 贴图像素（贴图顶部 = 纸张远端），框按比例外扩', () => {
    // 假设原图 1 像素 = 0.5 mm，原图 y 向下、纸张 v 向上：v = 100 − y/2
    const toLocal = [[0.5, 0, 0], [0, -0.5, 100], [0, 0, 1]];
    const poly = boxToTexture([100, 40, 140, 80], toLocal, { pxPerMm: 4, paperH: 100 }, 0);
    // 外扩 0 时仍至少外扩 3 像素
    expect(poly[0][0]).toBeCloseTo((97 * 0.5) * 4, 9);
    expect(poly[0][1]).toBeCloseTo((100 - (100 - 37 * 0.5)) * 4, 9);
    expect(poly[2][0]).toBeCloseTo((143 * 0.5) * 4, 9);
    expect(poly[2][1]).toBeCloseTo((83 * 0.5) * 4, 9);
  });
});

describe('erasePolygons', () => {
  /** 100×80 的图：红通道随 x 渐变、绿通道随 y 渐变；中间有一块深色"零件" */
  function makeImage() {
    const W = 100;
    const H = 80;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const blob = x >= 40 && x < 60 && y >= 30 && y < 50;
        data[o] = blob ? 20 : 100 + x;
        data[o + 1] = blob ? 20 : 100 + y;
        data[o + 2] = blob ? 20 : 200;
        data[o + 3] = 255;
      }
    }
    return { width: W, height: H, data };
  }
  const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

  it('区域内换成周围纸面的颜色（跟得上渐变），区域外不变', () => {
    const img = makeImage();
    const before = makeImage();
    const n = erasePolygons(img, [[[38, 28], [62, 28], [62, 52], [38, 52]]], { featherPx: 3, ringPx: 4 });
    expect(n).toBe(1);
    // 原来的深色块：接近该处背景应有的渐变颜色
    for (const [x, y] of [[45, 35], [50, 40], [55, 45]]) {
      const [r, g, b] = px(img, x, y);
      expect(Math.abs(r - (100 + x))).toBeLessThan(4);
      expect(Math.abs(g - (100 + y))).toBeLessThan(4);
      expect(Math.abs(b - 200)).toBeLessThan(1);
    }
    // 羽化范围外完全不变
    for (const [x, y] of [[10, 10], [80, 70], [33, 40], [67, 40]]) expect(px(img, x, y)).toEqual(px(before, x, y));
  });

  it('透明像素（照片外）不参与取色、也不被改写；全透明时跳过', () => {
    const img = makeImage();
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
    expect(erasePolygons(img, [[[38, 28], [62, 28], [62, 52], [38, 52]]])).toBe(0);
    expect(px(img, 50, 40)).toEqual([20, 20, 20]);
  });

  it('区域超出图像边界时只处理图内部分', () => {
    const img = makeImage();
    expect(erasePolygons(img, [[[-10, -10], [20, -10], [20, 20], [-10, 20]]])).toBe(1);
  });
});
