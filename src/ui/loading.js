// 视图区的加载遮罩：读取照片这类"画面上还没有东西可看"的等待，盖在视图上转圈 + 一句说明。
// 样式在 motion.css（.view-loader）；稍等片刻才显出来，读得快就不会闪一下。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {HTMLElement} root 视图容器（.views）
 */
export function createViewLoader(root) {
  const el = document.createElement('div');
  el.className = 'view-loader';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  root.appendChild(el);
  let key = '';
  return {
    /**
     * @param {{ title: string, sub?: string, progress?: number|null }} o
     *   progress：0–1 时显示进度条；null 时进度条来回滑（不知道还要多久）
     */
    show({ title, sub = '', progress = null }) {
      const next = `${title}\n${sub}`;
      if (key !== next) {
        // 内容没变就不重建：否则每次刷新状态，转圈和淡入都会从头开始
        key = next;
        el.innerHTML = `<div class="view-loader-card"><span class="spinner lg" aria-hidden="true"></span><p class="view-loader-title">${esc(title)}</p>${sub ? `<p class="view-loader-sub">${esc(sub)}</p>` : ''}<span class="progress" aria-hidden="true"><i></i></span></div>`;
      }
      const bar = el.querySelector('.progress');
      bar.classList.toggle('indeterminate', progress == null);
      bar.style.setProperty('--p', progress == null ? 0 : Math.max(0, Math.min(1, progress)));
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
      key = '';
    },
    get visible() {
      return !el.hidden;
    },
  };
}

/**
 * 把按钮切到"等待中"（转圈、不能点），返回恢复函数
 * @param {HTMLButtonElement} btn
 * @param {string} [label] 等待时换成的文字
 */
export function setButtonLoading(btn, on, label) {
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    if (label) btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
  btn.classList.toggle('is-loading', !!on);
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}
