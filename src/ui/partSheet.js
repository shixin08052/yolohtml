// 导出"零件图片"：一张 PNG 汇总识别结果——上面是底板正视图（框出元件、编号），下面是每个零件的特写
// （从原照片按单应性取出，转到长轴水平），并标上类别、坐标、朝向、置信度。需要浏览器环境（canvas）。
import { drawPartBoxes, countByClass, partNo } from './confirmView.js';
import { invert3 } from '../vision/homography.js';

/** 特写窗口（mm）：沿零件长轴 × 垂直方向；分辨率按格子大小 */
const CROP_MM = [36, 24];

/** 3×3 矩阵作用在点上（含透视除法） */
const apply = (H, X, Y) => {
  const w = H[2][0] * X + H[2][1] * Y + H[2][2];
  return [(H[0][0] * X + H[0][1] * Y + H[0][2]) / w, (H[1][0] * X + H[1][1] * Y + H[1][2]) / w];
};

/**
 * 零件特写：格子像素 → 照片像素是单应性，在几厘米的小窗口里用仿射近似（取窗口中心和两个方向上的点精确对应）
 * @param {CanvasRenderingContext2D} ctx 已平移到格子左上角
 * @param {CanvasImageSource} photo 原照片
 * @param {number[][]} H 底板 mm → 照片像素
 * @param {{ xPlane: number, yPlane: number, rotDeg: number }} part
 * @param {number} w 格子宽（px）
 * @param {number} h 格子高（px）
 */
function drawCrop(ctx, photo, H, part, w, h) {
  const k = w / CROP_MM[0]; // px / mm
  const a = (part.rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // 格子像素 (u, v) → 零件局部 mm（长轴向右、向上为 +）→ 底板 mm → 照片像素
  const toPhoto = (u, v) => {
    const lx = (u - w / 2) / k;
    const ly = -(v - h / 2) / k;
    return apply(H, part.xPlane + lx * c - ly * s, part.yPlane + lx * s + ly * c);
  };
  const o = toPhoto(w / 2, h / 2);
  const ex = toPhoto(w / 2 + 1, h / 2);
  const ey = toPhoto(w / 2, h / 2 + 1);
  // 格子 → 照片的仿射 [[a, b, tx], [c, d, ty]]，取逆后交给 canvas（照片 → 格子）
  const M = [
    [ex[0] - o[0], ey[0] - o[0], o[0] - (ex[0] - o[0]) * (w / 2) - (ey[0] - o[0]) * (h / 2)],
    [ex[1] - o[1], ey[1] - o[1], o[1] - (ex[1] - o[1]) * (w / 2) - (ey[1] - o[1]) * (h / 2)],
    [0, 0, 1],
  ];
  const Mi = invert3(M);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = '#eee';
  ctx.fillRect(0, 0, w, h);
  ctx.transform(Mi[0][0], Mi[1][0], Mi[0][1], Mi[1][1], Mi[0][2], Mi[1][2]);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo, 0, 0);
  ctx.restore();
}

const FONT = 'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/**
 * 生成汇总图
 * @param {{
 *   front: HTMLCanvasElement,            // 底板正射图（纸张范围）
 *   toFront: number[][],                 // 底板 mm → 正射图像素
 *   photo: CanvasImageSource,            // 原照片
 *   H: number[][],                       // 底板 mm → 照片像素
 *   parts: object[], classes: object[],
 *   body: (cls: number) => { minX: number, maxX: number, halfW: number },
 *   title?: string, subtitle?: string, note?: string,
 * }} o
 * @returns {HTMLCanvasElement}
 */
export function renderPartSheet({ front, toFront, photo, H, parts, classes, body, title = '零件识别结果', subtitle = '', note = '' }) {
  const W = 1800;
  const pad = 48;
  const inner = W - 2 * pad;
  const cols = 4;
  const gap = 24;
  const cellW = Math.floor((inner - (cols - 1) * gap) / cols);
  const cropH = Math.round((cellW * CROP_MM[1]) / CROP_MM[0]);
  const capH = 86;
  const rows = Math.ceil(parts.length / cols);
  const k = inner / front.width;
  const frontH = Math.round(front.height * k);
  const headH = 110;
  const gridTop = headH + frontH + 70;
  const Ht = gridTop + rows * (cropH + capH + gap) + (note ? 60 : 30);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = Ht;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, Ht);
  ctx.textBaseline = 'alphabetic';

  // 标题
  ctx.fillStyle = '#1f1e1d';
  ctx.font = `600 34px ${FONT}`;
  ctx.fillText(title, pad, 62);
  ctx.fillStyle = '#6b6862';
  ctx.font = `20px ${FONT}`;
  const counts = countByClass(parts, classes).map((c) => `${c.name} × ${c.n}`).join('、');
  ctx.fillText([subtitle, `共 ${parts.length} 个元件${counts ? `：${counts}` : ''}`].filter(Boolean).join('　·　'), pad, 96);

  // 正视图 + 框
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(front, pad, headH, inner, frontH);
  ctx.strokeStyle = '#d8d4cc';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, headH + 0.5, inner - 1, frontH - 1);
  const toScreen = ([X, Y]) => {
    const [u, v] = apply(toFront, X, Y);
    return [pad + u * k, headH + v * k];
  };
  drawPartBoxes(ctx, { parts, classes, body, toScreen, width: W, scale: 1.8 });

  // 特写
  ctx.fillStyle = '#1f1e1d';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('单个零件（从原照片取出并转正：长轴水平）', pad, gridTop - 22);
  parts.forEach((p, i) => {
    const x = pad + (i % cols) * (cellW + gap);
    const y = gridTop + Math.floor(i / cols) * (cropH + capH + gap);
    const cls = classes[p.cls];
    ctx.save();
    ctx.translate(x, y);
    drawCrop(ctx, photo, H, p, cellW, cropH);
    ctx.restore();
    ctx.strokeStyle = cls?.color ?? '#999';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, cellW - 3, cropH - 3);
    ctx.fillStyle = cls?.color ?? '#333';
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText(`${partNo(p, i)}  ${cls?.name ?? ''}`, x, y + cropH + 30);
    ctx.fillStyle = '#4a4742';
    ctx.font = `18px ${FONT}`;
    ctx.fillText(`位置 (${f1(p.x)}, ${f1(p.y)}) mm · 朝向 ${f1(p.rotDeg)}°`, x, y + cropH + 56);
    ctx.fillStyle = '#7a776f';
    ctx.fillText(`置信度 ${Number.isFinite(p.score) ? p.score.toFixed(2) : '—'}`, x, y + cropH + 80);
  });

  if (note) {
    ctx.fillStyle = '#7a776f';
    ctx.font = `17px ${FONT}`;
    ctx.fillText(note, pad, Ht - 24);
  }
  return canvas;
}
