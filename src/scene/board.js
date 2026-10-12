// 3D 底板：按实测纸张（或设计尺寸）摆放的薄盒子，顶面贴正射图；4 个码中心上方 1 mm 处挂 ID 标签。
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BOARD, MARKERS } from '../config.js';
import { toThree } from '../math/coords.js';
import { designFrame } from '../vision/boardLayout.js';

/**
 * @returns {{ group: THREE.Group, setPaper: (canvas: HTMLCanvasElement, frame: object) => void }}
 */
export function createBoard() {
  const group = new THREE.Group();
  group.name = 'board';

  const side = new THREE.MeshStandardMaterial({ color: '#f1efe9', roughness: 0.9 });
  const top = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
  // BoxGeometry 面顺序：+x, −x, +y(顶), −y, +z, −z；顶面 u 沿 +x、v = 1 在 −z（底板 +Y 远端），与正射图方向一致
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [side, side, top, side, side, side]);
  mesh.name = 'board-mesh';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);

  // ID 标签：码中心上方 1 mm（底板坐标由码决定，与纸张偏移无关）
  for (const [id, [cx, cy]] of Object.entries(MARKERS.centers)) {
    const el = document.createElement('div');
    el.className = 'marker-tag';
    el.textContent = `ID${id}`;
    const label = new CSS2DObject(el);
    label.position.copy(toThree(cx, cy, 1));
    label.name = `marker-label-${id}`;
    group.add(label);
  }

  let texture = null;

  /**
   * 设置纸张的位置与贴图
   * @param {HTMLCanvasElement|null} canvas 纸张局部坐标下的正射图（顶部 = 纸张远端）
   * @param {{cx:number, cy:number, w:number, h:number, theta:number}} [frame] 纸张坐标框（默认设计尺寸）
   */
  function setPaper(canvas, frame = designFrame()) {
    mesh.scale.set(frame.w, BOARD.thickness, frame.h);
    mesh.position.copy(toThree(frame.cx, frame.cy, -BOARD.thickness / 2));
    mesh.rotation.set(0, frame.theta, 0); // 底板绕 Z 逆时针 = Three.js 绕 y 正转
    if (texture) texture.dispose();
    texture = null;
    if (canvas) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
    }
    top.map = texture;
    top.needsUpdate = true;
  }

  setPaper(null);
  return { group, setPaper };
}
