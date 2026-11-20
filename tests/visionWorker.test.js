import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/vision/aruco.js', () => ({ detectMarkersInImage: vi.fn(() => ({ markers: ['fallback'] })) }));
vi.mock('../src/vision/colorSeg.js', () => ({ segmentParts: vi.fn(() => ['fallback']) }));

let workers;
let copy;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  workers = [];
  copy = { close: vi.fn() };
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => copy));
  vi.stubGlobal('Worker', class {
    constructor() { workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate = vi.fn();
    reply(result) { this.onmessage({ data: { id: this.message.id, ok: true, result } }); }
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('Worker 正常回复后清掉计时，不会误伤后续请求', async () => {
  const { segmentPartsOffThread } = await import('../src/vision/visionWorker.js');
  const first = segmentPartsOffThread({}, [], 1);
  workers[0].reply(['worker']);
  await expect(first).resolves.toEqual(['worker']);
  await vi.advanceTimersByTimeAsync(30001);
  expect(workers[0].terminate).not.toHaveBeenCalled();
  const second = segmentPartsOffThread({}, [], 1);
  workers[0].reply(['again']);
  await expect(second).resolves.toEqual(['again']);
});

it('无响应时结束全部等待并回退，以后的请求不再进入损坏的 Worker', async () => {
  const { segmentPartsOffThread, readPixelsOffThread } = await import('../src/vision/visionWorker.js');
  const results = Promise.all([segmentPartsOffThread({}, [], 1), readPixelsOffThread({})]);
  await vi.advanceTimersByTimeAsync(30001);
  await expect(results).resolves.toEqual([['fallback'], null]);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(copy.close).toHaveBeenCalledOnce();
  await expect(segmentPartsOffThread({}, [], 1)).resolves.toEqual(['fallback']);
  expect(workers).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('发送图片失败时释放副本，识别码回退到主线程且不留下超时任务', async () => {
  Worker.prototype.postMessage = () => { throw new Error('无法传送图片'); };
  const { detectMarkersOffThread } = await import('../src/vision/visionWorker.js');
  await expect(detectMarkersOffThread({})).resolves.toEqual({ markers: ['fallback'] });
  expect(copy.close).toHaveBeenCalledOnce();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('Worker 的消息无法反序列化时立即回退', async () => {
  const { segmentPartsOffThread } = await import('../src/vision/visionWorker.js');
  const result = segmentPartsOffThread({}, [], 1);
  workers[0].onmessageerror();
  await expect(result).resolves.toEqual(['fallback']);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('复制图片期间 Worker 已损坏时，不重新创建 Worker，并释放迟到的副本', async () => {
  let finish;
  createImageBitmap.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { segmentPartsOffThread, readPixelsOffThread } = await import('../src/vision/visionWorker.js');
  const reading = readPixelsOffThread({});
  const segmenting = segmentPartsOffThread({}, [], 1);
  workers[0].onmessageerror();
  finish(copy);
  await expect(Promise.all([reading, segmenting])).resolves.toEqual([null, ['fallback']]);
  expect(workers).toHaveLength(1);
  expect(copy.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
