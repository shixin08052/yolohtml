// 流程编排。
import { store, STAGE_LABELS, STEPS, stageIndex } from './state.js';
import { createStepper } from './ui/stepper.js';
import { createTabs } from './ui/tabs.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createDebugView } from './ui/debugView.js';
import { drawTruth } from './ui/truthOverlay.js';
import { createWorld } from './scene/world.js';
import { createBoard } from './scene/board.js';
import { createPhone, panoramaAzimuth } from './scene/phone.js';
import { createTransition } from './scene/transition.js';
import { buildBoardSVG, renderBoardToCanvas } from './ui/boardSheet.js';
import { loadSampleIndex, loadSample } from './vision/samples.js';
import { loadImageFile, ImageFormatError } from './vision/image.js';
import { computeIntrinsics, defaultSource } from './vision/intrinsics.js';
import { renderImagePanel } from './ui/imagePanel.js';
import { detectMarkersInImage, VALID_IDS } from './vision/aruco.js';
import { markerCornerErrors, homographyTruthError, poseTruthError } from './vision/evaluate.js';
import { poseFromHomography, estimateFocal } from './vision/pose.js';
import { intrinsicsMatrix } from './math/pinhole.js';
import { mul3 } from './math/linalg.js';
import { drawPose } from './ui/poseOverlay.js';
import { boardHomography, rectify, invert3 } from './vision/homography.js';
import { boxToTexture, erasePolygons } from './vision/erase.js';
import { estimateYaw, expandPoly } from './vision/orientation.js';
import { segmentParts, fuseDetections } from './vision/colorSeg.js';
import { measurePaper, EDGE_NAMES, CHECK_LIMITS } from './vision/boardCheck.js';
import { markerCornersWorld, markerRectOnPage, paperFrame, designFrame, frameMatrix } from './vision/boardLayout.js';
import { BOARD, MARKERS } from './config.js';
import { drawMarkers } from './ui/markerOverlay.js';
import { createBoxEditor } from './ui/boxEditor.js';
import { createPartsLayer, leadFootprint, partFootprint } from './scene/parts.js';
import { detect, MockMissingError, detectionsFileName, serializeDetections, parseDetections, lastOnnxRun, getOnnxDetector } from './vision/detector.js';
import { mapDetections, selectMethod } from './vision/mapping.js';
import { partsTruthError } from './vision/evaluate.js';
import { CLASSES, WORK_AREA, ARM, BINS, MODELS, DETECT } from './config.js';
import { createArm } from './scene/arm.js';
import { createBins } from './scene/bins.js';
import { ikWorld, fkWorld, fkChain, fromBase, pathClear } from './robot/ik.js';
import { plan } from './robot/planner.js';
import { buildSequence, GRIP_MAX } from './robot/sequence.js';
import { createSortPlayer } from './scene/sortPlayer.js';
import { createRun, recordStep, finishRun, summarizeRun, RUN_KINDS } from './timing.js';
import * as THREE from 'three';
import { toThree } from './math/coords.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

const panel = createInfoPanel($('#info-panel'));
createStepper($('#stepper'), store);
const debugView = createDebugView($('#debug-canvas'));
const world = createWorld($('#three-container'));
/* ------------------------------------------------------------------ */
/* 3D 场景：底板                                                        */
/* ------------------------------------------------------------------ */

const board = createBoard();
world.scene.add(board.group);
/** 打印版面（页面坐标，4 px/mm）：没有照片时直接贴；"纯色"板面也用它，按实测纸张位置重新排 */
const DESIGN_PX_PER_MM = 4;
const designRaster = renderBoardToCanvas(buildBoardSVG(), DESIGN_PX_PER_MM);
// 还没有照片时，顶面先贴打印版面
designRaster
  .then((c) => {
    if (!store.state.calib) {
      board.setPaper(c, designFrame());
      world.requestRender();
    }
  })
  .catch((err) => console.error(err));
$('#show-axes').addEventListener('change', (e) => world.setAxesVisible(e.target.checked));
$('#three-reset').addEventListener('click', () => world.setDefaultView());

/* ------------------------------------------------------------------ */
/* 3D 场景：虚拟手机与"照片 → 3D"转场                                     */
/* ------------------------------------------------------------------ */

const phone = createPhone();
world.scene.add(phone.group);
const partsLayer = createPartsLayer({ requestRender: world.requestRender });
world.scene.add(partsLayer.group);
$('#show-part-labels').addEventListener('change', (e) => partsLayer.setLabelsVisible(e.target.checked));
let transitionPending = false; // 有新位姿、还没在 3D 视图里播过转场

const transition = createTransition({
  world,
  container: $('#three-container'),
  overlay: $('#photo-overlay'),
  phone,
  onGrow: (t) => partsLayer.setGrow(t),
  onModeChange: (mode) => {
    $('#btn-compare').setAttribute('aria-pressed', String(mode === 'compare'));
    $('#btn-transition').disabled = mode === 'playing' || !store.state.pose;
    $('#three-reset').disabled = mode !== 'idle';
  },
});

const poseInputs = () => {
  const { image, pose, intrinsics } = store.state;
  return { bitmap: image.bitmap, pose, intrinsics };
};

function playTransition() {
  if (!store.state.pose) return;
  // 一键流程到转场开始为止（场景还没建好时不算）
  if (run?.until === 'transition' && store.state.stage === 'sceneBuilt') endRun();
  transitionPending = false;
  transition.play(poseInputs());
}

$('#btn-transition').addEventListener('click', playTransition);
$('#btn-compare').addEventListener('click', () => {
  if (!store.state.pose) return;
  transition.compare(transition.mode !== 'compare', poseInputs());
});

store.on('stage:posed', (st) => {
  phone.setPose({ pose: st.pose, intrinsics: st.intrinsics, orientation: st.image.exif.orientation });
  stopSorting();
  partsLayer.clear();
  // 全景视角要把手机（光心周围 ±80 mm）也装进画面
  const [X, Y, Z] = st.pose.position;
  const m = 80;
  world.setFocusPoints([[X - m, Y - m, Z - m], [X + m, Y + m, Z + m]], panoramaAzimuth(st.pose.position, [BOARD.width / 2, BOARD.height / 2]));
  phone.setOpacity(1);
  world.requestRender();
  $('#btn-transition').disabled = false;
  $('#btn-compare').disabled = false;
  transitionPending = true;
  // 正在看 3D 视图时直接播放；否则等切换到 3D 视图时播放
  if ($('#view-three').classList.contains('active')) playTransition();
});

/* ------------------------------------------------------------------ */
/* 3D 场景：机械臂、料盒，机械臂调试（点击移动）                           */
/* ------------------------------------------------------------------ */

const arm = createArm({ requestRender: world.requestRender });
world.scene.add(arm.group);
const bins = createBins();
world.scene.add(bins.group);

// 默认视角要装进画面的固定物体：底板四角、料盒外角（含高度）、机械臂底座和初始姿态的关节
{
  const pts = [[0, 0, 0], [BOARD.width, 0, 0], [BOARD.width, BOARD.height, 0], [0, BOARD.height, 0]];
  for (const b of BINS) {
    const [cx, cy] = b.center;
    const [sx, sy, h] = b.size;
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) pts.push([cx + (dx * sx) / 2, cy + (dy * sy) / 2, h]);
  }
  const [bx, by] = ARM.base;
  pts.push([bx - 50, by + 50, 0], [bx + 50, by + 50, 0]);
  const chain = fkChain(arm.homeAngles, ARM);
  for (const k of ['shoulder', 'elbow', 'wrist']) pts.push(fromBase(chain[k], ARM));
  world.setBasePoints(pts);
  world.setDefaultView();
}

/** 调试模式的目标标记：板面上的圆环 + 竖线 + 目标点 */
const armTarget = (() => {
  const g = new THREE.Group();
  g.name = 'arm-target';
  g.visible = false;
  const mat = new THREE.MeshBasicMaterial({ color: '#c96442', depthTest: false, transparent: true });
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 7, 40), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.4;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(2.5, 20, 12), mat);
  dot.position.y = ARM.approach;
  const lineMat = new THREE.LineDashedMaterial({ color: '#c96442', dashSize: 4, gapSize: 3, depthTest: false, transparent: true });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, ARM.approach, 0)]), lineMat);
  line.computeLineDistances();
  for (const o of [ring, dot, line]) o.renderOrder = 20;
  g.add(ring, dot, line);
  world.scene.add(g);
  return {
    show(P, ok) {
      const c = ok ? '#c96442' : '#e5484d';
      mat.color.set(c);
      lineMat.color.set(c);
      g.position.copy(toThree(P[0], P[1], 0));
      g.visible = true;
      world.requestRender();
    },
    hide() {
      g.visible = false;
      world.requestRender();
    },
  };
})();

let armDebug = false;

