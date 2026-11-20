// 读取 CSS 主题变量，并在系统或手动浅色 / 深色切换时通知。
// 支持三种模式：'auto'（跟随系统）、'light'（强制浅色）、'dark'（强制深色），持久化在 localStorage('yolohtml.theme')。

const THEME_KEY = 'yolohtml.theme';
/** @type {Set<Function>} */
const listeners = new Set();

/** 读取 :root 上的 CSS 变量 */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 读取当前保存的主题模式：'auto' | 'light' | 'dark' */
export function getThemeMode() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // 忽略存储异常
  }
  return 'auto';
}

/** 当前实际生效的是否为深色 */
export function isDarkTheme() {
  const mode = document.documentElement.dataset.theme || getThemeMode();
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** 设置主题模式：'auto' | 'light' | 'dark' */
export function setThemeMode(mode) {
  const next = mode === 'light' || mode === 'dark' ? mode : 'auto';
  if (next === 'auto') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = next;
  }
  try {
    if (next === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // 忽略存储异常
  }
  for (const fn of listeners) fn();
}

/** 循环切换主题：跟随系统 → 浅色 → 深色 */
export function cycleThemeMode() {
  const cur = getThemeMode();
  const next = cur === 'auto' ? (isDarkTheme() ? 'light' : 'dark') : cur === 'light' ? 'dark' : 'auto';
  setThemeMode(next);
  return next;
}

/** 初始化主题属性（页面加载时调用） */
export function initTheme() {
  const mode = getThemeMode();
  if (mode !== 'auto') document.documentElement.dataset.theme = mode;
}

/** 系统或手动主题变化时调用 fn */
export function onThemeChange(fn) {
  listeners.add(fn);
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', fn);
  return () => listeners.delete(fn);
}
