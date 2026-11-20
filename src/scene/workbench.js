// 高精细度实验室工作台 3D 场景：
// 实木指接复合实验桌面（带木纹凹凸/粗糙度贴图）、重型钢架、防静电台垫（微压纹 + 精准刻度与分区丝印）、
// 工业 4040 真实截面 T 型槽铝型材龙门架、冲孔洞洞板（带挂钩工具）、纤薄 PDU 排插与顶部悬臂 LED 工作灯、
// 机械臂光学安装底板、MC-500 运动视觉控制器（带尼龙编织主线缆）、工业急停按钮盒、双路数控直流稳压电源、
// 后置数字存储示波器与 12 格元件抽屉柜、高精度数显游标卡尺、CNC 铝合金零件托盘、防静电精密镊子、电子斜口钳。
// 所有外围设备与走线均经过精确空间排布，互不穿模且完全位于机械臂与 7 个料盒工位之外。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ARM, BOARD, BIN_SLOTS, BIN_SIZE, LED_COLORS } from '../config.js';
import { toThree } from '../math/coords.js';
import {
  getSandblastMaps,
  getBrushedMetalMaps,
  getMoldStippleMaps,
  getRubberPebbleMaps,
  getBraidedCableMaps,
  getWoodBenchMaps,
  getPegboardMaps,
  getLabWallMaps,
  createContactShadow,
} from './pbrTextures.js';

/** 防静电台垫尺寸（mm）与中心（底板坐标） */
export const ESD_MAT = { width: 960, depth: 570, thick: 2.8, cx: 148.5, cy: 140 };

/** 实验室工作台桌面尺寸（mm）与中心（底板坐标） */
export const BENCH = { width: 2240, depth: 1020, thick: 38, cx: 148.5, cy: 190 };

/** 圆角矩形 Shape（中心在原点） */
function roundedRectShape(w, d, r) {
  const s = new THREE.Shape();
  const [hw, hd] = [w / 2, d / 2];
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.absarc(hw - r, -hd + r, r, -Math.PI / 2, 0);
  s.lineTo(hw, hd - r);
  s.absarc(hw - r, hd - r, r, 0, Math.PI / 2);
  s.lineTo(-hw + r, hd);
  s.absarc(-hw + r, hd - r, r, Math.PI / 2, Math.PI);
  s.lineTo(-hw, -hd + r);
  s.absarc(-hw + r, -hd + r, r, Math.PI, Math.PI * 1.5);
  return s;
}

/** 真实 40×40 工业 T 型槽铝型材截面挤出体（四面真实凹槽 + 倒角外棱，不是黑方块贴片） */
function create4040ProfileGeometry(length) {
  const s = new THREE.Shape();
  const h = 20;
  const c = 2.2;
  const slotOpen = 4.2;
  const slotIn = 7.6;
  const lip = 3.2;
  const depth = 9.5;

  s.moveTo(-h + c, -h);
  s.lineTo(-slotOpen, -h);
  s.lineTo(-slotOpen, -h + lip);
  s.lineTo(-slotIn, -h + lip);
  s.lineTo(-slotIn, -h + depth);
  s.lineTo(slotIn, -h + depth);
  s.lineTo(slotIn, -h + lip);
  s.lineTo(slotOpen, -h + lip);
  s.lineTo(slotOpen, -h);
  s.lineTo(h - c, -h);
  s.lineTo(h, -h + c);
  s.lineTo(h, -slotOpen);
  s.lineTo(h - lip, -slotOpen);
  s.lineTo(h - lip, -slotIn);
  s.lineTo(h - depth, -slotIn);
  s.lineTo(h - depth, slotIn);
  s.lineTo(h - lip, slotIn);
  s.lineTo(h - lip, slotOpen);
  s.lineTo(h, slotOpen);
  s.lineTo(h, h - c);
  s.lineTo(h - c, h);
  s.lineTo(slotOpen, h);
  s.lineTo(slotOpen, h - lip);
  s.lineTo(slotIn, h - lip);
  s.lineTo(slotIn, h - depth);
  s.lineTo(-slotIn, h - depth);
  s.lineTo(-slotIn, h - lip);
  s.lineTo(-slotOpen, h - lip);
  s.lineTo(-slotOpen, h);
  s.lineTo(-h + c, h);
  s.lineTo(-h, h - c);
  s.lineTo(-h, slotOpen);
  s.lineTo(-h + lip, slotOpen);
  s.lineTo(-h + lip, slotIn);
  s.lineTo(-h + depth, slotIn);
  s.lineTo(-h + depth, -slotIn);
  s.lineTo(-h + lip, -slotIn);
  s.lineTo(-h + lip, -slotOpen);
  s.lineTo(-h, -slotOpen);
  s.lineTo(-h, -h + c);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -length / 2);
  return geo;
}

