// 零件模型：每个类别用基础几何体拼成（步骤 3 合成图使用，步骤 10 的 3D 场景复用）。
// 模型的局部坐标：原点在零件本体中心正下方的板面上；底板 X、Y、Z 分别对应 Three.js 的 x、−z、y。
// 长条形零件（电阻、LED，都是躺平放的）沿局部 X 方向放置，绕 Z 轴旋转 rotDeg 后摆到板上。
// 检测框只框零件本体（不含电阻、LED 的引脚）：引脚是模型里固定的部分，知道本体中心和朝向就能摆出整个零件。
// 引脚网格带 userData.lead = true，计算本体包围盒时排除。
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CLASSES } from '../config.js';
import { toThree } from '../math/coords.js';

/**
 * 每类零件本体的包围盒尺寸（mm，不含引脚）：lx 沿零件长轴，ly 垂直长轴，h 为高度（= CLASSES.heightMm）。
 * 本体包围盒以模型原点为中心。真值 box 由它投影得到，模型尺寸必须与之一致（有单元测试检查）。
 */
export const PART_SIZE = {
  0: { lx: 6.3, ly: 2.4, h: 2.4 }, // 色环电阻（1/4 W 金属膜）：本体长 6.3，两头端帽 Φ2.4、中部 Φ2.0（另有两根 Φ0.5 引脚，各伸出 24 mm）
  1: { lx: 8.5, ly: 5.8, h: 5.8 }, // LED（躺平）：Φ5.8 底边 + Φ5 灯体 + 半球头，灯头朝局部 +X（另有两根引脚 20 / 18 mm 伸向 −X）
};

/**
 * 零件本体（不含引脚）在模型局部坐标下的包围盒
 * @param {THREE.Object3D} obj createPartMesh 的结果
 * @returns {THREE.Box3}
 */
export function bodyBox(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  obj.traverse((o) => {
    if (o.isMesh && !o.userData.lead) box.expandByObject(o);
  });
  return box;
}

const material = (cls, opts = {}) =>
  new THREE.MeshStandardMaterial({ color: CLASSES[cls].color, roughness: 0.55, metalness: 0.1, ...opts });

/** 沿局部 X 轴横躺的圆柱，中心在 (cx, cy) 高度处 */
function lyingCylinder(r, len, mat, cx, cy) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), mat);
  m.rotation.z = Math.PI / 2;
  m.position.set(cx, cy, 0);
  return m;
}

const leadCache = new Map();
/**
 * 引脚在模型局部坐标下占的范围（俯视，含本体）：{ minX, maxX, halfW }；没有引脚的类别返回 null。
 * 用来在底板贴图上擦掉照片里的引脚（检测框只框本体，引脚的位置由模型和朝向推出）。
 * @param {number} cls
 */
export function leadFootprint(cls) {
  if (!leadCache.has(cls)) {
    const m = createPartMesh(cls);
    m.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let any = false;
    m.traverse((o) => {
      if (o.isMesh && o.userData.lead) {
        box.expandByObject(o);
        any = true;
      }
      if (o.isMesh) o.geometry.dispose();
    });
    const body = bodyBox(m);
    leadCache.set(cls, any ? { minX: Math.min(box.min.x, body.min.x), maxX: Math.max(box.max.x, body.max.x), halfW: Math.max(-box.min.z, box.max.z) } : null);
  }
  return leadCache.get(cls);
}

const footprintCache = new Map();
/**
 * 零件俯视的占地（模型局部坐标，含引脚）：本体、引脚各一个矩形 { minX, maxX, halfW }，以及本体高度。
 * 料盒里摆放零件时用来判断是否重叠（robot/drop.js）。
 * @param {number} cls
 * @returns {{ rects: {minX:number, maxX:number, halfW:number}[], height: number }}
 */
export function partFootprint(cls) {
  if (!footprintCache.has(cls)) {
    const m = createPartMesh(cls);
    m.updateMatrixWorld(true);
    const body = bodyBox(m);
    const leads = new THREE.Box3();
    m.traverse((o) => {
      if (o.isMesh && o.userData.lead) leads.expandByObject(o);
      if (o.isMesh) o.geometry.dispose();
    });
    // Three.js 的 z = −局部 y
    const rect = (b) => ({ minX: b.min.x, maxX: b.max.x, halfW: Math.max(-b.min.z, b.max.z) });
    const rects = [rect(body)];
    if (!leads.isEmpty()) rects.push(rect(leads));
    footprintCache.set(cls, { rects, height: body.max.y - body.min.y });
  }
  return footprintCache.get(cls);
}

/** LED 模型整体沿 X 的平移量，使本体（底边到灯头）居中 */
const LED_SHIFT = -1.75;

/** 色环电阻的外形（mm）：本体沿局部 X，端帽鼓、中间细；色环按 5 环色码（10 kΩ ±1%：棕黑黑红 + 棕） */
const RESISTOR = {
  len: 6.3,       // 本体长
  capR: 1.2,      // 端帽半径（Φ2.4）
  midR: 1.0,      // 中部半径（Φ2.0）
  color: '#2f6e9c', // 本体：实物是偏深的蓝色漆面
  bandW: 0.42,    // 色环宽
  bandLift: 0.012, // 色环比本体表面高一点，避免与本体表面闪烁
  leadR: 0.25,    // 引脚半径（Φ0.5）
  leadLen: 24,    // 引脚伸出长度
  bands: [[-2.3, '#7b4a2a'], [-1.25, '#1b1b1b'], [-0.55, '#1b1b1b'], [0.15, '#c8312b'], [2.3, '#7b4a2a']],
};

