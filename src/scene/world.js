// 3D 世界：渲染器、场景、灯光、桌面、轨道控制器、CSS2D 标签渲染器、坐标轴。
// 场景里的位置一律先用底板坐标写，再经 math/coords.js 的 toThree 转换。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { cssVar, onThemeChange } from '../ui/theme.js';
import { BOARD } from '../config.js';
import { toThree, fromThree, cameraQuaternionFromR } from '../math/coords.js';

/** 桌面尺寸（mm），中心与底板中心对齐 */
export const TABLE = { width: 1200, depth: 900 };

/** 底板中心（底板坐标） */
const BOARD_CENTER = [BOARD.width / 2, BOARD.height / 2, 0];

/**
 * 桌垫的贴图：深色底 + 细颗粒（哑光的质感）+ 很淡的 50 mm 网格（给画面一个尺度感），四周略暗。
 * 画在 1 px = 1 mm 的画布上；贴图坐标由调用方按桌垫尺寸换算
 */
function matTexture() {
  const c = document.createElement('canvas');
  c.width = TABLE.width;
  c.height = TABLE.depth;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2f2c29';
  ctx.fillRect(0, 0, c.width, c.height);
  // 颗粒：固定种子的伪随机数，每次打开都一样
  let seed = 20261111;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // 网格：以桌垫中心（= 底板中心）对齐，每 50 mm 一条细线，每 100 mm 稍亮
  for (const [step, alpha] of [[50, 0.035], [100, 0.05]]) {
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (c.width / 2) % step; x < c.width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, c.height);
    }
    for (let y = (c.height / 2) % step; y < c.height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(c.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }
  // 四周压暗一点，视线自然落在中间的底板上
  const g = ctx.createRadialGradient(c.width / 2, c.height / 2, c.height * 0.35, c.width / 2, c.height / 2, c.width * 0.62);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 底板坐标系的坐标轴：X 红、Y 绿、Z 蓝，长 100 mm，带 CSS2D 字母 */
function createAxes() {
  const g = new THREE.Group();
  g.name = 'axes';
  // X、Y 轴正好躺在板面上，抬高 0.5 mm 并始终画在最上层，避免被板面挡住
  const o = toThree(0, 0, 0.5);
  for (const [name, dir, color] of [
    ['X', [1, 0, 0], '#e5484d'],
    ['Y', [0, 1, 0], '#30a46c'],
    ['Z', [0, 0, 1], '#3e63dd'],
  ]) {
    const d = toThree(...dir).normalize();
    // 圆柱 + 圆锥做箭头（WebGL 线宽只有 1 像素，太细）
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 88, 12), mat);
    shaft.position.y = 44;
    const head = new THREE.Mesh(new THREE.ConeGeometry(4, 12, 16), mat);
    head.position.y = 94;
    arrow.add(shaft, head);
    // 圆柱默认沿 +y，转到方向 d
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    arrow.position.copy(o);
    arrow.traverse((m) => (m.renderOrder = 10));
    g.add(arrow);
    const el = document.createElement('div');
    el.className = 'axis-label';
    el.textContent = name;
    el.style.color = color;
    const label = new CSS2DObject(el);
    label.position.copy(toThree(...dir.map((x) => x * 114)).add(toThree(0, 0, 0.5)));
    g.add(label);
  }
  return g;
}

/**
 * @param {HTMLElement} container
 */
