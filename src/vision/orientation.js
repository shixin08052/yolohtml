// 零件朝向估计（纯函数，不碰 DOM）。
// 检测框是轴对齐的矩形，分不出斜放的角度，所以直接看照片：在底板正射图（俯视、毫米比例）上
// 取检测框对应的区域，按框外一圈纸面的颜色把零件像素分出来，再看零件像素的形状：
// - 长条零件（电阻、螺丝）：主轴方向（二阶矩）；螺丝再比较两端的"粗细"判断螺帽在哪头
// - 螺母：六棱柱，轮廓的 6 次谐波给出角的方向（周期 60°）
// - 圆形零件（电容、LED、垫片）没有朝向
// 正射图把有高度的零件沿视线往后"拉长"了一点，但电阻、螺丝只有 3–4 mm 高，影响不大。

/** 需要估计朝向的类别及方式 */
const MODE = { 0: 'axis', 3: 'screw', 4: 'hex' };

/** 中值 */
function median(a) {
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

/** 点是否在凸多边形内（顶点顺序任意） */
function inConvex(poly, x, y) {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/**
 * 在区域内分出零件像素（与纸面颜色差得多的像素），返回它们的底板坐标
 * @param {{width:number, height:number, data:ArrayLike<number>}} img 正射图 RGBA（alpha < 255 为照片外）
 * @param {number[][]} poly 区域（图像像素）
 * @param {number[][]} toBoard 图像像素（连续坐标）→ 底板 mm 的仿射矩阵
 * @param {{ ringPx?: number, minDiff?: number }} [opts]
 * @returns {{ pts: number[][], paper: number[]|null }}
 */
export function foregroundPoints(img, poly, toBoard, { ringPx = 8, minDiff = 40 } = {}) {
  const { width: W, height: H, data } = img;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return { pts: [], paper: null };

  // 纸面颜色：外接矩形外一圈的中值
  const ring = [[], [], []];
  for (let y = Math.max(0, y0 - ringPx); y < Math.min(H, y1 + ringPx); y++) {
    for (let x = Math.max(0, x0 - ringPx); x < Math.min(W, x1 + ringPx); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const o = (y * W + x) * 4;
      if (data[o + 3] < 255) continue;
      for (let c = 0; c < 3; c++) ring[c].push(data[o + c]);
    }
  }
  if (ring[0].length < 8) return { pts: [], paper: null };
  const paper = ring.map(median);

  const pts = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4;
      if (data[o + 3] < 255) continue;
      const diff = Math.max(Math.abs(data[o] - paper[0]), Math.abs(data[o + 1] - paper[1]), Math.abs(data[o + 2] - paper[2]));
      if (diff < minDiff) continue;
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inConvex(poly, px, py)) continue;
      pts.push([
        toBoard[0][0] * px + toBoard[0][1] * py + toBoard[0][2],
        toBoard[1][0] * px + toBoard[1][1] * py + toBoard[1][2],
      ]);
    }
  }
  return { pts, paper };
}

const deg = (r) => (r * 180) / Math.PI;
/** 角度归一化到 (−period/2, period/2] */
const wrap = (a, period) => {
  let x = ((a % period) + period) % period;
  if (x > period / 2) x -= period;
  return x;
};

/**
 * 由零件像素（底板坐标）估计朝向
 * @param {number[][]} pts
 * @param {number} cls
 * @returns {{ rotDeg: number, reliable: boolean, elong?: number, headRatio?: number, hexStrength?: number }|null}
 *   rotDeg：模型绕 Z 轴的转角（与 parts.js 的模型约定一致：长轴沿局部 X、螺帽在局部 −X、螺母的角朝局部 X）
 */
export function yawFromPoints(pts, cls) {
  const mode = MODE[cls];
  if (!mode || pts.length < 12) return null;
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;

  if (mode === 'hex') {
    // r⁴ 加权突出六个角；6 次谐波的辐角 ÷ 6 = 角的方向
    let re = 0;
    let im = 0;
    let wsum = 0;
    for (const [x, y] of pts) {
      const dx = x - mx;
      const dy = y - my;
      const r2 = dx * dx + dy * dy;
      const w = r2 * r2;
      const a = 6 * Math.atan2(dy, dx);
      re += w * Math.cos(a);
      im += w * Math.sin(a);
      wsum += w;
    }
    const strength = Math.hypot(re, im) / (wsum || 1);
    return { rotDeg: wrap(deg(Math.atan2(im, re)) / 6, 60), reliable: strength > 0.02, hexStrength: strength };
  }

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const tr = sxx + syy;
  const dt = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const l1 = tr / 2 + dt;
  const l2 = Math.max(1e-9, tr / 2 - dt);
  const elong = Math.sqrt(l1 / l2); // 长宽比的估计
  const reliable = elong > 1.8;

  if (mode === 'axis') return { rotDeg: wrap(deg(phi), 180), reliable, elong };

  // 螺丝：沿主轴投影，比较两端各 1/4 长度内的像素数（螺帽那头更粗）
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const proj = pts.map(([x, y]) => (x - mx) * c + (y - my) * s).sort((a, b) => a - b);
  const lo = proj[Math.floor(0.02 * (n - 1))];
  const hi = proj[Math.ceil(0.98 * (n - 1))];
  const q = (hi - lo) / 4;
  let nLo = 0;
  let nHi = 0;
  for (const p of proj) {
    if (p <= lo + q) nLo++;
    else if (p >= hi - q) nHi++;
  }
  const headRatio = Math.max(nLo, nHi) / Math.max(1, Math.min(nLo, nHi));
  // 模型的螺帽在局部 −X：螺帽在 +主轴 那头时整体转 180°
  const rot = nHi > nLo ? deg(phi) + 180 : deg(phi);
  return { rotDeg: wrap(rot, 360), reliable, elong, headRatio };
}

/**
 * 正射图上一个区域里零件的朝向
 * @param {{width:number, height:number, data:ArrayLike<number>}} img
 * @param {number[][]} poly
 * @param {number} cls
 * @param {number[][]} toBoard
 */
export function estimateYaw(img, poly, cls, toBoard) {
  if (!MODE[cls]) return null;
  const { pts } = foregroundPoints(img, poly, toBoard);
  return yawFromPoints(pts, cls);
}
