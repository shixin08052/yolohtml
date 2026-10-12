// 流程编排。
import { store, STAGE_LABELS } from './state.js';
import { createStepper } from './ui/stepper.js';
import { createTabs } from './ui/tabs.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createDebugView } from './ui/debugView.js';
import { drawTruth } from './ui/truthOverlay.js';
import { createWorld } from './scene/world.js';
import { loadSampleIndex, loadSample } from './vision/samples.js';
import { loadImageFile, ImageFormatError } from './vision/image.js';
import { computeIntrinsics, defaultSource } from './vision/intrinsics.js';
import { renderImagePanel } from './ui/imagePanel.js';
import { detectMarkersInImage, VALID_IDS } from './vision/aruco.js';
import { markerCornerErrors, homographyTruthError } from './vision/evaluate.js';
import { boardHomography, rectify } from './vision/homography.js';
import { markerCornersWorld, markerRectOnPage } from './vision/boardLayout.js';
import { BOARD } from './config.js';
import { drawMarkers } from './ui/markerOverlay.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

const panel = createInfoPanel($('#info-panel'));
createStepper($('#stepper'), store);
const debugView = createDebugView($('#debug-canvas'));
const world = createWorld($('#three-container'));
const tabs = createTabs($('.main'), (view) => {
  if (view === 'three') world.resize();
  else debugView.resize();
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
function setImage(image, truth, source = defaultSource({ image, calib, truth })) {
  const { intrinsics, notes } = computeIntrinsics(source, { image, calib, truth });
  intrinsicsNotes = notes;
  store.advance('imageLoaded', { image, intrinsics, truth });
  for (const n of notes) panel.message(n.text, n.level);
}

store.on('stage:imageLoaded', (st) => {
  const { image, intrinsics, truth } = st;
  debugView.setImage(image.bitmap);
  $('#truth-toggle').hidden = !truth;
  updateTruthOverlay();
  if (markerResult?.bitmap !== image.bitmap) {
    debugView.setOverlay('markers', null);
    $('#markers-toggle').hidden = true;
    showRectified(null);
  }
  tabs.select('debug');

  renderImagePanel(panel, {
    image,
    intrinsics,
    truth,
    notes: intrinsicsNotes,
    calibAvailable: !!calib,
    // 切换来源：重新计算内参，从这一步重跑（后续结果清空）
    onSourceChange: (source) => setImage(store.state.image, store.state.truth, source),
  });
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
  let html = '<dl class="kv">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
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
    const { markers } = detectMarkersInImage(image.bitmap, 1600);
    const ms = performance.now() - t0;
    let hom = null;
    let calib = null;
    if (markers.length) {
      hom = boardHomography(markers, markerCornersWorld);
      const rectified = rectify(image.bitmap, hom.H, RECT_PX_PER_MM, { boardW: BOARD.width, boardH: BOARD.height });
      calib = { markers, H: hom.H, Hinv: hom.Hinv, reprojErrPx: hom.reprojErrPx, rectified };
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
window.__twin = { store, panel, debugView, world, get calib() { return calib; } };
