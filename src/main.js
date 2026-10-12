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
window.__twin = { store, panel, debugView, world, get calib() { return calib; } };
