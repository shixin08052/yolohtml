// 读取 CSS 主题变量，并在系统浅色 / 深色切换时通知。

/** 读取 :root 上的 CSS 变量 */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 系统主题变化时调用 fn */
export function onThemeChange(fn) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fn);
}
