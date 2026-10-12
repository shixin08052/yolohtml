import { describe, it, expect } from 'vitest';
import { detectMarkers, markerBits, markerSVG, svgScale, getDictionary } from '../src/vision/aruco.js';
import { rasterMarkers } from './helpers/rasterMarkers.js';

const maxCornerErr = (found, truth) =>
  Math.max(...found.corners.map((c, i) => Math.hypot(c[0] - truth.corners[i][0], c[1] - truth.corners[i][1])));

describe('ArUco 字典', () => {
  it('4×4 字典，码本体 6×6', () => {
    const d = getDictionary();
    expect(d.nBits).toBe(16);
    expect(d.markSize).toBe(6);
    expect(svgScale()).toBeCloseTo(8 / 6, 12);
  });

  it('ID 0–3 与 OpenCV DICT_4X4_50 的比特一致', () => {
    // 由 opencv-python 5.0 的 generateImageMarker 读出（行优先，1 = 白）
    const opencv = ['1011010100110010', '0000111110011010', '0011001100101101', '1001100101000110'];
    for (let id = 0; id < 4; id++) expect(markerBits(id).flat().join('')).toBe(opencv[id]);
  });

  it('generateSVG 输出 8×8 viewBox，白格数与比特一致', () => {
    for (let id = 0; id < 4; id++) {
      const svg = markerSVG(id);
      expect(svg).toContain('viewBox="0 0 8 8"');
      const whiteCells = (svg.match(/width="1" height="1" fill="white"/g) ?? []).length;
      expect(whiteCells).toBe(markerBits(id).flat().filter((b) => b === 1).length);
    }
  });
});

describe('detectMarkers', () => {
  it('任意旋转下 ID 正确，角点顺序为码自身左上、右上、右下、左下', () => {
    for (let id = 0; id < 4; id++) {
      for (let rot = 0; rot < 4; rot++) {
        const { image, truth } = rasterMarkers(400, 400, [{ id, x: 100, y: 100, mod: 30, rot }]);
        const found = detectMarkers(image);
        expect(found.map((m) => m.id)).toEqual([id]);
        expect(maxCornerErr(found[0], truth[0])).toBeLessThan(2);
      }
    }
  });

  it('一张图里的 4 个码都能识别，并按 ID 排序', () => {
    const { image, truth } = rasterMarkers(900, 600, [
      { id: 2, x: 650, y: 60, mod: 25 },
      { id: 0, x: 60, y: 380, mod: 25 },
      { id: 3, x: 60, y: 60, mod: 25, rot: 1 },
      { id: 1, x: 650, y: 380, mod: 25, rot: 2 },
    ]);
    const found = detectMarkers(image);
    expect(found.map((m) => m.id)).toEqual([0, 1, 2, 3]);
    for (const m of found) expect(maxCornerErr(m, truth.find((t) => t.id === m.id))).toBeLessThan(2);
  });

  it('只保留 ID 0–3；同一 ID 出现多次时保留面积最大的', () => {
    const { image, truth } = rasterMarkers(900, 500, [
      { id: 7, x: 40, y: 40, mod: 20 },
      { id: 1, x: 300, y: 40, mod: 15 },
      { id: 1, x: 500, y: 40, mod: 40 },
    ]);
    const found = detectMarkers(image);
    expect(found.map((m) => m.id)).toEqual([1]);
    expect(maxCornerErr(found[0], truth[2])).toBeLessThan(2);
  });
});

describe('角点精修', async () => {
  const { refineCorners } = await import('../src/vision/aruco.js');

  it('干净的码：任意旋转下角点误差 < 0.3 像素', () => {
    for (let rot = 0; rot < 4; rot++) {
      const { image, truth } = rasterMarkers(400, 400, [{ id: 2, x: 100, y: 100, mod: 30, rot }]);
      const [m] = detectMarkers(image);
      expect(maxCornerErr(m, truth[0])).toBeLessThan(0.3);
    }
  });

  it('初始角点偏了 15 像素，精修后回到真值附近', async () => {
    const { image, truth } = rasterMarkers(400, 400, [{ id: 1, x: 100, y: 100, mod: 30 }]);
    const grey = { width: 400, height: 400, data: Uint8Array.from({ length: 400 * 400 }, (_, i) => image.data[i * 4]) };
    const bad = truth[0].corners.map((c, i) => (i === 2 ? [c[0] + 12, c[1] - 9] : c));
    const out = refineCorners(grey, refineCorners(grey, bad));
    expect(maxCornerErr({ corners: out }, truth[0])).toBeLessThan(0.5);
  });
});

describe('打印质量差（黑色发灰、白色斑点、轻微模糊）', async () => {
  const { degradePrint } = await import('./helpers/degrade.js');
  const items = [
    { id: 3, x: 60, y: 60, mod: 30 },
    { id: 2, x: 700, y: 60, mod: 30, rot: 1 },
    { id: 0, x: 60, y: 420, mod: 30, rot: 3 },
    { id: 1, x: 700, y: 420, mod: 30, rot: 2 },
  ];
  const cases = [
    { density: 0.02, speck: 2, seed: 1 },
    { density: 0.02, speck: 2, seed: 2 },
    { density: 0.04, speck: 2, seed: 3 },
  ];

  it('只用 js-aruco2 默认阈值窗口时会漏码（说明测试图确实有难度）', () => {
    for (const c of cases) {
      const { image } = rasterMarkers(1000, 700, items);
      degradePrint(image, c);
      expect(detectMarkers(image, { passes: [{ kernel: 2 }], refine: false }).length).toBeLessThan(4);
    }
  });

  it('多轮识别 + 精修：4 个码都识别到，角点误差 < 2 像素', () => {
    for (const c of cases) {
      const { image, truth } = rasterMarkers(1000, 700, items);
      degradePrint(image, c);
      const found = detectMarkers(image);
      expect(found.map((m) => m.id)).toEqual([0, 1, 2, 3]);
      for (const m of found) expect(maxCornerErr(m, truth.find((t) => t.id === m.id))).toBeLessThan(2);
    }
  });
});
