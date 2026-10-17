import { describe, it, expect } from 'vitest';
import { samplePatch, boardToPatch, leadDirection, ledColor, polyDistance, ridgeStrength } from '../src/vision/leads.js';

const PAPER = [226, 224, 218];
const angDiff = (a, b, p = 360) => Math.abs(((((a - b) % p) + p * 1.5) % p) - p / 2);

/** 画布：一块 W×H 的 RGBA，纸面颜色 */
function canvas(W, H) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...PAPER, 255], i * 4);
  return { width: W, height: H, data };
}
/** 在画布上把满足 f(x, y) 的像素涂成 rgb（f 用像素中心坐标） */
function paint(img, f, rgb, alpha = 1) {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!f(x + 0.5, y + 0.5)) continue;
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = img.data[o + c] * (1 - alpha) + rgb[c] * alpha;
    }
  }
}
/** 局部坐标（沿 a 方向为 +u）里的矩形 [u0, u1] × [−hw, hw]，中心 (cx, cy)；坐标为"向上为 +y"的数学坐标，画布 y 向下 */
const rectFn = (cx, cy, aDeg, u0, u1, hw, imgH) => (x, y) => {
  const a = (aDeg * Math.PI) / 180;
  const X = x - cx;
  const Y = imgH - y - cy;
  const u = X * Math.cos(a) + Y * Math.sin(a);
  const v = -X * Math.sin(a) + Y * Math.cos(a);
  return u >= u0 && u <= u1 && Math.abs(v) <= hw;
};

/**
 * 在取样图（8 px/mm、44 mm）上画一颗躺平的 LED：灯头朝 headDeg，本体 8.5 × 5.8 mm，两根引脚从底座伸出 15 mm
 * 返回本体的轴对齐外接框（像 YOLO 框）
 */
