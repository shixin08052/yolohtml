// 虚拟手机：机身（圆角盒）、镜头（位于光心 C）、视锥（光心到照片四角在底板上的落点）、
// 底板上的照片视野轮廓。位置和朝向全部由位姿 (R, t) 与内参 K 决定。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { toThree, cameraQuaternionFromR } from '../math/coords.js';
import { photoFootprint, intrinsicsMatrix } from '../math/pinhole.js';

/** iPhone 13 Pro 外形（mm）与主摄镜头位置（从背面看，镜头中心距左边、上边各约 14 mm） */
export const PHONE = { width: 71.5, height: 146.7, depth: 7.65, lensFromEdge: 14, lensRadius: 5.5 };

/**
 * 机身在照片坐标系里的摆放（纯函数）。照片坐标：x 向右、y 向下，与相机的 x、y 轴一致。
 * 竖着拿手机时，从屏幕一侧看，背面的主摄在右上角；横拍（EXIF 方向 1）是竖拿逆时针转 90°，
 * 镜头到了左上角；方向 3 再转 180°；方向 8 是竖拿倒过来。
 * @param {number|null|undefined} orientation EXIF 方向（1 / 3 / 6 / 8）；没有时按照片宽高判断
 * @param {number} W 照片宽
 * @param {number} H 照片高
 * @returns {{ size:[number, number], lens:[number, number] }}
 *   size：机身沿照片 x、y 方向的尺寸；lens：镜头相对机身中心的偏移（照片坐标方向，mm）
 */
export function phoneLayout(orientation, W, H) {
  const o = orientation ?? (W >= H ? 1 : 6);
  const lx = PHONE.width / 2 - PHONE.lensFromEdge;
  const ly = -(PHONE.height / 2 - PHONE.lensFromEdge);
  // 竖拿（方向 6）时机身坐标与照片坐标一致；其他方向把机身坐标 (px, py) 转到照片坐标
  const map = {
    6: ([px, py]) => [px, py],
    1: ([px, py]) => [py, -px], // 逆时针 90°：机身顶部朝左
    3: ([px, py]) => [-py, px], // 顺时针 90°：机身顶部朝右
    8: ([px, py]) => [-px, -py], // 倒拿
  }[o] ?? (([px, py]) => [px, py]);
  const portrait = o === 6 || o === 8;
  return {
    size: portrait ? [PHONE.width, PHONE.height] : [PHONE.height, PHONE.width],
    lens: map([lx, ly]),
  };
}

/**
 * @returns {{ group: THREE.Group, setPose: Function, setOpacity: (a:number) => void, clear: () => void }}
 */
