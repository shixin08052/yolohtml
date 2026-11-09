// 模块 4：零件检测。接口 detect(imageInput) → Promise<Detection[]>，两种模式：
// - mock：合成图直接用真值里的框；其他照片读 public/samples/<照片名>.detections.json
// - onnx：在 Web Worker 里用 onnxruntime-web 跑 YOLO（步骤 14，见 detector.worker.js、yolo.js）
// 另外提供 .detections.json 的读写（手动框选工具保存 / 载入用）。
import { CLASSES, DETECT, MODELS } from '../config.js';
import { nmsByClass } from './yolo.js';
import { fetchResource } from './request.js';

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
    const box = [Math.max(0, Math.min(a, c) * sx), Math.max(0, Math.min(b, e) * sy), Math.min(width, Math.max(a, c) * sx), Math.min(height, Math.max(b, e) * sy)];
    if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(`第 ${i + 1} 个检测框没有有效面积或超出照片范围`);
    out.push({
      cls,
      name: CLASSES[cls].name,
      score: Number.isFinite(d.score) ? d.score : 1,
      box,
    });
  });
  return out;
}

/** 读取期间换图或启动了其他检测时，旧导入作废。 */
export async function readDetectionsFile(file, image, isCurrent) {
  if (file.size > 2 * 1024 * 1024) throw new Error('检测文件不能超过 2 MB');
  const text = await file.text();
  if (!isCurrent()) return null;
  const json = JSON.parse(text);
  return { json, detections: parseDetections(json, image) };
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
export function createOnnxDetector(modelUrl, { prefer = 'auto', names = null, initTimeoutMs = 300000, detectTimeoutMs = 90000 } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let ready = null;
  let generation = 0;
  let loadingController = null;
  let progress = null;
  const listeners = new Set();
  const report = (value) => {
    progress = value;
    for (const listener of listeners) listener(value);
  };

  /** 丢掉当前 Worker（出错后 onnxruntime 不能再初始化，只能换一个新的 Worker 重来），等待中的请求都以出错结束 */
  function reset(err) {
    generation++;
    loadingController?.abort(err);
    loadingController = null;
    worker?.terminate();
    worker = null;
    ready = null;
    progress = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./detector.worker.js', import.meta.url), { type: 'module' });
    const activeWorker = worker;
    worker.onmessage = (e) => {
      if (worker !== activeWorker) return;
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (e.data.progress) {
        report(e.data.progress);
        return;
      }
      pending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    // Worker 脚本加载失败、Worker 内未捕获的错误：换一个新的 Worker，不让等待中的请求永远挂着
    worker.onerror = (e) => {
      if (worker === activeWorker) reset(new Error(e.message || 'Worker 出错'));
    };
    return worker;
  }

  const call = (msg, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reset(new Error(msg.type === 'init' ? '模型准备超时，请重试或改用仅 WASM。' : '模型推理超时，请重试、改用仅 WASM或手动框选。')), msg.type === 'init' ? initTimeoutMs : detectTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ensureWorker().postMessage({ id, ...msg }, transfer);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        if (msg.type !== 'init') reset(err);
        reject(err);
      }
    });

  return {
    /** 加载模型（只加载一次），返回后端、耗时、输入输出形状；类别名从模型旁边的 .json（export.py 生成）读 */
    init({ onProgress } = {}) {
      if (onProgress) {
        listeners.add(onProgress);
        if (progress) onProgress(progress);
      }
      if (!ready) {
        const token = generation;
        loadingController = new AbortController();
        const signal = loadingController.signal;
        ready = (async () => {
          report({ stage: 'metadata' });
          if (!names) {
            // 类别名是必需的，不能按顺序猜。
            const meta = await fetchResource(modelUrl.replace(/\.onnx$/, '.json'), { signal });
            if (!meta?.names) throw new Error('读取模型的类别名失败');
            names = Object.values(meta.names);
          }
          if (signal.aborted) throw signal.reason;
          const info = await call({ type: 'init', modelUrl, ortBase: new URL('ort/', document.baseURI).href, prefer });
          report({ stage: 'ready' });
          return info;
        })().catch((err) => {
          // 换新 Worker 重试；旧初始化失败不能关闭新会话。
          if (token === generation) reset(err);
          throw err;
        });
      }
      return onProgress ? ready.finally(() => listeners.delete(onProgress)) : ready;
    },
    /**
     * 检测一张照片（ImageBitmap 会被复制一份交给 Worker）
     * @param {ImageBitmap} bitmap
     * @param {{ onPosted?: () => void }} [opts] onPosted：照片交给 Worker 后调用（主线程可以趁推理时做别的）
     * @returns {Promise<{ raw: object[], dets: import('../state.js').Detection[], prepMs: number, inferMs: number, postMs: number, dims: number[] }>}
     */
    async detect(bitmap, { scoreThreshold = DETECT.scoreThreshold, lowThreshold = DETECT.lowThreshold, lowMaxIou = DETECT.lowMaxIou, iouThreshold = DETECT.iouThreshold, dedupIou = DETECT.dedupIou, onPosted = null } = {}) {
      const token = generation;
      await this.init();
      const copy = await createImageBitmap(bitmap);
      if (token !== generation) {
        copy.close();
        const err = new Error('检测已取消');
        err.name = 'AbortError';
        throw err;
      }
      const pending = call({ type: 'detect', bitmap: copy, scoreThreshold, lowThreshold, lowMaxIou, iouThreshold, dedupIou }, [copy]);
      onPosted?.(); // 照片已交给 Worker，主线程可以去做别的
      const r = await pending;
      // raw 保留模型自己的类别 ID 和类别名（与 predict_dump.py 的输出对照）；
      // dets：零件模型按类别名换成本项目的类别 ID 和中文名，去掉这里没有的类别；其他模型（官方 COCO）保持原样
      const map = modelClassMap(names);
      const own = (d) => ({ cls: d.cls, name: names?.[d.cls] ?? String(d.cls), score: d.score, box: d.box });
      const dets = map
        ? r.dets.filter((d) => map[d.cls] >= 0).map((d) => ({ ...own(d), cls: map[d.cls], name: CLASSES[map[d.cls]].name, ...(d.low ? { low: true } : {}) }))
        : r.dets.map(own);
      return { ...r, raw: r.raw.map(own), dets };
    },
    terminate(message = '检测器已关闭') {
      const err = new Error(message);
      err.name = 'AbortError';
      reset(err);
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
    // 只保留一个检测器：每个 Worker 都有自己的一份 onnxruntime 和模型（几十 MB），换模型 / 后端时关掉旧的
    for (const d of detectors.values()) d.detector.terminate();
    detectors.clear();
    const url = new URL(MODELS[key].file, document.baseURI).href;
    detectors.set(k, { key, prefer, detector: createOnnxDetector(url, { prefer }) });
  }
  return detectors.get(k).detector;
}

/**
 * 检测零件
 * @param {import('../state.js').ImageInput} image
 * @param {{ mode?: 'mock'|'onnx', truth?: import('../state.js').GroundTruth|null, model?: keyof typeof MODELS, prefer?: 'auto'|'wasm',
 *           onPosted?: (() => void)|null }} [opts] onPosted：onnx 模式下照片交给 Worker 后调用
 * @returns {Promise<import('../state.js').Detection[]>}
 * @throws {MockMissingError} mock 模式下既没有真值也没有检测结果文件
 */
export async function detect(image, { mode = 'mock', truth = null, model = 'parts', prefer = 'auto', onPosted = null, signal } = {}) {
  if (mode === 'onnx') {
    const d = getOnnxDetector(model, { prefer });
    const info = await d.init();
    const r = await d.detect(image.bitmap, { onPosted });
    lastOnnxRun = { model, info, ...r };
    return r.dets;
  }
  if (truth) return detectionsFromTruth(truth);
  // 文件名里可能有 #、? 等字符：逐段编码（示例的 real/xxx 保留斜杠）
  const path = detectionsFileName(image.fileName).split('/').map(encodeURIComponent).join('/');
  const url = new URL(`samples/${path}`, document.baseURI);
  let json;
  try {
    json = await fetchResource(url, { timeoutMs: 30000, signal });
  } catch (err) {
    // 开发服务器找不到文件时会返回 index.html。
    if (err.status === 404 || err instanceof SyntaxError) throw new MockMissingError(image.fileName);
    throw err;
  }
  // mock 文件可能是 predict_dump.py 的推理结果（没有去重），这里同样做同类去重
  return nmsByClass(parseDetections(json, image), DETECT.dedupIou);
}
