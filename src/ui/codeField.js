// 首页背景：铺满一层很淡的视觉与运动学代码。
// 默认按"对角扫描流 + 逐行执行脉冲"规律局部闪动（同一时刻只有少数代码片段流光跳字，其余保持静默）；
// 电脑端鼠标划过或停驻的区域会形成"静默稳定区"——鼠标经过的位置立即停止闪动、恢复为静止代码。
// 性能：底层代码只画一次到离屏画布；每帧只重画当前发热的那几十个字符，进入工作台或切到后台时完全停掉 rAF。
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
const CALM_RADIUS = 96; // 电脑鼠标划过时的静默半径（px）
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
  let calm = new Float32Array(0); // 鼠标划过的静默抑制强度 [0..1]
  let glyph = new Uint16Array(0); // 0 = 用原字符
  const hot = new Set();
  const calmed = new Set();
  /** 规律游走的代码流脉冲：{ row: number, col: number, speed: number, span: number, peak: number }[] */
  let pulses = [];
  let rowCursor = 0;
  let raf = 0;
  let last = 0;
  let prevMouse = null;
  let hoverMouse = null;
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

  /** 生成一条新的游走脉冲：按黄金分割步进挑选行号，使闪动均匀错落分布在画面不同高度 */
  function spawnPulse(k, initial = false) {
    if (!rows || !cols) return null;
    rowCursor = (rowCursor + 7) % rows;
    const row = (rowCursor + k * 3) % rows;
    const span = 8 + (row % 5) * 2; // 脉冲宽度 8~16 个字符
    const speed = 0.24 + ((row * 13 + k * 7) % 11) * 0.022; // 每帧推进字符数
    const col = initial ? ((row * 19 + k * 23) % Math.max(1, cols)) : -2;
    const peak = 0.68 + ((row + k) % 4) * 0.08;
    return { row, col, speed, span, peak };
  }

  function initPulses() {
    pulses = [];
    if (!rows || !cols) return;
    // 同一时刻只保留 6~9 条局部代码流脉冲，绝不全屏乱闪
    const count = Math.max(5, Math.min(9, Math.round(rows / 4.2)));
    for (let k = 0; k < count; k++) {
      const p = spawnPulse(k, true);
      if (p) pulses.push(p);
    }
  }

  function startLoop() {
    if (!raf && active && !document.hidden && cols > 0 && rows > 0) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function layout() {
    const { width, height } = host.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    dpr = Math.min(1.75, window.devicePixelRatio || 1);
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
    calm = new Float32Array(cols * rows);
    glyph = new Uint16Array(cols * rows);
    hot.clear();
    calmed.clear();
    initPulses();
    readColors();
    paintBase();
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.drawImage(base, 0, 0, base.width / dpr, base.height / dpr);
    startLoop();
  }

  function paintBase() {
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.fillStyle = colors.text;
    bctx.globalAlpha = 0.055;
    for (let r = 0; r < rows; r++) bctx.fillText(text[r], 0, r * LINE_PX + LINE_PX / 2);
    bctx.globalAlpha = 1;
  }

  /** 将电脑鼠标所在半径内的字符置为"静默"，立即停止闪动并还原为原始代码字符 */
  function pacify(x, y) {
    if (!cols || !rows) return;
    const c0 = Math.max(0, Math.floor((x - CALM_RADIUS) / cw));
    const c1 = Math.min(cols - 1, Math.ceil((x + CALM_RADIUS) / cw));
    const r0 = Math.max(0, Math.floor((y - CALM_RADIUS) / LINE_PX));
    const r1 = Math.min(rows - 1, Math.ceil((y + CALM_RADIUS) / LINE_PX));
    for (let r = r0; r <= r1; r++) {
      const dy = r * LINE_PX + LINE_PX / 2 - y;
      for (let c = c0; c <= c1; c++) {
        const dx = c * cw + cw / 2 - x;
        const d = Math.hypot(dx, dy);
        if (d > CALM_RADIUS) continue;
        const i = r * cols + c;
        const strength = (1 - d / CALM_RADIUS) ** 0.75;
        if (strength >= calm[i]) calm[i] = 1;
        calmed.add(i);
        if (heat[i] > 0) {
          heat[i] = 0;
          glyph[i] = 0;
          hot.delete(i);
        }
      }
    }
  }

  function onMove(e) {
    if (!active || e.pointerType === 'touch') return;
    const rect = host.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (prevMouse) {
      const steps = Math.min(8, Math.floor(Math.hypot(x - prevMouse.x, y - prevMouse.y) / (CALM_RADIUS / 3)));
      for (let s = 1; s <= steps; s++) {
        pacify(prevMouse.x + ((x - prevMouse.x) * s) / (steps + 1), prevMouse.y + ((y - prevMouse.y) * s) / (steps + 1));
      }
    }
    pacify(x, y);
    prevMouse = { x, y };
    hoverMouse = { x, y };
    startLoop();
  }

  const onLeave = () => {
    prevMouse = null;
    hoverMouse = null;
  };

  /** 推进规律代码流脉冲，激活经过的非空格代码字符（避开鼠标静默区） */
  function stepPulses(dt, now) {
    // 对角相位波：让不同位置的脉冲呈现呼吸起伏的规律感
    const wavePhase = now * 0.0022;
    for (let k = 0; k < pulses.length; k++) {
      const p = pulses[k];
      const prevCol = p.col;
      p.col += p.speed * dt;
      if (p.col - p.span > cols + 2) {
        pulses[k] = spawnPulse(k, false) ?? p;
        continue;
      }
      const r = p.row;
      const line = text[r];
      if (!line) continue;
      const cStart = Math.max(0, Math.floor(prevCol - 2));
      const cEnd = Math.min(cols - 1, Math.ceil(p.col));
      const diagWave = 0.72 + 0.28 * Math.sin(wavePhase + r * 0.55 - p.col * 0.07);
      for (let c = cStart; c <= cEnd; c++) {
        if (line[c] === ' ') continue;
        const i = r * cols + c;
        // 电脑鼠标划过或停驻的静默区不闪动
        if (calm[i] > 0.08) continue;
        const distBehind = Math.max(0, p.col - c);
        if (distBehind > p.span) continue;
        const envelope = (1 - distBehind / p.span) ** 1.35;
        const h = p.peak * diagWave * envelope * (1 - calm[i]);
        if (h > heat[i]) {
          heat[i] = h;
          // 脉冲前端刚扫过时短暂跳变字符，随后恢复原代码字符
          if (distBehind < 2.2 && ((r * 31 + c * 17 + ((now * 0.03) | 0)) % 3 === 0)) {
            glyph[i] = SCRAMBLE.charCodeAt((r * 13 + c * 29 + ((now * 0.05) | 0)) % SCRAMBLE.length);
          }
          hot.add(i);
        }
      }
    }
  }

  function frame(now) {
    raf = 0;
    if (!active || document.hidden) return;
    const dt = Math.min(64, now - last) / 16.7;
    last = now;

    // 鼠标悬停处持续保持静默；鼠标移开后的轨迹在约 1.4 秒内平滑恢复闪动
    if (hoverMouse) pacify(hoverMouse.x, hoverMouse.y);
    const calmDecay = 0.962 ** dt;
    for (const i of calmed) {
      if (hoverMouse) {
        const r = (i / cols) | 0;
        const c = i - r * cols;
        const d = Math.hypot(c * cw + cw / 2 - hoverMouse.x, r * LINE_PX + LINE_PX / 2 - hoverMouse.y);
        if (d <= CALM_RADIUS * 0.85) continue;
      }
      const next = calm[i] * calmDecay;
      if (next < 0.04) {
        calm[i] = 0;
        calmed.delete(i);
      } else {
        calm[i] = next;
      }
    }

    stepPulses(dt, now);

    const decay = 0.935 ** dt;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.drawImage(base, 0, 0, base.width / dpr, base.height / dpr);
    for (const i of hot) {
      if (calm[i] > 0.15) {
        heat[i] = 0;
        glyph[i] = 0;
        hot.delete(i);
        continue;
      }
      const h = heat[i] * decay;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (h < 0.04) {
        heat[i] = 0;
        glyph[i] = 0;
        hot.delete(i);
        continue;
      }
      heat[i] = h;
      if (h > 0.52 && Math.random() < h * 0.18 * dt) {
        glyph[i] = SCRAMBLE.charCodeAt((Math.random() * SCRAMBLE.length) | 0);
      } else if (h < 0.42 || Math.random() < 0.12 * dt) {
        glyph[i] = 0;
      }
      const ch = glyph[i] ? String.fromCharCode(glyph[i]) : text[r][c];
      const x = c * cw;
      const y = r * LINE_PX;
      ctx.clearRect(x, y, cw, LINE_PX);
      if (ch === ' ') continue;
      ctx.globalAlpha = Math.min(0.92, 0.1 + h * 0.82);
      ctx.fillStyle = h > 0.76 ? colors.text : colors.accent;
      ctx.fillText(ch, x, y + LINE_PX / 2);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  const onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      startLoop();
    }
  };

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layout());
  ro?.observe(host);
  const onScheme = () => { readColors(); paintBase(); layout(); };
  const offTheme = onThemeChange(onScheme);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', onVis);
  layout();

  return {
    /** 首页被盖住 / 隐藏时停掉 */
    setActive(on) {
      active = on;
      if (!on) {
        cancelAnimationFrame(raf);
        raf = 0;
        prevMouse = null;
        hoverMouse = null;
      } else {
        layout();
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      offTheme();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      canvas.remove();
    },
  };
}
