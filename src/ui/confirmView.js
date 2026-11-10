// 演示模式的"正视图 · 确认识别结果"：底板正射图（照片按单应性拉正），把识别到的元件按类别颜色框出来、编号，
// 下方一条确认栏：确认后开始转场建模；也可以回到照片上修改框，或重新选照片。
// outlineCorners、countByClass 是纯函数（便于测试）；createConfirmView 负责画布和按钮。
import { partName, partColor } from '../robot/bins.js';
import { createPanZoom } from './panZoom.js';

/**
 * 元件在底板上的轮廓（只框本体，不含引脚）：四个角，底板坐标 mm
 * 用方法 1 的位置（检测框中心沿视线落到板面）：正射图就是照片投到板面上的样子，零件的像也在那里
 * @param {{ xPlane: number, yPlane: number, rotDeg: number }} part
 * @param {{ minX: number, maxX: number, halfW: number }} body 本体在局部坐标下的范围（x 沿长轴）
 * @param {number} [pad=1.5] 每边外扩（mm）
 * @returns {number[][]}
 */
export function outlineCorners(part, body, pad = 1.5) {
  const a = (part.rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x0 = body.minX - pad;
  const x1 = body.maxX + pad;
  const w = body.halfW + pad;
  return [[x0, -w], [x1, -w], [x1, w], [x0, w]].map(([u, v]) => [part.xPlane + u * c - v * s, part.yPlane + u * s + v * c]);
}

/**
 * 各种零件的数量（LED 按颜色分开，"红色 LED × 2"），按类别、颜色的顺序，只列出有的
 * @param {{ cls: number, color?: string }[]} parts
 * @param {{ id: number }[]} classes
 * @returns {{ name: string, color: string, n: number }[]}
 */
export function countByClass(parts, classes) {
  const out = new Map();
  for (const c of classes) {
    for (const p of parts.filter((q) => q.cls === c.id)) {
      const name = partName(p);
      if (!out.has(name)) out.set(name, { name, color: partColor(p), n: 0 });
      out.get(name).n++;
    }
  }
  return [...out.values()];
}

/**
 * 标签摆放：每个框的标签先试框的正上方，再试正下方、左侧、右侧、更上方；选第一个不与其他框、已放好的标签重叠的位置，
 * 都重叠时选重叠面积最小的。（零件挨得近时标签不会互相盖住）
 * @param {{ bbox: number[], w: number, h: number }[]} items bbox：框的外接矩形 [x0, y0, x1, y1]
 * @param {number} width
 * @param {number} height
 * @param {number} [gap=6]
 * @param {number[][]} [avoid] 标签要避开的区域 [x0, y0, x1, y1]（例如浮在画面上的工具条）
 * @returns {number[][]} 每个标签左上角
 */
export function placeLabels(items, width, height, gap = 6, avoid = []) {
  const placed = avoid.map((r) => [...r]);
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const clampX = (x, w) => Math.min(Math.max(x, 2), width - w - 2);
  const clampY = (y, h) => Math.min(Math.max(y, 2), height - h - 2);
  return items.map((it, i) => {
    const [x0, y0, x1, y1] = it.bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const { w, h } = it;
    const cands = [
      [cx - w / 2, y0 - gap - h],
      [cx - w / 2, y1 + gap],
      [x0 - gap - w, cy - h / 2],
      [x1 + gap, cy - h / 2],
      [cx - w / 2, y0 - 2 * gap - 2 * h],
      [cx - w / 2, y1 + 2 * gap + h],
    ].map(([x, y]) => [clampX(x, w), clampY(y, h)]);
    let best = cands[0];
    let bestCost = Infinity;
    for (const [x, y] of cands) {
      const r = [x, y, x + w, y + h];
      let cost = 0;
      items.forEach((o, j) => {
        if (j !== i) cost += overlap(r, o.bbox);
      });
      for (const q of placed) cost += 2 * overlap(r, q);
      if (cost < bestCost - 1e-9) {
        best = [x, y];
        bestCost = cost;
        if (cost === 0) break;
      }
    }
    placed.push([best[0], best[1], best[0] + w, best[1] + h]);
    return best;
  });
}

/** 标签（字号、线宽）的倍数：画布窄于 560 px 时按比例缩小，最小 0.78 */
export const labelScale = (width) => Math.min(1, Math.max(0.78, width / 560));

/** 零件的显示编号（从 1 开始，与导出的零件图片、分拣指令一致） */
export const partNo = (p, i = 0) => (Number.isInteger(p.id) ? p.id : i) + 1;

/**
 * 在画布上框出元件（按类别颜色，编号 + 类别名的标签）
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ parts: object[], classes: object[], body: (cls: number) => object, toScreen: (P: number[]) => number[],
 *           width: number, height?: number, scale?: number, pad?: number, avoid?: number[][] }} o scale：线宽、字号的倍数；avoid：标签要避开的区域
 */
export function drawPartBoxes(ctx, { parts, classes, body, toScreen, width, height, scale = 1, pad = 1.5, avoid = [] }) {
  ctx.save();
  ctx.lineJoin = 'round';
  const boxes = [];
  parts.forEach((p, i) => {
    const color = partColor(p);
    const pts = outlineCorners(p, body(p.cls), pad).map(toScreen);
    ctx.beginPath();
    pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = `${color}2e`;
    ctx.fill();
    ctx.lineWidth = 2.5 * scale;
    ctx.strokeStyle = color;
    ctx.stroke();
    boxes.push({ pts, color, label: `${partNo(p, i)} ${partName(p)}` });
  });
  // 标签：先量好大小，再避开别的框和已放好的标签摆放
  ctx.font = `600 ${12 * scale}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  const h = 18 * scale;
  const all = boxes.map((b) => {
    const xs = b.pts.map((q) => q[0]);
    const ys = b.pts.map((q) => q[1]);
    return { b, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], w: ctx.measureText(b.label).width + 10 * scale, h };
  });
  // 放大后整个框都在画面外的零件不画标签（不然标签会被挤到画面边上堆成一排）
  const H = height ?? Infinity;
  const items = all.filter(({ bbox }) => bbox[2] > 0 && bbox[0] < width && bbox[3] > 0 && bbox[1] < H);
  const pos = placeLabels(items, width, H, 6 * scale, avoid);
  items.forEach((it, i) => {
    const [lx, ly] = pos[i];
    ctx.fillStyle = it.b.color;
    ctx.beginPath();
    ctx.roundRect(lx, ly, it.w, h, 5 * scale);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.b.label, lx + 5 * scale, ly + h / 2 + 0.5 * scale);
  });
  ctx.restore();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param {{
 *   root: HTMLElement,               // #view-confirm
 *   onConfirm: () => void,
 *   onEdit: () => void,
 * }} deps
 */
export function createConfirmView({ root, onConfirm, onEdit }) {
  root.innerHTML = `
    <div class="confirm-stage">
      <canvas class="confirm-canvas"></canvas>
      <div class="view-tools confirm-tools">
        <span class="zoom-btns">
          <button type="button" class="icon-btn" data-zoom="out" aria-label="缩小">−</button>
          <button type="button" class="icon-btn" data-zoom="in" aria-label="放大">＋</button>
          <button type="button" class="icon-btn text" data-zoom="reset">复位</button>
        </span>
        <span class="hint hint-mouse">滚轮缩放 · 拖动平移 · 双击放大</span>
        <span class="hint hint-touch">双指缩放 · 单指拖动 · 双击放大</span>
      </div>
    </div>
    <div class="confirm-bar">
      <div class="confirm-text"><b>请确认识别结果</b><span class="confirm-source"></span><span class="confirm-sum"></span></div>
      <div class="confirm-actions">
        <button type="button" class="btn" data-act="edit">修改框选</button>
        <label class="btn" for="file-input">重新选照片</label>
        <button type="button" class="btn btn-primary" data-act="ok">确认，开始建模</button>
      </div>
    </div>`;
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const sum = root.querySelector('.confirm-sum');
  const okBtn = root.querySelector('[data-act="ok"]');
  okBtn.addEventListener('click', () => onConfirm());
  root.querySelector('[data-act="edit"]').addEventListener('click', () => onEdit());

  /** 当前内容：{ image, toTex, parts, classes, body } */
  let data = null;
  /** 缩放按钮条在画布里占的位置 [x0, y0, x1, y1]（画布大小变化时更新，画的时候不读布局） */
  const tools = root.querySelector('.confirm-tools');
  let toolsBox = [0, 0, 0, 0];
  const measureTools = () => {
    toolsBox = [tools.offsetLeft, tools.offsetTop, tools.offsetLeft + tools.offsetWidth, tools.offsetTop + tools.offsetHeight];
  };

  /** 正射图按比例放进画布（四周留白）：{ ox, oy, w, h, k }，CSS 像素 */
  function fitRect() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!data || !W || !H) return null;
    const { image } = data;
    const pad = Math.min(16, W / 24);
    const k = Math.min((W - 2 * pad) / image.width, (H - 2 * pad) / image.height);
    if (!(k > 0)) return null;
    const h = image.height * k;
    // 上下有空余时把图往下让一让，尽量不被左上角的缩放按钮挡住
    const oy = Math.max((H - h) / 2, Math.min(toolsBox[3] + 6, H - h - pad));
    return { ox: (W - image.width * k) / 2, oy, w: image.width * k, h, k };
  }

  // 拖动 / 捏合时指针事件比屏幕刷新快：每帧最多画一次
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  };
  const panZoom = createPanZoom(canvas, { getFit: fitRect, onChange: schedule });
  root.querySelector('[data-zoom="in"]').addEventListener('click', () => panZoom.zoomBy(1.5));
  root.querySelector('[data-zoom="out"]').addEventListener('click', () => panZoom.zoomBy(1 / 1.5));
  root.querySelector('[data-zoom="reset"]').addEventListener('click', () => panZoom.reset());

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; // 只在大小变了时重新分配画布
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const fit = fitRect();
    if (!fit) return;
    panZoom.refit();
    const { z, tx, ty } = panZoom.view;
    const { image, toTex, parts, classes, body } = data;
    const k = fit.k * z;
    const ox = fit.ox * z + tx;
    const oy = fit.oy * z + ty;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, ox, oy, image.width * k, image.height * k);
    const toScreen = ([X, Y]) => {
      const w = toTex[2][0] * X + toTex[2][1] * Y + toTex[2][2];
      return [ox + ((toTex[0][0] * X + toTex[0][1] * Y + toTex[0][2]) / w) * k, oy + ((toTex[1][0] * X + toTex[1][1] * Y + toTex[1][2]) / w) * k];
    };
    // 标签在屏幕上大小不变（放大后零件分开、标签不再互相挤）；窄屏上整体小一号
    drawPartBoxes(ctx, { parts, classes, body, toScreen, width: W, height: H, scale: labelScale(W), avoid: [toolsBox] });
  }

  new ResizeObserver(() => {
    measureTools();
    draw();
  }).observe(canvas);

  return {
    /**
     * @param {{ image: CanvasImageSource & {width:number, height:number}, toTex: number[][], parts: object[],
     *           classes: object[], body: (cls: number) => {minX:number, maxX:number, halfW:number} }} d
     */
    show(d) {
      if (data?.image !== d.image) panZoom.reset(); // 换了照片：回到整图
      data = d;
      root.querySelector('.confirm-source').textContent = d.source ? `来源：${d.source}` : '';
      const counts = countByClass(d.parts, d.classes);
      sum.innerHTML = d.parts.length
        ? `识别到 <b>${d.parts.length}</b> 个元件：` + counts.map((c) => `<span class="confirm-chip" style="--c:${c.color}">${esc(c.name)} × ${c.n}</span>`).join('')
        : '没有识别到元件，可以"修改框选"手动框出来';
      okBtn.textContent = d.canBuild === false ? '确认，查看照片' : d.parts.length ? '确认，开始建模' : '仍然继续';
      draw();
    },
    clear() {
      data = null;
      sum.textContent = '';
      root.querySelector('.confirm-source').textContent = '';
      draw();
    },
    redraw: draw,
  };
}
