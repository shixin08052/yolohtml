import { describe, it, expect } from 'vitest';
import { plan } from '../src/robot/planner.js';
import { fkWorld } from '../src/robot/ik.js';
import { sortInstructions, instructionsCsv, instructionsJson } from '../src/robot/export.js';
import { partFootprint } from '../src/scene/parts.js';
import { flowSvgStandalone, flowNodes, PHASES, SIDE_NODES } from '../src/ui/flowchart.js';
import { ARM, BINS, CLASSES } from '../src/config.js';

const P = (id, cls, x, y, rotDeg = 0) => ({ id, cls, name: CLASSES[cls].name, score: 0.9, x, y, xPlane: x, yPlane: y, xParallax: x, yParallax: y, rotDeg, heightMm: CLASSES[cls].heightMm, reachable: true });
const parts = [P(0, 0, 120, 100, 30), P(1, 1, 180, 80, -60), P(2, 0, 150, 140, 90), P(3, 1, 900, 900)];
const footprints = Object.fromEntries(CLASSES.map((c) => [c.id, partFootprint(c.id)]));
const result = plan(parts, BINS, ARM, { footprints });
const ins = sortInstructions(result, parts, BINS, CLASSES, ARM);
const rad = (d) => (d * Math.PI) / 180;

describe('分拣指令导出', () => {
  it('按执行顺序列出，够不到的单独列出原因', () => {
    expect(ins.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(ins.steps.map((s) => s.partId)).toEqual(result.tasks.map((t) => t.partId));
    expect(ins.skipped).toHaveLength(1);
    expect(ins.skipped[0]).toMatchObject({ partId: 3, name: 'LED' });
    expect(ins.skipped[0].reason).toBeTruthy();
  });

  it('关节角代回正运动学，指尖正好在抓取点 / 松开点（误差 < 0.05 mm，角度保留两位小数）', () => {
    for (const s of ins.steps) {
      for (const [ang, point] of [[s.pick.angles, s.pick.point], [s.place.angles, s.place.point]]) {
        const tip = fkWorld(ang.map(rad), ARM);
        expect(Math.hypot(tip[0] - point[0], tip[1] - point[1], tip[2] - point[2])).toBeLessThan(0.05);
      }
      expect(s.place.bin.name).toBe(`${s.name}盒`);
      expect(s.pick.gripWidthMm).toBeGreaterThan(0);
    }
  });

  it('CSV：表头完整、每个零件一行（含跳过的）；JSON 能解析', () => {
    const lines = instructionsCsv(ins).slice(1).trimEnd().split('\r\n');
    const header = lines[0].split(',');
    expect(header).toContain('抓取 θ₀ (°)');
    expect(header).toContain('放置 θ₄ (°)');
    expect(lines).toHaveLength(1 + 3 + 1);
    for (const l of lines.slice(1)) expect(l.split(',')).toHaveLength(header.length);
    expect(lines[4].startsWith('跳过,4,LED')).toBe(true); // 编号从 1 开始，与零件图片一致
    const j = JSON.parse(instructionsJson(ins, { photo: 'a.jpg', arm: ARM }));
    expect(j.steps).toHaveLength(3);
    expect(j.skipped).toHaveLength(1);
  });
});

describe('流程图导出', () => {
  it('三个阶段按顺序覆盖全部主流程节点，各段连续', () => {
    for (const demo of [false, true]) {
      const ids = flowNodes({ demo }).map((n) => n.id);
      const covered = PHASES.flatMap((ph) => ph.nodes.filter((id) => ids.includes(id)));
      expect(covered).toEqual(ids);
    }
  });

  it('独立 SVG：自带样式和白底，含标题、三个阶段和全部节点', () => {
    const { svg, width, height } = flowSvgStandalone({ demo: true });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<style>');
    expect(svg).toContain('识别 — 定位 — 执行');
    for (const ph of PHASES) expect(svg).toContain(`data-phase="${ph.id}"`);
    for (const n of [...flowNodes({ demo: true }), ...SIDE_NODES]) expect(svg).toContain(`data-node="${n.id}"`);
    expect(svg.match(/<svg/g)).toHaveLength(1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(400);
    expect(flowSvgStandalone().svg).not.toContain('data-node="confirm"');
  });
});