function setArmDebug(on) {
  armDebug = on;
  $('#btn-arm-debug').setAttribute('aria-pressed', String(on));
  if (on) {
    renderArmSection(null);
  } else {
    armTarget.hide();
    panel.remove('arm');
  }
}
$('#btn-arm-debug').addEventListener('click', () => setArmDebug(!armDebug));

/** 渲染"机械臂"分区；r 为最近一次点击的结果 */
function renderArmSection(r) {
  const body = panel.setCustom('arm', '机械臂调试');
  const d = (x) => `${fmt((x * 180) / Math.PI, 1)}°`;
  let html = '';
  if (!r) {
    html += '<p class="muted small">在 3D 视图里点击底板或桌面，机械臂移动到该点正上方 ' + ARM.approach + ' mm 处。</p>';
  } else if (!r.reachable) {
    html += `<p class="note error">目标 (${fmt(r.target[0])}, ${fmt(r.target[1])}, ${fmt(r.target[2])}) 够不到：${r.reason}</p>`;
  } else {
    const e = r.err;
    html += '<dl class="kv">';
    html += `<dt>目标</dt><dd>${r.target.map((x) => fmt(x, 1)).join(', ')} mm</dd>`;
    html += `<dt>指尖（fk）</dt><dd>${r.tip.map((x) => fmt(x, 3)).join(', ')} mm</dd>`;
    html += `<dt>误差</dt><dd><span class="${e < 0.1 ? 'ok' : 'bad'}">${e < 0.001 ? e.toExponential(1) : fmt(e, 3)} mm</span></dd>`;
    html += `<dt>关节角 θ₀ θ₁ θ₂ θ₃ θ₄</dt><dd>${r.angles.map(d).join(' · ')}</dd>`;
    html += `<dt>夹爪俯仰</dt><dd>${d(r.angles[1] + r.angles[2] + r.angles[3])}（−90° 为竖直向下）</dd>`;
    html += '</dl>';
    if (r.viaHome) html += '<p class="muted small">直接过去途中会碰到自身，先回到初始姿态再过去。</p>';
  }
  html += '<div class="sec-actions"><button type="button" class="btn btn-small" id="btn-arm-home">回到初始姿态</button></div>';
  body.innerHTML = html;
  body.querySelector('#btn-arm-home').addEventListener('click', () => {
    armTarget.hide();
    arm.animateTo(arm.homeAngles).catch(() => {});
  });
}

/** 点击：机械臂移动到点击位置正上方 approach 高度处 */
function armGoto(X, Y) {
  if (sortActive()) return; // 分拣时不响应
  const target = [X, Y, ARM.approach];
  const s = ikWorld(target, ARM);
  armTarget.show(target, s.reachable);
  if (!s.reachable) {
    renderArmSection({ reachable: false, target, reason: s.reason });
    return;
  }
  const tip = fkWorld(s.angles, ARM);
  const err = Math.hypot(tip[0] - X, tip[1] - Y, tip[2] - target[2]);
  // 关节空间直线插值途中会碰到自身时，先回初始姿态再过去
  const cur = arm.angles;
  const viaHome = !pathClear(cur, s.angles, ARM);
  if (viaHome && !(pathClear(cur, arm.homeAngles, ARM) && pathClear(arm.homeAngles, s.angles, ARM))) {
    armTarget.show(target, false);
    renderArmSection({ reachable: false, target, reason: '找不到不碰撞的运动路径' });
    return;
  }
  renderArmSection({ reachable: true, target, tip, err, angles: s.angles, viaHome });
  arm.animatePath(viaHome ? [arm.homeAngles, s.angles] : [s.angles]).catch(() => {});
}

// 区分点击与拖动（拖动是在转视角）
{
  const el = world.renderer.domElement;
  let down = null;
  el.addEventListener('pointerdown', (e) => {
    down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  });
  el.addEventListener('pointerup', (e) => {
    if (!armDebug || !down || transition.mode !== 'idle') return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 6 || !quick) return;
    const P = world.pickPlane(e.clientX, e.clientY, 0);
    if (P) armGoto(P[0], P[1]);
  });
}

/** 3D 底板贴图的分辨率（px/mm），比调试小窗的正射图更清晰 */
const BOARD_TEX_PX_PER_MM = 4;

/**
 * 纸张有一部分在照片外时，正射图那里是透明的（3D 里会显示成黑色）：
 * 用照片内纸张的平均颜色填上。
 */
function fillOutside(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let r = 0, g = 0, b = 0, n = 0, holes = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    if (d[i + 3] === 255) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
  }
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) holes++;
  if (!holes || !n) return canvas;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const octx = out.getContext('2d');
  octx.fillStyle = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0);
  return out;
}

/** 当前底板贴图的原始正射图（未擦除零件）：{ bitmap, canvas, frame, toLocal } */
let boardTex = null;

/** 标定完成后：底板按实测纸张摆放，顶面贴按纸张轮廓生成的正射图 */
function updateBoard3D() {
  const { image, calib } = store.state;
  const frame = calib.paper?.corners ? paperFrame(calib.paper.corners) : designFrame();
  // 纸张局部坐标 → 底板坐标 → 照片像素
  const Hpaper = mul3(calib.H, frameMatrix(frame));
  const canvas = rectify(image.bitmap, Hpaper, BOARD_TEX_PX_PER_MM, { boardW: frame.w, boardH: frame.h });
  // 贴图像素 → 纸张局部坐标（贴图顶部 = 纸张远端）→ 底板坐标
  const texToLocal = [[1 / BOARD_TEX_PX_PER_MM, 0, 0], [0, -1 / BOARD_TEX_PX_PER_MM, frame.h], [0, 0, 1]];
  boardTex = { bitmap: image.bitmap, canvas, frame, toLocal: invert3(Hpaper), toBoard: mul3(frameMatrix(frame), texToLocal), pixels: null };
  refreshBoardTexture();
}

/**
 * 重新生成底板贴图：照片里的零件被压到板面上、沿视线往后偏，会在 3D 模型旁形成重影，
 * 默认按检测框把它们擦掉（勾选"板面原图"时保留）
 */
let skinToken = 0;
function refreshBoardTexture() {
  if (!boardTex) return;
  const { canvas, frame, toLocal } = boardTex;
  const skin = $('#board-skin').value;
  const token = ++skinToken;
  if (skin === 'plain') {
    // 纯色：干净的打印版面（白纸 + 码），按实测纸张位置摆放；照片里的阴影、污渍都不要
    designRaster.then((design) => {
      if (token !== skinToken || boardTex?.frame !== frame) return;
      board.setPaper(plainTexture(design, boardTex), frame);
      world.requestRender();
    });
    return;
  }
  const dets = detResult?.bitmap === boardTex.bitmap ? detResult.detections : [];
  // 每次都在副本上处理，原始正射图保持不变
  const tex = document.createElement('canvas');
  tex.width = canvas.width;
  tex.height = canvas.height;
  const ctx = tex.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  if (dets.length && skin === 'photo') {
    const img = ctx.getImageData(0, 0, tex.width, tex.height);
    const polys = dets.map((d) => boxToTexture(d.box, toLocal, { pxPerMm: BOARD_TEX_PX_PER_MM, paperH: frame.h }));
    // 检测框只框本体：照片里的引脚按模型和估计的朝向推出位置，一并擦掉（朝向没估计出来的不擦）
    const toTex = invert3(boardTex.toBoard);
    const parts = store.state.image?.bitmap === boardTex.bitmap ? store.state.parts ?? [] : [];
    for (const p of parts) {
      const f = leadFootprint(p.cls);
      if (!f || p.yawSource !== 'photo') continue;
      const a = (p.rotDeg * Math.PI) / 180;
      const w = f.halfW + 1; // 留 1 mm 余量
      polys.push([[f.minX - 1, -w], [f.maxX + 1, -w], [f.maxX + 1, w], [f.minX - 1, w]].map(([lx, ly]) => {
        const X = p.x + lx * Math.cos(a) - ly * Math.sin(a);
        const Y = p.y + lx * Math.sin(a) + ly * Math.cos(a);
        return [toTex[0][0] * X + toTex[0][1] * Y + toTex[0][2], toTex[1][0] * X + toTex[1][1] * Y + toTex[1][2]];
      }));
    }
    erasePolygons(img, polys, { featherPx: 1.5 * BOARD_TEX_PX_PER_MM, ringPx: 2 * BOARD_TEX_PX_PER_MM });
    ctx.putImageData(img, 0, 0);
  }
  board.setPaper(fillOutside(tex), frame);
  world.requestRender();
}
$('#board-skin').addEventListener('change', refreshBoardTexture);

/**
 * "纯色"板面贴图：把打印版面（页面坐标）画到纸张局部坐标的贴图上。
 * 打印机会把内容整体印偏，纸张位置按实测（boardTex.frame），码和文字的位置按底板坐标，所以要换算：
 * 版面像素 → 页面 mm → 底板 mm → 纸张局部 mm → 贴图像素（都是仿射，合成一个矩阵交给 canvas）
 */
