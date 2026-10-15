// 读取照片：按 EXIF 方向转正，读取 EXIF 中与相机有关的字段。
// 实验结论（exifr 7.1.3）：exifr.parse(输入, { pick, translateValues: false }) 返回
// FocalLengthIn35mmFormat、FocalLength、LensModel、Make、Model、Orientation（数字）；
// 没有 EXIF 时返回 undefined。
import exifr from 'exifr';

/** 照片格式不支持等预期内的错误：直接把 message 展示给用户 */
export class ImageFormatError extends Error {}

export const HEIC_MESSAGE = '不支持 HEIC/HEIF 格式。请在 iPhone 设置 → 相机 → 格式中选择"兼容性最佳"后重新拍摄。';

/**
 * 是否为 HEIC/HEIF：看 MIME、扩展名，以及文件头（ISO BMFF 的 ftyp 品牌）
 * @param {Blob & {name?: string}} file
 */
export async function isHeic(file) {
  if (/hei[cf]/i.test(file.type ?? '') || /\.hei[cf]$/i.test(file.name ?? '')) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...head.slice(4, 12));
  return s.startsWith('ftyp') && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(s.slice(4, 8));
}

/**
 * 读取 EXIF（不需要浏览器 DOM，Node 下可直接传 Buffer 测试）
 * @param {Blob|ArrayBuffer|Uint8Array} input
 * @returns {Promise<import('../state.js').ImageInput['exif']>}
 */
export async function readExif(input) {
  let tags;
  try {
    tags = await exifr.parse(input, {
      pick: ['FocalLengthIn35mmFormat', 'FocalLength', 'LensModel', 'Make', 'Model', 'Orientation'],
      translateValues: false,
    });
  } catch {
    tags = null;
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return {
    focal35: num(tags?.FocalLengthIn35mmFormat),
    focalMm: num(tags?.FocalLength),
    lensModel: str(tags?.LensModel),
    make: str(tags?.Make),
    model: str(tags?.Model),
    orientation: num(tags?.Orientation),
  };
}

/**
 * 读取用户上传的照片
 * @param {File} file
 * @returns {Promise<import('../state.js').ImageInput>}
 */
export async function loadImageFile(file) {
  if (await isHeic(file)) throw new ImageFormatError(HEIC_MESSAGE);
  let bitmap;
  try {
    // 按 EXIF 方向转正（竖拍照片的像素是横着存的）；不做色彩空间转换：训练时（PIL）读的就是原始像素值，
    // iPhone 的 Display P3 照片若转成 sRGB，红、蓝会更饱和，与训练和颜色分割阈值不一致
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'none' });
  } catch {
    throw new ImageFormatError('无法读取这张图片，请上传 JPEG 或 PNG。');
  }
  const exif = await readExif(file);
  return { bitmap, width: bitmap.width, height: bitmap.height, fileName: file.name, exif };
}
