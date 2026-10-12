import { describe, it, expect } from 'vitest';
import { checkBoardPhoto, measurePaper } from '../src/vision/boardCheck.js';
import { markerCornersWorld } from '../src/vision/boardLayout.js';
import { applyH, invert3 } from '../src/vision/homography.js';
import { intrinsicsMatrix, lookAtPose } from '../src/math/pinhole.js';
import { mul3 } from '../src/math/linalg.js';

// 拍照：底板 mm → 像素（带透视），约 3.5 px/mm，整张纸落在 1300×1000 的图里
const Hcam = [
  [3.6, 0.35, 120],
  [0.15, -3.4, 850],
  [0.0002, 0.0006, 1],
];

/** 按"实际打印出来的版面"生成识别结果：transform 把设计坐标变成实际坐标 */
function photo(ids, transform = (p) => p) {
  return ids.map((id) => ({ id, corners: markerCornersWorld(id).map((p) => applyH(Hcam, transform(p))) }));
}

/**
 * 合成照片：深色桌面上一张白纸。
 * 纸张在"设计底板坐标"里的范围为 [x0, x1] × [y0, y1]（100% 打印时为 0..297 × 0..210）
 */
function rasterPaper([x0, x1, y0, y1], W = 1300, Hpx = 1000, Hc = Hcam) {
  const Hinv = invert3(Hc);
  const data = new Uint8ClampedArray(W * Hpx * 4);
  for (let v = 0; v < Hpx; v++) {
    for (let u = 0; u < W; u++) {
      const [X, Y] = applyH(Hinv, [u + 0.5, v + 0.5]);
      const inPaper = X >= x0 && X <= x1 && Y >= y0 && Y <= y1;
      const g = inPaper ? 235 : 70;
      const p = (v * W + u) * 4;
      data[p] = data[p + 1] = data[p + 2] = g;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: Hpx, data };
}

/** 内容按比例 k 绕纸中心缩小打印时，纸在设计坐标里的范围 */
function paperForScale(kx, ky = kx) {
  const cx = 148.5;
  const cy = 105;
  return [cx - 148.5 / kx, cx + 148.5 / kx, cy - 105 / ky, cy + 105 / ky];
}

describe('打印检查：码的版面', () => {
  it('版面正确：4 个码全部识别，偏差 ≈ 0，边长 40 mm', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3]));
    expect(r.level).toBe('ok');
    expect(r.missing).toEqual([]);
    expect(r.maxErrMm).toBeLessThan(1e-6);
    for (const p of r.perMarker) expect(p.sideMm).toBeCloseTo(40, 6);
  });

  it('整页缩放（含横竖不等）会被 H 吸收，单看码判断不出来', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3], ([x, y]) => [x, 105 + 0.94 * (y - 105)]));
    expect(r.maxErrMm).toBeLessThan(1e-6);
  });

  it('某个码印大了：判为不正确', () => {
    const markers = photo([0, 1, 2, 3]);
    const c = [265, 178];
    markers[2].corners = markerCornersWorld(2).map(([x, y]) => applyH(Hcam, [c[0] + 1.2 * (x - c[0]), c[1] + 1.2 * (y - c[1])]));
    expect(checkBoardPhoto(markers).level).not.toBe('ok');
  });

  it('两个码位置互换：判为 bad', () => {
    const markers = photo([0, 1, 2, 3]);
    [markers[1].corners, markers[2].corners] = [markers[2].corners, markers[1].corners];
    expect(checkBoardPhoto(markers).level).toBe('bad');
  });

  it('缺码时列出缺少的 ID，并降为 warn', () => {
    const r = checkBoardPhoto(photo([0, 2, 3]));
    expect(r.missing).toEqual([1]);
    expect(r.level).toBe('warn');
  });

  it('只有 1 个码或没有码：bad', () => {
    expect(checkBoardPhoto(photo([3])).level).toBe('bad');
    expect(checkBoardPhoto([]).level).toBe('bad');
  });
});

describe('打印检查：纸边与打印比例', () => {
  it('100% 打印：纸宽 297、高 210，比例 100%', () => {
    const m = measurePaper(rasterPaper(paperForScale(1)), Hcam);
    expect(Math.abs(m.widthMm - 297)).toBeLessThan(1);
    expect(Math.abs(m.heightMm - 210)).toBeLessThan(1);
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), rasterPaper(paperForScale(1)));
    expect(r.level).toBe('ok');
  });

  it('"适合页面"打印成 97%：测出约 97%，判为 bad', () => {
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), rasterPaper(paperForScale(0.97)));
    expect(r.paper.scaleX).toBeCloseTo(0.97, 2);
    expect(r.paper.scaleY).toBeCloseTo(0.97, 2);
    expect(r.level).toBe('bad');
  });

  it('横竖比例不一致（100% × 95%）也能测出', () => {
    const m = measurePaper(rasterPaper(paperForScale(1, 0.95)), Hcam);
    expect(m.scaleX).toBeCloseTo(1, 2);
    expect(m.scaleY).toBeCloseTo(0.95, 2);
  });

  it('打印内容整体平移 3 mm 不影响比例', () => {
    const [x0, x1, y0, y1] = paperForScale(1);
    const m = measurePaper(rasterPaper([x0 + 3, x1 + 3, y0 - 2, y1 - 2]), Hcam);
    expect(m.scaleX).toBeCloseTo(1, 2);
    expect(m.scaleY).toBeCloseTo(1, 2);
    expect(m.edges.left).toBeCloseTo(-3, 0);
  });

  it('纸和桌面颜色相同时测不出纸边，提示而不误判', () => {
    const blank = rasterPaper([-1000, 1000, -1000, 1000]);
    const r = checkBoardPhoto(photo([0, 1, 2, 3]), blank);
    expect(r.paper.widthMm).toBeNull();
    expect(r.level).toBe('warn');
  });
});

