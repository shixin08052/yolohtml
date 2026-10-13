// 零件模型：每个类别用基础几何体拼成（步骤 3 合成图使用，步骤 10 的 3D 场景复用）。
// 模型的局部坐标：原点在零件中心正下方的板面上；底板 X、Y、Z 分别对应 Three.js 的 x、−z、y。
// 长条形零件（电阻、螺丝）沿局部 X 方向放置，绕 Z 轴旋转 rotDeg 后摆到板上。
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CLASSES } from '../config.js';
import { toThree } from '../math/coords.js';

/**
 * 每类零件的包围盒尺寸（mm）：lx 沿零件长轴，ly 垂直长轴，h 为高度（= CLASSES.heightMm）。
 * 真值 box 由这个包围盒投影得到，模型尺寸必须与之一致（有单元测试检查）。
 */
export const PART_SIZE = {
  0: { lx: 22, ly: 3, h: 3 },      // 色环电阻：本体 Φ3×8，两根引脚，总长 22
  1: { lx: 8, ly: 8, h: 12 },      // 电解电容：Φ8×12
  2: { lx: 5, ly: 5, h: 9 },       // LED：Φ5，柱体 6.5 + 半球
  3: { lx: 14.5, ly: 4, h: 4 },    // 螺丝（横躺）：杆 Φ2.5×12，圆头 Φ4×2.5
};

const material = (cls, opts = {}) =>
  new THREE.MeshStandardMaterial({ color: CLASSES[cls].color, roughness: 0.55, metalness: 0.1, ...opts });

/** 沿局部 X 轴横躺的圆柱，中心在 (cx, cy) 高度处 */
function lyingCylinder(r, len, mat, cx, cy) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), mat);
  m.rotation.z = Math.PI / 2;
  m.position.set(cx, cy, 0);
  return m;
}

/**
 * 创建一个零件模型（未旋转、位于原点）
 * @param {number} cls 类别 ID
 * @returns {THREE.Group}
 */
export function createPartMesh(cls) {
  const g = new THREE.Group();
  g.name = `part-${CLASSES[cls].key}`;
  switch (cls) {
    case 0: {
      // 色环电阻：横躺本体 + 两根引脚 + 几道色环
      const body = material(0);
      g.add(lyingCylinder(1.45, 8, body, 0, 1.5));
      const lead = new THREE.MeshStandardMaterial({ color: '#c0c4c8', metalness: 0.6, roughness: 0.35 });
      g.add(lyingCylinder(0.3, 7, lead, -7.5, 1.5));
      g.add(lyingCylinder(0.3, 7, lead, 7.5, 1.5));
      const bands = ['#7a4a1e', '#111111', '#d43b2a', '#c9a227'];
      bands.forEach((c, i) => {
        g.add(lyingCylinder(1.5, 0.7, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }), -2.6 + i * 1.6, 1.5));
      });
      break;
    }
    case 1: {
      // 电解电容：竖立圆柱，顶面浅色（CylinderGeometry 的材质组：侧面、顶面、底面）
      const topMat = new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.5, roughness: 0.4 });
      const can = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 12, 40), [material(1), topMat, material(1)]);
      can.position.y = 6;
      g.add(can);
      break;
    }
    case 2: {
      // LED：圆柱 + 半球
      const mat = material(2, { roughness: 0.25, transparent: true, opacity: 0.92 });
      const col = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 6.5, 32), mat);
      col.position.y = 3.25;
      g.add(col);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
      dome.position.y = 6.5;
      g.add(dome);
      break;
    }
    case 3: {
      // 螺丝（横躺）：杆 + 圆头
      const mat = material(3, { metalness: 0.45, roughness: 0.35 });
      g.add(lyingCylinder(1.25, 12, mat, 1.25, 2));
      g.add(lyingCylinder(2, 2.5, mat, -6, 2));
      break;
    }
    default:
      throw new Error(`未知类别 ${cls}`);
  }
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** 先冲过头一点再回落，"长出来"更有弹性 */
const easeOutBack = (t) => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 两种方法之间切换的动画时长（ms） */
export const METHOD_MOVE_MS = 500;

/**
 * 3D 场景里的零件层：每个零件一个模型 + 头顶 CSS2D 标签（类别、坐标、置信度）。
 * 位置在方法 1（板面落点）与方法 2（视差修正）之间用 blend ∈ [0, 1] 插值，
 * 切换时 0.5 秒平滑移动；转场时用 setGrow 让零件从板面"长出来"。
 * @param {{ requestRender: () => void, onFrame?: () => void }} deps onFrame：位置变化后（更新射线用）
 */
