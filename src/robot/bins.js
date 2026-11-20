// 料盒按需生成（纯函数）：电阻一个盒；LED 按颜色分，照片里出现了哪些颜色就有哪些盒。
// 零件 → 盒子的对应用 binKey：电阻 'resistor'；LED 'led-<颜色>'，颜色未知时 'led'（不分颜色的 LED 盒）。
import { CLASSES, LED_COLORS, BIN_SLOTS, BIN_SIZE } from '../config.js';

const LED_ORDER = ['red', 'green', 'blue', 'yellow', 'clear'];
/** LED 盒依次占用的格位（电阻固定在左中） */
const LED_SLOTS = ['rightMid', 'rightFar', 'rightNear', 'leftFar', 'leftNear', 'front', 'leftMid'];

/** 零件该进哪个盒 */
export function binKey(p) {
  if (p.cls === 0) return 'resistor';
  return p.color && LED_COLORS[p.color] ? `led-${p.color}` : 'led';
}

/** 零件的显示名：LED 带颜色（"红色 LED"） */
export function partName(p) {
  if (p.cls === 1 && p.color && LED_COLORS[p.color]) return `${LED_COLORS[p.color].name} LED`;
  return CLASSES[p.cls]?.name ?? String(p.cls);
}

/** 零件的显示颜色：LED 用灯体颜色 */
export function partColor(p) {
  if (p.cls === 1 && p.color && LED_COLORS[p.color]) return LED_COLORS[p.color].hex;
  return CLASSES[p.cls]?.color ?? '#888';
}

/** 盒子的名称与颜色 */
function binInfo(key) {
  if (key === 'resistor') return { cls: 0, label: CLASSES[0].name, hex: CLASSES[0].color };
  if (key === 'led') return { cls: 1, label: 'LED', hex: CLASSES[1].color };
  const c = key.slice(4);
  return { cls: 1, color: c, label: `${LED_COLORS[c].name} LED`, hex: LED_COLORS[c].hex };
}

/** 盒子的排列顺序：电阻、各色 LED（按 LED_ORDER）、颜色未知的 LED */
const order = (key) => (key === 'resistor' ? -1 : key === 'led' ? 99 : LED_ORDER.indexOf(key.slice(4)));

/**
 * 这组零件需要的料盒（每种出现过的 binKey 一个），格位按上面的规则分配。
 * 若传入 existingBins（前几轮已落入零件的料盒），这些料盒保持原有格位不变，新出现的类别从剩余空闲格位分配。
 * @param {{ cls: number, color?: string }[]} parts
 * @param {{ key: string, center: number[], size?: number[] }[]} [existingBins]
 * @returns {{ id: number, key: string, cls: number, color?: string, label: string, hex: string, center: number[], size: number[] }[]}
 */
export function binsFor(parts, existingBins = []) {
  const locked = new Map();
  for (const b of existingBins) {
    if (b?.key && b?.center && !locked.has(b.key)) locked.set(b.key, b);
  }
  const partKeys = [...new Set(parts.map(binKey))];
  const allKeys = [...new Set([...locked.keys(), ...partKeys])].sort((a, b) => order(a) - order(b));
  const usedCenters = new Set([...locked.values()].map((b) => `${b.center[0]},${b.center[1]}`));
  const free = LED_SLOTS.filter((s) => !usedCenters.has(`${BIN_SLOTS[s][0]},${BIN_SLOTS[s][1]}`));
  return allKeys.map((key, id) => {
    const prev = locked.get(key);
    if (prev) {
      return { id, key, ...binInfo(key), center: prev.center, size: prev.size ?? BIN_SIZE };
    }
    let slot;
    if (key === 'resistor' && free.includes('leftMid')) {
      slot = 'leftMid';
      free.splice(free.indexOf('leftMid'), 1);
    } else {
      // 电阻在后面才排到时，左中可能已被占：取第一个空的格位
      slot = free.find((s) => s !== 'leftMid' || !allKeys.includes('resistor')) ?? free[0];
      free.splice(free.indexOf(slot), 1);
    }
    return { id, key, ...binInfo(key), center: BIN_SLOTS[slot], size: BIN_SIZE };
  });
}
