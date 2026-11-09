/** 下载及响应体读取共用一个截止时间；取消会中止底层 fetch。 */
export async function fetchResource(url, { timeoutMs = 120000, signal, onProgress, type = 'json' } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('下载超时，请检查网络后重试。')), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`读取资源失败（${res.status}）`);
    if (type === 'json') return await res.json();
    const total = Number(res.headers.get('content-length')) || null;
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.({ loaded, total });
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason ?? err;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
