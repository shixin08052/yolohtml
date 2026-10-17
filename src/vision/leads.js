// 看引脚判断零件朝向，并判断 LED 灯体颜色（纯函数，不碰 DOM）。
//
// 检测框只框本体，引脚一定伸在框外，而且 LED 的两根引脚都从灯体的底座那一端伸出来；电阻的两根引脚从两端伸出来。
// 所以在框外一圈（0.8–8 mm）里找引脚：
// - LED：从本体中心指向引脚的方向就是"底座方向"，反过来就是灯头朝向——长轴和灯头方向一次都得到；
// - 电阻：两侧引脚连成的轴线就是长轴（两端对称，只要 0–180°）。
// 引脚是金属细丝（约 0.5 mm 粗），在白纸上表现为一条比两侧暗（或因反光比两侧亮）的细线，颜色是银灰色；
// 不管灯体是红、绿、蓝还是透明的，引脚都一样，所以对所有颜色的 LED 都适用。
// 引脚只有 0.5 mm 粗，网页的正射图（4 px/mm）上只有 2 像素，所以直接从原照片取一小块高分辨率正射图（默认 8 px/mm）：
//   samplePatch：以零件为中心，按单应性逐像素到原照片里双线性取样；
//   ridgeStrength：细线检测——像素比两侧（相距约 0.5 mm）都暗或都亮的程度，取四个方向里最大的；
//     宽的阴影、阴影边缘、纸面渐变都不是"细线"，不会被当成引脚；
//   leadDirection：框外一圈里、饱和度低（银灰色）的细线像素，按相对本体中心的方向做直方图找主方向。
// 旁边零件的本体所在的区域不算（挨在一起的零件不会互相干扰）；引脚可能弯，越靠近本体权重越大。

/** 默认参数 */
export const LEAD = {
  pxPerMm: 8, // 取样分辨率
  patchMm: 44, // 取样窗口边长上限（实际按检测框大小取）
  ringMinMm: 0.8, // 框外一圈的内径（框边略有误差，太近的不算）
  ringMaxMm: 8, // 外径
  ridgeMm: 0.55, // 细线检测时两侧取样点到中心的距离
  ridgeMin: 14, // 细线强度阈值（亮度 0–255）
  leadSatMax: 80, // 引脚是银灰色：饱和度（0–255）上限
  minLeadMm2: 0.9, // 主方向上至少要有这么多面积的引脚像素
  minPeakFrac: 0.35, // 主方向占全部引脚像素权重的比例下限
  windowDeg: 30, // 主轴拟合时取主方向 ±windowDeg 内的引脚像素（两根引脚相对中心各偏十几度，窗口要把两根都包进来）
  radialDeg: 32, // 细线走向与"从本体中心指过来"的方向之差的上限：自己的引脚是放射状伸出的，旁边零件横穿过来的引脚不算
};

const deg = (r) => (r * 180) / Math.PI;
const wrap = (a, p) => ((a % p) + p) % p;

/**
 * 从原照片取一块正射图：中心 (cx, cy)（底板 mm），边长 sizeMm，分辨率 pxPerMm。
 * 取样图的 u 向右 = 底板 +X，v 向下 = 底板 −Y。照片外的像素 alpha = 0。
 * @param {{ width: number, height: number, data: ArrayLike<number> }} img 原照片 RGBA
 * @param {number[][]} H 底板 mm → 照片像素（像素 (i, j) 覆盖 [i, i+1)）
 * @returns {{ width: number, height: number, data: Uint8ClampedArray, cx: number, cy: number, pxPerMm: number }}
 */
