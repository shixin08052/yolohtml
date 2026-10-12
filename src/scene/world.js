// 3D 世界：渲染器、场景、灯光、桌面、轨道控制器、CSS2D 标签渲染器、坐标轴。
// 场景里的位置一律先用底板坐标写，再经 math/coords.js 的 toThree 转换。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { cssVar, onThemeChange } from '../ui/theme.js';
import { BOARD } from '../config.js';
import { toThree } from '../math/coords.js';

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

  const camera = new THREE.PerspectiveCamera(40, 1, 5, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 80;
  controls.maxDistance = 3000;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; // 不钻到桌面下面
  controls.screenSpacePanning = true;

  /**
   * 默认视角：从操作者一侧（−Y）斜上方看向底板中心；距离按画面宽高比让底板完整可见
   * @param {number} [elevationDeg=50] 视线仰角
   */
  function setDefaultView(elevationDeg = 50) {
    // 先清掉阻尼留下的旋转 / 平移惯性，否则复位后还会继续漂移
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    const e = (elevationDeg * Math.PI) / 180;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    // 底板半宽 / 半深（深度方向在斜视下缩短）
    const halfW = BOARD.width / 2 + 20;
    const halfD = (BOARD.height / 2 + 20) * Math.sin(e) + 20;
    const dist = Math.max(halfW / Math.tan(hfov / 2), halfD / Math.tan(vfov / 2)) * 1.15;
    const target = toThree(...BOARD_CENTER);
    camera.position.copy(toThree(BOARD_CENTER[0], BOARD_CENTER[1] - dist * Math.cos(e), dist * Math.sin(e)));
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
    controls.enableDamping = damping;
    requestRender();
  }

  // 按需渲染：控制器变化、窗口变化、内容变化时渲染；阻尼动画期间持续渲染
  let needRender = true;
  function requestRender() {
    needRender = true;
  }
  controls.addEventListener('change', requestRender);

  let sized = false;
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // 标签页隐藏时跳过
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!sized) {
      sized = true;
      setDefaultView();
    }
    requestRender();
  }

  function render() {
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  renderer.setAnimationLoop(() => {
    if (container.clientWidth === 0) return; // 不可见时不渲染
    const moving = controls.update(); // 阻尼仍在衰减时返回 true
    if (needRender || moving) {
      needRender = false;
      render();
    }
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
    requestRender,
    setDefaultView,
    /** 显示 / 隐藏坐标轴 */
    setAxesVisible(on) {
      axes.visible = on;
      requestRender();
    },
  };
}
