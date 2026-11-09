import { afterEach, expect, it, vi } from 'vitest';
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal(),
  WebGLRenderer: class { constructor() { throw new Error('WebGL unavailable'); } },
}));
import { createWorld } from '../src/scene/world.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('WebGL 创建失败时返回可用的几何容器，显示提示且不启动渲染', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const createElement = vi.fn(() => ({ setAttribute: vi.fn() }));
  vi.stubGlobal('document', { createElement });
  const container = { appendChild: vi.fn() };
  const world = createWorld(container);
  expect(world.available).toBe(false);
  expect(container.appendChild.mock.calls[0][0].textContent).toContain('照片上传、识别');
  expect(world.scene.isScene).toBe(true);
  expect(world.renderer.domElement).toBeDefined();
  expect(() => { world.resize(); world.render(); world.setFrame(null); }).not.toThrow();
  expect(world.pickPlane(10, 10)).toBeNull();
});