export function samplePatch(img, H, cx, cy, sizeMm, pxPerMm) {
  const N = Math.max(8, Math.round(sizeMm * pxPerMm));
  const out = new Uint8ClampedArray(N * N * 4);
  const { width: W, height: Hh, data } = img;
  for (let v = 0; v < N; v++) {
    const Y = cy - (v + 0.5 - N / 2) / pxPerMm;
    for (let u = 0; u < N; u++) {
      const X = cx + (u + 0.5 - N / 2) / pxPerMm;
      const w = H[2][0] * X + H[2][1] * Y + H[2][2];
      const x = (H[0][0] * X + H[0][1] * Y + H[0][2]) / w - 0.5;
      const y = (H[1][0] * X + H[1][1] * Y + H[1][2]) / w - 0.5;
      const o = (v * N + u) * 4;
      if (!(x >= 0 && y >= 0 && x < W - 1 && y < Hh - 1)) continue;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * W + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + W * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
        const bot = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: N, height: N, data: out, cx, cy, pxPerMm };
}

/** 底板 mm → 取样图像素（像素中心坐标系，与 samplePatch 一致） */
export function boardToPatch(patch, X, Y) {
  const { width: N, cx, cy, pxPerMm: k } = patch;
  return [(X - cx) * k + N / 2 - 0.5, -(Y - cy) * k + N / 2 - 0.5];
}

/** 二项式平滑（[1 4 6 4 1] / 16，横竖各一次，σ ≈ 1 像素）：求细线走向前先去掉锯齿 */
export function smooth5(L, W, H, rect = [0, 0, W - 1, H - 1]) {
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  // 只算 rect（含两端）范围；横向那一遍上下各多算 2 行，供竖向那一遍用
  const [rx0, ry0, rx1, ry1] = rect;
  for (let y = Math.max(0, ry0 - 2); y <= Math.min(H - 1, ry1 + 2); y++) {
    for (let x = rx0; x <= rx1; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k[j + 2] * L[y * W + Math.min(W - 1, Math.max(0, x + j))];
      tmp[y * W + x] = s / 16;
    }
  }
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      let s = 0;
      for (let j = -2; j <= 2; j++) s += k[j + 2] * tmp[Math.min(ry1 + 2, H - 1, Math.max(ry0 - 2, 0, y + j)) * W + x];
      out[y * W + x] = s / 16;
    }
  }
  return out;
}

/** 亮度（0–255） */
function luma(data, n) {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return L;
}

/** 细线检测的 8 个"横穿"方向（0°、22.5°、…、157.5°，图像坐标） */
export const RIDGE_DIRS = 8;

/**
 * 细线强度：对每个像素，在 8 个方向上比较它和两侧（相距 r 像素）的亮度，
 * 暗细线 = min(两侧) − 中心，亮细线 = 中心 − max(两侧)，取各方向里最大的。阶跃边缘、宽的阴影都接近 0。
 * dirOut 给出时记下最强的方向编号 j（横穿方向角 = j × 22.5°，图像坐标；细线本身的走向与它垂直）
 * @returns {Float32Array}
 */
export function ridgeStrength(L, W, H, r, dirOut = null, rect = [0, 0, W - 1, H - 1]) {
  const out = new Float32Array(W * H);
  const dirs = Array.from({ length: RIDGE_DIRS }, (_, j) => {
    const a = (j * Math.PI) / RIDGE_DIRS;
    return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
  });
  const [rx0, ry0, rx1, ry1] = rect;
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const c = L[y * W + x];
      let best = 0;
      let bj = 0;
      for (let j = 0; j < RIDGE_DIRS; j++) {
        const [dx, dy] = dirs[j];
        const xa = x + dx;
        const ya = y + dy;
        const xb = x - dx;
        const yb = y - dy;
        if (xa < 0 || ya < 0 || xb < 0 || yb < 0 || xa >= W || ya >= H || xb >= W || yb >= H) continue;
        const a = L[ya * W + xa];
        const b = L[yb * W + xb];
        const v = Math.max(Math.min(a, b) - c, c - Math.max(a, b));
        if (v > best) {
          best = v;
          bj = j;
        }
      }
      out[y * W + x] = best;
      if (dirOut) dirOut[y * W + x] = bj;
    }
  }
  return out;
}

/**
 * 细线在 (x, y) 处的走向（图像坐标的角度，弧度，±90° 不定）：用二阶导数（Hessian）——
 * 横穿细线的方向上亮度弯得最厉害，那是绝对值最大的特征值对应的方向，走向与它垂直。
 * s 为差分步长（约为线宽的一半）
 */
