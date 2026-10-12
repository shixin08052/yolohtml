// 合成测试图生成器（synth.html）。
// 用 Three.js 离屏渲染一张 4032 × 3024 的"照片"，真值用 synth/truth.js 的针孔公式计算。
import * as THREE from 'three';
import { BOARD } from './config.js';
import layout from './synth/layout.json';
import { SYNTH_PRESETS } from './synth/presets.js';
import { makeGroundTruth } from './synth/truth.js';
import { createPartMesh } from './scene/parts.js';
import { toThree, cameraQuaternionFromR } from './math/coords.js';
import { buildBoardSVG, renderBoardToCanvas } from './ui/boardSheet.js';
import { drawTruth } from './ui/truthOverlay.js';
import { detectMarkersInImage } from './vision/aruco.js';

const W = 4032;
const H = 3024;
const TEXTURE_PX_PER_MM = 10;

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

/** 深色桌垫纹理：低频斑驳（程序生成，固定种子）。不加逐像素噪声，PNG 才不会太大 */
function tableTexture() {
  const small = document.createElement('canvas');
  small.width = 48;
  small.height = 48;
  const sctx = small.getContext('2d');
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const img = sctx.createImageData(48, 48);
  for (let i = 0; i < img.data.length; i += 4) {
    const g = 50 + (rnd() - 0.5) * 14;
    img.data[i] = g + 3;
    img.data[i + 1] = g;
    img.data[i + 2] = g - 4;
    img.data[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.5);
  return tex;
}

async function buildScene(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a2724');

  // 光照：半球光 + 一盏带阴影的平行光（从左上方照下）
  scene.add(new THREE.HemisphereLight('#ffffff', '#4a4640', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.copy(toThree(BOARD.width / 2 - 250, BOARD.height / 2 + 200, 600));
  sun.target.position.copy(toThree(BOARD.width / 2, BOARD.height / 2, 0));
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -260;
  sun.shadow.camera.right = 260;
  sun.shadow.camera.top = 200;
  sun.shadow.camera.bottom = -200;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 1500;
  sun.shadow.bias = -0.0005;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // 桌面：比视野大，板面下方 BOARD.thickness 处
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1200),
    new THREE.MeshStandardMaterial({ map: tableTexture(), roughness: 0.95 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.copy(toThree(BOARD.width / 2, BOARD.height / 2, -BOARD.thickness));
  table.receiveShadow = true;
  scene.add(table);

  // 底板：顶面贴标定板图案（不含屏幕标注）
  const sheet = await renderBoardToCanvas(buildBoardSVG(), TEXTURE_PX_PER_MM);
  const tex = new THREE.CanvasTexture(sheet);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const paper = new THREE.MeshStandardMaterial({ color: '#f4f3ef', roughness: 0.9 });
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
  // BoxGeometry 面顺序：+x, −x, +y(顶), −y, +z, −z；顶面 u 沿 +x、v=1 在 −z（= 底板 +Y 远端）
  const board = new THREE.Mesh(new THREE.BoxGeometry(BOARD.width, BOARD.thickness, BOARD.height), [paper, paper, top, paper, paper, paper]);
  board.position.copy(toThree(BOARD.width / 2, BOARD.height / 2, -BOARD.thickness / 2));
  board.receiveShadow = true;
  scene.add(board);

  // 零件
  for (const p of layout.parts) {
    const m = createPartMesh(p.cls);
    m.position.copy(toThree(p.x, p.y, 0));
    m.rotation.y = ((p.rotDeg ?? 0) * Math.PI) / 180;
    scene.add(m);
  }
  return scene;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

let renderer = null;
let scenePromise = null;

function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  return renderer;
}

/**
 * 渲染一个预设视角
 * @returns {Promise<{canvas: HTMLCanvasElement, truth: import('./state.js').GroundTruth}>}
 */
async function renderPreset(preset) {
  const r = getRenderer();
  scenePromise ??= buildScene(r);
  const scene = await scenePromise;
  const truth = makeGroundTruth(preset, layout.parts);
  const { fy } = truth.intrinsics;
  const cam = new THREE.PerspectiveCamera((2 * Math.atan(H / 2 / fy) * 180) / Math.PI, W / H, 5, 5000);
  cam.position.copy(toThree(...truth.position));
  cam.quaternion.copy(cameraQuaternionFromR(truth.R));
  cam.updateMatrixWorld();
  r.render(scene, cam);
  return { canvas: r.domElement, truth };
}

/** 渲染结果自检：识别码，与真值角点比较 */
function selfCheck(canvas, truth) {
  const det = detectMarkersInImage(canvas, 1600);
  const errs = [];
  const rows = truth.markers.map((t) => {
    const m = det.markers.find((x) => x.id === t.id);
    if (!m) return { id: t.id, found: false };
    const e = m.corners.map((c, i) => Math.hypot(c[0] - t.corners[i][0], c[1] - t.corners[i][1]));
    errs.push(...e);
    return { id: t.id, found: true, mean: e.reduce((a, b) => a + b, 0) / 4, max: Math.max(...e) };
  });
  return {
    rows,
    found: rows.filter((r) => r.found).length,
    mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    max: errs.length ? Math.max(...errs) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);
const fmt = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
let current = null; // { preset, canvas, truth, check }

function drawPreview() {
  const pv = $('#preview');
  if (!current) return;
  const k = 1600 / W;
  pv.width = 1600;
  pv.height = Math.round(H * k);
  const ctx = pv.getContext('2d');
  ctx.drawImage(current.canvas, 0, 0, pv.width, pv.height);
  if ($('#show-truth').checked) {
    ctx.save();
    ctx.scale(k, k);
    drawTruth(ctx, current.truth, k, 1.6);
    ctx.restore();
  }
}

function showInfo() {
  const { truth, check } = current;
  const [X, Y, Z] = truth.position;
  $('#truth').innerHTML =
    '<table>' +
    `<tr><td>手机位置 (X, Y, Z)</td><td>${fmt(X)}, ${fmt(Y)}, ${fmt(Z)} mm</td></tr>` +
    `<tr><td>离桌面高度</td><td>${fmt(Z / 10, 2)} cm</td></tr>` +
    `<tr><td>俯角</td><td>${fmt(truth.pitchDeg, 2)}°</td></tr>` +
    `<tr><td>fx = fy</td><td>${fmt(truth.intrinsics.fx, 2)}</td></tr>` +
    `<tr><td>零件数</td><td>${truth.parts.length}</td></tr>` +
    '</table>';
  $('#truth').classList.remove('muted');
  const ok = check.found === 4 && check.mean < 3;
  $('#check').innerHTML =
    `<div class="${ok ? 'ok' : 'bad'}">${ok ? '✓ 渲染与真值一致' : '✗ 渲染与真值不一致'}</div><table>` +
    check.rows.map((r) => `<tr><td>ID ${r.id}</td><td>${r.found ? `平均 ${fmt(r.mean, 2)} px · 最大 ${fmt(r.max, 2)} px` : '<span class="bad">未识别</span>'}</td></tr>`).join('') +
    `<tr><td>全部角点</td><td>平均 ${fmt(check.mean, 2)} px · 最大 ${fmt(check.max, 2)} px</td></tr></table>`;
  $('#check').classList.remove('muted');
  $('#check').dataset.ok = String(ok);
}

async function select(key) {
  const preset = SYNTH_PRESETS.find((p) => p.key === key);
  for (const b of document.querySelectorAll('#preset-tabs .tab')) b.classList.toggle('active', b.dataset.key === key);
  $('#busy').hidden = false;
  $('#check').dataset.ok = '';
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const { canvas, truth } = await renderPreset(preset);
    current = { preset, canvas, truth, check: selfCheck(canvas, truth) };
    drawPreview();
    showInfo();
  } finally {
    $('#busy').hidden = true;
  }
  return current;
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const pngBlob = () => new Promise((res) => current.canvas.toBlob(res, 'image/png'));
const truthJSON = () => JSON.stringify(current.truth, null, 2);

for (const p of SYNTH_PRESETS) {
  const b = document.createElement('button');
  b.className = 'tab';
  b.dataset.key = p.key;
  b.textContent = `俯角 ${p.pitchDeg}°`;
  b.addEventListener('click', () => select(p.key));
  $('#preset-tabs').appendChild(b);
}
$('#show-truth').addEventListener('change', drawPreview);
$('#dl-png').addEventListener('click', async () => current && download(`${current.preset.key}.png`, await pngBlob()));
$('#dl-json').addEventListener('click', () => current && download(`${current.preset.key}.truth.json`, new Blob([truthJSON()], { type: 'application/json' })));

// 供自动化脚本批量生成 public/samples/ 下的文件
window.__synth = {
  presets: SYNTH_PRESETS,
  async generate(key) {
    await select(key);
    const blob = await pngBlob();
    const png = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
    return { png, truth: truthJSON(), check: current.check };
  },
};

select(SYNTH_PRESETS[0].key);
