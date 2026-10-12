import { describe, it, expect } from 'vitest';
import { poseFromHomography, orthonormalize } from '../src/vision/pose.js';
import { solveHomography } from '../src/vision/homography.js';
import { markerCornersWorld } from '../src/vision/boardLayout.js';
import { intrinsicsMatrix, lookAtPose, project } from '../src/math/pinhole.js';
import { poseTruthError } from '../src/vision/evaluate.js';
import { det3, mul3, transpose3 } from '../src/math/linalg.js';
import { BOARD } from '../src/config.js';

const K = intrinsicsMatrix({ fx: 3028.4, fy: 3028.4, cx: 2016, cy: 1512 });
const world = [0, 1, 2, 3].flatMap((id) => markerCornersWorld(id));

/** 固定种子的伪随机数与高斯噪声 */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** 随机生成 n 组位姿：高度 250–500 mm，俯角 40°–90°，看向底板中心附近，偏航 / 滚转随机 */
function randomPoses(n, r) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const pitchDeg = 40 + 50 * r();
    const height = 250 + 250 * r();
    const target = [BOARD.width / 2 + (r() - 0.5) * 60, BOARD.height / 2 + (r() - 0.5) * 40, 0];
    out.push(lookAtPose({
      target,
      distance: height / Math.sin((pitchDeg * Math.PI) / 180),
      pitchDeg,
      yawDeg: (r() - 0.5) * 60,
      rollDeg: (r() - 0.5) * 20,
    }));
  }
  return out;
}

function estimate(pose, noise, r) {
  const img = world.map(([X, Y]) => {
    const [u, v] = project(K, pose.R, pose.t, [X, Y, 0]);
    return [u + noise * gauss(r), v + noise * gauss(r)];
  });
  const H = solveHomography(world, img);
  return poseFromHomography(K, H, world, img);
}

describe('位姿反推', () => {
  it('正交化得到旋转矩阵（RᵀR = I，det = 1）', () => {
    const R = orthonormalize([[1.02, 0.01, 0], [-0.02, 0.98, 0.03], [0, -0.01, 1.01]]);
    const I = mul3(transpose3(R), R);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(I[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
    expect(det3(R)).toBeCloseTo(1, 12);
  });

  it('20 组随机位姿、无噪声：位置误差 < 0.1 mm', () => {
    const r = rng(1);
    for (const pose of randomPoses(20, r)) {
      const est = estimate(pose, 0, r);
      const e = poseTruthError(est, { ...pose, pitchDeg: Math.asin(-pose.R[2][2]) * 180 / Math.PI });
      expect(e.posErrMm).toBeLessThan(0.1);
      expect(e.angleErrDeg).toBeLessThan(0.01);
      expect(est.reprojErrPx).toBeLessThan(1e-3);
    }
  });

  it('20 组随机位姿、0.5 像素噪声：位置误差 < 5 mm，角度误差 < 0.5°', () => {
    const r = rng(2);
    let worstPos = 0;
    let worstAng = 0;
    for (const pose of randomPoses(20, r)) {
      const est = estimate(pose, 0.5, r);
      const e = poseTruthError(est, { ...pose, pitchDeg: Math.asin(-pose.R[2][2]) * 180 / Math.PI });
      worstPos = Math.max(worstPos, e.posErrMm);
      worstAng = Math.max(worstAng, e.angleErrDeg, Math.abs(e.pitchErrDeg));
    }
    console.log(`0.5 px 噪声：最大位置误差 ${worstPos.toFixed(2)} mm，最大角度误差 ${worstAng.toFixed(3)}°`);
    expect(worstPos).toBeLessThan(5);
    expect(worstAng).toBeLessThan(0.5);
  });

  it('H 的符号取反不影响结果（t_z 保证为正）', () => {
    const [pose] = randomPoses(1, rng(3));
    const img = world.map(([X, Y]) => project(K, pose.R, pose.t, [X, Y, 0]).slice(0, 2));
    const H = solveHomography(world, img).map((row) => row.map((x) => -x));
    const est = poseFromHomography(K, H, world, img);
    expect(est.t[2]).toBeGreaterThan(0);
    expect(Math.hypot(...est.position.map((x, i) => x - pose.position[i]))).toBeLessThan(0.1);
  });

  it('正上方 300 mm：高度 300 mm、俯角 90°', () => {
    const pose = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg: 90 });
    const est = estimate(pose, 0, rng(4));
    expect(est.heightMm).toBeCloseTo(300, 4);
    expect(est.pitchDeg).toBeCloseTo(90, 3);
  });
});
