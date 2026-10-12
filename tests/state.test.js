import { describe, it, expect } from 'vitest';
import { Store, STAGES } from '../src/state.js';

describe('state 状态机', () => {
  it('按顺序前进并发出事件', () => {
    const s = new Store();
    const seen = [];
    s.on('change', (e) => seen.push(e.stage));
    let got = null;
    s.on('stage:imageLoaded', (st) => (got = st.image));
    s.advance('imageLoaded', { image: { fileName: 'a.jpg' } });
    s.advance('calibrated', { calib: { H: 1 } });
    expect(seen).toEqual(['imageLoaded', 'calibrated']);
    expect(got.fileName).toBe('a.jpg');
  });

  it('不能跳步', () => {
    const s = new Store();
    expect(() => s.advance('posed')).toThrow();
  });

  it('重跑某一步时清空其后的数据', () => {
    const s = new Store();
    s.advance('imageLoaded', { image: 1 });
    s.advance('calibrated', { calib: 2 });
    s.advance('posed', { pose: 3 });
    s.advance('calibrated', { calib: 4 });
    expect(s.state.stage).toBe('calibrated');
    expect(s.state.calib).toBe(4);
    expect(s.state.pose).toBeNull();
    expect(s.state.image).toBe(1);
  });

  it('失败时停在当前状态并记录原因', () => {
    const s = new Store();
    s.advance('imageLoaded', { image: 1 });
    let err = null;
    s.on('error', (e) => (err = e));
    s.fail('calib', '只识别到 2 个码');
    expect(s.state.stage).toBe('imageLoaded');
    expect(err).toEqual({ step: 'calib', reason: '只识别到 2 个码' });
    s.advance('calibrated', { calib: 1 });
    expect(s.state.error).toBeNull();
  });

  it('回退', () => {
    const s = new Store();
    for (const st of STAGES.slice(1, 5)) s.advance(st, {});
    s.rollback('calibrated');
    expect(s.state.stage).toBe('calibrated');
  });
});

describe('状态文字', async () => {
  const { STAGE_LABELS } = await import('../src/state.js');
  it('每个状态都有中文说明', () => {
    for (const st of STAGES) expect(STAGE_LABELS[st]).toBeTruthy();
  });
});
