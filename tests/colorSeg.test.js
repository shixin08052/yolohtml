import { describe, it, expect } from 'vitest';
import { rgbToHsv, closeMask, segmentParts, fuseDetections } from '../src/vision/colorSeg.js';
import { BOARD } from '../src/config.js';

// 合成一张"俯拍"的板子：4 px/mm，图像 y 向下，底板 Y 向上；Hinv：像素 → 底板 mm
const PPM = 4;
const W = BOARD.width * PPM;
const H = BOARD.height * PPM;
const Hinv = [[1 / PPM, 0, 0], [0, -1 / PPM, BOARD.height], [0, 0, 1]];
const toPx = (X, Y) => [X * PPM, (BOARD.height - Y) * PPM];

function board(rects) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([236, 234, 228, 255], i * 4); // 白纸
  for (const { X0, Y0, X1, Y1, rgb } of rects) {
    const [a, b] = toPx(X0, Y1);
    const [c, d] = toPx(X1, Y0);
    for (let y = Math.round(b); y < Math.round(d); y++) for (let x = Math.round(a); x < Math.round(c); x++) data.set([...rgb, 255], (y * W + x) * 4);
  }
  return { width: W, height: H, data };
}
const RED = [200, 30, 35];
const BLUE = [40, 90, 200];
const GREY = [170, 172, 176]; // 引脚：饱和度低

describe('颜色分割', () => {
  it('HSV 与 OpenCV 约定一致（H 0–180）', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 255, 255]);
    expect(rgbToHsv(0, 0, 255)[0]).toBeCloseTo(120, 6);
    expect(rgbToHsv(0, 255, 0)[0]).toBeCloseTo(60, 6);
    expect(rgbToHsv(128, 128, 128)[1]).toBe(0);
  });

  it('闭运算把间隔很小的两块连起来', () => {
    const w = 10;
    const m = new Uint8Array(w);
    m[2] = 1;
    m[4] = 1;
    const c = closeMask(m, w, 1, 1);
    expect([...c.slice(2, 5)]).toEqual([1, 1, 1]);
    expect(c[0]).toBe(0);
  });

  it('找到红色 LED 和蓝色电阻本体（框只包住本体，不含灰色引脚），码区和板边外的不算，太小的斑点不算', () => {
    const img = board([
      { X0: 100, Y0: 100, X1: 108.5, Y1: 105.8, rgb: RED }, // LED 本体
      { X0: 80, Y0: 103, X1: 100, Y1: 103.5, rgb: GREY }, // LED 引脚
      { X0: 180, Y0: 60, X1: 188, Y1: 63, rgb: BLUE }, // 电阻本体（带一道色环缝隙）
      { X0: 183, Y0: 60, X1: 183.5, Y1: 63, rgb: [236, 234, 228] },
      { X0: 25, Y0: 25, X1: 35, Y1: 35, rgb: RED }, // 码 0 的区域里
      { X0: 2, Y0: 100, X1: 8, Y1: 106, rgb: BLUE }, // 板边 12 mm 以内
      { X0: 150, Y0: 150, X1: 150.5, Y1: 150.5, rgb: RED }, // 斑点
    ]);
    const parts = segmentParts(img, Hinv, PPM);
    expect(parts).toHaveLength(2);
    const led = parts.find((p) => p.cls === 2);
    const res = parts.find((p) => p.cls === 0);
    expect(led.box).toEqual([...toPx(100, 105.8), ...toPx(108.5, 100)].map(Math.round));
    // 色环缝隙被闭运算连起来，电阻只有一个框
    expect(res.box).toEqual([...toPx(180, 63), ...toPx(188, 60)].map(Math.round));
  });
});

describe('YOLO 与颜色分割合并', () => {
  const yolo = [
    { cls: 2, name: 'LED', score: 0.95, box: [100, 100, 140, 130] },
    { cls: 0, name: '色环电阻', score: 0.9, box: [300, 100, 340, 115] },
  ];
  it('YOLO 框过的零件不重复加（颜色框偏大也算覆盖）；YOLO 漏掉的补上，标为 color', () => {
    const color = [
      { cls: 2, box: [95, 96, 150, 136] }, // 同一个 LED，颜色框偏大
      { cls: 0, box: [302, 101, 338, 114] }, // 同一个电阻
      { cls: 0, box: [500, 200, 540, 214] }, // YOLO 漏掉的电阻
    ];
    const { dets, added } = fuseDetections(yolo, color, { names: (c) => (c === 0 ? '色环电阻' : 'LED') });
    expect(added).toBe(1);
    expect(dets).toHaveLength(3);
    expect(dets[0]).toMatchObject({ origin: 'yolo', box: yolo[0].box });
    expect(dets[2]).toMatchObject({ cls: 0, origin: 'color', box: [500, 200, 540, 214], name: '色环电阻' });
  });

  it('类别不同但位置重叠时以 YOLO 为准，不补', () => {
    const { added } = fuseDetections(yolo, [{ cls: 0, box: [105, 102, 138, 128] }]);
    expect(added).toBe(0);
  });

  it('没有 YOLO 结果时颜色候选全部补上', () => {
    const { dets, added } = fuseDetections([], [{ cls: 2, box: [0, 0, 10, 10] }, { cls: 0, box: [20, 0, 30, 10] }]);
    expect(added).toBe(2);
    expect(dets.every((d) => d.origin === 'color')).toBe(true);
  });
});