/**
 * 用针孔模型生成"拍照"单应性（底板 mm → 像素）：H = K·[r1 r2 t]
 * rollDeg 模拟手机横拿 / 竖拿 / 倒拿；target 决定纸在照片里的位置
 */
function photoH({ W, Hpx, rollDeg = 0, target = [148.5, 105, 0], distance = 400, pitchDeg = 80, yawDeg = 0 }) {
  const K = intrinsicsMatrix({ fx: 900, fy: 900, cx: W / 2, cy: Hpx / 2 });
  const { R, t } = lookAtPose({ target, distance, pitchDeg, yawDeg, rollDeg });
  const Rt = [[R[0][0], R[0][1], t[0]], [R[1][0], R[1][1], t[1]], [R[2][0], R[2][1], t[2]]];
  const H = mul3(K, Rt);
  return H.map((r) => r.map((x) => x / H[2][2]));
}

describe('打印检查：照片旋转与纸靠近照片边缘', () => {
  const cases = [
    { name: '横拿（0°）', W: 1000, Hpx: 750, rollDeg: 0 },
    { name: '竖拿（90°）', W: 750, Hpx: 1000, rollDeg: 90 },
    { name: '倒拿（180°）', W: 1000, Hpx: 750, rollDeg: 180 },
    { name: '竖拿（270°）', W: 750, Hpx: 1000, rollDeg: 270 },
  ];
  for (const c of cases) {
    it(`${c.name}：100% 和 97% 打印都测得出`, () => {
      const H = photoH(c);
      for (const k of [1, 0.97]) {
        const m = measurePaper(rasterPaper(paperForScale(k), c.W, c.Hpx, H), H);
        expect(m.scaleX).toBeCloseTo(k, 2);
        expect(m.scaleY).toBeCloseTo(k, 2);
      }
    });
  }

  it('纸边离照片边缘只有 6 mm（纸外桌面不足 15 mm）：仍能测出', () => {
    // 竖拿，纸的操作者一侧靠近照片左边缘
    const c = { W: 750, Hpx: 1000, rollDeg: 90, distance: 330, pitchDeg: 90 };
    let H = photoH(c);
    // 平移相机，使操作者一侧的纸边落在离照片边缘约 6 mm 处
    const pxPerMm = Math.hypot(applyH(H, [10, 0])[0] - applyH(H, [0, 0])[0], applyH(H, [10, 0])[1] - applyH(H, [0, 0])[1]) / 10;
    // 这个姿态下操作者一侧的纸边是照片里靠右的一条竖线
    const [u0] = applyH(H, [148.5, 0]);
    expect(u0).toBeGreaterThan(c.W / 2);
    const shift = c.W - 6 * pxPerMm - u0;
    H = mul3([[1, 0, shift], [0, 1, 0], [0, 0, 1]], H);
    const [u1] = applyH(H, [148.5, 0]);
    expect((c.W - u1) / pxPerMm).toBeCloseTo(6, 0);
    const m = measurePaper(rasterPaper(paperForScale(1), c.W, c.Hpx, H), H);
    expect(m.edges.bottom).not.toBeNull();
    expect(m.scaleY).toBeCloseTo(1, 2);
  });

  it('纸边被裁出照片：说明是哪条边、原因是离照片边缘太近', () => {
    const c = { W: 750, Hpx: 1000, rollDeg: 90, distance: 330, pitchDeg: 90 };
    let H = photoH(c);
    const [u0] = applyH(H, [148.5, 0]);
    H = mul3([[1, 0, c.W - u0 + 5], [0, 1, 0], [0, 0, 1]], H); // 操作者一侧的纸边移出照片右边缘
    const img = rasterPaper(paperForScale(1), c.W, c.Hpx, H);
    const m = measurePaper(img, H);
    expect(m.edges.bottom).toBeNull();
    expect(m.reasons.bottom).toBe('outside');
    const markers = [0, 1, 2, 3].map((id) => ({ id, corners: markerCornersWorld(id).map((p) => applyH(H, p)) }));
    const r = checkBoardPhoto(markers, img);
    expect(r.level).toBe('warn');
    expect(r.messages.join('')).toContain('操作者一侧');
    expect(r.messages.join('')).toContain('离照片边缘太近');
  });
});
