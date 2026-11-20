// 视觉计算 Worker 的主线程这一端（见 vision.worker.js）：识别码、读整张照片像素、颜色分割都放到 Worker 里算，
// 主线程只等结果，加载动画不掉帧。浏览器不支持（没有 Worker / OffscreenCanvas）或 Worker 出错时，退回主线程同步计算——
// 结果一样，只是会卡一下。
import { detectMarkersInImage } from './aruco.js';
import { segmentParts } from './colorSeg.js';

let worker = null;
let broken = false;
let seq = 0;
const pending = new Map();
const WORKER_TIMEOUT_MS = 30000;

const supported = () => !broken && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';

function fail(err) {
  broken = true;
  worker?.terminate();
  worker = null;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./vision.worker.js', import.meta.url), { type: 'module' });
  const activeWorker = worker;
  worker.onmessage = (e) => {
    if (worker !== activeWorker) return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  // Worker 加载失败（例如模块在 Worker 里跑不起来）：以后都在主线程算
  worker.onerror = (e) => {
    if (worker !== activeWorker) return;
    e.preventDefault?.();
    fail(new Error(e.message || '视觉计算 Worker 出错'));
  };
  worker.onmessageerror = () => {
    if (worker === activeWorker) fail(new Error('无法读取视觉计算 Worker 的结果'));
  };
  return worker;
}

function call(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    if (broken) {
      reject(new Error('视觉计算 Worker 已停用'));
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => fail(new Error('视觉计算超时，改在主线程处理')), WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ensureWorker().postMessage({ ...msg, id }, transfer);
    } catch (err) {
      fail(err);
    }
  });
}

async function callWithBitmap(bitmap, message) {
  const copy = await createImageBitmap(bitmap);
  try {
    return await call({ ...message, bitmap: copy }, [copy]);
  } finally {
    // postMessage 失败时副本还在本线程；成功转交后 close 是无操作。
    copy.close();
  }
}

/** 像素数据还原成 ImageData（有的话），没有时保持 { width, height, data } */
const toImageData = (p) => (typeof ImageData !== 'undefined' ? new ImageData(p.data, p.width, p.height) : p);

/**
 * 识别 ArUco 码（与 aruco.js 的 detectMarkersInImage 结果相同）
 * @param {ImageBitmap} bitmap 原图（不会被转走，Worker 拿的是一份副本）
 * @param {number} [maxSide=1600]
 */
export async function detectMarkersOffThread(bitmap, maxSide = 1600) {
  if (supported()) {
    try {
      const r = await callWithBitmap(bitmap, { type: 'markers', maxSide });
      return { ...r, imageData: toImageData(r.imageData) };
    } catch (err) {
      console.warn('识别码改在主线程进行：', err);
    }
  }
  return detectMarkersInImage(bitmap, maxSide);
}

/**
 * 读整张照片的像素；不支持 Worker 时返回 null（调用方按需在主线程读）
 * @param {ImageBitmap} bitmap
 * @returns {Promise<ImageData|null>}
 */
export async function readPixelsOffThread(bitmap) {
  if (!supported()) return null;
  try {
    return toImageData(await callWithBitmap(bitmap, { type: 'pixels' }));
  } catch (err) {
    console.warn('读取照片像素改在主线程进行：', err);
    return null;
  }
}

/**
 * 颜色分割（与 colorSeg.js 的 segmentParts 结果相同）。图像数据复制一份给 Worker（调用方还要用）
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 */
export async function segmentPartsOffThread(img, Hinv, pxPerMm) {
  if (supported()) {
    try {
      return await call({ type: 'colorSeg', imageData: { width: img.width, height: img.height, data: img.data }, Hinv, pxPerMm });
    } catch (err) {
      console.warn('颜色分割改在主线程进行：', err);
    }
  }
  return segmentParts(img, Hinv, pxPerMm);
}
