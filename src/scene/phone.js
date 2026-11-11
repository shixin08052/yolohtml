// 虚拟手机：机身（圆角盒）、镜头（位于光心 C）、视锥（光心到照片四角在底板上的落点）、
// 底板上的照片视野轮廓。位置和朝向全部由位姿 (R, t) 与内参 K 决定。
import * as THREE from 'three';
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
  // 材质：磨砂玻璃后盖、抛光不锈钢中框、屏幕玻璃、镜头玻璃和金属镜圈。都设成可透明（转场时整机淡入）
  const shellMat = new THREE.MeshPhysicalMaterial({ color: '#43464c', roughness: 0.5, metalness: 0.2, clearcoat: 0.5, clearcoatRoughness: 0.45, transparent: true });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#8f9399', roughness: 0.2, metalness: 1, envMapIntensity: 3, transparent: true });
  const screenMat = new THREE.MeshPhysicalMaterial({ color: '#08090b', roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 3, transparent: true });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: '#0b0d12', roughness: 0.05, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 4, transparent: true });
  const ringMat = new THREE.MeshStandardMaterial({ color: '#c3c6cb', roughness: 0.22, metalness: 1, envMapIntensity: 3, transparent: true });
  const bumpMat = new THREE.MeshPhysicalMaterial({ color: '#4b4e55', roughness: 0.2, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 2, transparent: true });
  const flashMat = new THREE.MeshStandardMaterial({ color: '#f4ecd2', roughness: 0.35, emissive: '#f4ecd2', emissiveIntensity: 0.25, transparent: true });

  /** 圆角矩形（中心在原点） */
  const roundedRect = (w, h, r) => {
    const sh = new THREE.Shape();
    const [x, y] = [w / 2, h / 2];
    sh.moveTo(-x + r, -y);
    sh.lineTo(x - r, -y);
    sh.absarc(x - r, -y + r, r, -Math.PI / 2, 0);
    sh.lineTo(x, y - r);
    sh.absarc(x - r, y - r, r, 0, Math.PI / 2);
    sh.lineTo(-x + r, y);
    sh.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI);
    sh.lineTo(-x, -y + r);
    sh.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5);
    return sh;
  };
  /** 沿局部 z 的圆柱（镜头、镜圈） */
  const disc = (r, len, mat, seg = 40) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
    m.rotation.x = Math.PI / 2;
    return m;
  };

  // 机身、屏幕的几何体按拍照方向（横 / 竖）在 setPose 里生成：机身是四角半径 11 mm 的圆角板，边缘倒角，不是把方盒子拉伸出来
  const shell = new THREE.Mesh(new THREE.BufferGeometry(), [shellMat, frameMat]);
  const screen = new THREE.Mesh(new THREE.BufferGeometry(), screenMat);
  // 主摄镜头：沿局部 z 轴的小圆柱，从光心向拍摄方向（−z）凸出 2 mm
  const lens = disc(PHONE.lensRadius, 2, lensMat);
  lens.position.z = -1;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PHONE.lensRadius, 0.8, 12, 48), ringMat);
  ring.position.z = -2;
  // 手机不投影：悬在半空的机身在桌面上投下的大块阴影只会干扰观察
  body.add(shell, screen, lens, ring);

  // 相机模组：一块凸起的玻璃台，上面主摄 + 另外两颗镜头 + 闪光灯 + 激光雷达。
  // 按"主摄在原点、机身中心在 +x +y 方向"建好，setPose 里按实际方向用 ±1 的缩放翻转过去
  const module = new THREE.Group();
  module.name = 'camera-module';
  const plate = new THREE.Mesh(new THREE.ExtrudeGeometry(roundedRect(35, 35, 9), { depth: 0.9, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.35, bevelSegments: 2, curveSegments: 16 }), bumpMat);
  plate.position.set(8.5, 8.5, -1.25); // 台面在机身背面（z = 0）往外 1.25 mm
  module.add(plate);
  for (const [x, y] of [[0, 17], [16.5, 8.5]]) {
    const l = disc(PHONE.lensRadius, 2, lensMat);
    l.position.set(x, y, -1);
    const r = new THREE.Mesh(new THREE.TorusGeometry(PHONE.lensRadius, 0.8, 12, 48), ringMat);
    r.position.set(x, y, -2);
    module.add(l, r);
  }
  // 每颗镜头里面一圈更小的"瞳孔"，有层次
  for (const [x, y] of [[0, 0], [0, 17], [16.5, 8.5]]) {
    const iris = disc(2.6, 0.3, new THREE.MeshStandardMaterial({ color: '#1b2233', roughness: 0.15, metalness: 0.8, envMapIntensity: 4, transparent: true }));
    iris.position.set(x, y, -2.05);
    iris.userData.fade = true;
    module.add(iris);
  }
  const flash = disc(2.4, 0.5, flashMat);
  flash.position.set(17.5, -3, -1.5);
  const lidar = disc(2, 0.5, lensMat);
  lidar.position.set(17.5, 20, -1.5);
  module.add(flash, lidar);
  body.add(module);
  group.add(body);

  // —— 视锥与视野轮廓（底板坐标，不随机身转动）
  const lineMat = new THREE.LineBasicMaterial({ color: '#c96442', transparent: true });
  const missMat = new THREE.LineDashedMaterial({ color: '#c96442', transparent: true, dashSize: 8, gapSize: 6 });
  const fovMat = new THREE.LineBasicMaterial({ color: '#c96442', transparent: true });
  const frustum = new THREE.Group();
  frustum.name = 'frustum';
  group.add(frustum);

  const mats = [shellMat, frameMat, screenMat, lensMat, ringMat, bumpMat, flashMat, lineMat, missMat, fovMat];
  module.traverse((o) => { if (o.userData.fade) mats.push(o.material); });
  /** 当前机身几何体对应的尺寸（换了横竖才重建） */
  let shellKey = '';
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
    if (shellKey !== size.join('x')) {
      shellKey = size.join('x');
      shell.geometry.dispose();
      screen.geometry.dispose();
      const bevel = 1.1;
      // 挤出体：正反两面（后盖玻璃）用第 0 个材质，侧面一圈（金属中框）用第 1 个
      shell.geometry = new THREE.ExtrudeGeometry(roundedRect(size[0] - 2 * bevel, size[1] - 2 * bevel, 11 - bevel), { depth: PHONE.depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 20 });
      shell.geometry.translate(0, 0, -(PHONE.depth - 2 * bevel) / 2); // 厚度方向居中
      screen.geometry = new THREE.ShapeGeometry(roundedRect(size[0] - 5, size[1] - 5, 9), 20);
    }
    shell.position.set(-lensOff[0], lensOff[1], PHONE.depth / 2);
    screen.position.set(-lensOff[0], lensOff[1], PHONE.depth + 0.05);
    // 相机模组朝机身中心那一侧展开：机身中心相对镜头在 (−lensOff[0], +lensOff[1])
    module.scale.set(Math.sign(-lensOff[0]) || 1, Math.sign(lensOff[1]) || 1, 1);
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
