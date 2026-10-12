// 模块 1：相机内参（纯函数，不碰 DOM）。
// 像素坐标约定：像素 (i, j) 覆盖 [i, i+1) × [j, j+1)，主点在图像中心时 cx = W/2、cy = H/2。
import { CAMERA } from '../config.js';

/** 35 mm 全画幅对角线长度（mm） */
export const FULL_FRAME_DIAGONAL = 43.27;

/**
 * 由 EXIF 等效焦距估算内参：f = focal35 × √(W² + H²) ÷ 43.27，主点在图像中心
 * @param {number} focal35 35 mm 等效焦距（mm）
 * @param {number} width 照片宽（像素，已转正）
 * @param {number} height 照片高
 * @returns {import('../state.js').Intrinsics}
 */
export function fromExif(focal35, width, height) {
  if (!(focal35 > 0)) throw new Error('等效焦距无效');
  const f = (focal35 * Math.hypot(width, height)) / FULL_FRAME_DIAGONAL;
  return { fx: f, fy: f, cx: width / 2, cy: height / 2, width, height, source: 'exif' };
}

/**
 * EXIF Orientation → 显示时相对传感器图像顺时针旋转的角度。
 * 1 = 不转，6 = 顺时针 90°（竖拍），3 = 180°，8 = 顺时针 270°（另一侧竖拍）。
 * 带镜像的取值（2、4、5、7）手机不会产生，按不转处理。
 * @param {number|null|undefined} orientation
 * @returns {0|90|180|270}
 */
export function rotationFromOrientation(orientation) {
  return { 6: 90, 3: 180, 8: 270 }[orientation] ?? 0;
}

/**
 * 把参考分辨率下（传感器方向）的内参顺时针旋转 rot 度。
 * 例如顺时针 90°：像素 (x, y) → (H − y, x)，所以 fx' = fy，fy' = fx，cx' = H − cy，cy' = cx。
 * @param {{fx:number, fy:number, cx:number, cy:number}} k
 * @param {number} W 旋转前的宽
 * @param {number} H 旋转前的高
 * @param {0|90|180|270} rot
 * @returns {{fx:number, fy:number, cx:number, cy:number, width:number, height:number}}
 */
export function rotateIntrinsics(k, W, H, rot) {
  switch (rot) {
    case 90:
      return { fx: k.fy, fy: k.fx, cx: H - k.cy, cy: k.cx, width: H, height: W };
    case 180:
      return { fx: k.fx, fy: k.fy, cx: W - k.cx, cy: H - k.cy, width: W, height: H };
    case 270:
      return { fx: k.fy, fy: k.fx, cx: k.cy, cy: W - k.cx, width: H, height: W };
    default:
      return { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: W, height: H };
  }
}

/**
 * 由棋盘格标定结果得到当前照片的内参。
 * 标定文件（public/intrinsics.json，步骤 13 生成）的格式：
 *   { fx, fy, cx, cy, width, height, dist?: number[], rms?: number }
 *   width / height 为参考分辨率（4032 × 3024，横向）。
 * 先按照片方向旋转（竖拍默认顺时针 90°；有 EXIF 方向时按 rotation 指定），再按分辨率缩放：
 * s = 实际宽 ÷ 旋转后的参考宽，fx、fy、cx、cy 都乘以 s。
 * @param {{fx:number, fy:number, cx:number, cy:number, width?:number, height?:number}} calib
 * @param {number} width 照片宽（像素，已转正）
 * @param {number} height 照片高
 * @param {0|90|180|270} [rotation] 照片相对传感器顺时针旋转的角度；省略时按宽高判断（竖图 = 90°）
 * @returns {import('../state.js').Intrinsics}
 */
