// 合成图真值（纯函数）。全部用针孔公式 K·(R·P + t) 计算，不从 Three.js 读取，
// 这样渲染端的坐标转换如果写错，真值和图像就对不上，能被发现。
import { CAMERA, CLASSES, MARKERS } from '../config.js';
import { intrinsicsMatrix, lookAtPose, project, pitchDegFromR } from '../math/pinhole.js';
import { markerCornersWorld } from '../vision/boardLayout.js';
import { PART_SIZE } from '../scene/parts.js';
import { SYNTH_TARGET } from './presets.js';

/**
 * iPhone 13 Pro 主摄内参：等效焦距 26 mm，f = 26 × √(W² + H²) ÷ 43.27 ≈ 3028，主点在图像中心
 * @returns {import('../state.js').Intrinsics}
 */
export function synthIntrinsics() {
  const W = CAMERA.refWidth;
  const H = CAMERA.refHeight;
  const f = (CAMERA.expectedFocal35 * Math.hypot(W, H)) / 43.27;
  return { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H, source: 'truth' };
}

/**
 * 零件 3D 包围盒的 8 个角点（底板坐标）
 * @param {{cls:number, x:number, y:number, rotDeg?:number}} part
 */
export function partBoxCorners(part) {
  const { lx, ly, h } = PART_SIZE[part.cls];
  const a = ((part.rotDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts = [];
  for (const dx of [-lx / 2, lx / 2]) {
    for (const dy of [-ly / 2, ly / 2]) {
      for (const z of [0, h]) pts.push([part.x + c * dx - s * dy, part.y + s * dx + c * dy, z]);
    }
  }
  return pts;
}

/**
 * 生成一张合成图的真值
 * @param {{pitchDeg:number, yawDeg?:number, rollDeg?:number, distance:number}} preset
 * @param {{cls:number, x:number, y:number, rotDeg?:number}[]} parts 布局
 * @returns {import('../state.js').GroundTruth}
 */
export function makeGroundTruth(preset, parts) {
  const intrinsics = synthIntrinsics();
  const K = intrinsicsMatrix(intrinsics);
  const { R, t, position } = lookAtPose({ target: SYNTH_TARGET, ...preset });
  const proj = (P) => {
    const [u, v] = project(K, R, t, P);
    return [u, v];
  };
  const markers = Object.keys(MARKERS.centers).map((k) => {
    const id = Number(k);
    return { id, corners: markerCornersWorld(id).map(([X, Y]) => proj([X, Y, 0])) };
  });
  const truthParts = parts.map((p) => {
    const uv = partBoxCorners(p).map(proj);
    const us = uv.map((q) => q[0]);
    const vs = uv.map((q) => q[1]);
    return {
      cls: p.cls,
      x: p.x,
      y: p.y,
      heightMm: CLASSES[p.cls].heightMm,
      rotDeg: p.rotDeg ?? 0,
      box: [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)],
    };
  });
  return { intrinsics, R, t, position, pitchDeg: pitchDegFromR(R), markers, parts: truthParts };
}
