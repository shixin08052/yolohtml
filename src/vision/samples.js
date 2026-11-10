// 示例照片（public/samples/）：列表与加载。合成图带真值，内参直接取真值。
import { fetchResource } from './request.js';

/** 示例目录的 URL（相对页面，兼容 GitHub Pages 子路径） */
const samplesURL = (name) => new URL(`samples/${name}`, document.baseURI).href;

/**
 * @returns {Promise<{key:string, label:string, image:string, truth?:string}[]>}
 */
export async function loadSampleIndex() {
  const json = await fetchResource(samplesURL('index.json'), { timeoutMs: 30000 });
  if (!Array.isArray(json?.samples)) throw new Error('示例列表格式无效');
  return json.samples;
}

/**
 * 加载一个示例
 * @param {{key:string, image:string, truth?:string}} entry
 * @returns {Promise<{image: import('../state.js').ImageInput, truth: import('../state.js').GroundTruth|null}>}
 */
export async function loadSample(entry, { signal, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let bitmap = null;
  try {
    const opts = { signal: controller.signal, timeoutMs };
    const [blob, truth] = await Promise.all([
      fetchResource(samplesURL(entry.image), { ...opts, type: 'blob' }),
      entry.truth ? fetchResource(samplesURL(entry.truth), opts) : Promise.resolve(null),
    ]);
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'none' });
    if (controller.signal.aborted) throw controller.signal.reason;
    return {
      image: {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        fileName: entry.image,
        exif: { focal35: null, focalMm: null, lensModel: null, make: null, model: null },
      },
      truth,
    };
  } catch (err) {
    controller.abort(err); // 一个资源失败时，同时停止另一个下载。
    bitmap?.close();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
