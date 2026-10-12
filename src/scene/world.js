// 3D 世界（步骤 1：只有一个空画布；步骤 8 补充灯光、控制器等）。
import * as THREE from 'three';

/**
 * @param {HTMLElement} container
 */
export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x1b1f26);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  camera.position.set(210, 600, 500);
  camera.lookAt(210, 0, -148.5);

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
