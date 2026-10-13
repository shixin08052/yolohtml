// 模块 4：零件检测。接口 detect(imageInput) → Promise<Detection[]>，两种模式：
// - mock：合成图直接用真值里的框；其他照片读 public/samples/<照片名>.detections.json
// - onnx：步骤 14 实现
// 另外提供 .detections.json 的读写（手动框选工具保存 / 载入用）。
import { CLASSES } from '../config.js';

/** 没有 mock 检测结果 */
export class MockMissingError extends Error {
  constructor(fileName) {
    super(`没有找到 ${detectionsFileName(fileName)}`);
    this.name = 'MockMissingError';
  }
}

/** 照片名 → 检测结果文件名：IMG_0001.HEIC → IMG_0001.detections.json */
export function detectionsFileName(fileName) {
  const base = String(fileName || 'photo').replace(/\.[^./\\]+$/, '');
  return `${base}.detections.json`;
}

/**
 * 检测结果 → 可保存的 JSON 对象（带照片名与尺寸，载入时用来核对）
 * @param {import('../state.js').Detection[]} detections
 * @param {{fileName:string, width:number, height:number}} image
 */
export function serializeDetections(detections, { fileName, width, height }) {
  const r = (x) => Math.round(x * 10) / 10;
  return {
    说明: '零件检测框（原图像素，已按 EXIF 方向转正）：cls 类别 ID，box = [x1, y1, x2, y2]',
    image: fileName,
    width,
    height,
    detections: detections.map((d) => ({
      cls: d.cls,
      name: CLASSES[d.cls]?.name ?? d.name,
      score: Math.round(d.score * 100) / 100,
      box: d.box.map(r),
    })),
  };
}

/**
 * 解析 .detections.json（对象或直接是数组）。记录的尺寸与照片不同但宽高比相同时按比例缩放；
 * 宽高比不同（例如方向不同）时报错。
 * @param {unknown} json
 * @param {{width:number, height:number}} image
 * @returns {import('../state.js').Detection[]}
 */
export function parseDetections(json, { width, height }) {
  const list = Array.isArray(json) ? json : json?.detections;
  if (!Array.isArray(list)) throw new Error('文件里没有 detections 数组');
  let sx = 1;
  let sy = 1;
  if (!Array.isArray(json) && json.width > 0 && json.height > 0 && (json.width !== width || json.height !== height)) {
    if (Math.abs(json.width / json.height - width / height) > 0.01) {
      throw new Error(`检测结果对应 ${json.width} × ${json.height} 的照片，与当前照片 ${width} × ${height} 的方向或比例不同`);
    }
    sx = width / json.width;
    sy = height / json.height;
  }
  return list.map((d, i) => {
    const cls = Number(d.cls);
    if (!CLASSES[cls]) throw new Error(`第 ${i + 1} 个检测的类别 ${d.cls} 无效`);
    if (!Array.isArray(d.box) || d.box.length !== 4 || !d.box.every(Number.isFinite)) {
      throw new Error(`第 ${i + 1} 个检测的 box 无效`);
    }
    const [a, b, c, e] = d.box;
    return {
      cls,
      name: CLASSES[cls].name,
      score: Number.isFinite(d.score) ? d.score : 1,
      box: [Math.min(a, c) * sx, Math.min(b, e) * sy, Math.max(a, c) * sx, Math.max(b, e) * sy],
    };
  });
}

/** 合成图真值 → 检测结果（置信度 1）；跳过当前没有的类别（例如旧真值文件里已删除的类别） */
export function detectionsFromTruth(truth) {
  return truth.parts
    .filter((p) => CLASSES[p.cls])
    .map((p) => ({ cls: p.cls, name: CLASSES[p.cls].name, score: 1, box: [...p.box] }));
}

/**
 * 检测零件
 * @param {import('../state.js').ImageInput} image
 * @param {{ mode?: 'mock'|'onnx', truth?: import('../state.js').GroundTruth|null }} [opts]
 * @returns {Promise<import('../state.js').Detection[]>}
 * @throws {MockMissingError} mock 模式下既没有真值也没有检测结果文件
 */
export async function detect(image, { mode = 'mock', truth = null } = {}) {
  if (mode === 'onnx') throw new Error('ONNX 推理在步骤 14 实现');
  if (truth) return detectionsFromTruth(truth);
  const url = new URL(`samples/${detectionsFileName(image.fileName)}`, document.baseURI);
  const res = await fetch(url).catch(() => null);
  // 开发服务器找不到文件时会返回 index.html，所以还要确认是 JSON
  const json = res?.ok ? await res.json().catch(() => null) : null;
  if (!json) throw new MockMissingError(image.fileName);
  return parseDetections(json, image);
}
