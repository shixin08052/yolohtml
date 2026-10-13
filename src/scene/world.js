// 3D 世界：渲染器、场景、灯光、桌面、轨道控制器、CSS2D 标签渲染器、坐标轴。
// 场景里的位置一律先用底板坐标写，再经 math/coords.js 的 toThree 转换。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { cssVar, onThemeChange } from '../ui/theme.js';
import { BOARD } from '../config.js';
import { toThree, fromThree, cameraQuaternionFromR } from '../math/coords.js';

/** 桌面尺寸（mm），中心与底板中心对齐 */
export const TABLE = { width: 1200, depth: 900 };

/** 底板中心（底板坐标） */
const BOARD_CENTER = [BOARD.width / 2, BOARD.height / 2, 0];

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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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
    requestRender();
  };

  // 灯光：半球光 + 一盏带阴影的平行光（从左后上方照下）
  scene.add(new THREE.HemisphereLight('#ffffff', '#5a554d', 1.5));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.copy(toThree(BOARD.width / 2 - 300, BOARD.height / 2 + 250, 700));
  sun.target.position.copy(toThree(...BOARD_CENTER));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 450, bottom: -450, near: 100, far: 2000 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  // 桌面：深色平面，顶面在底板下方 BOARD.thickness 处
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE.width, TABLE.depth),
    new THREE.MeshStandardMaterial({ color: '#2f2c29', roughness: 0.92 }),
  );
  table.name = 'table';
  table.rotation.x = -Math.PI / 2;
  table.position.copy(toThree(BOARD_CENTER[0], BOARD_CENTER[1], -BOARD.thickness));
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
  controls.minDistance = 80;
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
    const pts = [...basePoints, ...(focusPoints ?? [])];
    const az = ((focusPoints ? focusAzimuth : 0) * Math.PI) / 180;
    const el = ((focusPoints ? 28 : 50) * Math.PI) / 180;
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

  /** 按参数摆放相机（k 为视点偏移的保留比例，转场中从 1 过渡到 0） */
  function applyCamera({ position, quaternion, fov, offset, size }, k = 1) {
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.fov = fov;
    if (offset && size && k > 0 && (offset[0] || offset[1])) {
      camera.setViewOffset(size[0], size[1], offset[0] * k, offset[1] * k, size[0], size[1]);
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
    requestRender();
  }

  /** 是否由轨道控制器接管相机（转场、对比时关闭） */
  let controlsActive = true;
  function setControlsActive(on) {
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
      renderer.setClearColor(letterbox.set(cssVar('--surface')));
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
