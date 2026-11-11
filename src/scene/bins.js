// 料盒：开口盒子（底 + 四壁），两侧（朝 ±X 的壁）贴名称。按需生成：setBins 传入 robot/bins.js 的 binsFor 结果，
// 有几种零件（LED 按颜色）就有几个盒子。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BIN_WALL } from '../config.js';
import { toThree } from '../math/coords.js';

/** 类别名贴图：类别颜色底的圆角标签（四角透明）、白字 */
function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.scale(2, 2); // 下面按 256 × 128 的坐标画，贴图清晰一倍
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(2, 2, 252, 124, 22);
  ctx.fill();
  // 标签上半部分一层很淡的高光，像贴纸的覆膜
  const sheen = ctx.createLinearGradient(0, 0, 0, 128);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.fillStyle = '#fff';
  // 字号按文字长度缩小，"透明 LED"这类长名字也放得下
  let size = 52;
  const font = (n) => `600 ${n}px "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  ctx.font = font(size);
  while (size > 24 && ctx.measureText(text).width > 256 - 36) ctx.font = font((size -= 2));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * @returns {{ group: THREE.Group, setBins: (list: { id: number, key: string, label: string, hex: string, center: number[], size: number[] }[]) => void, readonly bins: object[] }}
 */
export function createBins() {
  const group = new THREE.Group();
  group.name = 'bins';
  // 注塑的料盒：略带光泽的塑料
  const wallMat = new THREE.MeshPhysicalMaterial({ color: '#ebe6dc', roughness: 0.55, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.4 });
  let current = [];
  let sig = '';

  const build = (bin) => {
    const [sx, sy, h] = bin.size;
    const g = new THREE.Group();
    g.name = `bin-${bin.id}`;
    g.position.copy(toThree(bin.center[0], bin.center[1], 0));
    const rim = new THREE.MeshPhysicalMaterial({ color: bin.hex, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 });
    const add = (w, hh, d, x, y, z, mat = wallMat, r = 0.9) => {
      // w 沿底板 X，d 沿底板 Y，hh 为高度；(x, y, z) 为底板坐标下相对盒中心的位置；棱边倒圆角 r
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, hh, d, 3, Math.min(r, w / 2, hh / 2, d / 2) * 0.98), mat);
      m.position.copy(toThree(x, y, z));
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    const t = BIN_WALL;
    add(sx, t, sy, 0, 0, t / 2); // 底
    add(t, h, sy, -(sx - t) / 2, 0, h / 2); // −X 壁
    add(t, h, sy, (sx - t) / 2, 0, h / 2); // +X 壁
    add(sx - 2 * t + 1, h, t, 0, -(sy - t) / 2, h / 2); // −Y 壁（两头各伸进侧壁 0.5，圆角处不漏缝）
    add(sx - 2 * t + 1, h, t, 0, (sy - t) / 2, h / 2); // +Y 壁
    // 盒口一圈类别色的卷边：比壁厚宽一点，向外翻出 1 mm
    const lip = t + 1.6;
    const out = 0.8;
    add(sx + 2 * out, 2.4, lip, 0, -(sy - t) / 2 - out / 2, h + 0.9, rim, 1.1);
    add(sx + 2 * out, 2.4, lip, 0, (sy - t) / 2 + out / 2, h + 0.9, rim, 1.1);
    add(lip, 2.4, sy - 2 * t + 1, -(sx - t) / 2 - out / 2, 0, h + 0.9, rim, 1.1);
    add(lip, 2.4, sy - 2 * t + 1, (sx - t) / 2 + out / 2, 0, h + 0.9, rim, 1.1);
    // 四个竖棱外面各一条加强筋（注塑盒常见），顺便盖住两面壁的接缝
    for (const [ix, iy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add(3.2, h - 2, 3.2, ix * (sx / 2 - 1.2), iy * (sy / 2 - 1.2), (h - 2) / 2, wallMat, 1.4);
    // 两侧壁外面贴类别名（标签四角是透明的）
    const tex = labelTexture(bin.label, bin.hex);
    const labelMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, transparent: true, alphaTest: 0.5 });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(sy * 0.74, sy * 0.37), labelMat);
      p.position.copy(toThree(side * (sx / 2 + 0.25), 0, h * 0.5));
      p.rotation.y = side * (Math.PI / 2); // 平面法线朝 ±X
      g.add(p);
    }
    group.add(g);
    return { bin, group: g };
  };

  /** 释放一个盒子的几何体、材质（共用的墙面材质不释放） */
  const dispose = (g) =>
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material !== wallMat) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });

  return {
    group,
    /** 换一组料盒（内容相同时不重建） */
    setBins(list) {
      const s = JSON.stringify(list.map((b) => [b.key, b.label, b.hex, b.center, b.size]));
      if (s === sig) return;
      sig = s;
      for (const b of current) dispose(b.group);
      group.clear();
      current = list.map(build);
    },
    get bins() {
      return current;
    },
  };
}
