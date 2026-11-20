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
    // 交叉淡化：旧视图留在原位淡出，新视图同时淡入、轻轻浮起（样式见 motion.css 的 .view.leaving / .view.active）
    for (const v of root.querySelectorAll('.view')) {
      const on = v.id === `view-${view}`;
      const was = v.classList.contains('active');
      v.classList.toggle('active', on);
      if (was && !on) {
        v.classList.add('leaving');
        clearTimeout(v._leaveTimer);
        v._leaveTimer = setTimeout(() => v.classList.remove('leaving'), 360);
      } else if (on) {
        clearTimeout(v._leaveTimer);
        v.classList.remove('leaving');
      }
    }
    onChange?.(view);
  }

  for (const t of tabs) t.addEventListener('click', () => select(t.dataset.view));
  return { select };
}