function plainTexture(design, { frame, toBoard }) {
  const k = BOARD_TEX_PX_PER_MM;
  const tex = document.createElement('canvas');
  tex.width = Math.round(frame.w * k);
  tex.height = Math.round(frame.h * k);
  const ctx = tex.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tex.width, tex.height);
  const designToBoard = [[1 / DESIGN_PX_PER_MM, 0, 0], [0, -1 / DESIGN_PX_PER_MM, BOARD.height], [0, 0, 1]];
  const m = mul3(invert3(toBoard), designToBoard); // 版面像素 → 贴图像素
  ctx.setTransform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);
  ctx.drawImage(design, 0, 0);
  return tex;
}

const tabs = createTabs($('.main'), (view) => {
  if (view === 'three') {
    world.resize();
    if (transitionPending) playTransition();
  } else {
    transition.cancel();
    debugView.resize();
  }
});

const showStatus = () => panel.setRows('status', '状态', [['流程', STAGE_LABELS[store.state.stage]]]);
showStatus();
store.on('change', showStatus);
store.on('error', ({ reason }) => panel.message(reason, 'error'));

/* ------------------------------------------------------------------ */
/* 一键流程：分步耗时                                                    */
/* ------------------------------------------------------------------ */

/** 当前这次运行（选好照片 / 切换内参来源时开始） */
let run = null;
const now = () => performance.now();

/** 开始一次运行。新照片一直跑到转场开始；切换内参来源跑到场景建立 */
function beginRun(kind) {
  run = createRun(kind, now(), { until: kind === 'intrinsics' ? 'scene' : 'transition' });
  renderTimingSection();
}

/** 记一步耗时（运行已结束时忽略） */
function timeStep(key, ms, opts) {
  if (recordStep(run, key, ms, opts)) renderTimingSection();
}

/** 结束当前运行 */
function endRun(opts) {
  if (finishRun(run, now(), opts)) renderTimingSection();
}

function renderTimingSection() {
  if (!run) return;
  const s = summarizeRun(run, now());
  const ms = (x) => `${fmt(x, 0)} ms`;
  let html = `<p class="summary">${RUN_KINDS[run.kind]}：`;
  if (!s.done) html += `进行中… 已用 <b>${fmt(s.total / 1000, 1)} s</b>`;
  else if (run.error) html += `在"${STEPS.find((x) => x.key === run.error)?.label ?? run.error}"一步出错（${fmt(s.total / 1000, 1)} s）`;
  else html += `${run.until === 'scene' ? '到场景建立' : '到转场开始'}共 <b class="${s.total > 5000 ? 'bad' : 'ok'}">${fmt(s.total / 1000, 2)} s</b>`;
  html += '</p><dl class="kv timing">';
  for (const r of s.rows) {
    html += `<dt>${r.label}</dt><dd>${r.cached ? '<span class="muted">沿用</span>' : ms(r.ms)}${r.parallel ? ' <span class="muted">（与检测同时进行）</span>' : ''}</dd>`;
  }
  if (s.done) html += `<dt>其他</dt><dd>${ms(s.other)} <span class="muted">（界面刷新等）</span></dd>`;
  html += '</dl>';
  panel.setCustom('timing', '耗时').innerHTML = html;
}

store.on('error', ({ step }) => endRun({ error: step }));

/* ------------------------------------------------------------------ */
/* 照片读入后：调试视图、信息面板、真值叠加                                 */
/* ------------------------------------------------------------------ */

function updateTruthOverlay() {
  const truth = store.state.truth;
  const on = truth && $('#show-truth').checked;
  debugView.setOverlay('truth', on ? (ctx, s, dpr) => drawTruth(ctx, truth, s, 1.5 * dpr) : null);
}
$('#show-truth').addEventListener('change', updateTruthOverlay);
$('#zoom-in').addEventListener('click', () => debugView.zoomBy(1.5));
$('#zoom-out').addEventListener('click', () => debugView.zoomBy(1 / 1.5));
$('#zoom-reset').addEventListener('click', () => debugView.reset());

/* ------------------------------------------------------------------ */
/* 内参：标定文件、来源切换                                              */
/* ------------------------------------------------------------------ */

/** public/intrinsics.json（步骤 13 生成）；没有时为 null */
let calib = null;
const calibReady = fetch(new URL('intrinsics.json', document.baseURI))
  .then(async (res) => {
    if (!res.ok) return;
    const j = await res.json().catch(() => null); // 开发服务器找不到文件时会返回 HTML
    if (j && ['fx', 'fy', 'cx', 'cy'].every((k) => typeof j[k] === 'number')) calib = j;
  })
  .catch(() => {});

/** 照片的内参提示（缺 EXIF、换了镜头等），随来源变化 */
let intrinsicsNotes = [];

/** 读入照片（上传或示例）后进入 imageLoaded */
/** 由照片估计的焦距（按照片缓存）：{ bitmap, f, sigmaF, reliable } */
let focalEstimate = null;
const selfFocalFor = (image) => (focalEstimate?.bitmap === image.bitmap ? focalEstimate : null);

function setImage(image, truth, source = defaultSource({ image, calib, truth })) {
  const { intrinsics, notes } = computeIntrinsics(source, { image, calib, truth, selfFocal: selfFocalFor(image) });
  intrinsicsNotes = notes;
  store.advance('imageLoaded', { image, intrinsics, truth });
  for (const n of notes) panel.message(n.text, n.level);
}

/** 渲染"照片"和"内参"分区（估计出焦距后也会刷新） */
function renderImagePanelNow() {
  const { image, intrinsics, truth } = store.state;
  renderImagePanel(panel, {
    image,
    intrinsics,
    truth,
    notes: intrinsicsNotes,
    calibAvailable: !!calib,
    selfFocal: selfFocalFor(image),
    // 切换来源：重新计算内参，从这一步重跑（后续结果清空）
    onSourceChange: (source) => {
      beginRun('intrinsics');
      setImage(store.state.image, store.state.truth, source);
    },
  });
}

store.on('stage:imageLoaded', (st) => {
  const { image, intrinsics, truth } = st;
  debugView.setImage(image.bitmap);
  $('#truth-toggle').hidden = !truth;
  updateTruthOverlay();
  debugView.setOverlay('pose', null);
  $('#pose-toggle').hidden = true;
  transition.cancel();
  phone.clear();
  world.setFocusPoints(null);
  transitionPending = false;
  $('#btn-transition').disabled = true;
  $('#btn-compare').disabled = true;
  panel.remove('pose');
  stopSorting();
  panel.remove('sort');
  partsLayer.clear();
  if (detResult?.bitmap !== image.bitmap) resetDetections();
  if (markerResult?.bitmap !== image.bitmap) {
    debugView.setOverlay('markers', null);
    $('#markers-toggle').hidden = true;
    showRectified(null);
  }
  tabs.select('debug');

  renderImagePanelNow();
  if (truth) {
    const [X, Y, Z] = truth.position;
    panel.setRows('truth', '真值', [
      ['手机位置', `${fmt(X)}, ${fmt(Y)}, ${fmt(Z)} mm`],
      ['离桌面高度', `${fmt(Z / 10, 1)} cm`],
      ['俯角', `${fmt(truth.pitchDeg, 1)}°`],
      ['码 / 零件', `${truth.markers.length} / ${truth.parts.length}`],
    ]);
  } else {
    panel.remove('truth');
  }
  runCalibration().catch((err) => {
    console.error(err);
    store.fail('calib', `标定出错：${err.message}`);
  });
});

/* ------------------------------------------------------------------ */
/* 模块 2：识别 ArUco 码 → 单应性 → 正射图                               */
/* ------------------------------------------------------------------ */

const RECT_PX_PER_MM = 2;

/** 当前照片的识别结果缓存（换内参来源时不必重新识别） */
let markerResult = null; // { bitmap, markers, ms, calib, hom }

function updateMarkerOverlay() {
  const on = markerResult && $('#show-markers').checked;
  const markers = markerResult?.markers ?? [];
  debugView.setOverlay('markers', on ? (ctx, s, dpr) => drawMarkers(ctx, markers, s, dpr) : null);
}
$('#show-markers').addEventListener('change', updateMarkerOverlay);

