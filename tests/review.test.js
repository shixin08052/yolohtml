import { describe, expect, it } from 'vitest';
import { iou, trackEdits, mergeEdits, placeNewBox, reviewReasons, withUid } from '../src/vision/review.js';

const det = (box, extra = {}) => withUid({ cls: 1, name: 'LED', score: 0.9, box, ...extra });

describe('人工改框的记录', () => {
  it('删掉的框、改过的框原样记为"删掉"；改过和新画的标 manual', () => {
    const a = det([0, 0, 10, 10]);
    const b = det([20, 0, 40, 10]); // 框大了
    const c = det([50, 0, 60, 10]);
    const { boxes, removed } = trackEdits([a, b, c], [a, { ...b, box: [20, 0, 30, 10] }, { cls: 0, box: [70, 0, 80, 10] }]);
    expect(removed.map((d) => d.uid)).toEqual([b.uid, c.uid]);
    expect(boxes[0]).toBe(a);
    expect(boxes[1]).toMatchObject({ uid: b.uid, manual: true, box: [20, 0, 30, 10], score: 1 });
    expect(boxes[2].manual).toBe(true);
    expect(boxes[2].uid).toMatch(/^m/);
  });

  it('人工框再改、再删都不进"删掉"（它本来就不会被识别出来）', () => {
    const m = withUid({ cls: 1, box: [0, 0, 10, 10], manual: true, score: 1 }, 'm');
    expect(trackEdits([m], [{ ...m, box: [1, 0, 11, 10] }]).removed).toEqual([]);
    expect(trackEdits([m], []).removed).toEqual([]);
    // 编辑器里的副本没有 manual 标记也不丢
    const plain = { ...m };
    delete plain.manual;
    expect(trackEdits([m], [plain]).boxes[0].manual).toBe(true);
  });

  it('只改 LED 颜色也算改过', () => {
    const a = det([0, 0, 10, 10]);
    const { boxes, removed } = trackEdits([a], [{ ...a, color: 'green' }]);
    expect(boxes[0]).toMatchObject({ manual: true, color: 'green' });
    expect(removed).toHaveLength(1);
  });

  it('重新识别：删掉的不再出现，人工框保留且不与模型框重复', () => {
    const removed = [det([20, 0, 40, 10], { rawBox: [18, 0, 42, 10] }), det([50, 0, 60, 10])];
    const manual = [withUid({ cls: 1, box: [20, 0, 30, 10], manual: true }, 'm')];
    const fresh = [det([0, 0, 10, 10]), det([19, 0, 41, 10]), det([50.5, 0, 60.5, 10]), det([21, 0, 31, 10]), det([100, 0, 110, 10])];
    const { dets, dropped } = mergeEdits(fresh, { removed, manual });
    expect(dets.map((d) => d.box[0])).toEqual([0, 100, 20]);
    expect(dropped).toBe(3);
  });

  it('新画的框：重叠很多的替换掉，落在大框里时指出那个大框', () => {
    const boxes = [det([0, 0, 10, 10]), det([20, 0, 50, 20])];
    expect(placeNewBox(boxes, [1, 0, 11, 10])).toEqual({ replace: [0], inside: -1 });
    expect(placeNewBox(boxes, [22, 2, 32, 12])).toEqual({ replace: [], inside: 1 });
    expect(placeNewBox(boxes, [70, 0, 80, 10])).toEqual({ replace: [], inside: -1 });
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3);
  });
});

describe('哪些零件要人确认', () => {
  it('低置信度、颜色补的、拆出来的、颜色没认出的；人工框只看颜色', () => {
    expect(reviewReasons({ cls: 1, color: 'red' }, { score: 0.9 })).toEqual([]);
    expect(reviewReasons({ cls: 1, color: 'red' }, { score: 0.3, low: true })).toEqual(['置信度低（0.30）']);
    expect(reviewReasons({ cls: 1 }, { origin: 'color', score: 1 })).toEqual(['模型没框到，按颜色补的', '颜色没认出']);
    expect(reviewReasons({ cls: 1, color: 'clear' }, { score: 0.9, fit: 'split' })).toEqual(['从一个大框拆出来的']);
    expect(reviewReasons({ cls: 0 }, { score: 0.95 })).toEqual([]);
    expect(reviewReasons({ cls: 1 }, { score: 0.2, manual: true })).toEqual(['颜色没认出']);
  });
});
