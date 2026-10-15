// 信息面板的"实验"分区（步骤 16）：为每个零件输入尺子量的真实坐标，算方法 1 / 方法 2 的误差；
// 输入卷尺量的手机高度与系统结果对比；记录本次实验（内参来源、俯角、各步耗时一并记下），导出 CSV。
// 记录与还没记录的输入（按照片保存的草稿）存在 localStorage，刷新页面不丢。
import { CLASSES } from '../config.js';
import { partErrors, heightError, buildRecord, resolveMeasured, measuredByPart, experimentsCsv, partsCsv, loadStore, saveStore, photoKey, SOURCE_LABELS } from '../experiment.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d).replace(/^-(0\.?0*)$/, '$1')); // 不显示 -0.0
/** 带正负号（0 不带） */
const sign = (x, d) => {
  const s = fmt(x, d);
  return Number(s) > 0 ? `+${s}` : s;
};
/** 输入框里的数：允许逗号作小数点；空或不是数时为 null */
const parseNum = (s) => {
  const v = Number.parseFloat(String(s).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** 本地存储（拿不到时为 null，例如浏览器禁用了站点数据） */
function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   panel: ReturnType<import('./infoPanel.js').createInfoPanel>,
 *   getContext: () => null | {
 *     image: import('../state.js').ImageInput, intrinsics: import('../state.js').Intrinsics, pose: import('../state.js').CameraPose|null,
 *     parts: import('../state.js').Part[]|null, truth: import('../state.js').GroundTruth|null, method: 1|2,
 *     timing: { rows: object[], total: number }|null,
 *   },
 *   message: (text: string, level?: string) => void,
 * }} deps
 */
