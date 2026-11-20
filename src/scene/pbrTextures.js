// 程序化 PBR 微表面贴图库（反照率 / 凹凸 / 粗糙度 + 接触阴影贴图）。
// 真实工业与实验室物体表面绝不是数学上完全平滑的镜面或单色块：
// - 阳极氧化铝 / 喷涂钢架有细腻喷砂微颗粒（sandblast）
// - 拉丝不锈钢 / 铝型材有定向拉丝纹理（brushed）
// - 示波器 / 稳压电源 / 急停盒 / 注塑料盒有模具晒纹（stipple）
// - 防静电台垫有细微磨砂压纹（pebble）
// - 实木复合桌面有指接木纹与导管凹凸（wood）
// - 物体落地处有一层柔和的接触环境光遮蔽阴影（contactShadow）
// 所有贴图均按需生成并缓存复用；在 Node 单元测试环境（无 document）下安全返回 null。
import * as THREE from 'three';

const cache = new Map();

function cached(key, factory) {
  if (typeof document === 'undefined') return null;
  if (!cache.has(key)) cache.set(key, factory());
  return cache.get(key);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext?.('2d');
  return ctx ? { c, ctx } : null;
}

function rng(seed0) {
  let s = seed0 >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function tileTex(canvas, { srgb = false, repeatX = 1, repeatY = 1, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 喷砂阳极氧化铝 / 粉末喷涂金属微颗粒（bump + roughness）
 * 让铝件、机械臂深色金属、控制器外壳在受光时呈现细腻微闪而不是假塑料反光
 */
export function getSandblastMaps(repeatX = 4, repeatY = 4) {
  const base = cached('sandblast', () => {
    const size = 256;
    const b = makeCanvas(size, size);
    const r = makeCanvas(size, size);
    if (!b || !r) return null;
    const rand = rng(104729);
    const bImg = b.ctx.createImageData(size, size);
    const rImg = r.ctx.createImageData(size, size);
    // 生成两层频率混合的喷砂微粒（高频细沙 + 极淡低频色块起伏）
    const low = new Float32Array(16 * 16);
    for (let i = 0; i < low.length; i++) low[i] = (rand() - 0.5) * 18;
    for (let y = 0; y < size; y++) {
      const ly = Math.floor((y / size) * 16);
      for (let x = 0; x < size; x++) {
        const lx = Math.floor((x / size) * 16);
        const idx = (y * size + x) * 4;
        const fine = (rand() - 0.5) * 46;
        const v = Math.max(0, Math.min(255, 128 + fine + low[ly * 16 + lx]));
        bImg.data[idx] = bImg.data[idx + 1] = bImg.data[idx + 2] = v;
        bImg.data[idx + 3] = 255;
        // 粗糙度贴图在 0.72–1.0 范围微调（与材质 scalar roughness 相乘）
        const rv = Math.max(175, Math.min(255, 224 + (rand() - 0.5) * 44));
        rImg.data[idx] = rImg.data[idx + 1] = rImg.data[idx + 2] = rv;
        rImg.data[idx + 3] = 255;
      }
    }
    b.ctx.putImageData(bImg, 0, 0);
    r.ctx.putImageData(rImg, 0, 0);
    return { bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
    roughnessMap: tileTex(base.roughCanvas, { repeatX, repeatY }),
  };
}

/**
 * 定向拉丝不锈钢 / 拉丝铝纹理（map + bump + roughness）
 * 用于 4040 铝型材、游标卡尺尺身、铝合金托盘、机械臂钢件、面板装饰条
 */
export function getBrushedMetalMaps(repeatX = 2, repeatY = 2) {
  const base = cached('brushed', () => {
    const size = 256;
    const m = makeCanvas(size, size);
    const b = makeCanvas(size, size);
    const r = makeCanvas(size, size);
    if (!m || !b || !r) return null;
    const rand = rng(339217);

    m.ctx.fillStyle = '#e5e8ec';
    m.ctx.fillRect(0, 0, size, size);
    b.ctx.fillStyle = '#808080';
    b.ctx.fillRect(0, 0, size, size);
    r.ctx.fillStyle = '#c8c8c8';
    r.ctx.fillRect(0, 0, size, size);

    // 水平拉丝划痕（无缝循环绘制）
    for (let i = 0; i < 650; i++) {
      const y = rand() * size;
      const x = rand() * size;
      const len = 30 + rand() * 140;
      const bright = rand() > 0.48;
      const a = 0.04 + rand() * 0.1;
      const lw = 0.6 + rand() * 1.1;

      const drawStreak = (ctx, col) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y);
        if (x + len > size) {
          ctx.moveTo(0, y);
          ctx.lineTo(x + len - size, y);
        }
        ctx.stroke();
      };
      drawStreak(m.ctx, bright ? `rgba(255,255,255,${a})` : `rgba(110,118,128,${a})`);
      drawStreak(b.ctx, bright ? `rgba(210,210,210,${a * 1.8})` : `rgba(55,55,55,${a * 1.8})`);
      drawStreak(r.ctx, bright ? `rgba(170,170,170,${a * 1.5})` : `rgba(245,245,245,${a * 1.5})`);
    }
    return { mapCanvas: m.c, bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    map: tileTex(base.mapCanvas, { srgb: true, repeatX, repeatY }),
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
    roughnessMap: tileTex(base.roughCanvas, { repeatX, repeatY }),
  };
}

/**
 * 工程塑料 / 仪器外壳模具晒纹（VDI 27 细腻磨砂质感）
 * 用于示波器、稳压电源外壳、急停盒、注塑分拣料盒、机械臂烤漆/塑料壳
 */
export function getMoldStippleMaps(repeatX = 4, repeatY = 4) {
  const base = cached('stipple', () => {
    const size = 256;
    const b = makeCanvas(size, size);
    const r = makeCanvas(size, size);
    if (!b || !r) return null;
    const rand = rng(774103);

    b.ctx.fillStyle = '#808080';
    b.ctx.fillRect(0, 0, size, size);
    r.ctx.fillStyle = '#d8d8d8';
    r.ctx.fillRect(0, 0, size, size);

    // 细腻圆点微凸（模拟注塑模具蚀刻晒纹）
    for (let i = 0; i < 4200; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rad = 0.7 + rand() * 1.3;
      const up = rand() > 0.45;
      b.ctx.fillStyle = up ? 'rgba(182,182,182,0.38)' : 'rgba(78,78,78,0.38)';
      b.ctx.beginPath();
      b.ctx.arc(x, y, rad, 0, Math.PI * 2);
      b.ctx.fill();

      r.ctx.fillStyle = up ? 'rgba(200,200,200,0.3)' : 'rgba(248,248,248,0.3)';
      r.ctx.beginPath();
      r.ctx.arc(x, y, rad * 1.1, 0, Math.PI * 2);
      r.ctx.fill();
    }
    return { bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
    roughnessMap: tileTex(base.roughCanvas, { repeatX, repeatY }),
  };
}

/**
 * 防静电橡胶垫微压纹（pebbled ESD vinyl texture）
 */
export function getRubberPebbleMaps(repeatX = 12, repeatY = 8) {
  const base = cached('esd-pebble', () => {
    const size = 256;
    const b = makeCanvas(size, size);
    const r = makeCanvas(size, size);
    if (!b || !r) return null;
    const rand = rng(551923);

    b.ctx.fillStyle = '#7e7e7e';
    b.ctx.fillRect(0, 0, size, size);
    r.ctx.fillStyle = '#dcdcdc';
    r.ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 3600; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rad = 0.9 + rand() * 1.8;
      const v = Math.floor(96 + rand() * 64);
      b.ctx.fillStyle = `rgba(${v},${v},${v},0.42)`;
      b.ctx.beginPath();
      b.ctx.arc(x, y, rad, 0, Math.PI * 2);
      b.ctx.fill();

      const rv = Math.floor(195 + rand() * 55);
      r.ctx.fillStyle = `rgba(${rv},${rv},${rv},0.35)`;
      r.ctx.beginPath();
      r.ctx.arc(x, y, rad, 0, Math.PI * 2);
      r.ctx.fill();
    }
    return { bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
    roughnessMap: tileTex(base.roughCanvas, { repeatX, repeatY }),
  };
}

/**
 * 尼龙编织线束纹理（用于机械臂主线缆）
 */
export function getBraidedCableMaps(repeatX = 18, repeatY = 3) {
  const base = cached('braided', () => {
    const size = 128;
    const m = makeCanvas(size, size);
    const b = makeCanvas(size, size);
    if (!m || !b) return null;
    m.ctx.fillStyle = '#1b1d20';
    m.ctx.fillRect(0, 0, size, size);
    b.ctx.fillStyle = '#555555';
    b.ctx.fillRect(0, 0, size, size);

    // 双向斜纹编织网格
    for (let step = -size; step < size * 2; step += 10) {
      m.ctx.strokeStyle = 'rgba(56, 60, 68, 0.72)';
      m.ctx.lineWidth = 4;
      m.ctx.beginPath();
      m.ctx.moveTo(step, 0);
      m.ctx.lineTo(step + size, size);
      m.ctx.stroke();

      m.ctx.strokeStyle = 'rgba(42, 46, 52, 0.65)';
      m.ctx.beginPath();
      m.ctx.moveTo(step + size, 0);
      m.ctx.lineTo(step, size);
      m.ctx.stroke();

      b.ctx.strokeStyle = 'rgba(220, 220, 220, 0.65)';
      b.ctx.lineWidth = 3.5;
      b.ctx.beginPath();
      b.ctx.moveTo(step, 0);
      b.ctx.lineTo(step + size, size);
      b.ctx.moveTo(step + size, 0);
      b.ctx.lineTo(step, size);
      b.ctx.stroke();
    }
    return { mapCanvas: m.c, bumpCanvas: b.c };
  });
  if (!base) return null;
  return {
    map: tileTex(base.mapCanvas, { srgb: true, repeatX, repeatY }),
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
  };
}

/**
 * 实验室实木复合指接桌面（榉木/橡木）：反照率 + 凹凸木纹导管 + 空间粗糙度贴图
 */
export function getWoodBenchMaps() {
  const base = cached('wood-bench-pbr', () => {
    const W = 1024;
    const H = 512;
    const m = makeCanvas(W, H);
    const b = makeCanvas(W, H);
    const r = makeCanvas(W, H);
    if (!m || !b || !r) return null;
    const rand = rng(9876543);

    m.ctx.fillStyle = '#ba9266';
    m.ctx.fillRect(0, 0, W, H);
    b.ctx.fillStyle = '#868686';
    b.ctx.fillRect(0, 0, W, H);
    r.ctx.fillStyle = '#a8a8a8';
    r.ctx.fillRect(0, 0, W, H);

    const rows = 14;
    const rowH = H / rows;
    for (let row = 0; row < rows; row++) {
      let x = 0;
      const y0 = row * rowH;
      while (x < W) {
        const segW = 210 + rand() * 290;
        const hue = 29 + (rand() - 0.5) * 6;
        const sat = 36 + (rand() - 0.5) * 10;
        const lit = 54 + (rand() - 0.5) * 9;
        m.ctx.fillStyle = `hsl(${hue}, ${sat}%, ${lit}%)`;
        m.ctx.fillRect(x, y0, segW + 1, rowH + 0.6);

        // 每块木条的基础光泽略有不同（天然实木拼板特征）
        const rBase = Math.floor(148 + (rand() - 0.5) * 32);
        r.ctx.fillStyle = `rgb(${rBase},${rBase},${rBase})`;
        r.ctx.fillRect(x, y0, segW + 1, rowH + 0.6);

        // 顺纹木纤维与细腻木导管（同时写入反照率、凹凸、粗糙度）
        for (let g = 0; g < 26; g++) {
          const gy = y0 + rand() * rowH;
          const dark = rand() > 0.35;
          const a = 0.045 + rand() * 0.085;
          const lw = 0.5 + rand() * 1.5;
          const wave = (rand() - 0.5) * 5.5;
          const x1 = Math.min(W, x + segW);

          const drawFiber = (ctx, col, w = lw) => {
            ctx.strokeStyle = col;
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.moveTo(x, gy);
            ctx.bezierCurveTo(x + (x1 - x) * 0.33, gy + wave, x + (x1 - x) * 0.67, gy - wave, x1, gy);
            ctx.stroke();
          };
          drawFiber(m.ctx, dark ? `rgba(74, 46, 20, ${a})` : `rgba(240, 215, 182, ${a * 0.65})`);
          drawFiber(b.ctx, dark ? `rgba(48, 48, 48, ${a * 2.2})` : `rgba(195, 195, 195, ${a * 1.5})`);
          drawFiber(r.ctx, dark ? `rgba(232, 232, 232, ${a * 2.4})` : `rgba(115, 115, 115, ${a * 1.5})`);
        }

        // 木块端头指接齿缝
        m.ctx.strokeStyle = 'rgba(65, 40, 18, 0.24)';
        m.ctx.lineWidth = 1.2;
        m.ctx.beginPath();
        m.ctx.moveTo(x, y0);
        m.ctx.lineTo(x, y0 + rowH);
        m.ctx.stroke();

        b.ctx.strokeStyle = 'rgba(30, 30, 30, 0.55)';
        b.ctx.lineWidth = 1.4;
        b.ctx.beginPath();
        b.ctx.moveTo(x, y0);
        b.ctx.lineTo(x, y0 + rowH);
        b.ctx.stroke();

        x += segW;
      }
      // 长边拼缝
      m.ctx.strokeStyle = 'rgba(62, 38, 16, 0.19)';
      m.ctx.lineWidth = 1;
      m.ctx.beginPath();
      m.ctx.moveTo(0, y0);
      m.ctx.lineTo(W, y0);
      m.ctx.stroke();

      b.ctx.strokeStyle = 'rgba(38, 38, 38, 0.45)';
      b.ctx.lineWidth = 1.2;
      b.ctx.beginPath();
      b.ctx.moveTo(0, y0);
      b.ctx.lineTo(W, y0);
      b.ctx.stroke();
    }
    return { mapCanvas: m.c, bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    map: tileTex(base.mapCanvas, { srgb: true }),
    bumpMap: tileTex(base.bumpCanvas),
    roughnessMap: tileTex(base.roughCanvas),
  };
}

/**
 * 实验室冲孔洞洞板贴图（深灰喷涂钢板 + 阵列圆孔与凹凸凹陷）
 */
export function getPegboardMaps(repeatX = 6, repeatY = 2) {
  const base = cached('pegboard', () => {
    const size = 256;
    const m = makeCanvas(size, size);
    const b = makeCanvas(size, size);
    const r = makeCanvas(size, size);
    if (!m || !b || !r) return null;
    const rand = rng(66109);

    m.ctx.fillStyle = '#30343b';
    m.ctx.fillRect(0, 0, size, size);
    b.ctx.fillStyle = '#a0a0a0';
    b.ctx.fillRect(0, 0, size, size);
    r.ctx.fillStyle = '#c4c4c4';
    r.ctx.fillRect(0, 0, size, size);

    // 喷粉细微颗粒
    for (let i = 0; i < 1600; i++) {
      const x = rand() * size;
      const y = rand() * size;
      m.ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.03)';
      m.ctx.fillRect(x, y, 2, 2);
    }

    // 规则排列的冲孔圆孔阵列（孔内深黑 + 下缘微弱亮倒角）
    const step = 32;
    for (let y = step / 2; y < size; y += step) {
      for (let x = step / 2; x < size; x += step) {
        // 冲孔下沿微高光
        m.ctx.fillStyle = 'rgba(130, 138, 150, 0.25)';
        m.ctx.beginPath();
        m.ctx.arc(x, y + 1.2, 5.4, 0, Math.PI * 2);
        m.ctx.fill();
        // 孔洞本体
        m.ctx.fillStyle = '#111316';
        m.ctx.beginPath();
        m.ctx.arc(x, y, 5.0, 0, Math.PI * 2);
        m.ctx.fill();

        b.ctx.fillStyle = '#181818';
        b.ctx.beginPath();
        b.ctx.arc(x, y, 5.2, 0, Math.PI * 2);
        b.ctx.fill();

        r.ctx.fillStyle = '#ffffff';
        r.ctx.beginPath();
        r.ctx.arc(x, y, 5.2, 0, Math.PI * 2);
        r.ctx.fill();
      }
    }
    return { mapCanvas: m.c, bumpCanvas: b.c, roughCanvas: r.c };
  });
  if (!base) return null;
  return {
    map: tileTex(base.mapCanvas, { srgb: true, repeatX, repeatY }),
    bumpMap: tileTex(base.bumpCanvas, { repeatX, repeatY }),
    roughnessMap: tileTex(base.roughCanvas, { repeatX, repeatY }),
  };
}

/**
 * 实验室墙面哑光涂装质感（细微乳胶漆肌理 + 建筑板块接缝 + 下部渐变环境遮蔽）
 */
export function getLabWallMaps() {
  const base = cached('lab-wall', () => {
    const W = 512;
    const H = 512;
    const m = makeCanvas(W, H);
    const b = makeCanvas(W, H);
    if (!m || !b) return null;
    const rand = rng(44197);

    // 自上而下柔和墙面明暗过渡（靠近桌面的下部自然偏暗，模拟真实室内漫反射衰减）
    const grad = m.ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#ddd8ce');
    grad.addColorStop(0.55, '#d4cfc5');
    grad.addColorStop(1, '#bbb5aa');
    m.ctx.fillStyle = grad;
    m.ctx.fillRect(0, 0, W, H);

    b.ctx.fillStyle = '#808080';
    b.ctx.fillRect(0, 0, W, H);

    // 墙面细微乳胶漆肌理
    for (let i = 0; i < 6000; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const rad = 0.8 + rand() * 2.2;
      const up = rand() > 0.5;
      m.ctx.fillStyle = up ? 'rgba(255,252,245,0.035)' : 'rgba(60,55,48,0.035)';
      m.ctx.fillRect(x, y, rad, rad);
      b.ctx.fillStyle = up ? 'rgba(165,165,165,0.28)' : 'rgba(95,95,95,0.28)';
      b.ctx.fillRect(x, y, rad, rad);
    }

    // 建筑隔音墙板极淡竖向接缝
    m.ctx.strokeStyle = 'rgba(70, 65, 58, 0.08)';
    m.ctx.lineWidth = 1.5;
    for (const sx of [128, 256, 384]) {
      m.ctx.beginPath();
      m.ctx.moveTo(sx, 0);
      m.ctx.lineTo(sx, H);
      m.ctx.stroke();
    }

    return { mapCanvas: m.c, bumpCanvas: b.c };
  });
  if (!base) return null;
  const map = new THREE.CanvasTexture(base.mapCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bumpMap = new THREE.CanvasTexture(base.bumpCanvas);
  return { map, bumpMap };
}

/**
 * 柔和的接触环境光遮蔽阴影贴图（圆角矩形或圆形）
 * 贴在重物与桌面/台垫交界处，提供真实物理“落地感”与缝隙暗影
 */
export function getContactShadowTexture(kind = 'rect') {
  return cached(`contact-shadow-${kind}`, () => {
    const size = 256;
    const g = makeCanvas(size, size);
    if (!g) return null;
    const { ctx } = g;
    ctx.clearRect(0, 0, size, size);

    if (kind === 'circle') {
      const grad = ctx.createRadialGradient(128, 128, 52, 128, 128, 124);
      grad.addColorStop(0, 'rgba(8, 10, 12, 0.72)');
      grad.addColorStop(0.55, 'rgba(8, 10, 12, 0.42)');
      grad.addColorStop(0.82, 'rgba(8, 10, 12, 0.14)');
      grad.addColorStop(1, 'rgba(8, 10, 12, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
    } else {
      // 多层向外扩散衰减的圆角矩形柔影（比 canvas shadowBlur 跨平台更稳定且边缘自然）
      for (let i = 16; i >= 1; i--) {
        const pad = 6 + (16 - i) * 3.1;
        const alpha = (0.048 * (17 - i)) / 16;
        ctx.fillStyle = `rgba(8, 10, 12, ${alpha})`;
        ctx.beginPath();
        ctx.roundRect(pad, pad, size - pad * 2, size - pad * 2, 14 + i * 1.4);
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(g.c);
    tex.anisotropy = 4;
    return tex;
  });
}

/**
 * 创建一个紧贴水平面 Z = z 的柔和接触阴影平面（depthWrite = false，不影响拾取与渲染顺序）
 * @param {number} width 底板 X 方向宽（已含阴影外扩余量）
 * @param {number} depth 底板 Y 方向深（已含阴影外扩余量）
 * @param {{ kind?: 'rect'|'circle', opacity?: number }} [opts]
 */
export function createContactShadow(width, depth, { kind = 'rect', opacity = 0.62 } = {}) {
  const tex = getContactShadowTexture(kind);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: '#000000',
    transparent: true,
    opacity: tex ? opacity : 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}
