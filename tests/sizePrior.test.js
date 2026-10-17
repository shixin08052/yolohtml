import { describe, it, expect } from 'vitest';
import { fitBoxes, bodyBoxPx } from '../src/vision/sizePrior.js';

// 底板 mm → 照片像素：10 px/mm，Y 向上 → 像素 y 向下
const H = [[10, 0, 100], [0, -10, 2100], [0, 0, 1]];
const Hinv = [[0.1, 0, -10], [0, -0.1, 210], [0, 0, 1]];
const LED = [8.5, 5.8];
const S = 0.93; // 照片里的框 / 按尺寸推算的框

/** 真实 LED 在照片上的框 */
function boxOf({ X, Y, rot }) {
  const { w, h } = bodyBoxPx(H, X, Y, rot, LED);
  const u = 10 * X + 100;
  const v = 2100 - 10 * Y;
  return [u - (S * w) / 2, v - (S * h) / 2, u + (S * w) / 2, v + (S * h) / 2];
}

/** 假的"看引脚"：框里只有一个 LED 的中心 → 它的朝向；几个同向的（引脚方向一致）→ 那个朝向；否则看不清 */
const yawFrom = (truth) => (box) => {
  const inside = truth.filter((t) => {
    const u = 10 * t.X + 100;
    const v = 2100 - 10 * t.Y;
    return u > box[0] && u < box[2] && v > box[1] && v < box[3];
  });
  if (!inside.length || inside.some((t) => t.rot !== inside[0].rot)) return null;
  return { rotDeg: inside[0].rot, reliable: true };
};

const det = (box, score = 0.9, cls = 1) => ({ cls, score, box });
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

// 三个分开放、框得正常的 LED（定比例尺用）
const refs = [{ X: 30, Y: 30, rot: 0 }, { X: 60, Y: 30, rot: 90 }, { X: 90, Y: 30, rot: 45 }];

