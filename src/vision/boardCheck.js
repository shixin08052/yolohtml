// 打印检查：根据照片判断打印出来的标定板是否正确（纯函数，不碰 DOM）。
// 1. 码的版面：用全部角点拟合单应性 H，再用 Hinv 把每个角点映射回底板坐标，与设计值比较。
//    能发现缺码、码的位置 / 大小 / 朝向不对。但整页的缩放（等比或横竖不等）是仿射变换，
//    会被 H 完全吸收，单看码发现不了。
// 2. 打印比例：标定板设计尺寸 = A4 纸张，沿 4 条纸边在底板坐标系里测出纸的宽和高，
//    与 297 × 210 之比就是实际打印比例。打印机把内容整体平移不影响宽高。
import { BOARD } from '../config.js';
import { VALID_IDS } from './aruco.js';
import { markerCornersWorld } from './boardLayout.js';
import { solveHomography, applyH, invert3, reprojError } from './homography.js';

/** 判定阈值 */
export const CHECK_LIMITS = {
  // 真实照片里纸张不完全平整，即使打印正确，偏差也常到 1 mm 左右；
  // 印错 / 位置不对的码偏差通常有好几毫米
  okMm: 1.5,      // 角点最大偏差（mm）不超过此值：版面正确
  warnMm: 3.0,    // 超过 okMm、不超过此值：基本正确但偏差偏大
  okScale: 0.01,  // 打印比例与 100% 相差不超过 1%：正确
  warnScale: 0.02, // 1%–2%：提醒；超过 2%：比例不对
};

/** RGBA 图像在 (u, v) 处的亮度（双线性插值）；超出图像返回 null */
function lumaAt(img, u, v) {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return null;
  const fx = x - x0;
  const fy = y - y0;
  const L = (xx, yy) => {
    const p = (yy * img.width + xx) * 4;
    return 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
  };
  return (
    L(x0, y0) * (1 - fx) * (1 - fy) + L(x0 + 1, y0) * fx * (1 - fy) +
    L(x0, y0 + 1) * (1 - fx) * fy + L(x0 + 1, y0 + 1) * fx * fy
  );
}

/** 纸边的名称：用版面上的文字和码来指代，照片怎么旋转都不会混淆 */
export const EDGE_NAMES = {
  bottom: '印有"操作者一侧"的长边',
  top: '远端长边（印有说明文字的一侧）',
  left: 'ID0、ID3 所在的短边',
  right: 'ID1、ID2 所在的短边',
};

/**
 * 稳健拟合"外移量随位置变化"的直线 off(t) = a + b·t（剔除残差大的点后重拟合）
 * @param {number[][]} pts [t, off]
 * @returns {{a:number, b:number, n:number}}
 */
function fitOffsetLine(pts) {
  const fit = (ps) => {
    const n = ps.length;
    const mt = ps.reduce((s, p) => s + p[0], 0) / n;
    const mo = ps.reduce((s, p) => s + p[1], 0) / n;
    let stt = 0;
    let sto = 0;
    for (const [t, o] of ps) {
      stt += (t - mt) ** 2;
      sto += (t - mt) * (o - mo);
    }
    const b = stt > 1e-9 ? sto / stt : 0;
    return { a: mo - b * mt, b };
  };
  let ps = pts;
  let L = fit(ps);
  for (let it = 0; it < 2; it++) {
    const res = ps.map(([t, o]) => Math.abs(o - (L.a + L.b * t)));
    const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
    const keep = ps.filter((_, i) => res[i] <= Math.max(0.5, 3 * med));
    if (keep.length < 3 || keep.length === ps.length) break;
    ps = keep;
    L = fit(ps);
  }
  return { ...L, n: ps.length };
}

/**
 * 由 4 条纸边直线求纸张四角（底板坐标），顺序：左下、右下、右上、左上（与底板四角对应）。
 * 纸边直线：下 Y = −off(X)，上 Y = H + off(X)，左 X = −off(Y)，右 X = W + off(Y)。
 * 任一条边缺失时返回 null。
 */
