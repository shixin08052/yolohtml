import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PART_SIZE, createPartMesh } from '../src/scene/parts.js';
import { CLASSES } from '../src/config.js';

describe('零件模型', () => {
  for (const c of CLASSES) {
    it(`${c.name}：模型包围盒与 PART_SIZE 一致，高度 = heightMm，放在板面上`, () => {
      const box = new THREE.Box3().setFromObject(createPartMesh(c.id));
      const s = PART_SIZE[c.id];
      // Three.js：x = 底板 X（长轴），y = 高度，z = −底板 Y
      expect(box.max.x - box.min.x).toBeCloseTo(s.lx, 1);
      expect(box.max.z - box.min.z).toBeCloseTo(s.ly, 1);
      expect(box.max.y - box.min.y).toBeCloseTo(s.h, 1);
      expect(s.h).toBe(c.heightMm);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThan(0.05);
      expect(Math.abs(box.max.z + box.min.z)).toBeLessThan(0.05);
    });
  }
});
