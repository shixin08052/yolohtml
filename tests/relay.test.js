import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import http from 'node:http';
import { createRelayServer } from '../server/relay-server.mjs';
import { normalizeRelayUrl, isMixedContentBlocked, resolveDefaultRelayKey, DEFAULT_RELAY_URL } from '../src/ui/phoneStream.js';
import { readExif } from '../src/vision/image.js';

let activeServer = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

function openWs(url, session) {
  return new Promise((resolveWs, rejectWs) => {
    const ws = session ? new WebSocket(url, ['sorting-twin.v1', `session.${session}`]) : new WebSocket(url);
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
    expect(isMixedContentBlocked(DEFAULT_RELAY_URL, 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://127.0.0.1:8787', 'https:')).toBe(false);
    expect(isMixedContentBlocked('http://198.51.100.10:8787', 'http:')).toBe(false);
  });

  it('仅对默认 HTTPS 中转域名返回构建期注入的演示访问密钥', () => {
    expect(resolveDefaultRelayKey(DEFAULT_RELAY_URL, 'demo-secret')).toBe('demo-secret');
    expect(resolveDefaultRelayKey('https://forward.davidshi.codes/', 'demo-secret')).toBe('demo-secret');
    expect(resolveDefaultRelayKey('forward.davidshi.codes', ' demo-secret ')).toBe('demo-secret');
    expect(resolveDefaultRelayKey('http://forward.davidshi.codes', 'demo-secret')).toBe('');
    expect(resolveDefaultRelayKey('https://other.example.com', 'demo-secret')).toBe('');
    expect(resolveDefaultRelayKey('http://127.0.0.1:8787', 'demo-secret')).toBe('');
    expect(resolveDefaultRelayKey(DEFAULT_RELAY_URL, '')).toBe('');
    expect(resolveDefaultRelayKey(DEFAULT_RELAY_URL)).toBe('');
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
    expect(stPhone.previewCodecs).toEqual([]);

    pcWs.send(JSON.stringify({ type: 'preview_codecs', codecs: ['h264', 'vp8', 'unknown'] }));
    const capable = await phoneWs.nextMsg((m) => m.type === 'room_state' && m.previewCodecs?.length);
    expect(capable.previewCodecs).toEqual(['h264', 'vp8']);
    const keyframeRequest = phoneWs.nextMsg((m) => m.type === 'preview_keyframe');
    pcWs.send(JSON.stringify({ type: 'preview_keyframe' }));
    await keyframeRequest;
    const legacyPc = await openWs(`${wsBase}/ws?room=${room}&role=pc&device=legacy`);
    const compatibility = await phoneWs.nextMsg((m) => m.type === 'room_state' && m.pcCount === 2);
    expect(compatibility.previewCodecs).toEqual([]);
    legacyPc.close();
    await pcWs.nextMsg((m) => m.type === 'room_state' && m.pcCount === 1);

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

  it('只允许电脑密钥创建房间，扫码邀请只能兑换一次，HTTP 和 WebSocket 按角色授权', async () => {
    const key = 'test-desktop-access-key';
    activeServer = createRelayServer({ port: 0, host: '127.0.0.1', accessKey: key, token: 'legacy-token' });
    const { port } = await activeServer.listen();
    const request = (path, method = 'GET', credential = '', body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
      body,
    });
    const create = () => request('/api/rooms', 'POST', key).then(response => response.json());
    const roomWs = (room, role, session) =>
      openWs(`ws://127.0.0.1:${port}/ws?room=${room}&role=${role}`, session);

    expect((await request('/api/health').then(response => response.json())).authMode).toBe('pairing');
    expect((await request('/api/rooms?token=legacy-token', 'POST')).status).toBe(401);
    const { room, pcSession, invite } = await create();
    const otherRoom = await create();
    const path = `/api/rooms/${room}`;
    expect((await request(path, 'GET', key)).status).toBe(401);
    expect((await request(path, 'GET', otherRoom.pcSession)).status).toBe(401);
    expect((await request(`/api/rooms/${otherRoom.room}/pair`, 'POST', invite)).status).toBe(401);
    await expect(roomWs(room, 'pc')).rejects.toBeDefined();
    await expect(roomWs(room, 'phone', pcSession)).rejects.toBeDefined();

    const pc = await roomWs(room, 'pc', pcSession);
    expect(pc.protocol).toBe('sorting-twin.v1');
    const exchanges = await Promise.all([request(`${path}/pair`, 'POST', invite), request(`${path}/pair`, 'POST', invite)]);
    expect(exchanges.map(response => response.status).sort()).toEqual([201, 401]);
    const { phoneSession } = await exchanges.find(response => response.ok).json();
    expect((await request(path, 'GET', phoneSession)).status).toBe(401);
    const phone = await roomWs(room, 'phone', phoneSession);
    const state = await phone.nextMsg(message => message.type === 'room_state');
    expect(state.pcCount).toBe(1);
    expect(state).not.toHaveProperty('photos');

    const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 255, 217]);
    expect((await request(`${path}/photo`, 'POST', pcSession, jpeg)).status).toBe(401);
    const uploaded = await request(`${path}/photo`, 'POST', phoneSession, jpeg);
    expect(uploaded.status).toBe(200);
    const { url } = await uploaded.json();
    expect((await request(url, 'GET', phoneSession)).status).toBe(401);
    const download = await request(url, 'GET', pcSession);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(jpeg);

    const phoneClosed = new Promise(resolve => phone.addEventListener('close', resolve, { once: true }));
    const rotated = await request(`${path}/invite`, 'POST', pcSession);
    expect(rotated.status).toBe(201);
    expect((await phoneClosed).code).toBe(4001);
    expect((await request(`${path}/photo`, 'POST', phoneSession, jpeg)).status).toBe(401);
    await expect(roomWs(room, 'phone', phoneSession)).rejects.toBeDefined();
    const rotatedInvite = await rotated.json();
    const nextPhone = await request(`${path}/pair`, 'POST', rotatedInvite.invite).then(response => response.json());
    const reconnected = await roomWs(room, 'phone', nextPhone.phoneSession);
    expect((await reconnected.nextMsg(message => message.type === 'room_state')).pcCount).toBe(1);
    expect((await request(path, 'DELETE', nextPhone.phoneSession)).status).toBe(401);
    expect((await request(path, 'DELETE', pcSession)).status).toBe(200);
    expect((await request(url, 'GET', pcSession)).status).toBe(401);
    expect((await request(`${path}/photo`, 'POST', nextPhone.phoneSession, jpeg)).status).toBe(401);
  });

  it('拒绝已过期的扫码邀请', async () => {
    const key = 'test-desktop-access-key';
    activeServer = createRelayServer({ port: 0, host: '127.0.0.1', accessKey: key, inviteTtlMs: 0 });
    const { port } = await activeServer.listen();
    const base = `http://127.0.0.1:${port}/api/rooms`;
    const created = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
    const { room, invite } = await created.json();
    const paired = await fetch(`${base}/${room}/pair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${invite}` },
    });
    expect(paired.status).toBe(401);
  });

  it('支持 ACK 端到端流控：JPEG 单槽覆盖、视频按 GOP 丢包请求关键帧、隐藏预览暂停与大帧分片重组', async () => {
    activeServer = createRelayServer({ port: 0, host: '127.0.0.1' });
    const { port } = await activeServer.listen();
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    const { room } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
    const pcWs = await openWs(`${wsBase}/ws?room=${room}&role=pc`);
    await pcWs.nextMsg((m) => m.type === 'room_state');
    const phoneWs = await openWs(`${wsBase}/ws?room=${room}&role=phone&device=iPhone`);
    await phoneWs.nextMsg((m) => m.type === 'room_state' && m.pcCount === 1);

    const makeVideoPacket = (seq, keyframe, codecId = 1, extra = 8) => {
      const buf = new Uint8Array(10 + extra);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x53545031);
      dv.setUint32(4, seq);
      dv.setUint8(8, codecId);
      dv.setUint8(9, keyframe ? 1 : 0);
      for (let i = 0; i < extra; i++) buf[10 + i] = (seq + i) & 0xff;
      return buf;
    };

    // 1. 启用 ACK 流控：JPEG 模式超过 2 帧在途时单槽覆盖，收到 ACK 后直接吐出最新帧
    pcWs.send(JSON.stringify({ type: 'preview_codecs', codecs: ['h264'], ack: true }));
    await phoneWs.nextMsg((m) => m.type === 'room_state' && m.previewCodecs?.includes('h264'));

    const mkJpeg = (tag) => Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, tag, 0xff, 0xd9]);
    const congestedPromise = phoneWs.nextMsg((m) => m.type === 'preview_feedback' && m.congested === true);
    phoneWs.send(mkJpeg(1));
    phoneWs.send(mkJpeg(2));
    phoneWs.send(mkJpeg(3));
    phoneWs.send(mkJpeg(4));

    const j1 = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    const j2 = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    expect(j1[4]).toBe(1);
    expect(j2[4]).toBe(2);
    await congestedPromise;

    pcWs.send(JSON.stringify({ type: 'preview_ack', count: 2, queue: 0 }));
    const jLatest = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    expect(jLatest[4]).toBe(4);
    pcWs.send(JSON.stringify({ type: 'preview_ack', count: 3, queue: 0 }));
    await phoneWs.nextMsg((m) => m.type === 'preview_feedback' && m.congested === false);

    // 2. 视频流在途窗口满 10 帧触发 GOP 感知丢包：丢弃残余 P 帧并向手机请求关键帧，收到新关键帧后恢复
    phoneWs.send(makeVideoPacket(1, true));
    for (let s = 2; s <= 10; s++) phoneWs.send(makeVideoPacket(s, false));
    // 第 11 帧（P 帧）超窗口被丢弃并触发等待关键帧
    phoneWs.send(makeVideoPacket(11, false));

    const gotSeqs = [];
    for (let i = 0; i < 10; i++) {
      const pkt = await pcWs.nextMsg((m) => m instanceof Uint8Array);
      gotSeqs.push(new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength).getUint32(4));
    }
    expect(gotSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await phoneWs.nextMsg((m) => m.type === 'preview_keyframe');
    await phoneWs.nextMsg((m) => m.type === 'preview_feedback' && m.severe === true);

    // 电脑确认收到这 10 帧（累计 13 帧）
    pcWs.send(JSON.stringify({ type: 'preview_ack', count: 13, queue: 0 }));
    await phoneWs.nextMsg((m) => m.type === 'preview_feedback' && m.inFlight === 0);

    // 处于 awaitingKeyframe 时，后续 P 帧（12）必须被丢弃，直到关键帧（13）到达后才恢复转发（13, 14）
    phoneWs.send(makeVideoPacket(12, false));
    phoneWs.send(makeVideoPacket(13, true));
    phoneWs.send(makeVideoPacket(14, false));

    const p13 = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    const p14 = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    expect(new DataView(p13.buffer, p13.byteOffset, p13.byteLength).getUint32(4)).toBe(13);
    expect(new DataView(p14.buffer, p14.byteOffset, p14.byteLength).getUint32(4)).toBe(14);
    pcWs.send(JSON.stringify({ type: 'preview_ack', count: 15, queue: 0 }));

    // 3. 电脑隐藏预览面板时暂停转发，恢复可见时自动请求关键帧并跳过孤立 P 帧
    pcWs.send(JSON.stringify({ type: 'preview_visible', visible: false }));
    await phoneWs.nextMsg((m) => m.type === 'room_state' && m.activeReceivers === 0);
    phoneWs.send(makeVideoPacket(15, true));

    pcWs.send(JSON.stringify({ type: 'preview_visible', visible: true }));
    await phoneWs.nextMsg((m) => m.type === 'room_state' && m.activeReceivers === 1);
    await phoneWs.nextMsg((m) => m.type === 'preview_keyframe');

    phoneWs.send(makeVideoPacket(16, false));
    // 4. 大尺寸非 4 字节对齐二进制关键帧（测试 ws.mjs 多分片拉取与 32 位整字解掩码边界）
    const bigKeyframe = makeVideoPacket(17, true, 1, 40003);
    phoneWs.send(bigKeyframe);
    const gotBig = await pcWs.nextMsg((m) => m instanceof Uint8Array);
    expect(gotBig.length).toBe(bigKeyframe.length);
    expect(Buffer.from(gotBig).equals(Buffer.from(bigKeyframe))).toBe(true);

    pcWs.close();
    phoneWs.close();
  });
});
