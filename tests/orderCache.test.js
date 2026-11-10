import { describe, expect, it } from 'vitest';
import { createOrderCache, CACHE_TTL_MS, CACHE_MAX_ENTRIES, ORDER_CACHE_KEY, orderCacheId } from '../src/llm/orderCache.js';

const storage = () => {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
};
const result = { order: { resistor: 3 }, note: '三颗电阻' };

describe('本机清单结果缓存', () => {
  it('过期结果不复用，刷新页面后仍可读未过期结果', () => {
    let time = 1_000_000;
    const s = storage();
    const first = createOrderCache({ storage: s, now: () => time });
    first.set('a', result);
    const second = createOrderCache({ storage: s, now: () => time });
    expect(second.get('a').order).toEqual(result.order);
    time += CACHE_TTL_MS;
    expect(first.get('a')).toBeNull();
    expect(second.get('a')).toBeNull();
    expect(createOrderCache({ storage: s, now: () => time }).get('a')).toBeNull();
  });

  it('最多缓存 50 条，命中过的条目按最近使用保留', () => {
    const cache = createOrderCache({ storage: storage() });
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) cache.set(String(i), result);
    cache.get('0');
    cache.set('new', result);
    expect(cache.get('0')).not.toBeNull();
    expect(cache.get('1')).toBeNull();
    expect(cache.get('new')).not.toBeNull();
  });

  it('清空同时移除持久化数据，并防止在途旧请求重新写回', () => {
    const s = storage();
    const cache = createOrderCache({ storage: s });
    cache.set('a', result);
    const revision = cache.revision;
    cache.clear();
    cache.set('b', result, revision);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(s.getItem(ORDER_CACHE_KEY)).toBeNull();
  });

  it('数据副本互不影响；存储损坏或不可用时可以正常使用内存', () => {
    const s = storage();
    s.setItem(ORDER_CACHE_KEY, '{broken');
    const cache = createOrderCache({ storage: s });
    cache.set('a', result);
    const item = cache.get('a'); item.order.resistor = 99;
    expect(cache.get('a').order.resistor).toBe(3);
    const unavailable = createOrderCache({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } } });
    unavailable.set('a', result);
    expect(unavailable.get('a').order).toEqual(result.order);
    expect(() => unavailable.clear()).not.toThrow();
  });

  it('缓存摘要不会泄露 Key 和原始需求，提示词变化导致缓存失效', async () => {
    const request = { model: 'deepseek-flash', messages: [{ role: 'system', content: 'v1' }, { role: 'user', content: '要三个电阻' }] };
    const key = await orderCacheId('https://api.deepseek.com/chat/completions', 'sk-secret', request);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('secret');
    expect(key).not.toContain('电阻');
    expect(await orderCacheId('https://api.deepseek.com/chat/completions', 'sk-secret', { ...request, messages: [{ role: 'system', content: 'v2' }] })).not.toBe(key);
  });
});
