import { describe, it, expect } from 'vitest';
import { detectionsFileName, serializeDetections, parseDetections, detectionsFromTruth, detect } from '../src/vision/detector.js';
import { CLASSES } from '../src/config.js';

const image = { fileName: 'IMG_0001.HEIC', width: 4032, height: 3024 };
const dets = [
  { cls: 1, name: CLASSES[1].name, score: 0.934, box: [100.04, 200.06, 180.5, 290] },
  { cls: 2, name: CLASSES[2].name, score: 1, box: [1000, 1200, 1060, 1250] },
];

describe('检测结果文件', () => {
  it('文件名', () => {
    expect(detectionsFileName('IMG_0001.HEIC')).toBe('IMG_0001.detections.json');
    expect(detectionsFileName('synth_45.png')).toBe('synth_45.detections.json');
    expect(detectionsFileName('a.b.jpg')).toBe('a.b.detections.json');
    expect(detectionsFileName('noext')).toBe('noext.detections.json');
  });

  it('保存再载入：内容一致（坐标保留 1 位小数）', () => {
    const json = JSON.parse(JSON.stringify(serializeDetections(dets, image)));
    expect(json.image).toBe('IMG_0001.HEIC');
    const back = parseDetections(json, image);
    expect(back).toHaveLength(2);
    back.forEach((d, i) => {
      expect(d.cls).toBe(dets[i].cls);
      expect(d.name).toBe(CLASSES[d.cls].name);
      d.box.forEach((x, k) => expect(x).toBeCloseTo(dets[i].box[k], 1));
    });
    expect(back[0].score).toBeCloseTo(0.93, 6);
  });

  it('直接是数组也能读；框的两角顺序颠倒时自动整理；缺置信度按 1', () => {
    const back = parseDetections([{ cls: 2, box: [50, 60, 10, 20] }], image);
    expect(back[0].box).toEqual([10, 20, 50, 60]);
    expect(back[0].score).toBe(1);
  });

  it('尺寸不同但比例相同：按比例缩放；比例不同：报错', () => {
    const json = serializeDetections(dets, { ...image, width: 2016, height: 1512 });
    const back = parseDetections(json, image);
    expect(back[1].box).toEqual([2000, 2400, 2120, 2500]);
    const rotated = serializeDetections(dets, { ...image, width: 3024, height: 4032 });
    expect(() => parseDetections(rotated, image)).toThrow(/方向或比例/);
  });

  it('类别或框无效时报错', () => {
    expect(() => parseDetections([{ cls: 4, box: [0, 0, 1, 1] }], image)).toThrow(/类别/);
    expect(() => parseDetections([{ cls: 1, box: [0, 0, 1] }], image)).toThrow(/box/);
    expect(() => parseDetections({ foo: 1 }, image)).toThrow(/detections/);
  });

  it('合成图：mock 检测直接用真值框', async () => {
    const truth = { parts: [{ cls: 3, x: 1, y: 2, heightMm: 4, box: [1, 2, 3, 4] }] };
    expect(detectionsFromTruth(truth)).toEqual([{ cls: 3, name: CLASSES[3].name, score: 1, box: [1, 2, 3, 4] }]);
    expect(await detect(image, { truth })).toEqual(detectionsFromTruth(truth));
    // 已删除的类别被跳过
    expect(detectionsFromTruth({ parts: [...truth.parts, { cls: 5, x: 0, y: 0, heightMm: 1, box: [0, 0, 1, 1] }] })).toHaveLength(1);
    await expect(detect(image, { mode: 'onnx' })).rejects.toThrow(/步骤 14/);
  });
});
