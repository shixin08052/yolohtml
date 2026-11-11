// 机械臂 3D 模型与动画。层级结构与 robot/ik.js 的关节一一对应：
// 底座（固定）→ 转台（绕 Z 转 θ₀）→ 肩关节（θ₁）→ 大臂 → 肘关节（θ₂）→ 小臂 → 腕关节俯仰（θ₃）
// → 腕关节转动（θ₄）→ 夹爪（两指可开合）。
// 转台局部坐标：x = 手臂伸出的水平方向，y = 向上，z = 关节转轴；俯仰关节都绕局部 z 轴转，
// 正角度把 +x 转向 +y（抬起），与 ik.js 中"从水平面量起、向上为正"一致。
// 大臂是两片侧板的叉形结构，小臂夹在两片侧板之间，肘关节折得很深时也不会互相穿插。
// 外形尺寸与 ik.js 的 ARM_SHAPE（碰撞检查用）对应：细节（倒角、螺栓、减重孔、指示灯）都在原来的外形之内。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ARM, BOARD } from '../config.js';
import { toThree } from '../math/coords.js';
import { ikWorld, lerpAngles } from '../robot/ik.js';
import { GRIP_MAX } from '../robot/sequence.js';

/** 初始姿态：收拢竖起，指尖在底板远边外侧上方（底板坐标），不伸到底板上方 */
export const ARM_HOME = [148.5, BOARD.height + 10, 200];

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 两组关节角之间的运动时长（ms）：按转动最多的关节估算 */
export function moveDuration(a, b) {
  const d0 = Math.abs(Math.atan2(Math.sin(b[0] - a[0]), Math.cos(b[0] - a[0])));
  const d4 = Math.abs((b[4] ?? 0) - (a[4] ?? 0));
  const d = Math.max(d0, Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]), d4);
  return Math.min(1800, Math.max(450, 350 + 900 * d));
}

/**
 * @param {{ requestRender: () => void }} deps
 */
