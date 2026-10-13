// 模块 4：零件检测。接口 detect(imageInput) → Promise<Detection[]>，两种模式：
// - mock：合成图直接用真值里的框；其他照片读 public/samples/<照片名>.detections.json
// - onnx：在 Web Worker 里用 onnxruntime-web 跑 YOLO（步骤 14，见 detector.worker.js、yolo.js）
// 另外提供 .detections.json 的读写（手动框选工具保存 / 载入用）。
import { CLASSES, DETECT, MODELS } from '../config.js';
import { nmsByClass } from './yolo.js';

/** 没有 mock 检测结果 */
export class MockMissingError extends Error {
  constructor(fileName) {
    super(`没有找到 ${detectionsFileName(fileName)}`);
    this.name = 'MockMissingError';
  }
}

/**
 * 类别名 → 本项目的类别 ID（认 key 和中文名，不区分大小写）；对不上返回 -1
 * @param {string} name
 */
export function classIdByName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return CLASSES.findIndex((c) => c.key === n || c.name.toLowerCase() === n);
}

/**
 * 模型类别 ID → 本项目类别 ID 的对照表（按类别名对应）。模型里有、这里没有的类别（例如训练时留着的电容、螺丝）
 * 对应 -1，检测结果里去掉。一个都对不上（官方 COCO 等）时返回 null，表示不是零件模型。
 * @param {string[]} names 模型的类别名（按模型类别 ID 排列）
 * @returns {number[]|null}
 */
export function modelClassMap(names) {
  const map = names.map(classIdByName);
  return map.some((i) => i >= 0) ? map : null;
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
  const out = [];
  list.forEach((d, i) => {
    // 有类别名时按名字认（predict_dump.py 的输出用的是模型的类别 ID，旧文件里还有已删除的类别），对不上的跳过；
    // 没有类别名时直接用 cls
    let cls = Number(d.cls);
    if (d.name != null) {
      cls = classIdByName(d.name);
      if (cls < 0) return;
    } else if (!CLASSES[cls]) {
      throw new Error(`第 ${i + 1} 个检测的类别 ${d.cls} 无效`);
    }
    if (!Array.isArray(d.box) || d.box.length !== 4 || !d.box.every(Number.isFinite)) {
      throw new Error(`第 ${i + 1} 个检测的 box 无效`);
    }
    const [a, b, c, e] = d.box;
    out.push({
      cls,
      name: CLASSES[cls].name,
      score: Number.isFinite(d.score) ? d.score : 1,
      box: [Math.min(a, c) * sx, Math.min(b, e) * sy, Math.max(a, c) * sx, Math.max(b, e) * sy],
    });
  });
  return out;
}

/** 合成图真值 → 检测结果（置信度 1）；跳过当前没有的类别（例如旧真值文件里已删除的类别） */
export function detectionsFromTruth(truth) {
  return truth.parts
    .filter((p) => CLASSES[p.cls])
    .map((p) => ({ cls: p.cls, name: CLASSES[p.cls].name, score: 1, box: [...p.box] }));
}

/* ------------------------------------------------------------------ */
/* ONNX 推理（Web Worker）                                               */
/* ------------------------------------------------------------------ */

/**
 * 创建一个 ONNX 检测器：模型在 Worker 里加载一次，之后每张照片只推理
 * @param {string} modelUrl
 * @param {{ prefer?: 'auto'|'wasm', names?: string[] }} [opts] prefer = 'wasm' 时不尝试 WebGPU；names 为模型类别名
 */
