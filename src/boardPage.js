// 可打印的 A4 标定板（board.html）：显示与打印、自检、照片检查。
// 标定板 SVG 本身由 ui/boardSheet.js 生成。
import { BOARD, MARKERS } from './config.js';
import { detectMarkers, detectMarkersInImage, VALID_IDS } from './vision/aruco.js';
import { markerCornersOnPage } from './vision/boardLayout.js';
import { buildBoardSVG, renderBoardToCanvas } from './ui/boardSheet.js';
import { checkBoardPhoto, EDGE_NAMES } from './vision/boardCheck.js';
import { applyH } from './vision/homography.js';
import { loadImageFile, ImageFormatError } from './vision/image.js';

const sheet = buildBoardSVG();
document.getElementById('sheet-host').appendChild(sheet);

document.getElementById('btn-print').addEventListener('click', () => window.print());

/* ------------------------------------------------------------------ */
/* 自检：把标定板 SVG 渲染成图片，交给 aruco.js 识别                       */
/* ------------------------------------------------------------------ */

const PX_PER_MM = 4;

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
    const canvas = await renderBoardToCanvas(sheet, PX_PER_MM);
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

/* ------------------------------------------------------------------ */
/* 照片检查：上传打印后拍的照片，检查码、版面和打印比例                       */
/* ------------------------------------------------------------------ */

const fmt = (x, d = 1) => (x == null ? '—' : x.toFixed(d));

function renderPhotoResult(out, file, bitmap, det, r) {
  const icon = { ok: '✓', warn: '!', bad: '✗' }[r.level];
  const cls = { ok: 'ok', warn: 'warn', bad: 'bad' }[r.level];
  const title = { ok: '打印正确', warn: '基本可用，有提醒', bad: '打印有问题' }[r.level];
  const s = det.scale;

  let html = `<div class="verdict ${cls}">${icon} ${title}</div><ul>`;
  html += r.messages.map((m) => `<li>${m}</li>`).join('');
  html += '</ul>';

  html += '<h4>照片</h4><table>';
  html += `<tr><td>文件</td><td>${file.name}</td></tr>`;
  html += `<tr><td>尺寸</td><td>${bitmap.width} × ${bitmap.height}</td></tr>`;
  html += `<tr><td>识别到</td><td>${r.found.length ? 'ID ' + r.found.join('、') : '无'}</td></tr>`;
  if (r.reprojErrPx != null && r.found.length >= 2) {
    html += `<tr><td>重投影误差</td><td>${fmt(r.reprojErrPx / s, 2)} px</td></tr>`;
  }
  html += '</table>';

  if (r.perMarker.length) {
    html += '<h4>每个码（设计边长 ' + MARKERS.size + ' mm）</h4><table>';
    for (const p of r.perMarker) {
      html += `<tr><td>ID ${p.id}</td><td>位置偏差 ${fmt(p.maxMm, 2)} mm · 边长 ${fmt(p.sideMm, 2)} mm</td></tr>`;
    }
    html += '</table>';
  }

  if (r.paper) {
    const { edges, widthMm, heightMm, scaleX, scaleY } = r.paper;
    html += '<h4>纸张（设计 ' + BOARD.width + ' × ' + BOARD.height + ' mm）</h4><table>';
    const pct = (k) => (k ? fmt(k * 100) + '%' : '—');
    html += `<tr><td>实测长边 × 短边</td><td>${fmt(widthMm)} × ${fmt(heightMm)} mm</td></tr>`;
    html += `<tr><td>打印比例（长边 × 短边）</td><td>${pct(scaleX)} × ${pct(scaleY)}</td></tr>`;
    // 纸边相对设计位置的外移；测不出时写原因
    const why = { outside: '太靠近照片边缘', contrast: '对比不够' };
    for (const k of ['bottom', 'top', 'left', 'right']) {
      const v = edges[k] != null ? `外移 ${fmt(edges[k])} mm` : `<span class="warn">${why[r.paper.reasons[k]]}</span>`;
      html += `<tr><td>${EDGE_NAMES[k]}</td><td>${v}</td></tr>`;
    }
    html += '</table>';
  }
  out.innerHTML = html;
  out.classList.remove('muted');
  out.dataset.level = r.level;
}

/** 在大预览图上画出识别结果、设计纸边、实测纸边。坐标均为缩小图像素。 */
function drawPhotoPreview(bitmap, det, r) {
  const canvas = document.getElementById('photo-canvas');
  const maxW = 1400;
  const k = Math.min(1, maxW / bitmap.width);
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const f = k / det.scale; // 缩小图像素 → 预览像素
  const P = ([u, v]) => [u * f, v * f];
  const lw = Math.max(2, canvas.width / 500);

  const poly = (pts, color, dash = []) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash);
    ctx.beginPath();
    pts.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };

  // 实测纸张轮廓（四条纸边直线的交点，能反映纸张的偏移与歪斜）
  if (r.paper?.corners && r.H) poly(r.paper.corners.map((p) => applyH(r.H, p)), '#3d7bd9');

  // 设计纸边画在实测纸边上面（虚线），打印正确时两者重合
  if (r.boardOutlinePx) poly(r.boardOutlinePx, '#c96442', [lw * 4, lw * 3]);

  ctx.font = `600 ${Math.round(lw * 9)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of det.small) {
    poly(m.corners, '#3b9e5a');
    const [x0, y0] = P(m.corners[0]);
    ctx.fillStyle = '#e03c31';
    ctx.beginPath();
    ctx.arc(x0, y0, lw * 3, 0, Math.PI * 2);
    ctx.fill();
    const c = m.corners.map(P);
    const cx = c.reduce((a, p) => a + p[0], 0) / 4;
    const cy = c.reduce((a, p) => a + p[1], 0) / 4;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(cx - lw * 14, cy - lw * 7, lw * 28, lw * 14);
    ctx.fillStyle = '#c96442';
    ctx.fillText(`ID${m.id}`, cx, cy);
  }
}

async function photoCheck(file) {
  const out = document.getElementById('photo-result');
  const panel = document.getElementById('photo-panel');
  out.classList.add('muted');
  out.textContent = '识别中…';
  delete out.dataset.level;
  try {
    const { bitmap } = await loadImageFile(file);
    const det = detectMarkersInImage(bitmap, 1600);
    // 在缩小图的像素坐标里做检查（纸边也在缩小图上测）
    const r = checkBoardPhoto(det.small, det.imageData);
    renderPhotoResult(out, file, bitmap, det, r);
    drawPhotoPreview(bitmap, det, r);
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    out.classList.remove('muted');
    out.innerHTML = `<span class="bad">${e.message ?? e}</span>`;
    out.dataset.level = 'error';
    panel.hidden = true;
    if (!(e instanceof ImageFormatError)) console.error(e);
  }
}

document.getElementById('photo-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) photoCheck(file);
  e.target.value = '';
});
