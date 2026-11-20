// 料盒：开口盒子（底 + 四壁），两侧（朝 ±X 的壁）贴名称。按需生成：setBins 传入 robot/bins.js 的 binsFor 结果，
// 有几种零件（LED 按颜色）就有几个盒子。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BIN_WALL } from '../config.js';
import { toThree } from '../math/coords.js';
import { getMoldStippleMaps, getRubberPebbleMaps, createContactShadow } from './pbrTextures.js';

/** 类别名贴图：类别颜色底的圆角标签（四角透明）、白字 */
function labelTexture(text, color) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;
  ctx.scale(2, 2); // 下面按 256 × 128 的坐标画，贴图清晰一倍
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(2, 2, 252, 124, 22);
  ctx.fill();
  // 标签内框细白线，更有工业铭牌质感
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(7, 7, 242, 114, 17);
  ctx.stroke();
  // 标签上半部分一层很淡的高光，像贴纸的覆膜
  const sheen = ctx.createLinearGradient(0, 0, 0, 128);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
  sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.fillStyle = '#fff';
  // 字号按文字长度缩小，"透明 LED"这类长名字也放得下
  let size = 50;
  const font = (n) => `600 ${n}px "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  ctx.font = font(size);
  while (size > 24 && ctx.measureText(text).width > 256 - 42) ctx.font = font((size -= 2));
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
  // 注塑工业零件盒：细腻晒纹工程塑料 + 盒底防静电微压纹缓冲垫
  const stipple = getMoldStippleMaps(3, 3);
  const pebble = getRubberPebbleMaps(2, 2);
  const wallMat = new THREE.MeshPhysicalMaterial({
    color: '#e8e3d8',
    roughness: 0.56,
    metalness: 0.02,
    bumpMap: stipple?.bumpMap ?? null,
    bumpScale: 0.2,
    roughnessMap: stipple?.roughnessMap ?? null,
    clearcoat: 0.16,
    clearcoatRoughness: 0.45,
  });
  const linerMat = new THREE.MeshStandardMaterial({
    color: '#222526',
    roughness: 0.9,
    metalness: 0,
    bumpMap: pebble?.bumpMap ?? null,
    bumpScale: 0.2,
  });
  let current = [];
  let sig = '';

  const build = (bin) => {
    const [sx, sy, h] = bin.size;
    const g = new THREE.Group();
    g.name = `bin-${bin.id}`;
    g.position.copy(toThree(bin.center[0], bin.center[1], 0));
    const ao = createContactShadow(sx + 14, sy + 14, { opacity: 0.58 });
    ao.position.copy(toThree(0, 0, -0.02));
    ao.userData.sharedMap = true;
    g.add(ao);
    const rim = new THREE.MeshPhysicalMaterial({
      color: bin.hex,
      roughness: 0.46,
      bumpMap: stipple?.bumpMap ?? null,
      bumpScale: 0.14,
      clearcoat: 0.3,
      clearcoatRoughness: 0.34,
    });
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
    // 盒内底部防静电缓冲软垫（平面贴在盒底上表面 Z = t + 0.04 处，避免与底板圆角盒发生深度冲突，零件落入后对比鲜明）
    const liner = new THREE.Mesh(new THREE.PlaneGeometry(sx - 2 * t - 0.8, sy - 2 * t - 0.8), linerMat);
    liner.rotation.x = -Math.PI / 2;
    liner.position.copy(toThree(0, 0, t + 0.04));
    liner.receiveShadow = true;
    g.add(liner);
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
    // 四个竖棱外面各一条加强筋 + 底部一圈堆叠裙边（工业注塑零件盒特征）
    for (const [ix, iy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add(3.2, h - 2, 3.2, ix * (sx / 2 - 1.2), iy * (sy / 2 - 1.2), (h - 2) / 2, wallMat, 1.4);
    add(sx + 1.2, 2.2, sy + 1.2, 0, 0, 1.1, wallMat, 0.8);
    // 两侧壁（朝 ±X）与前壁（朝 −Y 操作者方向）均贴上类别铭牌，正面默认视角下也能一眼看清各料盒名称
    const tex = labelTexture(bin.label, bin.hex);
    const labelMat = new THREE.MeshStandardMaterial({
      color: tex ? '#ffffff' : bin.hex,
      map: tex,
      roughness: 0.45,
      transparent: true,
      alphaTest: 0.5,
    });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(sy * 0.74, sy * 0.37), labelMat);
      p.position.copy(toThree(side * (sx / 2 + 0.25), 0, h * 0.52));
      p.rotation.y = side * (Math.PI / 2); // 平面法线朝 ±X
      g.add(p);
    }
    // 前壁（朝 −Y，即 Three.js 的 +z）类别铭牌
    const frontLabel = new THREE.Mesh(new THREE.PlaneGeometry(sx * 0.72, sy * 0.35), labelMat);
    frontLabel.position.copy(toThree(0, -(sy / 2 + 0.28), h * 0.52));
    g.add(frontLabel);
    group.add(g);
    return { bin, group: g };
  };

  /** 释放一个盒子的几何体、材质（共用的墙面/贴图不释放） */
  const dispose = (g) =>
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material !== wallMat && o.material !== linerMat) {
        if (!o.userData.sharedMap) o.material.map?.dispose();
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
