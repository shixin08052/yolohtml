import { describe, it, expect } from 'vitest';
import { inventory, selectForOrder, planForOrder, normalizeOrder, clampCount, orderTable, ORDER_KINDS, ORDER_MAX } from '../src/robot/order.js';
import { plan } from '../src/robot/planner.js';
import { binsFor } from '../src/robot/bins.js';
import { ARM, CLASSES } from '../src/config.js';
import { partFootprint } from '../src/scene/parts.js';
import { assessGrasp, partPolys } from '../src/robot/clearance.js';
import { polysOverlap } from '../src/robot/drop.js';
import { ikWorld } from '../src/robot/ik.js';
import { buildSequence } from '../src/robot/sequence.js';
import { sortInstructions, instructionsCsv } from '../src/robot/export.js';
import { ARM_HOME } from '../src/scene/arm.js';

const part = (id, cls, color, score = 0.9, x = 60 + id * 25, y = 100) => ({ id, cls, color, score, x, y, rotDeg: 0, name: CLASSES[cls].name, heightMm: CLASSES[cls].heightMm });
const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));
const options = { footprints, arm: ARM };
const parts = [part(0, 0), part(1, 0, undefined, 0.5), part(2, 1, 'red', 0.6), part(3, 1, 'red', 0.95), part(4, 1, 'red', 0.8), part(5, 1, 'blue')];
// 实拍 IMG_9902 的紧密灯组：绿灯位于 (145.9, 101.8)，外围红灯能拨开，但绿灯最终仍夹不起来。
const blockedGreen = [
  [146.7, 78.2, 358, 'red'], [145.9, 101.8, 190, 'green'], [144.8, 90.8, 357, 'clear'],
  [146.8, 84.3, 172, 'clear'], [146.5, 97.1, 181, 'clear'],
].map(([x, y, rotDeg, color], id) => ({ ...part(id, 1, color, 0.9, x, y), rotDeg }));

