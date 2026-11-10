import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOrderCache } from '../src/llm/orderCache.js';
import { askOrder, buildRequest, completionURL, DEFAULT_BASE_URL, DEFAULT_MODEL, MAX_OUTPUT_TOKENS, MAX_REQUEST_CHARS, REQUEST_TIMEOUT_MS, THINKING_TIMEOUT_MS, parseOrderReply, systemPrompt, userMessage } from '../src/llm/orderAssist.js';

afterEach(() => { clearOrderCache(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const okReply = (extra = {}) => ({ choices: [{ finish_reason: 'stop', message: { content: '{"r":3,"R":3}' } }], ...extra });
const respond = (data, status = 200) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status })));
const input = { apiKey: 'sk-test', text: '做三个红灯', useCache: false };

describe('DeepSeek 清单接口', () => {
  it('Chat Completions 格式、关闭思考、短键 JSON，只发单轮需求', () => {
    const req = buildRequest({ text: '  做三个红灯  ', have: { 'led-red': 3 } });
    expect(req.model).toBe(DEFAULT_MODEL);
    expect(req.messages).toEqual([{ role: 'system', content: systemPrompt() }, { role: 'user', content: '做三个红灯' }]);
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(req.max_tokens).toBeLessThanOrEqual(256);
    expect(req).not.toHaveProperty('output_config');
    expect(req).not.toHaveProperty('tools');
    expect(buildRequest({ model: 'deepseek-v4-pro', text: 'x' }).model).toBe('deepseek-v4-pro');
    expect(buildRequest({ model: ' ', text: 'x' }).model).toBe(DEFAULT_MODEL);
    expect(userMessage('电'.repeat(MAX_REQUEST_CHARS + 50))).toHaveLength(MAX_REQUEST_CHARS);
  });

  it.each([['none', 'disabled', 256], ['low', 'enabled', 2048], ['high', 'enabled', 4096], ['max', 'enabled', 8192]])('思考强度 %s 正确传入且分配推理预算', (effort, type, budget) => {
    const request = buildRequest({ text: '做三个红灯', reasoningEffort: effort });
    expect(request.thinking).toEqual({ type });
    expect(request.reasoning_effort).toBe(effort);
    expect(request.max_tokens).toBe(budget);
    if (effort !== 'none') expect(request).not.toHaveProperty('temperature');
    expect(buildRequest({ text: 'x', reasoningEffort: 'invalid' }).reasoning_effort).toBe('none');
  });

  it('相同需求命中本地缓存，复用只拷贝结果且没有新增 token', async () => {
    respond(okReply());
    const first = await askOrder({ ...input, useCache: true });
    first.order.resistor = 999;
    const second = await askOrder({ ...input, text: ` ${input.text} `, useCache: true });
    expect(second).toEqual({ order: { resistor: 3, 'led-red': 3 }, note: '', usage: null, cacheHit: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    second.order.resistor = 888;
    expect((await askOrder({ ...input, useCache: true })).order.resistor).toBe(3);
  });

  it('更改模型、思考强度、接口或账户不能误用旧缓存；重新生成与关闭缓存均调用接口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(okReply()))));
    const cached = { ...input, useCache: true };
    await askOrder(cached);
    await askOrder(cached);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const overrides of [{ model: 'deepseek-v4-pro' }, { reasoningEffort: 'high' }, { baseURL: 'https://example.test/v1' }, { apiKey: 'sk-other' }, { refresh: true }, { useCache: false }]) await askOrder({ ...cached, ...overrides });
    expect(fetch).toHaveBeenCalledTimes(7);
    clearOrderCache();
    await askOrder(cached);
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it('强制重新生成后写回新结果，下次复用新数量', async () => {
    let count = 1;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ R: count }) } }] }))));
    const cached = { ...input, useCache: true };
    expect((await askOrder(cached)).order['led-red']).toBe(1);
    count = 2;
    expect((await askOrder({ ...cached, refresh: true })).order['led-red']).toBe(2);
    expect((await askOrder(cached)).order['led-red']).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('失败或被截断的结果不缓存；思考 token 单独计数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"r":3}' } }] }))));
    for (let i = 0; i < 2; i++) await expect(askOrder({ ...input, useCache: true })).rejects.toThrow('截断');
    expect(fetch).toHaveBeenCalledTimes(2);
    respond(okReply({ usage: { prompt_tokens: 200, completion_tokens: 1012, total_tokens: 1212, completion_tokens_details: { reasoning_tokens: 1000 } } }));
    expect((await askOrder({ ...input, useCache: true, reasoningEffort: 'low' })).usage.reasoningTokens).toBe(1000);
  });

  it('短键映射所有种类，0 省略，说明可选；不接受错误键或错误数量', () => {
    expect(parseOrderReply('{"r":3,"R":2,"G":1,"B":4,"Y":5,"C":6,"n":" 每灯一个电阻 "}')).toEqual({
      order: { resistor: 3, 'led-red': 2, 'led-green': 1, 'led-blue': 4, 'led-yellow': 5, 'led-clear': 6 }, note: '每灯一个电阻',
    });
    expect(parseOrderReply('{"r":0}')).toEqual({ order: {}, note: '' });
    for (const data of ['null', '[]', '{"r":-1}', '{"r":1.5}', '{"r":1000}', '{"r":"3"}', '{"r":null}', '{"r":true}', '{"capacitor":1}', '{"n":1}']) expect(() => parseOrderReply(data)).toThrow();
    expect(() => parseOrderReply('好的，需要三个电阻')).toThrow('JSON');
  });

  it('接口地址支持根地址、v1 和完整端点，拒绝无效 URL', () => {
    expect(completionURL()).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
    expect(completionURL(' https://api.deepseek.com/v1/ ')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(completionURL('https://api.deepseek.com/chat/completions/')).toBe('https://api.deepseek.com/chat/completions');
    for (const url of ['api.deepseek.com', 'file:///tmp', 'https://api.deepseek.com?key=xxx', 'https://key@api.deepseek.com']) expect(() => completionURL(url)).toThrow('接口地址');
  });

  it('Bearer 认证、响应 choices 解析和实际 token 使用量', async () => {
    respond(okReply({ usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212, prompt_cache_hit_tokens: 128 } }));
    const res = await askOrder(input);
    expect(res).toEqual({ order: { resistor: 3, 'led-red': 3 }, note: '', cacheHit: false, usage: { promptTokens: 200, completionTokens: 12, totalTokens: 212, cachedTokens: 128, reasoningTokens: 0 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, req] = fetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer sk-test');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).not.toContain('sk-test');
    expect(JSON.parse(req.body)).toEqual(buildRequest(input));
  });

  it('无 key、空需求、已取消时不发请求', async () => {
    respond(okReply());
    await expect(askOrder({ text: 'x' })).rejects.toThrow('API Key');
    await expect(askOrder({ apiKey: 'x', text: ' ' })).rejects.toThrow('需求');
    const c = new AbortController(); c.abort();
    await expect(askOrder({ ...input, signal: c.signal })).rejects.toThrow('已取消');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'Key 无效'], [402, '余额不足'], [404, '模型或接口地址'], [429, '太频繁'], [503, '繁忙']])('HTTP %s 显示错误且不重试', async (status, message) => {
    respond({ error: { message: 'upstream' } }, status);
    await expect(askOrder(input)).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'content_filter', 'insufficient_system_resource', 'aborted', 'tool_calls'])('拒绝不完整的响应 %s', async (reason) => {
    respond({ choices: [{ finish_reason: reason, message: { content: '{"r":3}' } }] });
    await expect(askOrder(input)).rejects.toThrow();
  });

  it('拒绝空白响应和损坏 JSON', async () => {
    respond({ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] });
    await expect(askOrder(input)).rejects.toThrow('完整清单');
    respond({ choices: [{ finish_reason: 'stop', message: { content: '{"r":' } }] });
    await expect(askOrder(input)).rejects.toThrow('JSON');
  });

  it('开启思考允许更长等待，达到思考超时上限后结束', async () => {
    vi.useFakeTimers();
    let requestSignal;
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }));
    const pending = expect(askOrder({ ...input, reasoningEffort: 'high' })).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(THINKING_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
    await pending;
  });

  it('网络错误、用户取消和超时均能结束请求', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(askOrder(input)).rejects.toThrow('连不上接口');
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))));
    const c = new AbortController();
    const cancelled = expect(askOrder({ ...input, signal: c.signal })).rejects.toThrow('已取消');
    c.abort(); await cancelled;
    vi.useFakeTimers();
    const timedOut = expect(askOrder(input)).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await timedOut;
  });
});
