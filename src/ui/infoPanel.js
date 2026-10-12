// 右侧信息面板：若干分区（键值表或自定义内容）+ 消息区。

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {HTMLElement} el
 */
export function createInfoPanel(el) {
  el.innerHTML = '';
  /** @type {Map<string, HTMLElement>} */
  const sections = new Map();

  const msgSection = document.createElement('section');
  msgSection.className = 'panel-section';
  msgSection.innerHTML = '<h3>消息</h3><div class="msgs"></div>';
  const msgBox = msgSection.querySelector('.msgs');
  el.appendChild(msgSection);

  function getSection(key, title) {
    let sec = sections.get(key);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'panel-section';
      sec.dataset.key = key;
      el.insertBefore(sec, msgSection);
      sections.set(key, sec);
    }
    sec.innerHTML = `<h3>${esc(title)}</h3><div class="body"></div>`;
    return sec.querySelector('.body');
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
     * @returns {HTMLElement}
     */
    setCustom(key, title) {
      return getSection(key, title);
    },

    /** 删除分区 */
    remove(key) {
      sections.get(key)?.remove();
      sections.delete(key);
    },

    /**
     * 追加一条消息
     * @param {string} text
     * @param {'info'|'ok'|'warn'|'error'} [level='info']
     */
    message(text, level = 'info') {
      const p = document.createElement('p');
      p.className = `msg ${level}`;
      p.textContent = text;
      msgBox.appendChild(p);
      while (msgBox.childElementCount > 50) msgBox.firstElementChild.remove();
    },

    clearMessages() {
      msgBox.innerHTML = '';
    },
  };
}