export function lineAngle(L, W, H, x, y, s) {
  const at = (u, v) => L[Math.min(H - 1, Math.max(0, v)) * W + Math.min(W - 1, Math.max(0, u))];
  const c = at(x, y);
  const xx = at(x + s, y) - 2 * c + at(x - s, y);
  const yy = at(x, y + s) - 2 * c + at(x, y - s);
  const xy = (at(x + s, y + s) - at(x + s, y - s) - at(x - s, y + s) + at(x - s, y - s)) / 4;
  // 特征值 λ₁ ≥ λ₂；θ₁ 为 λ₁ 的特征向量方向
  const th = 0.5 * Math.atan2(2 * xy, xx - yy);
  const m = (xx + yy) / 2;
  const dd = Math.hypot((xx - yy) / 2, xy);
  const across = Math.abs(m + dd) >= Math.abs(m - dd) ? th : th + Math.PI / 2;
  return across + Math.PI / 2;
}

/** 点到凸多边形的有符号距离（外为正、内为负，像素） */
export function polyDistance(poly, x, y) {
  let inside = true;
  let sign = 0;
  let dmin = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax;
    const ey = by - ay;
    const cr = ex * (y - ay) - ey * (x - ax);
    if (cr !== 0) {
      const sg = Math.sign(cr);
      if (sign === 0) sign = sg;
      else if (sg !== sign) inside = false;
    }
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    dmin = Math.min(dmin, Math.hypot(x - ax - t * ex, y - ay - t * ey));
  }
  return inside ? -dmin : dmin;
}

/** 多边形的形心（顶点平均，框是四边形足够了） */
const centroid = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];

/** OpenCV 约定的 HSV 里的 S（0–255） */
function sat(r, g, b) {
  const v = Math.max(r, g, b);
  return v === 0 ? 0 : (255 * (v - Math.min(r, g, b))) / v;
}

/**
 * 看引脚求朝向
 * @param {ReturnType<typeof samplePatch>} patch
 * @param {number[][]} body 本体（检测框）在取样图上的多边形
 * @param {'led'|'axis'} mode led：求灯头方向（0–360°）；axis：只求长轴（0–180°）
 * @param {{ others?: number[][][] } & Partial<typeof LEAD>} [opts] others：旁边零件的本体多边形（这些区域不算）
 * @returns {{ rotDeg: number, reliable: boolean, leadMm2: number, peakFrac: number }|null}
 *   rotDeg：零件模型绕 Z 的转角（底板坐标，度；LED 为灯头方向，电阻为长轴方向）
 */
