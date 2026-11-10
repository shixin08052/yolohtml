// 分拣相关的三块小界面：
// - 首页引导（还没有照片时盖在视图上，一键看演示 / 上传照片）
// - 分拣结果卡（分拣完成后盖在 3D 画面上：各类数量、用时、拨开次数、清单缺口、跳过详情）
// - 机械臂指令表（弹窗：按执行顺序列出抓取点、夹爪、关节角——和导出的 CSV / JSON 是同一份数据）
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * 首页引导
 * @param {HTMLElement} root 视图容器（.views）
 * @param {{ onDemo: () => void }} deps
 */
export function createHero(root, { onDemo }) {
  const el = document.createElement('div');
  el.className = 'hero';
  el.innerHTML = `
    <div class="hero-card">
      <h2>拍一张照片，机械臂就知道怎么分拣</h2>
      <p class="hero-sub">识别桌上的电阻和各色 LED，按真实尺寸重建 3D 场景，规划机械臂把它们分进料盒。</p>
      <ol class="hero-steps">
        <li><b>识别</b><span>定位码 + YOLO 找出每个元件</span></li>
        <li><b>定位</b><span>换算成毫米坐标和朝向</span></li>
        <li><b>执行</b><span>规划抓取，输出机械臂指令</span></li>
      </ol>
      <div class="hero-actions">
        <button type="button" class="btn btn-primary" data-hero="demo">一键看演示</button>
        <label class="btn" for="file-input">上传自己的照片</label>
      </div>
      <p class="muted small hero-hint">演示用一张实拍照片（10 个元件），全程在浏览器里运行。</p>
    </div>`;
  root.appendChild(el);
  const btn = el.querySelector('[data-hero="demo"]');
  btn.addEventListener('click', onDemo);
  return {
    setVisible(on) {
      el.hidden = !on;
    },
    /** 示例列表还没读到时先禁用 */
    setReady(on) {
      btn.disabled = !on;
    },
  };
}

