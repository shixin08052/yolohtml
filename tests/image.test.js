import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { readExif, isHeic } from '../src/vision/image.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('读取 EXIF', () => {
  it('横拍主摄：26 mm、5.7 mm、镜头型号、机型、方向 1', async () => {
    const e = await readExif(fixture('landscape_26.jpg'));
    expect(e).toEqual({
      focal35: 26,
      focalMm: 5.7,
      lensModel: 'iPhone 13 Pro back triple camera 5.7mm f/1.5',
      make: 'Apple',
      model: 'iPhone 13 Pro',
      orientation: 1,
    });
  });

  it('竖拍：方向为 6（显示时顺时针转 90°）', async () => {
    expect((await readExif(fixture('portrait_26.jpg'))).orientation).toBe(6);
  });

  it('长焦：等效焦距 77 mm', async () => {
    expect((await readExif(fixture('tele_77.jpg'))).focal35).toBe(77);
  });

  it('没有 EXIF（如微信转发）：全部为 null，不报错', async () => {
    const e = await readExif(fixture('no_exif.jpg'));
    expect(Object.values(e).every((v) => v === null)).toBe(true);
  });

  it('不是图片的数据：返回空 EXIF，不报错', async () => {
    const e = await readExif(new Uint8Array([1, 2, 3, 4, 5]));
    expect(e.focal35).toBeNull();
  });
});

describe('HEIC 识别', () => {
  const blob = (bytes, type = '', name = '') => Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name });
  const ftyp = (brand) => [0, 0, 0, 24, ...[...`ftyp${brand}`].map((c) => c.charCodeAt(0)), 0, 0, 0, 0];

  it('按 MIME 或扩展名识别', async () => {
    expect(await isHeic(blob([0], 'image/heic'))).toBe(true);
    expect(await isHeic(blob([0], '', 'IMG_0001.HEIC'))).toBe(true);
    expect(await isHeic(blob([0], '', 'a.heif'))).toBe(true);
  });

  it('扩展名被改掉时按文件头识别', async () => {
    expect(await isHeic(blob(ftyp('heic'), 'image/jpeg', 'x.jpg'))).toBe(true);
    expect(await isHeic(blob(ftyp('mif1'), '', 'x'))).toBe(true);
  });

  it('JPEG 不是 HEIC', async () => {
    expect(await isHeic(blob([...fixture('landscape_26.jpg')], 'image/jpeg', 'a.jpg'))).toBe(false);
  });
});
