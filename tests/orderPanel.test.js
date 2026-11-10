// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInfoPanel } from '../src/ui/infoPanel.js';
import { createOrderPanel } from '../src/ui/orderPanel.js';
import { askOrder } from '../src/llm/orderAssist.js';
import { clearOrderCache } from '../src/llm/orderCache.js';

vi.mock('../src/llm/orderAssist.js', async (original) => ({ ...await original(), askOrder: vi.fn() }));
vi.mock('../src/llm/orderCache.js', async (original) => ({ ...await original(), clearOrderCache: vi.fn() }));

beforeEach(() => { localStorage.clear(); document.body.innerHTML = '<div id="panel"></div>'; vi.clearAllMocks(); });
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const ps = [
  { id: 0, cls: 0, x: 80, y: 100, score: 0.9, rotDeg: 0 },
  { id: 1, cls: 1, color: 'red', x: 150, y: 100, score: 0.9, rotDeg: 0 },
  { id: 2, cls: 1, color: 'blue', x: 220, y: 100, score: 0.9, rotDeg: 0 },
];
const field = (key) => document.querySelector(`tr[data-key="${key}"] input`);
const act = (name) => document.querySelector(`[data-act="${name}"]`).click();
const input = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
const change = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
const values = () => Object.fromEntries([...document.querySelectorAll('tbody tr')].map((tr) => [tr.dataset.key, Number(tr.querySelector('input').value)]));
const mount = () => {
  const onChange = vi.fn();
  const control = createOrderPanel({ panel: createInfoPanel(document.querySelector('#panel')), getParts: () => ps, onChange, fileStem: () => 'test', message: vi.fn() });
  control.render();
  input(document.querySelector('.ai-text'), '只要两个红灯');
  return { control, onChange };
};
const result = (order, extra = {}) => ({ order, note: '', usage: null, cacheHit: false, ...extra });

