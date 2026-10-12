import { describe, it, expect } from 'vitest';
import { markerCornerErrors } from '../src/vision/evaluate.js';

const sq = (id, x, y, s = 10) => ({ id, corners: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] });

describe('码角点误差', () => {
  it('按 ID 配对，计算平均与最大误差，列出缺少的 ID', () => {
    const truth = [sq(0, 0, 0), sq(1, 100, 0), sq(2, 100, 100)];
    const found = [sq(1, 103, 4), sq(0, 0, 0)];
    const r = markerCornerErrors(found, truth);
    expect(r.missing).toEqual([2]);
    expect(r.perId.find((p) => p.id === 0).max).toBe(0);
    expect(r.perId.find((p) => p.id === 1).mean).toBeCloseTo(5, 12);
    expect(r.mean).toBeCloseTo(2.5, 12);
    expect(r.max).toBeCloseTo(5, 12);
  });

  it('一个都没找到', () => {
    const r = markerCornerErrors([], [sq(0, 0, 0)]);
    expect(r.mean).toBeNull();
    expect(r.missing).toEqual([0]);
  });
});

describe('单应性与真值的误差', async () => {
  const { homographyTruthError } = await import('../src/vision/evaluate.js');
  const { makeGroundTruth } = await import('../src/synth/truth.js');
  const { SYNTH_PRESETS } = await import('../src/synth/presets.js');
  const layout = (await import('../src/synth/layout.json')).default;
  const { solveHomography } = await import('../src/vision/homography.js');
  const { markerCornersWorld } = await import('../src/vision/boardLayout.js');

  it('由真值角点求出的 H 与真值位姿一致（误差 ≈ 0）', () => {
    const gt = makeGroundTruth(SYNTH_PRESETS[2], layout.parts);
    const H = solveHomography(gt.markers.flatMap((m) => markerCornersWorld(m.id)), gt.markers.flatMap((m) => m.corners));
    const e = homographyTruthError(H, gt, { boardW: 297, boardH: 210 });
    expect(e.max).toBeLessThan(1e-6);
  });

  it('H 偏了能测出来', () => {
    const gt = makeGroundTruth(SYNTH_PRESETS[0], layout.parts);
    const H = solveHomography(gt.markers.flatMap((m) => markerCornersWorld(m.id)), gt.markers.flatMap((m) => m.corners.map(([u, v]) => [u + 2, v])));
    const e = homographyTruthError(H, gt, { boardW: 297, boardH: 210 });
    expect(e.mean).toBeCloseTo(2, 1);
  });
});
