// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createInfoPanel } from '../src/ui/infoPanel.js';
import { createOrderPanel } from '../src/ui/orderPanel.js';
import { clearOrderCache } from '../src/llm/orderCache.js';

beforeEach(() => {
  localStorage.clear(); clearOrderCache();
  localStorage.setItem('yolohtml.deepseek', JSON.stringify({ apiKey: 'sk-test', useCache: true }));
  document.body.innerHTML = '<div id="panel"></div>';
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => { clearOrderCache(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const field = (key) => document.querySelector(`tr[data-key="${key}"] input`);
const edit = (element, value, event = 'input') => { element.value = value; element.dispatchEvent(new Event(event, { bubbles: true })); };
const click = (act) => document.querySelector(`[data-act="${act}"]`).click();
const idle = () => vi.waitFor(() => expect(document.querySelector('[data-act="ai"]').disabled).toBe(false));

it('真实 UI → 请求 → 短键解析 → 清零回填 → 本地缓存 → 强度变化及重新生成', async () => {
  let reply = { R: 2 };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }],
    usage: { prompt_tokens: 200, completion_tokens: 32, total_tokens: 232, completion_tokens_details: { reasoning_tokens: 20 } },
  }))));
  const parts = [{ id: 0, cls: 0, x: 80, y: 100, rotDeg: 0 }, { id: 1, cls: 1, color: 'red', x: 150, y: 100, rotDeg: 0 }, { id: 2, cls: 1, color: 'blue', x: 220, y: 100, rotDeg: 0 }];
  const onChange = vi.fn();
  const ui = createOrderPanel({ panel: createInfoPanel(document.querySelector('#panel')), getParts: () => parts, onChange, fileStem: () => 'test', message: vi.fn() });
  ui.render();
  edit(field('resistor'), '7'); edit(field('led-blue'), '5');
  edit(document.querySelector('.ai-text'), '只要两个红灯');
  edit(document.querySelector('[data-llm="reasoningEffort"]'), '2', 'change');
  onChange.mockClear();
  click('ai'); await idle();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 4096 });
  expect(ui.order).toEqual({ 'led-red': 2 });
  expect(field('resistor').value).toBe('0'); expect(field('led-blue').value).toBe('0');
  expect(field('led-red').value).toBe('2'); expect(onChange).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.ai-usage').textContent).toContain('思考 20');
  edit(field('resistor'), '9');
  click('ai'); await idle();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(field('resistor').value).toBe('0');
  expect(document.querySelector('.ai-usage').textContent).toContain('未调用接口（0 token）');
  edit(document.querySelector('[data-llm="reasoningEffort"]'), '0', 'change');
  reply = { B: 3 };
  click('ai'); await idle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(ui.order).toEqual({ 'led-blue': 3 });
  expect(field('led-red').value).toBe('0');
  reply = { r: 1 };
  click('ai-refresh'); await idle();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(ui.order).toEqual({ resistor: 1 });
  expect(field('led-blue').value).toBe('0');
  click('cache-clear'); click('ai'); await idle();
  expect(fetch).toHaveBeenCalledTimes(4);
});
