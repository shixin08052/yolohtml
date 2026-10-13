// 模块 4：检测框 → 底板坐标（纯函数，不碰 DOM）。
// 方法 1（不修正）：框中心经 Hinv 映射到 Z = 0 平面。零件有高度，框中心其实对应零件半高处，
//   斜拍时视线斜着穿过半高平面再落到板面，结果会沿视线方向往远处偏。
// 方法 2（视差修正）：视线方向 d = Rᵀ·K⁻¹·(u, v, 1)，与 Z = h/2 平面求交：
//   P = C + ((h/2 − C_z) ÷ d_z)·d，h 取该类别的 heightMm。
// 两种方法的结果在同一条视线上，只是落点高度不同。
import { BOARD, CLASSES, MARKERS, WORK_AREA } from '../config.js';
import { mulVec3, transpose3 } from '../math/linalg.js';
import { applyH } from './homography.js';

/** 检测框中心（像素） */
export function boxCenter([x1, y1, x2, y2]) {
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

/**
 * 方法 1：像素经 Hinv 落到板面
 * @param {number[][]} Hinv 像素 → 底板
 * @param {[number, number]} uv
 * @returns {[number, number]}
 */
export function mapToPlane(Hinv, uv) {
  return applyH(Hinv, uv);
}

/**
 * 方法 2：像素的视线与 Z = z0 平面求交
 * @param {number[][]} K
 * @param {number[][]} R
 * @param {number[]} C 光心（底板坐标）
 * @param {[number, number]} uv
 * @param {number} z0 平面高度（零件半高）
 * @returns {[number, number, number]|null} 视线不朝下（打不到平面）时为 null
 */
export function mapWithParallax(K, R, C, [u, v], z0) {
  const x = (u - K[0][2]) / K[0][0];
  const y = (v - K[1][2]) / K[1][1];
  const d = mulVec3(transpose3(R), [x, y, 1]);
  if (!(d[2] < -1e-9)) return null;
  const s = (z0 - C[2]) / d[2];
  if (!(s > 0)) return null;
  return [C[0] + s * d[0], C[1] + s * d[1], z0];
}

/**
 * 是否在零件允许出现的区域内：底板内缩 margin，再挖掉 4 个码（各外扩 markerPadding）
 * @param {number} x
 * @param {number} y
 */
export function inWorkArea(x, y) {
  const m = WORK_AREA.margin;
  if (!(x >= m && x <= BOARD.width - m && y >= m && y <= BOARD.height - m)) return false;
  const half = MARKERS.size / 2 + WORK_AREA.markerPadding;
  for (const [cx, cy] of Object.values(MARKERS.centers)) {
    if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) return false;
  }
  return true;
}

/**
 * 长条零件（电阻、螺丝、躺平的 LED）的朝向：检测框只有轴对齐的外接矩形，分不出 ±θ，
 * 这里只按框四角落到板面后的 X、Y 跨度判断大致沿 X（0°）还是沿 Y（90°）。
 * @param {number[][]} Hinv
 * @param {[number,number,number,number]} box
 * @returns {0|90}
 */
export function boxYawDeg(Hinv, [x1, y1, x2, y2]) {
  const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map((p) => applyH(Hinv, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx = Math.max(...xs) - Math.min(...xs);
  const dy = Math.max(...ys) - Math.min(...ys);
  return dy > dx ? 90 : 0;
}

/**
 * 检测结果 → 零件
 * @param {import('../state.js').Detection[]} detections
 * @param {{ Hinv: number[][], K: number[][], R: number[][], position: number[] }} cam
 * @param {{ parallax?: boolean }} [opts] parallax 为 true 时 x, y 取方法 2 的结果
 * @returns {{ parts: import('../state.js').Part[], dropped: { det: import('../state.js').Detection, x: number, y: number }[] }}
 *   落在工作区外（按方法 2 的结果判断，两种方法共用同一套零件）的检测放进 dropped
 */
export function mapDetections(detections, { Hinv, K, R, position }, { parallax = true } = {}) {
  const parts = [];
  const dropped = [];
  detections.forEach((det, i) => {
    const cls = CLASSES[det.cls];
    if (!cls) return;
    const uv = boxCenter(det.box);
    const [xPlane, yPlane] = mapToPlane(Hinv, uv);
    const P = mapWithParallax(K, R, position, uv, cls.heightMm / 2);
    const [xParallax, yParallax] = P ?? [xPlane, yPlane];
    if (!inWorkArea(xParallax, yParallax)) {
      dropped.push({ det, x: xParallax, y: yParallax });
      return;
    }
    parts.push({
      id: parts.length,
      cls: det.cls,
      name: det.name ?? cls.name,
      score: det.score,
      x: parallax ? xParallax : xPlane,
      y: parallax ? yParallax : yPlane,
      heightMm: cls.heightMm,
      xPlane,
      yPlane,
      xParallax,
      yParallax,
      rotDeg: cls.id === 0 || cls.id === 2 || cls.id === 3 ? boxYawDeg(Hinv, det.box) : 0,
      detIndex: i,
      reachable: true, // 步骤 12 用逆运动学判断
    });
  });
  return { parts, dropped };
}

/**
 * 切换方法：返回 x, y 换成另一种结果的新零件数组
 * @param {import('../state.js').Part[]} parts
 * @param {boolean} parallax
 */
export function selectMethod(parts, parallax) {
  return parts.map((p) => ({ ...p, x: parallax ? p.xParallax : p.xPlane, y: parallax ? p.yParallax : p.yPlane }));
}
