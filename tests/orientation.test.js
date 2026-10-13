import { describe, it, expect } from 'vitest';
import { estimateYaw, yawFromPoints, foregroundPoints } from '../src/vision/orientation.js';

// 400×400 像素的正射图 = 100×100 mm，4 px/mm，图像顶部是底板远端
const PPM = 4;
const SIZE = 400;
const toBoard = [[1 / PPM, 0, 0], [0, -1 / PPM, SIZE / PPM], [0, 0, 1]];
const toPx = ([X, Y]) => [X * PPM, (SIZE / PPM - Y) * PPM];

/**
 * 画一张纸面上的零件：shapes 为 [颜色, 判定函数(局部坐标 x, y)]，局部坐标绕 Z 转 deg 后平移到 (50, 50)
 * @param {[number[], (x:number, y:number) => boolean][]} shapes
 * @param {number} rotDeg
 * @param {{ smear?: number[] }} [opts] smear：再按这个位移叠画一次（模拟正射图里零件沿视线被拉长）
 */
function render(shapes, rotDeg, { smear = null } = {}) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      // 纸面带一点渐变
      let col = [236 - y / 40, 234, 228];
      for (const off of smear ? [[0, 0], smear] : [[0, 0]]) {
        const X = (x + 0.5) / PPM - 50 - off[0];
        const Y = SIZE / PPM - (y + 0.5) / PPM - 50 - off[1];
        const lx = c * X + s * Y;
        const ly = -s * X + c * Y;
        for (const [color, inside] of shapes) if (inside(lx, ly)) col = color;
      }
      data.set([...col, 255], o);
    }
  }
  return { width: SIZE, height: SIZE, data };
}

const rect = (x0, x1, w) => (x, y) => x >= x0 && x <= x1 && Math.abs(y) <= w / 2;
const RESISTOR = [
  [[160, 164, 168], rect(-11, 11, 0.6)],
  [[200, 161, 101], rect(-4, 4, 3)],
];
const SCREW = [
  [[140, 145, 150], rect(-4.75, 7.25, 2.5)],
  [[140, 145, 150], rect(-7.25, -4.75, 4)],
];
// 躺平的 LED（与 parts.js 一致，包围盒居中）：灯体在 +X，两根引脚伸向 −X
const LED = [
  [[170, 174, 178], (x, y) => x >= -14.25 && x <= 6 && Math.abs(Math.abs(y) - 1.27) <= 0.3],
  [[200, 60, 60], (x, y) => x >= 5.75 && x <= 14.25 && Math.abs(y) <= 2.6],
];

/** 零件周围 30×30 mm 的区域（图像像素） */
const region = () => [[50 - 15, 50 + 15], [50 + 15, 50 + 15], [50 + 15, 50 - 15], [50 - 15, 50 - 15]].map(toPx);

/** 角度差（按周期） */
const angDiff = (a, b, period) => {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
};

describe('零件朝向估计', () => {
  it('电阻：主轴方向（周期 180°）', () => {
    for (const rot of [0, 20, 45, 80, 100, -35, 135]) {
      const r = estimateYaw(render(RESISTOR, rot), region(), 0, toBoard);
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, rot, 180)).toBeLessThan(2);
    }
  });

  it('螺丝：主轴方向 + 螺帽在哪头（周期 360°）', () => {
    for (const rot of [0, 20, -35, 100, 170, -120]) {
      const r = estimateYaw(render(SCREW, rot), region(), 3, toBoard);
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, rot, 360)).toBeLessThan(3);
    }
  });

  it('躺平的 LED：主轴方向 + 灯体在哪头（周期 360°）', () => {
    for (const rot of [0, 30, -70, 160, -120]) {
      const r = estimateYaw(render(LED, rot), region(), 2, toBoard);
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, rot, 360)).toBeLessThan(3);
    }
  });

  it('正射图里零件沿视线被拉长 3 mm 时，电阻、螺丝的角度误差仍小于 8°', () => {
    for (const rot of [20, -35, 100]) {
      const smear = [0, 3]; // 沿 +Y（远离手机）
      const r0 = estimateYaw(render(RESISTOR, rot, { smear }), region(), 0, toBoard);
      expect(angDiff(r0.rotDeg, rot, 180)).toBeLessThan(8);
      const r3 = estimateYaw(render(SCREW, rot, { smear }), region(), 3, toBoard);
      expect(angDiff(r3.rotDeg, rot, 360)).toBeLessThan(8);
    }
  });

  it('圆形零件不估计；零件像素太少返回 null', () => {
    expect(estimateYaw(render(RESISTOR, 0), region(), 1, toBoard)).toBeNull();
    expect(yawFromPoints([[0, 0], [1, 1]], 0)).toBeNull();
  });

  it('近似圆形的一团像素：电阻判为不可靠', () => {
    const blob = [[[90, 90, 90], (x, y) => Math.hypot(x, y) < 3]];
    expect(estimateYaw(render(blob, 0), region(), 0, toBoard).reliable).toBe(false);
  });

  it('照片外（透明）的像素不参与', () => {
    const img = render(RESISTOR, 30);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
    expect(foregroundPoints(img, region(), toBoard).pts).toHaveLength(0);
  });
});
