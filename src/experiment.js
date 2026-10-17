// 实验记录（纯函数，不碰 DOM）：零件定位误差、手机高度误差、实验记录的组装、CSV 导出与本地保存。
// 误差 = 系统给出的零件坐标与用尺子量的真实坐标之间的距离（mm）；方法 1 = 不修正视差（xPlane, yPlane），
// 方法 2 = 视差修正（xParallax, yParallax）。

/** 内参来源的中文名 */
export const SOURCE_LABELS = { exif: 'EXIF 等效焦距', calib: '固定内参', truth: '真值', self: '由照片估计' };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 每个零件的误差与汇总
 * @param {import('./state.js').Part[]} parts
 * @param {Record<number, { x?: number|null, y?: number|null }>} measured 零件 id → 实测坐标（mm），没填的跳过
 * @returns {{ rows: object[], summary: { n: number, mean1: number|null, max1: number|null, mean2: number|null, max2: number|null } }}
 */
export function partErrors(parts, measured) {
  const rows = parts.map((p) => {
    const m = measured[p.id];
    const has = !!m && finite(m.x) && finite(m.y);
    const row = { id: p.id, cls: p.cls, name: p.name, score: p.score, rotDeg: p.rotDeg, x1: p.xPlane, y1: p.yPlane, x2: p.xParallax, y2: p.yParallax, tx: has ? m.x : null, ty: has ? m.y : null, e1: null, e2: null };
    if (has) {
      row.e1 = Math.hypot(p.xPlane - m.x, p.yPlane - m.y);
      row.e2 = Math.hypot(p.xParallax - m.x, p.yParallax - m.y);
    }
    return row;
  });
  const done = rows.filter((r) => r.e1 != null);
  const stat = (k) => (done.length ? { mean: done.reduce((a, r) => a + r[k], 0) / done.length, max: Math.max(...done.map((r) => r[k])) } : { mean: null, max: null });
  const s1 = stat('e1');
  const s2 = stat('e2');
  return { rows, summary: { n: done.length, mean1: s1.mean, max1: s1.max, mean2: s2.mean, max2: s2.max } };
}

/**
 * 草稿里的实测值对应到当前的零件。零件编号就是检测框的顺序，删框、重新检测后会变，所以每条实测值都记下了
 * 录入时零件的类别和位置（px, py：方法 2 的坐标）；按同类、距离最近（maxDist 以内）重新对应。
 * 没有记位置的旧草稿（键就是零件编号）按编号对应。
 * @param {import('./state.js').Part[]} parts
 * @param {Record<string, { x?: number|null, y?: number|null, cls?: number, px?: number, py?: number }>} measured 实测值，键为条目名
 * @param {number} [maxDist=15]
 * @returns {Record<number, string>} 零件 id → 条目名
 */