/** 正射图小窗：画正射图，并用虚线画出设计的码位置（页面坐标 = 正射图坐标） */
function showRectified(canvas) {
  const inset = $('#rect-inset');
  $('#rect-toggle').hidden = !canvas;
  inset.hidden = !canvas || !$('#show-rect').checked;
  if (!canvas) return;
  const c = $('#rect-canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#c96442';
  for (const id of VALID_IDS) {
    const r = markerRectOnPage(id);
    ctx.strokeRect(r.x * RECT_PX_PER_MM, r.y * RECT_PX_PER_MM, r.size * RECT_PX_PER_MM, r.size * RECT_PX_PER_MM);
  }
}
$('#show-rect').addEventListener('change', () => showRectified(store.state.calib?.rectified ?? null));
$('#rect-inset').addEventListener('click', () => $('#rect-inset').classList.toggle('big'));

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 渲染"标定"分区 */
function renderCalibSection() {
  const { truth } = store.state;
  const { markers, ms, hom } = markerResult;
  const found = markers.map((m) => m.id);
  const missing = VALID_IDS.filter((id) => !found.includes(id));
  const rows = [
    ['识别到', found.length ? `ID ${found.join('、')}` : '无'],
    ['识别耗时', `${ms.toFixed(0)} ms`],
  ];
  if (hom) {
    const cls = hom.reprojErrPx > 3 ? 'bad' : hom.reprojErrPx > 1.5 ? '' : 'ok';
    rows.push(['重投影误差', `<span class="${cls}">${fmt(hom.reprojErrPx, 2)} px</span>`]);
  }
  if (truth) {
    const err = markerCornerErrors(markers, truth.markers);
    if (err.mean != null) {
      rows.push(['角点 vs 真值', `<span class="${err.mean < 3 ? 'ok' : 'bad'}">平均 ${fmt(err.mean, 2)} · 最大 ${fmt(err.max, 2)} px</span>`]);
    }
    if (hom) {
      const e = homographyTruthError(hom.H, truth, { boardW: BOARD.width, boardH: BOARD.height });
      rows.push(['单应性 vs 真值', `<span class="${e.max < 3 ? 'ok' : 'bad'}">平均 ${fmt(e.mean, 2)} · 最大 ${fmt(e.max, 2)} px</span>`]);
    }
  }
  const paper = markerResult.calib?.paper;
  const paperNotes = [];
  if (paper) {
    const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
    if (paper.widthMm != null || paper.heightMm != null) {
      rows.push(['纸张实测', `${fmt(paper.widthMm, 1)} × ${fmt(paper.heightMm, 1)} mm`]);
      const dev = Math.max(...[paper.scaleX, paper.scaleY].filter((x) => x != null).map((x) => Math.abs(x - 1)));
      rows.push(['打印比例', `<span class="${dev > CHECK_LIMITS.warnScale ? 'bad' : dev > CHECK_LIMITS.okScale ? '' : 'ok'}">${pct(paper.scaleX)} × ${pct(paper.scaleY)}</span>`]);
      if (dev > CHECK_LIMITS.warnScale) {
        const sc = [paper.scaleX, paper.scaleY].filter((x) => x != null);
        const avg = sc.reduce((a, b) => a + b, 0) / sc.length;
        paperNotes.push(`打印比例约 ${(avg * 100).toFixed(1)}%：码的实际边长约 ${(MARKERS.size * avg).toFixed(1)} mm，而系统按 ${MARKERS.size} mm 计算，手机高度和零件位置会偏差约 ${Math.abs(100 - avg * 100).toFixed(0)}%。请按 100% 实际尺寸重新打印。`);
      }
    }
    if (paper.corners) {
      // 打印偏移 = 纸张中心相对设计中心的偏移（与打印比例无关）
      const { left, right, bottom, top } = paper.edges;
      const dx = (right - left) / 2;
      const dy = (top - bottom) / 2;
      const sgn = (v) => `${v >= 0 ? '+' : ''}${fmt(v, 1)}`;
      rows.push(['纸张相对码的偏移', `X ${sgn(dx)} · Y ${sgn(dy)} mm`]);
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) {
        paperNotes.push(`打印内容在纸上偏了约 ${fmt(Math.hypot(dx, dy), 1)} mm（打印机进纸偏差，常见）。坐标以码为准，底板外框按实测纸边显示。`);
      }
    } else {
      const bad = Object.keys(paper.edges).filter((k) => paper.edges[k] == null);
      paperNotes.push(`没测出纸边（${bad.map((k) => `${EDGE_NAMES[k]}${paper.reasons[k] === 'outside' ? '离照片边缘太近' : '与背景对比不够'}`).join('；')}），底板外框按设计尺寸显示。`);
    }
  }
  let html = '<dl class="kv">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  for (const n of paperNotes) html += `<p class="note ${/重新打印/.test(n) ? 'warn' : 'info'}">${n}</p>`;
  if (missing.length) {
    html += `<p class="note warn">缺少 ID：${missing.join('、')}。请确认整张标定板都在画面里、码没有被遮挡或反光。</p>`;
  }
  for (const w of hom?.warnings ?? []) html += `<p class="note warn">${w}</p>`;
  html += '<div class="sec-actions"><button type="button" class="btn btn-small" id="btn-redetect">重新识别</button></div>';
  const body = panel.setCustom('markers', '标定');
  body.innerHTML = html;
  body.querySelector('#btn-redetect').addEventListener('click', () => runCalibration({ force: true }));
}

/** 识别码、求单应性、生成正射图，写入 state.calib；同一张照片只算一次，force 时重跑 */
async function runCalibration({ force = false } = {}) {
  const { image } = store.state;
  if (!image) return;
  const cached = !force && markerResult?.bitmap === image.bitmap;
  if (!cached) {
    const body = panel.setCustom('markers', '标定');
    body.innerHTML = '<p class="muted">识别中…</p>';
    showRectified(null);
    await nextFrame();
    const t0 = performance.now();
    const det = detectMarkersInImage(image.bitmap, 1600);
    const { markers } = det;
    const ms = performance.now() - t0;
    timeStep('markers', ms);
    const t1 = now();
    let hom = null;
    let calib = null;
    if (markers.length) {
      hom = boardHomography(markers, markerCornersWorld);
      const rectified = rectify(image.bitmap, hom.H, RECT_PX_PER_MM, { boardW: BOARD.width, boardH: BOARD.height });
      // 在缩小图上测纸边：H 换到缩小图像素
      const k = det.scale;
      const Hs = [hom.H[0].map((x) => x * k), hom.H[1].map((x) => x * k), hom.H[2]];
      const m = measurePaper(det.imageData, Hs);
      const paper = { corners: m.corners, edges: m.edges, reasons: m.reasons, widthMm: m.widthMm, heightMm: m.heightMm, scaleX: m.scaleX, scaleY: m.scaleY };
      calib = { markers, H: hom.H, Hinv: hom.Hinv, reprojErrPx: hom.reprojErrPx, rectified, paper };
    }
    // 缩小图（长边 1600）留着给颜色分割用，不必再读一遍全尺寸照片
    markerResult = { bitmap: image.bitmap, markers, ms, hom, calib, small: { imageData: det.imageData, scale: det.scale } };
    if (calib) timeStep('homography', now() - t1);
  } else {
    timeStep('markers', 0, { cached: true });
    timeStep('homography', 0, { cached: true });
  }
  $('#markers-toggle').hidden = false;
  updateMarkerOverlay();
  renderCalibSection();

  const { markers, ms, hom, calib } = markerResult;
  if (!calib) {
    showRectified(null);
    store.fail('calib', '没有识别到任何码。请确认整张标定板都在画面里、光线均匀、对焦清晰。');
    return;
  }
  // 照片已换掉时不再写入
  if (store.state.image?.bitmap !== markerResult.bitmap) return;
  store.advance('calibrated', { calib });
  for (const w of hom.warnings) panel.message(w, 'warn');
  panel.message(`标定完成：${markers.length} 个码，重投影误差 ${fmt(hom.reprojErrPx, 2)} px（识别 ${ms.toFixed(0)} ms）`, 'ok');
}

store.on('stage:calibrated', (st) => showRectified(st.calib.rectified));
store.on('stage:calibrated', () => {
  try {
    const t0 = now();
    updateBoard3D();
    timeStep('board', now() - t0);
  } catch (err) {
    console.error(err);
  }
});

/* ------------------------------------------------------------------ */
/* 模块 3：手机位姿                                                     */
/* ------------------------------------------------------------------ */

function updatePoseOverlay() {
  const { pose, intrinsics } = store.state;
  const on = pose && $('#show-pose').checked;
  const K = pose ? intrinsicsMatrix(intrinsics) : null;
  const paper = store.state.calib?.paper?.corners ?? null;
  debugView.setOverlay('pose', on ? (ctx, s, dpr) => drawPose(ctx, K, pose, s, dpr, paper) : null);
}
$('#show-pose').addEventListener('change', updatePoseOverlay);

