// 机械臂 3D 模型与动画。层级结构与 robot/ik.js 的关节一一对应：
// 底座（固定）→ 转台（绕 Z 转 θ₀）→ 肩关节（θ₁）→ 大臂 → 肘关节（θ₂）→ 小臂 → 腕关节（θ₃）→ 夹爪（两指可开合）。
// 转台局部坐标：x = 手臂伸出的水平方向，y = 向上，z = 关节转轴；俯仰关节都绕局部 z 轴转，
// 正角度把 +x 转向 +y（抬起），与 ik.js 中"从水平面量起、向上为正"一致。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ARM } from '../config.js';
import { toThree } from '../math/coords.js';
import { ikWorld, lerpAngles } from '../robot/ik.js';

/** 初始姿态：收拢竖起，指尖在底板前边外侧上方（底板坐标），不挡住底板 */
export const ARM_HOME = [148.5, -10, 200];

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 两组关节角之间的运动时长（ms）：按转动最多的关节估算 */
export function moveDuration(a, b) {
  const d0 = Math.abs(Math.atan2(Math.sin(b[0] - a[0]), Math.cos(b[0] - a[0])));
  const d = Math.max(d0, Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
  return Math.min(1800, Math.max(450, 350 + 900 * d));
}

/**
 * @param {{ requestRender: () => void }} deps
 */
export function createArm({ requestRender }) {
  const { L0, L1, L2, L3 } = ARM;
  const shell = new THREE.MeshStandardMaterial({ color: '#ebe8e2', roughness: 0.45, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.55, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: '#c96442', roughness: 0.4, metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ color: '#9aa0a6', roughness: 0.3, metalness: 0.8 });

  const mesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  /** 沿局部 z 轴的圆柱（关节） */
  const joint = (r, len, mat) => {
    const m = mesh(new THREE.CylinderGeometry(r, r, len, 40), mat);
    m.rotation.x = Math.PI / 2;
    return m;
  };
  /** 沿局部 x 轴、从 x0 到 x1 的圆角方杆 */
  const link = (x0, x1, h, w, mat) => {
    const m = mesh(new RoundedBoxGeometry(x1 - x0, h, w, 3, Math.min(h, w) * 0.3), mat);
    m.position.x = (x0 + x1) / 2;
    return m;
  };

  const group = new THREE.Group();
  group.name = 'arm';
  group.position.copy(toThree(...ARM.base));

  // —— 底座（固定）
  const plinth = mesh(new THREE.CylinderGeometry(46, 50, 10, 48), dark);
  plinth.position.y = 5;
  group.add(plinth);

  // —— 转台：θ₀ 绕竖直轴（底板 Z 逆时针 = Three.js 绕 y 正转）
  const turret = new THREE.Group();
  turret.name = 'turret';
  group.add(turret);
  const disk = mesh(new THREE.CylinderGeometry(36, 38, 8, 48), accent);
  disk.position.y = 14;
  turret.add(disk);
  const column = mesh(new THREE.CylinderGeometry(24, 28, L0 - 18, 40), shell);
  column.position.y = 18 + (L0 - 18) / 2 - 6;
  turret.add(column);

  // —— 肩关节（θ₁）
  const shoulder = new THREE.Group();
  shoulder.name = 'shoulder';
  shoulder.position.y = L0;
  turret.add(shoulder);
  shoulder.add(joint(19, 50, dark), joint(13, 54, accent));
  shoulder.add(link(0, L1, 26, 22, shell));

  // —— 肘关节（θ₂）
  const elbow = new THREE.Group();
  elbow.name = 'elbow';
  elbow.position.x = L1;
  shoulder.add(elbow);
  elbow.add(joint(16, 42, dark), joint(10, 46, accent));
  elbow.add(link(0, L2, 21, 18, shell));

  // —— 腕关节（θ₃）与夹爪：夹爪沿局部 +x，指尖在 x = L3
  const wrist = new THREE.Group();
  wrist.name = 'wrist';
  wrist.position.x = L2;
  elbow.add(wrist);
  wrist.add(joint(12, 34, dark), joint(7, 38, accent));
  const housing = mesh(new THREE.CylinderGeometry(11, 11, 26, 32), shell);
  housing.rotation.z = -Math.PI / 2; // 圆柱轴转到局部 x
  housing.position.x = 13 + 3;
  wrist.add(housing);
  const palm = link(29, 38, 16, 46, dark);
  wrist.add(palm);
  // 两根手指沿局部 z 分开，开合时沿 z 平移
  const fingers = [-1, 1].map((side) => {
    const f = link(38, L3, 9, 4, steel);
    const pad = link(L3 - 10, L3, 9, 1.5, accent);
    pad.position.z = -side * 2.6;
    const g = new THREE.Group();
    g.add(f, pad);
    g.userData.side = side;
    wrist.add(g);
    return g;
  });

  /** 夹爪开口（两指内侧间距，mm） */
  const GRIP = { min: 2, max: 34 };
  let grip = 1;
  function setGrip(open) {
    grip = Math.min(1, Math.max(0, open));
    const gap = GRIP.min + (GRIP.max - GRIP.min) * grip;
    for (const f of fingers) f.position.z = f.userData.side * (gap / 2 + 2);
    requestRender();
  }

  /** 当前关节角 [θ₀, θ₁, θ₂, θ₃] */
  let angles = [0, 0, 0, -Math.PI / 2];
  function setAngles(a) {
    angles = [...a];
    turret.rotation.y = a[0];
    shoulder.rotation.z = a[1];
    elbow.rotation.z = a[2];
    wrist.rotation.z = a[3];
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

  const home = ikWorld(ARM_HOME, ARM);
  const homeAngles = home.angles;
  setAngles(homeAngles);
  setGrip(1);

  return {
    group,
    setAngles,
    animateTo,
    stop,
    setGrip,
    homeAngles,
    get angles() {
      return [...angles];
    },
    get grip() {
      return grip;
    },
    /** 指尖在场景里的位置（由 Three.js 层级算出，用来核对与 fk 是否一致） */
    tipFromScene() {
      group.updateMatrixWorld(true);
      return new THREE.Vector3(L3, 0, 0).applyMatrix4(wrist.matrixWorld);
    },
  };
}