function paperCorners(lines, W, H) {
  const { left, right, bottom, top } = lines;
  if (!left || !right || !bottom || !top) return null;
  // 竖边 X = p + q·Y 与横边 Y = r + s·X 的交点
  const meet = (p, q, r, sl) => {
    const Y = (r + sl * p) / (1 - sl * q);
    return [p + q * Y, Y];
  };
  const L = [-left.a, -left.b];
  const R = [W + right.a, right.b];
  const B = [-bottom.a, -bottom.b];
  const T = [H + top.a, top.b];
  return [meet(...L, ...B), meet(...R, ...B), meet(...R, ...T), meet(...L, ...T)];
}

/**
 * 测量纸边。对每条边在若干位置沿法线方向采样亮度剖面（底板坐标，步长 0.25 mm，
 * 纸内 8 mm 到纸外最多 15 mm；超出照片的部分截掉，纸外至少要有 3 mm 桌面），
 * 取"纸内亮、纸外暗"跳变最大处为纸边，再取中位数。
 * 采样位置避开版面上的文字（长边只在两侧码所在的列取样，短边取中段）。
 * 只用底板坐标，与照片的旋转方向无关。
 * @param {{width:number, height:number, data:Uint8ClampedArray}} img RGBA
 * @param {number[][]} H 底板 mm → 该图像像素
 * @returns {{edges: {left:number|null, right:number|null, bottom:number|null, top:number|null},
 *            reasons: {[edge:string]: 'outside'|'contrast'|null},
 *            lines: {[edge:string]: {a:number, b:number, n:number}|null},
 *            corners: number[][]|null,
 *            widthMm:number|null, heightMm:number|null, scaleX:number|null, scaleY:number|null}}
 *   edges.x 为纸边相对设计位置向外的偏移（mm，各采样点的中位数）；lines.x 为外移量沿边的直线拟合
 *   （可反映纸张相对打印内容的轻微歪斜）；corners 为实测纸张四角的底板坐标（左下、右下、右上、左上）；
 *   reasons.x 为测不出的原因：
 *   'outside' 纸边太靠近照片边缘（或在照片外），'contrast' 纸与桌面对比不够
 */
