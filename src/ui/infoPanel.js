// 右侧信息面板：顶部三个标签页（进度 / 清单 / 调试），每页若干分区（键值表或自定义内容）。
// 消息：成功 / 警告 / 出错弹一条右下角提示，几秒后自己消失；完整记录留在"调试"页最后的"消息记录"里。

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PANES = [
  { id: 'progress', label: '进度' },
  { id: 'order', label: '清单', empty: '识别完成后，在这里按清单挑选要分拣的元件，也可以让 AI 帮你填。' },
  { id: 'debug', label: '调试' },
];
/** 分区放在哪一页；没列出的都在"调试"页 */
const PANE_OF = { status: 'progress', sort: 'progress', export: 'progress', order: 'order' };
/** 同一页里的先后顺序（没列出的按出现先后排在后面） */
const RANK = ['status', 'sort', 'export', 'order', 'image', 'markers', 'pose', 'detect', 'truth', 'timing', 'arm'];
const rankOf = (key, last) => (last ? 1000 : RANK.includes(key) ? RANK.indexOf(key) : 500);
const TOAST_MS = { ok: 2600, warn: 4500, error: 6500 };

/**
 * @param {HTMLElement} el
 */
export function createInfoPanel(el) {
  el.innerHTML = '';
  /** @type {Map<string, HTMLElement>} */
  const sections = new Map();
  const collapsed = new Map();
  const advanced = new Set(['timing', 'intrinsics', 'markers', 'detect', 'pose', 'experiment', 'truth', 'arm']);

  // ---------- 标签页 ----------
  const tabbar = document.createElement('div');
  tabbar.className = 'panel-tabs';
  tabbar.setAttribute('role', 'tablist');
  tabbar.setAttribute('aria-label', '信息面板');
  el.appendChild(tabbar);
  /** @type {Record<string, HTMLElement>} */
  const panes = {};
  /** @type {Record<string, HTMLButtonElement>} */
  const tabs = {};
  let current = 'progress';
  for (const p of PANES) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'panel-tab';
    tab.dataset.pane = p.id;
    tab.id = `panel-tab-${p.id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-pane-${p.id}`);
    tab.textContent = p.label;
    tab.addEventListener('click', () => select(p.id));
    tabbar.appendChild(tab);
    tabs[p.id] = tab;
    const pane = document.createElement('div');
    pane.className = 'panel-pane';
    pane.id = `panel-pane-${p.id}`;
    pane.dataset.pane = p.id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    if (p.empty) pane.innerHTML = `<p class="panel-empty">${esc(p.empty)}</p>`;
    el.appendChild(pane);
    panes[p.id] = pane;
  }
  tabbar.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const visible = PANES.filter((p) => getComputedStyle(tabs[p.id]).display !== 'none');
    const i = visible.findIndex((p) => p.id === current);
    const next = visible[(i + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
    select(next.id);
    tabs[next.id].focus();
  });

  function select(id) {
    if (!panes[id]) return;
    current = id;
    for (const p of PANES) {
      const on = p.id === id;
      tabs[p.id].classList.toggle('active', on);
      tabs[p.id].setAttribute('aria-selected', String(on));
      tabs[p.id].tabIndex = on ? 0 : -1;
      panes[p.id].hidden = !on;
      if (on) tabs[p.id].classList.remove('has-new');
    }
  }
  select('progress');

  // ---------- 消息记录（调试页最后） ----------
  const debugTools = document.createElement('div');
  debugTools.className = 'debug-pane-tools';
  debugTools.innerHTML = `<span class="debug-tools-label">调试参数分区</span><div class="debug-tools-btns"><button type="button" class="ai-text-button" data-debug-act="expand">全部展开</button><span class="muted">·</span><button type="button" class="ai-text-button" data-debug-act="collapse">全部收起</button></div>`;
  debugTools.addEventListener('click', (e) => {
    const act = e.target.closest('[data-debug-act]')?.dataset.debugAct;
    if (!act) return;
    const open = act === 'expand';
    for (const d of panes.debug.querySelectorAll(':scope > details.panel-section')) {
      d.open = open;
      if (d.dataset.key) collapsed.set(d.dataset.key, !open);
    }
  });
  panes.debug.appendChild(debugTools);

  const msgSection = document.createElement('details');
  msgSection.className = 'panel-section';
  msgSection.dataset.key = 'messages';
  msgSection.innerHTML = '<summary>消息记录</summary><div class="msgs" aria-live="polite"></div>';
  const msgBox = msgSection.querySelector('.msgs');
  panes.debug.appendChild(msgSection);

  // ---------- 右下角提示 ----------
  let toastHost = document.querySelector('.toasts');
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  function toast(text, level) {
    const t = document.createElement('div');
    t.className = `toast ${level}`;
    t.innerHTML = `<i aria-hidden="true"></i><span>${esc(text)}</span><button type="button" class="toast-close" aria-label="关闭">×</button>`;
    let timer;
    const close = () => {
      clearTimeout(timer);
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 180);
    };
    t.querySelector('button').addEventListener('click', close);
    t.addEventListener('pointerenter', () => clearTimeout(timer));
    t.addEventListener('pointerleave', () => { timer = setTimeout(close, 1500); });
    toastHost.appendChild(t);
    while (toastHost.childElementCount > 3) toastHost.firstElementChild.remove();
    timer = setTimeout(close, TOAST_MS[level] ?? 3000);
  }

  function getSection(key, title, { last = false } = {}) {
    const paneId = PANE_OF[key] ?? 'debug';
    const pane = panes[paneId];
    let sec = sections.get(key);
    if (!sec) {
      const foldable = advanced.has(key);
      sec = document.createElement(foldable ? 'details' : 'section');
      if (foldable) {
        sec.open = collapsed.has(key) ? !collapsed.get(key) : !window.matchMedia('(max-width: 900px)').matches;
        sec.addEventListener('toggle', () => collapsed.set(key, !sec.open));
      }
      sec.className = 'panel-section';
      sec.dataset.key = key;
      sec.dataset.rank = String(rankOf(key, last));
      sections.set(key, sec);
      place(pane, sec);
      if (paneId !== current && paneId === 'order') tabs[paneId].classList.add('has-new');
    } else if (last && sec.dataset.rank !== '1000') {
      sec.dataset.rank = '1000';
      place(pane, sec);
    }
    sec.innerHTML = `${sec.tagName === 'DETAILS' ? `<summary>${esc(title)}</summary>` : `<h3>${esc(title)}</h3>`}<div class="body"></div>`;
    return sec.querySelector('.body');
  }

  /** 按 rank 插到页里合适的位置（消息记录始终在调试页最后） */
  function place(pane, sec) {
    const rank = Number(sec.dataset.rank);
    const after = [...pane.querySelectorAll(':scope > .panel-section')].find((s) => s !== sec && (s === msgSection || Number(s.dataset.rank) > rank));
    pane.insertBefore(sec, after ?? null);
  }

  return {
    /**
     * 设置一个键值表分区
     * @param {string} key
     * @param {string} title
     * @param {[string, string|number][]} rows
     */
    setRows(key, title, rows) {
      const body = getSection(key, title);
      body.innerHTML =
        '<dl class="kv">' +
        rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') +
        '</dl>';
    },

    /**
     * 设置一个自定义内容分区，返回内容容器
     * @param {string} key
     * @param {string} title
     * @param {{ last?: boolean }} [opts] last：始终放在该页最后
     * @returns {HTMLElement}
     */
    setCustom(key, title, opts) {
      return getSection(key, title, opts);
    },

    /** 删除分区 */
    remove(key) {
      sections.get(key)?.remove();
      sections.delete(key);
    },

    /** 切换标签页：'progress' | 'order' | 'debug' */
    selectTab(id) {
      select(id);
    },
    get tab() {
      return current;
    },

    /** 跳转到指定分区并展开闪烁提示 */
    focusSection(key) {
      const paneId = PANE_OF[key] ?? 'debug';
      select(paneId);
      const sec = sections.get(key) ?? (key === 'messages' ? msgSection : null);
      if (!sec) return;
      if (sec.tagName === 'DETAILS') sec.open = true;
      sec.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      sec.classList.remove('section-flash');
      void sec.offsetWidth;
      sec.classList.add('section-flash');
    },

    /**
     * 追加一条消息（记录到"消息记录"；成功 / 警告 / 出错同时弹提示）
     * @param {string} text
     * @param {'info'|'ok'|'warn'|'error'} [level='info']
     */
    message(text, level = 'info') {
      const p = document.createElement('p');
      p.className = `msg ${level}`;
      p.textContent = text;
      msgBox.appendChild(p);
      while (msgBox.childElementCount > 50) msgBox.firstElementChild.remove();
      if (level !== 'info') toast(text, level);
    },

    clearMessages() {
      msgBox.innerHTML = '';
    },
  };
}
