// 位姿叠加：用 K[R | t] 把底板外框、4 个码的方框和底板坐标轴（X 红、Y 绿、Z 蓝，长 100 mm）
// 投影画在原图上。和识别结果（蓝框）不同，这里的线完全由位姿算出，能直观看出位姿是否正确。
import { BOARD, MARKERS } from '../config.js';
import { project } from '../math/pinhole.js';
import { markerCornersWorld } from '../vision/boardLayout.js';

/**
 * @param {CanvasRenderingContext2D} ctx 已处于原图像素坐标
 * @param {number[][]} K
 * @param {import('../state.js').CameraPose} pose
 * @param {number} scale 当前缩放比
 * @param {number} dpr
 */
export function drawPose(ctx, K, pose, scale, dpr = 1) {
  const P = (X, Y, Z = 0) => project(K, pose.R, pose.t, [X, Y, Z]);
  const lw = (2 * dpr) / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const poly = (pts, color, width = lw, dash = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash.map((d) => d * lw));
    ctx.beginPath();
    pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // 底板外框
  poly([P(0, 0), P(BOARD.width, 0), P(BOARD.width, BOARD.height), P(0, BOARD.height)], '#f2b134', lw * 1.2, [6, 4]);
  // 码的方框
  for (const k of Object.keys(MARKERS.centers)) {
    poly(markerCornersWorld(Number(k)).map(([X, Y]) => P(X, Y)), '#f2b134', lw);
  }

  // 坐标轴
  const o = P(0, 0, 0);
  const axes = [
    ['X', P(100, 0, 0), '#e5484d'],
    ['Y', P(0, 100, 0), '#30a46c'],
    ['Z', P(0, 0, 100), '#3e63dd'],
  ];
  const fs = (14 * dpr) / scale;
  ctx.font = `700 ${fs}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [name, e, color] of axes) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * 2;
    ctx.beginPath();
    ctx.moveTo(o[0], o[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.stroke();
    // 箭头
    const a = Math.atan2(e[1] - o[1], e[0] - o[0]);
    const h = 10 * lw;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(e[0], e[1]);
    ctx.lineTo(e[0] - h * Math.cos(a - 0.45), e[1] - h * Math.sin(a - 0.45));
    ctx.lineTo(e[0] - h * Math.cos(a + 0.45), e[1] - h * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
    const lx = e[0] + 1.3 * fs * Math.cos(a);
    const ly = e[1] + 1.3 * fs * Math.sin(a);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(lx, ly, fs * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(name, lx, ly);
  }
}
