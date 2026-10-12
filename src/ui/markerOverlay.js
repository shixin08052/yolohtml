// 在调试视图上画识别到的码：四边形 + ID，第一个角点（码自身左上）画红点。坐标为原图像素。

/**
 * @param {CanvasRenderingContext2D} ctx 已处于原图像素坐标
 * @param {import('../state.js').Marker[]} markers
 * @param {number} scale 当前缩放比
 * @param {number} dpr 设备像素比
 */
export function drawMarkers(ctx, markers, scale, dpr = 1) {
  const lw = (2 * dpr) / scale;
  ctx.lineJoin = 'round';
  for (const m of markers) {
    const c = m.corners;
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#3d7bd9';
    ctx.beginPath();
    c.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
    ctx.closePath();
    ctx.stroke();

    // 码自身左上角
    ctx.fillStyle = '#e03c31';
    ctx.beginPath();
    ctx.arc(c[0][0], c[0][1], 4.5 * lw, 0, Math.PI * 2);
    ctx.fill();

    // ID 标签放在码中心
    const cx = c.reduce((a, p) => a + p[0], 0) / 4;
    const cy = c.reduce((a, p) => a + p[1], 0) / 4;
    const fs = 14 * dpr / scale;
    ctx.font = `600 ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `ID ${m.id}`;
    const w = ctx.measureText(text).width + fs * 0.8;
    ctx.fillStyle = 'rgba(61, 123, 217, 0.92)';
    ctx.fillRect(cx - w / 2, cy - fs * 0.75, w, fs * 1.5);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, cx, cy);
  }
}
