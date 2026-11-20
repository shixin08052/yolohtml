// 首页背景：铺满一层很淡的代码，鼠标（或手指）划过的地方字符变亮、乱跳，然后慢慢熄灭。
// 性能：底层代码只画一次到离屏画布；每帧只重画"发热"的那几十个格子，没有发热的格子时停掉 rAF。
import { onThemeChange } from './theme.js';

const SNIPPETS = [
  'const H = homography(src, dst); // 4 个定位码角点 → 底板毫米',
  'for (const det of yolo.run(tensor)) parts.push(toBoard(det, H));',
  'const [q1, q2, q3] = solveIK(arm, { x, y, z: zSafe });',
  'if (clearance(part, neighbors) < GRIP_MM) plan.push(relocate(part));',
  'ctx.drawImage(bitmap, 0, 0, w, h); const img = ctx.getImageData(0, 0, w, h);',
  'const R = rodrigues(rvec); const t = tvec.map((v) => v * scale);',
  'session = await ort.InferenceSession.create(model, { executionProviders });',
  'nms(boxes, scores, { iou: 0.45, conf: 0.25 }).forEach(keep);',
  'const bin = bins[part.cls]; await arm.moveTo(bin.drop, { speed });',
  'markers = aruco.detect(gray).filter((m) => BOARD_IDS.has(m.id));',
  'const theta = Math.atan2(lead.y - body.y, lead.x - body.x);',
  'world.add(new Mesh(partGeometry(cls), material(color)));',
  'export function pinhole(K, [X, Y, Z]) { return [K.fx * X / Z + K.cx, K.fy * Y / Z + K.cy]; }',
  'order = normalizeOrder(await askOrder({ text, reasoningEffort }));',
  'const err = reprojection(H, corners).reduce((s, e) => s + e, 0) / n;',
  'sequence = plan.tasks.sort((a, b) => a.dist - b.dist);',
  'gripper.open(part.width + 4); await arm.descend(part.z + 2);',
  'const lab = rgbToLab(r, g, b); if (lab.a > 20) color = "red";',
  'scene.camera.position.lerp(target, 1 - Math.exp(-dt * 6));',
  'if (!calib.ok) return fail("calib", "没识别到定位码");',
  'const px = mmToPx(part.x, part.y); drawBox(ctx, px, CLASSES[part.cls]);',
  'joints = ik.solve(pose); assert(joints.every(withinLimits));',
  'await Promise.all(samples.map((s) => fetch(s.url).then(toBitmap)));',
  'const zSafe = Math.max(...parts.map((p) => p.h)) + 25;',
];
const SCRAMBLE = '01{}[]()<>=+-*/;:._#$%&|!?~^@abcdefxyzABCDEF';
const FONT_PX = 12;
const LINE_PX = 18;
const RADIUS = 84;
const BLOCK = 72; // 每一列代码块的宽度（字符）

/**
 * @param {HTMLElement} host 背景所在的容器（需要 position: relative/absolute）
 * @returns {{ destroy(): void, setActive(on: boolean): void }}
 */
