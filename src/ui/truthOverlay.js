// 把合成图真值画到 2D canvas 上（坐标为原图像素）：码的四边形 + 左上角红点，零件框（虚线）+ 类别名。
import { CLASSES } from '../config.js';

/**
 * @param {CanvasRenderingContext2D} ctx 已设好"原图像素 → 画布"变换
 * @param {import('../state.js').GroundTruth} truth
 * @param {number} scale 当前缩放比（原图 1 像素 = scale 个画布像素），用于保持线宽恒定
 * @param {number} [px=1] 期望的线宽（画布像素）
 */
export function drawTruth(ctx, truth, scale, px = 1.5) {
  const lw = px / scale;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';

  for (const m of truth.markers) {
    const c = m.corners;
    ctx.strokeStyle = '#3b9e5a';
    ctx.beginPath();
    c.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#e03c31';
    ctx.beginPath();
    ctx.arc(c[0][0], c[0][1], 3.5 * lw, 0, Math.PI * 2);
    ctx.fill();
  }

  const fs = 7.5 * lw; // 与检测框标签的字号一致
  ctx.font = `600 ${fs}px sans-serif`;
  ctx.textAlign = 'left';
  // 真值标签画在框的下方（检测框的标签在上方），两者同时显示时不重叠
  ctx.textBaseline = 'top';
  for (const p of truth.parts) {
    const [x1, y1, x2, y2] = p.box;
    ctx.strokeStyle = '#c96442';
    ctx.setLineDash([4 * lw, 3 * lw]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    const name = `真值 · ${CLASSES[p.cls]?.name ?? String(p.cls)}`;
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = 'rgba(201, 100, 66, 0.9)';
    ctx.fillRect(x1, y2, tw + 4 * lw, fs + 2 * lw);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, x1 + 2 * lw, y2 + lw);
  }
}
