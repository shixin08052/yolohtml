// 模块 2：ArUco 识别（步骤 2 的雏形：字典、码图案、单张图识别）。
//
// 实验结论（scratchpad 实验，已写入单元测试）：
// - js-aruco2 自带 'ARUCO_4X4_1000' 字典（需单独引入字典文件），ID 0–3 的比特与
//   OpenCV DICT_4X4_50 完全一致；markSize = 6（4×4 数据 + 1 圈黑边）。
// - dictionary.generateSVG(id) 能直接生成码图案：viewBox 8×8，外圈 1 格白边，
//   内部 6×6 为码本体（黑边 + 数据），码字按行优先、从码自身左上开始。
// - detector.detect() 返回的 corners 无论码怎么旋转，顺序都已经是
//   "码自身的左上、右上、右下、左下"，无需再调整。
// - 原始角点为整像素轮廓点，与理想角点相差约 0–1.4 像素；斑点多时个别角点会偏很多，
//   所以识别后再用 refineCorners 沿边拟合直线精修到亚像素。
// - js-aruco2 的自适应阈值窗口很小（kernel 2），大块黑色只剩边缘一圈细环；
//   打印有斑点（墨粉不匀）时细环断开，码连候选都进不去。所以这里像 OpenCV 一样
//   用几种窗口大小各跑一遍；斑点很重时，最后再用"轻微模糊 + 全局 Otsu 阈值"找候选
//   （斑点被抹平，黑块变实心）。解码始终在原灰度图上做。
//   注意 CV.stackBoxBlur 的半径只支持 0–15。
import arucoPkg from 'js-aruco2';
import cvPkg from 'js-aruco2/src/cv.js';
import 'js-aruco2/src/dictionaries/aruco_4x4_1000.js';

const { AR } = arucoPkg;
const { CV } = cvPkg;

/** 使用的字典名（js-aruco2 内置） */
export const ARUCO_DICT = 'ARUCO_4X4_1000';
/** 底板上用到的 ID */
export const VALID_IDS = [0, 1, 2, 3];

/**
 * 识别轮次，依次尝试，4 个码都找到就停止。
 * - { kernel }：自适应阈值，kernel 为求局部均值的模糊半径（js-aruco2 默认 2）
 * - { otsuBlur }：先盒式模糊（半径 otsuBlur），再用整张图的 Otsu 阈值；
 *   不怕斑点，但怕光照很不均匀，所以放在最后
 */
export const DETECT_PASSES = [
  { kernel: 2 },
  { kernel: 5 },
  { kernel: 8 },
  { kernel: 12 },
  { otsuBlur: 2 },
];

let dictionary = null;
let detector = null;

/** js-aruco2 的字典对象（单例） */
export function getDictionary() {
  if (!dictionary) dictionary = new AR.Dictionary(ARUCO_DICT);
  return dictionary;
}

function getDetector() {
  if (!detector) detector = new AR.Detector({ dictionaryName: ARUCO_DICT });
  return detector;
}

/**
 * 码的数据比特（4×4，1 = 白）。行优先，从码自身左上开始。
 * @param {number} id
 * @returns {number[][]}
 */
export function markerBits(id) {
  const code = getDictionary().codeList[id];
  if (code == null) throw new Error(`字典 ${ARUCO_DICT} 中没有 ID ${id}`);
  const n = Math.sqrt(code.length);
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => Number(code[r * n + c])));
}

/**
 * 由 js-aruco2 生成的码 SVG 字符串。
 * viewBox 为 8×8：外圈 1 格白边，中间 6×6 是码本体。
 * 因此码本体边长为 s 时，整个 SVG 边长应为 s × 8 / 6。
 * @param {number} id
 * @returns {string}
 */
export function markerSVG(id) {
  return getDictionary().generateSVG(id);
}

/** 生成的 SVG 边长与码本体边长之比 */
export function svgScale() {
  const m = getDictionary().markSize; // 6
  return (m + 2) / m;
}

/** 四边形面积（鞋带公式） */
function quadArea(c) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * 生成二值图（暗 = 255），作为找轮廓的输入。
 * 自适应阈值写进 det.thres（js-aruco2 内部用可变长数组）；Otsu 轮用独立的图，
 * 不替换 det.thres，以免后面更大的图写不进定长数组。
 */
