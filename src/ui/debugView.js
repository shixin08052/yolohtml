// 调试视图：2D canvas，显示原图并在上面画叠加层。
// 叠加层以"原图像素坐标"绘制，视图负责缩放与平移：
// - 鼠标：滚轮缩放（以光标为中心）、拖动平移、双击复位
// - 触屏：双指捏合缩放（以两指中点为中心）、单指拖动平移、双击复位
// - 也可以调用 zoomBy / reset（界面上的 − ＋ 复位按钮）
import { cssVar, onThemeChange } from './theme.js';

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createDebugView(canvas) {
  const ctx = canvas.getContext('2d');
  /** @type {ImageBitmap|HTMLCanvasElement|null} */
  let image = null;
  /** @type {Map<string, (ctx: CanvasRenderingContext2D, scale: number, dpr: number) => void>} */
  const overlays = new Map();
  // 视图变换：画布像素 = 原图像素 × s + (tx, ty)
  const view = { s: 1, tx: 0, ty: 0, fitted: false };
  const dpr = () => window.devicePixelRatio || 1;

  function fit() {
    if (!image) return;
    // 留边不超过画布的 1/8；布局过程中画布可能只有几个像素高，不能让缩放比变成负数
    const pad = Math.min(16 * dpr(), canvas.width / 8, canvas.height / 8);
    const s = Math.min((canvas.width - 2 * pad) / image.width, (canvas.height - 2 * pad) / image.height);
    if (!(s > 0)) return;
    view.s = s;
    view.tx = (canvas.width - image.width * s) / 2;
    view.ty = (canvas.height - image.height * s) / 2;
    view.fitted = true;
  }

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr()));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr()));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (view.fitted) fit();
    }
    draw();
  }

  function draw() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar('--canvas-bg');
    ctx.fillRect(0, 0, W, H);

    if (!image) {
      ctx.fillStyle = cssVar('--canvas-hint');
      ctx.font = `${14 * dpr()}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('请上传照片，或从右上角加载示例', W / 2, H / 2);
      return;
    }
    if (!view.fitted) fit();
    if (!view.fitted) return; // 画布太小，等下一次尺寸变化
    ctx.setTransform(view.s, 0, 0, view.s, view.tx, view.ty);
    // 放大很多时关掉平滑，便于看清像素
    ctx.imageSmoothingEnabled = view.s < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
    for (const fn of overlays.values()) {
      ctx.save();
      fn(ctx, view.s, dpr());
      ctx.restore();
    }
  }

  /** 视图缩放范围：最小为整图的一半，最大 40 倍 */
  const clampScale = (sc) => {
    const minS = Math.min(canvas.width / image.width, canvas.height / image.height) * 0.5;
    return Math.min(40, Math.max(minS, sc));
  };

  /** 以画布上的点 (mx, my)（设备像素）为中心缩放到 newS */
  function zoomAt(mx, my, newS) {
    const ix = (mx - view.tx) / view.s;
    const iy = (my - view.ty) / view.s;
    view.s = clampScale(newS);
    view.tx = mx - ix * view.s;
    view.ty = my - iy * view.s;
    draw();
  }

  /** 客户端坐标 → 画布设备像素 */
  const toCanvas = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) * dpr(), (clientY - r.top) * dpr()];
  };

  // 滚轮缩放（以光标为中心）
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!image) return;
      e.preventDefault();
      const [mx, my] = toCanvas(e.clientX, e.clientY);
      zoomAt(mx, my, view.s * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // 指针：单指 / 鼠标拖动平移，双指捏合缩放
  /** @type {Map<number, {x:number, y:number}>} 当前按下的指针（客户端坐标） */
  const pointers = new Map();
  let pan = null; // { x, y, tx, ty }
  let pinch = null; // { dist, mid: [x, y], s, tx, ty }

  const twoPointers = () => [...pointers.values()].slice(0, 2);
  function startPinch() {
    const [a, b] = twoPointers();
    const mid = toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid, s: view.s, tx: view.tx, ty: view.ty };
    pan = null;
  }
  function startPan() {
    const [p] = pointers.values();
    pan = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
    pinch = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!image || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size >= 2) startPinch();
    else startPan();
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = twoPointers();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
      // 捏合开始时两指中点下的原图点，跟随当前中点移动
      const ix = (pinch.mid[0] - pinch.tx) / pinch.s;
      const iy = (pinch.mid[1] - pinch.ty) / pinch.s;
      view.s = clampScale(pinch.s * (dist / pinch.dist));
      view.tx = mid[0] - ix * view.s;
      view.ty = mid[1] - iy * view.s;
      draw();
    } else if (pan) {
      view.tx = pan.tx + (e.clientX - pan.x) * dpr();
      view.ty = pan.ty + (e.clientY - pan.y) * dpr();
      draw();
    }
  });

  // 双击 / 双指轻点后的双击：自己判断，触屏上浏览器不一定发 dblclick
  let lastTap = null; // { t, x, y }
  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const start = pan && pointers.size === 1 ? pan : null;
    pointers.delete(e.pointerId);
    if (pointers.size >= 2) startPinch();
    else if (pointers.size === 1) startPan();
    else {
      pan = null;
      pinch = null;
      canvas.style.cursor = '';
      // 轻点（几乎没移动）才算一次点击
      if (e.pointerType !== 'mouse' && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = null;
          fit();
          draw();
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      }
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('dblclick', () => {
    fit();
    draw();
  });

  new ResizeObserver(resize).observe(canvas);
  onThemeChange(draw);

  return {
    /** 设置底图（会复位视图） */
    setImage(img) {
      image = img;
      view.fitted = false;
      draw();
    },
    /**
     * 设置 / 替换一个叠加层；fn 为 null 时移除。
     * fn(ctx, scale, dpr)：ctx 已处于原图像素坐标，scale 为当前缩放比
     */
    setOverlay(key, fn) {
      if (fn) overlays.set(key, fn);
      else overlays.delete(key);
      draw();
    },
    /** 复位到整图显示 */
    reset() {
      fit();
      draw();
    },
    /** 以画布中心缩放 k 倍 */
    zoomBy(k) {
      if (!image) return;
      zoomAt(canvas.width / 2, canvas.height / 2, view.s * k);
    },
    redraw: draw,
    resize,
    /** 当前视图变换（测试用） */
    get view() {
      return { ...view };
    },
  };
}
