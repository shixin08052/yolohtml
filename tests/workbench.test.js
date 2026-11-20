import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWorkbench, ESD_MAT } from '../src/scene/workbench.js';
import { BOARD, BIN_SLOTS, BIN_SIZE } from '../src/config.js';
import { fromThree } from '../src/math/coords.js';

/** 提取对象内所有实体网格（排除透明接触阴影贴片）的世界包围盒列表 */
function solidMeshBoxes(rootObj) {
  const list = [];
  rootObj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => m && m.depthWrite === false)) return;
    list.push(new THREE.Box3().setFromObject(o));
  });
  return list;
}

/** 合并实体网格包围盒 */
function solidBox(rootObj) {
  const box = new THREE.Box3();
  for (const b of solidMeshBoxes(rootObj)) box.union(b);
  return box;
}

describe('实验室工作台 3D 场景', () => {
  const wb = createWorkbench();
  wb.updateMatrixWorld(true);

  const props = [
    'arm-controller',
    'emergency-stop',
    'bench-power-supply',
    'lab-gantry',
    'digital-caliper',
    'spare-parts-tray',
    'esd-tweezers',
    'flush-cutters',
  ];

  it('包含防静电台垫、实木复合工作台桌面、控制器、稳压电源、急停、龙门架及全部实验工具', () => {
    for (const name of ['table', 'workbench-top', 'oscilloscope', 'component-cabinet', ...props]) {
      expect(wb.getObjectByName(name), `缺少节点 ${name}`).toBeTruthy();
    }
  });

  it('防静电台垫顶面与底板底面（Z = −BOARD.thickness）齐平，实木桌面紧贴台垫下方', () => {
    const matBox = solidBox(wb.getObjectByName('table'));
    const topBox = solidBox(wb.getObjectByName('workbench-top'));
    expect(matBox.max.y).toBeCloseTo(-BOARD.thickness, 1);
    expect(topBox.max.y).toBeCloseTo(-BOARD.thickness - ESD_MAT.thick, 1);
  });

  it('外围实验仪器与工具均位于 A4 标定板及 7 个分拣料盒工位之外，互不干涉', () => {
    const [bsx, bsy] = BIN_SIZE;
    const zones = [
      { name: 'A4 底板', minX: 0, maxX: BOARD.width, minY: 0, maxY: BOARD.height },
      ...Object.entries(BIN_SLOTS).map(([k, [cx, cy]]) => ({
        name: `料盒 ${k}`,
        minX: cx - bsx / 2,
        maxX: cx + bsx / 2,
        minY: cy - bsy / 2,
        maxY: cy + bsy / 2,
      })),
    ];

    for (const propName of props) {
      const box = solidBox(wb.getObjectByName(propName));
      const pMin = fromThree(box.min);
      const pMax = fromThree(box.max);
      const minX = Math.min(pMin[0], pMax[0]);
      const maxX = Math.max(pMin[0], pMax[0]);
      const minY = Math.min(pMin[1], pMax[1]);
      const maxY = Math.max(pMin[1], pMax[1]);

      for (const z of zones) {
        const overlapX = minX < z.maxX && maxX > z.minX;
        const overlapY = minY < z.maxY && maxY > z.minY;
        expect(overlapX && overlapY, `${propName} 与 ${z.name} 发生空间重叠`).toBe(false);
      }
    }
  });

  it('工作台所有独立仪器与工具逐网格两两零穿模，且斜口钳与稳压电源保持充裕净距', () => {
    const entries = props.map((name) => ({ name, meshes: solidMeshBoxes(wb.getObjectByName(name)) }));
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        let hit = false;
        for (const ba of a.meshes) {
          for (const bb of b.meshes) {
            if (ba.intersectsBox(bb)) {
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
        expect(hit, `${a.name} 与 ${b.name} 发生 3D 穿模`).toBe(false);
      }
    }

    // 显式核对斜口钳（flush-cutters）与稳压电源（bench-power-supply）之间的 Y 向净距 > 60 mm
    const cutBox = solidBox(wb.getObjectByName('flush-cutters'));
    const psuBox = solidBox(wb.getObjectByName('bench-power-supply'));
    const cutMaxY = Math.max(fromThree(cutBox.min)[1], fromThree(cutBox.max)[1]);
    const psuMinY = Math.min(fromThree(psuBox.min)[1], fromThree(psuBox.max)[1]);
    expect(psuMinY - cutMaxY).toBeGreaterThan(60);
  });

  it('铝合金零件盘内的备用元件均严格收容在盘壁直径之内，不穿透盘壁', () => {
    const tray = wb.getObjectByName('spare-parts-tray');
    const box = solidBox(tray);
    const spanX = box.max.x - box.min.x;
    const spanZ = box.max.z - box.min.z;
    expect(spanX).toBeLessThanOrEqual(82);
    expect(spanZ).toBeLessThanOrEqual(82);
  });
});