function binarize(det, grey, pass) {
  if (pass.kernel != null) {
    CV.adaptiveThreshold(grey, det.thres, pass.kernel, 7);
    return det.thres;
  }
  const n = grey.data.length;
  const b = new CV.Image(grey.width, grey.height, new Uint8ClampedArray(n));
  CV.stackBoxBlur(grey, b, pass.otsuBlur);
  const t = CV.otsu(b);
  const out = new CV.Image(grey.width, grey.height, new Uint8ClampedArray(n));
  for (let i = 0; i < n; i++) out.data[i] = b.data[i] <= t ? 255 : 0;
  return out;
}

/**
 * 跑一遍 js-aruco2 的识别流程（与 Detector.detect 相同，只是二值化方式可调）。
 * @returns {{id:number, corners:number[][], area:number}[]}
 */
function detectPass(det, grey, pass) {
  const bin = binarize(det, grey, pass);
  det.contours = CV.findContours(bin, det.binary);
  let cands = det.findCandidates(det.contours, grey.width * 0.01, 0.05, 10);
  cands = det.notTooNear(det.clockwiseCorners(cands), 10);
  return det
    .findMarkers(grey, cands, 49)
    .filter((m) => VALID_IDS.includes(m.id))
    .map((m) => {
      const corners = m.corners.map((p) => [p.x, p.y]);
      return { id: m.id, corners, area: quadArea(corners) };
    });
}

/* ------------------------------------------------------------------ */
/* 角点精修：沿每条边拟合直线，相邻两边求交点                               */
/* ------------------------------------------------------------------ */

/** 灰度图双线性取值；像素 (i, j) 覆盖 [i, i+1) × [j, j+1)，中心在 +0.5 处 */
function sampleGrey(grey, u, v) {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= grey.width || y0 + 1 >= grey.height) return null;
  const fx = x - x0;
  const fy = y - y0;
  const d = grey.data;
  const i = y0 * grey.width + x0;
  return (
    d[i] * (1 - fx) * (1 - fy) + d[i + 1] * fx * (1 - fy) +
    d[i + grey.width] * (1 - fx) * fy + d[i + grey.width + 1] * fx * fy
  );
}

/** 总体最小二乘拟合直线，返回 { c: 中心点, d: 单位方向 } */
function fitLine(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: [mx, my], d: [Math.cos(a), Math.sin(a)] };
}

const lineDist = (L, p) => Math.abs((p[0] - L.c[0]) * L.d[1] - (p[1] - L.c[1]) * L.d[0]);

function intersect(L1, L2) {
  const det = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
  if (Math.abs(det) < 1e-9) return null;
  const t = ((L2.c[0] - L1.c[0]) * L2.d[1] - (L2.c[1] - L1.c[1]) * L2.d[0]) / det;
  return [L1.c[0] + t * L1.d[0], L1.c[1] + t * L1.d[1]];
}

/**
 * 精修一个码的 4 个角点（纯函数）。
 * 沿每条边取若干位置，在法线方向上采样亮度剖面（码内黑边 → 码外白边），
 * 取"最后一个暗点"之后与中间亮度的交点为边缘点（码内的白色斑点不影响），
 * 稳健拟合直线后相邻两边求交。某条边失败时整个码保留原角点。
 * @param {{width:number, height:number, data:ArrayLike<number>}} grey 单通道灰度图
 * @param {number[][]} corners 4 个角点，顺时针（码自身左上、右上、右下、左下）
 * @returns {number[][]}
 */
