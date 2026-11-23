// 零依赖 RFC 6455 WebSocket 服务端实现（适用于 Node.js >= 18）
// 支持文本帧、二进制帧（实时取景画面）、分片重组、Ping/Pong 保活与背压检测。
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 构造 WebSocket 帧头（服务端发送不掩码） */
function encodeHeader(opcode, len) {
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
  return header;
}

/** 构造服务端发往客户端的 WebSocket 帧（服务端发送不掩码） */
export function encodeFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf ?? '');
  const header = encodeHeader(opcode, payload.length);
  return payload.length ? Buffer.concat([header, payload]) : header;
}

/** 按 32 位整字解掩码，避免逐字节 XOR 循环 */
function unmaskPayload(src, dataOffset, maskOffset, payloadLen) {
  const payload = Buffer.allocUnsafe(payloadLen);
  const mask32 = src.readUInt32BE(maskOffset);
  let i = 0;
  const end4 = payloadLen - 3;
  for (; i < end4; i += 4) {
    payload.writeUInt32BE((src.readUInt32BE(dataOffset + i) ^ mask32) >>> 0, i);
  }
  for (; i < payloadLen; i++) {
    payload[i] = src[dataOffset + i] ^ src[maskOffset + (i & 3)];
  }
  return payload;
}

/**
 * 将 HTTP Upgrade 请求升级为 WebSocket 连接
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ maxPayloadBytes?: number, protocol?: string }} [opts]
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
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (opts.protocol ? `Sec-WebSocket-Protocol: ${opts.protocol}\r\n` : '') +
    '\r\n',
  );

  const ws = new EventEmitter();
  let closed = false;
  let rxChunks = [];
  let rxOffset = 0;
  let rxBytes = 0;
  let fragOpcode = 0;
  let fragChunks = [];
  let fragBytes = 0;

  const markClosed = (code = 1006, reason = '') => {
    if (closed) return;
    closed = true;
    ws.readyState = 3;
    rxChunks = [];
    rxOffset = 0;
    rxBytes = 0;
    fragChunks = [];
    ws.emit('close', code, reason);
  };

  const writeFrame = (opcode, payloadBuf) => {
    if (closed || socket.destroyed || !socket.writable) return false;
    const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf ?? '');
    const header = encodeHeader(opcode, payload.length);
    try {
      if (payload.length) {
        socket.cork();
        socket.write(header);
        socket.write(payload);
        socket.uncork();
      } else {
        socket.write(header);
      }
      return true;
    } catch {
      try { socket.uncork(); } catch {}
      return false;
    }
  };

  ws.readyState = 1;
  Object.defineProperty(ws, 'bufferedAmount', {
    get: () => (socket.destroyed ? Infinity : socket.writableLength),
  });

  ws.sendText = (text) => writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  ws.sendJson = (obj) => ws.sendText(JSON.stringify(obj));
  ws.sendBinary = (buf) => writeFrame(0x2, buf);
  ws.ping = (payload = '') => writeFrame(0x9, Buffer.from(payload));
  ws.pong = (payload = '') => writeFrame(0xa, payload);
  ws.close = (code = 1000, reason = '') => {
    if (closed) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 120);
    const body = Buffer.allocUnsafe(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    writeFrame(0x8, body);
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

  const peekByte = (index) => {
    let rem = index;
    for (let i = 0; i < rxChunks.length; i++) {
      const c = rxChunks[i];
      const start = i === 0 ? rxOffset : 0;
      const avail = c.length - start;
      if (rem < avail) return c[start + rem];
      rem -= avail;
    }
    return 0;
  };

  const pullBytes = (length) => {
    const first = rxChunks[0];
    const firstAvail = first.length - rxOffset;
    if (firstAvail >= length) {
      const slice = first.subarray(rxOffset, rxOffset + length);
      rxOffset += length;
      rxBytes -= length;
      if (rxOffset === first.length) {
        rxChunks.shift();
        rxOffset = 0;
      }
      return slice;
    }
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const c = rxChunks[0];
      const start = rxOffset;
      const take = Math.min(c.length - start, length - written);
      c.copy(out, written, start, start + take);
      written += take;
      rxBytes -= take;
      if (start + take === c.length) {
        rxChunks.shift();
        rxOffset = 0;
      } else {
        rxOffset = start + take;
      }
    }
    return out;
  };

  const processBuffer = () => {
    while (!closed && rxBytes >= 2) {
      const b0 = peekByte(0);
      const b1 = peekByte(1);
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) return fail(1002, 'RSV bits not supported');
      if (payloadLen === 126) {
        if (rxBytes < 4) return;
        payloadLen = (peekByte(2) << 8) | peekByte(3);
        offset = 4;
      } else if (payloadLen === 127) {
        if (rxBytes < 10) return;
        let bigLen = 0n;
        for (let i = 2; i < 10; i++) bigLen = (bigLen << 8n) | BigInt(peekByte(i));
        if (bigLen > BigInt(maxPayloadBytes)) return fail(1009, 'Frame too large');
        payloadLen = Number(bigLen);
        offset = 10;
      }
      if (payloadLen > maxPayloadBytes) return fail(1009, 'Frame too large');

      const maskLen = masked ? 4 : 0;
      const frameEnd = offset + maskLen + payloadLen;
      if (rxBytes < frameEnd) return;

      const frame = pullBytes(frameEnd);
      let payload;
      if (payloadLen === 0) {
        payload = Buffer.alloc(0);
      } else if (masked) {
        payload = unmaskPayload(frame, offset + 4, offset, payloadLen);
      } else {
        payload = Buffer.allocUnsafe(payloadLen);
        frame.copy(payload, 0, offset, frameEnd);
      }

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
    if (closed || !chunk.length) return;
    rxChunks.push(chunk);
    rxBytes += chunk.length;
    processBuffer();
  });
  socket.on('error', (err) => {
    ws.emit('error', err);
    markClosed(1006, err.message);
  });
  socket.on('close', () => markClosed(1006, ''));

  if (head && head.length) {
    rxChunks.push(Buffer.from(head));
    rxBytes += head.length;
    processBuffer();
  }
  return ws;
}
