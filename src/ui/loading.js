// 视图区的加载遮罩：读取照片、识别元件这类"要等一会儿"的时候盖在视图上。
// 同一个遮罩在几种状态之间平滑过渡，而不是一个藏起来、另一个突然冒出来：
// - cover：还没有画面（读取照片）——不透明底；
// - glass：画面已经有了（识别中）——磨砂玻璃，下面的照片模糊可见；结束时模糊慢慢退掉，照片"对焦"出来。
// 多个来源（photo / prep / detect / build）各自 set / clear，显示优先级最高的那个；全部清掉后稍等一下才收起，
// 两段等待之间不会闪一下。样式在 motion.css（.view-loader）。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 同时有几个来源时显示哪个：新照片最优先，其余按流程靠后的优先（建场景 > 识别 > 定位标定板）
const PRIORITY = ['photo', 'build', 'detect', 'prep'];
/** 收起时淡出的时长（ms，含稍等的 140 ms），与 motion.css 的 .view-loader 一致；等它淡完再切视图，两段动画不叠在一起 */
export const LOADER_HIDE_MS = 140 + 550;

/**
 * @param {HTMLElement} root 视图容器（.views）
 */
export function createViewLoader(root) {
  const el = document.createElement('div');
  el.className = 'view-loader';
  el.dataset.mode = 'cover';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="view-loader-card">
      <span class="loader-orb" aria-hidden="true"><span class="tick-spinner"></span></span>
      <p class="view-loader-title"></p>
      <p class="view-loader-sub"></p>
      <span class="progress" aria-hidden="true"><i></i></span>
      <button type="button" class="btn btn-small btn-ghost view-loader-action" hidden></button>
    </div>`;
  root.appendChild(el);
  const titleEl = el.querySelector('.view-loader-title');
  const subEl = el.querySelector('.view-loader-sub');
  const bar = el.querySelector('.progress');
  const actionEl = el.querySelector('.view-loader-action');
  /** @type {Map<string, any>} */
  const sources = new Map();
  let shown = null; // 当前显示的选项
  let hideTimer = 0;
  let action = null;
  actionEl.addEventListener('click', () => action?.onClick());

  function apply() {
    const owner = PRIORITY.find((k) => sources.has(k)) ?? [...sources.keys()].at(-1);
    const opts = owner ? sources.get(owner) : null;
    clearTimeout(hideTimer);
    if (!opts) {
      // 稍等再收：紧接着下一段等待（读完照片马上开始识别）时遮罩不闪
      hideTimer = setTimeout(() => {
        el.classList.remove('is-on');
        shown = null;
      }, 140);
      return;
    }
    const { title, sub = '', progress = null, mode = 'cover', action: act = null } = opts;
    if (!shown || shown.title !== title) {
      titleEl.textContent = title;
      // 标题换了：文字轻轻换入（重新触发动画）
      titleEl.classList.remove('swap');
      void titleEl.offsetWidth;
      titleEl.classList.add('swap');
    }
    subEl.textContent = sub;
    subEl.hidden = !sub;
    bar.classList.toggle('indeterminate', progress == null);
    bar.style.setProperty('--p', progress == null ? 0 : Math.max(0, Math.min(1, progress)));
    el.dataset.mode = mode;
    action = act;
    actionEl.hidden = !act;
    if (act) actionEl.textContent = act.label;
    el.classList.add('is-on');
    shown = opts;
  }

  return {
    /**
     * @param {string} owner 来源：'photo' | 'prep'（定位标定板）| 'detect' | 'build'（建场景）
     * @param {{ title: string, sub?: string, progress?: number|null, mode?: 'cover'|'glass', action?: { label: string, onClick: () => void } } | null} opts
     *   progress：0–1 时显示进度条；null 时进度条来回滑（不知道还要多久）
     */
    set(owner, opts) {
      if (opts) sources.set(owner, opts);
      else if (sources.has(owner)) sources.delete(owner);
      else return;
      apply();
    },
    /** 兼容旧调用：等同 set('photo', …) */
    show(opts) {
      this.set('photo', opts);
    },
    hide() {
      this.set('photo', null);
    },
    get visible() {
      return el.classList.contains('is-on');
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
