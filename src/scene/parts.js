// 零件模型：每个类别用基础几何体拼成（步骤 3 合成图使用，步骤 10 的 3D 场景复用）。
// 模型的局部坐标：原点在零件中心正下方的板面上；底板 X、Y、Z 分别对应 Three.js 的 x、−z、y。
// 长条形零件（电阻、螺丝）沿局部 X 方向放置，绕 Z 轴旋转 rotDeg 后摆到板上。
import * as THREE from 'three';
import { CLASSES } from '../config.js';

/**
 * 每类零件的包围盒尺寸（mm）：lx 沿零件长轴，ly 垂直长轴，h 为高度（= CLASSES.heightMm）。
 * 真值 box 由这个包围盒投影得到，模型尺寸必须与之一致（有单元测试检查）。
 */
export const PART_SIZE = {
  0: { lx: 22, ly: 3, h: 3 },      // 色环电阻：本体 Φ3×8，两根引脚，总长 22
  1: { lx: 8, ly: 8, h: 12 },      // 电解电容：Φ8×12
  2: { lx: 5, ly: 5, h: 9 },       // LED：Φ5，柱体 6.5 + 半球
  3: { lx: 14.5, ly: 4, h: 4 },    // 螺丝（横躺）：杆 Φ2.5×12，圆头 Φ4×2.5
  4: { lx: 8, ly: 6.93, h: 3 },    // 螺母：外接圆 Φ8 的六棱柱，厚 3，孔 Φ3.4
  5: { lx: 10, ly: 10, h: 1 },     // 垫片：外 Φ10，内 Φ5，厚 1
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
    case 4: {
      // 螺母：带孔六棱柱（外接圆半径 4，角朝局部 X）
      const shape = new THREE.Shape();
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const p = [4 * Math.cos(a), 4 * Math.sin(a)];
        if (i === 0) shape.moveTo(...p);
        else shape.lineTo(...p);
      }
      shape.closePath();
      const hole = new THREE.Path();
      hole.absarc(0, 0, 1.7, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false, curveSegments: 24 });
      geo.rotateX(-Math.PI / 2); // 挤出方向朝上
      g.add(new THREE.Mesh(geo, material(4, { metalness: 0.45, roughness: 0.4 })));
      break;
    }
    case 5: {
      // 垫片：薄圆环
      const shape = new THREE.Shape();
      shape.absarc(0, 0, 5, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, 2.5, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 40 });
      geo.rotateX(-Math.PI / 2);
      g.add(new THREE.Mesh(geo, material(5, { metalness: 0.45, roughness: 0.35 })));
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
