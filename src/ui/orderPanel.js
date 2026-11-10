// "元件清单"分区：清点（板上每种有几个）+ 自选清单（每种要几个，按清单分拣）+ AI 帮填。
// 数量的整理、挑零件是 robot/order.js 的纯函数；这里只管界面。
import { selectForOrder, orderTable, clampCount, normalizeOrder, ORDER_MAX } from '../robot/order.js';
import { askOrder, DEFAULT_MODEL, MAX_REQUEST_CHARS, REASONING_OPTIONS, normalizeEffort } from '../llm/orderAssist.js';
import { clearOrderCache } from '../llm/orderCache.js';
import { toCsv } from '../experiment.js';
import { downloadText } from './download.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LLM_KEY = 'yolohtml.deepseek';
const EFFORT_LABELS = ['关闭', '低', '高', 'Ultra'];
const EFFORT_HINTS = ['直接生成，节省 token', '轻量思考，适合简单需求', '深入推理，适合复杂电路', '充分推理，耗时与 token 用量更高'];

function loadLlm() {
  try {
    const v = JSON.parse(localStorage.getItem(LLM_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveLlm(v) {
  try {
    localStorage.setItem(LLM_KEY, JSON.stringify(v));
  } catch {
    // 不能存就只在这次打开期间有效
  }
}

/**
 * @param {{
 *   panel: ReturnType<import('./infoPanel.js').createInfoPanel>,
 *   getParts: () => (import('../state.js').Part[]|null),
 *   getPlanningOptions?: () => { footprints: object, arm: object },
 *   onChange: () => void,   清单变了（调用方重新规划）
 *   fileStem: () => string,
 *   message: (text: string, level?: string) => void,
 * }} deps
 */
export function createOrderPanel({ panel, getParts, getPlanningOptions = () => ({}), onChange, fileStem, message }) {
  /** 自选清单：null = 全部分拣；否则 种类 → 数量 */
  let order = null;
  let note = '';
  let usage = null;
  let cacheHit = false;
  let bodyElement = null;
  let aiStatus = '';
  let busy = null; // 正在请求大模型时的 AbortController
  let llm = { model: DEFAULT_MODEL, apiKey: '', baseURL: '', reasoningEffort: 'none', useCache: true, ...loadLlm() };
  llm.reasoningEffort = normalizeEffort(llm.reasoningEffort);
  llm.useCache = llm.useCache !== false;
  let draft = '';
  let aiOpen = false;
  let stopMotion = () => {};
  let stopEffortPicker = () => {};

  // 无逐帧 JS；只在可见性改变时启停轨道内的合成动画。
  function watchMotion(box) {
    let visible = typeof IntersectionObserver === 'undefined';
    const sync = () => box.classList.toggle('ai-motion', visible && box.open && !document.hidden);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer?.observe(box);
    box.addEventListener('toggle', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    stopMotion = () => {
      observer?.disconnect();
      box.removeEventListener('toggle', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }

  function refreshEffort(body, position) {
    const index = REASONING_OPTIONS.findIndex((o) => o.value === llm.reasoningEffort);
    const slider = body.querySelector('[data-llm="reasoningEffort"]');
    slider.value = position ?? index;
    slider.setAttribute('aria-valuetext', `${index === 3 ? '最高 Ultra' : EFFORT_LABELS[index]}：${EFFORT_HINTS[index]}`);
    body.querySelector('.ai-box').dataset.effort = llm.reasoningEffort;
    body.querySelector('.ai-effort').style.setProperty('--effort-fill', (position ?? index) / (REASONING_OPTIONS.length - 1));
    body.querySelector('.ai-effort-value').textContent = EFFORT_LABELS[index];
    body.querySelector('.ai-effort-value').title = EFFORT_HINTS[index];
    body.querySelector('.ai-effort-hint').textContent = EFFORT_HINTS[index];
    const model = llm.model.trim() || DEFAULT_MODEL;
    body.querySelector('.ai-effort-model-name').textContent = `${model === 'deepseek-flash' ? 'DeepSeek Flash' : model === 'deepseek-v4-pro' ? 'DeepSeek V4 Pro' : model} · DeepSeek`;
  }

  function setupEffortPicker(body) {
    const picker = body.querySelector('.ai-effort');
    const slider = picker.querySelector('input');
    const dots = [...picker.querySelectorAll('.ai-effort-dots > span')];
    let near = -1;
    let ready = false;
    let pending = -1;
    let pointer = null;
    let settleTimer;
    const paintDots = () => {
      dots.forEach((dot, i) => {
        dot.classList.toggle('is-near', i === near || i === pending);
        dot.classList.toggle('is-target', i === pending || (i === near && ready));
      });
    };
    const clearHover = () => { near = -1; ready = false; paintDots(); };
    const preview = (event) => {
      if (event.pointerType === 'touch') return;
      const bounds = slider.getBoundingClientRect();
      const travel = bounds.width - 32; // 和视觉滑块直径一致，缩放后按 CSS 像素计算。
      if (travel <= 0) return;
      const position = (event.clientX - bounds.left - 16) / travel * (dots.length - 1);
      const candidate = Math.max(0, Math.min(dots.length - 1, Math.round(position)));
      const distance = Math.abs(position - candidate) * travel / (dots.length - 1);
      const current = REASONING_OPTIONS.findIndex((o) => o.value === llm.reasoningEffort);
      const nextNear = candidate !== current && distance <= Math.min(24, travel / (dots.length - 1) * .4) ? candidate : -1;
      const nextReady = nextNear !== -1 && distance <= 10;
      if (nextNear === near && nextReady === ready) return;
      near = nextNear;
      ready = nextReady;
      paintDots();
    };
    const target = (index) => {
      if (index === pending) return;
      clearTimeout(settleTimer);
      pending = index;
      near = -1;
      ready = false;
      paintDots();
      // 仅切换时启动一次收尾；位置和高亮的每一帧交给 CSS 合成。
      settleTimer = setTimeout(() => { pending = -1; paintDots(); }, 280);
    };
    // step=any 让拖动连续；键盘保持逐档切换，包括 Home / End。
    slider.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = REASONING_OPTIONS.findIndex((o) => o.value === llm.reasoningEffort);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : Math.max(0, Math.min(3, current + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1)));
      if (next !== current) target(next);
      llm = { ...llm, reasoningEffort: REASONING_OPTIONS[next].value };
      refreshEffort(body);
      saveLlm(llm);
    });
    const pointerEnd = (event) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer = null;
      picker.classList.remove('is-dragging', 'is-pressed');
      clearHover();
      refreshEffort(body);
      saveLlm(llm);
    };
    slider.addEventListener('pointerenter', preview);
    slider.addEventListener('pointermove', (event) => {
      // 点按保留吸附动画；实际拖动才关闭位置过渡，使滑块紧跟指针。
      if (pointer && event.pointerId === pointer.id && Math.abs(event.clientX - pointer.x) > 3) picker.classList.add('is-dragging');
      if (!pointer) preview(event);
    });
    slider.addEventListener('pointerleave', clearHover);
    slider.addEventListener('blur', clearHover);
    slider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX };
      picker.classList.add('is-pressed');
    });
    slider.addEventListener('input', () => {
      const next = Math.round(Number(slider.value));
      if (REASONING_OPTIONS[next]?.value !== llm.reasoningEffort) target(next);
    });
    document.addEventListener('pointerup', pointerEnd);
    document.addEventListener('pointercancel', pointerEnd);
    body.querySelector('.ai-effort-model').addEventListener('click', () => {
      body.querySelector('.ai-settings').open = true;
      body.querySelector('[data-llm="model"]').focus();
    });
    stopEffortPicker = () => {
      clearTimeout(settleTimer);
      document.removeEventListener('pointerup', pointerEnd);
      document.removeEventListener('pointercancel', pointerEnd);
    };
  }

  const selection = () => selectForOrder(getParts() ?? [], order, getPlanningOptions());

  function statusText(l) {
    if (l.short > 0) return `<span class="bad">缺 ${l.short}</span>`;
    if (!l.want) return '<span class="muted">不拣</span>';
    return l.want === l.have ? '全部' : `拣 ${l.pick}`;
  }

  function summaryText(sel) {
    const total = sel.lines.reduce((s, l) => s + l.have, 0);
    if (!sel.custom) return `板上共 <b>${total}</b> 个元件，全部分拣。改下面的数量即按清单分拣。`;
    return `按清单分拣：需要 <b>${sel.totalWant}</b> 个，板上能拣 <b>${sel.totalPick}</b> 个${sel.totalShort ? `，<span class="bad">缺 ${sel.totalShort} 个</span>` : ''}；其余留在板上，挡路的先挪到空位。优先拣遮挡最少的元件。`;
  }

  /** 只更新数字和状态（不重建输入框，免得打字时丢焦点） */
  function refresh(body, { inputs = false } = {}) {
    const sel = selection();
    body.querySelector('.order-summary').innerHTML = summaryText(sel);
    for (const l of sel.lines) {
      const tr = body.querySelector(`tr[data-key="${l.key}"]`);
      if (!tr) continue;
      tr.querySelector('.st').innerHTML = statusText(l);
      tr.classList.toggle('none', !l.have && !l.want);
      if (inputs) tr.querySelector('input').value = l.want;
    }
    body.querySelector('[data-act="all"]').disabled = !sel.custom;
  }

  function setOrder(next, body, { inputs = true } = {}) {
    order = next;
    if (body) refresh(body, { inputs });
    onChange();
  }

  function render() {
    stopEffortPicker();
    stopMotion();
    const parts = getParts();
    if (!parts) {
      panel.remove('order');
      bodyElement = null;
      return;
    }
    const sel = selection();
    const body = panel.setCustom('order', '元件清单');
    bodyElement = body;
    body.innerHTML = `
      <p class="summary order-summary"></p>
      <table class="order-table">
        <thead><tr><th>元件</th><th>板上</th><th>需要</th><th></th></tr></thead>
        <tbody>${sel.lines.map((l) => `
          <tr data-key="${l.key}">
            <td><span class="dot" style="--c:${l.hex}"></span>${esc(l.label)}</td>
            <td class="num">${l.have}</td>
            <td><span class="qty"><button type="button" class="icon-btn" data-step="-1" aria-label="减少">−</button><input type="number" inputmode="numeric" min="0" max="${ORDER_MAX}" value="${l.want}" aria-label="${esc(l.label)} 需要数量" /><button type="button" class="icon-btn" data-step="1" aria-label="增加">＋</button></span></td>
            <td class="st"></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="sec-actions">
        <button type="button" class="btn btn-small" data-act="all">恢复全部</button>
        <button type="button" class="btn btn-small" data-act="none">清零</button>
        <button type="button" class="btn btn-small" data-act="csv">导出清单</button>
      </div>
      <details class="ai-box"${aiOpen ? ' open' : ''}>
        <summary><span class="ai-emblem" aria-hidden="true">✦</span><span class="ai-heading">AI 帮我填清单<small>DeepSeek</small></span><span class="ai-chevron" aria-hidden="true"></span></summary>
        <div class="ai-content">
        <textarea class="ai-text" aria-label="描述元件需求" rows="3" maxlength="${MAX_REQUEST_CHARS}" placeholder="想做什么电路？\n例如：红绿蓝三色指示灯，每路串一个限流电阻">${esc(draft)}</textarea>
        <div class="ai-effort">
          <div class="ai-effort-card" role="group" aria-label="思考强度">
            <div class="ai-effort-value" aria-hidden="true"></div>
            <button type="button" class="ai-effort-model" aria-label="修改 AI 模型"><span class="ai-effort-model-name"></span><span aria-hidden="true">›</span></button>
            <div class="ai-effort-track">
              <div class="ai-effort-rail" aria-hidden="true"><div class="ai-effort-fill"><span class="ai-effort-aurora"></span><span class="ai-effort-particles"></span><span class="ai-effort-particles ai-effort-particles-back"></span></div></div>
              <div class="ai-effort-dots" aria-hidden="true">${EFFORT_LABELS.map((label, i) => `<span style="--stop:${i / (EFFORT_LABELS.length - 1)}"></span>`).join('')}</div>
              <span class="ai-effort-knob-path" aria-hidden="true"><span class="ai-effort-knob"></span></span>
              <input type="range" min="0" max="${REASONING_OPTIONS.length - 1}" step="any" value="0" data-llm="reasoningEffort" aria-label="思考强度" aria-describedby="ai-effort-hint" />
            </div>
            <p class="ai-effort-hint" id="ai-effort-hint"></p>
          </div>
        </div>
        <div class="ai-cache-row">
          <label class="ai-cache-toggle"><input type="checkbox" data-llm="useCache"${llm.useCache ? ' checked' : ''} /><span class="ai-switch" aria-hidden="true"></span>复用本地缓存</label>
          <button type="button" class="ai-text-button" data-act="cache-clear">清空缓存</button>
        </div>
        <div class="sec-actions ai-actions">
          <button type="button" class="btn btn-primary btn-small" data-act="ai"${busy ? ' disabled' : ''}>生成清单</button>
          <button type="button" class="btn btn-small" data-act="ai-refresh"${busy ? ' disabled' : ''}>重新生成</button>
          <button type="button" class="btn btn-small" data-act="ai-cancel"${busy ? '' : ' hidden'}>取消</button>
        </div>
        <p class="muted small ai-status" role="status">${esc(aiStatus)}</p>
        <p class="ai-cache-hint">缓存保留 24 小时 · 最多 50 条<br />重新生成将调用接口，成功后替换当前清单。</p>
        <p class="note ai-note"${note ? '' : ' hidden'}>${esc(note)}</p>
        <p class="muted small ai-usage"${usage || cacheHit ? '' : ' hidden'}>${cacheHit ? '命中本地缓存，本次未调用接口（0 token）' : usage ? `本次 ${usage.totalTokens} tokens（输入 ${usage.promptTokens}，输出 ${usage.completionTokens}，其中思考 ${usage.reasoningTokens ?? 0}，服务端缓存命中 ${usage.cachedTokens}）` : ''}</p>
        <details class="ai-settings"${llm.apiKey ? '' : ' open'}>
          <summary>接口设置</summary>
          <label>API Key <input type="password" data-llm="apiKey" autocomplete="off" spellcheck="false" placeholder="sk-…" value="${esc(llm.apiKey)}" /></label>
          <label>模型 <input type="text" data-llm="model" spellcheck="false" value="${esc(llm.model)}" /></label>
          <label>接口地址 <input type="text" data-llm="baseURL" spellcheck="false" placeholder="https://api.deepseek.com" value="${esc(llm.baseURL)}" /></label>
          <p class="muted small">Key 只保存在这台电脑的浏览器里，请求从浏览器直接发给接口；公用电脑演示完请清空。</p>
        </details>
        </div>
      </details>`;
    refreshEffort(body);
    setupEffortPicker(body);
    watchMotion(body.querySelector('.ai-box'));
    refresh(body);

    const current = () => {
      const o = {};
      for (const tr of body.querySelectorAll('tbody tr')) o[tr.dataset.key] = clampCount(tr.querySelector('input').value);
      return o;
    };
    body.querySelector('tbody').addEventListener('input', (e) => {
      if (e.target.matches('input')) setOrder(current(), body, { inputs: false });
    });
    body.querySelector('tbody').addEventListener('change', (e) => {
      if (e.target.matches('input')) e.target.value = clampCount(e.target.value); // 离开输入框时整理成整数
    });
    body.addEventListener('click', (e) => {
      const step = e.target.closest('[data-step]');
      if (step) {
        const input = step.parentElement.querySelector('input');
        input.value = clampCount(Number(input.value) + Number(step.dataset.step));
        setOrder(current(), body, { inputs: false });
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'all') {
        note = '';
        body.querySelector('.ai-note').hidden = true;
        setOrder(null, body);
      } else if (act === 'none') setOrder({}, body);
      else if (act === 'csv') {
        const t = orderTable(selection());
        downloadText(toCsv(t.header, t.rows), `元件清单_${fileStem()}.csv`, 'text/csv;charset=utf-8');
        message('已导出元件清单', 'ok');
      } else if (act === 'ai') runAi();
      else if (act === 'ai-refresh') runAi({ refresh: true });
      else if (act === 'cache-clear') {
        clearOrderCache();
        message('已清空本地清单缓存', 'ok');
        aiStatus = '已清空本地缓存';
        body.querySelector('.ai-status').textContent = aiStatus;
      }
      else if (act === 'ai-cancel') busy?.abort();
    });
    body.querySelector('.ai-box').addEventListener('toggle', (e) => {
      if (e.target.classList.contains('ai-box')) aiOpen = e.target.open;
    });
    body.querySelector('.ai-text').addEventListener('input', (e) => {
      draft = e.target.value;
    });
    for (const input of body.querySelectorAll('[data-llm]')) {
      if (input.dataset.llm === 'reasoningEffort') {
        const update = () => {
          const position = Math.max(0, Math.min(REASONING_OPTIONS.length - 1, Number(input.value)));
          llm = { ...llm, reasoningEffort: REASONING_OPTIONS[Math.round(position)].value };
          refreshEffort(body, position);
        };
        input.addEventListener('input', update);
        input.addEventListener('change', () => { update(); refreshEffort(body); saveLlm(llm); });
        continue;
      }
      input.addEventListener('change', () => {
        llm = { ...llm, [input.dataset.llm]: input.type === 'checkbox' ? input.checked : input.value.trim() };
        saveLlm(llm);
        if (input.dataset.llm === 'model') refreshEffort(body);
      });
    }
  }

  /** 成功取得完整结果后，先清空旧选择及所有输入，再填本次结果；仅重新规划一次。 */
  function replaceAiOrder(next) {
    order = {};
    const body = bodyElement?.isConnected ? bodyElement : null;
    if (body) for (const input of body.querySelectorAll('.order-table input')) input.value = 0;
    order = normalizeOrder(next);
    if (body) refresh(body, { inputs: true });
    onChange();
  }

  function updateBusyControls() {
    if (!bodyElement?.isConnected) return;
    for (const button of bodyElement.querySelectorAll('[data-act="ai"], [data-act="ai-refresh"]')) button.disabled = !!busy;
    bodyElement.querySelector('[data-act="ai-cancel"]').hidden = !busy;
    bodyElement.querySelector('.ai-status').textContent = aiStatus;
  }

  async function runAi({ refresh = false } = {}) {
    if (busy) return;
    const controller = new AbortController();
    busy = controller;
    aiStatus = llm.reasoningEffort === 'none' ? '正在生成清单…' : '正在思考并生成清单…';
    updateBusyControls();
    try {
      const res = await askOrder({ ...llm, text: draft, refresh, signal: controller.signal });
      if (controller.signal.aborted) {
        aiStatus = '已取消';
        return;
      }
      usage = res.usage;
      cacheHit = !!res.cacheHit;
      note = res.note;
      replaceAiOrder(res.order);
      message(`AI 已替换清单：共 ${Object.values(order).reduce((s, n) => s + n, 0)} 个元件${cacheHit ? '（本地缓存）' : ''}`, 'ok');
      aiStatus = '';
      busy = null;
      render();
    } catch (err) {
      aiStatus = err.message;
      if (!controller.signal.aborted) message(`AI 填写清单失败：${err.message}`, 'warn');
    } finally {
      busy = null;
      updateBusyControls();
    }
  }

  return {
    render,
    selection,
    get order() {
      return order;
    },
  };
}
