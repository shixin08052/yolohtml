// 元件清点与自选清单（纯函数，不碰 DOM）。
// 清点：照片里每种元件各有几个；自选清单：每种想要几个（可以比板上的多，多出来的记为"缺"）。
// 种类用 robot/bins.js 的 binKey：'resistor'、'led-red' …、颜色未知的 'led'。
import { CLASSES, LED_COLORS } from '../config.js';
import { binKey, binsFor } from './bins.js';
import { plan, DEFAULT_FOOTPRINT, GRIP_WIDTH, GRASP_Z, gripYawFor } from './planner.js';
import { assessGrasp } from './clearance.js';
import { ikWorld } from './ik.js';

/** 清单里固定列出的种类（顺序即显示顺序） */
export const ORDER_KINDS = [
  { key: 'resistor', label: CLASSES[0].name, hex: CLASSES[0].color },
  ...Object.entries(LED_COLORS).map(([c, v]) => ({ key: `led-${c}`, label: `${v.name} LED`, hex: v.hex })),
];
const UNKNOWN_LED = { key: 'led', label: 'LED（颜色未知）', hex: CLASSES[1].color };

/** 每种最多要多少个（输入框上限，防止误填） */
export const ORDER_MAX = 999;

/**
 * 清点：每种元件板上有几个
 * @param {{ cls: number, color?: string }[]} parts
 * @returns {Record<string, number>}
 */
export function inventory(parts) {
  const out = {};
  for (const p of parts) out[binKey(p)] = (out[binKey(p)] ?? 0) + 1;
  return out;
}

/** 把数量整理成 0–ORDER_MAX 的整数；不是数字时为 0 */
export function clampCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(ORDER_MAX, Math.max(0, n)) : 0;
}

/**
 * 整理一份清单：只留认识的种类、数量取整，0 的去掉
 * @param {Record<string, unknown>|null|undefined} order
 * @returns {Record<string, number>}
 */
export function normalizeOrder(order) {
  const out = {};
  if (!order || typeof order !== 'object') return out;
  const known = new Set([...ORDER_KINDS.map((k) => k.key), UNKNOWN_LED.key]);
  for (const [key, v] of Object.entries(order)) {
    if (!known.has(key)) continue;
    const n = clampCount(v);
    if (n > 0) out[key] = n;
  }
  return out;
}

/**
 * 按清单挑零件。
 * order 为 null 表示全部分拣（每种要的数量 = 板上的数量）。
 * 优先可达、实际夹爪遮挡最少的；每选一颗重算遮挡，其次置信度和编号。
 * @param {{ id: number, cls: number, color?: string, score?: number, x: number, y: number }[]} parts
 * @param {Record<string, number>|null} order
 * @param {{ footprints?: object, arm?: object }} [opts] 与运动规划相同的占地和机械臂参数
 * @returns {{
 *   ids: Set<number>,
 *   lines: { key: string, label: string, hex: string, have: number, want: number, pick: number, short: number }[],
 *   totalWant: number, totalPick: number, totalShort: number, custom: boolean
 * }}
 *   lines：固定的几种 + 板上出现的颜色未知 LED；pick = min(have, want)，short = want − pick
 */
export function selectForOrder(parts, order, { footprints = {}, arm } = {}) {
  const have = inventory(parts);
  const kinds = [...ORDER_KINDS];
  if (have[UNKNOWN_LED.key] || order?.[UNKNOWN_LED.key]) kinds.push(UNKNOWN_LED);
  const ids = new Set();
  const fps = Object.fromEntries(parts.map((p) => [p.cls, footprints[p.cls] ?? DEFAULT_FOOTPRINT]));
  // 每挑走一个目标，重算剩余元件的实际夹爪遮挡；可达的优先。
  const remaining = new Map(parts.map((p) => [p.id, p]));
  const needed = Object.fromEntries(kinds.map((k) => [k.key, order ? clampCount(order[k.key] ?? 0) : (have[k.key] ?? 0)]));
  while (true) {
    const candidates = [...remaining.values()].filter((p) => needed[binKey(p)] > 0).map((p) => {
      const access = assessGrasp(p, [...remaining.values()].filter((o) => o.id !== p.id), {
        width: GRIP_WIDTH[p.cls] ?? 5, fps,
        ok: (pt) => !arm || [GRASP_Z, GRASP_Z + arm.approach].every((z) => ikWorld([pt[0], pt[1], z], arm, { gripYaw: gripYawFor(p) }).reachable),
      });
      return { part: p, blocked: access?.blockers.length ?? Infinity };
    });
    if (!candidates.length) break;
    candidates.sort((a, b) => a.blocked - b.blocked || (b.part.score ?? 0) - (a.part.score ?? 0) || a.part.id - b.part.id);
    const p = candidates[0].part;
    ids.add(p.id);
    remaining.delete(p.id);
    needed[binKey(p)]--;
  }
  const lines = kinds.map((k) => {
    const n = have[k.key] ?? 0;
    const want = order ? clampCount(order[k.key] ?? 0) : n;
    const pick = Math.min(n, want);
    return { ...k, have: n, want, pick, short: want - pick };
  });
  const sum = (f) => lines.reduce((s, l) => s + l[f], 0);
  return { ids, lines, totalWant: sum('want'), totalPick: sum('pick'), totalShort: sum('short'), custom: !!order };
}

/**
 * 清单 CSV 的表头和行（清点 + 需求 + 缺口）
 * @param {ReturnType<typeof selectForOrder>} sel
 */
export function orderTable(sel) {
  return {
    header: ['元件', '板上数量', '需要数量', '本次分拣', '缺'],
    rows: [...sel.lines.filter((l) => l.have || l.want).map((l) => [l.label, l.have, l.want, l.pick, l.short]), ['合计', sel.lines.reduce((s, l) => s + l.have, 0), sel.totalWant, sel.totalPick, sel.totalShort]],
  };
}

/** 按清单规划：只把目标送入料盒，障碍拨开或夹起暂放到板上空位。 */
export function planForOrder(parts, sel, arm, opts = {}) {
  const bins = binsFor(parts.filter((p) => sel.ids.has(p.id)));
  const result = plan(parts, bins, arm, { ...opts, only: sel.custom ? sel.ids : null });
  const moved = new Set(result.tasks.filter((t) => t.kind !== 'pick' && !sel.ids.has(t.partId)).map((t) => t.partId));
  return { ...result, bins, moved };
}