/** 防静电台垫高精度丝印反照率贴图（搭配 getRubberPebbleMaps 的微压纹凹凸/粗糙度贴图） */
function createEsdMatTexture() {
  if (typeof document === 'undefined') return null;
  const scale = 2;
  const W = ESD_MAT.width;
  const D = ESD_MAT.depth;
  const c = document.createElement('canvas');
  c.width = W * scale;
  c.height = D * scale;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#272b2a';
  ctx.fillRect(0, 0, c.width, c.height);

  const noiseC = document.createElement('canvas');
  noiseC.width = 256;
  noiseC.height = 256;
  const nctx = noiseC.getContext?.('2d');
  if (nctx) {
    let seed = 20261120;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const img = nctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 39 + (rnd() - 0.5) * 16;
      img.data[i] = v - 1;
      img.data[i + 1] = v + 2;
      img.data[i + 2] = v + 1;
      img.data[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.62;
    const pat = ctx.createPattern(noiseC, 'repeat');
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.restore();
  }

  ctx.save();
  ctx.scale(scale, scale);

  const toU = (X) => X - ESD_MAT.cx + W / 2;
  const toV = (Y) => D / 2 - (Y - ESD_MAT.cy);

  ctx.strokeStyle = 'rgba(218, 228, 222, 0.16)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.roundRect(14, 14, W - 28, D - 28, 16);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(218, 228, 222, 0.07)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.roundRect(18, 18, W - 36, D - 36, 13);
  ctx.stroke();

  const cxU = toU(BOARD.width / 2);
  const cyV = toV(BOARD.height / 2);
  for (const [step, alpha, lw] of [[50, 0.04, 0.6], [100, 0.08, 0.85]]) {
    ctx.strokeStyle = `rgba(220, 232, 226, ${alpha})`;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let u = cxU % step; u < W - 22; u += step) {
      if (u < 22) continue;
      ctx.moveTo(u, 22);
      ctx.lineTo(u, D - 22);
    }
    for (let v = cyV % step; v < D - 22; v += step) {
      if (v < 22) continue;
      ctx.moveTo(22, v);
      ctx.lineTo(W - 22, v);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(225, 235, 230, 0.17)';
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (let u = cxU % 100; u < W - 28; u += 100) {
    if (u < 28) continue;
    for (let v = cyV % 100; v < D - 28; v += 100) {
      if (v < 28) continue;
      ctx.moveTo(u - 3.5, v);
      ctx.lineTo(u + 3.5, v);
      ctx.moveTo(u, v - 3.5);
      ctx.lineTo(u, v + 3.5);
    }
  }
  ctx.stroke();

  const font = (px, weight = 500) => `${weight} ${px}px "JetBrains Mono", Consolas, monospace`;
  ctx.fillStyle = 'rgba(215, 225, 220, 0.34)';
  ctx.strokeStyle = 'rgba(215, 225, 220, 0.26)';
  ctx.lineWidth = 0.7;
  ctx.font = font(7.5, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const rulerY = D - 15;
  ctx.beginPath();
  for (let mm = -280; mm <= 580; mm += 10) {
    const u = toU(mm);
    if (u < 35 || u > W - 35) continue;
    const major = mm % 50 === 0;
    ctx.moveTo(u, rulerY);
    ctx.lineTo(u, rulerY - (major ? 6.5 : 3.2));
    if (major) ctx.fillText(`${mm}`, u, rulerY - 7.5);
  }
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rulerX = 15;
  ctx.beginPath();
  for (let mm = -100; mm <= 380; mm += 10) {
    const v = toV(mm);
    if (v < 35 || v > D - 35) continue;
    const major = mm % 50 === 0;
    ctx.moveTo(rulerX, v);
    ctx.lineTo(rulerX + (major ? 6.5 : 3.2), v);
    if (major) ctx.fillText(`${mm}`, rulerX + 8.5, v);
  }
  ctx.stroke();

  const bL = toU(0);
  const bR = toU(BOARD.width);
  const bT = toV(BOARD.height);
  const bB = toV(0);
  ctx.strokeStyle = 'rgba(235, 240, 236, 0.32)';
  ctx.lineWidth = 1.4;
  const cornerLen = 16;
  const pad = 3;
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [
    [bL - pad, bT - pad, 1, 1],
    [bR + pad, bT - pad, -1, 1],
    [bR + pad, bB + pad, -1, -1],
    [bL - pad, bB + pad, 1, -1],
  ]) {
    ctx.moveTo(cx + dx * cornerLen, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * cornerLen);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(220, 230, 224, 0.34)';
  ctx.font = font(7.8, 600);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('VISION CALIBRATION ZONE · A4 (297 × 210 mm)', (bL + bR) / 2, bB + 6);

  const slotLabels = {
    leftFar: 'BIN L-3',
    leftMid: 'BIN L-2 (RES)',
    leftNear: 'BIN L-1',
    rightFar: 'BIN R-3',
    rightMid: 'BIN R-2 (LED)',
    rightNear: 'BIN R-1',
    front: 'BIN F-1',
  };
  const [bsx, bsy] = BIN_SIZE;
  for (const [key, [sx, sy]] of Object.entries(BIN_SLOTS)) {
    const u = toU(sx);
    const v = toV(sy);
    const hw = bsx / 2 + 4;
    const hd = bsy / 2 + 4;
    ctx.save();
    ctx.strokeStyle = 'rgba(215, 225, 220, 0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3.5]);
    ctx.beginPath();
    ctx.roundRect(u - hw, v - hd, hw * 2, hd * 2, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(215, 225, 220, 0.24)';
    ctx.font = font(7, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slotLabels[key] || key, u, v);
    ctx.restore();
  }

  const armU = toU(ARM.base[0]);
  const armV = toV(ARM.base[1]);
  ctx.strokeStyle = 'rgba(218, 128, 88, 0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(armU, armV, 68, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180;
    const r0 = deg % 45 === 0 ? 68 : 70;
    const r1 = deg % 45 === 0 ? 76 : 74;
    ctx.moveTo(armU + Math.cos(a) * r0, armV + Math.sin(a) * r0);
    ctx.lineTo(armU + Math.cos(a) * r1, armV + Math.sin(a) * r1);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(218, 128, 88, 0.36)';
  ctx.font = font(7.2, 600);
  ctx.textAlign = 'center';
  ctx.fillText('5-DOF MANIPULATOR BASE · R380 WORK ENVELOPE', armU, armV - 84);

  const badgeX = 34;
  const badgeY = D - 54;
  ctx.strokeStyle = 'rgba(230, 185, 75, 0.38)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, 152, 24, 4);
  ctx.stroke();
  ctx.fillStyle = 'rgba(230, 185, 75, 0.46)';
  ctx.font = font(7.5, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('▲ ESD SAFE WORKSTATION', badgeX + 8, badgeY + 8.5);
  ctx.fillStyle = 'rgba(215, 225, 220, 0.32)';
  ctx.font = font(6.4, 500);
  ctx.fillText('IEC 61340-5-1 · Rs 10⁶–10⁹ Ω · GROUNDED', badgeX + 8, badgeY + 17.5);

  const grad = ctx.createRadialGradient(W / 2, D / 2, D * 0.3, W / 2, D / 2, W * 0.65);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.015)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, D);

  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 机械臂控制器前面板 OLED 遥测屏贴图 */
function createControllerPanelTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#23262b';
  ctx.fillRect(0, 0, 512, 256);

  for (let y = 0; y < 256; y += 2) {
    ctx.fillStyle = y % 4 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.02)';
    ctx.fillRect(0, y, 512, 1);
  }

  ctx.strokeStyle = '#3c4149';
  ctx.lineWidth = 3;
  ctx.strokeRect(5, 5, 502, 246);

  ctx.fillStyle = '#c96442';
  ctx.fillRect(18, 16, 6, 22);
  ctx.fillStyle = '#e8e5de';
  ctx.font = '700 16px "JetBrains Mono", Consolas, sans-serif';
  ctx.fillText('MC-500 · 5-DOF MOTION & VISION CONTROLLER', 32, 33);

  ctx.fillStyle = '#081015';
  ctx.beginPath();
  ctx.roundRect(18, 50, 266, 182, 8);
  ctx.fill();
  ctx.strokeStyle = '#334854';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#4de698';
  ctx.font = '700 14px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('● IK SOLVER: ONLINE · 100Hz', 30, 74);
  ctx.fillStyle = '#85b3cb';
  ctx.font = '500 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('VISION SYNC: ARUCO-4×4 LOCKED', 30, 96);

  const joints = [
    ['J0 BASE', 0.54, '#4de698', '  0.0°'],
    ['J1 SHLD', 0.68, '#4de698', '+62.4°'],
    ['J2 ELBW', 0.74, '#5ec8f2', '-88.5°'],
    ['J3 WRST', 0.46, '#5ec8f2', '-63.9°'],
    ['J4 ROLL', 0.50, '#f09a5c', ' +0.0°'],
  ];
  joints.forEach(([label, val, col, deg], idx) => {
    const y = 122 + idx * 21;
    ctx.fillStyle = '#9bb0bd';
    ctx.font = '600 11px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(label, 30, y);
    ctx.fillStyle = '#15232d';
    ctx.fillRect(92, y - 9, 118, 10);
    ctx.fillStyle = col;
    ctx.fillRect(92, y - 9, 118 * val, 10);
    ctx.fillStyle = '#d2e4ee';
    ctx.fillText(deg, 218, y);
  });

  ctx.fillStyle = '#a3a9b2';
  ctx.font = '600 11px "JetBrains Mono", Consolas, sans-serif';
  ctx.fillText('PWR   IK   CAM   ERR', 302, 74);
  ctx.fillText('JOG / FEEDRATE', 368, 128);
  ctx.fillText('USB-C   LAN-1G', 308, 224);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 双路数控直流稳压电源前面板贴图 */
function createPowerSupplyPanelTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 384;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#202327';
  ctx.fillRect(0, 0, 512, 384);

  for (let y = 0; y < 384; y += 2) {
    ctx.fillStyle = y % 4 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.02)';
    ctx.fillRect(0, y, 512, 1);
  }

  ctx.fillStyle = '#c96442';
  ctx.fillRect(20, 18, 8, 22);
  ctx.fillStyle = '#eae7e0';
  ctx.font = '700 15px "JetBrains Mono", Consolas, sans-serif';
  ctx.fillText('DP-3205 · PROGRAMMABLE DUAL DC SUPPLY', 36, 35);

  ctx.fillStyle = '#070c10';
  ctx.beginPath();
  ctx.roundRect(20, 52, 472, 146, 8);
  ctx.fill();
  ctx.strokeStyle = '#38424c';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.strokeStyle = '#1b2830';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(256, 62);
  ctx.lineTo(256, 188);
  ctx.stroke();

  ctx.fillStyle = '#3ae683';
  ctx.font = '700 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('CH1 · LOGIC / MCU  [CV]', 34, 76);
  ctx.font = '700 40px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('05.00 V', 34, 124);
  ctx.font = '700 30px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = '#26bd68';
  ctx.fillText('0.142 A', 34, 166);
  ctx.font = '600 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('0.71 W · ON', 172, 166);

  ctx.fillStyle = '#f7a13e';
  ctx.font = '700 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('CH2 · SERVO BUS    [CV]', 274, 76);
  ctx.font = '700 40px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('24.00 V', 274, 124);
  ctx.font = '700 30px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = '#d98528';
  ctx.fillText('1.250 A', 274, 166);
  ctx.font = '600 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('30.0 W · ON', 410, 166);

  ctx.fillStyle = '#9ea4ac';
  ctx.font = '600 11px "JetBrains Mono", Consolas, sans-serif';
  ctx.fillText('CH1 V / I ADJ', 66, 222);
  ctx.fillText('CH2 V / I ADJ', 316, 222);
  ctx.fillText('+  CH1  −      GND      +  CH2  −', 64, 304);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 示波器波形与右侧软键菜单屏幕贴图 */
function createOscilloscopeScreenTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#060f15';
  ctx.fillRect(0, 0, 512, 320);

  ctx.fillStyle = '#11222e';
  ctx.fillRect(0, 0, 512, 24);
  ctx.fillStyle = '#4de698';
  ctx.font = '700 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('● RUN   2.00ms/div   100MSa/s   TRIG: CH1 ↑ 2.50V', 14, 16);

  ctx.strokeStyle = 'rgba(80, 145, 175, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 20; x <= 404; x += 32) {
    ctx.moveTo(x, 28);
    ctx.lineTo(x, 284);
  }
  for (let y = 28; y <= 284; y += 32) {
    ctx.moveTo(20, y);
    ctx.lineTo(404, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(110, 175, 205, 0.35)';
  ctx.beginPath();
  ctx.moveTo(20, 156);
  ctx.lineTo(404, 156);
  ctx.moveTo(212, 28);
  ctx.lineTo(212, 284);
  ctx.stroke();

  ctx.strokeStyle = '#ffd43b';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let x = 20; x <= 404; x += 2) {
    const phase = ((x - 20) % 72) / 72;
    let y = phase < 0.6 ? 78 : 132;
    if (phase < 0.06) y -= Math.sin((phase / 0.06) * Math.PI) * 5;
    if (x === 20) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = '#38d9f5';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let x = 20; x <= 404; x += 3) {
    const t = (x - 20) / 42;
    const y = 216 + Math.sin(t) * 26 + Math.cos(t * 2.3) * 7;
    if (x === 20) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#0e1d27';
  ctx.fillRect(412, 28, 94, 256);
  const menus = ['CH1 DC', 'BW 20M', 'PROBE 10×', 'MATH FFT', 'MEASURE'];
  menus.forEach((txt, i) => {
    const y = 36 + i * 49;
    ctx.fillStyle = i === 0 ? '#1e3c4f' : '#132734';
    ctx.fillRect(418, y, 82, 40);
    ctx.strokeStyle = '#2c5369';
    ctx.strokeRect(418, y, 82, 40);
    ctx.fillStyle = '#cfe5f0';
    ctx.font = '600 11px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(txt, 424, y + 24);
  });

  ctx.fillStyle = '#ffd43b';
  ctx.font = '700 12px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('CH1 5.00V/  Freq 50.0Hz  Duty 60.0%', 20, 306);
  ctx.fillStyle = '#38d9f5';
  ctx.fillText('CH2 200mA/  RMS 184mA', 300, 306);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 游标卡尺尺身毫米激光刻度贴图 */
function createCaliperScaleTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#d3d8de';
  ctx.fillRect(0, 0, 1024, 128);
  for (let y = 0; y < 128; y += 2) {
    ctx.fillStyle = y % 4 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(60,68,76,0.06)';
    ctx.fillRect(0, y, 1024, 1);
  }

  ctx.strokeStyle = '#1b1e22';
  ctx.fillStyle = '#1b1e22';
  ctx.font = '700 22px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const startX = 64;
  const pxPerMm = 6.0;
  for (let mm = 0; mm <= 150; mm++) {
    const x = startX + mm * pxPerMm;
    const isCm = mm % 10 === 0;
    const isHalf = mm % 5 === 0 && !isCm;
    ctx.lineWidth = isCm ? 2.4 : 1.4;
    ctx.beginPath();
    ctx.moveTo(x, 124);
    ctx.lineTo(x, isCm ? 82 : isHalf ? 94 : 104);
    ctx.stroke();
    if (isCm) ctx.fillText(`${mm}`, x, 78);
  }

  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = startX + i * 15.24;
    if (x > 980) break;
    ctx.moveTo(x, 4);
    ctx.lineTo(x, i % 10 === 0 ? 28 : 16);
  }
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 数显卡尺读数屏贴图（40.00 mm —— 对应 40mm 标定码尺寸校验） */
function createCaliperLcdTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#82937c';
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = '#475342';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 92);

  ctx.fillStyle = '#141b13';
  ctx.font = '700 48px "JetBrains Mono", Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('40.00', 206, 52);
  ctx.font = '700 20px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('mm', 242, 60);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 工业急停警示圆环丝印贴图（EMERGENCY STOP） */
function createEstopLegendTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#e2b224';
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = '#17181a';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(128, 128, 110, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#17181a';
  ctx.font = '800 24px "Inter", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EMERGENCY', 128, 38);
  ctx.fillText('STOP', 128, 218);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 元件抽屉白色打印索引标签贴图 */
function createDrawerCardTexture(title, sub, accentHex) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#f2efe8';
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = accentHex;
  ctx.fillRect(0, 0, 18, 96);
  ctx.strokeStyle = '#cfc9be';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, 252, 92);

  ctx.fillStyle = '#1d1e20';
  ctx.font = '700 32px "JetBrains Mono", Consolas, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 30, 38);
  ctx.fillStyle = '#5a5d62';
  ctx.font = '600 18px "JetBrains Mono", Consolas, sans-serif';
  ctx.fillText(sub, 30, 72);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 工业 PDU 排插三孔面板贴图 */
function createPduFaceTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#202328';
  ctx.fillRect(0, 0, 512, 64);

  for (let i = 0; i < 6; i++) {
    const cx = 110 + i * 64;
    ctx.fillStyle = '#15171b';
    ctx.beginPath();
    ctx.roundRect(cx - 22, 10, 44, 44, 5);
    ctx.fill();
    ctx.strokeStyle = '#363b43';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#07080a';
    ctx.fillRect(cx - 2.5, 16, 5, 11);
    ctx.save();
    ctx.translate(cx - 10, 40);
    ctx.rotate(0.45);
    ctx.fillRect(-2.5, -6, 5, 12);
    ctx.restore();
    ctx.save();
    ctx.translate(cx + 10, 40);
    ctx.rotate(-0.45);
    ctx.fillRect(-2.5, -6, 5, 12);
    ctx.restore();
  }

  ctx.fillStyle = '#7c828c';
  ctx.font = '700 11px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('250V~ 10A MAX', 14, 52);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 铝合金零件托盘内的紧凑型备用元件（剪短成型引脚，确保 100% 严格位于盘壁 R = 36 mm 内，绝不穿模） */
function createCompactSpareLed(hex, chromeMat) {
  const g = new THREE.Group();
  const isClear = hex === 'clear';
  const bodyMat = isClear
    ? new THREE.MeshPhysicalMaterial({ color: '#eef5f8', roughness: 0.06, transparent: true, opacity: 0.42, clearcoat: 1, ior: 1.5 })
    : new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.16, transparent: true, opacity: 0.9, clearcoat: 1, emissive: hex, emissiveIntensity: 0.1 });
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 1, 20), bodyMat);
  rim.rotation.z = Math.PI / 2;
  rim.position.set(-2, 2.9, 0);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 5, 20), bodyMat);
  cyl.rotation.z = Math.PI / 2;
  cyl.position.set(1, 2.9, 0);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
  dome.rotation.z = -Math.PI / 2;
  dome.position.set(3.5, 2.9, 0);
  g.add(rim, cyl, dome);

  for (const [z, len] of [[1.27, 8.5], [-1.27, 7.2]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, len, 8), chromeMat);
    leg.rotation.z = Math.PI / 2;
    leg.position.set(-2.5 - len / 2, 2.1, z);
    g.add(leg);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function createCompactSpareResistor(chromeMat) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#2f6e9c', roughness: 0.36, clearcoat: 0.65 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 6.2, 16), bodyMat);
  body.rotation.z = Math.PI / 2;
  body.position.y = 1.25;
  g.add(body);
  for (const [x, col] of [[-2.1, '#7b4a2a'], [-1.1, '#1a1a1a'], [-0.3, '#1a1a1a'], [0.5, '#c8312b'], [2.1, '#7b4a2a']]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(1.19, 1.19, 0.42, 16), new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 }));
    b.rotation.z = Math.PI / 2;
    b.position.set(x, 1.25, 0);
    g.add(b);
  }
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 6, 8), chromeMat);
    leg.rotation.z = Math.PI / 2;
    leg.position.set(s * 6.1, 1.0, 0);
    g.add(leg);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/**
 * 构建高精细度、全 PBR 微表面材质、零穿模的实验室工作台 3D 场景
 * @returns {THREE.Group}
 */
