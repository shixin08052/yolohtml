// 可打印的 A3 标定板（board.html）。
// 整张板是一个 viewBox = 0 0 420 297 的 SVG，1 单位 = 1 mm；码图案取自 js-aruco2 的
// generateSVG，保证打印的码与识别端使用同一个字典。
import { BOARD, MARKERS } from './config.js';
import { markerSVG, svgScale, detectMarkers, VALID_IDS, ARUCO_DICT } from './vision/aruco.js';
import { markerRectOnPage, markerCornersOnPage } from './vision/boardLayout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_COLOR = '#8a877f';
const FONT = "-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

function label(x, y, text, { size = 3, anchor = 'start', color = TEXT_COLOR, weight = 400 } = {}) {
  return el('text', {
    x, y,
    'font-size': size,
    'font-family': FONT,
    'font-weight': weight,
    'text-anchor': anchor,
    'dominant-baseline': 'middle',
    fill: color,
  }, text);
}

/** 生成整张标定板 SVG */
function buildSheet() {
  const W = BOARD.width;
  const H = BOARD.height;
  const svg = el('svg', {
    xmlns: SVG_NS,
    class: 'sheet',
    width: `${W}mm`,
    height: `${H}mm`,
    viewBox: `0 0 ${W} ${H}`,
  });
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }));

  // 4 个码：js-aruco2 生成的 SVG 外圈带 1 格白边，按比例放大，使码本体正好 50 mm
  const k = svgScale();
  for (const id of VALID_IDS) {
    const { x, y, size } = markerRectOnPage(id);
    const total = size * k;
    const doc = new DOMParser().parseFromString(markerSVG(id), 'image/svg+xml');
    const m = document.importNode(doc.documentElement, true);
    m.setAttribute('x', x - (total - size) / 2);
    m.setAttribute('y', y - (total - size) / 2);
    m.setAttribute('width', total);
    m.setAttribute('height', total);
    m.setAttribute('shape-rendering', 'crispEdges');
    m.dataset.markerId = id;
    svg.appendChild(m);

    // ID 标注：放在码靠近板中心的一侧、白边之外
    const gap = (total - size) / 2 + 2;
    const onLeftHalf = x < W / 2;
    const lx = onLeftHalf ? x + size + gap : x - gap;
    svg.appendChild(label(lx, y + size / 2, `ID ${id}`, { size: 4, anchor: onLeftHalf ? 'start' : 'end' }));
  }

  // 顶部：说明与方向
  svg.appendChild(label(W / 2, 7, `视觉分拣标定板 · A3 · ArUco 4×4（${ARUCO_DICT}，与 OpenCV DICT_4X4_50 相同）· ID 0–3 · 码边长 ${MARKERS.size} mm`, { size: 3, anchor: 'middle' }));
  svg.appendChild(label(W / 2, 11.5, '↑ 远离操作者（+Y）', { size: 3, anchor: 'middle' }));

  // 底部：操作者一侧
  svg.appendChild(label(W / 2, 286, '操作者一侧 ↓', { size: 3.5, anchor: 'middle', weight: 600 }));
  svg.appendChild(label(W / 2, 290.5, '底板原点在左下角，X 向右，Y 向上', { size: 2.6, anchor: 'middle' }));

  // 底部左侧：100 mm 比例尺
  const sx = 85;
  const sy = 289;
  const scale = el('g', { stroke: '#555', 'stroke-width': 0.25, fill: 'none' });
  scale.appendChild(el('line', { x1: sx, y1: sy, x2: sx + 100, y2: sy }));
  for (let i = 0; i <= 10; i++) {
    const h = i % 5 === 0 ? 2.5 : 1.3;
    scale.appendChild(el('line', { x1: sx + i * 10, y1: sy, x2: sx + i * 10, y2: sy - h }));
  }
  svg.appendChild(scale);
  svg.appendChild(label(sx + 50, sy + 2.6, '比例尺 100 mm', { size: 2.6, anchor: 'middle' }));

  // 角落：打印提示
  svg.appendChild(label(340, 286, '打印时选择 100% 实际尺寸，', { size: 2.8, anchor: 'end' }));
  svg.appendChild(label(340, 290, '打印后用尺子量码边长是否为 50 mm', { size: 2.8, anchor: 'end' }));

  return svg;
}

