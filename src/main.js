// 流程编排（步骤 1：只搭页面骨架）。
import { store, STAGE_LABELS } from './state.js';
import { createStepper } from './ui/stepper.js';
import { createTabs } from './ui/tabs.js';
import { createInfoPanel } from './ui/infoPanel.js';
import { createDebugView } from './ui/debugView.js';
import { createWorld } from './scene/world.js';

const $ = (sel) => document.querySelector(sel);

const panel = createInfoPanel($('#info-panel'));
createStepper($('#stepper'), store);
const debugView = createDebugView($('#debug-canvas'));
const world = createWorld($('#three-container'));
createTabs($('.main'), (view) => {
  if (view === 'three') world.resize();
  else debugView.resize();
});

const showStatus = () => panel.setRows('status', '状态', [['流程', STAGE_LABELS[store.state.stage]]]);
showStatus();
store.on('change', showStatus);
store.on('error', ({ reason }) => panel.message(reason, 'error'));

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  panel.message(`已选择文件：${file.name}（照片读取在步骤 4 实现）`, 'info');
  e.target.value = '';
});

$('#sample-select').addEventListener('change', (e) => {
  if (!e.target.value) return;
  panel.message(`示例 ${e.target.value}（步骤 3 实现）`, 'info');
  e.target.value = '';
});

panel.message('页面已就绪。', 'ok');

// 调试用：在控制台访问
window.__twin = { store, panel, debugView, world };
