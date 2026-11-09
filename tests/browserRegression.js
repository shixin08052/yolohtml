// 在真实浏览器中加载入口，故障注入仅存在于此测试页面。
const results = document.querySelector('#results');
const fixture = document.querySelector('#fixture');
const button = document.querySelector('#run');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function until(predicate, timeout = 30000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待页面状态超时');
}
async function mount(noWebGL) {
  localStorage.setItem('yolohtml.demo', '0');
  const html = await (await fetch('../index.html')).text();
  const frame = document.createElement('iframe');
  frame.title = noWebGL ? '无 WebGL 场景' : '正常演示场景';
  const patch = `<script>
    window.__regressionErrors=[]; window.__regressionRequests=[];
    addEventListener('error',e=>window.__regressionErrors.push(e.message));
    const fetchOriginal=window.fetch;
    window.fetch=(url,...args)=>{window.__regressionRequests.push(String(url));return fetchOriginal(url,...args)};
    ${noWebGL ? `const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return /webgl/i.test(kind)?null:original.call(this,kind,...args)};` : ''}
  <\/script>`;
  frame.srcdoc = html.replace('<head>', `<head><base href="${new URL('../', location.href)}">${patch}`);
  fixture.replaceChildren(frame);
  await until(() => frame.contentDocument?.querySelector('.msgs')?.textContent.includes('页面已就绪'));
  return { frame, doc: frame.contentDocument, win: frame.contentWindow };
}
async function selectSample(ctx, label, expected) {
  const select = ctx.doc.querySelector('#sample-select');
  await until(() => [...select.options].some((o) => o.textContent.includes(label)));
  select.value = [...select.options].find((o) => o.textContent.includes(label)).value;
  select.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await until(() => ctx.doc.querySelector('#info-panel [data-key="image"]')?.textContent.includes(expected));
  await until(() => ctx.doc.querySelector('.detection-source')?.textContent.includes('合成图真值框'));
}
async function upload(ctx, file) {
  const transfer = new ctx.win.DataTransfer();
  transfer.items.add(file);
  const input = ctx.doc.querySelector('#file-input');
  input.files = transfer.files;
  input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
}
async function runCase(name, fn) {
  const row = document.createElement('li');
  row.textContent = `${name}：进行中`;
  results.append(row);
  try {
    await fn();
    row.dataset.result = 'pass';
    row.textContent = `${name}：通过`;
  } catch (err) {
    row.dataset.result = 'fail';
    row.textContent = `${name}：失败 — ${err.message}`;
  }
}
button.addEventListener('click', async () => {
  const savedMode = localStorage.getItem('yolohtml.demo');
  button.disabled = true;
  results.replaceChildren();
  await runCase('合成真值、控制条、确认与上传约束', async () => {
    const ctx = await mount(false);
    const { doc, win } = ctx;
    assert(doc.querySelector('#file-input').accept === 'image/jpeg,image/png,.jpg,.jpeg,.png', '上传格式声明错误');
    await selectSample(ctx, '45°', 'synth_45.png');
    assert(doc.querySelector('.flowchart').textContent.includes('读取合成真值框'), '流程图未标记真值');
    doc.querySelector('#dock-start').click();
    await until(() => !doc.querySelector('#dock-pause').disabled);
    doc.querySelector('#dock-pause').click();
    assert(doc.querySelector('#dock-pause').textContent === '继续', '无法暂停');
    doc.querySelector('#dock-pause').click();
    doc.querySelector('#dock-reset').click();
    assert(doc.querySelector('#dock-phase').textContent === '等待开始', '无法重置');
    if (win.innerWidth <= 900) {
      const r = doc.querySelector('#sort-dock').getBoundingClientRect();
      assert(r.top >= 0 && r.bottom <= win.innerHeight + 1, '控制条超出手机视口');
      assert([...doc.querySelectorAll('details.panel-section')].every((d) => !d.open), '窄屏高级参数没有默认折叠');
    }
    doc.querySelector('#btn-demo').click();
    await selectSample(ctx, '65°', 'synth_65.png');
    await until(() => doc.querySelector('#view-confirm').classList.contains('active'));
    assert(doc.querySelector('.confirm-source').textContent.includes('真值'), '确认页未显示来源');
    assert(doc.querySelector('#sort-dock').hidden, '未确认即暴露分拣控制');
    doc.querySelector('[data-act="ok"]').click();
    assert(!doc.querySelector('#sort-dock').hidden, '确认后控制条未恢复');
    await upload(ctx, new win.File([new Uint8Array([0, 0, 0, 24]), 'ftypheic'], 'renamed.jpg', { type: 'image/jpeg' }));
    await until(() => doc.querySelector('.msgs').textContent.includes('不支持 HEIC/HEIF'));
    const jpeg = await (await fetch('./fixtures/tele_77.jpg')).arrayBuffer();
    await upload(ctx, new win.File([jpeg], 'tele.jpg', { type: 'image/jpeg' }));
    await until(() => doc.querySelector('#capture-notices').textContent.includes('77 mm'));
    assert(!doc.querySelector('#model-progress').offsetHeight, '格式或标定失败后仍显示模型忙碌');
    assert(!win.__regressionRequests.some((url) => /\/models\//.test(url)), '真值演示意外下载模型');
    assert(win.__regressionErrors.length === 0, win.__regressionErrors.join('; '));
  });
  await runCase('WebGL 初始化失败后仍能识别照片', async () => {
    const ctx = await mount(true);
    await selectSample(ctx, '45°', 'synth_45.png');
    const { doc, win } = ctx;
    assert(doc.querySelector('.webgl-notice'), '缺少 WebGL 失败提示');
    assert(doc.querySelector('#sort-dock').hidden, '无 WebGL 时仍允许分拣');
    doc.querySelector('#tab-three').click();
    assert(doc.querySelector('#btn-transition').disabled, '无 WebGL 时转场未禁用');
    assert(doc.querySelector('.detection-source').textContent.includes('真值'), '识别结果不可用');
    assert(win.__regressionErrors.length === 0, win.__regressionErrors.join('; '));
  });
  if (savedMode == null) localStorage.removeItem('yolohtml.demo');
  else localStorage.setItem('yolohtml.demo', savedMode);
  button.disabled = false;
});