export function measurePaper(img, H) {
  const W = BOARD.width;
  const Hh = BOARD.height;
  const step = 0.25;
  const inside = 8;
  const outside = 15;
  const minOutside = 3;
  const minContrast = 20;
  const win = Math.round(1.5 / step); // 比较内外均值的窗口（1.5 mm）

  const along = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  // 每条边：基准位置、法线方向（指向纸外）、采样位置
  const defs = {
    left: { at: (t) => [0, t], n: [-1, 0], ts: along(Hh * 0.3, Hh * 0.7, 9) },
    right: { at: (t) => [W, t], n: [1, 0], ts: along(Hh * 0.3, Hh * 0.7, 9) },
    bottom: { at: (t) => [t, 0], n: [0, -1], ts: [...along(16, 50, 5), ...along(W - 50, W - 16, 5)] },
    top: { at: (t) => [t, Hh], n: [0, 1], ts: [...along(16, 50, 5), ...along(W - 50, W - 16, 5)] },
  };

  const edges = {};
  const reasons = {};
  const lines = {};
  for (const [name, d] of Object.entries(defs)) {
    const pts = []; // [t, 外移量]
    let clipped = 0;
    for (const t of d.ts) {
      const base = d.at(t);
      const prof = [];
      let complete = true;
      for (let s = -inside; s <= outside + 1e-9; s += step) {
        const v = lumaAt(img, ...applyH(H, [base[0] + d.n[0] * s, base[1] + d.n[1] * s]));
        if (v == null) {
          complete = s > 0; // 纸内部分超出照片：整条作废；纸外部分超出：截断
          break;
        }
        prof.push(v);
      }
      // 纸外可用长度不足 minOutside：这一处测不了
      if (!complete || (prof.length - 1) * step - inside < minOutside) {
        clipped++;
        continue;
      }
      // 找"内侧均值 − 外侧均值"最大的位置
      const contrast = new Array(prof.length).fill(-Infinity);
      let bestK = -1;
      for (let k = win; k < prof.length - win; k++) {
        let a = 0;
        let b = 0;
        for (let j = 1; j <= win; j++) {
          a += prof[k - j];
          b += prof[k + j];
        }
        contrast[k] = (a - b) / win;
        if (bestK < 0 || contrast[k] > contrast[bestK]) bestK = k;
      }
      if (bestK < 0 || contrast[bestK] < minContrast) continue;
      // 抛物线插值到亚采样精度
      let frac = 0;
      const c0 = contrast[bestK - 1];
      const c1 = contrast[bestK];
      const c2 = contrast[bestK + 1];
      if (Number.isFinite(c0) && Number.isFinite(c2) && c0 - 2 * c1 + c2 < 0) {
        frac = Math.max(-0.5, Math.min(0.5, (0.5 * (c0 - c2)) / (c0 - 2 * c1 + c2)));
      }
      pts.push([t, -inside + (bestK + frac) * step]);
    }
    if (pts.length >= 3) {
      const offs = pts.map((p) => p[1]).sort((a, b) => a - b);
      edges[name] = offs[Math.floor(offs.length / 2)];
      reasons[name] = null;
      lines[name] = fitOffsetLine(pts);
    } else {
      edges[name] = null;
      reasons[name] = clipped * 2 >= d.ts.length ? 'outside' : 'contrast';
      lines[name] = null;
    }
  }

  const widthMm = edges.left != null && edges.right != null ? W + edges.left + edges.right : null;
  const heightMm = edges.bottom != null && edges.top != null ? Hh + edges.bottom + edges.top : null;
  return {
    edges,
    reasons,
    lines,
    corners: paperCorners(lines, W, Hh),
    widthMm,
    heightMm,
    // 打印比例 = 设计纸宽 / 测得纸宽（内容缩小时，纸在底板坐标系里显得更大）
    scaleX: widthMm ? W / widthMm : null,
    scaleY: heightMm ? Hh / heightMm : null,
  };
}

/**
 * @param {import('../state.js').Marker[]} markers 识别结果（像素）
 * @param {{width:number, height:number, data:Uint8ClampedArray}} [img] 与 markers 同一像素坐标的 RGBA 图，提供时测量纸边
 * @returns {{
 *   level: 'ok'|'warn'|'bad',
 *   messages: string[],
 *   found: number[], missing: number[],
 *   H: number[][]|null, reprojErrPx: number|null,
 *   perMarker: {id:number, meanMm:number, maxMm:number, sideMm:number}[],
 *   maxErrMm: number|null,
 *   boardOutlinePx: number[][]|null,
 *   paper: ReturnType<typeof measurePaper>|null
 * }}
 */
