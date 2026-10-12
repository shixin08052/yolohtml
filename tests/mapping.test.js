import { describe, it, expect } from 'vitest';
import { boxCenter, mapToPlane, mapWithParallax, inWorkArea, boxYawDeg, mapDetections, selectMethod } from '../src/vision/mapping.js';
import { partsTruthError } from '../src/vision/evaluate.js';
import { intrinsicsMatrix, lookAtPose, project, cameraCenter } from '../src/math/pinhole.js';
import { mul3 } from '../src/math/linalg.js';
import { invert3 } from '../src/vision/homography.js';
import { makeGroundTruth } from '../src/synth/truth.js';
import { SYNTH_PRESETS } from '../src/synth/presets.js';
import { BOARD, CLASSES, MARKERS, WORK_AREA } from '../src/config.js';
import layout from '../src/synth/layout.json';

const K = intrinsicsMatrix({ fx: 3028.4, fy: 3028.4, cx: 2016, cy: 1512 });

/** 由位姿得到 H = K·[r1 r2 t] 与 Hinv */
function camFromPose({ R, t }) {
  const H = mul3(K, [
    [R[0][0], R[0][1], t[0]],
    [R[1][0], R[1][1], t[1]],
    [R[2][0], R[2][1], t[2]],
  ]);
  return { K, R, position: cameraCenter(R, t), Hinv: invert3(H) };
}

describe('mapToPlane / mapWithParallax', () => {
  const pose = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg: 45, yawDeg: -8, rollDeg: 2 });
  const cam = camFromPose(pose);

  it('板面上的点：两种方法（z0 = 0）都能还原', () => {
    for (const P of [[40, 60, 0], [150, 100, 0], [260, 170, 0]]) {
      const [u, v] = project(K, pose.R, pose.t, P);
      const a = mapToPlane(cam.Hinv, [u, v]);
      const b = mapWithParallax(K, pose.R, cam.position, [u, v], 0);
      expect(Math.hypot(a[0] - P[0], a[1] - P[1])).toBeLessThan(1e-6);
      expect(Math.hypot(b[0] - P[0], b[1] - P[1])).toBeLessThan(1e-6);
    }
  });

  it('已知位姿和零件：用纯数学投影零件半高处的中心作为框中心，方法 2 还原误差 < 0.5 mm', () => {
    for (const preset of SYNTH_PRESETS) {
      const p = lookAtPose({ target: [148.5, 105, 0], ...preset });
      const c = camFromPose(p);
      for (const cls of CLASSES) {
        for (const [x, y] of [[60, 100], [150, 60], [240, 150]]) {
          const uv = project(K, p.R, p.t, [x, y, cls.heightMm / 2]);
          const P = mapWithParallax(K, p.R, c.position, [uv[0], uv[1]], cls.heightMm / 2);
          expect(Math.hypot(P[0] - x, P[1] - y)).toBeLessThan(0.5);
          expect(P[2]).toBeCloseTo(cls.heightMm / 2, 9);
        }
      }
    }
  });

  it('两种方法的结果在同一条视线上：方法 1 落点 = 视线与 Z = 0 的交点', () => {
    const uv = project(K, pose.R, pose.t, [150, 100, 6]);
    const plane = mapToPlane(cam.Hinv, [uv[0], uv[1]]);
    const z0 = mapWithParallax(K, pose.R, cam.position, [uv[0], uv[1]], 0);
    expect(Math.hypot(plane[0] - z0[0], plane[1] - z0[1])).toBeLessThan(1e-6);
    // 斜拍时不修正的落点在零件后方（远离手机）
    const C = cam.position;
    const dPlane = Math.hypot(plane[0] - C[0], plane[1] - C[1]);
    expect(dPlane).toBeGreaterThan(Math.hypot(150 - C[0], 100 - C[1]));
  });

  it('视线不朝下时返回 null', () => {
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // 相机 z 轴朝 +Z（朝上看）
    expect(mapWithParallax(K, R, [0, 0, 100], [2016, 1512], 0)).toBeNull();
  });
});