export function createWorkbench() {
  const root = new THREE.Group();
  root.name = 'workbench';

  // ——— 全套微表面 PBR 材质库（凹凸 + 空间粗糙度贴图，还原真实金属/橡胶/木质/晒纹塑料质感） ———
  const sand = getSandblastMaps(4, 4);
  const sandFine = getSandblastMaps(8, 8);
  const brushed = getBrushedMetalMaps(2, 2);
  const brushedLong = getBrushedMetalMaps(1, 6);
  const stipple = getMoldStippleMaps(5, 5);
  const pebble = getRubberPebbleMaps(14, 9);
  const braided = getBraidedCableMaps(22, 3);
  const wood = getWoodBenchMaps();
  const peg = getPegboardMaps(7, 2);
  const wallMaps = getLabWallMaps();

  const darkSteelMat = new THREE.MeshStandardMaterial({
    color: '#25282d',
    roughness: 0.62,
    metalness: 0.62,
    bumpMap: sand?.bumpMap ?? null,
    bumpScale: 0.35,
    roughnessMap: sand?.roughnessMap ?? null,
    envMapIntensity: 1.5,
  });

  const anodizedDarkMat = new THREE.MeshStandardMaterial({
    color: '#2f3339',
    roughness: 0.48,
    metalness: 0.72,
    bumpMap: sandFine?.bumpMap ?? null,
    bumpScale: 0.25,
    roughnessMap: sandFine?.roughnessMap ?? null,
    envMapIntensity: 1.8,
  });

  const brushedAluMat = new THREE.MeshStandardMaterial({
    color: '#c8cdd3',
    map: brushed?.map ?? null,
    bumpMap: brushed?.bumpMap ?? null,
    bumpScale: 0.22,
    roughnessMap: brushed?.roughnessMap ?? null,
    roughness: 0.36,
    metalness: 0.86,
    envMapIntensity: 2.0,
  });

  const aluExtrusionMat = new THREE.MeshStandardMaterial({
    color: '#cdd2d8',
    map: brushedLong?.map ?? null,
    bumpMap: brushedLong?.bumpMap ?? null,
    bumpScale: 0.28,
    roughnessMap: brushedLong?.roughnessMap ?? null,
    roughness: 0.38,
    metalness: 0.84,
    envMapIntensity: 1.9,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    color: '#dce0e6',
    bumpMap: brushed?.bumpMap ?? null,
    bumpScale: 0.1,
    roughnessMap: brushed?.roughnessMap ?? null,
    roughness: 0.22,
    metalness: 0.94,
    envMapIntensity: 2.4,
  });

  const brassMat = new THREE.MeshStandardMaterial({
    color: '#d2a644',
    bumpMap: brushed?.bumpMap ?? null,
    bumpScale: 0.14,
    roughness: 0.28,
    metalness: 0.88,
    envMapIntensity: 2.2,
  });

  const instrumentCaseMat = new THREE.MeshPhysicalMaterial({
    color: '#e1ddd3',
    roughness: 0.64,
    metalness: 0.04,
    bumpMap: stipple?.bumpMap ?? null,
    bumpScale: 0.32,
    roughnessMap: stipple?.roughnessMap ?? null,
    clearcoat: 0.08,
    clearcoatRoughness: 0.55,
  });

  const accentOrangeMat = new THREE.MeshPhysicalMaterial({
    color: '#c65e3b',
    roughness: 0.52,
    metalness: 0.06,
    bumpMap: stipple?.bumpMap ?? null,
    bumpScale: 0.24,
    roughnessMap: stipple?.roughnessMap ?? null,
    clearcoat: 0.22,
    clearcoatRoughness: 0.42,
  });

  const rubberMat = new THREE.MeshStandardMaterial({
    color: '#1b1d1f',
    roughness: 0.92,
    metalness: 0,
    bumpMap: sandFine?.bumpMap ?? null,
    bumpScale: 0.26,
    roughnessMap: sandFine?.roughnessMap ?? null,
  });

  const braidedMat = new THREE.MeshStandardMaterial({
    color: '#2a2d32',
    map: braided?.map ?? null,
    bumpMap: braided?.bumpMap ?? null,
    bumpScale: 0.55,
    roughness: 0.82,
    metalness: 0.08,
  });

  const yellowSafeMat = new THREE.MeshPhysicalMaterial({
    color: '#dfb024',
    roughness: 0.54,
    metalness: 0.02,
    bumpMap: stipple?.bumpMap ?? null,
    bumpScale: 0.3,
    roughnessMap: stipple?.roughnessMap ?? null,
    clearcoat: 0.16,
    clearcoatRoughness: 0.45,
  });

  const redStopMat = new THREE.MeshPhysicalMaterial({
    color: '#cf3427',
    roughness: 0.38,
    metalness: 0.02,
    bumpMap: stipple?.bumpMap ?? null,
    bumpScale: 0.14,
    clearcoat: 0.35,
    clearcoatRoughness: 0.3,
  });

  const smokedGlassMat = new THREE.MeshPhysicalMaterial({
    color: '#141a20',
    roughness: 0.06,
    metalness: 0.05,
    transparent: true,
    opacity: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 2.2,
    depthWrite: false,
  });

  const shadowMesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // =========================================================================
  // 1. 防静电工作台垫（ESD Mat，顶面在 Z = -BOARD.thickness = -0.1 mm）
  // =========================================================================
  const matZTop = -BOARD.thickness;
  const matShape = roundedRectShape(ESD_MAT.width, ESD_MAT.depth, 22);
  const matTex = createEsdMatTexture();
  if (matTex) {
    matTex.repeat.set(1 / ESD_MAT.width, 1 / ESD_MAT.depth);
    matTex.offset.set(0.5, 0.5);
  }
  const esdTopMat = new THREE.MeshStandardMaterial({
    color: matTex ? '#ffffff' : '#272b2a',
    map: matTex,
    bumpMap: pebble?.bumpMap ?? null,
    bumpScale: 0.24,
    roughnessMap: pebble?.roughnessMap ?? null,
    roughness: 0.88,
    metalness: 0.02,
  });
  const esdEdgeMat = new THREE.MeshStandardMaterial({ color: '#181a1a', roughness: 0.92, metalness: 0 });
  const esdMesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(matShape, {
      depth: ESD_MAT.thick - 0.8,
      bevelEnabled: true,
      bevelThickness: 0.4,
      bevelSize: 0.6,
      bevelSegments: 2,
      curveSegments: 14,
    }),
    [esdTopMat, esdEdgeMat],
  );
  esdMesh.name = 'table';
  esdMesh.rotation.x = -Math.PI / 2;
  esdMesh.position.copy(toThree(ESD_MAT.cx, ESD_MAT.cy, matZTop - ESD_MAT.thick + 0.4));
  esdMesh.receiveShadow = true;
  root.add(esdMesh);

  const benchZTop = matZTop - ESD_MAT.thick;
  const matAO = createContactShadow(ESD_MAT.width + 26, ESD_MAT.depth + 26, { opacity: 0.45 });
  matAO.position.copy(toThree(ESD_MAT.cx, ESD_MAT.cy, benchZTop + 0.06));
  root.add(matAO);

  // 台垫后角金属接地扣（位置远离左侧控制器与右侧稳压电源，确保零干涉）
  for (const [gx, gy, hasCord] of [[-305, 404, true], [602, 404, false]]) {
    const stud = shadowMesh(new THREE.CylinderGeometry(5.2, 5.8, 1.8, 24), chromeMat);
    stud.position.copy(toThree(gx, gy, matZTop + 0.9));
    root.add(stud);
    const inner = shadowMesh(new THREE.CylinderGeometry(2.3, 2.3, 2.2, 16), brassMat);
    inner.position.copy(toThree(gx, gy, matZTop + 1.0));
    root.add(inner);
    if (hasCord) {
      const cap = shadowMesh(new THREE.CylinderGeometry(7.2, 7.4, 4.2, 24), yellowSafeMat);
      cap.position.copy(toThree(gx, gy, matZTop + 2.4));
      root.add(cap);
      const cordCurve = new THREE.CatmullRomCurve3([
        toThree(gx, gy + 5, matZTop + 2.4),
        toThree(gx - 32, gy + 36, benchZTop + 2),
        toThree(gx - 95, gy + 86, benchZTop + 2),
        toThree(-460, 522, benchZTop + 10),
      ]);
      root.add(shadowMesh(new THREE.TubeGeometry(cordCurve, 24, 1.4, 8, false), rubberMat));
    }
  }

  // =========================================================================
  // 2. 实验室实木指接复合工作台桌面（完整木纹反照率 + 凹凸 + 粗糙度）与重型钢架
  // =========================================================================
  if (wood) {
    for (const t of [wood.map, wood.bumpMap, wood.roughnessMap]) {
      t.repeat.set(1 / BENCH.width, 1 / BENCH.depth);
      t.offset.set(0.5, 0.5);
    }
  }
  const woodTopMat = new THREE.MeshPhysicalMaterial({
    color: wood ? '#ffffff' : '#ba9266',
    map: wood?.map ?? null,
    bumpMap: wood?.bumpMap ?? null,
    bumpScale: 0.45,
    roughnessMap: wood?.roughnessMap ?? null,
    roughness: 0.68,
    metalness: 0.01,
    clearcoat: 0.14,
    clearcoatRoughness: 0.48,
  });
  const benchEdgeMat = new THREE.MeshStandardMaterial({
    color: '#292c31',
    roughness: 0.72,
    metalness: 0.18,
    bumpMap: sand?.bumpMap ?? null,
    bumpScale: 0.25,
  });
  const benchShape = roundedRectShape(BENCH.width, BENCH.depth, 14);
  const benchMesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(benchShape, {
      depth: BENCH.thick - 3,
      bevelEnabled: true,
      bevelThickness: 1.5,
      bevelSize: 1.5,
      bevelSegments: 2,
      curveSegments: 10,
    }),
    [woodTopMat, benchEdgeMat],
  );
  benchMesh.name = 'workbench-top';
  benchMesh.rotation.x = -Math.PI / 2;
  benchMesh.position.copy(toThree(BENCH.cx, BENCH.cy, benchZTop - BENCH.thick + 1.5));
  benchMesh.receiveShadow = true;
  benchMesh.castShadow = true;
  root.add(benchMesh);

  const frontTrim = shadowMesh(new RoundedBoxGeometry(BENCH.width - 36, 12, 4.5, 2, 1.2), anodizedDarkMat);
  frontTrim.position.copy(toThree(BENCH.cx, BENCH.cy - BENCH.depth / 2 - 1.2, benchZTop - BENCH.thick / 2));
  root.add(frontTrim);

  const frameZ = benchZTop - BENCH.thick;
  const apronH = 50;
  const insetX = 72;
  const insetY = 60;
  const frameW = BENCH.width - insetX * 2;
  const frameD = BENCH.depth - insetY * 2;
  for (const dy of [-frameD / 2, frameD / 2]) {
    const beam = shadowMesh(new THREE.BoxGeometry(frameW, apronH, 44), darkSteelMat);
    beam.position.copy(toThree(BENCH.cx, BENCH.cy + dy, frameZ - apronH / 2));
    root.add(beam);
  }
  for (const dx of [-frameW / 2, frameW / 2]) {
    const beam = shadowMesh(new THREE.BoxGeometry(44, apronH, frameD - 44), darkSteelMat);
    beam.position.copy(toThree(BENCH.cx + dx, BENCH.cy, frameZ - apronH / 2));
    root.add(beam);
  }
  const legH = 580;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const lx = BENCH.cx + sx * (frameW / 2 - 4);
      const ly = BENCH.cy + sy * (frameD / 2 - 4);
      const leg = shadowMesh(new THREE.BoxGeometry(58, legH, 58), darkSteelMat);
      leg.position.copy(toThree(lx, ly, frameZ - apronH - legH / 2));
      root.add(leg);
    }
  }

  // =========================================================================
  // 3. 机械臂阳极氧化铝光学安装底板（中心在 ARM.base = [148.5, 290]，顶面 Z = 0）
  // =========================================================================
  {
    const [ax, ay] = ARM.base;
    const plateW = 144;
    const plateD = 136;
    const plateH = 2.4;
    const basePlate = shadowMesh(new RoundedBoxGeometry(plateW, plateH, plateD, 3, 1.0), anodizedDarkMat);
    basePlate.position.copy(toThree(ax, ay, -plateH / 2 - 0.02));
    root.add(basePlate);

    const plateAO = createContactShadow(plateW + 18, plateD + 18, { opacity: 0.58 });
    plateAO.position.copy(toThree(ax, ay, matZTop + 0.06));
    root.add(plateAO);

    const collar = shadowMesh(new THREE.CylinderGeometry(58, 59.5, 0.45, 48), brushedAluMat);
    collar.position.copy(toThree(ax, ay, 0.16));
    root.add(collar);

    for (const dx of [-56, 56]) {
      for (const dy of [-52, 52]) {
        const clamp = shadowMesh(new RoundedBoxGeometry(16, 3.2, 16, 2, 0.8), brushedAluMat);
        clamp.position.copy(toThree(ax + dx, ay + dy, 1.5));
        root.add(clamp);
        const washer = shadowMesh(new THREE.CylinderGeometry(4.4, 4.4, 0.6, 16), chromeMat);
        washer.position.copy(toThree(ax + dx, ay + dy, 3.3));
        root.add(washer);
        const bolt = shadowMesh(new THREE.CylinderGeometry(3.2, 3.2, 2.4, 6), darkSteelMat);
        bolt.position.copy(toThree(ax + dx, ay + dy, 4.6));
        root.add(bolt);
      }
    }
  }

  // =========================================================================
  // 4. MC-500 机械臂运动与视觉控制器（左后方 X = -190, Y = 348，完全避开托盘与料盒）
  // =========================================================================
  {
    const ctrl = new THREE.Group();
    ctrl.name = 'arm-controller';
    const [cx, cy] = [-190, 348];
    ctrl.position.copy(toThree(cx, cy, matZTop));
    ctrl.rotation.y = (-14 * Math.PI) / 180;

    const [cw, ch, cd] = [148, 66, 116];
    const ao = createContactShadow(cw + 28, cd + 28, { opacity: 0.72 });
    ao.position.set(0, 0.08, 0);
    ctrl.add(ao);

    const chassis = shadowMesh(new RoundedBoxGeometry(cw, ch, cd, 4, 3), anodizedDarkMat);
    chassis.position.set(0, ch / 2 + 2.5, 0);
    ctrl.add(chassis);

    for (const dx of [-cw / 2 + 15, cw / 2 - 15]) {
      for (const dz of [-cd / 2 + 15, cd / 2 - 15]) {
        const foot = shadowMesh(new THREE.CylinderGeometry(6.5, 7.2, 2.8, 20), rubberMat);
        foot.position.set(dx, 1.4, dz);
        ctrl.add(foot);
      }
    }

    for (let i = -5; i <= 5; i++) {
      const fin = shadowMesh(new THREE.BoxGeometry(cw - 20, 3.5, 2.6), darkSteelMat);
      fin.position.set(0, ch + 4, i * 8.5);
      ctrl.add(fin);
    }
    const accentBar = shadowMesh(new RoundedBoxGeometry(cw - 8, 4.2, 6, 2, 1.2), accentOrangeMat);
    accentBar.position.set(0, ch + 1.8, cd / 2 - 4.5);
    ctrl.add(accentBar);

    const panelTex = createControllerPanelTexture();
    const frontMat = new THREE.MeshStandardMaterial({
      color: panelTex ? '#ffffff' : '#23262b',
      map: panelTex,
      roughness: 0.42,
      metalness: 0.25,
      emissive: panelTex ? '#12222b' : '#000000',
      emissiveMap: panelTex,
      emissiveIntensity: 0.42,
    });
    const frontPlate = new THREE.Mesh(new THREE.PlaneGeometry(cw - 8, ch - 8), frontMat);
    frontPlate.position.set(0, ch / 2 + 2.5, cd / 2 + 0.15);
    ctrl.add(frontPlate);

    const oledGlass = new THREE.Mesh(new THREE.PlaneGeometry(72, 41), smokedGlassMat);
    oledGlass.position.set(-28, ch / 2 - 1.2, cd / 2 + 0.45);
    ctrl.add(oledGlass);

    for (const sx of [-cw / 2 + 7, cw / 2 - 7]) {
      for (const sy of [9, ch - 4]) {
        const sc = shadowMesh(new THREE.CylinderGeometry(1.8, 1.8, 1.4, 6), chromeMat);
        sc.rotation.x = Math.PI / 2;
        sc.position.set(sx, sy, cd / 2 + 0.6);
        ctrl.add(sc);
      }
    }

    const ledSpecs = [
      [16, '#4de698', 1.7],
      [27, '#4de698', 1.4],
      [38, '#52b8ff', 1.3],
      [49, '#3d2222', 0.0],
    ];
    for (const [lx, col, ei] of ledSpecs) {
      const ring = shadowMesh(new THREE.CylinderGeometry(2.6, 2.8, 1.4, 16), chromeMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(lx, ch - 18, cd / 2 + 0.6);
      ctrl.add(ring);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 14, 10),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: ei, roughness: 0.25 }),
      );
      bulb.position.set(lx, ch - 18, cd / 2 + 1.1);
      ctrl.add(bulb);
    }

    const knobBase = shadowMesh(new THREE.CylinderGeometry(9.5, 10.2, 3, 28), darkSteelMat);
    knobBase.rotation.x = Math.PI / 2;
    knobBase.position.set(42, 26, cd / 2 + 1.5);
    ctrl.add(knobBase);
    const knobCap = shadowMesh(new THREE.CylinderGeometry(8.2, 8.6, 8.5, 28), brushedAluMat);
    knobCap.rotation.x = Math.PI / 2;
    knobCap.position.set(42, 26, cd / 2 + 6.5);
    ctrl.add(knobCap);
    const knobDot = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1, 12), accentOrangeMat);
    knobDot.rotation.x = Math.PI / 2;
    knobDot.position.set(45.5, 29.5, cd / 2 + 10.6);
    ctrl.add(knobDot);

    const gxNut = shadowMesh(new THREE.CylinderGeometry(8.2, 8.2, 5, 16), chromeMat);
    gxNut.rotation.z = Math.PI / 2;
    gxNut.position.set(cw / 2 + 2.5, 24, 10);
    ctrl.add(gxNut);
    const gxPlug = shadowMesh(new THREE.CylinderGeometry(6.6, 6.6, 12, 20), brushedAluMat);
    gxPlug.rotation.z = Math.PI / 2;
    gxPlug.position.set(cw / 2 + 10, 24, 10);
    ctrl.add(gxPlug);
    const boot = shadowMesh(new THREE.CylinderGeometry(5.2, 4.0, 10, 16), rubberMat);
    boot.rotation.z = Math.PI / 2;
    boot.position.set(cw / 2 + 20, 24, 10);
    ctrl.add(boot);

    root.add(ctrl);

    const cableCurve = new THREE.CatmullRomCurve3([
      toThree(cx + 88, cy - 10, 24),
      toThree(-35, 384, 7),
      toThree(62, 392, 5),
      toThree(ARM.base[0], ARM.base[1] + 50, 6),
    ]);
    const umbilical = shadowMesh(new THREE.TubeGeometry(cableCurve, 40, 4.2, 14, false), braidedMat);
    umbilical.name = 'arm-umbilical';
    root.add(umbilical);

    const clip = shadowMesh(new RoundedBoxGeometry(16, 10.5, 14, 2, 2), anodizedDarkMat);
    clip.position.copy(toThree(42, 390, 4.6));
    root.add(clip);
  }

  // =========================================================================
  // 5. 工业急停按钮盒（E-Stop，右前方 X = 468, Y = -52，完全避开料盒与所有工具）
  // =========================================================================
  {
    const estop = new THREE.Group();
    estop.name = 'emergency-stop';
    const [ex, ey] = [468, -52];
    estop.position.copy(toThree(ex, ey, matZTop));
    estop.rotation.y = (8 * Math.PI) / 180;

    const ao = createContactShadow(82, 82, { opacity: 0.65 });
    ao.position.set(0, 0.08, 0);
    estop.add(ao);

    const lowerBox = shadowMesh(new RoundedBoxGeometry(64, 18, 64, 4, 3), darkSteelMat);
    lowerBox.position.y = 9;
    estop.add(lowerBox);
    const upperBox = shadowMesh(new RoundedBoxGeometry(64, 18, 64, 4, 3.2), yellowSafeMat);
    upperBox.position.y = 26;
    estop.add(upperBox);

    for (const sx of [-24, 24]) {
      for (const sz of [-24, 24]) {
        const sc = shadowMesh(new THREE.CylinderGeometry(2.0, 2.0, 1.2, 8), chromeMat);
        sc.position.set(sx, 35.2, sz);
        estop.add(sc);
      }
    }

    const legendTex = createEstopLegendTexture();
    const legend = new THREE.Mesh(
      new THREE.CylinderGeometry(25, 25.5, 0.8, 36),
      new THREE.MeshStandardMaterial({ color: legendTex ? '#ffffff' : '#e2b224', map: legendTex, roughness: 0.45 }),
    );
    legend.position.y = 35.4;
    estop.add(legend);

    const bezel = shadowMesh(new THREE.CylinderGeometry(14.5, 16, 6.5, 32), chromeMat);
    bezel.position.y = 38.8;
    estop.add(bezel);
    const mushroomProfile = [
      [0, 40],
      [9.5, 40],
      [9.5, 46.5],
      [17.5, 47.2],
      [19.8, 49.5],
      [19.5, 53.5],
      [16.5, 56.2],
      [10, 57.6],
      [0, 58.2],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const mushroom = shadowMesh(new THREE.LatheGeometry(mushroomProfile, 36), redStopMat);
    estop.add(mushroom);

    const gland = shadowMesh(new THREE.CylinderGeometry(4.5, 5.2, 9, 14), darkSteelMat);
    gland.rotation.z = Math.PI / 2;
    gland.position.set(35, 12, 0);
    estop.add(gland);

    root.add(estop);

    const esCurve = new THREE.CatmullRomCurve3([
      toThree(ex + 38, ey, 11),
      toThree(586, -42, 2.8),
      toThree(608, 120, 2.8),
      toThree(608, 380, 2.8),
      toThree(590, 500, 2.8),
    ]);
    root.add(shadowMesh(new THREE.TubeGeometry(esCurve, 32, 2.3, 10, false), rubberMat));
  }

  // =========================================================================
  // 6. 双路数控直流稳压电源（右后方 X = 482, Y = 345，与前方工具保持 > 80 mm 净距，零穿模）
  // =========================================================================
  {
    const psu = new THREE.Group();
    psu.name = 'bench-power-supply';
    const [px, py] = [482, 345];
    psu.position.copy(toThree(px, py, matZTop));
    psu.rotation.y = (18 * Math.PI) / 180;

    const [pw, ph, pd] = [146, 112, 166];
    const ao = createContactShadow(pw + 30, pd + 30, { opacity: 0.72 });
    ao.position.set(0, 0.08, 0);
    psu.add(ao);

    const body = shadowMesh(new RoundedBoxGeometry(pw, ph, pd, 4, 4), instrumentCaseMat);
    body.position.set(0, ph / 2 + 4.5, 0);
    psu.add(body);

    for (const dx of [-pw / 2 + 18, pw / 2 - 18]) {
      for (const dz of [-pd / 2 + 20, pd / 2 - 20]) {
        const foot = shadowMesh(new THREE.CylinderGeometry(7.5, 8.5, 4.5, 20), rubberMat);
        foot.position.set(dx, 2.25, dz);
        psu.add(foot);
      }
    }

    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const vent = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3.2, 54), darkSteelMat);
        vent.position.set(side * (pw / 2 + 0.1), 40 + i * 9, -8);
        psu.add(vent);
      }
    }

    const bezel = shadowMesh(new RoundedBoxGeometry(pw + 3, ph + 3, 14, 3, 3), anodizedDarkMat);
    bezel.position.set(0, ph / 2 + 4.5, pd / 2 - 4);
    psu.add(bezel);

    const psuTex = createPowerSupplyPanelTexture();
    const frontMat = new THREE.MeshStandardMaterial({
      color: psuTex ? '#ffffff' : '#202327',
      map: psuTex,
      roughness: 0.4,
      metalness: 0.18,
      emissive: psuTex ? '#121f19' : '#000000',
      emissiveMap: psuTex,
      emissiveIntensity: 0.52,
    });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(pw - 8, ph - 8), frontMat);
    front.position.set(0, ph / 2 + 4.5, pd / 2 + 3.15);
    psu.add(front);

    const screenGlass = new THREE.Mesh(new THREE.PlaneGeometry(pw - 18, 41), smokedGlassMat);
    screenGlass.position.set(0, ph - 29.5, pd / 2 + 3.5);
    psu.add(screenGlass);

    for (const kx of [-47, -18, 18, 47]) {
      const skirt = shadowMesh(new THREE.CylinderGeometry(7.6, 8.2, 3.5, 24), darkSteelMat);
      skirt.rotation.x = Math.PI / 2;
      skirt.position.set(kx, 44, pd / 2 + 4.8);
      psu.add(skirt);
      const cap = shadowMesh(new THREE.CylinderGeometry(6.2, 6.6, 7.5, 24), brushedAluMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(kx, 44, pd / 2 + 9.2);
      psu.add(cap);
    }

    const posts = [
      [-48, '#cf3427'],
      [-24, '#1e2024'],
      [0, '#2a9c55'],
      [24, '#cf3427'],
      [48, '#1e2024'],
    ];
    for (const [bx, col] of posts) {
      const postMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.36, clearcoat: 0.35 });
      const collar = shadowMesh(new THREE.CylinderGeometry(5.6, 6.0, 4, 20), darkSteelMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.set(bx, 19, pd / 2 + 4.5);
      psu.add(collar);
      const nut = shadowMesh(new THREE.CylinderGeometry(4.6, 5.0, 9.5, 18), postMat);
      nut.rotation.x = Math.PI / 2;
      nut.position.set(bx, 19, pd / 2 + 9.5);
      psu.add(nut);
      const core = shadowMesh(new THREE.CylinderGeometry(2.1, 2.1, 11, 12), brassMat);
      core.rotation.x = Math.PI / 2;
      core.position.set(bx, 19, pd / 2 + 9.8);
      psu.add(core);
    }

    for (const hx of [-36, 36]) {
      const mount = shadowMesh(new RoundedBoxGeometry(10, 6, 16, 2, 1.5), darkSteelMat);
      mount.position.set(hx, ph + 6.5, 0);
      psu.add(mount);
    }
    const grip = shadowMesh(new RoundedBoxGeometry(66, 6.5, 16, 2, 2.5), rubberMat);
    grip.position.set(0, ph + 9.5, 0);
    psu.add(grip);

    root.add(psu);
  }

  // =========================================================================
  // 7. 工业 4040 真实 T 型槽铝型材龙门架、冲孔洞洞板（带工具）、仪器层板、PDU 与顶部 LED 灯
  //    位于工作台后部 Y = 535 mm
  // =========================================================================
  {
    const gantry = new THREE.Group();
    gantry.name = 'lab-gantry';
    const gy = 535;
    const leftX = -465;
    const rightX = 762;
    const spanW = rightX - leftX;
    const midX = (leftX + rightX) / 2;
    const postH = 535;

    const postGeo = create4040ProfileGeometry(postH);
    for (const px of [leftX, rightX]) {
      const post = shadowMesh(postGeo, aluExtrusionMat);
      post.rotation.x = Math.PI / 2;
      post.position.copy(toThree(px, gy, benchZTop + postH / 2));
      gantry.add(post);

      const cap = shadowMesh(new RoundedBoxGeometry(40.5, 4, 40.5, 2, 1), darkSteelMat);
      cap.position.copy(toThree(px, gy, benchZTop + postH + 2));
      gantry.add(cap);

      const flange = shadowMesh(new RoundedBoxGeometry(80, 9, 80, 2, 2), anodizedDarkMat);
      flange.position.copy(toThree(px, gy, benchZTop + 4.5));
      gantry.add(flange);
      for (const bx of [-28, 28]) {
        for (const by of [-28, 28]) {
          const b = shadowMesh(new THREE.CylinderGeometry(2.8, 2.8, 2.5, 6), chromeMat);
          b.position.copy(toThree(px + bx, gy + by, benchZTop + 10));
          gantry.add(b);
        }
      }
    }

    const beamGeo = create4040ProfileGeometry(spanW - 40);
    const topZ = benchZTop + postH - 20;
    const topBeam = shadowMesh(beamGeo, aluExtrusionMat);
    topBeam.rotation.y = Math.PI / 2;
    topBeam.position.copy(toThree(midX, gy, topZ));
    gantry.add(topBeam);

    const shelfZ = 235;
    const shelfBeam = shadowMesh(beamGeo, aluExtrusionMat);
    shelfBeam.rotation.y = Math.PI / 2;
    shelfBeam.position.copy(toThree(midX, gy, shelfZ - 22));
    gantry.add(shelfBeam);

    const gussetShape = new THREE.Shape();
    gussetShape.moveTo(0, 0);
    gussetShape.lineTo(36, 0);
    gussetShape.lineTo(0, 36);
    gussetShape.closePath();
    const gussetGeo = new THREE.ExtrudeGeometry(gussetShape, { depth: 28, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 1 });
    gussetGeo.translate(0, 0, -14);
    for (const [gx, dir] of [[leftX + 20, 1], [rightX - 20, -1]]) {
      for (const gz of [shelfZ - 42, topZ - 20]) {
        const gus = shadowMesh(gussetGeo, brushedAluMat);
        gus.scale.x = dir;
        gus.scale.y = -1;
        gus.position.copy(toThree(gx, gy, gz));
        gantry.add(gus);
      }
    }

    const shelfBoard = shadowMesh(new RoundedBoxGeometry(spanW + 40, 16, 158, 3, 2), anodizedDarkMat);
    shelfBoard.position.copy(toThree(midX, gy - 5, shelfZ));
    gantry.add(shelfBoard);
    const shelfLip = shadowMesh(new RoundedBoxGeometry(spanW + 40, 21, 5.5, 2, 1), brushedAluMat);
    shelfLip.position.copy(toThree(midX, gy - 84, shelfZ + 2.5));
    gantry.add(shelfLip);

    const pegH = 192;
    const pegMat = new THREE.MeshStandardMaterial({
      color: peg ? '#ffffff' : '#30343b',
      map: peg?.map ?? null,
      bumpMap: peg?.bumpMap ?? null,
      bumpScale: 0.7,
      roughnessMap: peg?.roughnessMap ?? null,
      roughness: 0.65,
      metalness: 0.45,
    });
    const pegBoard = shadowMesh(new THREE.BoxGeometry(spanW - 44, pegH, 6), pegMat);
    pegBoard.position.copy(toThree(midX, gy + 10, benchZTop + pegH / 2 + 12));
    gantry.add(pegBoard);

    for (const [sx, handleCol] of [[-355, '#c65e3b'], [-318, '#3668a8']]) {
      const sd = new THREE.Group();
      sd.position.copy(toThree(sx, gy - 4, 155));
      const hook = shadowMesh(new THREE.TorusGeometry(6, 1.3, 8, 16, Math.PI), chromeMat);
      hook.rotation.x = Math.PI / 2;
      hook.position.set(0, 6, -4);
      sd.add(hook);
      const handleMat = new THREE.MeshPhysicalMaterial({ color: handleCol, roughness: 0.48, bumpMap: stipple?.bumpMap ?? null, bumpScale: 0.2, clearcoat: 0.2 });
      const handle = shadowMesh(new THREE.CylinderGeometry(5.5, 4.8, 56, 16), handleMat);
      handle.position.y = 14;
      sd.add(handle);
      const endCap = shadowMesh(new THREE.CylinderGeometry(5.0, 5.5, 10, 16), darkSteelMat);
      endCap.position.y = 46;
      sd.add(endCap);
      const shaft = shadowMesh(new THREE.CylinderGeometry(1.5, 1.4, 72, 12), chromeMat);
      shaft.position.y = -48;
      sd.add(shaft);
      gantry.add(sd);
    }

    const pduZ = shelfZ - 22;
    const pduBody = shadowMesh(new RoundedBoxGeometry(410, 24, 24, 2, 2), darkSteelMat);
    pduBody.position.copy(toThree(midX, gy - 28, pduZ));
    gantry.add(pduBody);
    const pduTex = createPduFaceTexture();
    const pduFace = new THREE.Mesh(
      new THREE.PlaneGeometry(398, 20),
      new THREE.MeshStandardMaterial({ color: pduTex ? '#ffffff' : '#1e2126', map: pduTex, roughness: 0.55 }),
    );
    pduFace.position.copy(toThree(midX, gy - 40.3, pduZ));
    gantry.add(pduFace);
    const pduSwitch = new THREE.Mesh(
      new THREE.BoxGeometry(10, 12, 3.5),
      new THREE.MeshStandardMaterial({ color: '#ff4238', emissive: '#e0281e', emissiveIntensity: 1.5 }),
    );
    pduSwitch.position.copy(toThree(midX - 178, gy - 41.2, pduZ));
    gantry.add(pduSwitch);

    const wallY = BENCH.cy + BENCH.depth / 2 - 4;
    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(BENCH.width + 600, 1040),
      new THREE.MeshStandardMaterial({
        color: wallMaps ? '#ffffff' : '#d5d0c6',
        map: wallMaps?.map ?? null,
        bumpMap: wallMaps?.bumpMap ?? null,
        bumpScale: 0.35,
        roughness: 0.94,
        metalness: 0.01,
        side: THREE.FrontSide,
      }),
    );
    backWall.position.copy(toThree(BENCH.cx, wallY, 390));
    backWall.receiveShadow = true;
    gantry.add(backWall);

    const wainscot = new THREE.Mesh(
      new THREE.PlaneGeometry(BENCH.width + 600, 300),
      new THREE.MeshStandardMaterial({
        color: '#2e3237',
        bumpMap: sand?.bumpMap ?? null,
        bumpScale: 0.25,
        roughness: 0.82,
        metalness: 0.12,
        side: THREE.FrontSide,
      }),
    );
    wainscot.position.copy(toThree(BENCH.cx, wallY - 1, 105));
    wainscot.receiveShadow = true;
    gantry.add(wainscot);

    const dadoRail = new THREE.Mesh(
      new THREE.PlaneGeometry(BENCH.width + 600, 16),
      new THREE.MeshStandardMaterial({ color: '#b5bcc4', map: brushed?.map ?? null, roughness: 0.4, metalness: 0.78, side: THREE.FrontSide }),
    );
    dadoRail.position.copy(toThree(BENCH.cx, wallY - 2, 255));
    gantry.add(dadoRail);

    const lampY = 448;
    const lampZ = topZ + 12;
    for (const armX of [midX - 245, midX + 245]) {
      const armBar = shadowMesh(new RoundedBoxGeometry(22, 16, 118, 2, 2), brushedAluMat);
      armBar.position.copy(toThree(armX, (gy + lampY) / 2, lampZ));
      gantry.add(armBar);
    }
    const lampHousing = new THREE.Group();
    lampHousing.position.copy(toThree(midX, lampY, lampZ));
    lampHousing.rotation.x = (22 * Math.PI) / 180;
    const hood = shadowMesh(new RoundedBoxGeometry(700, 20, 56, 3, 2.5), anodizedDarkMat);
    lampHousing.add(hood);
    const diffuser = new THREE.Mesh(
      new THREE.PlaneGeometry(666, 40),
      new THREE.MeshStandardMaterial({ color: '#fffcf5', emissive: '#fff6e6', emissiveIntensity: 2.0, roughness: 0.25 }),
    );
    diffuser.rotation.x = Math.PI / 2;
    diffuser.position.y = -10.2;
    lampHousing.add(diffuser);
    gantry.add(lampHousing);

    // —— 层板左侧：高精度数字存储示波器（Oscilloscope）
    {
      const osc = new THREE.Group();
      osc.name = 'oscilloscope';
      osc.position.copy(toThree(midX - 185, gy - 12, shelfZ + 8));
      const [ow, oh, od] = [236, 126, 102];

      const oAO = createContactShadow(ow + 24, od + 24, { opacity: 0.65 });
      oAO.position.set(0, 0.1, 0);
      osc.add(oAO);

      const oBody = shadowMesh(new RoundedBoxGeometry(ow, oh, od, 4, 4), instrumentCaseMat);
      oBody.position.y = oh / 2 + 2;
      osc.add(oBody);
      const oBezel = shadowMesh(new RoundedBoxGeometry(ow - 4, oh - 4, 10, 3, 2.5), anodizedDarkMat);
      oBezel.position.set(0, oh / 2 + 2, od / 2 - 2);
      osc.add(oBezel);

      const oscTex = createOscilloscopeScreenTexture();
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(142, 92),
        new THREE.MeshStandardMaterial({
          color: oscTex ? '#ffffff' : '#08141c',
          map: oscTex,
          emissive: oscTex ? '#122c38' : '#000000',
          emissiveMap: oscTex,
          emissiveIntensity: 0.8,
          roughness: 0.22,
        }),
      );
      screen.position.set(-36, oh / 2 + 5, od / 2 + 3.2);
      osc.add(screen);

      const oscGlass = new THREE.Mesh(new THREE.PlaneGeometry(142, 92), smokedGlassMat);
      oscGlass.position.set(-36, oh / 2 + 5, od / 2 + 3.6);
      osc.add(oscGlass);

      for (let i = 0; i < 5; i++) {
        const btn = shadowMesh(new RoundedBoxGeometry(7, 4.5, 4, 1, 0.8), instrumentCaseMat);
        btn.position.set(42, oh - 22 - i * 16.5, od / 2 + 4);
        osc.add(btn);
      }

      const runBtn = new THREE.Mesh(
        new RoundedBoxGeometry(12, 7, 4, 1, 1),
        new THREE.MeshStandardMaterial({ color: '#3ae683', emissive: '#22bf65', emissiveIntensity: 1.2, roughness: 0.35 }),
      );
      runBtn.position.set(96, oh - 16, od / 2 + 4);
      osc.add(runBtn);

      for (const [kx, ky, rad] of [[66, 92, 7.2], [94, 92, 5.2], [66, 62, 6.2], [94, 62, 6.2]]) {
        const k = shadowMesh(new THREE.CylinderGeometry(rad, rad + 0.8, 8, 22), brushedAluMat);
        k.rotation.x = Math.PI / 2;
        k.position.set(kx, ky, od / 2 + 6);
        osc.add(k);
      }

      for (const [bx, ringCol] of [[52, '#ffd43b'], [72, '#38d9f5'], [92, '#c96442'], [108, '#9aa0a8']]) {
        const bncBase = shadowMesh(new THREE.CylinderGeometry(5.2, 5.4, 2, 16), new THREE.MeshStandardMaterial({ color: ringCol, roughness: 0.4 }));
        bncBase.rotation.x = Math.PI / 2;
        bncBase.position.set(bx, 24, od / 2 + 3.8);
        osc.add(bncBase);
        const bnc = shadowMesh(new THREE.CylinderGeometry(3.8, 3.8, 10, 16), chromeMat);
        bnc.rotation.x = Math.PI / 2;
        bnc.position.set(bx, 24, od / 2 + 8);
        osc.add(bnc);
      }
      gantry.add(osc);
    }

    // —— 层板右侧：12 格工业电子元件抽屉柜（带打印索引卡片与半透明抽屉）
    {
      const cab = new THREE.Group();
      cab.name = 'component-cabinet';
      cab.position.copy(toThree(midX + 185, gy - 12, shelfZ + 8));
      const [cw, ch, cd] = [228, 126, 100];

      const cAO = createContactShadow(cw + 24, cd + 24, { opacity: 0.65 });
      cAO.position.set(0, 0.1, 0);
      cab.add(cAO);

      const frame = shadowMesh(new RoundedBoxGeometry(cw, ch, cd, 3, 2.5), darkSteelMat);
      frame.position.y = ch / 2;
      cab.add(frame);

      const drawerMat = new THREE.MeshPhysicalMaterial({
        color: '#d4dfe8',
        roughness: 0.32,
        bumpMap: stipple?.bumpMap ?? null,
        bumpScale: 0.12,
        transparent: true,
        opacity: 0.86,
        clearcoat: 0.35,
      });
      const cards = [
        ['10kΩ', '1/4W 1%', '#3f7fd0'],
        ['4.7kΩ', '1/4W 1%', '#3f7fd0'],
        ['1kΩ', '1/4W 1%', '#3f7fd0'],
        ['330Ω', '1/4W 1%', '#3f7fd0'],
        ['LED-R', '5mm RED', '#d94c4c'],
        ['LED-G', '5mm GRN', '#3aa65a'],
        ['LED-B', '5mm BLU', '#3d6be0'],
        ['LED-Y', '5mm YLW', '#e0ad2e'],
        ['LED-C', '5mm CLR', '#8aa3b0'],
        ['100nF', 'MLCC', '#c96442'],
        ['M3×8', 'SUS304', '#6d7580'],
        ['HDR', '2.54mm', '#4d545e'],
      ];
      const cols = 4;
      const rows = 3;
      const dw = (cw - 20) / cols;
      const dh = (ch - 18) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = (rows - 1 - r) * cols + c;
          const [title, sub, hex] = cards[idx];
          const x = -((cols - 1) * dw) / 2 + c * dw;
          const y = 11 + dh / 2 + r * dh;
          const dr = shadowMesh(new RoundedBoxGeometry(dw - 4.5, dh - 4.5, 9, 2, 1.2), drawerMat);
          dr.position.set(x, y, cd / 2 + 1.5);
          cab.add(dr);
          const handle = shadowMesh(new RoundedBoxGeometry(dw - 14, 4.5, 4.5, 2, 1.2), anodizedDarkMat);
          handle.position.set(x, y - 9.5, cd / 2 + 6.5);
          cab.add(handle);
          const cardTex = createDrawerCardTexture(title, sub, hex);
          const card = new THREE.Mesh(
            new THREE.PlaneGeometry(dw - 11, 14),
            new THREE.MeshStandardMaterial({ color: cardTex ? '#ffffff' : '#f2efe8', map: cardTex, roughness: 0.65 }),
          );
          card.position.set(x, y + 3.5, cd / 2 + 6.2);
          cab.add(card);
        }
      }
      gantry.add(cab);
    }

    root.add(gantry);
  }

  // =========================================================================
  // 8. 台垫外围高精细度实验工具（全部经空间包围盒校核，零穿模）
  // =========================================================================

  // —— ① 高精度数显游标卡尺（左侧 X = -205, Y = 55）
  {
    const caliper = new THREE.Group();
    caliper.name = 'digital-caliper';
    caliper.position.copy(toThree(-205, 55, matZTop + 0.1));
    caliper.rotation.y = (-6 * Math.PI) / 180;

    const cAO = createContactShadow(46, 206, { opacity: 0.45 });
    cAO.position.set(4, 0.05, 0);
    caliper.add(cAO);

    const beam = shadowMesh(new RoundedBoxGeometry(15.5, 2.8, 194, 2, 0.45), chromeMat);
    beam.position.set(0, 1.4, 0);
    caliper.add(beam);

    const scaleTex = createCaliperScaleTexture();
    const scaleFace = new THREE.Mesh(
      new THREE.PlaneGeometry(188, 13.5),
      new THREE.MeshStandardMaterial({
        color: scaleTex ? '#ffffff' : '#d2d7dd',
        map: scaleTex,
        roughness: 0.28,
        metalness: 0.85,
      }),
    );
    scaleFace.rotation.x = -Math.PI / 2;
    scaleFace.rotation.z = -Math.PI / 2;
    scaleFace.position.set(0, 2.86, 0);
    caliper.add(scaleFace);

    const depthRod = shadowMesh(new THREE.BoxGeometry(2.2, 1.4, 28), chromeMat);
    depthRod.position.set(0, 1.2, 108);
    caliper.add(depthRod);

    const makeExtJaw = (dir) => {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(36, 0);
      sh.lineTo(36, dir * 2.2);
      sh.lineTo(24, dir * 10.5);
      sh.lineTo(0, dir * 12.5);
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 2.4, bevelEnabled: true, bevelThickness: 0.25, bevelSize: 0.25, bevelSegments: 1 });
      geo.rotateX(Math.PI / 2);
      return geo;
    };
    const fixedJaw = shadowMesh(makeExtJaw(-1), chromeMat);
    fixedJaw.position.set(7.2, 2.6, -84);
    caliper.add(fixedJaw);
    const moveJaw = shadowMesh(makeExtJaw(1), chromeMat);
    moveJaw.position.set(7.2, 2.6, -44);
    caliper.add(moveJaw);

    for (const [zPos, dir] of [[-84, -1], [-44, 1]]) {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(-16, 0);
      sh.lineTo(-14, dir * 5.5);
      sh.lineTo(0, dir * 8);
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 1 });
      geo.rotateX(Math.PI / 2);
      const j = shadowMesh(geo, chromeMat);
      j.position.set(-7.2, 2.5, zPos);
      caliper.add(j);
    }

    const slider = shadowMesh(new RoundedBoxGeometry(26, 7.2, 56, 3, 1.4), anodizedDarkMat);
    slider.position.set(1.5, 4.2, -26);
    caliper.add(slider);

    const lcdTex = createCaliperLcdTexture();
    const lcd = new THREE.Mesh(
      new THREE.PlaneGeometry(14.5, 34),
      new THREE.MeshStandardMaterial({ color: lcdTex ? '#ffffff' : '#82937c', map: lcdTex, roughness: 0.3 }),
    );
    lcd.rotation.x = -Math.PI / 2;
    lcd.rotation.z = -Math.PI / 2;
    lcd.position.set(-0.8, 7.88, -26);
    caliper.add(lcd);

    for (const [bz, bcol] of [[-38, '#3668a8'], [-26, '#c83e32'], [-14, '#d9a828']]) {
      const btn = shadowMesh(new RoundedBoxGeometry(4.2, 1.4, 7.5, 1, 0.4), new THREE.MeshStandardMaterial({ color: bcol, roughness: 0.5 }));
      btn.position.set(10, 7.9, bz);
      caliper.add(btn);
    }

    const roller = shadowMesh(new THREE.CylinderGeometry(4.2, 4.2, 3.6, 20), brushedAluMat);
    roller.position.set(14.5, 3.0, -4);
    caliper.add(roller);
    const lock = shadowMesh(new THREE.CylinderGeometry(2.8, 2.8, 4.2, 16), brassMat);
    lock.position.set(-9.5, 8.2, -26);
    caliper.add(lock);

    root.add(caliper);
  }

  // —— ② CNC 车削铝合金磁性零件盘（左侧 X = -195, Y = 215，内部紧凑备用元件严格限制在盘壁 R=36mm 内）
  {
    const tray = new THREE.Group();
    tray.name = 'spare-parts-tray';
    tray.position.copy(toThree(-195, 215, matZTop));

    const tAO = createContactShadow(94, 94, { kind: 'circle', opacity: 0.62 });
    tAO.position.set(0, 0.08, 0);
    tray.add(tAO);

    const dishProfile = [
      [0, 0],
      [35, 0],
      [39.5, 2.6],
      [40.5, 8.2],
      [38.2, 8.8],
      [36.0, 7.8],
      [34.5, 2.2],
      [0, 2.2],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const dish = shadowMesh(new THREE.LatheGeometry(dishProfile, 56), brushedAluMat);
    tray.add(dish);

    const pad = shadowMesh(new THREE.CylinderGeometry(34.2, 34.2, 0.5, 44), rubberMat);
    pad.position.y = 2.25;
    tray.add(pad);

    const spares = [
      { kind: 'res', x: -11, z: -8, rot: 28 },
      { kind: 'res', x: 8, z: 12, rot: -42 },
      { kind: 'led', col: LED_COLORS.red.hex, x: -7, z: 11, rot: 125 },
      { kind: 'led', col: LED_COLORS.green.hex, x: 11, z: -9, rot: -20 },
      { kind: 'led', col: LED_COLORS.blue.hex, x: -1, z: 0, rot: 62 },
    ];
    for (const sp of spares) {
      const m = sp.kind === 'res' ? createCompactSpareResistor(chromeMat) : createCompactSpareLed(sp.col, chromeMat);
      m.position.set(sp.x, 2.52, sp.z);
      m.rotation.y = (sp.rot * Math.PI) / 180;
      tray.add(m);
    }

    root.add(tray);
  }

  // —— ③ ESD-15 防静电精密直尖镊子（右侧 X = 428, Y = 88）
  {
    const tweezers = new THREE.Group();
    tweezers.name = 'esd-tweezers';
    tweezers.position.copy(toThree(428, 88, matZTop + 0.1));
    tweezers.rotation.y = (14 * Math.PI) / 180;

    const twAO = createContactShadow(24, 140, { opacity: 0.42 });
    twAO.position.set(0, 0.05, 0);
    tweezers.add(twAO);

    for (const side of [-1, 1]) {
      const sh = new THREE.Shape();
      sh.moveTo(0, -64);
      sh.lineTo(side * 4.4, -64);
      sh.lineTo(side * 4.6, -12);
      sh.lineTo(side * 2.2, 34);
      sh.lineTo(side * 0.7, 65);
      sh.lineTo(side * 0.25, 65);
      sh.lineTo(side * 1.4, 34);
      sh.lineTo(side * 3.0, -12);
      sh.lineTo(side * 2.6, -54);
      sh.lineTo(0, -56);
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.18, bevelSegments: 1 });
      geo.rotateX(Math.PI / 2);
      const blade = shadowMesh(geo, chromeMat);
      blade.position.y = 2.6;
      tweezers.add(blade);

      const coat = shadowMesh(new RoundedBoxGeometry(2.1, 2.9, 74, 2, 0.5), anodizedDarkMat);
      coat.position.set(side * 3.6, 1.6, -24);
      coat.rotation.y = side * 0.018;
      tweezers.add(coat);
    }

    root.add(tweezers);
  }

  // —— ④ 精密电子斜口剪线钳（Flush Cutters，右侧 X = 508, Y = 106，前后均与急停盒及稳压电源留有充裕净距，零穿模！）
  {
    const cutters = new THREE.Group();
    cutters.name = 'flush-cutters';
    cutters.position.copy(toThree(508, 106, matZTop + 0.1));
    cutters.rotation.y = (-12 * Math.PI) / 180;

    const cutAO = createContactShadow(66, 138, { opacity: 0.48 });
    cutAO.position.set(0, 0.05, 0);
    cutters.add(cutAO);

    const makeJaw = (side) => {
      const sh = new THREE.Shape();
      sh.moveTo(0, -16);
      sh.lineTo(side * 7.8, -19);
      sh.lineTo(side * 6.5, -36);
      sh.lineTo(side * 1.8, -56);
      sh.lineTo(side * 0.35, -56);
      sh.lineTo(side * 0.8, -32);
      sh.lineTo(0, -24);
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 4.2, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.4, bevelSegments: 2 });
      geo.rotateX(Math.PI / 2);
      return geo;
    };
    const jawL = shadowMesh(makeJaw(-1), chromeMat);
    jawL.position.y = 5.2;
    const jawR = shadowMesh(makeJaw(1), chromeMat);
    jawR.position.y = 5.2;
    cutters.add(jawL, jawR);

    const pivot = shadowMesh(new THREE.CylinderGeometry(8.2, 8.6, 5.8, 24), darkSteelMat);
    pivot.position.set(0, 3.1, -18);
    cutters.add(pivot);
    const screw = shadowMesh(new THREE.CylinderGeometry(3.8, 3.8, 6.4, 20), chromeMat);
    screw.position.set(0, 3.2, -18);
    cutters.add(screw);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.6, 1.0), darkSteelMat);
    slot.position.set(0, 6.45, -18);
    cutters.add(slot);

    for (const side of [-1, 1]) {
      const tang = shadowMesh(new RoundedBoxGeometry(5.5, 4.2, 20, 2, 0.8), darkSteelMat);
      tang.position.set(side * 5.2, 3.1, -6);
      tang.rotation.y = side * 0.25;
      cutters.add(tang);

      const guard = shadowMesh(new RoundedBoxGeometry(11.5, 9.2, 11, 2, 2.2), rubberMat);
      guard.position.set(side * 9.5, 4.6, 4);
      guard.rotation.y = side * 0.26;
      cutters.add(guard);

      const gripCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 8.5, 4.6, 6),
        new THREE.Vector3(side * 16.5, 5.0, 32),
        new THREE.Vector3(side * 20.5, 4.6, 58),
      ]);
      const grip = shadowMesh(new THREE.TubeGeometry(gripCurve, 22, 4.6, 12, false), accentOrangeMat);
      cutters.add(grip);

      const endCap = shadowMesh(new THREE.SphereGeometry(4.6, 14, 10), accentOrangeMat);
      endCap.position.set(side * 20.5, 4.6, 58);
      cutters.add(endCap);

      const springCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 7.5, 3.4, 8),
        new THREE.Vector3(side * 3.0, 3.4, 24),
        new THREE.Vector3(side * 0.6, 3.4, 36),
      ]);
      const spring = shadowMesh(new THREE.TubeGeometry(springCurve, 12, 0.7, 6, false), chromeMat);
      cutters.add(spring);
    }

    root.add(cutters);
  }

  return root;
}