describe('元件清点与自选清单', () => {
  it('只选夹不起来的绿 LED：跳过目标，不执行试排中无效的拨开或挪位', () => {
    const before = structuredClone(blockedGreen);
    const res = planForOrder(blockedGreen, selectForOrder(blockedGreen, { 'led-green': 1 }, options), ARM, { footprints });
    expect(res.tasks).toEqual([]);
    expect(res.moved.size).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ id: 1, x: 145.9, y: 101.8 });
    expect(res.skipped[0].skipReason).toContain('安全挪位');
    expect(blockedGreen).toEqual(before);
    expect(sortInstructions(res, blockedGreen, res.bins, CLASSES, ARM).steps).toEqual([]);
  });

  it('红灯可取而绿灯失败：保留红灯所需的拨开，撤销之后为绿灯试排的所有准备动作', () => {
    const res = planForOrder(blockedGreen, selectForOrder(blockedGreen, { 'led-red': 1, 'led-green': 1 }, options), ARM, { footprints });
    expect(res.tasks.map((t) => [t.kind, t.partId])).toEqual([['push', 0], ['pick', 0]]);
    expect(res.moved.size).toBe(0);
    expect(res.skipped.map((p) => p.id)).toEqual([1]);
    expect(res.skipped[0]).toMatchObject({ x: 145.9, y: 101.8 });
    expect(res.tasks.at(-1).kind).toBe('pick');
  });

  it('试排拨动了目标但料盒不可达：动作全部撤销，跳过详情和导出恢复到实际板上位置', () => {
    const ps = blockedGreen.map((p) => p.id === 1 ? { ...p, y: 103.5 } : { ...p });
    const bins = binsFor([ps[1]]).map((b) => ({ ...b, center: [10000, 10000, 0] }));
    const res = plan(ps, bins, ARM, { footprints, only: new Set([1]) });
    expect(res.tasks).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ id: 1, x: ps[1].x, y: ps[1].y, rotDeg: ps[1].rotDeg });
    expect(res.skipped[0].skipReason).toContain('料盒里够不到');
    expect(sortInstructions(res, ps, bins, CLASSES, ARM).skipped[0]).toMatchObject({ x: ps[1].x, y: ps[1].y });
  });

  it('清点：按种类计数', () => {
    expect(inventory(parts)).toEqual({ resistor: 2, 'led-red': 3, 'led-blue': 1 });
  });

  it('没有清单时全部分拣', () => {
    const sel = selectForOrder(parts, null);
    expect(sel.custom).toBe(false);
    expect([...sel.ids].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sel.totalShort).toBe(0);
    expect(sel.lines.map((l) => l.key)).toEqual(ORDER_KINDS.map((k) => k.key));
  });

  it('按清单挑：同一种优先旁边不挤的、其次置信度高的；要的比板上多记为缺', () => {
    const sel = selectForOrder(parts, { resistor: 1, 'led-red': 2, 'led-yellow': 3 });
    expect([...sel.ids].sort()).toEqual([0, 3, 4]);
    const line = (k) => sel.lines.find((l) => l.key === k);
    expect(line('led-red')).toMatchObject({ have: 3, want: 2, pick: 2, short: 0 });
    expect(line('led-yellow')).toMatchObject({ have: 0, want: 3, pick: 0, short: 3 });
    expect(line('led-blue')).toMatchObject({ have: 1, want: 0, pick: 0 });
    expect(sel).toMatchObject({ totalWant: 6, totalPick: 3, totalShort: 3, custom: true });
  });

  it('同一种里先挑旁边不挤的', () => {
    // 0、1 贴在一起，2 单独放着；分数最低的 2 反而先被挑中
    const ps = [part(0, 1, 'red', 0.99, 100, 100), part(1, 1, 'red', 0.98, 100, 106), part(2, 1, 'red', 0.5, 200, 100)];
    expect([...selectForOrder(ps, { 'led-red': 1 }, options).ids]).toEqual([2]);
  });

  it('紧密并排的元件可以拨开，只把清单目标入盒', () => {
    const ps = [part(0, 1, 'red', 0.9, 150, 94.2), part(1, 1, 'clear', 0.9, 150, 100), part(2, 1, 'red', 0.9, 150, 105.8)];
    const sel = selectForOrder(ps, { 'led-clear': 1 }, options);
    const res = planForOrder(ps, sel, ARM, { footprints });
    expect(res.skipped).toHaveLength(0);
    expect(res.tasks.filter((t) => t.kind === 'pick').map((t) => t.partId)).toEqual([1]);
    expect(res.tasks.some((t) => t.kind === 'push')).toBe(true);
    expect(res.bins.map((b) => b.key)).toEqual(['led-clear']);
    expect(res.moved.size).toBeGreaterThan(0);
  });

  it('挡路元件夹起暂放板上，动画及指令保留挪位语义且不计入入盒数量', () => {
    const ps = [part(0, 1, 'clear', 0.9, 150, 100), part(1, 1, 'red', 0.9, 162, 92)];
    const original = structuredClone(ps);
    const res = planForOrder(ps, selectForOrder(ps, { 'led-clear': 1 }, options), ARM, { footprints });
    expect(res.skipped).toEqual([]);
    expect(res.tasks.map((t) => [t.kind, t.partId])).toEqual([['relocate', 1], ['pick', 0]]);
    expect([...res.moved]).toEqual([1]);
    expect(res.bins.map((b) => b.key)).toEqual(['led-clear']);
    const t = res.tasks[0];
    expect(t.binId).toBeUndefined();
    expect(t.drop).toBeUndefined();
    expect(t.partTo[2]).toBe(0);
    expect(t.partTo[3]).toBe(ps[1].rotDeg);
    const moved = { ...ps[1], x: t.partTo[0], y: t.partTo[1] };
    const overlap = partPolys(moved, footprints).some((P) => partPolys(ps[0], footprints).some((Q) => polysOverlap(P, Q)));
    expect(overlap).toBe(false);
    expect(assessGrasp(ps[0], [moved], { width: 5, fps: footprints }).blockers).toEqual([]);
    for (const p of [t.from, t.to, t.hoverFrom, t.hoverTo]) expect(ikWorld(p, ARM, { gripYaw: t.gripYaw }).reachable).toBe(true);
    const home = ikWorld(ARM_HOME, ARM).angles;
    const seq = buildSequence(res.tasks, ps, ARM, { startAngles: home, homeAngles: home });
    expect(seq.filter((s) => s.type === 'drop').map((s) => s.partId)).toEqual([0]);
    expect(seq.find((s) => s.type === 'detach' && s.partId === 1)).toMatchObject({ pose: t.partTo, keepLabel: true });
    const ins = sortInstructions(res, ps, res.bins, CLASSES, ARM);
    expect(ins.steps[0]).toMatchObject({ kind: 'relocate', place: { bin: null }, rest: { x: t.partTo[0], y: t.partTo[1], z: 0 } });
    expect(ins.steps[1].place.bin.key).toBe('led-clear');
    expect(instructionsCsv(ins)).toContain('板上挪位');
    expect(ps).toEqual(original);
    expect(planForOrder([...ps].reverse(), selectForOrder(ps, { 'led-clear': 1 }, options), ARM, { footprints }).tasks).toEqual(res.tasks);
  });

  it('有多个候选时按真实夹爪遮挡数量挑选，而非中心邻居数或置信度', () => {
    const ps = [part(0, 1, 'clear', 0.99, 100, 100), part(1, 1, 'red', 0.9, 112, 92),
      part(2, 1, 'clear', 0.5, 200, 100), part(3, 1, 'red', 0.9, 200, 125), part(4, 1, 'red', 0.9, 200, 75)];
    expect(assessGrasp(ps[0], ps.slice(1), { width: 5, fps: footprints }).blockers).toHaveLength(1);
    expect(assessGrasp(ps[2], ps.filter((p) => p.id !== 2), { width: 5, fps: footprints }).blockers).toHaveLength(0);
    expect([...selectForOrder(ps, { 'led-clear': 1 }, options).ids]).toEqual([2]);
  });

  it('先处理只有一个遮挡的远目标，再处理有两个遮挡的近目标；障碍全部挪开', () => {
    const ps = [part(0, 1, 'clear', 0.9, 90, 100), part(1, 1, 'red', 0.9, 102, 92),
      part(2, 1, 'clear', 0.9, 200, 100), part(3, 1, 'red', 0.9, 212, 92), part(4, 1, 'red', 0.9, 212, 110)];
    const res = planForOrder(ps, selectForOrder(ps, { 'led-clear': 2 }, options), ARM, { footprints, start: [200, 100, 0] });
    expect(res.skipped).toEqual([]);
    expect(res.tasks.filter((t) => t.kind === 'pick').map((t) => t.partId)).toEqual([0, 2]);
    expect([...res.moved].sort()).toEqual([1, 3, 4]);
    expect(res.tasks.filter((t) => t.kind === 'relocate')).toHaveLength(3);
  });

  it('连续遮挡依赖可终止，每个障碍最多暂放一次且不重新挡路', () => {
    const ps = [part(0, 1, 'clear', 0.9, 150, 100), part(1, 1, 'red', 0.9, 162, 92), part(2, 1, 'red', 0.9, 174, 84)];
    const res = planForOrder(ps, selectForOrder(ps, { 'led-clear': 1 }, options), ARM, { footprints });
    expect(res.skipped).toEqual([]);
    expect(res.tasks.filter((t) => t.kind === 'pick').map((t) => t.partId)).toEqual([0]);
    const relocated = res.tasks.filter((t) => t.kind === 'relocate').map((t) => t.partId);
    expect(new Set(relocated).size).toBe(relocated.length);
    expect(res.tasks.length).toBeLessThanOrEqual(7);
  });

  it('可达候选优先于底座内不可达但置信度更高的同类元件', () => {
    const ps = [part(0, 1, 'red', 0.99, 148.5, 240), part(1, 1, 'red', 0.5, 150, 100)];
    expect([...selectForOrder(ps, { 'led-red': 1 }, options).ids]).toEqual([1]);
  });

  it('全部分拣和空清单都不额外移动非目标', () => {
    const all = planForOrder(parts, selectForOrder(parts, null, options), ARM, { footprints });
    expect(all.tasks.filter((t) => t.kind === 'pick')).toHaveLength(parts.length);
    expect(all.moved.size).toBe(0);
    expect(planForOrder(parts, selectForOrder(parts, {}, options), ARM, { footprints }).tasks).toEqual([]);
  });

  it('没有可用板上空位时不会把障碍送进料盒', () => {
    const ps = [part(0, 1, 'clear', 0.9, 150, 100), part(1, 1, 'red', 0.9, 162, 92)];
    const res = planForOrder(ps, selectForOrder(ps, { 'led-clear': 1 }, options), ARM, { footprints, board: { width: 1, height: 1 } });
    expect(res.tasks.filter((t) => t.kind === 'pick')).toEqual([]);
    expect(res.tasks.filter((t) => t.kind === 'relocate')).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].skipReason).toContain('安全挪位');
  });

  it('空清单一个都不拣', () => {
    expect(selectForOrder(parts, {}).ids.size).toBe(0);
  });

  it('颜色未知的 LED 出现时多一行', () => {
    const sel = selectForOrder([...parts, part(6, 1, undefined)], null);
    expect(sel.lines.at(-1)).toMatchObject({ key: 'led', have: 1, want: 1 });
  });

  it('数量整理：取整、限制范围、丢掉不认识的种类', () => {
    expect(clampCount('3.7')).toBe(3);
    expect(clampCount(-2)).toBe(0);
    expect(clampCount('abc')).toBe(0);
    expect(clampCount(1e9)).toBe(ORDER_MAX);
    expect(normalizeOrder({ resistor: '2', 'led-red': 0, capacitor: 5, 'led-blue': 1.9 })).toEqual({ resistor: 2, 'led-blue': 1 });
    expect(normalizeOrder(null)).toEqual({});
  });

  it('清单表格：只列有的或要的，末行合计', () => {
    const t = orderTable(selectForOrder(parts, { resistor: 1, 'led-yellow': 3 }));
    expect(t.rows.map((r) => r[0])).toEqual(['色环电阻', '红色 LED', '蓝色 LED', '黄色 LED', '合计']);
    expect(t.rows.at(-1)).toEqual(['合计', 6, 4, 1, 3]);
  });

  it('规划只拣清单里的零件，其余留在板上、不算跳过', () => {
    const sel = selectForOrder(parts, { 'led-red': 2 });
    const bins = binsFor(parts.filter((p) => sel.ids.has(p.id)));
    expect(bins.map((b) => b.key)).toEqual(['led-red']);
    const { tasks, skipped } = plan(parts, bins, ARM, { only: sel.ids });
    expect(skipped).toHaveLength(0);
    expect(tasks.filter((t) => t.kind === 'pick').map((t) => t.partId).sort()).toEqual([3, 4]);
    // 不给 only 时和以前一样全部分拣
    const all = plan(parts, binsFor(parts), ARM);
    expect(all.tasks.filter((t) => t.kind === 'pick')).toHaveLength(parts.length);
  });
});