const sheet = buildSheet();
document.getElementById('sheet-host').appendChild(sheet);

document.getElementById('btn-print').addEventListener('click', () => window.print());

/* ------------------------------------------------------------------ */
/* 自检：把标定板 SVG 渲染成图片，交给 aruco.js 识别                       */
/* ------------------------------------------------------------------ */

const PX_PER_MM = 4;

async function renderSheetToCanvas(pxPerMm) {
  const clone = sheet.cloneNode(true);
  clone.setAttribute('width', BOARD.width * pxPerMm);
  clone.setAttribute('height', BOARD.height * pxPerMm);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = BOARD.width * pxPerMm;
    canvas.height = BOARD.height * pxPerMm;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawPreview(src, markers) {
  const preview = document.getElementById('check-preview');
  const s = 600 / src.width;
  preview.width = 600;
  preview.height = Math.round(src.height * s);
  const ctx = preview.getContext('2d');
  ctx.drawImage(src, 0, 0, preview.width, preview.height);
  ctx.lineWidth = 2;
  ctx.font = '600 14px sans-serif';
  for (const m of markers) {
    const c = m.corners.map(([u, v]) => [u * s, v * s]);
    ctx.strokeStyle = '#3b9e5a';
    ctx.beginPath();
    c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#e03c31';
    ctx.beginPath();
    ctx.arc(c[0][0], c[0][1], 4, 0, Math.PI * 2);
    ctx.fill();
    const cx = c.reduce((a, p) => a + p[0], 0) / 4;
    const cy = c.reduce((a, p) => a + p[1], 0) / 4;
    ctx.fillStyle = '#c96442';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`ID${m.id}`, cx, cy);
  }
  preview.hidden = false;
}

async function selfCheck() {
  const out = document.getElementById('check-result');
  const btn = document.getElementById('btn-check');
  btn.disabled = true;
  out.textContent = '识别中…';
  try {
    const canvas = await renderSheetToCanvas(PX_PER_MM);
    const ctx = canvas.getContext('2d');
    const t0 = performance.now();
    const markers = detectMarkers(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const ms = performance.now() - t0;

    const found = markers.map((m) => m.id);
    const missing = VALID_IDS.filter((id) => !found.includes(id));
    const rows = VALID_IDS.map((id) => {
      const m = markers.find((x) => x.id === id);
      if (!m) return `<tr><td>ID ${id}</td><td class="bad">未识别</td></tr>`;
      const truth = markerCornersOnPage(id).map(([x, y]) => [x * PX_PER_MM, y * PX_PER_MM]);
      const err = Math.max(...m.corners.map((c, i) => Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1])));
      return `<tr><td>ID ${id}</td><td class="ok">✓ 角点最大偏差 ${err.toFixed(1)} px</td></tr>`;
    });
    const head = missing.length
      ? `<span class="bad">缺少 ID：${missing.join('、')}</span>`
      : `<span class="ok">识别到 ID ${found.join('、')}，全部正确</span>`;
    out.innerHTML =
      `${head}<table>${rows.join('')}</table>` +
      `<div class="muted">渲染 ${canvas.width}×${canvas.height}（${PX_PER_MM} px/mm），识别耗时 ${ms.toFixed(0)} ms。红点 = 码自身左上角。</div>`;
    out.classList.remove('muted');
    out.dataset.found = found.join(',');
    drawPreview(canvas, markers);
  } catch (e) {
    out.innerHTML = `<span class="bad">自检失败：${e.message ?? e}</span>`;
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('btn-check').addEventListener('click', selfCheck);
