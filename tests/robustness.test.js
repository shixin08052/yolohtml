import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateImageFile } from '../src/vision/image.js';
import { captureWarnings, defaultSource } from '../src/vision/intrinsics.js';
import { FIXED_INTRINSICS } from '../src/config.js';
import { createOnnxDetector, parseDetections, readDetectionsFile } from '../src/vision/detector.js';
import { fetchResource } from '../src/vision/request.js';
import { flowNodes, flowStatuses, flowSvg, flowSvgStandalone } from '../src/ui/flowchart.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('指定设备与上传约束', () => {
  const image = { width: 4032, height: 3024, exif: { model: 'iPhone 13 Pro', focal35: 26 } };
  it('匹配设备及等比缩放不报警，也不改变默认内参', () => {
    expect(captureWarnings(image, FIXED_INTRINSICS)).toEqual([]);
    expect(captureWarnings({ ...image, width: 1512, height: 2016 }, FIXED_INTRINSICS)).toEqual([]);
    expect(defaultSource({ image, calib: FIXED_INTRINSICS })).toBe('calib');
  });
  it('机型、焦距与裁剪条件分别告警；未知条件不冒充匹配', () => {
    const warnings = captureWarnings({ width: 4032, height: 2268, exif: { model: 'iPhone 16 Pro', focal35: 77 } }, FIXED_INTRINSICS);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/77 mm/);
    expect(warnings.join(' ')).toMatch(/裁剪/);
    expect(captureWarnings({ ...image, exif: {} }, FIXED_INTRINSICS).join(' ')).toMatch(/无法核验镜头/);
  });
  it('接受实际 JPEG/PNG，拒绝改名 HEIC 与其他格式', async () => {
    await expect(validateImageFile(new Blob([new Uint8Array([255, 216, 255, 224])]))).resolves.toBeUndefined();
    await expect(validateImageFile(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]))).resolves.toBeUndefined();
    const heic = Object.assign(new Blob([new Uint8Array([0, 0, 0, 24]), 'ftypheic']), { name: 'renamed.jpg' });
    await expect(validateImageFile(heic)).rejects.toThrow(/HEIC/);
    await expect(validateImageFile(new Blob(['GIF89a']))).rejects.toThrow(/仅支持 JPEG 或 PNG/);
  });
});

describe('异步检测文件导入', () => {
  const image = { width: 100, height: 100 };
  it('读取期间切图，丢弃旧文件，连过期的非法 JSON 也不解析', async () => {
    let finish;
    let current = true;
    const promise = readDetectionsFile({ size: 10, text: () => new Promise((r) => { finish = r; }) }, image, () => current);
    current = false;
    finish('not json');
    await expect(promise).resolves.toBeNull();
  });
  it('拒绝超大文件、零面积及完全越界的框，裁剪部分越界框', async () => {
    await expect(readDetectionsFile({ size: 3e6 }, image, () => true)).rejects.toThrow(/2 MB/);
    expect(() => parseDetections([{ cls: 0, box: [1, 1, 1, 3] }], image)).toThrow(/有效面积/);
    expect(() => parseDetections([{ cls: 0, box: [101, 1, 110, 3] }], image)).toThrow(/超出/);
    expect(parseDetections([{ cls: 0, box: [-2, 1, 10, 3] }], image)[0].box).toEqual([0, 1, 10, 3]);
  });
});

describe('下载恢复', () => {
  it('超时中止实际请求，随后可重新请求', async () => {
    vi.useFakeTimers();
    let signal;
    vi.stubGlobal('fetch', vi.fn((_url, opts) => new Promise((_resolve, reject) => {
      signal = opts.signal;
      signal.addEventListener('abort', () => reject(signal.reason));
    })));
    const result = fetchResource('/model', { timeoutMs: 100 });
    const failed = expect(result).rejects.toThrow(/下载超时/);
    await vi.advanceTimersByTimeAsync(101);
    await failed;
    expect(signal.aborted).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    await expect(fetchResource('/model')).resolves.toEqual({ ok: true });
  });
  it('取消会传递到响应体读取阶段', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    })));
    const result = fetchResource('/meta', { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('用户取消'));
    await expect(result).rejects.toThrow('用户取消');
  });
  it('按实际收到的字节汇报下载，不虚构百分比', async () => {
    const progress = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    expect(await fetchResource('/model', { type: 'bytes', onProgress: progress })).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress).toHaveBeenCalledWith({ loaded: 3, total: null });
  });
});