export function checkBoardPhoto(markers, img) {
  const found = markers.map((m) => m.id).filter((id) => VALID_IDS.includes(id));
  const missing = VALID_IDS.filter((id) => !found.includes(id));
  const messages = [];
  const result = {
    level: 'ok', messages, found, missing,
    H: null, reprojErrPx: null, perMarker: [], maxErrMm: null, boardOutlinePx: null, paper: null,
  };
  const worse = (lv) => {
    const order = { ok: 0, warn: 1, bad: 2 };
    if (order[lv] > order[result.level]) result.level = lv;
  };

  if (found.length === 0) {
    result.level = 'bad';
    messages.push('没有识别到任何码。请确认整张纸都在画面里、光线均匀、对焦清晰。');
    return result;
  }
  if (missing.length) {
    messages.push(`缺少 ID：${missing.join('、')}。`);
  }

  const world = [];
  const image = [];
  for (const m of markers) {
    world.push(...markerCornersWorld(m.id));
    image.push(...m.corners);
  }
  const H = solveHomography(world, image);
  const Hinv = invert3(H);
  result.H = H;
  result.reprojErrPx = reprojError(H, world, image);
  result.boardOutlinePx = [[0, 0], [BOARD.width, 0], [BOARD.width, BOARD.height], [0, BOARD.height]].map((p) => applyH(H, p));

  if (found.length < 2) {
    result.level = 'bad';
    messages.push('只识别到 1 个码，无法检查码之间的相对位置。');
    return result;
  }

  for (const m of markers) {
    const design = markerCornersWorld(m.id);
    const back = m.corners.map((c) => applyH(Hinv, c));
    const errs = back.map((p, i) => Math.hypot(p[0] - design[i][0], p[1] - design[i][1]));
    const sides = back.map((p, i) => Math.hypot(p[0] - back[(i + 1) % 4][0], p[1] - back[(i + 1) % 4][1]));
    result.perMarker.push({
      id: m.id,
      meanMm: errs.reduce((a, b) => a + b, 0) / 4,
      maxMm: Math.max(...errs),
      sideMm: sides.reduce((a, b) => a + b, 0) / 4,
    });
  }
  result.perMarker.sort((a, b) => a.id - b.id);
  result.maxErrMm = Math.max(...result.perMarker.map((p) => p.maxMm));

  if (result.maxErrMm > CHECK_LIMITS.warnMm) {
    worse('bad');
    messages.push(`码的位置或大小与设计不符（最大偏差 ${result.maxErrMm.toFixed(1)} mm）。可能纸张弯曲，或打印的不是本页面生成的标定板。`);
  } else if (result.maxErrMm > CHECK_LIMITS.okMm) {
    worse('warn');
    messages.push(`码的版面基本正确，但偏差偏大（最大 ${result.maxErrMm.toFixed(1)} mm）。请把纸压平后再拍。`);
  } else {
    messages.push(`码的版面与设计一致（最大偏差 ${result.maxErrMm.toFixed(2)} mm）。`);
  }
  if (missing.length) worse('warn');

  if (img) {
    const paper = measurePaper(img, H);
    result.paper = paper;
    if (paper.scaleX == null || paper.scaleY == null) {
      worse('warn');
      const bad = Object.keys(paper.edges).filter((k) => paper.edges[k] == null);
      const near = bad.filter((k) => paper.reasons[k] === 'outside').map((k) => EDGE_NAMES[k]);
      const dim = bad.filter((k) => paper.reasons[k] === 'contrast').map((k) => EDGE_NAMES[k]);
      const parts = [];
      if (near.length) parts.push(`${near.join('、')}离照片边缘太近（纸外要能看到至少几毫米桌面）`);
      if (dim.length) parts.push(`${dim.join('、')}与桌面对比不够（请换颜色较深的桌面）`);
      messages.push(`没能测出纸边，无法判断打印比例：${parts.join('；')}。拍照时让整张纸四周都留出一圈桌面。`);
      // 一个方向测出来了也告诉用户
      if (paper.scaleX != null) messages.push(`已测出的方向：沿长边 ${(paper.scaleX * 100).toFixed(1)}%。`);
      if (paper.scaleY != null) messages.push(`已测出的方向：沿短边 ${(paper.scaleY * 100).toFixed(1)}%。`);
    } else {
      const dev = Math.max(Math.abs(paper.scaleX - 1), Math.abs(paper.scaleY - 1));
      const pct = `沿长边 ${(paper.scaleX * 100).toFixed(1)}%、沿短边 ${(paper.scaleY * 100).toFixed(1)}%`;
      if (dev > CHECK_LIMITS.warnScale) {
        worse('bad');
        messages.push(`打印比例不对：${pct}。请在打印设置里选择 100% / 实际尺寸后重新打印。`);
      } else if (dev > CHECK_LIMITS.okScale) {
        worse('warn');
        messages.push(`打印比例略有偏差：${pct}。建议用尺子量一下码边长。`);
      } else {
        messages.push(`打印比例正确：${pct}。`);
      }
    }
  }
  return result;
}
