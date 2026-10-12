import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { phoneLayout, createPhone, PHONE } from '../src/scene/phone.js';
import { lookAtPose } from '../src/math/pinhole.js';
import { toThree, fromThree } from '../src/math/coords.js';

describe('手机摆放', () => {
  it('竖拍（方向 6）：长边沿照片纵向，镜头在右上（从屏幕一侧看）', () => {
    const l = phoneLayout(6, 3024, 4032);
    expect(l.size).toEqual([PHONE.width, PHONE.height]);
    expect(l.lens[0]).toBeGreaterThan(0);
    expect(l.lens[1]).toBeLessThan(0);
  });

  it('横拍（方向 1）：长边沿照片横向，镜头在左上', () => {
    const l = phoneLayout(1, 4032, 3024);
    expect(l.size).toEqual([PHONE.height, PHONE.width]);
    expect(l.lens[0]).toBeLessThan(0);
    expect(l.lens[1]).toBeLessThan(0);
  });

  it('没有 EXIF 方向时按照片宽高判断', () => {
    expect(phoneLayout(null, 3024, 4032).size).toEqual([PHONE.width, PHONE.height]);
    expect(phoneLayout(undefined, 4032, 3024).size).toEqual([PHONE.height, PHONE.width]);
  });

  it('镜头在机身范围内（距边 14 mm）', () => {
    for (const o of [1, 3, 6, 8]) {
      const l = phoneLayout(o, 4032, 3024);
      expect(Math.abs(l.lens[0])).toBeCloseTo(l.size[0] / 2 - PHONE.lensFromEdge, 9);
      expect(Math.abs(l.lens[1])).toBeCloseTo(l.size[1] / 2 - PHONE.lensFromEdge, 9);
    }
  });
});

describe('3D 手机模型', () => {
  const intrinsics = { fx: 3028.4, fy: 3028.4, cx: 2016, cy: 1512, width: 4032, height: 3024, source: 'exif' };
  const pose = lookAtPose({ target: [148.5, 105, 0], distance: 300, pitchDeg: 60, yawDeg: 10 });

  it('镜头位于光心 C，机身背面朝向拍摄方向、在镜头后方', () => {
    const ph = createPhone();
    ph.setPose({ pose: { ...pose }, intrinsics, orientation: 1 });
    ph.group.updateMatrixWorld(true);
    const lensWorld = new THREE.Vector3();
    ph.body.children[2].getWorldPosition(lensWorld); // 镜头圆柱（中心在光心前 1 mm）
    const C = toThree(...pose.position);
    expect(lensWorld.distanceTo(C)).toBeLessThan(1.01);
    // 机身中心在光心后方（与拍摄方向相反）
    const shellWorld = new THREE.Vector3();
    ph.body.children[0].getWorldPosition(shellWorld);
    const fwd = toThree(...pose.R[2]); // 光轴方向（底板坐标的 Rᵀ·e3 = R 第 3 行）
    expect(shellWorld.clone().sub(C).dot(fwd)).toBeLessThan(0);
  });

  it('视锥：4 条线从光心到照片四角在底板上的落点，外加视野轮廓', () => {
    const ph = createPhone();
    ph.setPose({ pose, intrinsics, orientation: 1 });
    const frustum = ph.group.getObjectByName('frustum');
    expect(frustum.children.length).toBe(8); // 4 条视锥线 + 4 条轮廓
    const pts = frustum.children.slice(0, 4).map((l) => {
      const a = l.geometry.attributes.position;
      return fromThree(new THREE.Vector3(a.getX(1), a.getY(1), a.getZ(1)));
    });
    for (const p of pts) expect(Math.abs(p[2])).toBeLessThan(1e-6);
  });
});

describe('全景视角方位', async () => {
  const { panoramaAzimuth } = await import('../src/scene/phone.js');
  const c = [148.5, 105];
  it('手机在底板正上方附近：右前方 40°', () => {
    expect(panoramaAzimuth([150, 93, 284], c)).toBe(40);
  });
  it('手机在操作者一侧：从侧面看（约 ±80°），视线垂直于手机的偏移方向', () => {
    const az = panoramaAzimuth([119, -105, 212], c);
    expect(Math.abs(az)).toBeGreaterThan(70);
    const view = [Math.sin((az * Math.PI) / 180), -Math.cos((az * Math.PI) / 180)];
    const h = [119 - c[0], -105 - c[1]];
    expect(Math.abs(view[0] * h[0] + view[1] * h[1]) / Math.hypot(...h)).toBeLessThan(0.2);
  });
  it('手机在右侧：从操作者一侧看（约 0°）', () => {
    expect(Math.abs(panoramaAzimuth([450, 105, 200], c))).toBeLessThan(5);
  });
});