function drawLed(img, k, cx, cy, headDeg, rgb = [205, 40, 40], { leads = true } = {}) {
  const H = img.height;
  paint(img, rectFn(cx, cy, headDeg, -4.25 * k, 4.25 * k, 2.9 * k, H), rgb);
  if (leads) {
    for (const off of [-1.27, 1.27]) {
      const a = (headDeg * Math.PI) / 180;
      const ox = cx - Math.sin(a) * off * k;
      const oy = cy + Math.cos(a) * off * k;
      paint(img, rectFn(ox, oy, headDeg, -19 * k, -4.25 * k, 0.25 * k, H), [120, 120, 125]);
    }
  }
  // 本体四角 → 外接框（取样图像素，y 向下）
  const a = (headDeg * Math.PI) / 180;
  const pts = [[-4.25, -2.9], [4.25, -2.9], [4.25, 2.9], [-4.25, 2.9]].map(([u, v]) => [cx + (u * Math.cos(a) - v * Math.sin(a)) * k, H - (cy + (u * Math.sin(a) + v * Math.cos(a)) * k)]);
  const x0 = Math.min(...pts.map((p) => p[0]));
  const x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const y1 = Math.max(...pts.map((p) => p[1]));
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

const K = 8;
const N = 44 * K;
const patchOf = (img) => ({ ...img, cx: 0, cy: 0, pxPerMm: K });

describe('看引脚判断朝向', () => {
  it('单独一颗 LED：各个角度的灯头方向误差 < 3°', () => {
    for (const head of [0, 30, 75, 120, 200, 260, 333]) {
      const img = canvas(N, N);
      const body = drawLed(img, K, N / 2, N / 2, head);
      const r = leadDirection(patchOf(img), body, 'led');
      expect(r.reliable).toBe(true);
      expect(angDiff(r.rotDeg, head)).toBeLessThan(3);
    }
  });

  it('电阻（两侧都有引脚）：长轴方向，0–180°', () => {
    const img = canvas(N, N);
    const H = img.height;
    const a = 140;
    paint(img, rectFn(N / 2, N / 2, a, -3.15 * K, 3.15 * K, 1.2 * K, H), [45, 90, 150]);
    paint(img, rectFn(N / 2, N / 2, a, -18 * K, 18 * K, 0.25 * K, H), [120, 120, 125]);
    const r = Math.hypot(3.15, 1.2) * K;
    const body = [[N / 2 - r, N / 2 - r * 0.8], [N / 2 + r, N / 2 - r * 0.8], [N / 2 + r, N / 2 + r * 0.8], [N / 2 - r, N / 2 + r * 0.8]];
    const res = leadDirection(patchOf(img), body, 'axis');
    expect(res.reliable).toBe(true);
    expect(angDiff(res.rotDeg, a, 180)).toBeLessThan(3);
  });

  it('两颗 LED 并排贴在一起（灯体相碰、同向）：各自的方向都对', () => {
    const img = canvas(N, N);
    const a = drawLed(img, K, N / 2 - 3 * K, N / 2, 95);
    const b = drawLed(img, K, N / 2 + 2.9 * K, N / 2 + 0.5 * K, 85, [40, 160, 70]);
    const ra = leadDirection(patchOf(img), a, 'led', { others: [b] });
    const rb = leadDirection(patchOf(img), b, 'led', { others: [a] });
    expect(angDiff(ra.rotDeg, 95)).toBeLessThan(4);
    expect(angDiff(rb.rotDeg, 85)).toBeLessThan(4);
  });

  it('一颗的灯头顶在另一颗侧面、旁边还有一颗的引脚横穿过来：方向都对', () => {
    const img = canvas(N, N);
    const H = img.height;
    const a = drawLed(img, K, N / 2, N / 2, 90);
    const b = drawLed(img, K, N / 2 + 7 * K, N / 2 + 1 * K, 180, [40, 70, 210]); // 灯头朝左顶到 a 的侧面
    // 第三颗零件的一根引脚从 a 的上方横穿过去（离 a 的框约 3 mm）
    paint(img, rectFn(N / 2, N / 2 + 9 * K, 0, -16 * K, 6 * K, 0.25 * K, H), [120, 120, 125]);
    const ra = leadDirection(patchOf(img), a, 'led', { others: [b] });
    const rb = leadDirection(patchOf(img), b, 'led', { others: [a] });
    expect(angDiff(ra.rotDeg, 90)).toBeLessThan(4);
    expect(angDiff(rb.rotDeg, 180)).toBeLessThan(4);
  });

  it('宽的软阴影不算引脚', () => {
    const img = canvas(N, N);
    const H = img.height;
    // 灯头右侧一大片阴影（比纸暗 35）
    paint(img, rectFn(N / 2, N / 2, 0, 3 * K, 14 * K, 4 * K, H), [190, 188, 183]);
    const body = drawLed(img, K, N / 2, N / 2, 0);
    const r = leadDirection(patchOf(img), body, 'led');
    expect(angDiff(r.rotDeg, 0)).toBeLessThan(3);
  });

  it('没有引脚（剪掉了）：判为不可靠，交给原来的方法', () => {
    const img = canvas(N, N);
    const body = drawLed(img, K, N / 2, N / 2, 45, undefined, { leads: false });
    const r = leadDirection(patchOf(img), body, 'led');
    expect(r === null || r.reliable === false).toBe(true);
  });

  it('细线强度：细线处大，阶跃边缘处接近 0', () => {
    const W = 40;
    const L = new Float32Array(W * W).fill(220);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (x >= 30) L[y * W + x] = 120; // 阶跃
    for (let y = 0; y < W; y++) L[y * W + 10] = 150; // 1 像素宽的暗线
    const R = ridgeStrength(L, W, W, 3);
    expect(R[20 * W + 10]).toBeCloseTo(70, 5);
    const dir = new Uint8Array(W * W);
    ridgeStrength(L, W, W, 3, dir);
    expect(dir[20 * W + 10]).toBe(0); // 竖线：横穿方向是水平的（0°）
    expect(R[20 * W + 30]).toBe(0);
    expect(R[20 * W + 29]).toBe(0);
  });

  it('点到多边形的距离：内负外正', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(polyDistance(sq, 5, 5)).toBeCloseTo(-5, 9);
    expect(polyDistance(sq, 13, 5)).toBeCloseTo(3, 9);
    expect(polyDistance(sq, 13, 14)).toBeCloseTo(5, 9);
  });

  it('从"照片"取样到底板坐标：方向约定正确（X 向右、Y 向上）', () => {
    // 照片：10 px/mm，底板 (X, Y) → 像素 (100 + 10X, 1900 − 10Y)；在照片上画一颗灯头朝 60° 的 LED
    const P = 10;
    const Hm = [[P, 0, 100], [0, -P, 1900], [0, 0, 1]];
    const photo = canvas(2200, 2000);
    const cx = 80;
    const cy = 90;
    // 照片上画：rectFn 用"向上为 +y"，照片像素 y 向下：照片的数学 y = 2000 − 像素 y；底板 (80, 90) → 像素 (900, 1000) → 数学 (900, 1000)
    drawLed(photo, P, 100 + P * cx, 2000 - (1900 - P * cy), 60);
    const patch = samplePatch(photo, Hm, cx, cy, 44, 8);
    // 检测框：取样图上以零件为中心的外接框（灯头 60°：外接框半宽 ≈ 4.25cos60 + 2.9sin60）
    const hw = (4.25 * 0.5 + 2.9 * 0.866) * 8;
    const hh = (4.25 * 0.866 + 2.9 * 0.5) * 8;
    const [u, v] = boardToPatch(patch, cx, cy);
    const body = [[u - hw, v - hh], [u + hw, v - hh], [u + hw, v + hh], [u - hw, v + hh]];
    const r = leadDirection(patch, body, 'led');
    expect(r.reliable).toBe(true);
    expect(angDiff(r.rotDeg, 60)).toBeLessThan(3);
  });
});