describe('AI 清单回填和缓存控件', () => {
  it('靠近另一档时预览放大和白点，移开恢复；悬停不改变设置或发请求', () => {
    mount();
    const slider = document.querySelector('[data-llm="reasoningEffort"]');
    const dots = [...document.querySelectorAll('.ai-effort-dots > span')];
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 332 });
    change(slider, '2');
    const before = localStorage.getItem('yolohtml.deepseek');
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 132 }));
    expect(dots[1].classList.contains('is-near')).toBe(true);
    expect(dots[1].classList.contains('is-target')).toBe(false);
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 119 }));
    expect(dots[1].classList.contains('is-target')).toBe(true);
    expect(slider.value).toBe('2');
    expect(localStorage.getItem('yolohtml.deepseek')).toBe(before);
    expect(askOrder).not.toHaveBeenCalled();
    slider.dispatchEvent(new PointerEvent('pointerleave'));
    expect(dots.every((dot) => !dot.classList.contains('is-near') && !dot.classList.contains('is-target'))).toBe(true);
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: 116 }));
    expect(dots[1].classList.contains('is-near')).toBe(false);
  });

  it('点按保留滑动过渡、目标点变白；真正拖动才跟手，松开后恢复', () => {
    vi.useFakeTimers();
    mount();
    const slider = document.querySelector('[data-llm="reasoningEffort"]');
    const picker = document.querySelector('.ai-effort');
    const dots = [...document.querySelectorAll('.ai-effort-dots > span')];
    slider.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 116 }));
    input(slider, '1');
    expect(picker.classList.contains('is-pressed')).toBe(true);
    expect(picker.classList.contains('is-dragging')).toBe(false);
    expect(dots[1].classList.contains('is-target')).toBe(true);
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(picker.classList.contains('is-pressed')).toBe(false);
    expect(JSON.parse(localStorage.getItem('yolohtml.deepseek')).reasoningEffort).toBe('low');
    vi.advanceTimersByTime(300);
    expect(dots[1].classList.contains('is-target')).toBe(false);
    slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, button: 0, clientX: 116 }));
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 170 }));
    input(slider, '1.65');
    expect(picker.classList.contains('is-dragging')).toBe(true);
    expect(slider.value).toBe('1.65');
    expect(dots[2].classList.contains('is-target')).toBe(true);
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    expect(picker.classList.contains('is-dragging')).toBe(false);
    expect(slider.value).toBe('2');
  });

  it('仅展开且在视野内的前台面板启用动画；重建和移除时清理观察器', () => {
    const observers = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
      observe() {}
    });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let parts = ps;
    const control = createOrderPanel({ panel: createInfoPanel(document.querySelector('#panel')), getParts: () => parts, onChange: vi.fn(), fileStem: () => 'test', message: vi.fn() });
    control.render();
    let box = document.querySelector('.ai-box');
    observers[0].callback([{ isIntersecting: true }]);
    expect(box.classList.contains('ai-motion')).toBe(false);
    box.open = true; box.dispatchEvent(new Event('toggle'));
    expect(box.classList.contains('ai-motion')).toBe(true);
    hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    expect(box.classList.contains('ai-motion')).toBe(false);
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    expect(box.classList.contains('ai-motion')).toBe(true);
    observers[0].callback([{ isIntersecting: false }]);
    expect(box.classList.contains('ai-motion')).toBe(false);
    control.render();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    box = document.querySelector('.ai-box');
    observers[1].callback([{ isIntersecting: true }]);
    expect(box.classList.contains('ai-motion')).toBe(true);
    box.open = false; box.dispatchEvent(new Event('toggle'));
    expect(box.classList.contains('ai-motion')).toBe(false);
    parts = null; control.render();
    expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ai-box')).toBeNull();
  });

  it('滑动连续跟手、松手吸附四档，Ultra 使用 max；重建保留选择', async () => {
    const { control } = mount();
    const slider = document.querySelector('[data-llm="reasoningEffort"]');
    expect(slider.type).toBe('range');
    input(slider, '3');
    expect(document.querySelector('.ai-box').dataset.effort).toBe('max');
    expect(slider.getAttribute('aria-valuetext')).toContain('最高');
    expect(localStorage.getItem('yolohtml.deepseek')).toBeNull();
    change(slider, '3');
    expect(JSON.parse(localStorage.getItem('yolohtml.deepseek')).reasoningEffort).toBe('max');
    askOrder.mockResolvedValueOnce(result({ resistor: 1 })); act('ai');
    await vi.waitFor(() => expect(control.order).toEqual({ resistor: 1 }));
    expect(askOrder).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'max' }));
    expect(document.querySelector('[data-llm="reasoningEffort"]').value).toBe('3');
    const currentSlider = document.querySelector('[data-llm="reasoningEffort"]');
    input(currentSlider, '1.24');
    expect(currentSlider.value).toBe('1.24');
    expect(document.querySelector('.ai-effort-value').textContent).toBe('低');
    change(currentSlider, '1.24');
    expect(document.querySelector('[data-llm="reasoningEffort"]').value).toBe('1');
    control.render();
    expect(document.querySelector('[data-llm="reasoningEffort"]').value).toBe('1');
    expect(JSON.parse(localStorage.getItem('yolohtml.deepseek')).reasoningEffort).toBe('low');
  });

  it('打开 AI 助手即显示内嵌滑杆，支持键盘逐档且滚动不收起', () => {
    const { control } = mount();
    const box = document.querySelector('.ai-box');
    box.open = true; box.dispatchEvent(new Event('toggle'));
    const card = document.querySelector('.ai-effort-card');
    const slider = document.querySelector('[data-llm="reasoningEffort"]');
    expect(box.contains(card)).toBe(true);
    expect(card.hidden).toBe(false);
    expect(document.querySelector('[popover]')).toBeNull();
    expect(document.querySelector('.ai-effort-trigger')).toBeNull();
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(slider.value).toBe('3');
    expect(document.querySelector('.ai-effort-value').textContent).toBe('Ultra');
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(slider.value).toBe('2');
    expect(JSON.parse(localStorage.getItem('yolohtml.deepseek')).reasoningEffort).toBe('high');
    document.dispatchEvent(new Event('scroll'));
    expect(card.hidden).toBe(false);
    expect(document.activeElement).toBe(slider);
    control.render();
    expect(document.querySelector('.ai-box').open).toBe(true);
    expect(document.querySelector('.ai-effort-card').hidden).toBe(false);
    expect(document.querySelector('[data-llm="reasoningEffort"]').value).toBe('2');
  });

  it('卡片模型行显示实际模型并能跳转编辑', () => {
    mount();
    document.querySelector('.ai-effort-model').click();
    const model = document.querySelector('[data-llm="model"]');
    expect(document.querySelector('.ai-effort-card').hidden).toBe(false);
    expect(document.querySelector('.ai-settings').open).toBe(true);
    expect(document.activeElement).toBe(model);
    change(model, 'deepseek-v4-pro');
    expect(document.querySelector('.ai-effort-model-name').textContent).toBe('DeepSeek V4 Pro · DeepSeek');
  });

  it('先清空所有旧数量，再填模型结果；未返回种类全部归零，规划只触发一次', async () => {
    const { control, onChange } = mount();
    input(field('resistor'), '5'); input(field('led-blue'), '7'); input(field('led-red'), '4');
    onChange.mockClear();
    askOrder.mockResolvedValueOnce(result({ 'led-red': 2 }));
    act('ai');
    await vi.waitFor(() => expect(control.order).toEqual({ 'led-red': 2 }));
    expect(values()).toEqual({ resistor: 0, 'led-red': 2, 'led-green': 0, 'led-blue': 0, 'led-yellow': 0, 'led-clear': 0 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(control.selection().totalWant).toBe(2);
    expect(document.querySelector('.order-summary').textContent).toContain('需要 2 个');
  });

  it('连续第二次生成及本地缓存回填同样替换，旧种类不残留', async () => {
    const { control } = mount();
    askOrder.mockResolvedValueOnce(result({ resistor: 3, 'led-red': 3 })); act('ai');
    await vi.waitFor(() => expect(field('resistor').value).toBe('3'));
    askOrder.mockResolvedValueOnce(result({ 'led-blue': 1 }, { cacheHit: true })); act('ai');
    await vi.waitFor(() => expect(control.order).toEqual({ 'led-blue': 1 }));
    expect(field('resistor').value).toBe('0');
    expect(field('led-red').value).toBe('0');
    expect(field('led-blue').value).toBe('1');
    expect(document.querySelector('.ai-usage').textContent).toContain('未调用接口（0 token）');
  });

  it('空清单回复会清空全部，失败与取消不会清掉原选择', async () => {
    const { control } = mount();
    input(field('resistor'), '5');
    const before = { ...control.order };
    askOrder.mockRejectedValueOnce(new Error('API Key 无效')); act('ai');
    await vi.waitFor(() => expect(document.querySelector('.ai-status').textContent).toContain('Key 无效'));
    expect(control.order).toEqual(before);
    expect(field('resistor').value).toBe('5');
    askOrder.mockResolvedValueOnce(result({})); act('ai');
    await vi.waitFor(() => expect(control.order).toEqual({}));
    expect(Object.values(values()).every((n) => n === 0)).toBe(true);
  });

  it('请求期间重建面板后，回填更新最新面板并恢复按钮', async () => {
    const { control } = mount();
    let finish;
    askOrder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act('ai'); control.render();
    expect(document.querySelector('[data-act="ai"]').disabled).toBe(true);
    expect(document.querySelector('[data-act="ai-cancel"]').hidden).toBe(false);
    input(field('resistor'), '9');
    finish(result({ 'led-red': 2 }));
    await vi.waitFor(() => expect(field('led-red').value).toBe('2'));
    expect(field('resistor').value).toBe('0');
    expect(document.querySelector('[data-act="ai"]').disabled).toBe(false);
  });

  it('强度及缓存偏好持久化，重新生成绕过缓存，清空缓存不会改当前清单', async () => {
    const { control } = mount();
    change(document.querySelector('[data-llm="reasoningEffort"]'), '2');
    const checkbox = document.querySelector('[data-llm="useCache"]');
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem('yolohtml.deepseek'))).toMatchObject({ reasoningEffort: 'high', useCache: false });
    askOrder.mockResolvedValueOnce(result({ resistor: 1 })); act('ai-refresh');
    await vi.waitFor(() => expect(control.order).toEqual({ resistor: 1 }));
    expect(askOrder).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'high', useCache: false, refresh: true }));
    expect(document.querySelector('[data-llm="reasoningEffort"]').value).toBe('2');
    act('cache-clear');
    expect(clearOrderCache).toHaveBeenCalledTimes(1);
    expect(control.order).toEqual({ resistor: 1 });
    expect(document.querySelector('.ai-status').textContent).toContain('已清空');
  });

  it('用户取消时不应用晚到的结果', async () => {
    const { control } = mount();
    input(field('resistor'), '5');
    const before = { ...control.order };
    let finish;
    askOrder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act('ai'); act('ai-cancel'); finish(result({ 'led-red': 2 }));
    await vi.waitFor(() => expect(document.querySelector('[data-act="ai"]').disabled).toBe(false));
    expect(control.order).toEqual(before);
    expect(field('resistor').value).toBe('5');
  });
});
