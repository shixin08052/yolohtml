// 画布上的缩放 / 平移（演示模式的正视图用）。
// 内容先按比例放进画布（fit：左上角 ox, oy，大小 w × h，CSS 像素），再叠加用户的缩放和平移：
//   屏幕坐标 = fit 坐标 × z + (tx, ty)
// - 鼠标：滚轮缩放（以光标为中心）、拖动平移、双击放大 / 复位
// - 触屏：双指捏合缩放、单指拖动平移、双击放大 / 复位
// clampView、zoomAt 是纯函数（便于测试）；createPanZoom 负责指针事件。

export const ZOOM_MAX = 8;

/**
 * 把视图限制在合理范围：缩放 1–8 倍；内容比画布小的方向居中，比画布大的方向不能拖出空白
 * @param {{ z: number, tx: number, ty: number }} v
 * @param {{ ox: number, oy: number, w: number, h: number }} fit
 * @param {number} W 画布宽（CSS 像素）
 * @param {number} H
 */
export function clampView(v, fit, W, H) {
  const z = Math.min(ZOOM_MAX, Math.max(1, v.z));
  const axis = (t, o, size, full) => {
    const len = size * z;
    if (len <= full) return (full - len) / 2 - o * z;
    return Math.min(-o * z, Math.max(full - (o + size) * z, t));
  };
  return { z, tx: axis(v.tx, fit.ox, fit.w, W), ty: axis(v.ty, fit.oy, fit.h, H) };
}

/** 以屏幕上的点 (mx, my) 为中心缩放到 z（该点下的内容不动） */
export function zoomAt(v, mx, my, z) {
  const nz = Math.min(ZOOM_MAX, Math.max(1, z));
  const k = nz / v.z;
  return { z: nz, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ getFit: () => ({ox:number, oy:number, w:number, h:number}|null), onChange: () => void }} deps
 */
export function createPanZoom(canvas, { getFit, onChange }) {
  let view = { z: 1, tx: 0, ty: 0 };
  const size = () => [canvas.clientWidth, canvas.clientHeight];

  function set(next) {
    const fit = getFit();
    if (!fit) return;
    const [W, H] = size();
    view = clampView(next, fit, W, H);
    canvas.style.cursor = view.z > 1.001 ? 'grab' : '';
    onChange();
  }
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!getFit()) return;
      e.preventDefault();
      const [mx, my] = local(e);
      set(zoomAt(view, mx, my, view.z * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false },
  );

  /** @type {Map<number, {x:number, y:number}>} 按下的指针（画布内坐标） */
  const pointers = new Map();
  let pan = null; // { x, y, view }
  let pinch = null; // { dist, mid, view }
  const two = () => [...pointers.values()].slice(0, 2);
  const startPan = () => {
    const [p] = pointers.values();
    pan = { x: p.x, y: p.y, view };
    pinch = null;
  };
  const startPinch = () => {
    const [a, b] = two();
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], view };
    pan = null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!getFit() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size >= 2) startPinch();
    else startPan();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size >= 2) {
      const [a, b] = two();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      // 捏合开始时两指中点下的内容，跟着当前中点走
      const z = zoomAt(pinch.view, pinch.mid[0], pinch.mid[1], pinch.view.z * (dist / pinch.dist));
      set({ z: z.z, tx: z.tx + mid[0] - pinch.mid[0], ty: z.ty + mid[1] - pinch.mid[1] });
    } else if (pan) {
      set({ z: pan.view.z, tx: pan.view.tx + x - pan.x, ty: pan.view.ty + y - pan.y });
    }
  });

  /** 双击：没放大时以该点放大，已放大时复位 */
  const toggleAt = (mx, my) => set(view.z > 1.001 ? { z: 1, tx: 0, ty: 0 } : zoomAt(view, mx, my, 2.5));
  let lastTap = null; // { t, x, y }
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const start = pan && pointers.size === 1 ? pan : null;
    const [x, y] = local(e);
    pointers.delete(e.pointerId);
    if (pointers.size >= 2) startPinch();
    else if (pointers.size === 1) startPan();
    else {
      pan = null;
      pinch = null;
      // 触屏上浏览器不一定发 dblclick，自己判断两次轻点
      if (e.type === 'pointerup' && e.pointerType !== 'mouse' && start && Math.hypot(x - start.x, y - start.y) < 10) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
          lastTap = null;
          toggleAt(x, y);
        } else lastTap = { t: now, x, y };
      }
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => toggleAt(...local(e)));

  return {
    get view() {
      return view;
    },
    /** 画布大小或内容变了：保持缩放，重新限制范围（不触发 onChange） */
    refit() {
      const fit = getFit();
      if (!fit) return;
      const [W, H] = size();
      view = clampView(view, fit, W, H);
    },
    reset() {
      view = { z: 1, tx: 0, ty: 0 };
      canvas.style.cursor = '';
      onChange();
    },
    /** 以画布中心缩放 k 倍 */
    zoomBy(k) {
      const [W, H] = size();
      set(zoomAt(view, W / 2, H / 2, view.z * k));
    },
  };
}
