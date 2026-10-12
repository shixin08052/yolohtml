// 流程编排。
import { store, STAGE_LABELS } from './state.js';
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
import { measurePaper, EDGE_NAMES, CHECK_LIMITS } from './vision/boardCheck.js';
import { markerCornersWorld, markerRectOnPage, paperFrame, designFrame, frameMatrix } from './vision/boardLayout.js';
import { BOARD, MARKERS } from './config.js';
import { drawMarkers } from './ui/markerOverlay.js';
import { createBoxEditor } from './ui/boxEditor.js';
import { createPartsLayer } from './scene/parts.js';
import { detect, MockMissingError, detectionsFileName, serializeDetections, parseDetections } from './vision/detector.js';
import { mapDetections, selectMethod } from './vision/mapping.js';
import { partsTruthError } from './vision/evaluate.js';
import { CLASSES, WORK_AREA } from './config.js';

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
// 还没有照片时，顶面先贴打印版面
renderBoardToCanvas(buildBoardSVG(), 4)
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
// 零件层：位置变化时同步更新手机到零件的射线
const partsLayer = createPartsLayer({
  requestRender: world.requestRender,
  onFrame: () => phone.setRays(partsLayer.rayEnds()),
});
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
  boardTex = { bitmap: image.bitmap, canvas, frame, toLocal: invert3(Hpaper) };
  refreshBoardTexture();
}

/**
 * 重新生成底板贴图：照片里的零件被压到板面上、沿视线往后偏，会在 3D 模型旁形成重影，
 * 默认按检测框把它们擦掉（勾选"板面原图"时保留）
 */
