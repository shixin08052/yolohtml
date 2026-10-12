// 与合成图真值比较（纯函数）。各模块完成后，信息面板用这里的函数显示"与真值的误差"。

/**
 * 码角点误差：按 ID 配对，逐角点求像素距离
 * @param {import('../state.js').Marker[]} found 识别结果
 * @param {import('../state.js').Marker[]} truth 真值
 * @returns {{ perId: {id:number, mean:number, max:number}[], mean:number|null, max:number|null, missing:number[] }}
 */
export function markerCornerErrors(found, truth) {
  const perId = [];
  const all = [];
  const missing = [];
  for (const t of truth) {
    const m = found.find((x) => x.id === t.id);
    if (!m) {
      missing.push(t.id);
      continue;
    }
    const e = m.corners.map((c, i) => Math.hypot(c[0] - t.corners[i][0], c[1] - t.corners[i][1]));
    all.push(...e);
    perId.push({ id: t.id, mean: e.reduce((a, b) => a + b, 0) / e.length, max: Math.max(...e) });
  }
  return {
    perId,
    mean: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
    max: all.length ? Math.max(...all) : null,
    missing,
  };
}

/**
 * 单应性与真值的误差：在底板上每隔 step mm 取一个点（Z = 0），
 * 分别用 H 和真值位姿 K·(R·P + t) 投影，比较像素距离
 * @param {number[][]} H
 * @param {import('../state.js').GroundTruth} truth
 * @param {{boardW:number, boardH:number, step?:number}} board
 * @returns {{mean:number, max:number}}
 */
export function homographyTruthError(H, truth, { boardW, boardH, step = 10 }) {
  const { fx, fy, cx, cy } = truth.intrinsics;
  const { R, t } = truth;
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let X = 0; X <= boardW + 1e-9; X += step) {
    for (let Y = 0; Y <= boardH + 1e-9; Y += step) {
      const xc = R[0][0] * X + R[0][1] * Y + t[0];
      const yc = R[1][0] * X + R[1][1] * Y + t[1];
      const zc = R[2][0] * X + R[2][1] * Y + t[2];
      const u = (fx * xc) / zc + cx;
      const v = (fy * yc) / zc + cy;
      const w = H[2][0] * X + H[2][1] * Y + H[2][2];
      const e = Math.hypot((H[0][0] * X + H[0][1] * Y + H[0][2]) / w - u, (H[1][0] * X + H[1][1] * Y + H[1][2]) / w - v);
      sum += e;
      max = Math.max(max, e);
      n++;
    }
  }
  return { mean: sum / n, max };
}

/**
 * 位姿与真值的误差
 * @param {import('../state.js').CameraPose} pose
 * @param {{R:number[][], position:number[], pitchDeg:number}} truth
 * @returns {{posErrMm:number, heightErrMm:number, pitchErrDeg:number, angleErrDeg:number}}
 */
export function poseTruthError(pose, truth) {
  const dp = pose.position.map((x, i) => x - truth.position[i]);
  // 旋转误差：R_est·R_trueᵀ 的旋转角
  const A = pose.R;
  const B = truth.R;
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += A[i][k] * B[i][k];
  const angle = Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
  return {
    posErrMm: Math.hypot(...dp),
    heightErrMm: dp[2],
    pitchErrDeg: pose.pitchDeg - truth.pitchDeg,
    angleErrDeg: (angle * 180) / Math.PI,
  };
}

/**
 * 零件位置与真值的误差：每个零件配对同类别里最近的真值零件（按方法 2 的位置，
 * 贪心、一对一，距离超过 maxDist 不配对），分别统计两种方法的误差
 * @param {import('../state.js').Part[]} parts
 * @param {import('../state.js').GroundTruth} truth
 * @param {number} [maxDist=20]
 * 有朝向的零件（电阻周期 180°、螺丝 360°、螺母 60°）同时统计朝向误差（真值带 rotDeg 时）
 * @returns {{ plane: {mean:number, max:number}|null, parallax: {mean:number, max:number}|null,
 *             yaw: {mean:number, max:number, n:number}|null,
 *             matched: number, unmatchedParts: number, missedTruth: number }}
 */
export function partsTruthError(parts, truth, maxDist = 20) {
  const pairs = [];
  for (const p of parts) {
    truth.parts.forEach((t, j) => {
      if (t.cls !== p.cls) return;
      pairs.push({ p, j, d: Math.hypot(p.xParallax - t.x, p.yParallax - t.y) });
    });
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedP = new Set();
  const usedT = new Set();
  const plane = [];
  const parallax = [];
  const yaw = [];
  const YAW_PERIOD = { 0: 180, 3: 360, 4: 60 };
  for (const { p, j, d } of pairs) {
    if (d > maxDist || usedP.has(p) || usedT.has(j)) continue;
    usedP.add(p);
    usedT.add(j);
    const t = truth.parts[j];
    plane.push(Math.hypot(p.xPlane - t.x, p.yPlane - t.y));
    parallax.push(d);
    const period = YAW_PERIOD[p.cls];
    if (period && t.rotDeg != null && p.rotDeg != null) {
      const e = (((p.rotDeg - t.rotDeg) % period) + period) % period;
      yaw.push(Math.min(e, period - e));
    }
  }
  const stat = (a) => (a.length ? { mean: a.reduce((s, x) => s + x, 0) / a.length, max: Math.max(...a) } : null);
  return {
    plane: stat(plane),
    parallax: stat(parallax),
    yaw: yaw.length ? { ...stat(yaw), n: yaw.length } : null,
    matched: usedP.size,
    unmatchedParts: parts.length - usedP.size,
    missedTruth: truth.parts.length - usedT.size,
  };
}
