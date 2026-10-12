// 调试视图：2D canvas，显示原图并在上面画叠加层。
// 叠加层以"原图像素坐标"绘制，视图负责等比缩放居中。
import { cssVar, onThemeChange } from './theme.js';

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createDebugView(canvas) {
  const ctx = canvas.getContext('2d');
  /** @type {ImageBitmap|HTMLCanvasElement|null} */
  let image = null;
  /** @type {((ctx: CanvasRenderingContext2D, scale: number) => void)[]} */
  const overlays = [];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
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
      const dpr = window.devicePixelRatio || 1;
      ctx.fillStyle = cssVar('--canvas-hint');
      ctx.font = `${14 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('请上传照片，或从右上角加载示例', W / 2, H / 2);
      return;
    }

    // 等比缩放、居中，留 16 px 边距
    const pad = 16 * (window.devicePixelRatio || 1);
    const s = Math.min((W - 2 * pad) / image.width, (H - 2 * pad) / image.height);
    const ox = (W - image.width * s) / 2;
    const oy = (H - image.height * s) / 2;
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
    for (const fn of overlays) {
      ctx.save();
      fn(ctx, s);
      ctx.restore();
    }
  }

  new ResizeObserver(resize).observe(canvas);
  onThemeChange(draw);

  return {
    /** 设置底图 */
    setImage(img) {
      image = img;
      draw();
    },
    /** 添加叠加层绘制函数（参数为原图像素坐标系下的 ctx 和当前缩放比） */
    addOverlay(fn) {
      overlays.push(fn);
      draw();
      return () => {
        const i = overlays.indexOf(fn);
        if (i >= 0) overlays.splice(i, 1);
        draw();
      };
    },
    redraw: draw,
    resize,
  };
}
