import { describe, it, expect } from 'vitest';
import { createRun, recordStep, finishRun, summarizeRun, TIMING_STEPS } from '../src/timing.js';

describe('分步耗时', () => {
  it('按流程顺序列出记过的步骤，总耗时为墙钟时间，其他 = 总耗时 − 各步之和', () => {
    const run = createRun('upload', 1000);
    recordStep(run, 'pose', 5);
    recordStep(run, 'load', 300);
    recordStep(run, 'markers', 400);
    finishRun(run, 2000);
    const s = summarizeRun(run, 9999);
    expect(s.rows.map((r) => r.key)).toEqual(['load', 'markers', 'pose']);
    expect(s.sum).toBe(705);
    expect(s.total).toBe(1000);
    expect(s.other).toBe(295);
    expect(s.done).toBe(true);
  });

  it('沿用的步骤记为 cached；同一步记多次时累加', () => {
    const run = createRun('intrinsics', 0, { until: 'scene' });
    recordStep(run, 'markers', 0, { cached: true });
    recordStep(run, 'detect', 100);
    recordStep(run, 'detect', 50);
    const s = summarizeRun(run, 400);
    expect(s.rows).toEqual([
      { key: 'markers', label: '识别码', ms: 0, cached: true, parallel: false },
      { key: 'detect', label: '检测', ms: 150, cached: false, parallel: false },
    ]);
    expect(s.done).toBe(false);
    expect(s.total).toBe(400);
  });

  it('并行的步骤不计入各步之和', () => {
    const run = createRun('upload', 0);
    recordStep(run, 'detect', 1000);
    recordStep(run, 'color', 400, { parallel: true });
    finishRun(run, 1200);
    const s = summarizeRun(run, 0);
    expect(s.sum).toBe(1000);
    expect(s.other).toBe(200);
    expect(s.rows[1]).toMatchObject({ key: 'color', parallel: true });
  });

  it('结束后不再记录、不能再结束；出错时记下出错的步骤', () => {
    const run = createRun('sample', 0);
    expect(finishRun(run, 50, { error: 'calib' })).toBe(true);
    expect(recordStep(run, 'pose', 5)).toBe(false);
    expect(finishRun(run, 80)).toBe(false);
    expect(run).toMatchObject({ end: 50, error: 'calib' });
    expect(recordStep(null, 'pose', 1)).toBe(false);
  });

  it('未知步骤报错；步骤 key 不重复', () => {
    expect(() => recordStep(createRun('upload', 0), 'foo', 1)).toThrow(/未知/);
    expect(new Set(TIMING_STEPS.map((s) => s.key)).size).toBe(TIMING_STEPS.length);
  });
});