export function createCodeField(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'code-field';
  canvas.setAttribute('aria-hidden', 'true');
  host.prepend(canvas);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return { destroy() { canvas.remove(); }, setActive() {} };

  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let dpr = 1;
  let cw = 7.2;
  let cols = 0;
  let rows = 0;
  let text = []; // 每行的原始字符
  let heat = new Float32Array(0);
  let glyph = new Uint16Array(0); // 0 = 用原字符
  const hot = new Set();
  let raf = 0;
  let last = 0;
  let prev = null;
  let active = true;
  let colors = { text: '#1f1e1d', accent: '#c96442' };
  const font = `${FONT_PX}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace'}`;

  function readColors() {
    const cs = getComputedStyle(host);
    colors = {
      text: cs.getPropertyValue('--text').trim() || colors.text,
      accent: cs.getPropertyValue('--accent').trim() || colors.accent,
    };
  }

  function layout() {
    const { width, height } = host.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, base]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    for (const c of [ctx, bctx]) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.font = font;
      c.textBaseline = 'middle';
    }
    cw = ctx.measureText('M').width || 7.2;
    cols = Math.ceil(width / cw) + 1;
    rows = Math.ceil(height / LINE_PX) + 1;
    text = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let b = 0; line.length < cols; b++) {
        const src = SNIPPETS[(r * 5 + b * 11) % SNIPPETS.length];
        const indent = ' '.repeat(((r + b) % 3) * 2);
        line += (indent + src).padEnd(BLOCK, ' ').slice(0, BLOCK);
      }
      text.push(line.slice(0, cols));
    }
    heat = new Float32Array(cols * rows);
    glyph = new Uint16Array(cols * rows);
    hot.clear();
    readColors();
    paintBase();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, base.width / dpr, base.height / dpr);
  }

  function paintBase() {
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.fillStyle = colors.text;
    bctx.globalAlpha = 0.045;
    for (let r = 0; r < rows; r++) bctx.fillText(text[r], 0, r * LINE_PX + LINE_PX / 2);
    bctx.globalAlpha = 1;
  }

  function warm(x, y) {
    const c0 = Math.max(0, Math.floor((x - RADIUS) / cw));
    const c1 = Math.min(cols - 1, Math.ceil((x + RADIUS) / cw));
    const r0 = Math.max(0, Math.floor((y - RADIUS) / LINE_PX));
    const r1 = Math.min(rows - 1, Math.ceil((y + RADIUS) / LINE_PX));
    for (let r = r0; r <= r1; r++) {
      const dy = r * LINE_PX + LINE_PX / 2 - y;
      for (let c = c0; c <= c1; c++) {
        if (text[r][c] === ' ' && Math.random() > 0.18) continue; // 空白处偶尔也冒出字符
        const dx = c * cw + cw / 2 - x;
        const d = Math.hypot(dx, dy);
        if (d > RADIUS) continue;
        const i = r * cols + c;
        const h = (1 - d / RADIUS) ** 1.6;
        if (h > heat[i]) heat[i] = h;
        hot.add(i);
      }
    }
  }

  function onMove(e) {
    if (!active) return;
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 快速划过时在两点之间补几个点，轨迹不断
    if (prev) {
      const steps = Math.min(8, Math.floor(Math.hypot(x - prev.x, y - prev.y) / (RADIUS / 3)));
      for (let s = 1; s <= steps; s++) warm(prev.x + ((x - prev.x) * s) / (steps + 1), prev.y + ((y - prev.y) * s) / (steps + 1));
    }
    warm(x, y);
    prev = { x, y };
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  const onLeave = () => { prev = null; };

  function frame(now) {
    const dt = Math.min(64, now - last) / 16.7;
    last = now;
    const decay = 0.95 ** dt;
    // 先把上一帧画过的格子恢复成底层
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.drawImage(base, 0, 0, base.width / dpr, base.height / dpr);
    for (const i of hot) {
      const h = heat[i] * decay;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (h < 0.03) {
        heat[i] = 0;
        glyph[i] = 0;
        hot.delete(i);
        continue;
      }
      heat[i] = h;
      if (Math.random() < h * 0.32 * dt) glyph[i] = SCRAMBLE.charCodeAt((Math.random() * SCRAMBLE.length) | 0);
      else if (Math.random() < 0.04 * dt) glyph[i] = 0;
      const ch = glyph[i] ? String.fromCharCode(glyph[i]) : text[r][c];
      const x = c * cw;
      const y = r * LINE_PX;
      ctx.clearRect(x, y, cw, LINE_PX);
      if (ch === ' ') continue;
      ctx.globalAlpha = Math.min(1, 0.12 + h * 0.95);
      ctx.fillStyle = h > 0.8 ? colors.text : colors.accent;
      ctx.fillText(ch, x, y + LINE_PX / 2);
    }
    ctx.globalAlpha = 1;
    raf = hot.size ? requestAnimationFrame(frame) : 0;
  }

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layout());
  ro?.observe(host);
  const onScheme = () => { readColors(); paintBase(); layout(); };
  const offTheme = onThemeChange(onScheme);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  layout();

  return {
    /** 首页被盖住 / 隐藏时停掉 */
    setActive(on) {
      active = on;
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        prev = null;
      } else layout();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      offTheme();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      canvas.remove();
    },
  };
}