export function resolveMeasured(parts, measured, maxDist = 15) {
  const map = {};
  const pairs = [];
  for (const [k, m] of Object.entries(measured)) {
    if (!m || !finite(m.px) || !finite(m.py)) continue;
    for (const p of parts) {
      if (p.cls !== m.cls) continue;
      const d = Math.hypot(p.xParallax - m.px, p.yParallax - m.py);
      if (d <= maxDist) pairs.push({ k, id: p.id, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedK = new Set();
  for (const { k, id } of pairs) {
    if (usedK.has(k) || id in map) continue;
    usedK.add(k);
    map[id] = k;
  }
  for (const p of parts) {
    const m = measured[String(p.id)];
    if (!(p.id in map) && m && !finite(m.px) && !usedK.has(String(p.id))) map[p.id] = String(p.id);
  }
  return map;
}

/** 按 resolveMeasured 的对应关系取出每个零件的实测值（零件 id → 实测值），给 partErrors 用 */
export function measuredByPart(parts, measured) {
  const map = resolveMeasured(parts, measured);
  return Object.fromEntries(Object.entries(map).map(([id, k]) => [id, measured[k]]));
}

/**
 * 手机高度：系统结果与卷尺实测之差
 * @param {number} systemMm
 * @param {number|null} measuredMm
 * @returns {{ diffMm: number, pct: number }|null}
 */
export function heightError(systemMm, measuredMm) {
  if (!finite(systemMm) || !finite(measuredMm) || measuredMm <= 0) return null;
  const diffMm = systemMm - measuredMm;
  return { diffMm, pct: (diffMm / measuredMm) * 100 };
}

/**
 * 组装一条实验记录（存进本地、导出 CSV 用）
 * @param {{
 *   id: string, time: string, photo: { fileName: string, width: number, height: number },
 *   intrinsics: { source: string, fx: number }, pose: { heightMm: number, pitchDeg: number, reprojErrPx: number },
 *   parts: import('./state.js').Part[], measured: Record<number, {x?: number|null, y?: number|null}>,
 *   measuredHeightMm: number|null, method: 1|2, timing: { rows: {label: string, ms: number, cached?: boolean, parallel?: boolean}[], total: number }|null,
 *   note?: string,
 * }} p
 */
export function buildRecord(p) {
  const { rows, summary } = partErrors(p.parts, p.measured);
  return {
    id: p.id,
    time: p.time,
    photo: p.photo.fileName,
    size: `${p.photo.width}×${p.photo.height}`,
    source: p.intrinsics.source,
    fx: p.intrinsics.fx,
    pitchDeg: p.pose.pitchDeg,
    heightMm: p.pose.heightMm,
    reprojErrPx: p.pose.reprojErrPx,
    measuredHeightMm: finite(p.measuredHeightMm) ? p.measuredHeightMm : null,
    height: heightError(p.pose.heightMm, p.measuredHeightMm),
    method: p.method,
    summary,
    parts: rows,
    timing: p.timing ? { rows: p.timing.rows.map((r) => ({ label: r.label, ms: r.ms, cached: !!r.cached, parallel: !!r.parallel })), total: p.timing.total } : null,
    note: p.note ?? '',
  };
}

/** 数字转 CSV 文本（保留 d 位小数；空值为空串） */
const num = (v, d = 2) => (finite(v) ? v.toFixed(d) : '');

/**
 * CSV 单元格转义：含逗号、引号、换行时加引号，引号写两遍。
 * 以 = + - @ 开头的文字（不是数字）前面加单引号，免得 Excel 当成公式执行（例如照片名叫 "=HYPERLINK(…)"）
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 表格 → CSV 文本：开头加 UTF-8 BOM（Excel 才能认出是 UTF-8、中文不乱码），行尾用 CRLF
 * @param {string[]} header
 * @param {(string|number|null)[][]} rows
 */
export function toCsv(header, rows) {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 所有记录里出现过的步骤名（按出现顺序），作为耗时列 */
function timingLabels(records) {
  const labels = [];
  for (const r of records) for (const t of r.timing?.rows ?? []) if (!labels.includes(t.label)) labels.push(t.label);
  return labels;
}

/**
 * 每次实验一行
 * @param {ReturnType<typeof buildRecord>[]} records
 */
export function experimentsCsv(records) {
  const steps = timingLabels(records);
  const header = [
    '序号', '时间', '照片', '分辨率', '内参来源', '焦距 fx (px)', '俯角 (°)', '重投影误差 (px)',
    '系统高度 (mm)', '实测高度 (mm)', '高度误差 (mm)', '高度误差 (%)',
    '零件数', '已填实测坐标的零件数', '方法1 平均误差 (mm)', '方法1 最大误差 (mm)', '方法2 平均误差 (mm)', '方法2 最大误差 (mm)', '当前采用方法',
    ...steps.map((s) => `耗时·${s} (ms)`), '总耗时 (ms)', '备注',
  ];
  const rows = records.map((r, i) => {
    const t = new Map((r.timing?.rows ?? []).map((x) => [x.label, x]));
    return [
      i + 1, r.time, r.photo, r.size, SOURCE_LABELS[r.source] ?? r.source, num(r.fx, 1), num(r.pitchDeg, 1), num(r.reprojErrPx, 2),
      num(r.heightMm, 1), num(r.measuredHeightMm, 1), num(r.height?.diffMm, 1), num(r.height?.pct, 2),
      r.parts.length, r.summary.n, num(r.summary.mean1), num(r.summary.max1), num(r.summary.mean2), num(r.summary.max2), r.method === 2 ? '方法2（视差修正）' : '方法1（不修正）',
      ...steps.map((s) => {
        const x = t.get(s);
        return !x ? '' : x.cached ? '沿用' : num(x.ms, 0);
      }),
      num(r.timing?.total, 0), r.note,
    ];
  });
  return toCsv(header, rows);
}

/**
 * 每个零件一行
 * @param {ReturnType<typeof buildRecord>[]} records
 */
export function partsCsv(records) {
  const header = [
    '实验序号', '时间', '照片', '内参来源', '零件编号', '类别', '置信度', '朝向 (°)',
    '方法1 X (mm)', '方法1 Y (mm)', '方法2 X (mm)', '方法2 Y (mm)', '实测 X (mm)', '实测 Y (mm)', '方法1 误差 (mm)', '方法2 误差 (mm)',
  ];
  const rows = [];
  records.forEach((r, i) => {
    for (const p of r.parts) {
      rows.push([
        i + 1, r.time, r.photo, SOURCE_LABELS[r.source] ?? r.source, p.id, p.name, num(p.score, 2), num(p.rotDeg, 0),
        num(p.x1), num(p.y1), num(p.x2), num(p.y2), num(p.tx), num(p.ty), num(p.e1), num(p.e2),
      ]);
    }
  });
  return toCsv(header, rows);
}

/* ------------------------------------------------------------------ */
/* 本地保存（localStorage）：已记录的实验 + 每张照片还没记录的输入（草稿）       */
/* ------------------------------------------------------------------ */

export const STORAGE_KEY = 'yolohtml.experiments.v1';

/** 照片的草稿键：文件名 + 尺寸（重新上传同一张照片时能找回填过的值） */
export const photoKey = ({ fileName, width, height }) => `${fileName}|${width}×${height}`;

/**
 * 读出保存的数据；没有或损坏时返回空的
 * @param {Storage|null} storage
 * @returns {{ records: object[], drafts: Record<string, { measured: object, heightCm: number|null }> }}
 */
export function loadStore(storage) {
  try {
    const j = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (j && Array.isArray(j.records) && j.drafts && typeof j.drafts === 'object') {
      // 结构不对的记录（例如旧版本存的）丢掉，免得界面读字段时出错
      const ok = (r) => r && typeof r.id === 'string' && typeof r.time === 'string' && r.summary && typeof r.summary === 'object' && Array.isArray(r.parts);
      return { records: j.records.filter(ok), drafts: j.drafts };
    }
  } catch {
    // 损坏或无法读取（隐私模式等）：当作没有
  }
  return { records: [], drafts: {} };
}

/**
 * 保存；失败（存储已满、隐私模式）时返回 false
 * @param {Storage|null} storage
 * @param {{ records: object[], drafts: object }} data
 */
export function saveStore(storage, data) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
