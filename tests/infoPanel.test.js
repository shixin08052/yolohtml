// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInfoPanel } from '../src/ui/infoPanel.js';

beforeEach(() => { document.body.innerHTML = '<div id="panel"></div>'; });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

const paneOf = (key) => document.querySelector(`[data-key="${key}"]`).closest('.panel-pane').dataset.pane;

describe('信息面板标签页和提示', () => {
  it('分区按键名分到进度 / 清单 / 调试三页，同页按固定顺序排', () => {
    const panel = createInfoPanel(document.querySelector('#panel'));
    panel.setCustom('export', '导出');
    panel.setCustom('timing', '耗时');
    panel.setCustom('status', '状态');
    panel.setCustom('order', '元件清单');
    panel.setCustom('sort', '分拣');
    expect(paneOf('status')).toBe('progress');
    expect(paneOf('order')).toBe('order');
    expect(paneOf('timing')).toBe('debug');
    const progress = [...document.querySelectorAll('[data-pane="progress"].panel-pane > .panel-section')].map((s) => s.dataset.key);
    expect(progress).toEqual(['status', 'sort', 'export']);
    // 消息记录始终在调试页最后
    panel.setCustom('experiment', '实验', { last: true });
    const debug = [...document.querySelectorAll('[data-pane="debug"].panel-pane > .panel-section')].map((s) => s.dataset.key);
    expect(debug.at(-1)).toBe('messages');
    expect(debug.at(-2)).toBe('experiment');
  });

  it('切换标签只显示对应页；清单出现时在未选中的标签上标记', () => {
    const panel = createInfoPanel(document.querySelector('#panel'));
    expect(panel.tab).toBe('progress');
    panel.setCustom('order', '元件清单');
    const orderTab = document.querySelector('.panel-tab[data-pane="order"]');
    expect(orderTab.classList.contains('has-new')).toBe(true);
    orderTab.click();
    expect(panel.tab).toBe('order');
    expect(orderTab.classList.contains('has-new')).toBe(false);
    expect(document.querySelector('.panel-pane[data-pane="order"]').hidden).toBe(false);
    expect(document.querySelector('.panel-pane[data-pane="progress"]').hidden).toBe(true);
  });

  it('成功 / 警告 / 出错弹提示并自动消失，普通消息只进记录', () => {
    vi.useFakeTimers();
    const panel = createInfoPanel(document.querySelector('#panel'));
    panel.message('页面已就绪', 'info');
    panel.message('已导出', 'ok');
    expect(document.querySelector('.msgs').textContent).toContain('页面已就绪');
    const toasts = () => [...document.querySelectorAll('.toast')];
    expect(toasts().map((t) => t.textContent)).toEqual(['已导出×']);
    vi.advanceTimersByTime(3000);
    expect(toasts()).toHaveLength(0);
    for (const n of [1, 2, 3, 4]) panel.message(`出错 ${n}`, 'error');
    expect(toasts()).toHaveLength(3);
  });

  it('支持调试卡片一键全部展开 / 收起，以及 focusSection 跳转', () => {
    const panel = createInfoPanel(document.querySelector('#panel'));
    panel.setCustom('markers', '标定');
    panel.setCustom('pose', '位姿');
    const collapseBtn = document.querySelector('[data-debug-act="collapse"]');
    const expandBtn = document.querySelector('[data-debug-act="expand"]');
    collapseBtn.click();
    expect([...document.querySelectorAll('[data-pane="debug"] > details.panel-section')].every((d) => !d.open)).toBe(true);
    expandBtn.click();
    expect([...document.querySelectorAll('[data-pane="debug"] > details.panel-section')].every((d) => d.open)).toBe(true);
    collapseBtn.click();
    panel.focusSection('pose');
    expect(panel.tab).toBe('debug');
    expect(document.querySelector('[data-key="pose"]').open).toBe(true);
    expect(document.querySelector('[data-key="pose"]').classList.contains('section-flash')).toBe(true);
  });

  it('支持隐藏/过渡显示指定标签页，隐藏激活页时回退到进度页并触发切换回调', () => {
    const onTabSelect = vi.fn();
    const panel = createInfoPanel(document.querySelector('#panel'), {
      hiddenTabs: ['order'],
      onTabSelect,
    });
    const orderTab = document.querySelector('.panel-tab[data-pane="order"]');
    expect(orderTab.classList.contains('is-hidden')).toBe(true);
    expect(orderTab.disabled).toBe(true);
    expect(orderTab.getAttribute('aria-hidden')).toBe('true');

    // 隐藏期间写入清单分区不会提前标红点，且无法切到隐藏标签
    panel.setCustom('order', '元件清单');
    expect(orderTab.classList.contains('has-new')).toBe(false);
    panel.selectTab('order');
    expect(panel.tab).toBe('progress');
    expect(onTabSelect).not.toHaveBeenCalled();

    // 键盘切换跳过隐藏的清单页
    document.querySelector('.panel-tabs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(panel.tab).toBe('debug');
    expect(onTabSelect).toHaveBeenLastCalledWith('debug', { prev: 'progress', changed: true });

    // 建模完成后显示清单页：标出新内容提示并可点击切入
    panel.setTabVisible('order', true);
    expect(orderTab.classList.contains('is-hidden')).toBe(false);
    expect(orderTab.disabled).toBe(false);
    expect(orderTab.classList.contains('has-new')).toBe(true);
    expect(orderTab.classList.contains('is-revealing')).toBe(true);

    orderTab.click();
    expect(panel.tab).toBe('order');
    expect(onTabSelect).toHaveBeenLastCalledWith('order', { prev: 'debug', changed: true });

    // 再次点击当前清单页也会回调（用于回到建模正视图）
    orderTab.click();
    expect(onTabSelect).toHaveBeenLastCalledWith('order', { prev: 'order', changed: false });

    // 重新载入照片时隐藏清单页，自动回退到进度页
    panel.setTabVisible('order', false);
    expect(panel.tab).toBe('progress');
    expect(orderTab.classList.contains('is-hidden')).toBe(true);
  });
});
