// 手动框选工具：在调试视图上拖出矩形框、选类别、移动 / 拉伸、删除。
// 坐标一律为原图像素。作为 debugView 的指针工具使用（setTool(editor.tool)）。
import { CLASSES } from '../config.js';

/** 新框的最小边长（画布像素）；拖得比这还短算一次点击 */
const MIN_DRAG_PX = 6;

/**
 * 画检测框：类别颜色的矩形 + 左上角"类别 置信度"标签；选中的框加粗并画四角手柄
 * @param {CanvasRenderingContext2D} ctx 已处于原图像素坐标
 * @param {import('../state.js').Detection[]} boxes
 * @param {number} scale
 * @param {number} dpr
 * @param {{ selected?: number, draft?: number[]|null, showScore?: boolean }} [opts]
 */
export function drawDetections(ctx, boxes, scale, dpr = 1, { selected = -1, draft = null, showScore = true } = {}) {
  const lw = (1.75 * dpr) / scale;
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'bottom';
  const fs = (11.5 * dpr) / scale;
  ctx.font = `600 ${fs}px sans-serif`;
  boxes.forEach((d, i) => {
    const [x1, y1, x2, y2] = d.box;
    const color = CLASSES[d.cls]?.color ?? '#c96442';
    const sel = i === selected;
    ctx.lineWidth = sel ? lw * 1.8 : lw;
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    if (sel) {
      ctx.fillStyle = `${color}22`;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }
    const text = `${CLASSES[d.cls]?.name ?? d.name ?? d.cls}${showScore && d.score < 1 ? ` ${d.score.toFixed(2)}` : ''}`;
    const tw = ctx.measureText(text).width;
    const pad = 3 * dpr / scale;
    ctx.fillStyle = color;
    ctx.fillRect(x1 - ctx.lineWidth / 2, y1 - fs - 2 * pad, tw + 2 * pad, fs + 2 * pad);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x1 + pad - ctx.lineWidth / 2, y1 - pad);
    if (sel) {
      const h = (4 * dpr) / scale;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      for (const [x, y] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) {
        ctx.fillRect(x - h, y - h, 2 * h, 2 * h);
        ctx.strokeRect(x - h, y - h, 2 * h, 2 * h);
      }
    }
  });
  if (draft) {
    const [x1, y1, x2, y2] = draft;
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#c96442';
    ctx.setLineDash([6 * dpr / scale, 4 * dpr / scale]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.setLineDash([]);
  }
}

/**
 * @param {{
 *   getScale: () => number,                 // 当前视图缩放比（原图 1 像素 = 多少画布像素）
 *   dpr?: () => number,
 *   redraw: () => void,
 *   onChange: (boxes: import('../state.js').Detection[]) => void,  // 框增删改后
 *   onSelect?: (index: number) => void,
 *   imageSize: () => {width:number, height:number}|null,
 * }} deps
 */
