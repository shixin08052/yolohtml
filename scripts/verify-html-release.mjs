import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifyHtmlRelease(directory) {
  assert.equal(process.platform, 'win32', 'Windows preview verification requires Windows');
  const root = resolve(directory);
  const info = JSON.parse(await readFile(join(root, 'release-info.json'), 'utf8'));
  const temp = await mkdtemp(join(tmpdir(), 'sorting-twin-check-'));
  const ready = join(temp, 'ready.json');
  let output = '';
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'preview.ps1'), '-NoBrowser', '-Port', '0', '-ReadyFile', ready], { windowsHide: true, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((done) => child.on('close', done));
  try {
    let state;
    for (let attempt = 0; attempt < 160; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Preview exited (${child.exitCode}): ${output}`);
      try { state = JSON.parse((await readFile(ready, 'utf8')).replace(/^\uFEFF/, '')); break; } catch { await pause(100); }
    }
    assert.ok(state?.url, `Preview did not start: ${output}`);
    const health = await fetch(state.url + '__demo_health', { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await health.json(), { app: 'sorting-twin-html', version: info.version });
    let checked = 0;
    const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
    // 校验 HTML、Worker、模型、WASM、示例等所有发布资源的 HTTP 内容。
    const assets = Object.keys(manifest.files).filter((file) => /\.(?:html|js|mjs|css|json|wasm|onnx|png|jpe?g|svg|ico|woff2?)$/i.test(file));
    for (let offset = 0; offset < assets.length; offset += 6) {
      await Promise.all(assets.slice(offset, offset + 6).map(async (file) => {
        const response = await fetch(new URL(file, state.url), { signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200, file);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(digest(bytes), manifest.files[file].sha256, file);
        if (file.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
        if (file.endsWith('.mjs')) assert.match(response.headers.get('content-type'), /javascript/);
        checked++;
      }));
    }
    const home = await fetch(state.url + '?demo');
    assert.equal(home.status, 200);
    const head = await fetch(state.url + 'models/best.onnx', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(Number(head.headers.get('content-length')), manifest.files['models/best.onnx'].bytes);
    assert.equal((await fetch(state.url + 'missing-file.js')).status, 404);
    assert.equal((await fetch(state.url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(state.url + 'preview.ps1')).status, 404);
    // http.request 保留原始 ../ 路径，避免 fetch 在发送前自动正规化它。
    for (const [path, headers, expected] of [
      ['/../package.json', {}, 403],
      ['/%2e%2e/package.json', {}, 403],
      ['/%5c..%5cpackage.json', {}, 403],
      ['/', { Host: 'example.com' }, 403],
    ]) {
      const status = await new Promise((done, reject) => {
        const request = http.get(new URL(state.url), { path, headers, timeout: 5000 }, (response) => { response.resume(); done(response.statusCode); });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('Request timeout')));
      });
      assert.equal(status, expected, path);
    }
    return { version: info.version, resources: checked, checks: 'HTTP assets, binary hashes, MIME, HEAD, offline resources, path isolation' };
  } finally {
    child.kill();
    await exited;
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyHtmlRelease(process.argv[2]), null, 2));
}
