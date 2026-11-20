// 人工复核（纯函数，不碰 DOM）：
// 1. 哪些零件要请人确认（reviewReasons）；
// 2. 人工改框的记录（trackEdits）：删掉的框、改过的框记下来，重新识别时不再冒出来（mergeEdits），
//    人工框 / 改过的框始终保留，模型在同一处给的框让给人工框，不会重复。
// 框的身份用 uid：模型给的框识别时编号（'d…'），人工画的框 'm…'；改过的框保留 uid、标 manual。

/** 复核阈值 */
export const REVIEW = {
  minScore: 0.5, // 置信度低于它的模型框请人看一眼
  removedIou: 0.5, // 新识别的框与删掉的框重叠这么多：算同一个，不再出现
  manualIou: 0.3, // 新识别的框与人工框重叠这么多：让给人工框
  dupIou: 0.5, // 新画的框与已有框重叠这么多：替换掉已有的（不重复）
  insideFrac: 0.7, // 新画的框有这么多落在一个大得多的框里：提醒那个可能是框大了
};

/** 两个框 [x1, y1, x2, y2] 的交并比 */
export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
}

const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
/** a 落在 b 里的比例 */
export function insideFrac(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? (w * h) / area(a) : 0;
}

let uidSeq = 0;
/** 给没有编号的框编号（prefix：'d' 模型框，'m' 人工框） */
export function withUid(d, prefix = 'd') {
  return d.uid ? d : { ...d, uid: `${prefix}${++uidSeq}` };
}

/** 框里人会改的部分（位置、类别、人工指定的 LED 颜色） */
const sig = (d) => JSON.stringify([d.box.map((v) => Math.round(v * 10) / 10), d.cls, d.color ?? null]);

/**
 * 框选编辑后：哪些框被删了、哪些改过（改过的标 manual，原来的样子也算"删掉"，免得重新识别时原框又回来）
 * @param {object[]} prev 编辑前的框
 * @param {object[]} next 编辑后的框
 * @returns {{ boxes: object[], removed: object[] }}
 */
export function trackEdits(prev, next) {
  const before = new Map(prev.filter((d) => d.uid).map((d) => [d.uid, d]));
  const removed = [];
  const boxes = next.map((d) => {
    const old = d.uid ? before.get(d.uid) : null;
    if (!old) return withUid({ ...d, manual: true, score: 1 }, 'm');
    if (sig(old) === sig(d)) return old; // 没改：沿用原来的（带着 manual 等标记）
    if (!old.manual) removed.push(old);
    return { ...d, manual: true, score: 1, low: undefined, origin: undefined, fit: undefined, rawBox: undefined };
  });
  const kept = new Set(next.map((d) => d.uid).filter(Boolean));
  for (const d of prev) if (d.uid && !kept.has(d.uid) && !d.manual) removed.push(d);
  return { boxes, removed };
}

/**
 * 重新识别后合并人工修改：删掉的不再出现，人工框保留、同一处的模型框让给人工框
 * @param {object[]} fresh 新识别的框
 * @param {{ removed: object[], manual: object[] }} edits
 * @returns {{ dets: object[], dropped: number }}
 */
export function mergeEdits(fresh, { removed = [], manual = [] }, o = REVIEW) {
  const boxesOf = (d) => [d.box, d.rawBox].filter(Boolean);
  const hit = (d, list, thr) => list.some((r) => boxesOf(d).some((a) => boxesOf(r).some((b) => iou(a, b) >= thr)));
  const kept = fresh.filter((d) => !hit(d, removed, o.removedIou) && !hit(d, manual, o.manualIou));
  return { dets: [...kept, ...manual], dropped: fresh.length - kept.length };
}

/**
 * 新画一个框：与它重叠很多的已有框被替换（不重复）；落在一个大得多的框里时给出那个框的下标（多半是框大了）
 * @param {object[]} boxes
 * @param {number[]} box
 * @returns {{ replace: number[], inside: number }}
 */
export function placeNewBox(boxes, box, o = REVIEW) {
  const replace = [];
  let inside = -1;
  boxes.forEach((d, i) => {
    if (iou(d.box, box) >= o.dupIou) replace.push(i);
    else if (inside < 0 && insideFrac(box, d.box) >= o.insideFrac && area(d.box) >= 1.6 * area(box)) inside = i;
  });
  return { replace, inside };
}

/**
 * 零件要请人确认的原因（空数组 = 不用）
 * @param {{ cls: number, color?: string }} part
 * @param {{ manual?: boolean, origin?: string, low?: boolean, score?: number, fit?: string }|undefined} det
 * @returns {string[]}
 */
export function reviewReasons(part, det, o = REVIEW) {
  const out = [];
  if (det && !det.manual) {
    if (det.origin === 'color') out.push('模型没框到，按颜色补的');
    else if (det.low || (det.score ?? 1) < o.minScore) out.push(`置信度低（${(det.score ?? 0).toFixed(2)}）`);
    if (det.fit === 'split') out.push('从一个大框拆出来的');
  }
  if (part.cls === 1 && !part.color) out.push('颜色没认出');
  return out;
}