export function fromCalib(calib, width, height, rotation) {
  const refW = calib.width ?? CAMERA.refWidth;
  const refH = calib.height ?? CAMERA.refHeight;
  const portrait = height > width;
  const refPortrait = refH > refW;
  let rot = rotation ?? (portrait !== refPortrait ? 90 : 0);
  // EXIF 方向与实际宽高不符（例如经软件转存后方向已被"烧"进像素）：以宽高为准
  if ((rot === 90 || rot === 270) !== (portrait !== refPortrait)) rot = portrait !== refPortrait ? 90 : 0;
  const r = rotateIntrinsics(calib, refW, refH, rot);
  const s = width / r.width;
  return { fx: r.fx * s, fy: r.fy * s, cx: r.cx * s, cy: r.cy * s, width, height, source: 'calib' };
}

/**
 * 照片宽高比是否与标定的参考分辨率一致（不一致说明照片被裁剪过，标定内参不可用）
 * @returns {string|null} 不一致时返回提示
 */
export function calibAspectWarning(calib, width, height) {
  const refW = calib.width ?? CAMERA.refWidth;
  const refH = calib.height ?? CAMERA.refHeight;
  const a = Math.max(width, height) / Math.min(width, height);
  const b = Math.max(refW, refH) / Math.min(refW, refH);
  if (Math.abs(a / b - 1) > 0.01) {
    return `照片宽高比（${width} × ${height}）与标定分辨率（${refW} × ${refH}）不一致，照片可能被裁剪过，标定内参不准确。`;
  }
  return null;
}

/**
 * 镜头检查：等效焦距不是主摄的 26 mm 时提醒
 * @param {number|null|undefined} focal35
 * @returns {string|null}
 */
export function lensWarning(focal35) {
  if (focal35 == null) return null;
  if (Math.abs(focal35 - CAMERA.expectedFocal35) > 0.5) {
    return `可能切换了镜头（当前等效焦距 ${focal35} mm）`;
  }
  return null;
}

/**
 * 按来源计算当前照片的内参
 * @param {'exif'|'calib'|'truth'} source
 * @param {{image: import('../state.js').ImageInput, calib?: object|null, truth?: import('../state.js').GroundTruth|null}} ctx
 * @returns {{ intrinsics: import('../state.js').Intrinsics, notes: {level:'warn'|'info', text:string}[] }}
 */
export function computeIntrinsics(source, { image, calib = null, truth = null }) {
  const { width, height, exif } = image;
  const notes = [];
  if (source === 'truth') {
    if (!truth) throw new Error('这张照片没有真值');
    return { intrinsics: { ...truth.intrinsics, source: 'truth' }, notes };
  }
  if (source === 'calib') {
    if (!calib) throw new Error('没有标定文件 intrinsics.json');
    const w = calibAspectWarning(calib, width, height);
    if (w) notes.push({ level: 'warn', text: w });
    const lw = lensWarning(exif.focal35);
    if (lw) notes.push({ level: 'warn', text: `${lw}；标定文件是主摄的结果，可能不适用。` });
    return { intrinsics: fromCalib(calib, width, height, exif.orientation ? rotationFromOrientation(exif.orientation) : undefined), notes };
  }
  let focal35 = exif.focal35;
  if (focal35 == null) {
    focal35 = CAMERA.expectedFocal35;
    notes.push({ level: 'warn', text: `照片里没有等效焦距（EXIF 可能在转发时丢失，例如微信未选"原图"），按默认 ${focal35} mm 估算。` });
  } else {
    const lw = lensWarning(focal35);
    if (lw) notes.push({ level: 'warn', text: lw });
  }
  return { intrinsics: fromExif(focal35, width, height), notes };
}

/**
 * 默认的内参来源：合成图用真值；有标定文件且照片是主摄、未裁剪时用标定文件；否则用 EXIF
 * @returns {'exif'|'calib'|'truth'}
 */
export function defaultSource({ image, calib = null, truth = null }) {
  if (truth) return 'truth';
  if (calib && !lensWarning(image.exif.focal35) && !calibAspectWarning(calib, image.width, image.height)) return 'calib';
  return 'exif';
}
