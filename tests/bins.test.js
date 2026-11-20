import { describe, it, expect } from 'vitest';
import { binsFor, binKey, partName, partColor } from '../src/robot/bins.js';
import { plan } from '../src/robot/planner.js';
import { partFootprint } from '../src/scene/parts.js';
import { ARM, BINS, BIN_SLOTS, CLASSES, LED_COLORS } from '../src/config.js';

const P = (id, cls, x, y, color, rotDeg = 0) => ({ id, cls, color, name: '', score: 0.9, x, y, xPlane: x, yPlane: y, xParallax: x, yParallax: y, rotDeg, heightMm: CLASSES[cls].heightMm, reachable: true });

describe('料盒按需生成', () => {
  it('只有电阻和红色 LED：两个盒，位置与原来一样（电阻左、LED 右）', () => {
    const b = binsFor([P(0, 0, 100, 100), P(1, 1, 150, 100, 'red')]);
    expect(b.map((x) => x.key)).toEqual(['resistor', 'led-red']);
    expect(b[0].center).toEqual(BINS[0].center);
    expect(b[1].center).toEqual(BINS[1].center);
    expect(b[1].label).toBe('红色 LED');
  });

  it('有什么颜色才有什么盒；按 电阻、红、绿、蓝、黄、透明 排，格位互不重复', () => {
    const parts = [P(0, 1, 100, 100, 'clear'), P(1, 1, 120, 100, 'green'), P(2, 1, 140, 100, 'green'), P(3, 0, 160, 100), P(4, 1, 180, 100, 'blue')];
    const b = binsFor(parts);
    expect(b.map((x) => x.key)).toEqual(['resistor', 'led-green', 'led-blue', 'led-clear']);
    expect(new Set(b.map((x) => x.center.join())).size).toBe(b.length);
    expect(b.map((x) => x.id)).toEqual([0, 1, 2, 3]);
    expect(binsFor([P(0, 1, 100, 100, 'blue')]).map((x) => x.key)).toEqual(['led-blue']);
    expect(binsFor([])).toEqual([]);
  });

  it('最多 7 种（电阻 + 5 种颜色 + 颜色未知的 LED）也都有格位，互不重复', () => {
    const parts = [P(0, 0, 1, 1), ...['red', 'green', 'blue', 'yellow', 'clear', undefined].map((c, i) => P(i + 1, 1, 1, 1, c))];
    const b = binsFor(parts);
    expect(b).toHaveLength(7);
    expect(b.every((x) => Array.isArray(x.center))).toBe(true);
    expect(new Set(b.map((x) => x.center.join())).size).toBe(7);
  });

  it('显示名与颜色：LED 带颜色名', () => {
    expect(partName(P(0, 1, 0, 0, 'clear'))).toBe('透明 LED');
    expect(partName(P(0, 1, 0, 0))).toBe('LED');
    expect(partName(P(0, 0, 0, 0))).toBe(CLASSES[0].name);
    expect(partColor(P(0, 1, 0, 0, 'green'))).toBe(LED_COLORS.green.hex);
    expect(binKey(P(0, 1, 0, 0, 'blue'))).toBe('led-blue');
    expect(binKey(P(0, 1, 0, 0))).toBe('led');
  });

  it('多轮增量分拣：上一轮已放进元件的料盒保持原格位，后续同盒元件按 initialFill 避让已有元件', () => {
    const green = P(0, 1, 120, 100, 'green');
    const red = P(1, 1, 160, 100, 'red');
    const green2 = P(2, 1, 190, 100, 'green');
    const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));

    // 第一轮只选 green：分配在第一个 LED 格位 rightMid
    const bins1 = binsFor([green]);
    expect(bins1.map((b) => [b.key, b.center])).toEqual([['led-green', BIN_SLOTS.rightMid]]);
    const r1 = plan([green], bins1, ARM, { footprints });
    expect(r1.tasks).toHaveLength(1);
    const drop1 = r1.tasks[0].drop.to;

    // 第二轮再选 red + green2：green 盒必须留在 rightMid 不换位，red 分配到下一个空闲格位 rightFar
    const bins2 = binsFor([red, green2], bins1);
    expect(bins2.find((b) => b.key === 'led-green').center).toEqual(BIN_SLOTS.rightMid);
    expect(bins2.find((b) => b.key === 'led-red').center).toEqual(BIN_SLOTS.rightFar);

    const initialFill = new Map([
      ['led-green', [{ fp: footprints[1], x: drop1[0], y: drop1[1], z: drop1[2], yaw: drop1[3], height: footprints[1].height }]],
    ]);
    const r2 = plan([red, green2], bins2, ARM, { footprints, initialFill });
    const green2Task = r2.tasks.find((t) => t.partId === 2);
    expect(green2Task).toBeDefined();
    // 第二颗绿 LED 落点不能与第一颗重合
    const dist = Math.hypot(green2Task.drop.to[0] - drop1[0], green2Task.drop.to[1] - drop1[1]);
    expect(dist).toBeGreaterThan(2);
  });
});

describe('按颜色分拣', () => {
  const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));
  // 电阻 + 四种颜色的 LED 散在工作区里
  const colors = ['red', 'green', 'blue', 'clear'];
  const parts = [];
  let id = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const cls = (i + j) % 3 === 0 ? 0 : 1;
    parts.push(P(id++, cls, 50 + i * 60, 45 + j * 55, cls === 1 ? colors[(i + j) % 4] : undefined, (i * 37 + j * 71) % 180));
  }

  it('每个零件进对应颜色的盒，五个盒都够得着（没有零件被跳过）', () => {
    const bins = binsFor(parts);
    expect(bins.length).toBeGreaterThanOrEqual(4);
    const { tasks, skipped } = plan(parts, bins, ARM, { footprints });
    expect(skipped).toEqual([]);
    for (const t of tasks) {
      const p = parts[t.partId];
      expect(bins.find((b) => b.id === t.binId).key).toBe(binKey(p));
    }
  });

  it('每个格位都够得着：在每个格位放一个盒子，往里放零件不会被跳过', () => {
    for (const slot of Object.keys(BIN_SLOTS)) {
      const bins = [{ id: 0, key: 'led', cls: 1, label: 'LED', hex: '#f00', center: BIN_SLOTS[slot], size: BINS[0].size }];
      const { skipped } = plan([P(0, 1, 150, 105), P(1, 1, 60, 40), P(2, 1, 240, 170)], bins, ARM, { footprints });
      expect(skipped, slot).toEqual([]);
    }
  });
});
