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