/** 由 H 和 K 反推位姿，写入 state.pose */
function runPose() {
  const t0 = now();
  const { calib, intrinsics, truth } = store.state;
  const world = calib.markers.flatMap((m) => markerCornersWorld(m.id));
  const image = calib.markers.flatMap((m) => m.corners);
  const K = intrinsicsMatrix(intrinsics);
  const pose0 = poseFromHomography(K, calib.H, world, image, { refine: false }); // 第 1–7 步的解析解
  const pose = poseFromHomography(K, calib.H, world, image);
  if (!(pose.heightMm > 0)) {
    store.fail('pose', '求出的手机位置在桌面以下，位姿无效。请检查内参或重新拍照。');
    return;
  }
  // 位姿求出后检测、映射会接着同步开始，所以在这里记耗时
  timeStep('pose', now() - t0);
  store.advance('posed', { pose });

  const rows = [
    ['离桌面高度', `${fmt(pose.heightMm / 10, 1)} cm`],
    ['俯角', `${fmt(pose.pitchDeg, 1)}°`],
    ['重投影误差', `<span class="${pose.reprojErrPx > 3 ? 'bad' : pose.reprojErrPx > 1.5 ? '' : 'ok'}">${fmt(pose.reprojErrPx, 2)} px</span> <span class="muted">（解析解 ${fmt(pose0.reprojErrPx, 2)}，单应性 ${fmt(calib.reprojErrPx, 2)}）</span>`],
    ['手机位置 (X, Y, Z)', `${pose.position.map((x) => fmt(x, 0)).join(', ')} mm`],
  ];
  if (truth) {
    const e = poseTruthError(pose, truth);
    const ok = e.posErrMm < 5 && Math.abs(e.pitchErrDeg) < 0.5;
    rows.push(['位置 vs 真值', `<span class="${ok ? 'ok' : 'bad'}">${fmt(e.posErrMm, 2)} mm（高度 ${e.heightErrMm >= 0 ? '+' : ''}${fmt(e.heightErrMm, 2)}）</span>`]);
    rows.push(['角度 vs 真值', `<span class="${ok ? 'ok' : 'bad'}">俯角 ${e.pitchErrDeg >= 0 ? '+' : ''}${fmt(e.pitchErrDeg, 3)}° · 姿态 ${fmt(e.angleErrDeg, 3)}°</span>`]);
  }
  let html = `<p class="summary">手机离桌面 <b>${fmt(pose.heightMm / 10, 1)} cm</b>，俯角 <b>${fmt(pose.pitchDeg, 1)}°</b>，重投影误差 <b>${fmt(pose.reprojErrPx, 2)}</b> 像素</p>`;
  html += '<dl class="kv">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  if (calib.reprojErrPx < 1.5 && pose.reprojErrPx > 3 * calib.reprojErrPx + 1) {
    html += '<p class="note warn">位姿的重投影误差明显大于单应性的，内参可能不准（例如等效焦距不对）。可以试试切换内参来源。</p>';
  }
  // 由这张照片估计焦距（用"照片估计"作为来源时沿用已有结果，不再重算）
  const photo = store.state.image;
  if (!selfFocalFor(photo)) {
    const est = estimateFocal(intrinsics, pose.R, pose.t, world, image);
    focalEstimate = { bitmap: photo.bitmap, f: est.f, sigmaF: est.sigmaF, reliable: est.reliable };
    renderImagePanelNow();
  }
  const fe = selfFocalFor(photo);
  let focalAction = false;
  if (fe.reliable) {
    const diff = fe.f / intrinsics.fx - 1;
    const sig = fe.sigmaF / fe.f;
    html += `<dl class="kv"><dt>按照片估计焦距</dt><dd>${fmt(fe.f, 0)} ± ${fmt(fe.sigmaF, 0)}（比当前 ${diff >= 0 ? '+' : ''}${fmt(diff * 100, 1)}%）</dd></dl>`;
    if (intrinsics.source !== 'self' && Math.abs(diff) > Math.max(0.003, 2 * sig)) {
      html += `<p class="note warn">这张照片是斜拍的，能从照片本身估计焦距：比当前内参${diff > 0 ? '大' : '小'} ${fmt(Math.abs(diff) * 100, 1)}%。斜拍时焦距不准会让上面的框线错开、高度也按比例偏差。</p>`;
      focalAction = true;
    }
  } else if (pose.pitchDeg < 80) {
    html += '<p class="note info">这张照片无法可靠地估计焦距（码的透视不够明显）。</p>';
  }
  if (intrinsics.source === 'exif' && pose.pitchDeg > 75) {
    html += '<p class="note info">接近正上方拍摄时，焦距的误差几乎不会让上面的框线错开，但会按比例影响高度（焦距差 1%，高度约差 1%）。EXIF 只给出取整的等效焦距，要让高度更准需要棋盘格标定（步骤 13）。</p>';
  }
  if (focalAction) html += '<div class="sec-actions"><button type="button" class="btn btn-small" id="btn-use-focal">改用估计的焦距</button></div>';
  const poseBody = panel.setCustom('pose', '位姿');
  poseBody.innerHTML = html;
  poseBody.querySelector('#btn-use-focal')?.addEventListener('click', () => {
    beginRun('intrinsics');
    setImage(store.state.image, store.state.truth, 'self');
  });
  panel.message(`位姿：离桌面 ${fmt(pose.heightMm / 10, 1)} cm，俯角 ${fmt(pose.pitchDeg, 1)}°`, 'ok');
}

store.on('stage:calibrated', () => {
  try {
    runPose();
  } catch (err) {
    console.error(err);
    store.fail('pose', `位姿计算出错：${err.message}`);
  }
});
store.on('stage:posed', () => {
  $('#pose-toggle').hidden = false;
  updatePoseOverlay();
});

/* ------------------------------------------------------------------ */
/* 模块 4：零件检测（mock）、手动框选、坐标映射、3D 零件                    */
/* ------------------------------------------------------------------ */

const DET_SOURCE_LABELS = { truth: '合成图真值框', mock: 'mock 检测文件', onnx: '模型推理（ONNX）', manual: '手动框选', file: '载入的检测文件', none: '无' };

/** 检测设置：mode 为 null 时自动选（合成图用真值框，其他照片用模型推理） */
const detSettings = { mode: null, model: 'parts', prefer: 'auto', colorAssist: true };

/**
 * 颜色分割（在标定时的缩小图上做），返回原图像素上的候选框
 * @returns {{ parts: {cls:number, box:number[]}[], ms: number }|null}
 */
function colorCandidates() {
  const { calib, image } = store.state;
  const small = markerResult?.bitmap === image?.bitmap ? markerResult.small : null;
  if (!calib || !small) return null;
  const t0 = performance.now();
  const k = small.scale;
  const Hs = [calib.H[0].map((x) => x * k), calib.H[1].map((x) => x * k), calib.H[2]];
  // 板中心附近 1 mm 对应的像素数
  const p = (X, Y) => {
    const w = Hs[2][0] * X + Hs[2][1] * Y + Hs[2][2];
    return [(Hs[0][0] * X + Hs[0][1] * Y + Hs[0][2]) / w, (Hs[1][0] * X + Hs[1][1] * Y + Hs[1][2]) / w];
  };
  const a = p(BOARD.width / 2 - 5, BOARD.height / 2);
  const b = p(BOARD.width / 2 + 5, BOARD.height / 2);
  const pxPerMm = Math.hypot(b[0] - a[0], b[1] - a[1]) / 10;
  const parts = segmentParts(small.imageData, invert3(Hs), pxPerMm).map((c) => ({ ...c, box: c.box.map((v) => v / k) }));
  return { parts, ms: performance.now() - t0 };
}
const detMode = () => detSettings.mode ?? (store.state.truth ? 'mock' : 'onnx');

/** 当前照片的检测结果（换内参来源时沿用，手动框选的修改也存在这里） */
let detResult = null; // { bitmap, detections, source, note }
let parallaxOn = true;
let boxEditing = false;

const boxEditor = createBoxEditor({
  getScale: () => debugView.view.s,
  redraw: () => debugView.redraw(),
  imageSize: () => store.state.image,
  onChange: (boxes) => {
    if (!detResult) return;
    detResult = { ...detResult, detections: boxes, source: 'manual', note: null };
    applyDetections();
  },
  onSelect: (i) => {
    $('#box-delete').disabled = i < 0;
    $('#box-class').value = String(boxEditor.cls);
  },
});
for (const c of CLASSES) $('#box-class').add(new Option(c.name, String(c.id)));
$('#box-class').addEventListener('change', (e) => boxEditor.setClass(Number(e.target.value)));
$('#box-delete').addEventListener('click', () => boxEditor.deleteSelected());
$('#box-clear').addEventListener('click', () => boxEditor.clear());
$('#box-done').addEventListener('click', () => setBoxEditing(false));
$('#btn-boxedit').addEventListener('click', () => setBoxEditing(!boxEditing));
$('#show-dets').addEventListener('change', updateDetOverlay);
window.addEventListener('keydown', (e) => {
  if (!boxEditing || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    boxEditor.deleteSelected();
  } else if (e.key === 'Escape') {
    boxEditor.setBoxes(boxEditor.getBoxes());
  }
});

function updateDetOverlay() {
  const on = detResult && (boxEditing || $('#show-dets').checked);
  debugView.setOverlay('dets', on ? (ctx, s, dpr) => boxEditor.draw(ctx, s, dpr) : null);
}