export function leadDirection(patch, body, mode, opts = {}) {
  const o = { ...LEAD, ...opts };
  const others = opts.others ?? [];
  const { width: W, height: H, data } = patch;
  const k = patch.pxPerMm;
  const n = W * H;
  const L = luma(data, n);
  // 只看本体外接矩形外扩 maxD 的范围（细线检测、平滑都只算这一块）
  const minD = o.ringMinMm * k;
  const maxD = o.ringMaxMm * k;
  const xs = body.map((p) => p[0]);
  const ys = body.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - maxD));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) + maxD));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - maxD));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys) + maxD));
  if (x1 < x0 || y1 < y0) return null;
  const R = ridgeStrength(L, W, H, Math.max(2, Math.round(o.ridgeMm * k)), null, [x0, y0, x1, y1]);
  const hs = Math.max(1, Math.round(0.3 * k)); // 求走向的差分步长（约半个线宽）
  const Ls = smooth5(L, W, H, [Math.max(0, x0 - hs), Math.max(0, y0 - hs), Math.min(W - 1, x1 + hs), Math.min(H - 1, y1 + hs)]);
  const radialTol = (o.radialDeg * Math.PI) / 180;
  const [ucx, vcx] = centroid(body);
  const nb = 72; // 5° 一格
  const hist = new Float64Array(nb);
  const pts = [];
  const othersGrown = 0.8 * k;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      const r = R[i];
      if (r < o.ridgeMin || data[i * 4 + 3] === 0) continue;
      const d = polyDistance(body, x, y);
      if (d < minD || d > maxD) continue;
      if (sat(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) > o.leadSatMax) continue;
      // 旁边零件的本体及其附近不算；离别的零件本体比离自己更近的像素也算别人的（例如并排的另一颗的引脚）
      if (others.some((p) => {
        const od = polyDistance(p, x, y);
        return od < othersGrown || od < d;
      })) continue;
      // 方向（底板坐标：u 向右 = +X，v 向下 = −Y）；电阻用两倍角，把相反的两侧合到一起
      let a = Math.atan2(-(y - vcx), x - ucx);
      // 细线走向（底板坐标：图像 v 向下，角度取负）；与 a 相差（按 180° 周期）太大的不是自己的引脚
      const lineA = -lineAngle(Ls, W, H, x, y, hs);
      const dl = Math.abs(wrap(lineA - a + Math.PI / 2, Math.PI) - Math.PI / 2);
      if (dl > radialTol) continue;
      if (mode === 'axis') a *= 2;
      a = wrap(a, 2 * Math.PI);
      const w = Math.min(r, 60) * (1 - 0.7 * (d - minD) / (maxD - minD)); // 越靠近本体越可信（引脚可能弯）
      hist[Math.floor((a / (2 * Math.PI)) * nb) % nb] += w;
      pts.push(a, w, lineA);
    }
  }
  const total = hist.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  // 平滑后找主方向
  let peak = 0;
  let best = -1;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += hist[(b + j + nb) % nb] * (3 - Math.abs(j));
    if (s > best) {
      best = s;
      peak = b;
    }
  }
  // 直方图一格 5°，峰不一定对准两根引脚的正中：在峰附近迭代求加权圆周平均，把窗口中心对准，免得只包进一根引脚
  const win = ((mode === 'axis' ? 2 : 1) * o.windowDeg * Math.PI) / 180;
  let peakA = ((peak + 0.5) / nb) * 2 * Math.PI;
  for (let it = 0; it < 4; it++) {
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < pts.length; j += 3) {
      if (Math.abs(Math.atan2(Math.sin(pts[j] - peakA), Math.cos(pts[j] - peakA))) > win) continue;
      cx += Math.cos(pts[j]) * pts[j + 1];
      cy += Math.sin(pts[j]) * pts[j + 1];
    }
    if (cx === 0 && cy === 0) break;
    peakA = Math.atan2(cy, cx);
  }
  // 主方向 ±窗口内的引脚像素：平均它们的细线走向（两倍角平均，±180° 不定），就是零件轴向。
  // 不用"相对中心的方位"求平均（两根引脚各偏离中心 1.27 mm，会带偏），也不对位置做主轴拟合
  // （斜放时轴对齐的检测框把两根引脚截成前后错开的两段，拟合会被拉歪）
  let sw = 0;
  let cx2 = 0;
  let cy2 = 0;
  let cnt = 0;
  for (let j = 0; j < pts.length; j += 3) {
    if (Math.abs(Math.atan2(Math.sin(pts[j] - peakA), Math.cos(pts[j] - peakA))) > win) continue;
    const w = pts[j + 1];
    cx2 += w * Math.cos(2 * pts[j + 2]);
    cy2 += w * Math.sin(2 * pts[j + 2]);
    sw += w;
    cnt++;
  }
  if (!cnt) return null;
  let a = 0.5 * Math.atan2(cy2, cx2);
  // 取指向引脚那一侧的方向（与直方图的主方向一致；电阻的主方向是两倍角，换回来比较）
  const side = mode === 'axis' ? peakA / 2 : peakA;
  if (Math.cos(a - side) < 0) a += Math.PI;
  const leadMm2 = cnt / (k * k);
  const peakFrac = sw / total;
  const reliable = leadMm2 >= o.minLeadMm2 && peakFrac >= o.minPeakFrac;
  // LED：引脚方向是底座方向，灯头朝反方向
  const rotDeg = mode === 'led' ? wrap(deg(a) + 180, 360) : wrap(deg(a), 180);
  return { rotDeg, reliable, leadMm2, peakFrac };
}