describe('inWorkArea', () => {
  const m = WORK_AREA.margin;
  const half = MARKERS.size / 2 + WORK_AREA.markerPadding;
  it('底板内缩 margin', () => {
    expect(inWorkArea(BOARD.width / 2, BOARD.height / 2)).toBe(true);
    expect(inWorkArea(m - 0.1, 105)).toBe(false);
    expect(inWorkArea(m + 0.1, 105)).toBe(true);
    expect(inWorkArea(150, BOARD.height - m + 0.1)).toBe(false);
  });
  it('挖掉 4 个码（各外扩 markerPadding）', () => {
    for (const [cx, cy] of Object.values(MARKERS.centers)) {
      expect(inWorkArea(cx, cy)).toBe(false);
      const dx = cx < BOARD.width / 2 ? 1 : -1;
      expect(inWorkArea(cx + dx * (half - 0.1), cy)).toBe(false);
      expect(inWorkArea(cx + dx * (half + 0.1), cy)).toBe(true);
    }
  });
});

describe('boxCenter / boxYawDeg', () => {
  it('框中心', () => expect(boxCenter([10, 20, 30, 60])).toEqual([20, 40]));
  it('正上方拍摄：横框 0°，竖框（沿底板 Y）90°', () => {
    const p = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg: 90 });
    const { Hinv } = camFromPose(p);
    const proj = (X, Y) => project(K, p.R, p.t, [X, Y, 0]);
    const box = (pts) => {
      const us = pts.map((q) => q[0]);
      const vs = pts.map((q) => q[1]);
      return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
    };
    expect(boxYawDeg(Hinv, box([proj(100, 100), proj(122, 103)]))).toBe(0);
    expect(boxYawDeg(Hinv, box([proj(100, 100), proj(103, 122)]))).toBe(90);
  });
});

describe('mapDetections：合成图真值框', () => {
  const results = {};
  for (const preset of SYNTH_PRESETS) {
    const truth = makeGroundTruth(preset, layout.parts);
    const cam = camFromPose(truth);
    const dets = truth.parts.map((p) => ({ cls: p.cls, name: CLASSES[p.cls].name, score: 1, box: p.box }));
    const { parts, dropped } = mapDetections(dets, cam);
    results[preset.key] = { parts, dropped, err: partsTruthError(parts, truth) };
  }

  it('所有零件都在工作区内、都能和真值配对', () => {
    for (const r of Object.values(results)) {
      expect(r.dropped).toHaveLength(0);
      expect(r.err.matched).toBe(layout.parts.length);
      expect(r.err.missedTruth).toBe(0);
    }
  });

  it('45°：方法 2 平均误差 < 3 mm，且明显小于方法 1', () => {
    const { err } = results.synth_45;
    expect(err.parallax.mean).toBeLessThan(3);
    expect(err.parallax.mean).toBeLessThan(err.plane.mean * 0.5);
  });

  it('90°：两种方法的误差都很小', () => {
    const { err } = results.synth_90;
    expect(err.parallax.max).toBeLessThan(1);
    expect(err.plane.max).toBeLessThan(3);
  });

  it('x, y 随方法切换；selectMethod 只换 x, y', () => {
    const { parts } = results.synth_45;
    const plane = selectMethod(parts, false);
    plane.forEach((p, i) => {
      expect([p.x, p.y]).toEqual([parts[i].xPlane, parts[i].yPlane]);
      expect(p.xParallax).toBe(parts[i].xParallax);
    });
    const back = selectMethod(plane, true);
    back.forEach((p, i) => expect([p.x, p.y]).toEqual([parts[i].x, parts[i].y]));
  });

  it('工作区外的检测被丢弃，零件 id 连续', () => {
    const truth = makeGroundTruth(SYNTH_PRESETS[0], [
      { cls: 1, x: 150, y: 100 },
      { cls: 1, x: 32, y: 32 }, // 码 0 上
      { cls: 2, x: 200, y: 80 },
    ]);
    const dets = truth.parts.map((p) => ({ cls: p.cls, score: 0.9, box: p.box }));
    const { parts, dropped } = mapDetections(dets, camFromPose(truth));
    expect(parts.map((p) => p.id)).toEqual([0, 1]);
    expect(parts.map((p) => p.detIndex)).toEqual([0, 2]);
    expect(parts[0].name).toBe(CLASSES[1].name);
    expect(dropped).toHaveLength(1);
  });
});
