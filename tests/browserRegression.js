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
async function mount(noWebGL, missingMock = false) {
  localStorage.setItem('yolohtml.demo', '0');
  const html = await (await fetch('../index.html')).text();
  const frame = document.createElement('iframe');
  frame.title = noWebGL ? '无 WebGL 场景' : '正常演示场景';
  const patch = `<script>
    window.__regressionErrors=[]; window.__regressionRequests=[];
    addEventListener('error',e=>window.__regressionErrors.push(e.message));
    const fetchOriginal=window.fetch;
    window.fetch=(url,...args)=>{
      window.__regressionRequests.push(String(url));
      if(${missingMock} && String(url).includes('real/IMG_9899.detections.json')) return Promise.resolve(new Response('',{status:404}));
      return fetchOriginal(url,...args);
    };
    ${noWebGL ? `const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return /webgl/i.test(kind)?null:original.call(this,kind,...args)};` : ''}
  <\/script>`;
  frame.srcdoc = html.replace('<head>', `<head><base href="${new URL('../', location.href)}">${patch}`);
  fixture.replaceChildren(frame);
  await until(() => frame.contentDocument?.querySelector('.msgs')?.textContent.includes('页面已就绪'));
  return { frame, doc: frame.contentDocument, win: frame.contentWindow };
}
async function selectSample(ctx, label, expected, source = '合成图真值框') {
  const select = ctx.doc.querySelector('#sample-select');
  await until(() => [...select.options].some((o) => o.textContent.includes(label)));
  select.value = [...select.options].find((o) => o.textContent.includes(label)).value;
  select.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await until(() => ctx.doc.querySelector('#info-panel [data-key="image"]')?.textContent.includes(expected));
  if (source) await until(() => ctx.doc.querySelector('.detection-source')?.textContent.includes(source));
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
    assert(!doc.querySelector('#dock-phase').textContent.includes('等待开始'), '开始后仍显示等待开始');
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
    doc.querySelector('#btn-demo').click();
    await until(() => doc.querySelector('#view-confirm').classList.contains('active'));
    assert(doc.querySelector('.confirm-canvas').width > 0, '无 WebGL 时正视图为空');
    assert(doc.querySelector('[data-act="ok"]').textContent.includes('查看照片'), '降级确认仍承诺启动 3D');
    doc.querySelector('[data-act="ok"]').click();
    assert(doc.querySelector('#view-debug').classList.contains('active'), '降级确认后未回到照片');
    assert(win.__regressionErrors.length === 0, win.__regressionErrors.join('; '));
  });
  await runCase('mock 失败后真正切换到 WASM，清除旧错误并可取消', async () => {
    const ctx = await mount(false, true);
    const { doc, win } = ctx;
    await selectSample(ctx, '45°', 'synth_45.png');
    const mode = doc.querySelector('#det-mode');
    mode.value = 'mock';
    mode.dispatchEvent(new win.Event('change', { bubbles: true }));
    await selectSample(ctx, 'IMG_9899', 'real/IMG_9899.jpg', null);
    await until(() => doc.querySelector('[data-recover="wasm"]'));
    doc.querySelector('[data-recover="wasm"]').click();
    assert(doc.querySelector('#det-mode').value === 'onnx', '仍在读取 mock 文件');
    assert(doc.querySelector('#det-prefer').value === 'wasm', '没有切换 WASM');
    assert(!doc.querySelector('[data-recover]'), '重试时仍显示上次的失败入口');
    assert(!doc.querySelector('#model-progress').hidden, '重试没有显示准备阶段');
    doc.querySelector('#cancel-detection').click();
    await until(() => doc.querySelector('[data-recover="retry"]'));
    assert(doc.querySelector('#model-progress').hidden, '取消后仍然忙碌');
    assert(doc.querySelector('#info-panel [data-key="status"]').textContent.includes('识别已取消'), '取消信息不正确');
    assert(win.__regressionErrors.length === 0, win.__regressionErrors.join('; '));
  });
  await runCase('模型识别后改框及导入文件，不残留旧模型统计', async () => {
    const ctx = await mount(false);
    const { doc, win } = ctx;
    await selectSample(ctx, 'IMG_9899', 'real/IMG_9899.jpg', null);
    await until(() => doc.querySelector('#info-panel [data-key="detect"]')?.textContent.includes('推理后端'), 120000);
    doc.querySelector('#btn-det-edit').click();
    doc.querySelector('#box-clear').click();
    assert(doc.querySelector('.detection-source').textContent.includes('手动'), '手动结果来源不正确');
    assert(!doc.querySelector('#info-panel [data-key="detect"]').textContent.includes('推理后端'), '手动结果残留模型统计');
    doc.querySelector('#box-done').click();
    doc.querySelector('#btn-det-rerun').click();
    assert(doc.querySelector('#dock-start').disabled, '重新识别时仍允许启动旧场景');
    await until(() => doc.querySelector('#info-panel [data-key="detect"]')?.textContent.includes('推理后端'), 120000);
    const json = await (await fetch('../samples/real/IMG_9899.detections.json')).text();
    const transfer = new win.DataTransfer();
    transfer.items.add(new win.File([json], 'detections.json', { type: 'application/json' }));
    const input = doc.querySelector('#det-file');
    input.files = transfer.files;
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await until(() => doc.querySelector('.detection-source').textContent.includes('载入的检测文件'));
    assert(!doc.querySelector('#info-panel [data-key="detect"]').textContent.includes('推理后端'), '导入结果残留模型统计');
    assert(win.__regressionErrors.length === 0, win.__regressionErrors.join('; '));
  });
  if (savedMode == null) localStorage.removeItem('yolohtml.demo');
  else localStorage.setItem('yolohtml.demo', savedMode);
  button.disabled = false;
});
