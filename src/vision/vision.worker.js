// 视觉计算 Worker：把会卡住页面的同步计算挪到主线程之外，加载动画不掉帧。
// - markers：照片缩到长边 maxSide，识别 ArUco 码（aruco.js 的 detectMarkersInImage，Worker 里用 OffscreenCanvas）；
// - pixels：读出整张照片的像素（看引脚、LED 颜色都要用原图）；
// - colorSeg：颜色分割补漏（colorSeg.js 的 segmentParts）。
// 像素数据都以 { width, height, data } 传回，data 的内存直接转交（不复制）。
import { detectMarkersInImage } from './aruco.js';
import { segmentParts } from './colorSeg.js';

const plain = (img) => ({ width: img.width, height: img.height, data: img.data });

self.onmessage = (e) => {
  const { id, type, bitmap } = e.data;
  try {
    if (type === 'markers') {
      const { bitmap, maxSide } = e.data;
      const r = detectMarkersInImage(bitmap, maxSide);
      const imageData = plain(r.imageData);
      self.postMessage({ id, ok: true, result: { markers: r.markers, small: r.small, scale: r.scale, imageData } }, [imageData.data.buffer]);
    } else if (type === 'pixels') {
      const { bitmap } = e.data;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const img = plain(ctx.getImageData(0, 0, canvas.width, canvas.height));
      self.postMessage({ id, ok: true, result: img }, [img.data.buffer]);
    } else if (type === 'colorSeg') {
      const { imageData, Hinv, pxPerMm } = e.data;
      self.postMessage({ id, ok: true, result: segmentParts(imageData, Hinv, pxPerMm) });
    } else {
      throw new Error(`未知的请求：${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  } finally {
    bitmap?.close();
  }
};