export function createOnnxDetector(modelUrl, { prefer = 'auto', names = null } = {}) {
  const worker = new Worker(new URL('./detector.worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Worker 出错'));
    pending.clear();
  };
  const call = (msg, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg }, transfer);
    });

  let ready = null;
  return {
    /** 加载模型（只加载一次），返回后端、耗时、输入输出形状；类别名从模型旁边的 .json（export.py 生成）读 */
    init() {
      ready ??= (async () => {
        if (!names) {
          const meta = await fetch(modelUrl.replace(/\.onnx$/, '.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (meta?.names) names = Object.values(meta.names);
        }
        return call({ type: 'init', modelUrl, ortBase: new URL('ort/', document.baseURI).href, prefer });
      })();
      return ready;
    },
    /**
     * 检测一张照片（ImageBitmap 会被复制一份交给 Worker）
     * @param {ImageBitmap} bitmap
     * @returns {Promise<{ raw: object[], dets: import('../state.js').Detection[], prepMs: number, inferMs: number, postMs: number, dims: number[] }>}
     */
    async detect(bitmap, { scoreThreshold = DETECT.scoreThreshold, iouThreshold = DETECT.iouThreshold, dedupIou = DETECT.dedupIou } = {}) {
      await this.init();
      const copy = await createImageBitmap(bitmap);
      const r = await call({ type: 'detect', bitmap: copy, scoreThreshold, iouThreshold, dedupIou }, [copy]);
      // raw 保留模型自己的类别 ID 和类别名（与 predict_dump.py 的输出对照）；
      // dets：零件模型按类别名换成本项目的类别 ID 和中文名，去掉这里没有的类别；其他模型（官方 COCO）保持原样
      const map = names ? modelClassMap(names) : CLASSES.map((c) => c.id);
      const own = (d) => ({ cls: d.cls, name: names?.[d.cls] ?? String(d.cls), score: d.score, box: d.box });
      const dets = map
        ? r.dets.filter((d) => map[d.cls] >= 0).map((d) => ({ ...own(d), cls: map[d.cls], name: CLASSES[map[d.cls]].name }))
        : r.dets.map(own);
      return { ...r, raw: r.raw.map(own), dets };
    },
    terminate() {
      worker.terminate();
    },
  };
}

/** 各模型的检测器（按需创建，模型只加载一次） */
const detectors = new Map();
/** 最近一次 ONNX 检测的统计（信息面板显示） */
export let lastOnnxRun = null;

/**
 * 取得某个模型的检测器
 * @param {keyof typeof MODELS} key
 * @param {{ prefer?: 'auto'|'wasm' }} [opts]
 */
export function getOnnxDetector(key = 'parts', { prefer = 'auto' } = {}) {
  const k = `${key}:${prefer}`;
  if (!detectors.has(k)) {
    const url = new URL(MODELS[key].file, document.baseURI).href;
    detectors.set(k, { key, prefer, detector: createOnnxDetector(url, { prefer }) });
  }
  return detectors.get(k).detector;
}

/**
 * 检测零件
 * @param {import('../state.js').ImageInput} image
 * @param {{ mode?: 'mock'|'onnx', truth?: import('../state.js').GroundTruth|null, model?: keyof typeof MODELS, prefer?: 'auto'|'wasm' }} [opts]
 * @returns {Promise<import('../state.js').Detection[]>}
 * @throws {MockMissingError} mock 模式下既没有真值也没有检测结果文件
 */
export async function detect(image, { mode = 'mock', truth = null, model = 'parts', prefer = 'auto' } = {}) {
  if (mode === 'onnx') {
    const d = getOnnxDetector(model, { prefer });
    const info = await d.init();
    const r = await d.detect(image.bitmap);
    lastOnnxRun = { model, info, ...r };
    return r.dets;
  }
  if (truth) return detectionsFromTruth(truth);
  const url = new URL(`samples/${detectionsFileName(image.fileName)}`, document.baseURI);
  const res = await fetch(url).catch(() => null);
  // 开发服务器找不到文件时会返回 index.html，所以还要确认是 JSON
  const json = res?.ok ? await res.json().catch(() => null) : null;
  if (!json) throw new MockMissingError(image.fileName);
  // mock 文件可能是 predict_dump.py 的推理结果（没有去重），这里同样做同类去重
  return nmsByClass(parseDetections(json, image), DETECT.dedupIou);
}
