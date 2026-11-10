// 步骤条：根据 state 显示每一步的 待做 / 进行中 / 完成 / 失败。
import { STEPS, stageIndex } from '../state.js';

/**
 * @param {HTMLOListElement} el
 * @param {import('../state.js').Store} store
 */
export function createStepper(el, store) {
  el.innerHTML = '';
  const items = STEPS.map((s, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.key = s.key;
    li.innerHTML = `<span class="dot">${i + 1}</span><span class="label">${s.label}</span>`;
    el.appendChild(li);
    return li;
  });

  function render() {
    const { stage, error } = store.state;
    const cur = stageIndex(stage);
    let activeSet = false;
    STEPS.forEach((s, i) => {
      const li = items[i];
      li.classList.remove('done', 'active', 'error');
      if (error && error.step === s.key) {
        li.classList.add('error');
        li.title = error.reason;
        activeSet = true;
        return;
      }
      li.title = '';
      if (stageIndex(s.stage) <= cur) {
        li.classList.add('done');
      } else if (!activeSet) {
        li.classList.add('active');
        activeSet = true;
      }
    });
  }

  store.on('change', render);
  render();
  return { render };
}