export function createWorld(container) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (err) {
    console.warn('3D 初始化失败，保留照片识别功能：', err);
    return unavailableWorld(container);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // 手机等触屏设备显存紧：阴影贴图小一档
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const shadowSize = !coarse && renderer.capabilities.maxTextureSize >= 4096 ? 4096 : 2048;
  container.appendChild(renderer.domElement);

  // CSS2D 标签层：叠在画布上，不拦截鼠标
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'label-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const applyTheme = () => {
    const bg = new THREE.Color(cssVar('--canvas-bg'));
    renderer.setClearColor(bg);
    scene.background = bg;
    letterbox.set(cssVar('--surface')); // 转场 / 对比时画面区域外的底色（每帧读样式会触发重新计算样式）
    requestRender();
  };

  // 环境反射：一间柔光的"摄影棚"，金属引脚、机械臂的钢件、LED 的环氧树脂表面才有东西可反射（否则金属是一片死灰）。
  // 只用来算反射和环境光，不显示成背景
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.28;
  pmrem.dispose();

  // 灯光：环境反射提供柔和的底光，半球光补一点天地色差；一盏带阴影的主光从左前上方照下，一盏不投影的辅光从右后方勾出轮廓
  // 强度是对着画面调的：白纸受光处接近但不到纯白，影子里明显暗一档（环境光太强时影子会被冲掉）
  scene.add(new THREE.HemisphereLight('#ffffff', '#5a554d', 0.1));
  const sun = new THREE.DirectionalLight('#fffaf3', 1.85);
  sun.position.copy(toThree(BOARD.width / 2 - 300, BOARD.height / 2 - 250, 700)); // 从操作者一侧照，机械臂（在远端）的影子落在底板外
  sun.target.position.copy(toThree(...BOARD_CENTER));
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  // 阴影只需要盖住底板、料盒和机械臂这一带：范围收紧后每个像素更细，几毫米大的零件也有清楚的影子
  Object.assign(sun.shadow.camera, { left: -400, right: 400, top: 380, bottom: -360, near: 100, far: 2000 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  sun.shadow.radius = 1.6;
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight('#dfe9ff', 0.3);
  rim.position.copy(toThree(BOARD.width / 2 + 420, BOARD.height / 2 + 380, 380));
  rim.target.position.copy(toThree(...BOARD_CENTER));
  scene.add(rim, rim.target);

  // 桌面：一张圆角的深色桌垫（有厚度、边缘倒角），顶面在底板下方 BOARD.thickness 处
  const matShape = new THREE.Shape();
  {
    const [w, d, r] = [TABLE.width / 2, TABLE.depth / 2, 36];
    matShape.moveTo(-w + r, -d);
    matShape.lineTo(w - r, -d);
    matShape.absarc(w - r, -d + r, r, -Math.PI / 2, 0);
    matShape.lineTo(w, d - r);
    matShape.absarc(w - r, d - r, r, 0, Math.PI / 2);
    matShape.lineTo(-w + r, d);
    matShape.absarc(-w + r, d - r, r, Math.PI / 2, Math.PI);
    matShape.lineTo(-w, -d + r);
    matShape.absarc(-w + r, -d + r, r, Math.PI, Math.PI * 1.5);
  }
  const MAT_THICK = 3;
  const matTex = matTexture();
  // 挤出体的贴图坐标就是形状的坐标（mm，原点在中心）：换算到 0–1
  matTex.repeat.set(1 / TABLE.width, 1 / TABLE.depth);
  matTex.offset.set(0.5, 0.5);
  const table = new THREE.Mesh(
    new THREE.ExtrudeGeometry(matShape, { depth: MAT_THICK - 1, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 3, curveSegments: 12 }),
    [new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.94, metalness: 0 }), new THREE.MeshStandardMaterial({ color: '#262321', roughness: 0.9 })],
  );
  table.name = 'table';
  table.rotation.x = -Math.PI / 2; // 形状平面 → 水平，挤出方向 → 向上
  // 挤出体从 z = −bevelThickness 到 depth + bevelThickness：顶面落在底板底面
  table.position.copy(toThree(BOARD_CENTER[0], BOARD_CENTER[1], -BOARD.thickness - MAT_THICK));
  table.receiveShadow = true;
  scene.add(table);

  const axes = createAxes();
  axes.visible = false;
  scene.add(axes);

  /** 默认（全景）视角的纵向视场角 */
  const DEFAULT_FOV = 40;
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 5, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 20; // 可以凑近看清零件细节（电阻本体只有 6 mm）
  controls.maxDistance = 3000;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // 不钻到桌面下面
  controls.screenSpacePanning = true;

  /** 默认视角始终要装进画面的点（底板坐标）：底板四角，加上料盒、机械臂等固定物体 */
  let basePoints = [[0, 0, 0], [BOARD.width, 0, 0], [BOARD.width, BOARD.height, 0], [0, BOARD.height, 0]];
  /** 默认视角需要额外装进画面的点（底板坐标），例如手机；null 表示只看底板 */
  let focusPoints = null;
  /** 有额外点时的视线方位角（度，0 = 从操作者一侧看，正值往 +X 一侧转） */
  let focusAzimuth = 40;

  /**
   * 默认视角的相机位置与目标点（不应用）。
   * - 只有底板时：从操作者一侧（−Y）、仰角 50° 看向底板中心（机械臂在底板远端，不挡视线）
   * - 有手机时（全景）：从右前方斜看（方位 40°、仰角 28°），让底板和手机都在画面里
   * 相机距离按画面宽高比计算，保证所有要看的点都在视场内并留出边距。
   * @param {number} [aspect] 画面宽高比（默认取当前相机）
   * @returns {{position: THREE.Vector3, target: THREE.Vector3, fov: number}}
   */
  function getDefaultView(aspect = camera.aspect) {
    return viewFor([...basePoints, ...(focusPoints ?? [])], focusPoints ? focusAzimuth : 0, focusPoints ? 28 : 50, aspect);
  }

  /**
   * 从给定方位角 / 仰角看、把这些点（底板坐标）都装进画面的相机位置与目标点（不应用）
   * @param {number[][]} pts
   * @param {number} azimuthDeg 0 = 从操作者一侧看，正值往 +X 一侧转
   * @param {number} elevationDeg
   * @param {number} [aspect]
   */
  function viewFor(pts, azimuthDeg, elevationDeg, aspect = camera.aspect) {
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    // 目标点：所有点包围盒的中心
    const lo = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
    const hi = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
    const c = lo.map((x, i) => (x + hi[i]) / 2);
    // 视线方向（底板坐标）：目标点 → 相机
    const d = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
    const f = d.map((x) => -x); // 相机朝向
    const right = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0]; // f × (0,0,1)
    const rn = Math.hypot(...right);
    const r = right.map((x) => x / rn);
    const up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const tanV = Math.tan((DEFAULT_FOV * Math.PI) / 360) / 1.12; // 留 12% 边距
    const tanH = tanV * aspect;
    let dist = 100;
    for (const p of pts) {
      const rel = p.map((x, i) => x - c[i]);
      const x = rel[0] * r[0] + rel[1] * r[1] + rel[2] * r[2];
      const y = rel[0] * up[0] + rel[1] * up[1] + rel[2] * up[2];
      const z = rel[0] * f[0] + rel[1] * f[1] + rel[2] * f[2];
      dist = Math.max(dist, Math.abs(x) / tanH - z, Math.abs(y) / tanV - z);
    }
    return {
      position: toThree(c[0] + d[0] * dist, c[1] + d[1] * dist, c[2] + d[2] * dist),
      target: toThree(...c),
      fov: DEFAULT_FOV,
    };
  }

  /**
   * 设置默认视角要额外装进画面的点（底板坐标）与视线方位角
   * @param {number[][]|null} points
   * @param {number} [azimuthDeg=40]
   */
  function setFocusPoints(points, azimuthDeg = 40) {
    focusPoints = points && points.length ? points : null;
    focusAzimuth = azimuthDeg;
  }

  /**
   * 设置默认视角始终要装进画面的点（底板坐标）
   * @param {number[][]} points
   */
  function setBasePoints(points) {
    basePoints = points;
  }

  const raycaster = new THREE.Raycaster();
  /**
   * 屏幕上的点与水平面 Z = z 的交点（底板坐标）；转场 / 对比时（画面区域不是全画布）不处理
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} [z=0]
   * @returns {number[]|null}
   */
  function pickPlane(clientX, clientY, z = 0) {
    if (frame) return null;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), new THREE.Vector3());
    return hit ? fromThree(hit) : null;
  }

  /** 应用默认视角 */
  function setDefaultView() {
    cancelFly();
    // 先清掉阻尼留下的旋转 / 平移惯性，否则复位后还会继续漂移
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    const v = getDefaultView(camera.aspect);
    camera.clearViewOffset();
    camera.fov = v.fov;
    camera.updateProjectionMatrix();
    camera.position.copy(v.position);
    controls.target.copy(v.target);
    camera.lookAt(v.target);
    controls.update();
    controls.enableDamping = damping;
    requestRender();
  }

  /** 正在进行的视角过渡（requestAnimationFrame 句柄） */
  let flyRaf = 0;
  function cancelFly() {
    cancelAnimationFrame(flyRaf);
    flyRaf = 0;
  }
  controls.addEventListener('start', cancelFly); // 用户自己拖动视角时，过渡让位

  /**
   * 平滑移到"把这些点装进画面"的视角（分拣时拉近到底板和料盒；之后仍可自由旋转，"默认视角"回到全景）
   * @param {number[][]} points 底板坐标
   * @param {{ azimuthDeg?: number, elevationDeg?: number, ms?: number }} [opts]
   */
  function flyToPoints(points, { azimuthDeg = 0, elevationDeg = 50, ms = 700 } = {}) {
    cancelFly();
    if (!controlsActive || frame || !points?.length) return;
    const to = viewFor(points, azimuthDeg, elevationDeg, camera.aspect);
    const p0 = camera.position.clone();
    const t0 = controls.target.clone();
    const start = performance.now();
    const damping = controls.enableDamping;
    const step = (now) => {
      const k = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      controls.enableDamping = false;
      camera.position.lerpVectors(p0, to.position, e);
      controls.target.lerpVectors(t0, to.target, e);
      camera.lookAt(controls.target);
      controls.update();
      controls.enableDamping = damping;
      requestRender();
      flyRaf = k < 1 && controlsActive && !frame ? requestAnimationFrame(step) : 0;
    };
    step(start);
  }

  /**
   * 把相机设成拍照时手机的位姿与内参（转场、对比用）。
   * 纵向视场角 = 2·atan(H / 2fy)；主点不在中心时用 setViewOffset 平移画面。
   * 画面区域宽高比应与照片一致（由调用方用 setFrame 设置）。
   * @returns {{position: THREE.Vector3, quaternion: THREE.Quaternion, fov: number, offset: [number, number], size: [number, number]}}
   */
  function photoCameraParams({ pose, intrinsics }) {
    const { width: W, height: H, fy, cx, cy } = intrinsics;
    return {
      position: toThree(...pose.position),
      quaternion: cameraQuaternionFromR(pose.R),
      fov: (2 * Math.atan(H / (2 * fy)) * 180) / Math.PI,
      offset: [W / 2 - cx, H / 2 - cy],
      size: [W, H],
    };
  }

  /**
   * 按参数摆放相机（k 为视点偏移的保留比例，转场中从 1 过渡到 0）。
   * 注意 Three.js 的 setViewOffset 会把 camera.aspect 改成 fullWidth / fullHeight：这里按当前画面区域的宽高比
   * 给出"全画面"尺寸（高度取照片高度），只平移主点、不拉伸画面。转场途中画面区域从照片比例变宽时，
   * 如果用照片尺寸，整段飞行都会被横向拉伸，飞到终点偏移归零的那一帧突然复原（看起来像缩放了一下）。
   */
  function applyCamera({ position, quaternion, fov, offset, size }, k = 1) {
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.fov = fov;
    const aspect = frameAspect();
    if (offset && size && k > 0 && (offset[0] || offset[1])) {
      const H = size[1];
      camera.setViewOffset(H * aspect, H, offset[0] * k, offset[1] * k, H * aspect, H);
    } else {
      camera.clearViewOffset();
    }
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    requestRender();
  }

  /** 是否由轨道控制器接管相机（转场、对比时关闭） */
  let controlsActive = true;
  function setControlsActive(on) {
    if (!on) cancelFly();
    controlsActive = on;
    controls.enabled = on;
  }

  // 按需渲染：控制器变化、窗口变化、内容变化时渲染；阻尼动画期间持续渲染
  let needRender = true;
  function requestRender() {
    needRender = true;
  }
  controls.addEventListener('change', requestRender);

  // 画面区域（容器内 CSS px）。转场 / 对比时只在照片比例的这块区域里渲染，
  // 画布本身尺寸不变——每帧改画布尺寸会清空绘图缓冲，造成闪烁
  let frame = null;
  let size = { w: 0, h: 0 };

  /** 当前画面区域的宽高比（画面区域未设置时取整个画布） */
  function frameAspect() {
    const a = frame ? frame.w / frame.h : size.w / size.h;
    return Number.isFinite(a) && a > 0 ? a : camera.aspect;
  }

  function updateAspect() {
    const a = frame ? frame.w / frame.h : size.w / size.h;
    if (Number.isFinite(a) && a > 0) {
      camera.aspect = a;
      camera.updateProjectionMatrix();
    }
  }

  function layoutLabels() {
    const r = frame ?? { x: 0, y: 0, w: size.w, h: size.h };
    Object.assign(labelRenderer.domElement.style, { left: `${r.x}px`, top: `${r.y}px`, right: 'auto', bottom: 'auto' });
    labelRenderer.setSize(r.w, r.h);
  }

  /**
   * 设置画面区域；null 表示铺满容器
   * @param {{x:number, y:number, w:number, h:number}|null} r
   */
  function setFrame(r) {
    frame = r && r.w > 0 && r.h > 0 ? { ...r } : null;
    updateAspect();
    layoutLabels();
    requestRender();
  }

  let sized = false;
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // 标签页隐藏时跳过
    if (w === size.w && h === size.h) {
      requestRender();
      return;
    }
    size = { w, h };
    renderer.setSize(w, h);
    updateAspect();
    layoutLabels();
    if (!sized && controlsActive) {
      sized = true;
      setDefaultView();
    }
    // 改尺寸会清空画布，立刻重画，避免露出一帧空白
    render();
  }

  const letterbox = new THREE.Color();
  function render() {
    needRender = false;
    if (frame) {
      // 区域外填视图底色，区域内照常渲染场景
      const bg = renderer.getClearColor(new THREE.Color());
      renderer.setScissorTest(false);
      renderer.setClearColor(letterbox);
      renderer.clear();
      renderer.setClearColor(bg);
      const y = size.h - frame.y - frame.h; // WebGL 视口原点在左下角
      renderer.setViewport(frame.x, y, frame.w, frame.h);
      renderer.setScissor(frame.x, y, frame.w, frame.h);
      renderer.setScissorTest(true);
      renderer.render(scene, camera);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.w, size.h);
    } else {
      renderer.render(scene, camera);
    }
    labelRenderer.render(scene, camera);
    declutterTags();
  }

  /**
   * 零件标签避让：挤在一起的零件标签会叠成一团、谁也看不清。每帧按顺序摆，和已显示的标签重叠的先藏起来；
   * 拉近视角零件分开后自然又显示出来
   */
  function declutterTags() {
    const tags = labelRenderer.domElement.querySelectorAll('.part-tag');
    if (tags.length < 2) return;
    const shown = [];
    for (const el of tags) {
      if (el.style.display === 'none') continue; // 在相机背后（CSS2DRenderer 藏起来的）
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const hit = shown.some((q) => r.left < q.right - 2 && q.left < r.right - 2 && r.top < q.bottom - 2 && q.top < r.bottom - 2);
      el.classList.toggle('tag-hidden', hit);
      if (!hit) shown.push(r);
    }
  }

  renderer.setAnimationLoop(() => {
    if (container.clientWidth === 0) return; // 不可见时不渲染
    const moving = controlsActive ? controls.update() : false; // 阻尼仍在衰减时返回 true
    if (needRender || moving) render();
  });

  new ResizeObserver(resize).observe(container);
  onThemeChange(applyTheme);
  applyTheme();

  return {
    available: true,
    renderer,
    scene,
    camera,
    controls,
    resize,
    render,
    setFrame,
    requestRender,
    setDefaultView,
    getDefaultView,
    flyToPoints,
    setFocusPoints,
    setBasePoints,
    pickPlane,
    photoCameraParams,
    applyCamera,
    setControlsActive,
    /** 显示 / 隐藏坐标轴 */
    setAxesVisible(on) {
      axes.visible = on;
      requestRender();
    },
  };
}

/** 无 WebGL 时保留几何对象及识别流程，不启动渲染或分拣动画。 */
function unavailableWorld(container) {
  const notice = document.createElement('p');
  notice.className = 'webgl-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = '当前浏览器无法启动 3D。照片上传、识别和结果查看仍可使用，请换用支持 WebGL 的浏览器观看分拣。';
  container.appendChild(notice);
  const canvas = document.createElement('canvas');
  const noop = () => {};
  return {
    available: false,
    renderer: { domElement: canvas },
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    resize: noop, render: noop, setFrame: noop, requestRender: noop,
    setDefaultView: noop, flyToPoints: noop, setFocusPoints: noop, setBasePoints: noop,
    setAxesVisible: noop, setControlsActive: noop, pickPlane: () => null,
  };
}
