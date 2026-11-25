// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMenu } from '../src/ui/menu.js';

function setupMenu({ anchorRect, menuWidth = 248, menuHeight = 120, viewportWidth = 375, viewportHeight = 812 } = {}) {
  document.body.innerHTML = `
    <header class="topbar">
      <div class="menu-anchor" id="anchor">
        <button type="button" id="btn" aria-expanded="false">更多</button>
        <div class="menu" id="menu" role="menu" hidden>
          <button type="button" class="menu-item" role="menuitemcheckbox" aria-checked="false">演示模式</button>
          <a class="menu-item" role="menuitem" href="./board.html">打印标定板</a>
        </div>
      </div>
    </header>
  `;
  const topbar = document.querySelector('.topbar');
  const anchor = document.querySelector('#anchor');
  const btn = document.querySelector('#btn');
  const menu = document.querySelector('#menu');

  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewportWidth);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(viewportHeight);
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    left: anchorRect.left,
    right: anchorRect.right,
    top: anchorRect.top,
    bottom: anchorRect.bottom,
    width: anchorRect.right - anchorRect.left,
    height: anchorRect.bottom - anchorRect.top,
  });
  Object.defineProperty(menu, 'offsetParent', { configurable: true, get: () => anchor });
  Object.defineProperty(menu, 'offsetWidth', { configurable: true, get: () => menuWidth });
  Object.defineProperty(menu, 'offsetHeight', { configurable: true, get: () => menuHeight });

  const ctrl = bindMenu(btn, menu);
  return { topbar, anchor, btn, menu, ctrl };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('下拉菜单视口自适应定位 (bindMenu)', () => {
  it('按钮在右上角时保持右对齐且完整落在视口内', () => {
    const { btn, menu } = setupMenu({ anchorRect: { left: 323, right: 355, top: 18, bottom: 50 }, menuWidth: 248, viewportWidth: 375 });
    btn.click();
    expect(menu.hidden).toBe(false);
    expect(menu.style.right).toBe('auto');
    expect(menu.style.left).toBe('-216px');
    const menuLeftInViewport = 323 + Number.parseInt(menu.style.left, 10);
    expect(menuLeftInViewport).toBe(107);
    expect(menuLeftInViewport + 248).toBe(355);
  });

  it('按钮换行到左侧时夹紧左边界，不超出屏幕左侧', () => {
    const { topbar, btn, menu } = setupMenu({ anchorRect: { left: 24, right: 56, top: 60, bottom: 92 }, menuWidth: 248, viewportWidth: 375 });
    btn.click();
    expect(topbar.classList.contains('has-open-menu')).toBe(true);
    expect(menu.style.right).toBe('auto');
    expect(menu.style.left).toBe('-16px');
    const menuLeftInViewport = 24 + Number.parseInt(menu.style.left, 10);
    expect(menuLeftInViewport).toBe(8);
    expect(menuLeftInViewport + 248).toBeLessThanOrEqual(375 - 8);
  });

  it('极窄屏下限制 maxWidth 并保持左右均不溢出', () => {
    const { btn, menu } = setupMenu({ anchorRect: { left: 100, right: 132, top: 20, bottom: 52 }, menuWidth: 244, viewportWidth: 260 });
    btn.click();
    expect(menu.style.maxWidth).toBe('244px');
    const menuLeftInViewport = 100 + Number.parseInt(menu.style.left, 10);
    expect(menuLeftInViewport).toBe(8);
    expect(menuLeftInViewport + 244).toBe(252);
  });

  it('下方空间不足时自动向上弹出', () => {
    const { btn, menu } = setupMenu({ anchorRect: { left: 320, right: 352, top: 420, bottom: 452 }, menuWidth: 248, menuHeight: 140, viewportWidth: 375, viewportHeight: 500 });
    btn.click();
    expect(menu.style.top).toBe('auto');
    expect(menu.style.bottom).toBe('calc(100% + 8px)');
  });

  it('关闭菜单时清理 has-open-menu、内联定位样式并停止响应 resize', () => {
    const { topbar, btn, menu, ctrl } = setupMenu({ anchorRect: { left: 24, right: 56, top: 60, bottom: 92 } });
    btn.click();
    expect(menu.style.left).toBe('-16px');
    expect(topbar.classList.contains('has-open-menu')).toBe(true);
    ctrl.close(false);
    expect(menu.hidden).toBe(true);
    expect(topbar.classList.contains('has-open-menu')).toBe(false);
    expect(menu.style.left).toBe('');
    expect(menu.style.right).toBe('');
    expect(menu.style.top).toBe('');
    expect(menu.style.bottom).toBe('');
    expect(menu.style.maxWidth).toBe('');
    expect(menu.style.maxHeight).toBe('');
    window.dispatchEvent(new Event('resize'));
    expect(menu.style.left).toBe('');
  });
});
