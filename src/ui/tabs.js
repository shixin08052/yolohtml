// 视图标签页切换。

/**
 * @param {HTMLElement} root  包含 .tab 按钮和 .view 区块的容器
 * @param {(view: string) => void} [onChange]
 */
export function createTabs(root, onChange) {
  const tabs = [...root.querySelectorAll('.tab')];

  function select(view) {
    for (const t of tabs) {
      const on = t.dataset.view === view;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const v of root.querySelectorAll('.view')) {
      v.classList.toggle('active', v.id === `view-${view}`);
    }
    onChange?.(view);
  }

  for (const t of tabs) t.addEventListener('click', () => select(t.dataset.view));
  return { select };
}
