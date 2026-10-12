import { describe, it, expect } from 'vitest';
import { toThree, fromThree } from '../src/math/coords.js';

describe('coords', () => {
  it('底板点 (297, 210, 10) → Three.js (297, 10, −210)', () => {
    const v = toThree(297, 210, 10);
    expect([v.x, v.y, v.z]).toEqual([297, 10, -210]);
  });

  it('转回底板坐标保持一致', () => {
    expect(fromThree(toThree(297, 210, 10))).toEqual([297, 210, 10]);
  });

  it('Z 缺省为 0，随机点往返一致', () => {
    expect(fromThree(toThree(12.5, -3))).toEqual([12.5, -3, 0]);
    for (let k = 0; k < 50; k++) {
      const p = [Math.random() * 800 - 200, Math.random() * 600 - 150, Math.random() * 500];
      const q = fromThree(toThree(...p));
      for (let i = 0; i < 3; i++) expect(q[i]).toBeCloseTo(p[i], 12);
    }
  });

  it('右手系：Three.js 中 X × Y 方向 = Z 方向', () => {
    const ex = toThree(1, 0, 0);
    const ey = toThree(0, 1, 0);
    const ez = toThree(0, 0, 1);
    const c = ex.clone().cross(ey);
    expect(c.distanceTo(ez)).toBe(0);
  });
});

describe('相机朝向', async () => {
  const { cameraQuaternionFromR } = await import('../src/math/coords.js');
  const { lookAtPose } = await import('../src/math/pinhole.js');
  const { Vector3, PerspectiveCamera } = await import('three');

  it('Three.js 相机看向的方向 = 光轴 Rᵀ·(0,0,1)，向上 = −Rᵀ·(0,1,0)', () => {
    for (const [pitchDeg, yawDeg, rollDeg] of [[90, 0, 0], [65, 6, 0], [45, -8, 2], [40, 30, -15]]) {
      const { R } = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg, yawDeg, rollDeg });
      const q = cameraQuaternionFromR(R);
      const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
      const up = new Vector3(0, 1, 0).applyQuaternion(q);
      const right = new Vector3(1, 0, 0).applyQuaternion(q);
      expect(fwd.distanceTo(toThree(R[2][0], R[2][1], R[2][2]))).toBeLessThan(1e-9);
      expect(up.distanceTo(toThree(-R[1][0], -R[1][1], -R[1][2]))).toBeLessThan(1e-9);
      expect(right.distanceTo(toThree(R[0][0], R[0][1], R[0][2]))).toBeLessThan(1e-9);
    }
  });

  it('用 Three.js 相机投影与针孔公式一致（fov 由 fy 换算）', async () => {
    const { project, intrinsicsMatrix } = await import('../src/math/pinhole.js');
    const k = { fx: 3028.4, fy: 3028.4, cx: 2016, cy: 1512 };
    const W = 4032;
    const H = 3024;
    const pose = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg: 45, yawDeg: -8, rollDeg: 2 });
    const cam = new PerspectiveCamera((2 * Math.atan(H / 2 / k.fy) * 180) / Math.PI, W / H, 1, 5000);
    cam.position.copy(toThree(...pose.position));
    cam.quaternion.copy(cameraQuaternionFromR(pose.R));
    cam.updateMatrixWorld();
    for (const P of [[12, 12, 0], [285, 198, 0], [150, 140, 12]]) {
      const ndc = toThree(...P).project(cam);
      const u3 = ((ndc.x + 1) / 2) * W;
      const v3 = ((1 - ndc.y) / 2) * H;
      const [u, v] = project(intrinsicsMatrix(k), pose.R, pose.t, P);
      expect(Math.hypot(u3 - u, v3 - v)).toBeLessThan(1e-6);
    }
  });
});
