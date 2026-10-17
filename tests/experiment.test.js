import { describe, it, expect } from 'vitest';
import { partErrors, heightError, buildRecord, csvCell, toCsv, experimentsCsv, partsCsv, loadStore, saveStore, photoKey, STORAGE_KEY } from '../src/experiment.js';

const part = (id, x1, y1, x2, y2, extra = {}) => ({ id, cls: 0, name: '色环电阻', score: 0.9, rotDeg: 30, xPlane: x1, yPlane: y1, xParallax: x2, yParallax: y2, ...extra });
const parts = [part(0, 100, 50, 101, 51), part(1, 200, 80, 198, 83, { cls: 1, name: 'LED' }), part(2, 150, 150, 150, 150)];

/** 简单的内存 Storage */
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

describe('实验记录：误差', () => {
  it('手算核对：零件 0 实测 (103, 54) → 方法1 误差 √(3²+4²) = 5，方法2 误差 √(2²+3²) ≈ 3.606', () => {
    const { rows, summary } = partErrors(parts, { 0: { x: 103, y: 54 }, 1: { x: 198, y: 80 } });
    expect(rows[0].e1).toBeCloseTo(5, 12);
    expect(rows[0].e2).toBeCloseTo(Math.sqrt(13), 12);
    // 零件 1：方法1 √(2²+0²) = 2，方法2 √(0²+3²) = 3
    expect(rows[1].e1).toBeCloseTo(2, 12);
    expect(rows[1].e2).toBeCloseTo(3, 12);
    // 没填的零件不参与
    expect(rows[2]).toMatchObject({ tx: null, ty: null, e1: null, e2: null });
    expect(summary).toEqual({ n: 2, mean1: 3.5, max1: 5, mean2: expect.closeTo((Math.sqrt(13) + 3) / 2, 12), max2: expect.closeTo(Math.sqrt(13), 12) });
  });

  it('只填了一个坐标、或不是数字时算没填；都没填时汇总为空', () => {
    const { summary } = partErrors(parts, { 0: { x: 103, y: null }, 1: { x: NaN, y: 2 } });
    expect(summary).toEqual({ n: 0, mean1: null, max1: null, mean2: null, max2: null });
  });

  it('手机高度误差：系统 − 实测，百分比相对实测', () => {
    expect(heightError(252, 250)).toEqual({ diffMm: 2, pct: 0.8 });
    expect(heightError(245, 250).pct).toBeCloseTo(-2, 12);
    expect(heightError(250, null)).toBeNull();
    expect(heightError(250, 0)).toBeNull();
  });
});

const rec = (over = {}) =>
  buildRecord({
    id: 'r1', time: '2026-10-14 10:00:00', photo: { fileName: 'IMG_1,2.jpg', width: 4032, height: 3024 },
    intrinsics: { source: 'calib', fx: 3060.4 }, pose: { heightMm: 252.34, pitchDeg: 71.2, reprojErrPx: 0.81 },
    parts, measured: { 0: { x: 103, y: 54 } }, measuredHeightMm: 250, method: 2,
    timing: { rows: [{ label: '读取照片', ms: 150.4 }, { label: '识别码', ms: 0, cached: true }, { label: '颜色分割', ms: 400, parallel: true }], total: 3012.7 },
    ...over,
  });

