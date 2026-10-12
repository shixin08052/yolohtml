import { describe, it, expect } from 'vitest';
import { intrinsicsMatrix, project, lookAtPose, cameraCenter, pitchDegFromR } from '../src/math/pinhole.js';
import { mul3, transpose3, det3, identity3 } from '../src/math/linalg.js';

const K = intrinsicsMatrix({ fx: 3028, fy: 3028, cx: 2016, cy: 1512 });
const target = [148.5, 105, 0];

describe('针孔投影', () => {
  it('相机坐标系下的点：u = fx·x/z + cx', () => {
    const [u, v, z] = project(K, identity3(), [0, 0, 0], [30, -20, 300]);
    expect(u).toBeCloseTo(3028 * 30 / 300 + 2016, 9);
    expect(v).toBeCloseTo(3028 * -20 / 300 + 1512, 9);
    expect(z).toBe(300);
  });

  it('平移：t 直接加到相机坐标上', () => {
    const [u, v] = project(K, identity3(), [10, 0, 100], [20, 0, 200]);
    expect(u).toBeCloseTo(3028 * 30 / 300 + 2016, 9);
    expect(v).toBeCloseTo(1512, 9);
  });
});

describe('lookAtPose', () => {
  for (const pitchDeg of [90, 65, 45]) {
    for (const yawDeg of [0, 7, -12]) {
      it(`俯角 ${pitchDeg}° 偏航 ${yawDeg}°：R 正交、目标点投影到图像中心、俯角与距离一致`, () => {
        const { R, t, position } = lookAtPose({ target, distance: 300, pitchDeg, yawDeg });
        const RtR = mul3(transpose3(R), R);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(RtR[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
        expect(det3(R)).toBeCloseTo(1, 12);
        const [u, v, z] = project(K, R, t, target);
        expect(u).toBeCloseTo(2016, 8);
        expect(v).toBeCloseTo(1512, 8);
        expect(z).toBeCloseTo(300, 9);
        expect(pitchDegFromR(R)).toBeCloseTo(pitchDeg, 9);
        const C = cameraCenter(R, t);
        for (let i = 0; i < 3; i++) expect(C[i]).toBeCloseTo(position[i], 9);
        expect(position[2]).toBeCloseTo(300 * Math.sin((pitchDeg * Math.PI) / 180), 9);
      });
    }
  }

  it('正上方拍：底板 +X 在图像中向右，+Y 在图像中向上', () => {
    const { R, t } = lookAtPose({ target, distance: 300, pitchDeg: 90 });
    const o = project(K, R, t, target);
    const px = project(K, R, t, [target[0] + 10, target[1], 0]);
    const py = project(K, R, t, [target[0], target[1] + 10, 0]);
    expect(px[0] - o[0]).toBeCloseTo(3028 * 10 / 300, 6);
    expect(px[1] - o[1]).toBeCloseTo(0, 6);
    expect(py[1] - o[1]).toBeCloseTo(-3028 * 10 / 300, 6);
  });

  it('斜拍：近端（Y 小）比远端在图像中更大、更靠下', () => {
    const { R, t } = lookAtPose({ target, distance: 300, pitchDeg: 45 });
    const w = (Y) => project(K, R, t, [200, Y, 0])[0] - project(K, R, t, [100, Y, 0])[0];
    expect(w(20)).toBeGreaterThan(w(190));
    expect(project(K, R, t, [148.5, 20, 0])[1]).toBeGreaterThan(project(K, R, t, [148.5, 190, 0])[1]);
  });

  it('roll：图像绕中心旋转', () => {
    const a = lookAtPose({ target, distance: 300, pitchDeg: 90, rollDeg: 0 });
    const b = lookAtPose({ target, distance: 300, pitchDeg: 90, rollDeg: 90 });
    const P = [target[0] + 10, target[1], 0];
    const pa = project(K, a.R, a.t, P);
    const pb = project(K, b.R, b.t, P);
    // 不转时在中心右侧；顺时针转 90° 后应在中心上方
    expect(pa[0]).toBeGreaterThan(2016);
    expect(pb[1]).toBeLessThan(1512);
    expect(pb[0]).toBeCloseTo(2016, 6);
  });
});

describe('视线与照片视野', async () => {
  const { pixelRay, rayHitPlaneZ, photoFootprint } = await import('../src/math/pinhole.js');

  it('像素视线打到底板上的点，再投影回来就是这个像素', () => {
    const { R, t } = lookAtPose({ target, distance: 300, pitchDeg: 55, yawDeg: 10 });
    for (const uv of [[100, 200], [2016, 1512], [3900, 2900]]) {
      const { origin, dir } = pixelRay(K, R, t, uv);
      const P = rayHitPlaneZ(origin, dir, 0);
      expect(P[2]).toBeCloseTo(0, 9);
      const [u, v] = project(K, R, t, P);
      expect(u).toBeCloseTo(uv[0], 6);
      expect(v).toBeCloseTo(uv[1], 6);
    }
  });

  it('正上方拍：四角都落在底板平面上，构成以目标点为中心的矩形', () => {
    const { R, t } = lookAtPose({ target, distance: 300, pitchDeg: 90 });
    const f = photoFootprint(K, R, t, 4032, 3024);
    expect(f.every((c) => c.hit)).toBe(true);
    const half = [300 * 2016 / 3028, 300 * 1512 / 3028];
    expect(f[0].point[0]).toBeCloseTo(target[0] - half[0], 6); // 左上 → X 小、Y 大
    expect(f[0].point[1]).toBeCloseTo(target[1] + half[1], 6);
    expect(f[2].point[0]).toBeCloseTo(target[0] + half[0], 6);
    expect(f[2].point[1]).toBeCloseTo(target[1] - half[1], 6);
  });

  it('很斜地拍（俯角 20°）：上面两个角的视线打不到底板平面，给出 600 mm 长的端点', () => {
    const { R, t, position } = lookAtPose({ target, distance: 300, pitchDeg: 20 });
    const f = photoFootprint(K, R, t, 4032, 3024);
    expect(f[0].hit).toBe(false);
    expect(f[1].hit).toBe(false);
    expect(f[2].hit && f[3].hit).toBe(true);
    const len = Math.hypot(...f[0].point.map((x, i) => x - position[i]));
    expect(len).toBeCloseTo(600, 6);
  });
});