export function createBoxEditor({ getScale, dpr = () => window.devicePixelRatio || 1, redraw, onChange, onSelect = () => {}, imageSize }) {
  /** @type {import('../state.js').Detection[]} */
  let boxes = [];
  let selected = -1;
  let cls = 0;
  /** 拖动状态：{ kind: 'new'|'move'|'resize', start: [x, y], orig?: number[], corner?: number, cur: [x, y] } */
  let drag = null;

  /** 手柄判定半径（原图像素） */
  const tol = () => (10 * dpr()) / getScale();
  const clampPt = ([x, y]) => {
    const sz = imageSize();
    if (!sz) return [x, y];
    return [Math.min(sz.width, Math.max(0, x)), Math.min(sz.height, Math.max(0, y))];
  };
  const normBox = ([a, b, c, d]) => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];

  function select(i) {
    selected = i;
    if (i >= 0) cls = boxes[i].cls;
    onSelect(i);
    redraw();
  }

  /** 命中测试：先看选中框的四角，再看点落在哪个框里（取面积最小的） */
  function hit(x, y) {
    if (selected >= 0) {
      const [x1, y1, x2, y2] = boxes[selected].box;
      const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      const t = tol();
      const k = corners.findIndex(([cx, cy]) => Math.abs(cx - x) <= t && Math.abs(cy - y) <= t);
      if (k >= 0) return { kind: 'resize', index: selected, corner: k };
    }
    let best = -1;
    let bestArea = Infinity;
    boxes.forEach((d, i) => {
      const [x1, y1, x2, y2] = d.box;
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
        const a = (x2 - x1) * (y2 - y1);
        if (a < bestArea) {
          bestArea = a;
          best = i;
        }
      }
    });
    return best >= 0 ? { kind: 'move', index: best } : null;
  }

  const tool = {
    cursor: 'crosshair',
    down(x, y) {
      const h = hit(x, y);
      if (h) {
        if (h.index !== selected) select(h.index);
        drag = { kind: h.kind, start: [x, y], cur: [x, y], orig: [...boxes[h.index].box], corner: h.corner, moved: false };
      } else {
        drag = { kind: 'new', start: clampPt([x, y]), cur: clampPt([x, y]) };
      }
      return true;
    },
    move(x, y) {
      if (!drag) return;
      drag.cur = clampPt([x, y]);
      if (drag.kind === 'move' || drag.kind === 'resize') {
        const dx = drag.cur[0] - drag.start[0];
        const dy = drag.cur[1] - drag.start[1];
        if (!drag.moved && Math.hypot(dx, dy) * getScale() < MIN_DRAG_PX) return;
        drag.moved = true;
        const o = drag.orig;
        let b;
        if (drag.kind === 'move') {
          b = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy];
        } else {
          // 拖动的角跟随指针，对角固定
          const opp = [[o[2], o[3]], [o[0], o[3]], [o[0], o[1]], [o[2], o[1]]][drag.corner];
          b = normBox([opp[0], opp[1], drag.cur[0], drag.cur[1]]);
        }
        boxes[selected] = { ...boxes[selected], box: b };
      }
      redraw();
    },
    up(x, y) {
      if (!drag) return;
      tool.move(x, y);
      const d = drag;
      drag = null;
      if (d.kind === 'new') {
        const [x1, y1, x2, y2] = normBox([...d.start, ...d.cur]);
        if (Math.min(x2 - x1, y2 - y1) * getScale() < MIN_DRAG_PX) {
          select(-1); // 点在空白处：取消选中
          return;
        }
        boxes.push({ cls, name: CLASSES[cls].name, score: 1, box: [x1, y1, x2, y2] });
        select(boxes.length - 1);
        onChange(boxes.slice());
      } else if (d.moved) {
        redraw();
        onChange(boxes.slice());
      }
    },
    cancel() {
      if (drag && drag.kind !== 'new' && drag.moved) boxes[selected] = { ...boxes[selected], box: drag.orig };
      drag = null;
      redraw();
    },
  };

  return {
    tool,
    /** 叠加层绘制函数（交给 debugView.setOverlay） */
    draw(ctx, scale, dpr_) {
      const draft = drag?.kind === 'new' ? [...drag.start, ...drag.cur] : null;
      drawDetections(ctx, boxes, scale, dpr_, { selected, draft });
    },
    /** 换一组框（例如载入文件、换照片）；会取消选中 */
    setBoxes(list) {
      boxes = list.map((d) => ({ ...d, box: [...d.box] }));
      drag = null;
      select(-1);
    },
    getBoxes: () => boxes.slice(),
    get selected() {
      return selected;
    },
    get cls() {
      return cls;
    },
    /** 设置新框的类别；有选中框时同时改它的类别 */
    setClass(c) {
      cls = c;
      if (selected >= 0 && boxes[selected].cls !== c) {
        boxes[selected] = { ...boxes[selected], cls: c, name: CLASSES[c].name };
        redraw();
        onChange(boxes.slice());
      }
    },
    deleteSelected() {
      if (selected < 0) return;
      boxes.splice(selected, 1);
      select(-1);
      onChange(boxes.slice());
    },
    clear() {
      if (!boxes.length) return;
      boxes = [];
      select(-1);
      onChange([]);
    },
  };
}