describe('实验记录：CSV', () => {
  it('单元格转义：逗号、引号、换行', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('说"明"')).toBe('"说""明"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3)).toBe('3');
  });

  it('开头 UTF-8 BOM，行尾 CRLF', () => {
    const s = toCsv(['甲', '乙'], [[1, '中文']]);
    expect(s.charCodeAt(0)).toBe(0xfeff);
    expect(s).toBe('﻿甲,乙\r\n1,中文\r\n');
  });

  it('每次实验一行：列名中文、数值正确、耗时列按步骤展开', () => {
    const csv = experimentsCsv([rec(), rec({ id: 'r2', intrinsics: { source: 'exif', fx: 3028 }, measuredHeightMm: null, timing: null })]);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    const header = lines[0].split(',');
    expect(header).toContain('方法1 平均误差 (mm)');
    expect(header).toContain('耗时·读取照片 (ms)');
    expect(header).toContain('耗时·颜色分割 (ms)');
    const row = Object.fromEntries(header.map((h, i) => [h, lines[1].match(/("([^"]|"")*"|[^,]*)(,|$)/g)[i].replace(/,$/, '')]));
    expect(row['照片']).toBe('"IMG_1,2.jpg"');
    expect(row['内参来源']).toBe('固定内参');
    expect(row['系统高度 (mm)']).toBe('252.3');
    expect(row['高度误差 (mm)']).toBe('2.3');
    expect(row['方法1 平均误差 (mm)']).toBe('5.00');
    expect(row['方法2 平均误差 (mm)']).toBe('3.61');
    expect(row['已填实测坐标的零件数']).toBe('1');
    expect(row['耗时·识别码 (ms)']).toBe('沿用');
    expect(row['总耗时 (ms)']).toBe('3013');
    // 第二条没有实测高度、没有耗时：留空
    expect(lines[2]).toContain('EXIF 等效焦距');
  });

  it('每个零件一行：实测坐标、两种方法的误差', () => {
    const csv = partsCsv([rec()]);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(1 + parts.length);
    expect(lines[0].split(',').slice(-4)).toEqual(['实测 X (mm)', '实测 Y (mm)', '方法1 误差 (mm)', '方法2 误差 (mm)']);
    expect(lines[1].split(',').slice(-4)).toEqual(['103.00', '54.00', '5.00', '3.61']);
    expect(lines[3].split(',').slice(-4)).toEqual(['', '', '', '']);
  });
});

describe('实验记录：本地保存', () => {
  it('存进去再读出来一样；没有或损坏时返回空的', () => {
    const s = memStorage();
    expect(loadStore(s)).toEqual({ records: [], drafts: {} });
    const data = { records: [rec()], drafts: { [photoKey({ fileName: 'a.jpg', width: 4, height: 3 })]: { measured: { 0: { x: 1, y: 2 } }, heightCm: 25 } } };
    expect(saveStore(s, data)).toBe(true);
    expect(loadStore(s)).toEqual(JSON.parse(JSON.stringify(data)));
    s.setItem(STORAGE_KEY, '{oops');
    expect(loadStore(s)).toEqual({ records: [], drafts: {} });
    expect(loadStore(null)).toEqual({ records: [], drafts: {} });
  });

  it('保存失败（存储已满）时返回 false', () => {
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveStore(full, { records: [], drafts: {} })).toBe(false);
  });
});

describe('实验记录：检测结果变了时实测值跟着零件走', () => {
  const P = (id, cls, x, y) => ({ id, cls, name: '', score: 1, rotDeg: 0, xPlane: x, yPlane: y, xParallax: x, yParallax: y });

  it('删掉一个框、零件编号变了：按同类最近的位置对回原来的零件', async () => {
    const { resolveMeasured, measuredByPart } = await import('../src/experiment.js');
    const measured = {
      a: { x: 100.5, y: 50, cls: 0, px: 100, py: 50 },
      b: { x: 150, y: 80.5, cls: 1, px: 150, py: 80 },
      c: { x: 200, y: 20, cls: 0, px: 201, py: 21 },
    };
    // 原来的 #0 被删掉：#1 → #0，#2 → #1
    const parts = [P(0, 1, 150.4, 80.2), P(1, 0, 200.2, 20.5)];
    expect(resolveMeasured(parts, measured)).toEqual({ 0: 'b', 1: 'c' });
    expect(measuredByPart(parts, measured)[0]).toBe(measured.b);
    // 类别不同或离得太远的不对应
    expect(resolveMeasured([P(0, 0, 150, 80)], measured)).toEqual({});
    expect(resolveMeasured([P(0, 1, 180, 80)], measured)).toEqual({});
  });

  it('两个零件抢同一条实测值时给最近的那个；旧格式（按编号、没记位置）按编号对应', async () => {
    const { resolveMeasured } = await import('../src/experiment.js');
    const measured = { a: { x: 1, y: 1, cls: 0, px: 100, py: 50 }, 3: { x: 5, y: 5 } };
    expect(resolveMeasured([P(0, 0, 104, 50), P(1, 0, 101, 50), P(3, 1, 0, 0)], measured)).toEqual({ 1: 'a', 3: '3' });
  });
});

describe('实验记录：CSV 防公式注入', () => {
  it('以 = + - @ 开头的文字前加单引号，负数不受影响', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 2')).toBe("'+1 2");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('-12.80')).toBe('-12.80');
    expect(csvCell('-x')).toBe("'-x");
  });

  it('结构不对的旧记录读的时候丢掉', () => {
    const s = { getItem: () => JSON.stringify({ records: [{ id: 'a' }, null, { id: 'b', time: 't', summary: {}, parts: [] }], drafts: {} }) };
    expect(loadStore(s).records.map((r) => r.id)).toEqual(['b']);
  });
});