describe('fitBoxes 按 LED 尺寸修正检测框', () => {
  it('框得正常的不动，比例尺取参考框的中位数', () => {
    const truth = [...refs, { X: 120, Y: 30, rot: 200 }];
    const dets = truth.map((t) => det(boxOf(t)));
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes).toEqual([]);
    expect(r.dets).toEqual(dets);
    expect(r.scale[1]).toBeCloseTo(S, 2);
  });

  it('中间的 LED 框伸进旁边零件：裁掉挨着的那一头，朝空白纸面的那一头不动', () => {
    // 三个并排、同向（长轴沿 X）的 LED，挨在一起；中间那个的框向下（Y 小的一侧）伸进了下面那个
    const row = [{ X: 50, Y: 80, rot: 0 }, { X: 50, Y: 74.2, rot: 0 }, { X: 50, Y: 68.4, rot: 0 }];
    const truth = [...refs, ...row];
    const dets = truth.map((t) => det(boxOf(t)));
    const good = dets[4].box;
    dets[4] = det([good[0], good[1], good[2], good[3] + 25], 0.5); // 下沿多出 2.5 mm
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ index: 4, kind: 'trim' });
    const b = r.dets[4].box;
    expect(b[1]).toBeCloseTo(good[1], 6); // 上沿（挨着上面那个，但多出来的在下面）保留
    expect(b[3]).toBeLessThan(good[3] + 25);
    expect(b[3] - b[1]).toBeCloseTo((good[3] - good[1]) * 1.05, 0);
    expect(r.dets[4].rawBox).toEqual(dets[4].box);
    expect(r.dets[4].fit).toBe('trim');
  });

  it('多出来的那一头挨着别的零件时裁那一头（不管在哪一边）', () => {
    const row = [{ X: 50, Y: 80, rot: 0 }, { X: 50, Y: 74.2, rot: 0 }];
    const truth = [...refs, ...row];
    const dets = truth.map((t) => det(boxOf(t)));
    const good = dets[3].box;
    // 上面那个的框向下伸进下面那个：裁下沿
    dets[3] = det([good[0], good[1] - 2, good[2], good[3] + 25], 0.6);
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    const b = r.dets[3].box;
    expect(b[1]).toBeCloseTo(good[1] - 2, 6);
    expect(b[3]).toBeLessThan(good[3] + 5);
  });

  it('沿长轴偏长时（灯头伸进别的零件的底座）裁灯头那头', () => {
    // 长轴竖着（rot 90：灯头朝上，照片里朝 −v）；下面紧挨着另一个 LED
    const truth = [...refs, { X: 50, Y: 80, rot: 270 }, { X: 50, Y: 71.5, rot: 270 }];
    const dets = truth.map((t) => det(boxOf(t)));
    const good = dets[3].box;
    dets[3] = det([good[0], good[1], good[2], good[3] + 30], 0.55); // 灯头朝下（+v），伸进下面那个
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes.map((c) => c.index)).toEqual([3]);
    expect(r.dets[3].box[1]).toBeCloseTo(good[1], 6);
    expect(r.dets[3].box[3]).toBeLessThan(good[3] + 5);
  });

  it('两个并排的 LED 合成一个框：按尺寸拆成两个，中心落在各自的 LED 上', () => {
    const pair = [{ X: 50, Y: 80, rot: 0 }, { X: 50, Y: 74.2, rot: 0 }];
    const truth = [...refs, ...pair];
    const a = boxOf(pair[0]);
    const b = boxOf(pair[1]);
    const merged = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    const dets = [...refs.map((t) => det(boxOf(t))), det(merged, 0.7)];
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].kind).toBe('split');
    expect(r.dets).toHaveLength(5);
    const subs = r.dets.filter((d) => d.fit === 'split');
    expect(subs).toHaveLength(2);
    const want = [a, b].map(center).sort((p, q) => p[1] - q[1]);
    const got = subs.map((d) => center(d.box)).sort((p, q) => p[1] - q[1]);
    got.forEach((g, i) => {
      expect(Math.hypot(g[0] - want[i][0], g[1] - want[i][1])).toBeLessThan(3); // 0.3 mm 内
    });
    subs.forEach((d) => expect(d.rawBox).toEqual(merged));
  });

  it('两个不同向、斜着挨着的 LED 合成一个框（引脚朝两个方向、看不清朝向）：在两个对角各放一个，拆开', () => {
    const pair = [{ X: 50, Y: 80, rot: 0 }, { X: 56, Y: 73, rot: 70 }];
    const truth = [...refs, ...pair];
    const a = boxOf(pair[0]);
    const b = boxOf(pair[1]);
    const merged = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    const dets = [...refs.map((t) => det(boxOf(t))), det(merged, 0.6)];
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes.map((c) => c.kind)).toEqual(['split']);
    const subs = r.dets.filter((d) => d.fit === 'split');
    expect(subs).toHaveLength(2);
    for (const want of [a, b]) {
      const d = Math.min(...subs.map((q) => Math.hypot(center(q.box)[0] - center(want)[0], center(q.box)[1] - center(want)[1])));
      expect(d).toBeLessThan(5); // 0.5 mm 内
    }
  });

  it('拆开后看不到各自的引脚（例如其实是一个 LED 加一大块影子）：不拆，退回裁或不动', () => {
    const truth = [...refs, { X: 50, Y: 80, rot: 0 }];
    const a = boxOf(truth[3]);
    const big = [a[0], a[1], a[2], a[3] + (a[3] - a[1])]; // 往下大了一倍，但下半没有 LED
    const dets = [...refs.map((t) => det(boxOf(t))), det(big, 0.7)];
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.dets.filter((d) => d.fit === 'split')).toHaveLength(0);
    // 两头都不挨着别的零件：不知道该裁哪头，不动
    expect(r.dets[3].box).toEqual(big);
  });

  it('朝向看不清、没给尺寸的类别（电阻）都不动', () => {
    const truth = [...refs];
    const odd = det([1000, 1000, 1200, 1100], 0.8); // 框里没有 LED：朝向看不清
    const res = det([500, 500, 700, 520], 0.9, 0);
    const dets = [...refs.map((t) => det(boxOf(t))), odd, res];
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.changes).toEqual([]);
    expect(r.dets[3]).toBe(odd);
    expect(r.dets[4]).toBe(res);
  });

  it('参考框不够时用默认比例', () => {
    const truth = [{ X: 30, Y: 30, rot: 0 }];
    const dets = [det(boxOf(truth[0]))];
    const r = fitBoxes(dets, { H, Hinv, dims: { 1: LED }, yawOf: yawFrom(truth) });
    expect(r.scale[1]).toBe(0.93);
    expect(r.changes).toEqual([]);
  });
});