export function createArm({ requestRender }) {
  const { L0, L1, L2, L3 } = ARM;
  // 材质：烤漆外壳（带一层清漆）、阳极氧化的深色铝件、橙色点缀、抛光钢件（靠环境反射）、橡胶
  const shell = new THREE.MeshPhysicalMaterial({ color: '#efede8', roughness: 0.42, metalness: 0.05, clearcoat: 0.55, clearcoatRoughness: 0.22 });
  const dark = new THREE.MeshStandardMaterial({ color: '#33363b', roughness: 0.48, metalness: 0.55, envMapIntensity: 2 });
  const accent = new THREE.MeshPhysicalMaterial({ color: '#c96442', roughness: 0.36, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ color: '#b4b9bf', roughness: 0.22, metalness: 1, envMapIntensity: 3 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#1c1d1f', roughness: 0.95, metalness: 0 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#7fe3a1', emissive: '#35d07f', emissiveIntensity: 1.6, roughness: 0.4 });

  const mesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  /** 沿局部 z 轴的圆柱（关节轴套） */
  const joint = (r, len, mat) => {
    const m = mesh(new THREE.CylinderGeometry(r, r, len, 48), mat);
    m.rotation.x = Math.PI / 2;
    return m;
  };
  /** 沿局部 x 轴、从 x0 到 x1 的圆角方杆；h 为局部 y 方向厚度，w 为局部 z 方向宽度，z 为中心偏移 */
  const link = (x0, x1, h, w, mat, z = 0) => {
    const m = mesh(new RoundedBoxGeometry(x1 - x0, h, w, 4, Math.min(h, w) * 0.3), mat);
    m.position.set((x0 + x1) / 2, 0, z);
    return m;
  };
  /** 绕竖直轴的旋转体：profile 为 [半径, 高度] 的折线（带倒角的底座、转盘、立柱） */
  const turned = (profile, mat, seg = 64) => mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg), mat);
  /** 关节端盖：轴套两端各一个略小的圆盘，上面一圈内六角螺栓头（沿局部 z，在 z = ±half 处） */
  const caps = (parent, r, half, { capMat = steel, bolts = 6 } = {}) => {
    for (const s of [-1, 1]) {
      const cap = mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.78, 1.2, 40), capMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.z = s * (half + 0.6);
      parent.add(cap);
      for (let i = 0; i < bolts; i++) {
        const a = (i / bolts) * Math.PI * 2 + 0.3;
        const b = mesh(new THREE.CylinderGeometry(r * 0.085, r * 0.085, 1.1, 6), dark);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(a) * r * 0.54, Math.sin(a) * r * 0.54, s * (half + 1.3));
        parent.add(b);
      }
    }
  };
  /**
   * 大臂侧板：两头是圆的长条板（"跑道形"），中间开两个减重孔，边缘倒角。板在局部 xy 平面里，厚度沿 z。
   * @param {number} len 两端圆心的距离
   * @param {number} r 端部半径（板高的一半）
   * @param {number} thick 板厚
   */
  const sidePlate = (len, r, thick, mat) => {
    const s = new THREE.Shape();
    s.absarc(0, 0, r, Math.PI / 2, Math.PI * 1.5);
    s.absarc(len, 0, r, -Math.PI / 2, Math.PI / 2);
    s.closePath();
    const slot = (x0, x1, hr) => {
      const h = new THREE.Path();
      h.absarc(x0, 0, hr, Math.PI / 2, Math.PI * 1.5);
      h.absarc(x1, 0, hr, -Math.PI / 2, Math.PI / 2);
      h.closePath();
      return h;
    };
    s.holes.push(slot(len * 0.27, len * 0.46, r * 0.36), slot(len * 0.6, len * 0.79, r * 0.36));
    const bevel = 0.8;
    const geo = new THREE.ExtrudeGeometry(s, { depth: thick - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 24 });
    geo.translate(0, 0, -(thick - 2 * bevel) / 2); // 厚度方向居中
    return mesh(geo, mat);
  };

  const group = new THREE.Group();
  group.name = 'arm';
  group.position.copy(toThree(...ARM.base));

  // —— 底座（固定）：带倒角的法兰盘，一圈固定螺栓，底下一圈橡胶垫
  group.add(turned([[0, 0], [50, 0], [50, 5], [48.5, 7.5], [46, 10], [0, 10]], dark));
  const foot = mesh(new THREE.CylinderGeometry(50.6, 50.6, 1.4, 64), rubber);
  foot.position.y = 0.7;
  group.add(foot);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const bolt = mesh(new THREE.CylinderGeometry(2.1, 2.1, 1.6, 6), steel);
    bolt.position.set(Math.cos(a) * 42.5, 10.4, Math.sin(a) * 42.5);
    group.add(bolt);
  }

  // —— 转台：θ₀ 绕竖直轴（底板 Z 逆时针 = Three.js 绕 y 正转）
  const turret = new THREE.Group();
  turret.name = 'turret';
  group.add(turret);
  turret.add(turned([[0, 10], [38, 10], [38, 15.5], [36.5, 18], [0, 18]], accent));
  // 立柱：下粗上细，腰上两道深色的装饰槽，肩部收一圈
  const top = L0 - 12;
  turret.add(turned([[0, 18], [27, 18], [26.2, 22], [24, top - 8], [22, top - 2], [20.5, top], [0, top]], shell));
  for (const y of [26, 31]) {
    const groove = mesh(new THREE.TorusGeometry(26.2 - (y - 22) * 0.045, 0.55, 8, 64), dark);
    groove.rotation.x = Math.PI / 2;
    groove.position.y = y;
    turret.add(groove);
  }
  // 立柱正面（朝手臂伸出的方向）一颗状态指示灯
  const light = mesh(new THREE.SphereGeometry(1.5, 16, 12), lamp);
  light.position.set(24.6, 40, 0);
  light.castShadow = false;
  turret.add(light);
  const bezel = mesh(new THREE.TorusGeometry(1.9, 0.45, 8, 24), dark);
  bezel.rotation.y = Math.PI / 2;
  bezel.position.set(24.4, 40, 0);
  turret.add(bezel);
  // 肩关节支座：立柱顶上的 U 形叉
  for (const z of [-21, 21]) {
    const cheek = mesh(new RoundedBoxGeometry(34, 30, 6, 4, 2), dark);
    cheek.position.set(0, L0 - 8, z);
    turret.add(cheek);
  }

  // —— 肩关节（θ₁）与大臂：两片带减重孔的侧板，中间留出小臂折进来的空间
  const shoulder = new THREE.Group();
  shoulder.name = 'shoulder';
  shoulder.position.y = L0;
  turret.add(shoulder);
  shoulder.add(joint(18, 36, dark), joint(9, 50, accent));
  caps(shoulder, 9, 25, { bolts: 5 });
  for (const z of [-14, 14]) {
    const plate = sidePlate(L1, 13, 6, shell);
    plate.position.z = z;
    shoulder.add(plate);
  }
  shoulder.add(link(10, 40, 20, 34, shell)); // 靠近肩部的横撑（小臂折叠时到不了这里）
  // 横撑上一条橙色饰线
  shoulder.add(link(14, 36, 20.6, 4, accent));

  // —— 肘关节（θ₂）与小臂
  const elbow = new THREE.Group();
  elbow.name = 'elbow';
  elbow.position.x = L1;
  shoulder.add(elbow);
  elbow.add(joint(14, 22, dark), joint(7, 40, accent));
  caps(elbow, 7, 20, { bolts: 5 });
  elbow.add(link(0, L2, 18, 16, shell));
  // 小臂：靠肘部一段深色护套，中段一条橙色饰带，靠腕部一圈深色收口
  elbow.add(link(14, 46, 18.8, 16.8, dark));
  elbow.add(link(L2 * 0.5 - 2.5, L2 * 0.5 + 2.5, 18.5, 16.5, accent));
  elbow.add(link(L2 - 26, L2 - 14, 18.6, 16.6, dark));

  // —— 腕关节俯仰（θ₃）：夹爪沿局部 +x，指尖在 x = L3
  const wrist = new THREE.Group();
  wrist.name = 'wrist';
  wrist.position.x = L2;
  elbow.add(wrist);
  wrist.add(joint(11, 20, dark), joint(6, 26, accent));
  caps(wrist, 6, 13, { bolts: 4 });

  // —— 腕关节转动（θ₄）：绕夹爪自身的轴（局部 x）转
  const roll = new THREE.Group();
  roll.name = 'roll';
  wrist.add(roll);
  const housing = mesh(new THREE.CylinderGeometry(11, 11, 22, 48), shell);
  housing.rotation.z = -Math.PI / 2; // 圆柱轴转到局部 x
  housing.position.x = 18;
  roll.add(housing);
  // 壳体上两道细槽 + 前端的橙色法兰
  for (const x of [12, 15]) {
    const g = mesh(new THREE.TorusGeometry(11.05, 0.4, 8, 48), dark);
    g.rotation.y = Math.PI / 2;
    g.position.x = x;
    roll.add(g);
  }
  const ring = mesh(new THREE.CylinderGeometry(11.6, 11.6, 3, 48), accent);
  ring.rotation.z = -Math.PI / 2;
  ring.position.x = 28;
  roll.add(ring);
  // 掌板：手指沿它上面的导轨开合
  roll.add(link(29, 38, 16, 46, dark));
  const rail = link(36.2, 38.6, 5, 44, steel);
  roll.add(rail);
  // 两根手指沿局部 z 分开，开合时沿 z 平移；指尖内侧有一块垫片，开口按两块垫片的间距算
  const fingers = [-1, 1].map((side) => {
    const f = link(38, L3, 9, 4, steel);
    const pad = link(L3 - 10, L3, 9, 1.5, rubber);
    pad.position.z = -side * 2.75; // 垫片内侧面在手指中心往里 3.5 mm
    // 滑块：手指根部骑在导轨上的一块
    const carriage = link(34.5, 40.5, 12, 6.5, dark);
    // 手指外侧一条橙色标记
    const mark = link(L3 - 22, L3 - 12, 9.4, 0.8, accent);
    mark.position.z = side * 1.8;
    const g = new THREE.Group();
    g.add(f, pad, carriage, mark);
    g.userData.side = side;
    roll.add(g);
    return g;
  });

  /** 夹爪开口：两块垫片内侧的间距（mm），0 – GRIP_MAX */
  let gap = GRIP_MAX;
  function setGap(mm) {
    gap = Math.min(GRIP_MAX, Math.max(0, mm));
    for (const f of fingers) f.position.z = f.userData.side * (gap / 2 + 3.5);
    requestRender();
  }
  /** 夹爪开合程度 0（闭合）– 1（全开） */
  const setGrip = (open) => setGap(GRIP_MAX * Math.min(1, Math.max(0, open)));

  /** 当前关节角 [θ₀, θ₁, θ₂, θ₃, θ₄] */
  let angles = [0, 0, 0, -Math.PI / 2, 0];
  function setAngles(a) {
    angles = [a[0], a[1], a[2], a[3], a[4] ?? 0];
    turret.rotation.y = a[0];
    shoulder.rotation.z = a[1];
    elbow.rotation.z = a[2];
    wrist.rotation.z = a[3];
    // 夹爪朝下时，绕局部 x 转 −θ₄ 使两指连线方向 = θ₀ + 90° + θ₄（与 ik.js 的约定一致）
    roll.rotation.x = -angles[4];
    requestRender();
  }

  let anim = 0;
  let animReject = null;
  /** 停止正在进行的动画（Promise 以 'cancelled' 拒绝） */
  function stop() {
    cancelAnimationFrame(anim);
    anim = 0;
    if (animReject) animReject(new Error('cancelled'));
    animReject = null;
  }

  /**
   * 关节空间插值运动到目标关节角（θ₃ 由 θ₁、θ₂ 推出，途中夹爪始终竖直向下）
   * @param {number[]} target
   * @param {{ ms?: number, onFrame?: (angles: number[]) => void }} [opts]
   * @returns {Promise<void>}
   */
  function animateTo(target, { ms, onFrame } = {}) {
    stop();
    const from = [...angles];
    const dur = ms ?? moveDuration(from, target);
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      animReject = reject;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        setAngles(lerpAngles(from, target, easeInOutCubic(k)));
        onFrame?.(angles);
        if (k < 1) {
          anim = requestAnimationFrame(step);
        } else {
          anim = 0;
          animReject = null;
          resolve();
        }
      };
      anim = requestAnimationFrame(step);
    });
  }

  /** 依次经过若干组关节角 */
  async function animatePath(list, opts) {
    for (const a of list) await animateTo(a, opts);
  }

  const home = ikWorld(ARM_HOME, ARM);
  if (!home.reachable) throw new Error(`机械臂初始姿态不可达：${home.reason}`);
  const homeAngles = home.angles;
  setAngles(homeAngles);
  setGrip(1);

  return {
    group,
    setAngles,
    animateTo,
    animatePath,
    stop,
    setGrip,
    homeAngles,
    get angles() {
      return [...angles];
    },
    setGap,
    get gap() {
      return gap;
    },
    /** 夹住零件时把零件挂到这个节点下（随腕部转动） */
    gripNode: roll,
    /** 指尖在场景里的位置（由 Three.js 层级算出，用来核对与 fk 是否一致） */
    tipFromScene() {
      group.updateMatrixWorld(true);
      return new THREE.Vector3(L3, 0, 0).applyMatrix4(roll.matrixWorld);
    },
    /** 两根手指指尖在场景里的位置（核对夹爪转动方向用） */
    fingerTipsFromScene() {
      group.updateMatrixWorld(true);
      return fingers.map((f) => new THREE.Vector3(L3 - 2, 0, 0).applyMatrix4(f.matrixWorld));
    },
  };
}