export function createExperimentPanel({ panel, getContext, message }) {
  const storage = getStorage();
  let store = loadStore(storage);
  let warnedSave = false;

  const save = () => {
    if (!saveStore(storage, store) && !warnedSave) {
      warnedSave = true;
      message('实验记录没能保存到浏览器（存储已满或被禁用），刷新页面后会丢失，请及时导出 CSV。', 'warn');
    }
  };

  /** 当前照片的草稿 */
  function draftOf(image) {
    const k = photoKey(image);
    store.drafts[k] ??= { measured: {}, heightCm: null };
    return store.drafts[k];
  }

  /**
   * 写入某个零件的实测值。条目记下零件的类别和位置，检测结果变了（删框、重新检测、零件编号变了）也能对回原来的零件
   */
  function setMeasured(d, parts, id, patch) {
    const p = parts.find((q) => q.id === id);
    if (!p) return;
    const k = resolveMeasured(parts, d.measured)[id];
    const old = (k && d.measured[k]) || {};
    // 旧格式（键就是零件编号、没记位置）的条目换成带位置的新条目
    const key = k && old.px != null ? k : `m${Date.now().toString(36)}_${id}`;
    if (k && key !== k) delete d.measured[k];
    d.measured[key] = { x: old.x ?? null, y: old.y ?? null, ...patch, cls: p.cls, px: p.xParallax, py: p.yParallax };
  }

  /** 只更新算出来的数（输入框不重建，保持光标） */
  function updateComputed(body, ctx) {
    const d = draftOf(ctx.image);
    const { rows, summary } = partErrors(ctx.parts, measuredByPart(ctx.parts, d.measured));
    for (const r of rows) {
      const el = body.querySelector(`[data-err="${r.id}"]`);
      if (el) el.innerHTML = r.e1 == null ? '<span class="muted">误差 —</span>' : `误差 ① <b>${fmt(r.e1, 2)}</b> · ② <b>${fmt(r.e2, 2)}</b> mm`;
    }
    const sum = body.querySelector('[data-k="summary"]');
    if (sum) {
      sum.innerHTML =
        `<dt>已填实测坐标</dt><dd>${summary.n} / ${rows.length} 个零件</dd>` +
        `<dt>方法 1（不修正）</dt><dd>平均 ${fmt(summary.mean1, 2)} · 最大 ${fmt(summary.max1, 2)} mm</dd>` +
        `<dt>方法 2（视差修正）</dt><dd>平均 ${fmt(summary.mean2, 2)} · 最大 ${fmt(summary.max2, 2)} mm</dd>`;
    }
    const h = body.querySelector('[data-k="height"]');
    if (h && ctx.pose) {
      const e = heightError(ctx.pose.heightMm, d.heightCm == null ? null : d.heightCm * 10);
      h.innerHTML = `系统 ${fmt(ctx.pose.heightMm / 10, 1)} cm` + (e ? ` · 差 <b>${sign(e.diffMm / 10, 1)} cm</b>（${sign(e.pct, 1)}%）` : '');
    }
  }

  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function recordsHtml() {
    const n = store.records.length;
    let html = `<h4>已记录 ${n} 次实验</h4>`;
    if (n) {
      html += '<ol class="exp-records">';
      store.records.forEach((r, i) => {
        html += `<li><span>${i + 1}. ${esc(r.time.slice(5, 16))} · ${esc(r.photo)} · ${esc(SOURCE_LABELS[r.source] ?? r.source)}<br><span class="muted">① ${fmt(r.summary.mean1, 2)} · ② ${fmt(r.summary.mean2, 2)} mm（${r.summary.n} 个零件）${r.height ? ` · 高度差 ${fmt(r.height.pct, 1)}%` : ''}</span></span>` +
          `<button type="button" class="icon-btn" data-del="${esc(r.id)}" title="删除这条记录" aria-label="删除这条记录">✕</button></li>`;
      });
      html += '</ol>';
    }
    html += `<div class="sec-actions wrap"><button type="button" class="btn btn-small" data-act="csv-exp"${n ? '' : ' disabled'}>导出 CSV（每次实验一行）</button>` +
      `<button type="button" class="btn btn-small" data-act="csv-parts"${n ? '' : ' disabled'}>导出 CSV（每个零件一行）</button>` +
      `<button type="button" class="btn btn-small" data-act="clear-all"${n ? '' : ' disabled'}>清空记录</button></div>`;
    return html;
  }

  function render() {
    const body = panel.setCustom('experiment', '实验', { last: true });
    const ctx = getContext();
    let html = '';
    if (!ctx?.parts || !ctx.pose) {
      html += '<p class="muted">建好场景后，可以在这里为每个零件填入尺子量的真实坐标，计算误差并记录。</p>';
    } else {
      const d = draftOf(ctx.image);
      const links = resolveMeasured(ctx.parts, d.measured);
      html += '<p class="muted small">填入用尺子量的零件中心坐标（底板坐标，mm：原点在左下角，X 向右，Y 向上）。</p>';
      if (ctx.truth) html += '<div class="sec-actions"><button type="button" class="btn btn-small" data-act="fill-truth">用真值填入</button></div>';
      html += '<div class="exp-parts">';
      for (const p of ctx.parts) {
        const m = d.measured[links[p.id]] ?? {};
        const v = (k) => (m[k] == null ? '' : String(m[k]));
        html += `<div class="exp-part" style="--c: ${CLASSES[p.cls]?.color ?? '#888'}"><div class="exp-head"><b>#${p.id} ${esc(p.name)}</b>` +
          `<span class="muted">① (${fmt(p.xPlane)}, ${fmt(p.yPlane)}) · ② (${fmt(p.xParallax)}, ${fmt(p.yParallax)})</span></div>` +
          `<div class="exp-inputs"><label>X <input class="exp-num" inputmode="decimal" data-id="${p.id}" data-k="x" value="${esc(v('x'))}" /></label>` +
          `<label>Y <input class="exp-num" inputmode="decimal" data-id="${p.id}" data-k="y" value="${esc(v('y'))}" /></label>` +
          `<span class="exp-err" data-err="${p.id}"></span></div></div>`;
      }
      html += '</div>';
      html += '<dl class="kv" data-k="summary"></dl>';
      html += `<div class="exp-inputs exp-height"><label>实测手机高度 <input class="exp-num" inputmode="decimal" data-k="heightCm" value="${d.heightCm == null ? '' : d.heightCm}" /> cm</label><span data-k="height"></span></div>`;
      html += '<p class="muted small">手机高度：镜头到桌面的竖直距离。</p>';
      html += '<dl class="kv">' +
        `<dt>内参来源</dt><dd>${esc(SOURCE_LABELS[ctx.intrinsics.source] ?? ctx.intrinsics.source)}</dd>` +
        `<dt>俯角</dt><dd>${fmt(ctx.pose.pitchDeg, 1)}°</dd>` +
        `<dt>当前采用</dt><dd>${ctx.method === 2 ? '方法 2（视差修正）' : '方法 1（不修正）'}</dd>` +
        `<dt>各步耗时</dt><dd>${ctx.timing ? `共 ${fmt(ctx.timing.total / 1000, 2)} s` : '<span class="muted">没有（只记一键流程的耗时）</span>'}</dd></dl>`;
      html += '<div class="sec-actions wrap"><button type="button" class="btn btn-small btn-primary" data-act="record">记录本次实验</button>' +
        '<button type="button" class="btn btn-small" data-act="clear-draft">清空本张的输入</button></div>';
    }
    html += `<div class="exp-saved">${recordsHtml()}</div>`;
    body.innerHTML = html;
    if (ctx?.parts && ctx.pose) updateComputed(body, ctx);
    bind(body, ctx);
  }

  function bind(body, ctx) {
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.classList?.contains('exp-num') || !ctx?.parts) return;
      const d = draftOf(ctx.image);
      if (t.dataset.k === 'heightCm') {
        d.heightCm = parseNum(t.value);
      } else {
        setMeasured(d, ctx.parts, Number(t.dataset.id), { [t.dataset.k]: parseNum(t.value) });
      }
      save();
      updateComputed(body, ctx);
    });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (b.dataset.del) {
        store.records = store.records.filter((r) => r.id !== b.dataset.del);
        save();
        render();
      } else if (act === 'fill-truth' || act === 'clear-draft' || act === 'record') {
        // 按当前状态操作（这一分区渲染之后可能切换过方法、重新检测过）
        const cur = getContext();
        if (!cur?.parts || !cur.pose || cur.image.bitmap !== ctx?.image.bitmap) {
          render();
          return;
        }
        if (act === 'fill-truth') fillTruth(cur);
        else if (act === 'record') record(cur);
        else {
          delete store.drafts[photoKey(cur.image)];
          save();
          render();
        }
      } else if (act === 'csv-exp' || act === 'csv-parts') {
        const t = stamp().replace(/[-: ]/g, '').slice(0, 12);
        if (act === 'csv-exp') download(experimentsCsv(store.records), `实验记录_每次实验_${t}.csv`);
        else download(partsCsv(store.records), `实验记录_每个零件_${t}.csv`);
      } else if (act === 'clear-all') {
        if (!window.confirm(`清空全部 ${store.records.length} 条实验记录？清空前可以先导出 CSV。`)) return;
        store.records = [];
        save();
        render();
      }
    });
  }

  /** 合成图：按真值填入（每个零件找同类最近的真值零件，15 mm 以内） */
  function fillTruth(ctx) {
    const d = draftOf(ctx.image);
    const used = new Set();
    for (const p of ctx.parts) {
      let best = -1;
      let bestD = 15;
      ctx.truth.parts.forEach((t, j) => {
        if (t.cls !== p.cls || used.has(j)) return;
        const dist = Math.hypot(t.x - p.xParallax, t.y - p.yParallax);
        if (dist < bestD) {
          bestD = dist;
          best = j;
        }
      });
      if (best >= 0) {
        used.add(best);
        const t = ctx.truth.parts[best];
        setMeasured(d, ctx.parts, p.id, { x: +t.x.toFixed(2), y: +t.y.toFixed(2) });
      }
    }
    if (d.heightCm == null) d.heightCm = +(ctx.truth.position[2] / 10).toFixed(1);
    save();
    render();
  }

  function record(ctx) {
    const d = draftOf(ctx.image);
    const r = buildRecord({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      time: stamp(),
      photo: ctx.image,
      intrinsics: ctx.intrinsics,
      pose: ctx.pose,
      parts: ctx.parts,
      measured: measuredByPart(ctx.parts, d.measured),
      measuredHeightMm: d.heightCm == null ? null : d.heightCm * 10,
      method: ctx.method,
      timing: ctx.timing,
    });
    if (!r.summary.n && r.measuredHeightMm == null && !window.confirm('还没有填任何实测值，仍然记录吗？')) return;
    store.records.push(r);
    save();
    render();
    message(`已记录第 ${store.records.length} 次实验：${r.photo}（${r.summary.n} 个零件有实测坐标）`, 'ok');
  }

  /** 渲染出错（例如本地存的数据结构不对）时不影响页面其他部分 */
  function safeRender() {
    try {
      render();
    } catch (err) {
      console.error(err);
      panel.setCustom('experiment', '实验', { last: true }).innerHTML = `<p class="note error">实验分区出错：${esc(err.message)}</p>`;
    }
  }

  safeRender();
  return { render: safeRender };
}