function setBoxEditing(on) {
  if (on && !detResult) return;
  boxEditing = on;
  $('#btn-boxedit').setAttribute('aria-pressed', String(on));
  $('#box-tools').hidden = !on;
  debugView.setTool(on ? boxEditor.tool : null);
  if (on) {
    tabs.select('debug');
    $('#box-class').value = String(boxEditor.cls);
  } else {
    boxEditor.setBoxes(boxEditor.getBoxes()); // 取消选中
  }
  updateDetOverlay();
}

/** 换照片：清空检测结果与框选 */
function resetDetections() {
  detResult = null;
  setBoxEditing(false);
  boxEditor.setBoxes([]);
  $('#dets-toggle').hidden = true;
  $('#btn-boxedit').disabled = true;
  panel.remove('detect');
  updateDetOverlay();
}

/** 位姿求出后：检测（同一张照片沿用已有结果，force 时重跑），再映射 */
async function runDetect({ force = false } = {}) {
  const { image, truth } = store.state;
  if (!force && detResult?.bitmap === image.bitmap) {
    timeStep('detect', 0, { cached: true });
  } else {
    const mode = detMode();
    let detections = [];
    let source = mode === 'onnx' ? 'onnx' : truth ? 'truth' : 'mock';
    let note = null;
    let onnx = null;
    if (mode === 'onnx') {
      // 推理期间先显示"检测中"
      detResult = { bitmap: image.bitmap, detections: [], source, note: null, pending: true };
      renderDetectSection(null);
    }
    try {
      if (mode === 'onnx') {
        // 模型一般在页面打开后已预先加载好；没加载完时在这里等
        const t0 = now();
        await getOnnxDetector(detSettings.model, { prefer: detSettings.prefer }).init();
        timeStep('model', now() - t0);
      }
      // 颜色分割补漏（只对零件模型）：推理在 Worker 里进行，照片交给 Worker 后主线程空着，这段时间做颜色分割
      const wantColor = mode === 'onnx' && detSettings.colorAssist && detSettings.model === 'parts';
      let colorDone = null;
      const color = new Promise((resolve) => {
        colorDone = resolve;
      });
      const onPosted = wantColor ? () => setTimeout(() => colorDone(colorCandidates()), 0) : null;
      const t1 = now();
      detections = await detect(image, { mode, truth, model: detSettings.model, prefer: detSettings.prefer, onPosted });
      timeStep('detect', now() - t1);
      if (mode === 'onnx') {
        onnx = lastOnnxRun;
        // YOLO 没框到、颜色分割找到的零件补上
        if (wantColor) {
          const c = await color;
          if (c) {
            const fused = fuseDetections(detections, c.parts, { names: (cls) => CLASSES[cls].name });
            detections = fused.dets;
            onnx = { ...onnx, color: { candidates: c.parts.length, added: fused.added, ms: c.ms } };
            timeStep('color', c.ms, { parallel: true });
          }
        }
      }
    } catch (err) {
      if (err instanceof MockMissingError) {
        note = `没有找到 mock 检测文件 ${detectionsFileName(image.fileName)}。可以点"框选"在照片上手动框出零件，保存后下次用"载入"读回。`;
      } else if (mode === 'onnx') {
        console.error(err);
        note = `模型推理失败：${err.message}。可以改用 mock，或点"框选"手动框出零件。`;
        panel.message(note, 'error');
      } else {
        throw err;
      }
      source = 'none';
    }
    if (store.state.image?.bitmap !== image.bitmap) return; // 等待期间换了照片
    detResult = { bitmap: image.bitmap, detections, source, note, onnx };
    boxEditor.setBoxes(detections);
    if (onnx) {
      const t = onnx;
      panel.message(`推理完成（${t.info.backend === 'webgpu' ? 'WebGPU' : 'WASM'}）：${t.raw.length} 个框，同类去重后 ${t.dets.length} 个，推理 ${t.inferMs.toFixed(0)} ms${t.color ? `；颜色分割补上 ${t.color.added} 个` : ''}`, 'ok');
    }
  }
  $('#dets-toggle').hidden = false;
  $('#btn-boxedit').disabled = false;
  updateDetOverlay();
  if (detResult.source === 'none') {
    // 检测失败：清掉上一次的零件，回到"位姿已求出"，步骤条"检测"变红；可以点"框选"手动框出零件，框好后接着往下走
    stopSorting();
    partsLayer.clear();
    sortPlan = null;
    sortPlayer.load([]);
    panel.remove('sort');
    if (stageIndex(store.state.stage) > stageIndex('posed')) store.rollback('posed');
    refreshBoardTexture();
    renderDetectSection(null);
    store.fail('detect', detResult.note);
    return;
  }
  applyDetections();
}

/** 检测框 → 零件（两种方法都算），写入 state，重建 3D 零件 */
function applyDetections() {
  const { pose, calib, intrinsics, image } = store.state;
  if (!detResult || !pose || image?.bitmap !== detResult.bitmap) {
    renderDetectSection(null);
    return;
  }
  const t0 = now();
  const K = intrinsicsMatrix(intrinsics);
  const mapped = mapDetections(detResult.detections, { Hinv: calib.Hinv, K, R: pose.R, position: pose.position }, { parallax: parallaxOn });
  const { dropped } = mapped;
  const parts = refineYaw(mapped.parts);
  timeStep('map', now() - t0);
  const t1 = now();
  stopSorting();
  store.advance('detected', { detections: detResult.detections, parts });
  partsLayer.setParts(parts, parallaxOn);
  refreshBoardTexture();
  store.advance('sceneBuilt');
  renderDetectSection({ parts, dropped });
  refreshPlan();
  timeStep('scene', now() - t1);
  // 一键流程：新照片建好场景后切到 3D 视图播放转场（playTransition 里结束计时）；切换内参来源到这里结束
  if (run && run.end == null) {
    if (run.until === 'scene') endRun();
    else tabs.select('three');
  }
}

/** 估计朝向时检测框向外扩的距离（mm）：把电阻、LED 的一段引脚也纳入 */
const YAW_SEARCH_MM = 10;

/**
 * 用照片估计电阻、LED 的朝向（检测框是轴对齐的，看不出角度）：
 * 在底板正射图上取检测框对应的区域分出零件像素，按形状求角度；估计不可靠时沿用 mapping 的 0° / 90° 粗判
 */
function refineYaw(parts) {
  if (!boardTex || boardTex.bitmap !== store.state.image?.bitmap) return parts;
  if (!boardTex.pixels) {
    const ctx = boardTex.canvas.getContext('2d');
    boardTex.pixels = ctx.getImageData(0, 0, boardTex.canvas.width, boardTex.canvas.height);
  }
  const tex = { pxPerMm: BOARD_TEX_PX_PER_MM, paperH: boardTex.frame.h };
  return parts.map((p) => {
    const det = detResult.detections[p.detIndex];
    // 检测框只框本体：外扩 YAW_SEARCH_MM 把一段引脚也纳入，只保留与框内零件相连的像素
    const seed = boxToTexture(det.box, boardTex.toLocal, tex, 0.05);
    const est = estimateYaw(boardTex.pixels, expandPoly(seed, YAW_SEARCH_MM * BOARD_TEX_PX_PER_MM), p.cls, boardTex.toBoard, { seed });
    return est?.reliable ? { ...p, rotDeg: est.rotDeg, yawSource: 'photo' } : p;
  });
}

function setParallax(on) {
  parallaxOn = on;
  // 分拣进行中或已经动过零件：先复原，再切换
  if (stopSorting()) partsLayer.setParts(store.state.parts, !on);
  if (store.state.parts) store.state.parts = selectMethod(store.state.parts, on);
  partsLayer.animateMethod(on);
  renderDetectSection(lastMapping);
  if (store.state.parts) refreshPlan();
}

let lastMapping = null;