export function refineCorners(grey, corners) {
  const side = corners.reduce((a, p, i) => a + Math.hypot(...[0, 1].map((k) => corners[(i + 1) % 4][k] - p[k])), 0) / 4;
  // 搜索范围 < 半个码格，避免碰到内部数据格或码外白边以外的东西
  const search = Math.max(3, 0.08 * side);
  const step = 0.5;
  const lines = [];
  for (let e = 0; e < 4; e++) {
    const p = corners[e];
    const q = corners[(e + 1) % 4];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const nrm = [dir[1], -dir[0]]; // 顺时针排列（y 向下）时指向码外
    const N = Math.max(8, Math.round(len / 4));
    const profiles = [];
    const all = [];
    for (let k = 0; k < N; k++) {
      const t = 0.15 + (0.7 * k) / (N - 1);
      const base = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
      const vals = [];
      for (let s = -search; s <= search + 1e-9; s += step) {
        vals.push(sampleGrey(grey, base[0] + nrm[0] * s, base[1] + nrm[1] * s));
      }
      if (vals.some((v) => v == null)) continue;
      profiles.push({ base, vals });
      all.push(...vals);
    }
    if (profiles.length < 4) return corners;
    all.sort((a, b) => a - b);
    const black = all[Math.floor(all.length * 0.1)];
    const white = all[Math.floor(all.length * 0.9)];
    if (white - black < 20) return corners;
    const mid = (black + white) / 2;

    let pts = [];
    for (const { base, vals } of profiles) {
      let last = -1;
      for (let i = 0; i < vals.length; i++) if (vals[i] < mid) last = i;
      if (last < 0 || last === vals.length - 1) continue;
      const f = (mid - vals[last]) / (vals[last + 1] - vals[last]);
      const s = -search + (last + f) * step;
      pts.push([base[0] + nrm[0] * s, base[1] + nrm[1] * s]);
    }
    if (pts.length < 4) return corners;
    let L = fitLine(pts);
    for (let it = 0; it < 3; it++) {
      const d = pts.map((pt) => lineDist(L, pt));
      const med = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)];
      const keep = pts.filter((_, i) => d[i] <= Math.max(0.75, 3 * med));
      if (keep.length < 4) break;
      pts = keep;
      L = fitLine(pts);
    }
    lines.push(L);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const c = intersect(lines[(i + 3) % 4], lines[i]);
    if (!c || Math.hypot(c[0] - corners[i][0], c[1] - corners[i][1]) > 0.2 * side) return corners;
    out.push(c);
  }
  return out;
}

/**
 * 在一张图上识别码。按 DETECT_PASSES 依次识别，4 个码都找到就提前结束。
 * 只保留 VALID_IDS。同一轮里同一 ID 多次出现时保留面积最大的（同一个码的内外两条轮廓取外轮廓）；
 * 不同轮之间，先找到的优先。最后用 refineCorners 精修角点（亚像素）；
 * 精修两次：初始角点偏得多时，第一次把边找准，第二次在更准的边附近重新采样。
 * @param {{width:number, height:number, data:Uint8ClampedArray}} image RGBA 像素（ImageData 或同结构对象）
 * @param {{passes?: ({kernel:number}|{otsuBlur:number})[], refine?: boolean}} [opts]
 * @returns {import('../state.js').Marker[]} 按 ID 升序；corners 顺序为码自身左上、右上、右下、左下
 */
export function detectMarkers(image, { passes = DETECT_PASSES, refine = true } = {}) {
  const det = getDetector();
  const grey = CV.grayscale(image, new CV.Image());
  /** @type {Map<number, {id:number, corners:number[][], area:number}>} */
  const found = new Map();
  for (const pass of passes) {
    const round = new Map();
    for (const m of detectPass(det, grey, pass)) {
      const prev = round.get(m.id);
      if (!prev || m.area > prev.area) round.set(m.id, m);
    }
    for (const [id, m] of round) if (!found.has(id)) found.set(id, m);
    if (VALID_IDS.every((id) => found.has(id))) break;
  }
  return [...found.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, corners }) => ({ id, corners: refine ? refineTwice(grey, corners) : corners }));
}

/**
 * 精修两遍。第一遍就失败（码太模糊、边被遮住）时用原始角点，但 js-aruco2 的角点是像素序号（像素左上角），
 * 与精修结果的约定（像素中心为 +0.5）差半个像素，这里补上
 */
function refineTwice(grey, corners) {
  const r = refineCorners(grey, corners);
  if (r === corners) return corners.map(([x, y]) => [x + 0.5, y + 0.5]);
  return refineCorners(grey, r);
}

/**
 * 在一张照片（ImageBitmap / canvas / img）上识别码：先缩小到长边 maxSide 再识别，
 * 角点按比例换回原图像素。需要浏览器环境（使用 canvas）。
 * @param {CanvasImageSource & {width:number, height:number}} source
 * @param {number} [maxSide=1600]
 * @returns {{ markers: import('../state.js').Marker[],   // 原图像素
 *             small: import('../state.js').Marker[],     // 缩小图像素
 *             imageData: ImageData,                       // 缩小图
 *             scale: number }}                            // 缩小图 / 原图
 */
export function detectMarkersInImage(source, maxSide = 1600) {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cw, ch);
  const imageData = ctx.getImageData(0, 0, cw, ch);
  const small = detectMarkers(imageData);
  const sx = w / cw;
  const sy = h / ch;
  const markers = small.map((m) => ({ id: m.id, corners: m.corners.map(([u, v]) => [u * sx, v * sy]) }));
  return { markers, small, imageData, scale: cw / w };
}
