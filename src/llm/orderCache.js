// 本机清单结果缓存：24 小时过期，最多 50 条，按最近使用淘汰。
// 持久化内容仅有请求摘要、清单、说明和时间，不写入 API Key 或需求原文。
import { normalizeOrder } from '../robot/order.js';

export const ORDER_CACHE_KEY = 'yolohtml.deepseek.orders.v1';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 50;
/** 模型给的说明最多保留多少个字（界面上只有两三行的位置） */
export const NOTE_MAX = 80;

const browserStorage = () => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

export function createOrderCache({ storage = browserStorage(), now = () => Date.now(), limit = CACHE_MAX_ENTRIES, ttl = CACHE_TTL_MS } = {}) {
  const entries = new Map();
  let revision = 0;
  const valid = (item) => item && Number.isFinite(item.savedAt) && now() >= item.savedAt && now() - item.savedAt < ttl
    && item.order && typeof item.order === 'object' && !Array.isArray(item.order) && typeof item.note === 'string';
  const prune = () => {
    for (const [key, item] of entries) if (!valid(item)) entries.delete(key);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  };
  const persist = () => {
    try { storage?.setItem(ORDER_CACHE_KEY, JSON.stringify([...entries])); } catch { /* 配额不足时仍使用内存缓存 */ }
  };
  try {
    const saved = JSON.parse(storage?.getItem(ORDER_CACHE_KEY) ?? '[]');
    if (Array.isArray(saved)) for (const entry of saved) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && valid(entry[1])) {
        entries.set(entry[0], { order: normalizeOrder(entry[1].order), note: entry[1].note.slice(0, NOTE_MAX), savedAt: entry[1].savedAt });
      }
    }
  } catch { /* 损坏或禁用的存储不影响生成清单 */ }
  prune();
  return {
    get revision() { return revision; },
    get(key) {
      prune();
      const item = entries.get(key);
      if (!item) return null;
      entries.delete(key);
      entries.set(key, item);
      persist();
      return { order: { ...item.order }, note: item.note, savedAt: item.savedAt };
    },
    set(key, result, expectedRevision = revision) {
      if (revision !== expectedRevision) return; // 清空后，不让较早发出的请求重新写回
      entries.delete(key);
      entries.set(key, { order: normalizeOrder(result.order), note: result.note.slice(0, NOTE_MAX), savedAt: now() });
      prune();
      persist();
    },
    clear() {
      revision++;
      entries.clear();
      try { storage?.removeItem(ORDER_CACHE_KEY); } catch { /* 内存已清空 */ }
    },
  };
}

export const orderCache = createOrderCache();
export const clearOrderCache = () => orderCache.clear();

/** 摘要包含端点、模型、强度、完整请求及账户；提示词变化或换 Key 均不会复用旧结果。 */
export async function orderCacheId(url, apiKey, request) {
  if (!globalThis.crypto?.subtle) return null; // 非安全上下文正常调用接口，只跳过本地缓存
  const data = new TextEncoder().encode(JSON.stringify([1, url, apiKey.trim(), request]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