/** 电阻本体在 x 处的半径：中部细、端帽鼓，两端收成圆头 */
function resistorRadius(x) {
  const R = RESISTOR;
  const a = Math.abs(x);
  const half = R.len / 2;
  const smooth = (t) => t * t * (3 - 2 * t);
  // 中部 |x| < 1.3 → 端帽 |x| > 1.9，之间平滑过渡
  let r = R.midR + (R.capR - R.midR) * smooth(Math.min(1, Math.max(0, (a - 1.3) / 0.6)));
  // 端头 0.55 mm 内按椭圆收圆
  const e = 0.55;
  if (a > half - e) r = R.capR * Math.sqrt(Math.max(0, 1 - ((a - (half - e)) / e) ** 2));
  return r;
}

/**
 * 沿局部 X 轴的旋转体：半径由 radius(x) 给出，取 x ∈ [x0, x1]，半径再加 lift
 * @returns {THREE.Mesh}
 */
function lathe(radius, x0, x1, n, lift, mat) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const r = radius(x);
    pts.push(new THREE.Vector2(r > 0 ? r + lift : 0, x));
  }
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat);
  m.rotation.z = -Math.PI / 2; // 旋转轴 Y → X
  return m;
}

/** 两点之间的细圆柱（引脚） */
function rod(p0, p1, r, mat) {
  const d = new THREE.Vector3().subVectors(p1, p0);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
  m.position.copy(p0).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
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
      // 色环电阻（1/4 W 蓝色金属膜）：两头端帽鼓起、中间细的"哑铃"形旋转体 + 5 道色环 + 两根引脚
      const R = RESISTOR;
      const axisY = R.capR + R.bandLift; // 横躺在板面上：色环最低点贴着板面
      const body = lathe(resistorRadius, -R.len / 2, R.len / 2, 96, 0, material(0, { color: R.color, roughness: 0.32 }));
      body.position.y = axisY;
      g.add(body);
      for (const [x, c] of R.bands) {
        const ring = lathe(resistorRadius, x - R.bandW / 2, x + R.bandW / 2, 6, R.bandLift, new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 }));
        ring.position.y = axisY;
        g.add(ring);
      }
      // 引脚：从端帽里伸出，略微下垂搭到板面上
      const lead = new THREE.MeshStandardMaterial({ color: '#c9cdd1', metalness: 0.75, roughness: 0.3 });
      for (const s of [-1, 1]) {
        const p0 = new THREE.Vector3(s * (R.len / 2 - 0.3), axisY, 0);
        const p1 = new THREE.Vector3(s * (R.len / 2 + R.leadLen), R.leadR, 0);
        g.add(Object.assign(rod(p0, p1, R.leadR, lead), { userData: { lead: true } }));
      }
      break;
    }
    case 1: {
      // LED（躺平，像实物那样侧放在桌上）：灯体靠底边撑起，轴心高 2.9；两根引脚从底边伸出、斜搭到桌面
      // 未平移前：底边 x ∈ [−2.5, −1.5]，灯体 [−1.5, 3.5]，半球头到 6.0，引脚到 −22.5；整体平移 −1.75 使本体居中
      const S = LED_SHIFT;
      const mat = material(1, { roughness: 0.25, transparent: true, opacity: 0.92 });
      const axisY = 2.9;
      g.add(lyingCylinder(2.9, 1, mat, -2 + S, axisY)); // 底边
      g.add(lyingCylinder(2.5, 5, mat, 1 + S, axisY)); // 灯体
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
      dome.rotation.z = -Math.PI / 2; // 半球朝 +X
      dome.position.set(3.5 + S, axisY, 0);
      g.add(dome);
      const lead = new THREE.MeshStandardMaterial({ color: '#c0c4c8', metalness: 0.6, roughness: 0.35 });
      for (const [z, len] of [[1.27, 20], [-1.27, 18]]) {
        const p0 = new THREE.Vector3(-2.5 + S, axisY, z);
        const p1 = new THREE.Vector3(-2.5 - len + S, 0.25, z);
        g.add(Object.assign(rod(p0, p1, 0.25, lead), { userData: { lead: true } }));
      }
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

const Y_AXIS = new THREE.Vector3(0, 1, 0);
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
 * @param {{ requestRender: () => void, onFrame?: () => void }} deps onFrame：零件位置变化后
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
      if (it.moved) continue; // 已被机械臂拿走的零件不再跟随方法切换
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
      it.label.visible = labelsOn && k >= 1 && !it.labelHidden;
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
      it.node.removeFromParent(); // 可能正挂在夹爪上
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
    /** 零件的场景节点（分拣时挂到夹爪上） */
    nodeOf(id) {
      return items.find((it) => it.part.id === id)?.node ?? null;
    },
    /** 标记零件已被机械臂拿走（之后切换方法时不再移动它），可同时隐藏标签 */
    setMoved(id, { hideLabel = false } = {}) {
      const it = items.find((x) => x.part.id === id);
      if (!it) return;
      it.moved = true;
      it.labelHidden = hideLabel;
      applyGrow();
      requestRender();
    },
    /**
     * 直接摆放零件（底板坐标；yawDeg 为零件模型的朝向，与 Part.rotDeg 同一约定），用于落进料盒的动画。
     * 零件应已挂在 group 下（不在夹爪上）。
     */
    setPose(id, [x, y, z, yawDeg]) {
      const it = items.find((q) => q.part.id === id);
      if (!it) return;
      it.node.position.copy(toThree(x, y, z));
      it.node.quaternion.setFromAxisAngle(Y_AXIS, (yawDeg * Math.PI) / 180 - it.model.rotation.y);
      requestRender();
    },
    /** 不可达零件的标签标红 */
    markUnreachable(ids) {
      const set = new Set(ids);
      for (const it of items) it.text.classList.toggle('bad', set.has(it.part.id));
      requestRender();
    },
    get count() {
      return items.length;
    },
  };
}