function refreshBoardTexture() {
  if (!boardTex) return;
  const { canvas, frame, toLocal } = boardTex;
  const dets = detResult?.bitmap === boardTex.bitmap ? detResult.detections : [];
  // 每次都在副本上处理，原始正射图保持不变
  const tex = document.createElement('canvas');
  tex.width = canvas.width;
  tex.height = canvas.height;
  const ctx = tex.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  if (dets.length && !$('#show-raw-board').checked) {
    const img = ctx.getImageData(0, 0, tex.width, tex.height);
    const polys = dets.map((d) => boxToTexture(d.box, toLocal, { pxPerMm: BOARD_TEX_PX_PER_MM, paperH: frame.h }));
    erasePolygons(img, polys, { featherPx: 1.5 * BOARD_TEX_PX_PER_MM, ringPx: 2 * BOARD_TEX_PX_PER_MM });
    ctx.putImageData(img, 0, 0);
  }
  board.setPaper(fillOutside(tex), frame);
  world.requestRender();
}
$('#show-raw-board').addEventListener('change', refreshBoardTexture);

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
    onSourceChange: (source) => setImage(store.state.image, store.state.truth, source),
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
  if (force || markerResult?.bitmap !== image.bitmap) {
    const body = panel.setCustom('markers', '标定');
    body.innerHTML = '<p class="muted">识别中…</p>';
    showRectified(null);
    await nextFrame();
    const t0 = performance.now();
    const det = detectMarkersInImage(image.bitmap, 1600);
    const { markers } = det;
    const ms = performance.now() - t0;
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
    markerResult = { bitmap: image.bitmap, markers, ms, hom, calib };
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
    updateBoard3D();
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
  poseBody.querySelector('#btn-use-focal')?.addEventListener('click', () => setImage(store.state.image, store.state.truth, 'self'));
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

const DET_SOURCE_LABELS = { truth: '合成图真值框', mock: 'mock 检测文件', manual: '手动框选', file: '载入的检测文件', none: '无' };

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

/** 位姿求出后：检测（同一张照片沿用已有结果），再映射 */
async function runDetect() {
  const { image, truth } = store.state;
  if (detResult?.bitmap !== image.bitmap) {
    let detections = [];
    let source = truth ? 'truth' : 'mock';
    let note = null;
    try {
      detections = await detect(image, { mode: 'mock', truth });
    } catch (err) {
      if (!(err instanceof MockMissingError)) throw err;
      source = 'none';
      note = `没有找到 mock 检测文件 ${detectionsFileName(image.fileName)}。可以点"框选"在照片上手动框出零件，保存后下次用"载入"读回。`;
    }
    if (store.state.image?.bitmap !== image.bitmap) return; // 等待期间换了照片
    detResult = { bitmap: image.bitmap, detections, source, note };
    boxEditor.setBoxes(detections);
  }
  $('#dets-toggle').hidden = false;
  $('#btn-boxedit').disabled = false;
  updateDetOverlay();
  applyDetections();
}

/** 检测框 → 零件（两种方法都算），写入 state，重建 3D 零件 */
function applyDetections() {
  const { pose, calib, intrinsics, image } = store.state;
  if (!detResult || !pose || image?.bitmap !== detResult.bitmap) {
    renderDetectSection(null);
    return;
  }
  const K = intrinsicsMatrix(intrinsics);
  const { parts, dropped } = mapDetections(detResult.detections, { Hinv: calib.Hinv, K, R: pose.R, position: pose.position }, { parallax: parallaxOn });
  store.advance('detected', { detections: detResult.detections, parts });
  partsLayer.setParts(parts, parallaxOn);
  refreshBoardTexture();
  store.advance('sceneBuilt');
  renderDetectSection({ parts, dropped });
}

function setParallax(on) {
  parallaxOn = on;
  if (store.state.parts) store.state.parts = selectMethod(store.state.parts, on);
  partsLayer.animateMethod(on);
  renderDetectSection(lastMapping);
}

let lastMapping = null;

/** 渲染"检测"分区 */
function renderDetectSection(mapping) {
  lastMapping = mapping;
  if (!detResult) return;
  const { truth } = store.state;
  const body = panel.setCustom('detect', '检测与映射');
  const dets = detResult.detections;
  let html = '';
  if (!mapping) {
    html += `<p class="summary">${dets.length} 个检测框</p><p class="note info">需要先求出位姿，才能把检测框映射到底板坐标。</p>`;
  } else {
    const { parts, dropped } = mapping;
    html += `<p class="summary">检测到 <b>${parts.length}</b> 个零件<span class="muted">（来源：${DET_SOURCE_LABELS[detResult.source]}）</span></p>`;
    const counts = CLASSES.map((c) => [c.name, parts.filter((p) => p.cls === c.id).length]).filter(([, n]) => n);
    if (counts.length) html += '<dl class="kv">' + counts.map(([k, n]) => `<dt>${k}</dt><dd>${n}</dd>`).join('') + '</dl>';
    html += `<label class="check toggle-row"><input type="checkbox" id="parallax-toggle"${parallaxOn ? ' checked' : ''} /> 视差修正</label>`;
    html += '<p class="muted small">零件有高度，斜拍时检测框中心对应零件半高处；修正后按半高求交，不修正则直接落到板面。</p>';
    if (truth && parts.length) {
      const e = partsTruthError(parts, truth);
      const cell = (st, on) => (st ? `<span class="${st.mean < 3 ? 'ok' : 'bad'}">平均 ${fmt(st.mean, 2)} · 最大 ${fmt(st.max, 2)} mm</span>${on ? ' ◀' : ''}` : '—');
      html += '<dl class="kv">';
      html += `<dt>不修正 vs 真值</dt><dd>${cell(e.plane, !parallaxOn)}</dd>`;
      html += `<dt>视差修正 vs 真值</dt><dd>${cell(e.parallax, parallaxOn)}</dd>`;
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
/* 上传与示例                                                           */
/* ------------------------------------------------------------------ */

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  panel.message(`正在读取：${file.name}…`, 'info');
  try {
    const image = await loadImageFile(file);
    await calibReady;
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
  try {
    const { image, truth } = await loadSample(entry);
    await calibReady;
    // 合成图：内参默认取真值
    setImage(image, truth);
    panel.message(`已加载示例：${entry.label}`, 'ok');
  } catch (err) {
    store.fail('image', `加载示例失败：${err.message}`);
  }
});

panel.message('页面已就绪。', 'ok');

// 调试用：在控制台访问
window.__twin = { store, panel, debugView, world, phone, transition, partsLayer, boxEditor, get calib() { return calib; } };
