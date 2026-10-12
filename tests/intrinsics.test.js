import { describe, it, expect } from 'vitest';
import {
  fromExif, fromCalib, rotateIntrinsics, rotationFromOrientation, calibAspectWarning, lensWarning,
} from '../src/vision/intrinsics.js';

// 一份假的标定结果（参考分辨率 4032 × 3024，主点略偏离中心，fx ≠ fy）
const calib = { fx: 3050, fy: 3046, cx: 2010, cy: 1520, width: 4032, height: 3024, dist: [0.1, -0.2, 0, 0, 0.1], rms: 0.4 };

describe('fromExif', () => {
  it('26 mm、4032 × 3024 → fx ≈ 3028，主点在中心', () => {
    const k = fromExif(26, 4032, 3024);
    expect(Math.abs(k.fx - 3028)).toBeLessThan(1);
    expect(k.fy).toBe(k.fx);
    expect([k.cx, k.cy, k.width, k.height, k.source]).toEqual([2016, 1512, 4032, 3024, 'exif']);
  });

  it('竖拍 3024 × 4032：f 不变，主点在中心', () => {
    const k = fromExif(26, 3024, 4032);
    expect(Math.abs(k.fx - 3028)).toBeLessThan(1);
    expect([k.cx, k.cy]).toEqual([1512, 2016]);
  });

  it('分辨率缩小一半：f 也减半', () => {
    expect(fromExif(26, 2016, 1512).fx).toBeCloseTo(fromExif(26, 4032, 3024).fx / 2, 9);
  });

  it('等效焦距无效时报错', () => {
    expect(() => fromExif(0, 4032, 3024)).toThrow();
    expect(() => fromExif(undefined, 4032, 3024)).toThrow();
  });
});

describe('fromCalib', () => {
  it('同分辨率横拍：原样使用', () => {
    const k = fromCalib(calib, 4032, 3024);
    expect([k.fx, k.fy, k.cx, k.cy, k.source]).toEqual([3050, 3046, 2010, 1520, 'calib']);
  });

  it('分辨率不同：fx、fy、cx、cy 都乘以 s = 实际宽 ÷ 参考宽', () => {
    const k = fromCalib(calib, 2016, 1512);
    expect([k.fx, k.fy, k.cx, k.cy]).toEqual([1525, 1523, 1005, 760]);
    expect([k.width, k.height]).toEqual([2016, 1512]);
  });

  it('竖拍（顺时针 90°）：fx′ = fy，fy′ = fx，cx′ = 参考高 − cy，cy′ = cx', () => {
    const k = fromCalib(calib, 3024, 4032);
    expect([k.fx, k.fy, k.cx, k.cy]).toEqual([3046, 3050, 3024 - 1520, 2010]);
  });

  it('竖拍且分辨率减半：先旋转再缩放', () => {
    const k = fromCalib(calib, 1512, 2016);
    expect([k.fx, k.fy, k.cx, k.cy]).toEqual([1523, 1525, (3024 - 1520) / 2, 1005]);
  });

  it('按 EXIF 方向：倒拿（180°）与另一侧竖拍（270°）', () => {
    const k180 = fromCalib(calib, 4032, 3024, 180);
    expect([k180.cx, k180.cy]).toEqual([4032 - 2010, 3024 - 1520]);
    const k270 = fromCalib(calib, 3024, 4032, 270);
    expect([k270.fx, k270.fy, k270.cx, k270.cy]).toEqual([3046, 3050, 1520, 4032 - 2010]);
  });

  it('EXIF 方向与宽高不符时以宽高为准', () => {
    // 写着竖拍，实际是横图（方向已被转存进像素）
    expect(fromCalib(calib, 4032, 3024, 90).cx).toBe(2010);
  });

  it('旋转是对像素坐标的正确变换：旋转前后同一个点的投影对应', () => {
    // 传感器方向下相机坐标 (x, y, z) 投影到 (u, v)；竖拍照片里同一点在 (H − v, u)
    const P = [40, -25, 300];
    const u = (calib.fx * P[0]) / P[2] + calib.cx;
    const v = (calib.fy * P[1]) / P[2] + calib.cy;
    // 顺时针转 90° 后相机坐标为 (−y, x, z)
    const k = rotateIntrinsics(calib, 4032, 3024, 90);
    const u2 = (k.fx * -P[1]) / P[2] + k.cx;
    const v2 = (k.fy * P[0]) / P[2] + k.cy;
    expect(u2).toBeCloseTo(3024 - v, 9);
    expect(v2).toBeCloseTo(u, 9);
  });
});

describe('其他', () => {
  it('EXIF Orientation → 顺时针旋转角', () => {
    expect([1, 6, 3, 8, undefined, 2].map(rotationFromOrientation)).toEqual([0, 90, 180, 270, 0, 0]);
  });

  it('宽高比检查：裁剪过的照片给出提示', () => {
    expect(calibAspectWarning(calib, 4032, 3024)).toBeNull();
    expect(calibAspectWarning(calib, 1512, 2016)).toBeNull();
    expect(calibAspectWarning(calib, 4032, 2268)).toContain('裁剪');
  });

  it('镜头检查：26 mm 不提醒，其他焦距提醒', () => {
    expect(lensWarning(26)).toBeNull();
    expect(lensWarning(null)).toBeNull();
    expect(lensWarning(77)).toBe('可能切换了镜头（当前等效焦距 77 mm）');
    expect(lensWarning(13)).toContain('13 mm');
  });
});

describe('按来源计算内参', async () => {
  const { computeIntrinsics, defaultSource } = await import('../src/vision/intrinsics.js');
  const exif = (o) => ({ focal35: 26, focalMm: 5.7, lensModel: null, make: 'Apple', model: 'iPhone 13 Pro', orientation: 1, ...o });
  const img = (w, h, e = {}) => ({ width: w, height: h, exif: exif(e) });

  it('EXIF：横拍 26 mm 无提醒', () => {
    const r = computeIntrinsics('exif', { image: img(4032, 3024) });
    expect(Math.abs(r.intrinsics.fx - 3028)).toBeLessThan(1);
    expect(r.notes).toEqual([]);
  });

  it('EXIF 缺失：按 26 mm 估算并提醒', () => {
    const r = computeIntrinsics('exif', { image: img(3024, 4032, { focal35: null }) });
    expect(Math.abs(r.intrinsics.fx - 3028)).toBeLessThan(1);
    expect(r.notes[0].text).toContain('默认 26 mm');
  });

  it('长焦：提醒切换了镜头', () => {
    const r = computeIntrinsics('exif', { image: img(4032, 3024, { focal35: 77 }) });
    expect(r.notes[0].text).toContain('77 mm');
  });

  it('标定文件：竖拍按 EXIF 方向 6 旋转', () => {
    const r = computeIntrinsics('calib', { image: img(3024, 4032, { orientation: 6 }), calib });
    expect([r.intrinsics.cx, r.intrinsics.cy, r.intrinsics.source]).toEqual([3024 - 1520, 2010, 'calib']);
  });

  it('默认来源', () => {
    expect(defaultSource({ image: img(4032, 3024), truth: {} })).toBe('truth');
    expect(defaultSource({ image: img(4032, 3024), calib })).toBe('calib');
    expect(defaultSource({ image: img(4032, 3024) })).toBe('exif');
    expect(defaultSource({ image: img(4032, 3024, { focal35: 77 }), calib })).toBe('exif');
    expect(defaultSource({ image: img(4032, 2268), calib })).toBe('exif');
  });
});
