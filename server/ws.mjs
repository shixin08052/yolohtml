// 零依赖 RFC 6455 WebSocket 服务端实现（适用于 Node.js >= 18）
// 支持文本帧、二进制帧（实时取景画面）、分片重组、Ping/Pong 保活与背压检测。
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 构造服务端发往客户端的 WebSocket 帧（服务端发送不掩码） */
export function encodeFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf ?? '');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * 将 HTTP Upgrade 请求升级为 WebSocket 连接
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ maxPayloadBytes?: number }} [opts]
 */
export function acceptWebSocket(req, socket, head, opts = {}) {
  const maxPayloadBytes = opts.maxPayloadBytes ?? 4 * 1024 * 1024;
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(String(key).trim() + WS_GUID).digest('base64');
  socket.setNoDelay(true);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const ws = new EventEmitter();
  let closed = false;
  let rxBuf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];
  let fragBytes = 0;

  const markClosed = (code = 1006, reason = '') => {
    if (closed) return;
    closed = true;
    ws.readyState = 3;
    rxBuf = Buffer.alloc(0);
    fragChunks = [];
    ws.emit('close', code, reason);
  };

  const writeRaw = (buf) => {
    if (closed || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(buf);
      return true;
    } catch {
      return false;
    }
  };

  ws.readyState = 1;
  Object.defineProperty(ws, 'bufferedAmount', {
    get: () => (socket.destroyed ? Infinity : socket.writableLength),
  });

  ws.sendText = (text) => writeRaw(encodeFrame(0x1, Buffer.from(String(text), 'utf8')));
  ws.sendJson = (obj) => ws.sendText(JSON.stringify(obj));
  ws.sendBinary = (buf) => writeRaw(encodeFrame(0x2, buf));
  ws.ping = (payload = '') => writeRaw(encodeFrame(0x9, Buffer.from(payload)));
  ws.pong = (payload = '') => writeRaw(encodeFrame(0xa, payload));
  ws.close = (code = 1000, reason = '') => {
    if (closed) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const body = Buffer.allocUnsafe(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    writeRaw(encodeFrame(0x8, body));
    socket.end();
    markClosed(code, reason);
  };
  ws.terminate = () => {
    socket.destroy();
    markClosed(1006, 'terminated');
  };

  const fail = (code, reason) => {
    ws.close(code, reason);
    socket.destroy();
  };

  const processBuffer = () => {
    while (!closed && rxBuf.length >= 2) {
      const b0 = rxBuf[0];
      const b1 = rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) return fail(1002, 'RSV bits not supported');
      if (payloadLen === 126) {
        if (rxBuf.length < 4) return;
        payloadLen = rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (rxBuf.length < 10) return;
        const bigLen = rxBuf.readBigUInt64BE(2);
        if (bigLen > BigInt(maxPayloadBytes)) return fail(1009, 'Frame too large');
        payloadLen = Number(bigLen);
        offset = 10;
      }
      if (payloadLen > maxPayloadBytes) return fail(1009, 'Frame too large');

      const maskLen = masked ? 4 : 0;
      const frameEnd = offset + maskLen + payloadLen;
      if (rxBuf.length < frameEnd) return;

      const payload = Buffer.allocUnsafe(payloadLen);
      if (masked) {
        const maskOffset = offset;
        const dataOffset = offset + 4;
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = rxBuf[dataOffset + i] ^ rxBuf[maskOffset + (i & 3)];
        }
      } else {
        rxBuf.copy(payload, 0, offset, frameEnd);
      }
      rxBuf = rxBuf.subarray(frameEnd);

      // 控制帧（0x8 关闭 / 0x9 Ping / 0xA Pong）可穿插在分片之间
      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) return fail(1002, 'Invalid control frame');
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          ws.close(code, reason);
          return;
        }
        if (opcode === 0x9) {
          ws.pong(payload);
        } else if (opcode === 0xa) {
          ws.emit('pong', payload);
        }
        continue;
      }

      // 数据帧与分片重组
      if (opcode === 0x1 || opcode === 0x2) {
        if (fragOpcode !== 0) return fail(1002, 'Unexpected new message before continuation finished');
        if (fin) {
          if (opcode === 0x1) ws.emit('text', payload.toString('utf8'));
          else ws.emit('binary', payload);
        } else {
          fragOpcode = opcode;
          fragChunks = [payload];
          fragBytes = payload.length;
        }
      } else if (opcode === 0x0) {
        if (fragOpcode === 0) return fail(1002, 'Unexpected continuation frame');
        fragBytes += payload.length;
        if (fragBytes > maxPayloadBytes) return fail(1009, 'Message too large');
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks, fragBytes);
          const op = fragOpcode;
          fragOpcode = 0;
          fragChunks = [];
          fragBytes = 0;
          if (op === 0x1) ws.emit('text', full.toString('utf8'));
          else ws.emit('binary', full);
        }
      } else {
        return fail(1002, 'Unsupported opcode');
      }
    }
  };

  socket.on('data', (chunk) => {
    if (closed) return;
    rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
    processBuffer();
  });
  socket.on('error', (err) => {
    ws.emit('error', err);
    markClosed(1006, err.message);
  });
  socket.on('close', () => markClosed(1006, ''));

  if (head && head.length) {
    rxBuf = Buffer.from(head);
    processBuffer();
  }
  return ws;
}
