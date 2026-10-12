// 调试视图：2D canvas，显示原图并在上面画叠加层。
// 叠加层以"原图像素坐标"绘制，视图负责缩放与平移：滚轮缩放（以光标为中心）、拖动平移、双击复位。
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
    const pad = 16 * dpr();
    const s = Math.min((canvas.width - 2 * pad) / image.width, (canvas.height - 2 * pad) / image.height);
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

  // 滚轮缩放（以光标为中心）
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!image) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) * dpr();
      const my = (e.clientY - r.top) * dpr();
      const ix = (mx - view.tx) / view.s;
      const iy = (my - view.ty) / view.s;
      const k = Math.exp(-e.deltaY * 0.0015);
      const minS = Math.min(canvas.width / image.width, canvas.height / image.height) * 0.5;
      view.s = Math.min(40, Math.max(minS, view.s * k));
      view.tx = mx - ix * view.s;
      view.ty = my - iy * view.s;
      draw();
    },
    { passive: false },
  );

  // 拖动平移
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!image || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.tx = drag.tx + (e.clientX - drag.x) * dpr();
    view.ty = drag.ty + (e.clientY - drag.y) * dpr();
    draw();
  });
  const endDrag = () => {
    drag = null;
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
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
    redraw: draw,
    resize,
    /** 当前视图变换（测试用） */
    get view() {
      return { ...view };
    },
  };
}
