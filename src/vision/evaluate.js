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
