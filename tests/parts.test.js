import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PART_SIZE, createPartMesh, bodyBox } from '../src/scene/parts.js';
import { CLASSES } from '../src/config.js';

describe('零件模型', () => {
  for (const c of CLASSES) {
    it(`${c.name}：本体包围盒与 PART_SIZE 一致且以原点为中心，高度 = heightMm，放在板面上`, () => {
      const m = createPartMesh(c.id);
      const box = bodyBox(m);
      const s = PART_SIZE[c.id];
      // Three.js：x = 底板 X（长轴），y = 高度，z = −底板 Y
      expect(box.max.x - box.min.x).toBeCloseTo(s.lx, 1);
      expect(box.max.z - box.min.z).toBeCloseTo(s.ly, 1);
      expect(box.max.y - box.min.y).toBeCloseTo(s.h, 1);
      expect(s.h).toBe(c.heightMm);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(0.05);
      expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(0.05);
      // 整个模型（含引脚）也放在板面上
      expect(new THREE.Box3().setFromObject(m).min.y).toBeGreaterThan(-0.05);
    });
  }

  it('电阻、LED 有引脚：引脚伸出本体之外；LED 引脚只在灯头的反方向', () => {
    for (const cls of [0, 1]) {
      const m = createPartMesh(cls);
      const full = new THREE.Box3().setFromObject(m);
      const body = bodyBox(m);
      expect(full.max.x - full.min.x).toBeGreaterThan(body.max.x - body.min.x + 10);
    }
    const led = createPartMesh(1);
    const full = new THREE.Box3().setFromObject(led);
    expect(full.min.x).toBeLessThan(-20);
    expect(full.max.x).toBeCloseTo(PART_SIZE[1].lx / 2, 1);
  });
});
