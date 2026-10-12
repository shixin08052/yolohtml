import { describe, it, expect } from 'vitest';
import { checkBoardPhoto, measurePaper } from '../src/vision/boardCheck.js';
import { markerCornersWorld } from '../src/vision/boardLayout.js';
import { applyH, invert3 } from '../src/vision/homography.js';

// 拍照：底板 mm → 像素（带透视），约 3.5 px/mm，整张纸落在 1300×1000 的图里
const Hcam = [
  [3.6, 0.35, 120],
  [0.15, -3.4, 850],
  [0.0002, 0.0006, 1],
];

/** 按"实际打印出来的版面"生成识别结果：transform 把设计坐标变成实际坐标 */
function photo(ids, transform = (p) => p) {
  return ids.map((id) => ({ id, corners: markerCornersWorld(id).map((p) => applyH(Hcam, transform(p))) }));
}

/**
 * 合成照片：深色桌面上一张白纸。
 * 纸张在"设计底板坐标"里的范围为 [x0, x1] × [y0, y1]（100% 打印时为 0..297 × 0..210）
 */
function rasterPaper([x0, x1, y0, y1], W = 1300, Hpx = 1000) {
  const Hinv = invert3(Hcam);
  const data = new Uint8ClampedArray(W * Hpx * 4);
  for (let v = 0; v < Hpx; v++) {
    for (let u = 0; u < W; u++) {
      const [X, Y] = applyH(Hinv, [u + 0.5, v + 0.5]);
      const inPaper = X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
      const g = inPaper ? 235 : 70;
      const p = (v * W + u) * 4;
      data[p] = data[p + 1] = data[p + 2] = g;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: Hpx, data };
}

/** 内容按比例 k 绕纸中心缩小打印时，纸在设计坐标里的范围 */
function paperForScale(kx, ky = kx) {
  const cx = 148.5;
  const cy = 105;
  return [cx - 148.5 / kx, cx + 148.5 / kx, cy - 105 / ky, cy + 105 / ky];
}

describe('打印检查：码的版面', () => {
  it('版面正确：4 个码全部识别，偏差 ≈ 0，边长 40 mm', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3]));
    expect(r.level).toBe('ok');
    expect(r.missing).toEqual([]);
    expect(r.maxErrMm).toBeLessThan(1e-6);
    for (const p of r.perMarker) expect(p.sideMm).toBeCloseTo(40, 6);
  });

  it('整页缩放（含横竖不等）会被 H 吸收，单看码判断不出来', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3], ([x, y]) => [x, 105 + 0.94 * (y - 105)]));
    expect(r.maxErrMm).toBeLessThan(1e-6);
  });

  it('某个码印大了：判为不正确', () => {
    const markers = photo([0, 1, 2, 3]);
    const c = [265, 178];
    markers[2].corners = markerCornersWorld(2).map(([x, y]) => applyH(Hcam, [c[0] + 1.2 * (x - c[0]), c[1] + 1.2 * (y - c[1])]));
    expect(checkBoardPhoto(markers).level).not.toBe('ok');
  });

  it('两个码位置互换：判为 bad', () => {
    const markers = photo([0, 1, 2, 3]);
    [markers[1].corners, markers[2].corners] = [markers[2].corners, markers[1].corners];
    expect(checkBoardPhoto(markers).level).toBe('bad');
  });

  it('缺码时列出缺少的 ID，并降为 warn', () => {
    const r = checkBoardPhoto(photo([0, 2, 3]));
    expect(r.missing).toEqual([1]);
    expect(r.level).toBe('warn');
  });

  it('只有 1 个码或没有码：bad', () => {
    expect(checkBoardPhoto(photo([3])).level).toBe('bad');
    expect(checkBoardPhoto([]).level).toBe('bad');
  });
});

describe('打印检查：纸边与打印比例', () => {
  it('100% 打印：纸宽 297、高 210，比例 100%', () => {
    const m = measurePaper(rasterPaper(paperForScale(1)), Hcam);
    expect(Math.abs(m.widthMm - 297)).toBeLessThan(1);
    expect(Math.abs(m.heightMm - 210)).toBeLessThan(1);
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), rasterPaper(paperForScale(1)));
    expect(r.level).toBe('ok');
  });

  it('"适合页面"打印成 97%：测出约 97%，判为 bad', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), rasterPaper(paperForScale(0.97)));
    expect(r.paper.scaleX).toBeCloseTo(0.97, 2);
    expect(r.paper.scaleY).toBeCloseTo(0.97, 2);
    expect(r.level).toBe('bad');
  });

  it('横竖比例不一致（100% × 95%）也能测出', () => {
    const m = measurePaper(rasterPaper(paperForScale(1, 0.95)), Hcam);
    expect(m.scaleX).toBeCloseTo(1, 2);
    expect(m.scaleY).toBeCloseTo(0.95, 2);
  });

  it('打印内容整体平移 3 mm 不影响比例', () => {
    const [x0, x1, y0, y1] = paperForScale(1);
    const m = measurePaper(rasterPaper([x0 + 3, x1 + 3, y0 - 2, y1 - 2]), Hcam);
    expect(m.scaleX).toBeCloseTo(1, 2);
    expect(m.scaleY).toBeCloseTo(1, 2);
    expect(m.edges.left).toBeCloseTo(-3, 0);
  });

  it('纸和桌面颜色相同时测不出纸边，提示而不误判', () => {
    const blank = rasterPaper([-1000, 1000, -1000, 1000]);
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), blank);
    expect(r.paper.widthMm).toBeNull();
    expect(r.level).toBe('warn');
  });
});
