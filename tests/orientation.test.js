import { describe, it, expect } from 'vitest';
import { estimateYaw, yawFromPoints, foregroundPoints, expandPoly } from '../src/vision/orientation.js';

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
function render(shapes, rotDeg, { smear = null, extra = null } = {}) {
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
      // extra：另一个零件（底板坐标，不随 rotDeg 转）
      if (extra) {
        const X = (x + 0.5) / PPM;
        const Y = SIZE / PPM - (y + 0.5) / PPM;
        for (const [color, inside] of extra) if (inside(X, Y)) col = color;
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
// 躺平的 LED（与 parts.js 一致，本体居中）：本体 x ∈ [−4.25, 4.25]，灯头朝 +X，两根引脚从 −4.25 伸向 −X
const LED = [
  [[170, 174, 178], (x, y) => x >= -24.25 && x <= -4 && Math.abs(Math.abs(y) - 1.27) <= 0.3],
  [[200, 60, 60], (x, y) => x >= -4.25 && x <= 4.25 && Math.abs(y) <= 2.6],
];

/** 本体（局部 ±lx/2 × ±ly/2）转 rotDeg 后的轴对齐外接框（图像像素），即只框本体的检测框 */
function bodyBox(lx, ly, rotDeg) {
  const a = (rotDeg * Math.PI) / 180;
  const pts = [[-lx / 2, -ly / 2], [lx / 2, -ly / 2], [lx / 2, ly / 2], [-lx / 2, ly / 2]].map(([x, y]) => [
    50 + x * Math.cos(a) - y * Math.sin(a),
    50 + x * Math.sin(a) + y * Math.cos(a),
  ]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [[Math.min(...xs), Math.max(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.min(...xs), Math.min(...ys)]].map(toPx);
}

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

  it('躺平的 LED：检测框只框本体，外扩 10 mm 把引脚也算进来，得到主轴方向和灯头朝向（周期 360°）', () => {
    for (const rot of [0, 30, -70, 160, -120]) {
      const seed = bodyBox(8.5, 5.8, rot);
      const r = estimateYaw(render(LED, rot), expandPoly(seed, 10 * PPM), 1, toBoard, { seed });
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, rot, 360)).toBeLessThan(3);
    }
  });

  it('只看本体框（不外扩）时 LED 长宽比不够，判为不可靠', () => {
    const seed = bodyBox(8.5, 5.8, 30);
    const r = estimateYaw(render(LED, 30), seed, 1, toBoard, { seed });
    expect(r === null || r.reliable === false).toBe(true);
  });

  it('外扩区域里有别的零件（不相连）时不受影响', () => {
    // 旁边 8 mm 处有一团别的东西（Φ8 的圆）
    const cap = [[[60, 90, 160], (X, Y) => Math.hypot(X - 50, Y - 62) < 4]];
    for (const rot of [0, 30]) {
      const seed = bodyBox(8.5, 5.8, rot);
      const img = render(LED, rot, { extra: cap });
      const r = estimateYaw(img, expandPoly(seed, 10 * PPM), 1, toBoard, { seed });
      expect(angDiff(r.rotDeg, rot, 360)).toBeLessThan(3);
      // 不用 seed 时会被它带偏
      const bad = estimateYaw(img, expandPoly(seed, 10 * PPM), 1, toBoard);
      expect(angDiff(bad.rotDeg, rot, 360)).toBeGreaterThan(3);
    }
  });

  it('电阻：只框本体 + 外扩时同样准确', () => {
    for (const rot of [20, 80, -35]) {
      const seed = bodyBox(8, 3, rot);
      const r = estimateYaw(render(RESISTOR, rot), expandPoly(seed, 10 * PPM), 0, toBoard, { seed });
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, rot, 180)).toBeLessThan(2);
    }
  });

  it('正射图里零件沿视线被拉长 3 mm 时，电阻、LED 的角度误差仍小于 8°', () => {
    for (const rot of [20, -35, 100]) {
      const smear = [0, 3]; // 沿 +Y（远离手机）
      const r0 = estimateYaw(render(RESISTOR, rot, { smear }), region(), 0, toBoard);
      expect(angDiff(r0.rotDeg, rot, 180)).toBeLessThan(8);
      const seed = bodyBox(8.5, 5.8, rot);
      const r1 = estimateYaw(render(LED, rot, { smear }), expandPoly(seed, 10 * PPM), 1, toBoard, { seed });
      expect(angDiff(r1.rotDeg, rot, 360)).toBeLessThan(8);
    }
  });

  it('不认识的类别不估计；零件像素太少返回 null', () => {
    expect(estimateYaw(render(RESISTOR, 0), region(), 5, toBoard)).toBeNull();
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