describe('LED 灯体颜色', () => {
  const cases = [
    ['red', [200, 35, 40]],
    ['green', [40, 170, 70]],
    ['blue', [40, 70, 210]],
    ['yellow', [225, 190, 40]],
  ];
  for (const [name, rgb] of cases) {
    it(`${name}`, () => {
      const img = canvas(N, N);
      const body = drawLed(img, K, N / 2, N / 2, 30, rgb);
      expect(ledColor(patchOf(img), body).color).toBe(name);
    });
  }

  it('透明：灯体只有暗边和反光，判为透明', () => {
    const img = canvas(N, N);
    const H = img.height;
    const body = drawLed(img, K, N / 2, N / 2, 30, [205, 208, 210]);
    paint(img, rectFn(N / 2, N / 2, 30, -4.25 * K, 4.25 * K, 0.6 * K, H), [250, 250, 250]); // 高光
    paint(img, rectFn(N / 2, N / 2, 30, -4.25 * K, 4.25 * K, 2.9 * K, H), [170, 172, 175], 0.3); // 暗边
    expect(ledColor(patchOf(img), body).color).toBe('clear');
  });

  it('纸面偏暖（灯光发黄）也能分对：先按纸面做白平衡', () => {
    const img = canvas(N, N);
    // 暖光：纸面 (235, 215, 170)；真实的绿色 (40, 170, 70) 在暖光下按同样比例变成约 (41, 159, 52)
    for (let i = 0; i < N * N; i++) img.data.set([235, 215, 170, 255], i * 4);
    const body = drawLed(img, K, N / 2, N / 2, 30, [41, 159, 52]);
    expect(ledColor(patchOf(img), body).color).toBe('green');
  });
});

describe('细线走向', () => {
  it('各个角度的细线：走向误差 < 6°', async () => {
    const { lineAngle } = await import('../src/vision/leads.js');
    const W = 60;
    for (const t of [0, 20, 45, 70, 90, 135, 160]) {
      const a = (t * Math.PI) / 180;
      const L = new Float32Array(W * W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const d = Math.abs(-(x - 30) * Math.sin(a) + (y - 30) * Math.cos(a)); // 到过中心、方向 a（图像坐标）的直线的距离
        L[y * W + x] = 220 - 100 * Math.max(0, 1 - d / 2.5);
      }
      const got = (lineAngle(L, W, W, 30, 30, 2) * 180) / Math.PI;
      expect(Math.abs(((got - t) % 180 + 270) % 180 - 90)).toBeLessThan(6);
    }
  });
});