/** 渲染"检测"分区 */
function renderDetectSection(mapping) {
  lastMapping = mapping;
  if (!detResult) return;
  const { truth } = store.state;
  const body = panel.setCustom('detect', '检测与映射');
  const dets = detResult.detections;
  let html = renderDetControls();
  if (detResult.pending) {
    html += '<p class="muted">模型推理中…（第一次要下载模型，约 10 MB）</p>';
  } else if (detResult.source === 'none') {
    html += `<p class="note error">${detResult.note}</p>`;
  } else if (!mapping) {
    html += `<p class="summary">${dets.length} 个检测框</p><p class="note info">需要先求出位姿，才能把检测框映射到底板坐标。</p>`;
  } else {
    const { parts, dropped } = mapping;
    html += `<p class="summary">检测到 <b>${parts.length}</b> 个零件<span class="muted">（来源：${DET_SOURCE_LABELS[detResult.source]}）</span></p>`;
    const oriented = parts; // 电阻、LED 都是长条零件，都要估计朝向
    const fromPhoto = oriented.filter((p) => p.yawSource === 'photo').length;
    const counts = CLASSES.map((c) => [c.name, parts.filter((p) => p.cls === c.id).length]).filter(([, n]) => n);
    if (counts.length) html += '<dl class="kv">' + counts.map(([k, n]) => `<dt>${k}</dt><dd>${n}</dd>`).join('') + '</dl>';
    if (oriented.length) {
      html += `<p class="muted small">朝向：${fromPhoto} / ${oriented.length} 个电阻、LED 按照片估计${fromPhoto < oriented.length ? '，其余看不清，按检测框粗判 0° / 90°' : ''}。</p>`;
    }
    html += `<label class="check toggle-row"><input type="checkbox" id="parallax-toggle"${parallaxOn ? ' checked' : ''} /> 视差修正</label>`;
    html += '<p class="muted small">零件有高度，斜拍时检测框中心对应零件半高处；修正后按半高求交，不修正则直接落到板面。</p>';
    if (truth && parts.length) {
      const e = partsTruthError(parts, truth);
      const cell = (st, on) => (st ? `<span class="${st.mean < 3 ? 'ok' : 'bad'}">平均 ${fmt(st.mean, 2)} · 最大 ${fmt(st.max, 2)} mm</span>${on ? ' ◀' : ''}` : '—');
      html += '<dl class="kv">';
      html += `<dt>不修正 vs 真值</dt><dd>${cell(e.plane, !parallaxOn)}</dd>`;
      html += `<dt>视差修正 vs 真值</dt><dd>${cell(e.parallax, parallaxOn)}</dd>`;
      if (e.yaw) html += `<dt>朝向 vs 真值</dt><dd><span class="${e.yaw.max < 10 ? 'ok' : 'bad'}">平均 ${fmt(e.yaw.mean, 1)}° · 最大 ${fmt(e.yaw.max, 1)}°</span> <span class="muted">（${e.yaw.n} 个）</span></dd>`;
      html += '</dl>';
      if (e.unmatchedParts || e.missedTruth) {
        html += `<p class="note info">${e.unmatchedParts} 个零件没有对应的真值，${e.missedTruth} 个真值零件没有被检测到（只统计配对上的）。</p>`;
      }
    }
    if (dropped.length) {
      html += `<p class="note warn">${dropped.length} 个检测框映射后落在工作区外（板边 ${WORK_AREA.margin} mm 以内或码附近），已丢弃。</p>`;
    }
  }
  if (detResult.note) html += `<p class="note info">${detResult.note}</p>`;
  html += `<div class="sec-actions">
    <button type="button" class="btn btn-small" id="btn-det-edit">${boxEditing ? '结束框选' : '框选'}</button>
    <button type="button" class="btn btn-small" id="btn-det-save"${dets.length ? '' : ' disabled'}>保存检测结果</button>
    <button type="button" class="btn btn-small" id="btn-det-load">载入检测结果</button>
    <input type="file" id="det-file" accept=".json,application/json" hidden />
  </div>`;
  body.innerHTML = html;
  bindDetControls(body);
  body.querySelector('#parallax-toggle')?.addEventListener('change', (e) => setParallax(e.target.checked));
  body.querySelector('#btn-det-edit').addEventListener('click', () => {
    setBoxEditing(!boxEditing);
    renderDetectSection(lastMapping);
  });
  body.querySelector('#btn-det-save').addEventListener('click', saveDetections);
  const fileInput = body.querySelector('#det-file');
  body.querySelector('#btn-det-load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadDetectionsFile(f);
  });
}

/** 检测方式 / 模型 / 后端选择，以及最近一次推理的统计 */
function renderDetControls() {
  const mode = detMode();
  const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
  let html = '<div class="det-controls">';
  html += `<label>检测方式 <select class="select" id="det-mode">${opt('onnx', '模型推理（ONNX）', mode)}${opt('mock', 'mock（真值 / 检测文件）', mode)}</select></label>`;
  if (mode === 'onnx') {
    html += `<label>模型 <select class="select" id="det-model">${Object.entries(MODELS).map(([k, m]) => opt(k, m.label, detSettings.model)).join('')}</select></label>`;
    html += `<label>后端 <select class="select" id="det-prefer">${opt('auto', '自动（优先 WebGPU）', detSettings.prefer)}${opt('wasm', '仅 WASM', detSettings.prefer)}</select></label>`;
    html += `<label title="按颜色（红色 LED、蓝色电阻）找零件，YOLO 没框到的补上，虚线框表示"><input type="checkbox" id="det-color"${detSettings.colorAssist ? ' checked' : ''} /> 颜色分割补漏</label>`;
  }
  html += `<button type="button" class="btn btn-small" id="btn-det-rerun"${detResult?.pending ? ' disabled' : ''}>重新检测</button></div>`;
  const t = detResult?.onnx;
  if (t && !detResult.pending) {
    const i = t.info;
    const backend = i.backend === 'webgpu' ? 'WebGPU' : `WASM（${i.threads > 1 ? `${i.threads} 线程` : '单线程'}）`;
    html += '<dl class="kv">';
    html += `<dt>模型</dt><dd>${MODELS[t.model].label} · ${(i.modelBytes / 1e6).toFixed(1)} MB · 输入 ${i.inputSize}</dd>`;
    html += `<dt>推理后端</dt><dd>${backend}</dd>`;
    html += `<dt>模型加载</dt><dd>${fmt(i.loadMs, 0)} ms <span class="muted">（下载 ${fmt(i.fetchMs, 0)} + 初始化 ${fmt(i.createMs, 0)}）</span></dd>`;
    html += `<dt>推理耗时</dt><dd>${fmt(t.prepMs + t.inferMs + t.postMs, 0)} ms <span class="muted">（前处理 ${fmt(t.prepMs, 0)} + 推理 ${fmt(t.inferMs, 0)} + 后处理 ${fmt(t.postMs, 0)}）</span></dd>`;
    html += `<dt>检测数量</dt><dd>${t.raw.length} 个 → 同类去重后 ${t.dets.length} 个 <span class="muted">（置信度 ≥ ${DETECT.scoreThreshold}，IoU > ${DETECT.dedupIou} 视为重复）</span></dd>`;
    if (t.color) {
      html += `<dt>颜色分割</dt><dd>${t.color.candidates} 个候选，补上 <b>${t.color.added}</b> 个 YOLO 漏掉的 <span class="muted">（${fmt(t.color.ms, 0)} ms，虚线框）</span></dd>`;
    }
    html += '</dl>';
    if (t.model !== 'parts') {
      const names = {};
      for (const d of t.dets) names[d.name] = (names[d.name] ?? 0) + 1;
      html += `<p class="note info">COCO 模型的类别不是零件，只在调试视图里显示检测框：${Object.entries(names).map(([k, n]) => `${k} × ${n}`).join('，') || '没有检测到物体'}。</p>`;
    }
  }
  return html;
}

function bindDetControls(body) {
  const rerun = () => runDetect({ force: true }).catch((err) => store.fail('detect', `检测出错：${err.message}`));
  body.querySelector('#det-mode')?.addEventListener('change', (e) => {
    detSettings.mode = e.target.value;
    rerun();
  });
  body.querySelector('#det-model')?.addEventListener('change', (e) => {
    detSettings.model = e.target.value;
    rerun();
  });
  body.querySelector('#det-prefer')?.addEventListener('change', (e) => {
    detSettings.prefer = e.target.value;
    rerun();
  });
  body.querySelector('#det-color')?.addEventListener('change', (e) => {
    detSettings.colorAssist = e.target.checked;
    rerun();
  });
  body.querySelector('#btn-det-rerun')?.addEventListener('click', rerun);
}

