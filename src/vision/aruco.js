// 模块 2：ArUco 识别（步骤 2 的雏形：字典、码图案、单张图识别）。
//
// 实验结论（scratchpad 实验，已写入单元测试）：
// - js-aruco2 自带 'ARUCO_4X4_1000' 字典（需单独引入字典文件），ID 0–3 的比特与
//   OpenCV DICT_4X4_50 完全一致；markSize = 6（4×4 数据 + 1 圈黑边）。
// - dictionary.generateSVG(id) 能直接生成码图案：viewBox 8×8，外圈 1 格白边，
//   内部 6×6 为码本体（黑边 + 数据），码字按行优先、从码自身左上开始。
// - detector.detect() 返回的 corners 无论码怎么旋转，顺序都已经是
//   "码自身的左上、右上、右下、左下"，无需再调整。
// - 角点为整像素轮廓点，与理想角点相差约 0–1.4 像素。
import arucoPkg from 'js-aruco2';
import 'js-aruco2/src/dictionaries/aruco_4x4_1000.js';

const { AR } = arucoPkg;

/** 使用的字典名（js-aruco2 内置） */
export const ARUCO_DICT = 'ARUCO_4X4_1000';
/** 底板上用到的 ID */
export const VALID_IDS = [0, 1, 2, 3];

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
 * 在一张图上识别码。只保留 VALID_IDS，同一 ID 多次出现时保留面积最大的。
 * @param {{width:number, height:number, data:Uint8ClampedArray}} image RGBA 像素（ImageData 或同结构对象）
 * @returns {import('../state.js').Marker[]} 按 ID 升序；corners 顺序为码自身左上、右上、右下、左下
 */
export function detectMarkers(image) {
  const raw = getDetector().detect(image);
  /** @type {Map<number, {id:number, corners:number[][], area:number}>} */
  const best = new Map();
  for (const m of raw) {
    if (!VALID_IDS.includes(m.id)) continue;
    const corners = m.corners.map((p) => [p.x, p.y]);
    const area = quadArea(corners);
    const prev = best.get(m.id);
    if (!prev || area > prev.area) best.set(m.id, { id: m.id, corners, area });
  }
  return [...best.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, corners }) => ({ id, corners }));
}
