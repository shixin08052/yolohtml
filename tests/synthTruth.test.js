import { describe, it, expect } from 'vitest';
import layout from '../src/synth/layout.json';
import { SYNTH_PRESETS } from '../src/synth/presets.js';
import { makeGroundTruth, synthIntrinsics, partBoxCorners } from '../src/synth/truth.js';
import { BOARD, MARKERS, WORK_AREA } from '../src/config.js';
import { applyH, solveHomography } from '../src/vision/homography.js';
import { markerCornersWorld } from '../src/vision/boardLayout.js';
import { intrinsicsMatrix, project } from '../src/math/pinhole.js';

describe('合成图布局', () => {
  it('8–10 个零件，全部在工作区内且不压到码', () => {
    expect(layout.parts.length).toBeGreaterThanOrEqual(8);
    expect(layout.parts.length).toBeLessThanOrEqual(10);
    const m = WORK_AREA.margin;
    const pad = WORK_AREA.markerPadding;
    for (const p of layout.parts) {
      for (const [X, Y] of partBoxCorners(p)) {
        expect(X).toBeGreaterThanOrEqual(m);
        expect(X).toBeLessThanOrEqual(BOARD.width - m);
        expect(Y).toBeGreaterThanOrEqual(m);
        expect(Y).toBeLessThanOrEqual(BOARD.height - m);
        for (const [cx, cy] of Object.values(MARKERS.centers)) {
          const h = MARKERS.size / 2 + pad;
          expect(Math.abs(X - cx) <= h && Math.abs(Y - cy) <= h).toBe(false);
        }
      }
    }
  });
});

describe('合成图真值', () => {
  it('内参：fx = fy ≈ 3028，主点在图像中心', () => {
    const k = synthIntrinsics();
    expect(Math.abs(k.fx - 3028)).toBeLessThan(1);
    expect(k.fy).toBe(k.fx);
    expect([k.cx, k.cy, k.width, k.height]).toEqual([2016, 1512, 4032, 3024]);
    expect(k.source).toBe('truth');
  });

  for (const preset of SYNTH_PRESETS) {
    describe(preset.label, () => {
      const gt = makeGroundTruth(preset, layout.parts);

      it('俯角与预设一致，手机离底板中心 300 mm', () => {
        expect(gt.pitchDeg).toBeCloseTo(preset.pitchDeg, 9);
        const d = Math.hypot(gt.position[0] - BOARD.width / 2, gt.position[1] - BOARD.height / 2, gt.position[2]);
        expect(d).toBeCloseTo(300, 9);
      });

      it('所有码角点和零件框都在图像内（留 50 像素边）', () => {
        const inside = ([u, v]) => u > 50 && v > 50 && u < 4032 - 50 && v < 3024 - 50;
        for (const m of gt.markers) for (const c of m.corners) expect(inside(c)).toBe(true);
        for (const p of gt.parts) {
          expect(inside([p.box[0], p.box[1]])).toBe(true);
          expect(inside([p.box[2], p.box[3]])).toBe(true);
        }
      });

      it('码角点顺序：码自身左上、右上、右下、左下在图像中顺时针排列', () => {
        for (const m of gt.markers) {
          const c = m.corners;
          const cross = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[1][1] - c[0][1]) * (c[2][0] - c[0][0]);
          expect(cross).toBeGreaterThan(0); // y 向下时 > 0 即顺时针
        }
      });

      it('零件框包含零件底面中心与顶面中心的投影', () => {
        const K = intrinsicsMatrix(gt.intrinsics);
        for (const p of gt.parts) {
          for (const z of [0, p.heightMm]) {
            const [u, v] = project(K, gt.R, gt.t, [p.x, p.y, z]);
            expect(u).toBeGreaterThan(p.box[0]);
            expect(u).toBeLessThan(p.box[2]);
            expect(v).toBeGreaterThan(p.box[1]);
            expect(v).toBeLessThan(p.box[3]);
          }
        }
      });

      it('由真值角点求出的单应性能把底板点准确映射到像素', () => {
        const world = gt.markers.flatMap((m) => markerCornersWorld(m.id));
        const img = gt.markers.flatMap((m) => m.corners);
        const H = solveHomography(world, img);
        const K = intrinsicsMatrix(gt.intrinsics);
        const [u, v] = project(K, gt.R, gt.t, [148.5, 105, 0]);
        const q = applyH(H, [148.5, 105]);
        expect(Math.hypot(q[0] - u, q[1] - v)).toBeLessThan(1e-6);
      });
    });
  }
});