const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${s.toFixed(1)} 秒`);

/**
 * 分拣结果卡
 * @param {HTMLElement} root 3D 视图（#view-three）
 * @param {{ onInstructions: () => void, onExport: () => void, onAgain: () => void }} deps
 */
export function createResultCard(root, { onInstructions, onExport, onAgain }) {
  const el = document.createElement('div');
  el.className = 'result-card';
  el.hidden = true;
  el.setAttribute('role', 'status');
  root.appendChild(el);
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') el.hidden = true;
    else if (act === 'ins') onInstructions();
    else if (act === 'export') onExport();
    else if (act === 'again') onAgain();
  });
  return {
    /**
     * @param {{ bins: { label: string, hex: string, n: number }[], picked: number, pushes: number, skipped: { name: string, reason: string }[],
     *           seconds: number, speed: number, short: { label: string, short: number }[], left: number, moved?: number, relocations?: number }} r
     *   left：没在清单里、留在板上的元件数
     */
    show(r) {
      const rows = r.bins.map((b) => `<li><span class="dot" style="--c:${b.hex}"></span>${esc(b.label)}盒<b>${b.n}</b></li>`).join('');
      const facts = [`用时 ${fmtTime(r.seconds)}${r.speed !== 1 ? `（${r.speed}× 速度）` : ''}`];
      if (r.pushes) facts.push(`拨开 ${r.pushes} 次`);
      if (r.relocations) facts.push(`夹起挪位 ${r.relocations} 次`);
      if (r.moved) facts.push(`${r.moved} 个挡路元件已挪开，留在板上`);
      if (r.left) facts.push(`${r.left} 个不在清单里，留在板上`);
      if (r.skipped.length) facts.push(`<span class="bad">跳过 ${r.skipped.length} 个</span>`);
      const short = r.short.length ? `<p class="result-short">清单还缺：${r.short.map((s) => `${esc(s.label)} × ${s.short}`).join('，')}</p>` : '';
      const skipped = r.skipped.length ? `<div class="result-skipped"><p>已跳过</p><ul>${r.skipped.map((p) => `<li><b>${esc(p.name)}</b><span>${esc(p.reason)}</span></li>`).join('')}</ul></div>` : '';
      el.innerHTML = `
        <button type="button" class="icon-btn result-close" data-act="close" aria-label="关闭"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 12 12m0-12L4 16" /></svg></button>
        <p class="result-title">分拣完成</p>
        <p class="result-big"><b>${r.picked}</b> 个元件已入盒</p>
        <ul class="result-bins">${rows}</ul>
        <p class="result-facts">${facts.join(' · ')}</p>
        ${short}
        ${skipped}
        <div class="result-actions">
          <button type="button" class="btn btn-primary btn-small" data-act="ins">查看机械臂指令</button>
          <button type="button" class="btn btn-small" data-act="export">导出指令</button>
          <button type="button" class="btn btn-small" data-act="again">再来一次</button>
        </div>`;
      el.hidden = false;
    },
    hide() {
      el.hidden = true;
    },
  };
}

/** 角度整理到 0–360° 显示 */
const deg360 = (d) => `${(((d % 360) + 360) % 360).toFixed(0)}°`;
const xyz = (p) => (p ? `(${p.map((v) => v.toFixed(1)).join(', ')})` : '—');
const joints = (a) => (a ? a.map((v) => `${v.toFixed(1)}°`).join(' / ') : '—');

/**
 * 机械臂指令表（弹窗）
 * @param {{ onExport: (kind: 'csv'|'json') => void }} deps
 */
export function createInstructionsDialog({ onExport }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'ins-dialog';
  document.body.appendChild(dlg);
  dlg.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close' || e.target === dlg) dlg.close();
    else if (act === 'csv' || act === 'json') onExport(act);
  });
  return {
    /**
     * @param {ReturnType<import('../robot/export.js').sortInstructions>} ins
     * @param {{ photo: string }} meta
     */
    show(ins, { photo }) {
      const rows = ins.steps.map((s) =>
        s.kind === 'push'
          ? `<tr class="push"><td>${s.order}</td><td>拨开</td><td>${esc(s.name)} #${s.number}</td><td>${xyz(s.push.start)} → ${xyz(s.push.end)}</td><td>${deg360(s.push.gripYawDeg)} · 开口 ${s.push.openMm}</td><td>${joints(s.push.startAngles)}</td><td>推开 ${s.push.distMm} mm</td><td>${joints(s.push.endAngles)}</td></tr>`
          : `<tr><td>${s.order}</td><td>${s.kind === 'relocate' ? '挪位' : '抓取'}</td><td>${esc(s.name)} #${s.number}</td><td>${xyz(s.pick.point)}</td><td>${s.pick.gripYawDeg == null ? '—' : deg360(s.pick.gripYawDeg)} · 夹到 ${s.pick.gripWidthMm ?? '—'}</td><td>${joints(s.pick.angles)}</td><td>${esc(s.kind === 'relocate' ? '板上空位' : (s.place.bin?.name ?? ''))} ${xyz(s.place.point)}</td><td>${joints(s.place.angles)}</td></tr>`,
      ).join('');
      const skipped = ins.skipped.length ? `<p class="muted small">已跳过：${ins.skipped.map((k) => `${esc(k.name)} #${k.number}（${esc(k.reason)}）`).join('；')}</p>` : '';
      dlg.innerHTML = `
        <div class="ins-head">
          <div>
            <h3>机械臂指令 · ${ins.steps.length} 步</h3>
            <p class="muted small">照片 ${esc(photo)}。坐标为底板坐标（mm），关节角依次为 底座 / 大臂 / 小臂 / 腕俯仰 / 腕转动，由逆运动学算出并代回正运动学核对。3D 动画播放的就是这份指令；导出后可按同样的顺序发给真实机械臂。</p>
          </div>
          <button type="button" class="icon-btn" data-act="close" aria-label="关闭">×</button>
        </div>
        <div class="ins-scroll">
          <table class="ins-table">
            <thead><tr><th>#</th><th>动作</th><th>元件</th><th>抓取点 X, Y, Z</th><th>夹爪方向 · mm</th><th>抓取关节角</th><th>放置</th><th>放置关节角</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="muted">没有要执行的步骤</td></tr>'}</tbody>
          </table>
        </div>
        ${skipped}
        <div class="ins-actions">
          <button type="button" class="btn btn-small" data-act="csv">导出 CSV</button>
          <button type="button" class="btn btn-small" data-act="json">导出 JSON</button>
          <button type="button" class="btn btn-primary btn-small" data-act="close">关闭</button>
        </div>`;
      if (!dlg.open) dlg.showModal();
    },
  };
}
