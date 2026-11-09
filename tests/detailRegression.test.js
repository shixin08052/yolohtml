import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSortPlayer } from '../src/scene/sortPlayer.js';
import { loadSample, loadSampleIndex } from '../src/vision/samples.js';
import { detect, MockMissingError } from '../src/vision/detector.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const base = () => vi.stubGlobal('document', { baseURI: 'https://example.test/yolohtml/' });

it('开始和恢复分拣时立即报告当前步骤', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const onProgress = vi.fn();
  const player = createSortPlayer({ arm: { stop: vi.fn() }, partsLayer: {}, requestRender: vi.fn(), onProgress });
  player.load([{ type: 'grip', ms: 1000, task: 0, phase: '移到零件上方' }]);
  onProgress.mockClear();
  player.start();
  expect(onProgress).toHaveBeenLastCalledWith({ task: 0, phase: '移到零件上方', seg: 0, total: 1 });
  player.pause();
  onProgress.mockClear();
  player.resume();
  expect(onProgress).toHaveBeenCalledOnce();
  player.stop();
});

describe('示例资源的异常与取消', () => {
  it('图片失败时立即取消另一个还在等待的真值请求', async () => {
    base();
    let truthSignal;
    vi.stubGlobal('fetch', vi.fn((url, { signal }) => {
      if (String(url).endsWith('.png')) return Promise.resolve(new Response('', { status: 404 }));
      truthSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    }));
    await expect(loadSample({ image: 'missing.png', truth: 'truth.json' })).rejects.toThrow(/404/);
    expect(truthSignal.aborted).toBe(true);
  });
  it('切换照片发生在解码期间时，释放作废的 bitmap', async () => {
    base();
    const controller = new AbortController();
    let finish;
    const bitmap = { width: 100, height: 100, close: vi.fn() };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    const decoding = new Promise((resolve) => { finish = resolve; });
    vi.stubGlobal('createImageBitmap', vi.fn(() => decoding));
    const loading = loadSample({ image: 'photo.jpg' }, { signal: controller.signal });
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce());
    controller.abort(new Error('照片已切换'));
    finish(bitmap);
    await expect(loading).rejects.toThrow('照片已切换');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('损坏的真值文件不会留下已解码的照片资源', async () => {
    base();
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(String(url).endsWith('.json') ? '{invalid' : 'image')));
    vi.stubGlobal('createImageBitmap', vi.fn());
    await expect(loadSample({ image: 'photo.jpg', truth: 'truth.json' })).rejects.toThrow();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('示例列表下载超时会结束请求', async () => {
    base();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const failed = expect(loadSampleIndex()).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30001);
    await failed;
  });
  it('无效示例列表显示可理解的错误', async () => {
    base();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"samples":null}')));
    await expect(loadSampleIndex()).rejects.toThrow(/列表格式无效/);
  });
});

describe('mock 文件的恢复路径', () => {
  it('404 保留缺少检测文件的提示，网络超时不伪装成文件不存在', async () => {
    base();
    const image = { fileName: 'photo.jpg', width: 100, height: 100 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(detect(image)).rejects.toBeInstanceOf(MockMissingError);
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)))));
    const failed = expect(detect(image)).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30001);
    await failed;
  });
});