describe('LED 颜色：框与邻居重叠', () => {
  it('透明 LED 的框压到旁边红色 LED 的一部分：重叠处不算，仍判为透明', () => {
    const img = canvas(N, N);
    const H = img.height;
    const clear = drawLed(img, K, N / 2, N / 2 + 3 * K, 180, [205, 208, 210]);
    paint(img, rectFn(N / 2, N / 2 + 3 * K, 180, -4.25 * K, 4.25 * K, 0.6 * K, H), [250, 250, 250]);
    const red = drawLed(img, K, N / 2, N / 2 - 3 * K, 0, [200, 35, 40]);
    // 透明那颗的框往下多框了 2 mm（压到红色的灯体），像模型给的框那样
    const box = clear.map(([x, y], i) => [x, i >= 2 ? y + 2 * K : y]);
    expect(ledColor(patchOf(img), box).color).not.toBe('clear'); // 不排除邻居：被红色带偏
    expect(ledColor(patchOf(img), box, { others: [red] }).color).toBe('clear');
  });
});

describe('LED 颜色：框被别的框整个盖住', () => {
  it('同一颗的重复框（与自己重合）：不会因为像素全被排除而判不出颜色', () => {
    const img = canvas(N, N);
    const body = drawLed(img, K, N / 2, N / 2, 30, [40, 170, 70]);
    expect(ledColor(patchOf(img), body, { others: [body] })?.color).toBe('green');
  });
});

describe('彩色灯体自身的长轴', () => {
  it('各个角度：灯体长轴误差 < 1.5°（引脚掰弯时用它微调角度）', async () => {
    const { bodyAxis } = await import('../src/vision/leads.js');
    for (const t of [0, 17, 45, 90, 133, 170]) {
      const img = canvas(N, N);
      const body = drawLed(img, K, N / 2, N / 2, t, [225, 200, 40]);
      const patch = patchOf(img);
      const c = ledColor(patch, body);
      const ax = bodyAxis(patch, body, { paper: c.paper });
      expect(ax.ratio).toBeGreaterThan(1.6);
      expect(Math.abs(((ax.axisDeg - t) % 180 + 270) % 180 - 90)).toBeLessThan(1.5);
    }
  });

  it('同色的邻居贴着：离邻居框更近的像素不算，长轴不被带偏', async () => {
    const { bodyAxis } = await import('../src/vision/leads.js');
    const img = canvas(N, N);
    // 邻居头尾相反、并排贴着、沿长轴错开 1.5 mm（用户实拍的两颗黄色 LED 那样）；两个框有一点重叠
    const me = drawLed(img, K, N / 2, N / 2, 3, [225, 200, 40], { leads: false });
    const nb = drawLed(img, K, N / 2 + 1.5 * K, N / 2 + 5.9 * K, 180, [225, 200, 40], { leads: false });
    const patch = patchOf(img);
    const c = ledColor(patch, me, { others: [nb] });
    const ax = bodyAxis(patch, me, { others: [nb], paper: c.paper });
    expect(Math.abs(((ax.axisDeg - 3) % 180 + 270) % 180 - 90)).toBeLessThan(1.5);
  });
});

describe('灯体长轴：斜拍时的拉伸', () => {
  it('灯体顶部沿视线被拉开一段（斜向）：减掉这段的影响后长轴仍准（不减会偏好几度）', async () => {
    const { bodyAxis } = await import('../src/vision/leads.js');
    const t = 20;
    const smear = [3, 3]; // mm：从相机往外的拉伸
    const img = canvas(N, N);
    // 本体形状沿 smear 方向一层层平移叠加（灯体各高度处在板面上的投影）
    let body = null;
    for (let i = 0; i <= 12; i++) {
      const f = i / 12;
      const b = drawLed(img, K, N / 2 + smear[0] * f * K, N / 2 + smear[1] * f * K, t, [225, 200, 40], { leads: false });
      body = body ?? b;
    }
    const xs = [];
    const ys = [];
    for (const [x, y] of body) { xs.push(x); ys.push(y); }
    const big = [[Math.min(...xs), Math.min(...ys) - smear[1] * K], [Math.max(...xs) + smear[0] * K, Math.min(...ys) - smear[1] * K], [Math.max(...xs) + smear[0] * K, Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
    const patch = patchOf(img);
    const paper = ledColor(patch, big).paper;
    const err = (ax) => Math.abs(((ax.axisDeg - t) % 180 + 270) % 180 - 90);
    const raw = bodyAxis(patch, big, { paper });
    const fixed = bodyAxis(patch, big, { paper, smear });
    expect(err(raw)).toBeGreaterThan(4);
    expect(err(fixed)).toBeLessThan(1.5);
  });
});