/**
 * LED 灯体颜色：在本体多边形里，按纸面颜色做白平衡后，数饱和像素的色相
 * 饱和像素占本体面积很少时判为透明（透明灯体只有反光和暗边，没有颜色）
 * @param {ReturnType<typeof samplePatch>} patch
 * @param {number[][]} body
 * @param {{ others?: number[][][] }} [opts]
 * @returns {{ color: 'red'|'green'|'blue'|'yellow'|'clear', satFrac: number, votes: Record<string, number> }|null}
 */
export function ledColor(patch, body, { others = [] } = {}) {
  const { width: W, height: H, data } = patch;
  const k = patch.pxPerMm;
  // 纸面颜色：本体外 2–5 mm 一圈里、不属于其他零件的像素的中值
  const ring = [[], [], []];
  const inBody = [];
  // 落在别的框里的也另记一份：框整个被别的框盖住时（多半是同一个零件的重复框）退回用它们
  const inBodyAll = [];
  const ringAll = [[], [], []];
  const xs = body.map((p) => p[0]);
  const ys = body.map((p) => p[1]);
  const m = 5 * k;
  // 颜色统计隔一行、隔一列取样就够（8 px/mm 下仍有几百个灯体像素）
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - m)); y <= Math.min(H - 1, Math.ceil(Math.max(...ys) + m)); y += 2) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - m)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + m)); x += 2) {
      const i = (y * W + x) * 4;
      if (data[i + 3] === 0) continue;
      const d = polyDistance(body, x, y);
      // 灯体像素：在自己框里、但不在别的零件框里（挨在一起时框会互相重叠，邻居的颜色不能算进来）
      if (d <= -0.3 * k) {
        inBodyAll.push(i);
        if (!others.some((p) => polyDistance(p, x, y) < 0.3 * k)) inBody.push(i);
      } else if (d >= 2 * k && d <= m) {
        for (let c = 0; c < 3; c++) ringAll[c].push(data[i + c]);
        if (!others.some((p) => polyDistance(p, x, y) < 0.8 * k)) for (let c = 0; c < 3; c++) ring[c].push(data[i + c]);
      }
    }
  }
  if (inBody.length < 20) inBody.splice(0, inBody.length, ...inBodyAll);
  if (ring[0].length < 20) ring.forEach((a, c) => a.splice(0, a.length, ...ringAll[c]));
  if (inBody.length < 20 || ring[0].length < 20) return null;
  const med = (a) => Float64Array.from(a).sort()[a.length >> 1];
  const paper = ring.map((a) => Math.max(40, med(a)));
  const votes = { red: 0, yellow: 0, green: 0, blue: 0 };
  let nSat = 0;
  for (const i of inBody) {
    // 白平衡：纸面当作中性灰（约 230）
    const r = Math.min(255, (data[i] * 230) / paper[0]);
    const g = Math.min(255, (data[i + 1] * 230) / paper[1]);
    const b = Math.min(255, (data[i + 2] * 230) / paper[2]);
    const v = Math.max(r, g, b);
    const s = sat(r, g, b);
    if (s < 90 || v < 45) continue;
    nSat++;
    const d = v - Math.min(r, g, b);
    let h = v === r ? (60 * (g - b)) / d : v === g ? 120 + (60 * (b - r)) / d : 240 + (60 * (r - g)) / d;
    h = wrap(h, 360);
    if (h < 22 || h >= 300) votes.red++;
    else if (h < 70) votes.yellow++;
    else if (h < 185) votes.green++;
    else votes.blue++;
  }
  const satFrac = nSat / inBody.length;
  if (satFrac < 0.08) return { color: 'clear', satFrac, votes };
  const color = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  return { color, satFrac, votes };
}
