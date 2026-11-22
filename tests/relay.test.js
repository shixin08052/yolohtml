import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import http from 'node:http';
import { createRelayServer } from '../server/relay-server.mjs';
import { normalizeRelayUrl, isMixedContentBlocked } from '../src/ui/phoneStream.js';
import { readExif } from '../src/vision/image.js';

let activeServer = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

function openWs(url) {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const queue = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      const item = typeof ev.data === 'string' ? JSON.parse(ev.data) : new Uint8Array(ev.data);
      if (waiters.length) waiters.shift()(item);
      else queue.push(item);
    });
    ws.nextMsg = (predicate = () => true, timeoutMs = 4000) =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('WebSocket message timeout')), timeoutMs);
        const check = (msg) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            res(msg);
          } else {
            waiters.push(check);
          }
        };
        while (queue.length) {
          const item = queue.shift();
          if (predicate(item)) {
            clearTimeout(timer);
            return res(item);
          }
        }
        waiters.push(check);
      });
    ws.addEventListener('open', () => resolveWs(ws), { once: true });
    ws.addEventListener('error', (err) => rejectWs(err), { once: true });
  });
}

describe('中转地址规范化与混合内容检查', () => {
  it('自动补齐协议并去掉末尾斜杠', () => {
    expect(normalizeRelayUrl('198.51.100.10:8787/')).toBe('http://198.51.100.10:8787');
    expect(normalizeRelayUrl('http://198.51.100.10:8787///')).toBe('http://198.51.100.10:8787');
    expect(normalizeRelayUrl('cam.example.com')).toBe('https://cam.example.com');
    expect(normalizeRelayUrl('localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeRelayUrl('')).toBe('');
  });

  it('正确识别 HTTPS 页面连接公网 HTTP 中转时的混合内容拦截', () => {
    expect(isMixedContentBlocked('http://198.51.100.10:8787', 'https:')).toBe(true);
    expect(isMixedContentBlocked('https://cam.example.com', 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://127.0.0.1:8787', 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://198.51.100.10:8787', 'http:')).toBe(false);
  });
});

describe('手机照片串流中转服务（HTTP + WebSocket 全链路）', () => {
  it('完成房间配对、原图直传（字节与 EXIF 完整保留）、实时取景二进制转发与双向状态回传', async () => {
    activeServer = createRelayServer({ port: 0, host: '127.0.0.1' });
    const { port } = await activeServer.listen();
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    // 1. 健康检查与独立手机拍摄页
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.service).toBe('sorting-twin-relay');

    const mobileResp = await fetch(`${base}/m/TEST99`);
    expect(mobileResp.status).toBe(200);
    expect(await mobileResp.text()).toContain('手机串流端');

    // 2. 创建房间并分别以 pc / phone 身份连入 WebSocket
    const created = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
    expect(created.ok).toBe(true);
    expect(created.room).toMatch(/^[A-Z2-9]{6}$/);
    const room = created.room;

    const pcWs = await openWs(`${wsBase}/ws?room=${room}&role=pc`);
    const st1 = await pcWs.nextMsg((m) => m.type === 'room_state');
    expect(st1.pcCount).toBe(1);
    expect(st1.phoneCount).toBe(0);

    const phoneWs = await openWs(`${wsBase}/ws?room=${room}&role=phone&device=iPhone`);
    const stPc = await pcWs.nextMsg((m) => m.type === 'room_state' && m.phoneCount === 1);
    expect(stPc.phones[0].device).toBe('iPhone');
    const stPhone = await phoneWs.nextMsg((m) => m.type === 'room_state' && m.pcCount === 1);
    expect(stPhone.pcCount).toBe(1);

    // 3. 手机上传真实示例 JPEG 原图，验证电脑端收到通知、字节一致且 EXIF 完整保留
    const samplePath = resolve(import.meta.dirname, '..', 'public', 'samples', 'real', 'IMG_9899.jpg');
    const jpegBytes = await readFile(samplePath);
    const origExif = await readExif(jpegBytes);

    const photoNoticePromise = pcWs.nextMsg((m) => m.type === 'photo');
    const upResp = await fetch(`${base}/api/rooms/${room}/photo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-File-Name': encodeURIComponent('IMG_9899.jpg'),
        'X-Capture-Mode': 'upload',
      },
      body: jpegBytes,
    });
    expect(upResp.status).toBe(200);
    const upData = await upResp.json();
    expect(upData.deliveredTo).toBe(1);

    const notice = await photoNoticePromise;
    expect(notice.name).toBe('IMG_9899.jpg');
    expect(notice.size).toBe(jpegBytes.length);

    const dlResp = await fetch(`${base}${notice.url}`);
    expect(dlResp.status).toBe(200);
    expect(dlResp.headers.get('content-type')).toBe('image/jpeg');
    const dlBuf = Buffer.from(await dlResp.arrayBuffer());
    expect(dlBuf.equals(jpegBytes)).toBe(true);
    expect(await readExif(dlBuf)).toEqual(origExif);

    // 4. 验证 multipart/form-data 上传兼容性（curl / iOS 快捷指令）
    const boundary = '----SortingTwinTestBoundary';
    const mpHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shortcut.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    const mpTail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const miniJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
    const mpNoticePromise = pcWs.nextMsg((m) => m.type === 'photo' && m.name === 'shortcut.jpg');
    const mpResp = await fetch(`${base}/api/rooms/${room}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([mpHeader, miniJpeg, mpTail]),
    });
    expect(mpResp.status).toBe(200);
    const mpNotice = await mpNoticePromise;
    const mpDl = Buffer.from(await (await fetch(`${base}${mpNotice.url}`)).arrayBuffer());
    expect(mpDl.equals(miniJpeg)).toBe(true);

    // 5. 验证实时取景二进制帧转发（phone -> pc）
    const fakeFrame = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);
    const binPromise = pcWs.nextMsg((m) => m instanceof Uint8Array);
    phoneWs.send(fakeFrame);
    const gotFrame = await binPromise;
    expect(Array.from(gotFrame)).toEqual(Array.from(fakeFrame));

    // 6. 验证电脑远程快门与识别状态回传（pc -> phone）
    const shutterPromise = phoneWs.nextMsg((m) => m.type === 'shutter');
    pcWs.send(JSON.stringify({ type: 'shutter', ts: Date.now() }));
    await shutterPromise;

    const statusPromise = phoneWs.nextMsg((m) => m.type === 'pc_status');
    pcWs.send(JSON.stringify({ type: 'pc_status', stage: 'sceneBuilt', text: '识别完成：共 10 个元件', level: 'ok' }));
    const statusMsg = await statusPromise;
    expect(statusMsg.text).toContain('10 个元件');
    expect(statusMsg.level).toBe('ok');

    // 7. 拒绝非图片格式上传（415）
    const badResp = await fetch(`${base}/api/rooms/${room}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not an image',
    });
    expect(badResp.status).toBe(415);

    pcWs.close();
    phoneWs.close();
  });

  it('启用 token 鉴权、体积限制与静态文件目录穿越防护', async () => {
    const publicDir = resolve(import.meta.dirname, '..', 'public');
    activeServer = createRelayServer({
      port: 0,
      host: '127.0.0.1',
      token: 'secret123',
      maxPhotoBytes: 1024,
      webDir: publicDir,
    });
    const { port } = await activeServer.listen();
    const base = `http://127.0.0.1:${port}`;

    // 无口令被拒绝 401
    const unauth = await fetch(`${base}/api/rooms`, { method: 'POST' });
    expect(unauth.status).toBe(401);

    // 携带正确口令创建成功
    const authResp = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'X-Relay-Token': 'secret123' },
    });
    expect(authResp.status).toBe(201);
    const { room } = await authResp.json();

    // 超过 maxPhotoBytes 拒绝 413
    const big = Buffer.alloc(2048, 0xff);
    const tooBig = await fetch(`${base}/api/rooms/${room}/photo`, {
      method: 'POST',
      headers: { 'X-Relay-Token': 'secret123', 'Content-Type': 'image/jpeg' },
      body: big,
    });
    expect(tooBig.status).toBe(413);

    // 静态文件目录穿越拦截 403
    for (const badPath of ['/../package.json', '/%2e%2e/package.json']) {
      const traversalStatus = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port, path: badPath }, (r) => {
          r.resume();
          res(r.statusCode);
        }).on('error', rej);
      });
      expect(traversalStatus).toBe(403);
    }
  });
});
