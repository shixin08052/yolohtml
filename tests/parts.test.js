// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PART_SIZE, createPartMesh, bodyBox, createPartsLayer } from '../src/scene/parts.js';
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

  it('默认隐藏遮挡视野的悬浮标签和常驻圆环，并用材质亮暗区分选中与未选中', () => {
    const layer = createPartsLayer({ requestRender: () => {} });
    layer.setParts(
      [
        { id: 1, cls: 0, xPlane: 80, yPlane: 80, xParallax: 80, yParallax: 80, rotDeg: 0, heightMm: 2.4, score: 0.95 },
        { id: 2, cls: 1, color: 'red', xPlane: 140, yPlane: 100, xParallax: 140, yParallax: 100, rotDeg: 0, heightMm: 5.8, score: 0.96 },
        { id: 3, cls: 1, color: 'clear', xPlane: 180, yPlane: 110, xParallax: 180, yParallax: 110, rotDeg: 0, heightMm: 5.8, score: 0.94 },
      ],
      true,
    );

    const nodeOf = (id) => layer.nodeOf(id);
    const primaryMat = (id, role) => {
      let found = null;
      nodeOf(id).traverse((o) => {
        if (!found && o.isMesh && o.material?.userData?.role === role) found = o.material;
      });
      return found;
    };
    const ringOf = (id) => nodeOf(id).children.find((c) => c.isMesh && c.userData.deco);
    const labelOf = (id) => nodeOf(id).children.find((c) => c.isCSS2DObject);

    // 默认不显示悬浮标签小框与常驻圆环
    for (const id of [1, 2, 3]) {
      expect(labelOf(id).visible).toBe(false);
      expect(labelOf(id).element.hidden).toBe(true);
      expect(ringOf(id).visible).toBe(false);
    }

    // 仅选中 2 号红色 LED，1 号电阻与 3 号透明 LED 变暗，2 号保持明亮
    layer.setSelectedIds([2], { custom: true });
    const hsl = { h: 0, s: 0, l: 0 };
    const redMat = primaryMat(2, 'ledBody');
    const resMat = primaryMat(1, 'body');
    const clearMat = primaryMat(3, 'clearBody');

    redMat.color.getHSL(hsl);
    const redSelectedL = hsl.l;
    const redSelectedEmissive = redMat.emissiveIntensity;
    resMat.color.getHSL(hsl);
    const resUnselectedL = hsl.l;
    clearMat.color.getHSL(hsl);
    const clearUnselectedL = hsl.l;

    // 反转选中：1 号电阻和 3 号透明 LED 变亮，2 号红色 LED 变暗
    layer.setSelectedIds([1, 3], { custom: true });
    redMat.color.getHSL(hsl);
    expect(redSelectedL).toBeGreaterThan(hsl.l + 0.15);
    expect(redSelectedEmissive).toBeGreaterThan(redMat.emissiveIntensity);

    resMat.color.getHSL(hsl);
    expect(hsl.l).toBeGreaterThan(resUnselectedL + 0.15);
    expect(resMat.emissiveIntensity).toBeGreaterThan(0.1);

    clearMat.color.getHSL(hsl);
    expect(hsl.l).toBeGreaterThan(clearUnselectedL + 0.3);
    expect(clearMat.emissiveIntensity).toBeGreaterThan(0.2);

    // 悬停时才显示轻柔瞄准环
    layer.setHighlighted(2);
    expect(ringOf(2).visible).toBe(true);
    expect(ringOf(1).visible).toBe(false);
    layer.setHighlighted(null);
    expect(ringOf(2).visible).toBe(false);
  });
});
