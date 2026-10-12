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