export function createPartsLayer({ requestRender, onFrame = () => {} }) {
  const group = new THREE.Group();
  group.name = 'parts';
  /** @type {{ part: import('../state.js').Part, node: THREE.Group, model: THREE.Group, label: CSS2DObject, text: HTMLElement }[]} */
  let items = [];
  let blend = 1; // 1 = 视差修正
  let grow = 1;
  let labelsOn = true;
  let anim = 0;

  const posAt = (p, m) => [p.xPlane + (p.xParallax - p.xPlane) * m, p.yPlane + (p.yParallax - p.yPlane) * m];
  const fmt = (x) => x.toFixed(1);

  /** 标签文字：坐标取目标方法的结果 */
  function labelText(p, parallax) {
    const [x, y] = posAt(p, parallax ? 1 : 0);
    return `<b>${CLASSES[p.cls].name}</b><span>(${fmt(x)}, ${fmt(y)})${p.score < 1 ? ` · ${p.score.toFixed(2)}` : ''}</span>`;
  }

  function place() {
    for (const it of items) {
      const [x, y] = posAt(it.part, blend);
      it.node.position.copy(toThree(x, y, 0));
    }
  }

  function applyGrow() {
    const n = items.length;
    // 依次错开 0.4 的进度长出来
    const lag = n > 1 ? 0.4 / (n - 1) : 0;
    items.forEach((it, i) => {
      const k = clamp01((grow - i * lag) / 0.6);
      const sc = k <= 0 ? 0.0001 : easeOutBack(k);
      it.model.scale.setScalar(sc);
      it.model.visible = k > 0;
      it.label.visible = labelsOn && k >= 1;
    });
  }

  function dispose() {
    for (const it of items) {
      it.model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) m.dispose();
        }
      });
      it.text.remove();
    }
    group.clear();
    items = [];
  }

  return {
    group,
    /**
     * 换一组零件（模型重建；保留当前的方法与生长进度）
     * @param {import('../state.js').Part[]} parts
     * @param {boolean} parallax 当前是否视差修正
     */
    setParts(parts, parallax) {
      cancelAnimationFrame(anim);
      dispose();
      blend = parallax ? 1 : 0;
      for (const part of parts) {
        const node = new THREE.Group();
        node.name = `part-${part.id}`;
        const model = createPartMesh(part.cls);
        model.rotation.y = (part.rotDeg * Math.PI) / 180;
        node.add(model);
        const text = document.createElement('div');
        text.className = 'part-tag';
        text.style.setProperty('--c', CLASSES[part.cls].color);
        text.innerHTML = labelText(part, parallax);
        const label = new CSS2DObject(text);
        label.position.set(0, part.heightMm + 4, 0);
        label.center.set(0.5, 1); // 标签底边对准零件上方
        node.add(label);
        group.add(node);
        items.push({ part, node, model, label, text });
      }
      place();
      applyGrow();
      onFrame();
      requestRender();
    },
    clear() {
      cancelAnimationFrame(anim);
      dispose();
      onFrame();
      requestRender();
    },
    /** 生长进度 0 → 1（转场第 3 步） */
    setGrow(t) {
      grow = clamp01(t);
      applyGrow();
      requestRender();
    },
    /** 切换方法：0.5 秒平滑移动到另一种方法的位置 */
    animateMethod(parallax) {
      cancelAnimationFrame(anim);
      const from = blend;
      const to = parallax ? 1 : 0;
      for (const it of items) it.text.innerHTML = labelText(it.part, parallax);
      const t0 = performance.now();
      const step = (now) => {
        const k = clamp01((now - t0) / METHOD_MOVE_MS);
        blend = from + (to - from) * easeInOutCubic(k);
        place();
        onFrame();
        requestRender();
        if (k < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    },
    setLabelsVisible(on) {
      labelsOn = on;
      applyGrow();
      requestRender();
    },
    /** 当前射线终点（底板坐标）：两种方法的落点在同一条视线上，按 blend 插值仍在视线上 */
    rayEnds() {
      return items
        .filter((it) => it.model.visible)
        .map(({ part: p }) => {
          const [x, y] = posAt(p, blend);
          return { point: [x, y, (p.heightMm / 2) * blend], color: CLASSES[p.cls].color };
        });
    },
    get count() {
      return items.length;
    },
  };
}
