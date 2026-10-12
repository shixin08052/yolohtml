// 标定板 SVG（打印页面与合成图共用）。
// 整张板是一个 viewBox = 0 0 W H 的 SVG，1 单位 = 1 mm；码图案取自 js-aruco2 的
// generateSVG，保证打印的码与识别端使用同一个字典。需要浏览器环境（DOM）。
import { BOARD, MARKERS } from '../config.js';
import { markerSVG, svgScale, VALID_IDS, ARUCO_DICT } from '../vision/aruco.js';
import { markerRectOnPage } from '../vision/boardLayout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_COLOR = '#8a877f';
const FONT = "-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

function el(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

function label(x, y, text, { size = 3, anchor = 'start', color = TEXT_COLOR, weight = 400, cls } = {}) {
  return el('text', {
    ...(cls ? { class: cls } : {}),
    x, y,
    'font-size': size,
    'font-family': FONT,
    'font-weight': weight,
    'text-anchor': anchor,
    'dominant-baseline': 'middle',
    fill: color,
  }, text);
}

/**
 * 生成整张标定板 SVG。带 .screen-only 的元素（ID 标注）只在屏幕上显示，打印和渲染图片时去掉。
 * @returns {SVGSVGElement}
 */
export function buildBoardSVG() {
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

  // 4 个码：js-aruco2 生成的 SVG 外圈带 1 格白边，按比例放大，使码本体正好为 MARKERS.size
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

    // ID 标注：只在屏幕上显示（.screen-only 打印时隐藏），放在码靠近板中心的一侧、白边之外
    const gap = (total - size) / 2 + 2;
    const onLeftHalf = x < W / 2;
    const lx = onLeftHalf ? x + size + gap : x - gap;
    svg.appendChild(label(lx, y + size / 2, `ID ${id}`, { size: 5, anchor: onLeftHalf ? 'start' : 'end', color: '#c96442', weight: 600, cls: 'screen-only' }));
  }

  // 码与板边之间的空白条（页面坐标）：上下各 margin 宽；
  // 文字只放在两侧码（含白边）之间，避免压到码周围的白边
  const margin = markerRectOnPage(3).y;
  const quiet = (MARKERS.size * (k - 1)) / 2;
  const left = markerRectOnPage(3).x + MARKERS.size + quiet + 3;
  const right = markerRectOnPage(2).x - quiet - 3;
  const topMid = margin / 2;
  const botMid = H - margin / 2;

  // 顶部：说明与方向
  svg.appendChild(label(W / 2, topMid - 2, `视觉分拣标定板 · A4 · ArUco 4×4（${ARUCO_DICT} = OpenCV DICT_4X4_50）· ID 0–3 · 码边长 ${MARKERS.size} mm`, { size: 2.4, anchor: 'middle' }));
  svg.appendChild(label(W / 2, topMid + 1.6, '↑ 远离操作者（+Y）', { size: 2.4, anchor: 'middle' }));

  // 底部中间：操作者一侧
  svg.appendChild(label(W / 2, botMid - 2, '操作者一侧 ↓', { size: 3, anchor: 'middle', weight: 600 }));
  svg.appendChild(label(W / 2, botMid + 1.6, '原点在左下角，X 向右，Y 向上', { size: 2.2, anchor: 'middle' }));

  // 底部左侧：50 mm 比例尺
  const barLen = 50;
  const sx = left;
  const sy = botMid - 0.5;
  const scale = el('g', { stroke: '#555', 'stroke-width': 0.25, fill: 'none' });
  scale.appendChild(el('line', { x1: sx, y1: sy, x2: sx + barLen, y2: sy }));
  for (let i = 0; i <= barLen / 10; i++) {
    const h = i % 5 === 0 ? 2.2 : 1.2;
    scale.appendChild(el('line', { x1: sx + i * 10, y1: sy, x2: sx + i * 10, y2: sy - h }));
  }
  svg.appendChild(scale);
  svg.appendChild(label(sx + barLen / 2, sy + 2.2, `比例尺 ${barLen} mm`, { size: 2.2, anchor: 'middle' }));

  // 底部右侧角落：打印提示
  svg.appendChild(label(right, botMid - 2, '打印时选择 100% 实际尺寸，', { size: 2.4, anchor: 'end' }));
  svg.appendChild(label(right, botMid + 1.6, `打印后用尺子量码边长是否为 ${MARKERS.size} mm`, { size: 2.4, anchor: 'end' }));

  return svg;
}

/**
 * 把标定板 SVG 渲染到 canvas（不含 .screen-only 元素），白底
 * @param {SVGSVGElement} sheet
 * @param {number} pxPerMm
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderBoardToCanvas(sheet, pxPerMm) {
  const clone = sheet.cloneNode(true);
  // 只渲染会打印出来的内容
  for (const e of clone.querySelectorAll('.screen-only')) e.remove();
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
