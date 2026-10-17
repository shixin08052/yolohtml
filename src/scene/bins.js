// 料盒：开口盒子（底 + 四壁），两侧（朝 ±X 的壁）贴名称。按需生成：setBins 传入 robot/bins.js 的 binsFor 结果，
// 有几种零件（LED 按颜色）就有几个盒子。
import * as THREE from 'three';
import { BIN_WALL } from '../config.js';
import { toThree } from '../math/coords.js';

/** 类别名贴图：类别颜色底、白字 */
function labelTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  // 字号按文字长度缩小，"透明 LED"这类长名字也放得下
  let size = 52;
  const font = (n) => `600 ${n}px "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  ctx.font = font(size);
  while (size > 24 && ctx.measureText(text).width > c.width - 24) ctx.font = font((size -= 2));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * @returns {{ group: THREE.Group, setBins: (list: { id: number, key: string, label: string, hex: string, center: number[], size: number[] }[]) => void, readonly bins: object[] }}
 */
export function createBins() {
  const group = new THREE.Group();
  group.name = 'bins';
  const wallMat = new THREE.MeshStandardMaterial({ color: '#e9e4da', roughness: 0.75 });
  let current = [];
  let sig = '';

  const build = (bin) => {
    const [sx, sy, h] = bin.size;
    const g = new THREE.Group();
    g.name = `bin-${bin.id}`;
    g.position.copy(toThree(bin.center[0], bin.center[1], 0));
    const rim = new THREE.MeshStandardMaterial({ color: bin.hex, roughness: 0.6 });
    const add = (w, hh, d, x, y, z, mat = wallMat) => {
      // w 沿底板 X，d 沿底板 Y，hh 为高度；(x, y, z) 为底板坐标下相对盒中心的位置
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
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
    add(sx - 2 * t, h, t, 0, -(sy - t) / 2, h / 2); // −Y 壁
    add(sx - 2 * t, h, t, 0, (sy - t) / 2, h / 2); // +Y 壁
    // 盒口一圈类别色的边
    add(sx, 2, t, 0, -(sy - t) / 2, h + 1, rim);
    add(sx, 2, t, 0, (sy - t) / 2, h + 1, rim);
    add(t, 2, sy - 2 * t, -(sx - t) / 2, 0, h + 1, rim);
    add(t, 2, sy - 2 * t, (sx - t) / 2, 0, h + 1, rim);
    // 两侧壁外面贴类别名
    const tex = labelTexture(bin.label, bin.hex);
    const labelMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(sy * 0.78, h * 0.5), labelMat);
      p.position.copy(toThree(side * (sx / 2 + 0.2), 0, h * 0.5));
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