function saveDetections() {
  const { image } = store.state;
  if (!detResult || !image) return;
  const json = serializeDetections(detResult.detections, image);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = detectionsFileName(image.fileName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  panel.message(`已保存 ${a.download}（${json.detections.length} 个框）`, 'ok');
}

async function loadDetectionsFile(file) {
  const { image } = store.state;
  if (!detResult || !image) return;
  try {
    const json = JSON.parse(await file.text());
    if (json?.image && json.image !== image.fileName) {
      panel.message(`注意：检测文件记录的照片是 ${json.image}，当前照片是 ${image.fileName}`, 'warn');
    }
    const detections = parseDetections(json, image);
    detResult = { ...detResult, detections, source: 'file', note: null };
    boxEditor.setBoxes(detections);
    updateDetOverlay();
    applyDetections();
    panel.message(`已载入 ${file.name}：${detections.length} 个框`, 'ok');
  } catch (err) {
    panel.message(`载入检测结果失败：${err.message}`, 'error');
  }
}

store.on('stage:posed', () => {
  runDetect().catch((err) => {
    console.error(err);
    store.fail('detect', `检测出错：${err.message}`);
  });
});

/* ------------------------------------------------------------------ */
/* 模块 6：分拣规划与抓取动画                                            */
/* ------------------------------------------------------------------ */

const sortPlayer = createSortPlayer({
  arm,
  partsLayer,
  requestRender: world.requestRender,
  onProgress: ({ task, phase }) => updateSortProgress(task, phase),
  onState: (state) => onSortState(state),
});
/** 当前规划：{ tasks, skipped, segs } */
let sortPlan = null;
/** 分拣是否动过场景（零件被拿走、机械臂离开初始姿态） */
let sortTouched = false;

const sortActive = () => sortPlayer.state === 'running' || sortPlayer.state === 'paused';

/**
 * 停止分拣并复原机械臂；返回是否动过零件（调用方需要重建零件）
 * @returns {boolean}
 */
function stopSorting() {
  const touched = sortTouched;
  sortPlayer.stop();
  sortTouched = false;
  if (touched) {
    arm.setAngles(arm.homeAngles);
    arm.setGap(GRIP_MAX);
  }
  if (store.state.stage === 'sorting' || store.state.stage === 'done') store.rollback('sceneBuilt');
  return touched;
}

/** 重新规划（零件变化后），载入动作序列，刷新"分拣"分区 */
function refreshPlan() {
  const { parts } = store.state;
  if (!parts) return;
  const start = fkWorld(arm.homeAngles, ARM);
  const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));
  const { tasks, skipped } = plan(parts, BINS, ARM, { start, footprints });
  const skippedIds = new Set(skipped.map((p) => p.id));
  store.state.parts = parts.map((p) => ({ ...p, reachable: !skippedIds.has(p.id) }));
  partsLayer.markUnreachable([...skippedIds]);
  const segs = buildSequence(tasks, store.state.parts, ARM, { startAngles: arm.homeAngles, homeAngles: arm.homeAngles });
  sortPlan = { tasks, skipped, segs };
  sortPlayer.load(segs);
  renderSortSection();
}

/** 重置：零件回到原位，机械臂回到初始姿态 */
function resetSorting() {
  if (stopSorting()) partsLayer.setParts(store.state.parts, parallaxOn);
  refreshPlan();
}

function startSorting() {
  if (!sortPlan?.tasks.length) return;
  if (sortPlayer.state === 'done') resetSorting();
  setArmDebug(false);
  armTarget.hide();
  if (store.state.stage === 'sceneBuilt') store.advance('sorting', { tasks: sortPlan.tasks, skipped: sortPlan.skipped });
  tabs.select('three');
  sortTouched = true;
  sortPlayer.start();
}

const partName = (p) => `${CLASSES[p.cls].name} (${fmt(p.x, 1)}, ${fmt(p.y, 1)})`;

/** 渲染"分拣"分区（规划变化时整体重建；进度变化只改样式） */
function renderSortSection() {
  if (!sortPlan) return;
  const { tasks, skipped } = sortPlan;
  const byId = new Map(store.state.parts.map((p) => [p.id, p]));
  const body = panel.setCustom('sort', '分拣');
  let html = `<p class="summary">共 <b>${tasks.length}</b> 个零件待分拣${skipped.length ? `，<span class="bad">${skipped.length} 个够不到</span>` : ''}</p>`;
  html += `<div class="sort-controls">
    <button type="button" class="btn btn-primary btn-small" id="sort-start">开始</button>
    <button type="button" class="btn btn-small" id="sort-pause" disabled>暂停</button>
    <button type="button" class="btn btn-small" id="sort-reset">重置</button>
    <label class="speed">速度 <input type="range" id="sort-speed" min="0.5" max="3" step="0.25" value="${sortPlayer.speed}" /> <span id="sort-speed-val">${sortPlayer.speed.toFixed(2)}×</span></label>
  </div>
  <p class="muted small" id="sort-phase">等待开始</p>`;
  html += '<ol class="task-list">' + tasks.map((t, i) => {
    const p = byId.get(t.partId);
    const bin = BINS.find((b) => b.id === t.binId);
    return `<li data-i="${i}"><span class="dot" style="--c:${CLASSES[p.cls].color}"></span>${partName(p)}<span class="muted"> → ${CLASSES[bin.cls].name}盒</span></li>`;
  }).join('') + '</ol>';
  if (skipped.length) {
    html += '<p class="sub-title">已跳过</p><ul class="skip-list">' + skipped.map((p) => `<li>${partName(p)}<span>${p.skipReason}</span></li>`).join('') + '</ul>';
  }
  body.innerHTML = html;
  body.querySelector('#sort-start').addEventListener('click', startSorting);
  body.querySelector('#sort-pause').addEventListener('click', () => {
    if (sortPlayer.state === 'running') sortPlayer.pause();
    else sortPlayer.resume();
  });
  body.querySelector('#sort-reset').addEventListener('click', resetSorting);
  body.querySelector('#sort-speed').addEventListener('input', (e) => {
    sortPlayer.setSpeed(Number(e.target.value));
    body.querySelector('#sort-speed-val').textContent = `${Number(e.target.value).toFixed(2)}×`;
  });
  onSortState(sortPlayer.state);
}

function updateSortProgress(task, phase) {
  const body = document.querySelector('#info-panel [data-key="sort"]');
  if (!body || !sortPlan) return;
  const n = sortPlan.tasks.length;
  const finished = sortPlayer.state === 'done' || (task == null && sortTouched);
  body.querySelectorAll('.task-list li').forEach((li) => {
    const i = Number(li.dataset.i);
    li.classList.toggle('active', !finished && i === task);
    li.classList.toggle('done', finished || (task != null && i < task));
  });
  const ph = body.querySelector('#sort-phase');
  if (ph) {
    ph.textContent = !sortTouched ? '等待开始' : task == null ? (finished ? `全部完成（${n} 个）` : phase) : `第 ${task + 1} / ${n} 个 · ${phase}`;
  }
}

function onSortState(state) {
  const body = document.querySelector('#info-panel [data-key="sort"]');
  if (body) {
    const start = body.querySelector('#sort-start');
    const pause = body.querySelector('#sort-pause');
    start.disabled = state === 'running' || state === 'paused' || !sortPlan?.tasks.length;
    start.textContent = state === 'done' ? '重新开始' : '开始';
    pause.disabled = !(state === 'running' || state === 'paused');
    pause.textContent = state === 'paused' ? '继续' : '暂停';
  }
  if (state === 'done') {
    updateSortProgress(null, '完成');
    if (store.state.stage === 'sorting') store.advance('done');
    panel.message(`分拣完成：${sortPlan.tasks.length} 个零件${sortPlan.skipped.length ? `，跳过 ${sortPlan.skipped.length} 个` : ''}`, 'ok');
  }
}

/* ------------------------------------------------------------------ */
/* 上传与示例                                                           */
/* ------------------------------------------------------------------ */

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  panel.message(`正在读取：${file.name}…`, 'info');
  beginRun('upload');
  try {
    const t0 = now();
    const image = await loadImageFile(file);
    await calibReady;
    timeStep('load', now() - t0);
    setImage(image, null);
    panel.message(`已读取照片：${file.name}（${image.width} × ${image.height}）`, 'ok');
  } catch (err) {
    if (!(err instanceof ImageFormatError)) console.error(err);
    store.fail('image', err.message);
  }
});

const sampleSelect = $('#sample-select');
let samples = [];
loadSampleIndex()
  .then((list) => {
    samples = list;
    for (const s of list) sampleSelect.add(new Option(s.label, s.key));
  })
  .catch((err) => panel.message(`示例列表读取失败：${err.message}`, 'warn'));

sampleSelect.addEventListener('change', async (e) => {
  const entry = samples.find((s) => s.key === e.target.value);
  e.target.value = '';
  if (!entry) return;
  panel.message(`正在加载示例：${entry.label}…`, 'info');
  beginRun('sample');
  try {
    const t0 = now();
    const { image, truth } = await loadSample(entry);
    await calibReady;
    timeStep('load', now() - t0);
    // 合成图：内参默认取真值
    setImage(image, truth);
    panel.message(`已加载示例：${entry.label}`, 'ok');
  } catch (err) {
    store.fail('image', `加载示例失败：${err.message}`);
  }
});

/* global __BUILD_VERSION__ */
panel.message(`页面已就绪（版本 ${typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev'}）。`, 'ok');

// 页面空闲时预先加载零件模型（Worker 里下载约 10 MB、初始化），上传照片后不必再等模型
const preloadModel = () => getOnnxDetector('parts', { prefer: detSettings.prefer }).init().catch((err) => console.warn('模型预加载失败：', err));
if ('requestIdleCallback' in window) requestIdleCallback(preloadModel, { timeout: 3000 });
else setTimeout(preloadModel, 1000);

// 调试用：在控制台访问
window.__twin = { store, panel, debugView, world, phone, transition, partsLayer, boxEditor, arm, armGoto, sortPlayer, getOnnxDetector, colorCandidates, get detResult() { return detResult; }, get sortPlan() { return sortPlan; }, get calib() { return calib; } };
