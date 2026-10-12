import { describe, it, expect } from 'vitest';
import { markerCornerErrors } from '../src/vision/evaluate.js';

const sq = (id, x, y, s = 10) => ({ id, corners: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] });

describe('码角点误差', () => {
  it('按 ID 配对，计算平均与最大误差，列出缺少的 ID', () => {
    const truth = [sq(0, 0, 0), sq(1, 100, 0), sq(2, 100, 100)];
    const found = [sq(1, 103, 4), sq(0, 0, 0)];
    const r = markerCornerErrors(found, truth);
    expect(r.missing).toEqual([2]);
    expect(r.perId.find((p) => p.id === 0).max).toBe(0);
    expect(r.perId.find((p) => p.id === 1).mean).toBeCloseTo(5, 12);
    expect(r.mean).toBeCloseTo(2.5, 12);
    expect(r.max).toBeCloseTo(5, 12);
  });

  it('一个都没找到', () => {
    const r = markerCornerErrors([], [sq(0, 0, 0)]);
    expect(r.mean).toBeNull();
    expect(r.missing).toEqual([0]);
  });
});