export function createPhone() {
  const group = new THREE.Group();
  group.name = 'phone-all';

  // —— 机身：局部坐标 = Three.js 相机坐标（x 右、y 上、z 指向拍摄者），原点在镜头（光心）
  const body = new THREE.Group();
  body.name = 'phone';
  const shellMat = new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.45, metalness: 0.5, transparent: true });
  const screenMat = new THREE.MeshStandardMaterial({ color: '#0d0f12', roughness: 0.2, metalness: 0.1, transparent: true });
  const lensMat = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.15, metalness: 0.6, transparent: true });
  const ringMat = new THREE.MeshStandardMaterial({ color: '#b9bcc2', roughness: 0.3, metalness: 0.9, transparent: true });
  const shell = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 4, 0.08), shellMat);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
  // 镜头：沿局部 z 轴的小圆柱，从光心向拍摄方向（−z）凸出 2 mm
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(PHONE.lensRadius, PHONE.lensRadius, 2, 32), lensMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -1;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PHONE.lensRadius, 0.8, 8, 32), ringMat);
  ring.position.z = -2;
  // 手机不投影：悬在半空的机身在桌面上投下的大块阴影只会干扰观察
  body.add(shell, screen, lens, ring);
  group.add(body);

  // —— 视锥与视野轮廓（底板坐标，不随机身转动）
  const lineMat = new THREE.LineBasicMaterial({ color: '#c96442', transparent: true });
  const missMat = new THREE.LineDashedMaterial({ color: '#c96442', transparent: true, dashSize: 8, gapSize: 6 });
  const fovMat = new THREE.LineBasicMaterial({ color: '#c96442', transparent: true });
  const frustum = new THREE.Group();
  frustum.name = 'frustum';
  group.add(frustum);

  const mats = [shellMat, screenMat, lensMat, ringMat, lineMat, missMat, fovMat];
  group.visible = false;

  /**
   * 按位姿摆放手机与视锥
   * @param {{ pose: import('../state.js').CameraPose, intrinsics: import('../state.js').Intrinsics,
   *           orientation?: number|null }} p
   */
  function setPose({ pose, intrinsics, orientation }) {
    const { width: W, height: H } = intrinsics;
    const { size, lens: lensOff } = phoneLayout(orientation, W, H);
    // 机身中心 = 镜头 − 偏移（照片坐标 y 向下，局部 y 向上）；机身在镜头后方（朝拍摄者）
    shell.scale.set(size[0], size[1], PHONE.depth);
    shell.position.set(-lensOff[0], lensOff[1], PHONE.depth / 2);
    screen.scale.set(size[0] - 4, size[1] - 4, 1);
    screen.position.set(-lensOff[0], lensOff[1], PHONE.depth + 0.05);
    body.position.copy(toThree(...pose.position));
    body.quaternion.copy(cameraQuaternionFromR(pose.R));

    clearFrustum();
    const K = intrinsicsMatrix(intrinsics);
    const C = toThree(...pose.position);
    const fp = photoFootprint(K, pose.R, pose.t, W, H, 600);
    for (const c of fp) {
      const geo = new THREE.BufferGeometry().setFromPoints([C, toThree(...c.point)]);
      const line = new THREE.Line(geo, c.hit ? lineMat : missMat);
      if (!c.hit) line.computeLineDistances();
      frustum.add(line);
    }
    // 视野轮廓：只连相邻两个都落在底板平面上的角（抬高 0.3 mm 避免与板面重叠闪烁）
    for (let i = 0; i < 4; i++) {
      const a = fp[i];
      const b = fp[(i + 1) % 4];
      if (!a.hit || !b.hit) continue;
      const up = (p) => toThree(p[0], p[1], 0.3);
      frustum.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([up(a.point), up(b.point)]), fovMat));
    }
    group.visible = true;
  }

  /** 整体透明度（转场时淡入） */
  function setOpacity(a) {
    for (const m of mats) m.opacity = a;
    group.visible = a > 0.001;
  }

  /** 清掉视锥线（线的几何体要释放，否则每张照片都留下一组 GPU 缓冲） */
  function clearFrustum() {
    for (const o of frustum.children) o.geometry?.dispose();
    frustum.clear();
  }

  function clear() {
    clearFrustum();
    group.visible = false;
  }

  return { group, body, setPose, setOpacity, clear };
}

/**
 * 全景视角的方位角（纯函数）：手机相对底板中心明显偏到一侧时，从垂直于这个偏移的方向侧看，
 * 手机出现在底板旁边而不是挡在前面，高度也看得最清楚；手机大致在底板正上方时从右前方 40° 看。
 * 方位角 0 = 从操作者一侧（−Y）看，正值往 +X 一侧转；结果限制在 ±80° 内（始终偏向操作者一侧）。
 * @param {number[]} position 手机光心（底板坐标）
 * @param {number[]} center 底板中心
 * @returns {number} 度
 */
export function panoramaAzimuth(position, center) {
  const hx = position[0] - center[0];
  const hy = position[1] - center[1];
  if (Math.hypot(hx, hy) < 60) return 40;
  // 两个垂直方向里取更朝向操作者一侧（−Y）的那个；视线方向 (sin az, −cos az)
  let px = -hy;
  let py = hx;
  if (py > 0) {
    px = -px;
    py = -py;
  }
  const az = (Math.atan2(px, -py) * 180) / Math.PI;
  return Math.max(-80, Math.min(80, az));
}
