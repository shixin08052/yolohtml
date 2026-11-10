// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createResultCard } from '../src/ui/sortExtras.js';

afterEach(() => document.body.replaceChildren());

it('完成卡片逐项显示跳过元件、位置与原因；下一次无跳过时清掉旧详情', () => {
  const card = createResultCard(document.body, { onInstructions: vi.fn(), onExport: vi.fn(), onAgain: vi.fn() });
  const result = { bins: [], picked: 4, pushes: 1, seconds: 22.5, speed: 1, short: [], left: 0, skipped: [
    { name: '绿色 LED (145.9, 101.8)', reason: '与旁边的零件挤得太紧：没有可达的安全挪位或拨开路径，请手动分开' },
    { name: '红色 LED (30.0, 50.0)', reason: '超出机械臂范围 <请调整位置>' },
  ] };
  card.show(result);
  const items = [...document.querySelectorAll('.result-skipped li')];
  expect(items).toHaveLength(2);
  expect(items[0].querySelector('b').textContent).toBe(result.skipped[0].name);
  expect(items[0].querySelector('span').textContent).toBe(result.skipped[0].reason);
  expect(items[1].querySelector('span').textContent).toBe(result.skipped[1].reason);
  expect(items[1].querySelector('请调整位置')).toBeNull();
  expect(document.querySelector('.result-facts').textContent).toContain('跳过 2 个');
  expect(document.querySelector('.result-big').textContent).toContain('4 个元件已入盒');
  card.show({ ...result, skipped: [] });
  expect(document.querySelector('.result-skipped')).toBeNull();
  expect(document.querySelector('.result-facts').textContent).not.toContain('跳过');
});
