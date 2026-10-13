// 一次流程运行的分步耗时（纯函数，不碰 DOM）。
// 一次运行从"选好照片"（或切换内参来源）开始，到转场开始（或场景建立、某步出错）结束。
// 同一张照片已算过的步骤（例如切换内参来源时的识别码、检测）记为"沿用"，耗时 0。
// 与别的步骤同时进行的（颜色分割在模型推理期间做）记为"并行"，不计入各步之和。

/** 计时的步骤（按流程顺序） */
export const TIMING_STEPS = [
  { key: 'load', label: '读取照片' },
  { key: 'markers', label: '识别码' },
  { key: 'homography', label: '单应性 / 正射图' },
  { key: 'board', label: '底板贴图' },
  { key: 'pose', label: '位姿' },
  { key: 'model', label: '等待模型加载' },
  { key: 'detect', label: '检测' },
  { key: 'color', label: '颜色分割' },
  { key: 'map', label: '映射 / 朝向' },
  { key: 'scene', label: '建场景' },
];

/** 运行的起因 */
export const RUN_KINDS = { upload: '上传照片', sample: '示例', intrinsics: '切换内参来源' };

/**
 * 开始一次运行
 * @param {keyof typeof RUN_KINDS} kind
 * @param {number} t0 开始时刻（ms，performance.now()）
 * @param {{ until?: 'transition'|'scene' }} [opts] 运行到哪一步算结束
 */
export function createRun(kind, t0, { until = 'transition' } = {}) {
  return { kind, t0, until, steps: {}, end: null, error: null };
}

/**
 * 记录一步的耗时（运行结束后不再记录；同一步记多次时累加，例如检测重跑）
 * @param {ReturnType<typeof createRun>} run
 * @param {string} key TIMING_STEPS 里的 key
 * @param {number} ms
 * @param {{ cached?: boolean, parallel?: boolean }} [opts]
 * @returns {boolean} 是否记下
 */
export function recordStep(run, key, ms, { cached = false, parallel = false } = {}) {
  if (!run || run.end != null) return false;
  if (!TIMING_STEPS.some((s) => s.key === key)) throw new Error(`未知的计时步骤：${key}`);
  const s = run.steps[key];
  run.steps[key] = s ? { ms: s.ms + ms, cached: s.cached && cached, parallel: s.parallel && parallel } : { ms, cached, parallel };
  return true;
}

/**
 * 结束一次运行
 * @param {ReturnType<typeof createRun>} run
 * @param {number} t 结束时刻
 * @param {{ error?: string|null }} [opts] error：出错的步骤（步骤条的 key）
 */
export function finishRun(run, t, { error = null } = {}) {
  if (!run || run.end != null) return false;
  run.end = t;
  run.error = error;
  return true;
}

/**
 * 汇总：各步耗时（按流程顺序，只列记过的步骤）、各步之和、总耗时（墙钟）与"其他"（界面刷新、等待下一帧等）
 * @param {ReturnType<typeof createRun>} run
 * @param {number} now 运行还没结束时，总耗时算到 now
 */
export function summarizeRun(run, now) {
  const rows = TIMING_STEPS.filter((s) => run.steps[s.key]).map((s) => ({ ...s, ...run.steps[s.key] }));
  const sum = rows.reduce((a, r) => a + (r.parallel ? 0 : r.ms), 0);
  const total = (run.end ?? now) - run.t0;
  return { rows, sum, total, other: Math.max(0, total - sum), done: run.end != null };
}
