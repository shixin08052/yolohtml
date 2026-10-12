// 标定板版面：底板坐标（mm，原点在靠近操作者的左下角，Y 远离操作者）
// 与打印页面坐标（mm，原点在页面左上角，向下为正）之间的换算。纯函数。
import { BOARD, MARKERS } from '../config.js';

/**
 * 底板坐标 → 页面坐标（页面顶部 = 底板远端 = +Y）
 * @param {number} X
 * @param {number} Y
 * @returns {[number, number]}
 */
export function boardToPage(X, Y) {
  return [X, BOARD.height - Y];
}

/**
 * 码本体在页面上的外接正方形（mm）
 * @param {number} id
 * @returns {{x:number, y:number, size:number}} 左上角页面坐标与边长
 */
export function markerRectOnPage(id) {
  const c = MARKERS.centers[id];
  if (!c) throw new Error(`配置中没有 ID ${id} 的码`);
  const s = MARKERS.size;
  const [px, py] = boardToPage(c[0], c[1]);
  return { x: px - s / 2, y: py - s / 2, size: s };
}

/**
 * 码本体 4 个角在页面上的坐标，顺序为码自身左上、右上、右下、左下
 * （码"上方"朝页面顶部）
 * @param {number} id
 * @returns {[number, number][]}
 */
export function markerCornersOnPage(id) {
  const { x, y, size } = markerRectOnPage(id);
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
}

/**
 * 码本体 4 个角的底板坐标（mm），顺序为码自身左上、右上、右下、左下。
 * 码"上方"朝 +Y，所以左上 = (cx − s/2, cy + s/2)。
 * @param {number} id
 * @returns {[number, number][]}
 */
export function markerCornersWorld(id) {
  const c = MARKERS.centers[id];
  if (!c) throw new Error(`配置中没有 ID ${id} 的码`);
  const h = MARKERS.size / 2;
  return [
    [c[0] - h, c[1] + h],
    [c[0] + h, c[1] + h],
    [c[0] + h, c[1] - h],
    [c[0] - h, c[1] - h],
  ];
}

/**
 * 由实测纸张四角（底板坐标，左下、右下、右上、左上）得到纸张的局部坐标框：
 * 中心、宽高、绕 Z 轴的转角（俯视逆时针为正）。四角是两组对边各取平均。
 * @param {number[][]} corners
 * @returns {{cx:number, cy:number, w:number, h:number, theta:number}}
 */
export function paperFrame(corners) {
  const [bl, br, tr, tl] = corners;
  const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const theta = (ang(bl, br) + ang(tl, tr)) / 2;
  return {
    cx: (bl[0] + br[0] + tr[0] + tl[0]) / 4,
    cy: (bl[1] + br[1] + tr[1] + tl[1]) / 4,
    w: (d(bl, br) + d(tl, tr)) / 2,
    h: (d(bl, tl) + d(br, tr)) / 2,
    theta,
  };
}

/** 设计尺寸的底板对应的坐标框（没测出纸边时使用） */
export function designFrame() {
  return { cx: BOARD.width / 2, cy: BOARD.height / 2, w: BOARD.width, h: BOARD.height, theta: 0 };
}

/**
 * 纸张局部坐标 (u, v)（原点在纸张左下角，u 沿下边，单位 mm）→ 底板坐标的 3×3 矩阵
 * @param {{cx:number, cy:number, w:number, h:number, theta:number}} f
 * @returns {number[][]}
 */
export function frameMatrix(f) {
  const c = Math.cos(f.theta);
  const s = Math.sin(f.theta);
  // 底板 = 中心 + R(θ)·(u − w/2, v − h/2)
  const tx = f.cx - c * (f.w / 2) + s * (f.h / 2);
  const ty = f.cy - s * (f.w / 2) - c * (f.h / 2);
  return [[c, -s, tx], [s, c, ty], [0, 0, 1]];
}