describe('Worker 截止时间与重新初始化', () => {
  function setup() {
    vi.useFakeTimers();
    const workers = [];
    vi.stubGlobal('document', { baseURI: 'https://example.test/yolohtml/' });
    vi.stubGlobal('Worker', class {
      constructor() { workers.push(this); }
      postMessage(message) { this.message = message; }
      terminate = vi.fn();
      reply(result) { this.onmessage({ data: { id: this.message.id, result } }); }
    });
    return workers;
  }
  it('初始化不回复时终止旧 Worker，重试会建立新实例', async () => {
    const workers = setup();
    const detector = createOnnxDetector('/model.onnx', { names: ['resistor'], initTimeoutMs: 100 });
    const first = detector.init();
    const failed = expect(first).rejects.toThrow(/准备超时/);
    await vi.advanceTimersByTimeAsync(101);
    await failed;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const second = detector.init();
    expect(workers).toHaveLength(2);
    workers[1].reply({ backend: 'wasm' });
    await expect(second).resolves.toEqual({ backend: 'wasm' });
    detector.terminate();
  });
  it('用户取消后立即重试，旧 Promise 的失败不会终止新 Worker', async () => {
    const workers = setup();
    const detector = createOnnxDetector('/model.onnx', { names: ['led'] });
    const old = detector.init();
    const failed = expect(old).rejects.toThrow(/已关闭/);
    detector.terminate();
    const current = detector.init();
    await failed;
    expect(workers[1].terminate).not.toHaveBeenCalled();
    workers[1].reply({ backend: 'wasm' });
    await expect(current).resolves.toEqual({ backend: 'wasm' });
    detector.terminate();
  });
  it('Worker 构造失败也能重新初始化', async () => {
    const workers = setup();
    const WorkerClass = Worker;
    vi.stubGlobal('Worker', class { constructor() { throw new Error('无法加载 Worker'); } });
    const detector = createOnnxDetector('/model.onnx', { names: ['led'] });
    await expect(detector.init()).rejects.toThrow(/无法加载 Worker/);
    vi.stubGlobal('Worker', WorkerClass);
    const retry = detector.init();
    workers[0].reply({ backend: 'wasm' });
    await retry;
    detector.terminate();
  });
  it('推理不回复时清理会话和请求，后续仍可重试', async () => {
    const workers = setup();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 100 })));
    const detector = createOnnxDetector('/model.onnx', { names: ['led'], detectTimeoutMs: 100 });
    const ready = detector.init();
    workers[0].reply({ backend: 'wasm' });
    await ready;
    const inference = detector.detect({});
    const failed = expect(inference).rejects.toThrow(/推理超时/);
    await vi.advanceTimersByTimeAsync(101);
    await failed;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const retry = detector.init();
    workers[1].reply({ backend: 'wasm' });
    await retry;
    detector.terminate();
  });
  it('复制照片期间取消，不向新会话发送过期推理', async () => {
    const workers = setup();
    let finishCopy;
    const copy = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((resolve) => { finishCopy = resolve; })));
    const detector = createOnnxDetector('/model.onnx', { names: ['led'] });
    const ready = detector.init();
    workers[0].reply({ backend: 'wasm' });
    await ready;
    const inference = detector.detect({});
    const failed = expect(inference).rejects.toMatchObject({ name: 'AbortError', message: '检测已取消' });
    await Promise.resolve();
    detector.terminate();
    finishCopy(copy);
    await failed;
    expect(copy.close).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
  });
});

it('流程图按检测来源显示真值、文件及模型，不修改其他节点', () => {
  const statuses = flowStatuses({ stage: 'sceneBuilt', demo: true });
  const svg = flowSvg(statuses, { detectionSource: 'truth' });
  expect(svg).toContain('读取合成真值框');
  expect(svg).not.toContain('YOLO + 颜色');
  expect(flowSvgStandalone({ detectionSource: 'truth' }).svg).toContain('读取合成真值框');
  expect(flowNodes({ detectionSource: 'file' }).find((n) => n.id === 'detect').label).toBe('导入检测文件');
  expect(flowNodes({ detectionSource: 'onnx' }).find((n) => n.id === 'detect').label).toContain('YOLO');
});
