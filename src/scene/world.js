// 3D 世界（步骤 1：只有一个空画布；步骤 8 补充灯光、控制器等）。
import * as THREE from 'three';
import { cssVar, onThemeChange } from '../ui/theme.js';
import { BOARD } from '../config.js';
import { toThree } from '../math/coords.js';

/**
 * @param {HTMLElement} container
 */
export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const applyTheme = () => renderer.setClearColor(new THREE.Color(cssVar('--canvas-bg')));
  applyTheme();
  onThemeChange(applyTheme);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  // 临时视角：从操作者一侧斜上方看向底板中心（步骤 8 完善）
  camera.position.copy(toThree(BOARD.width / 2, -350, 450));
  camera.lookAt(toThree(BOARD.width / 2, BOARD.height / 2, 0));

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // 标签页隐藏时跳过
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  function render() {
    renderer.render(scene, camera);
  }

  new ResizeObserver(resize).observe(container);
  renderer.setAnimationLoop(render);

  return { renderer, scene, camera, resize, render };
}
