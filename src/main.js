// 流程编排。
import { store, STAGE_LABELS } from './state.js';
import { createStepper } from './ui/stepper.js';
import { createTabs } from './ui/tabs.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createDebugView } from './ui/debugView.js';
import { drawTruth } from './ui/truthOverlay.js';
import { createWorld } from './scene/world.js';
import { loadSampleIndex, loadSample } from './vision/samples.js';

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

store.on('stage:imageLoaded', (st) => {
  const { image, intrinsics, truth } = st;
  debugView.setImage(image.bitmap);
  $('#truth-toggle').hidden = !truth;
  updateTruthOverlay();
  tabs.select('debug');

  panel.setRows('image', '照片', [
    ['文件', image.fileName],
    ['分辨率', `${image.width} × ${image.height}`],
    ['类型', truth ? '合成图（带真值）' : '照片'],
  ]);
  const srcName = { exif: 'EXIF', calib: '标定文件', truth: '真值' }[intrinsics.source];
  panel.setRows('intrinsics', '内参', [
    ['fx / fy', `${fmt(intrinsics.fx, 1)} / ${fmt(intrinsics.fy, 1)}`],
    ['cx / cy', `${fmt(intrinsics.cx, 1)} / ${fmt(intrinsics.cy, 1)}`],
    ['来源', srcName],
  ]);
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

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  panel.message(`已选择文件：${file.name}（照片读取在步骤 4 实现）`, 'info');
  e.target.value = '';
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
    // 合成图：内参直接取真值
    const intrinsics = truth ? { ...truth.intrinsics, source: 'truth' } : null;
    if (!intrinsics) throw new Error('该示例没有内参（照片读取与 EXIF 在步骤 4 实现）');
    store.advance('imageLoaded', { image, intrinsics, truth });
    panel.message(`已加载示例：${entry.label}`, 'ok');
  } catch (err) {
    store.fail('image', `加载示例失败：${err.message}`);
  }
});

panel.message('页面已就绪。', 'ok');

// 调试用：在控制台访问
window.__twin = { store, panel, debugView, world };
