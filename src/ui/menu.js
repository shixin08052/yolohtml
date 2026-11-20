// 下拉菜单：按钮点开 / 方向键选择 / Esc 或点外面关闭。菜单本身是按钮旁边一个 [role=menu] 的元素。

/**
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} menu
 */
export function bindMenu(button, menu) {
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not([disabled])')];
  const outside = (e) => {
    if (!menu.contains(e.target) && !button.contains(e.target)) close(false);
  };
  function open(focusFirst = false) {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    if (focusFirst) items()[0]?.focus();
  }
  function close(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
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
