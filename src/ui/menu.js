// 下拉菜单：按钮点开 / 方向键选择 / Esc 或点外面关闭。菜单本身是按钮旁边一个 [role=menu] 的元素。

/**
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} menu
 */
export function bindMenu(button, menu) {
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not([disabled])')];
  const resetStyle = () => {
    menu.style.left = '';
    menu.style.right = '';
    menu.style.top = '';
    menu.style.bottom = '';
    menu.style.maxWidth = '';
    menu.style.maxHeight = '';
  };
  const positionMenu = () => {
    const margin = 8;
    const gap = 8;
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    const vh = document.documentElement.clientHeight || window.innerHeight || 0;
    resetStyle();
    if (vw > 0) menu.style.maxWidth = `${Math.max(160, vw - margin * 2)}px`;
    const menuW = menu.offsetWidth;
    const menuH = menu.offsetHeight;
    const anchor = menu.offsetParent || button.parentElement || button;
    const anchorRect = anchor.getBoundingClientRect();
    if (vw > 0 && menuW > 0) {
      const maxLeft = Math.max(margin, vw - margin - menuW);
      const desiredLeft = Math.min(Math.max(anchorRect.right - menuW, margin), maxLeft);
      menu.style.right = 'auto';
      menu.style.left = `${Math.round(desiredLeft - anchorRect.left)}px`;
    }
    if (vh > 0 && menuH > 0) {
      const spaceBelow = vh - anchorRect.bottom - margin - gap;
      const spaceAbove = anchorRect.top - margin - gap;
      if (spaceBelow < menuH && spaceAbove > spaceBelow) {
        menu.style.top = 'auto';
        menu.style.bottom = `calc(100% + ${gap}px)`;
        menu.style.maxHeight = `${Math.min(440, Math.max(120, Math.floor(spaceAbove)))}px`;
      } else {
        menu.style.top = `calc(100% + ${gap}px)`;
        menu.style.bottom = 'auto';
        if (spaceBelow > 0) menu.style.maxHeight = `${Math.min(440, Math.max(120, Math.floor(spaceBelow)))}px`;
      }
    }
  };
  const reposition = () => {
    if (!menu.hidden) positionMenu();
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !button.contains(e.target)) close(false);
  };
  function open(focusFirst = false) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.closest('.topbar')?.classList.add('has-open-menu');
    positionMenu();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    if (focusFirst) items()[0]?.focus();
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    resetStyle();
    const topbar = button.closest('.topbar');
    if (topbar && !topbar.querySelector('.menu:not([hidden])')) {
      topbar.classList.remove('has-open-menu');
    }
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    if (refocus) button.focus();
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close(false)));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open(true);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') close(false);
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('[role^="menuitem"]')) close(false);
  });
  return { open, close };
}
