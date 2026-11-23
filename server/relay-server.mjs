#!/usr/bin/env node
// 视觉分拣数字孪生 · 手机照片串流中转服务（零第三方依赖，Node.js >= 18）
// 支持：
// 1. 原图拍照/相册直传（HTTP POST 原字节上传，完整保留 JPEG/PNG 与 EXIF）
// 2. 实时取景串流与远程快门（WebSocket 二进制预览帧转发 + 信令互通）
// 3. 自带移动端拍摄页（/m/:room）与可选静态前端托管（--web-dir）
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from './ws.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MOBILE_HTML_PATH = join(HERE, 'mobile-standalone.html');
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const SESSION_PROTOCOL = 'sorting-twin.v1';
const PREVIEW_CODECS = ['h264', 'vp8'];
const PREVIEW_MAGIC = 0x53545031;
const VIDEO_SOFT_INFLIGHT = 6;
const VIDEO_MAX_INFLIGHT = 10;
const VIDEO_KEYFRAME_MAX_INFLIGHT = 14;
const JPEG_MAX_INFLIGHT = 2;
const PC_QUEUE_CONGESTED = 4;
const RELAY_KEYFRAME_COOLDOWN_MS = 450;
const FEEDBACK_INTERVAL_MS = 200;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const newCredential = () => randomBytes(32).toString('base64url');
const credentialHash = (value) => createHash('sha256').update(value).digest();

function bearerToken(req) {
  return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function generateRoomCode(existing) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    if (!existing.has(code)) return code;
  }
  throw new Error('Failed to allocate room code');
}

function detectImageMime(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 &&
    buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10
  ) {
    return 'image/png';
  }
  return null;
}

function sanitizeFileName(raw, fallbackMime) {
  let name = '';
  try {
    name = decodeURIComponent(String(raw || ''));
  } catch {
    name = String(raw || '');
  }
  name = name.replace(/[\r\n\0\\/:*?"<>|]/g, '_').trim().slice(0, 120);
  if (!name) name = `phone_${Date.now()}.${fallbackMime === 'image/png' ? 'png' : 'jpg'}`;
  return name;
}

/** 从 multipart/form-data 请求体中提取首个文件字段（兼容 curl -F 与 iOS 快捷指令） */
function extractMultipartFile(body, contentType) {
  const m = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const sepBuf = Buffer.from('\r\n\r\n');
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const partStart = pos + boundary.length;
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break; // 结束标记 --
    const nextPos = body.indexOf(boundary, partStart);
    if (nextPos === -1) break;
    const headerEnd = body.indexOf(sepBuf, partStart);
    if (headerEnd !== -1 && headerEnd < nextPos) {
      const headerStr = body.subarray(partStart, headerEnd).toString('utf8');
      let dataEnd = nextPos;
      if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
      const data = body.subarray(headerEnd + 4, dataEnd);
      const fnMatch = headerStr.match(/filename\*=UTF-8''([^;\r\n]+)|filename="([^"]+)"/i);
      const fileName = fnMatch ? (fnMatch[1] || fnMatch[2]) : '';
      if (fileName || detectImageMime(data)) {
        return { data, fileName };
      }
    }
    pos = nextPos;
  }
  return null;
}

async function readBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        const err = new Error(`照片体积超过上限（最大 ${Math.round(maxBytes / 1048576)} MB）`);
        err.statusCode = 413;
        rejectBody(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolveBody(Buffer.concat(chunks, total));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        rejectBody(err);
      }
    });
  });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name, X-Capture-Mode, X-Relay-Token');
  res.setHeader('Access-Control-Expose-Headers', 'X-File-Name, Content-Length');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

/**
 * 创建手机照片串流中转服务实例
 * @param {{
 *   port?: number,
 *   host?: string,
 *   webDir?: string | null,
 *   token?: string,
 *   accessKey?: string,
 *   inviteTtlMs?: number,
 *   maxPhotoBytes?: number,
 *   maxMemoryBytes?: number,
 *   maxRooms?: number,
 *   maxPhotosPerRoom?: number,
 *   roomTtlMs?: number,
 *   tlsCert?: string,
 *   tlsKey?: string,
 * }} [options]
 */
export function createRelayServer(options = {}) {
  const port = options.port ?? 8787;
  const host = options.host ?? '0.0.0.0';
  const webDir = options.webDir ? resolve(options.webDir) : null;
  const token = String(options.token || '').trim();
  const accessKey = String(options.accessKey || '').trim();
  const accessKeyHash = accessKey ? credentialHash(accessKey) : null;
  const authMode = accessKeyHash ? 'pairing' : token ? 'shared' : 'none';
  const inviteTtlMs = options.inviteTtlMs ?? 5 * 60 * 1000;
  const maxPhotoBytes = options.maxPhotoBytes ?? 25 * 1024 * 1024;
  const maxMemoryBytes = options.maxMemoryBytes ?? 150 * 1024 * 1024;
  const maxRooms = options.maxRooms ?? 60;
  const maxPhotosPerRoom = options.maxPhotosPerRoom ?? 8;
  const roomTtlMs = options.roomTtlMs ?? 60 * 60 * 1000;

  const startedAt = Date.now();
  const rooms = new Map(); // code -> { code, createdAt, lastActive, pcs: Set, phones: Set, photos: [] }
  const photoLru = []; // 全局按时间顺序记录 { roomCode, id, size } 以便总内存超限时淘汰最旧照片
  let totalPhotoBytes = 0;
  let mobileHtmlCache = null;

  const getMobileHtml = async () => {
    if (!mobileHtmlCache) mobileHtmlCache = await readFile(MOBILE_HTML_PATH, 'utf8');
    return mobileHtmlCache;
  };

  const removePhotoFromRoom = (room, photoId) => {
    const idx = room.photos.findIndex((p) => p.id === photoId);
    if (idx !== -1) {
      const [removed] = room.photos.splice(idx, 1);
      totalPhotoBytes = Math.max(0, totalPhotoBytes - removed.buffer.length);
    }
  };

  const evictMemoryIfNeeded = () => {
    while (totalPhotoBytes > maxMemoryBytes && photoLru.length > 0) {
      const oldest = photoLru.shift();
      const r = rooms.get(oldest.roomCode);
      if (r) removePhotoFromRoom(r, oldest.id);
    }
  };

  const retireRoom = (room) => {
    rooms.delete(room.code);
    for (const client of [...room.pcs, ...room.phones]) client.ws.close(4001, 'Room closed');
    for (const photo of [...room.photos]) removePhotoFromRoom(room, photo.id);
  };

  const issueInvite = (room, now) => {
    const auth = room.auth;
    const expiresAt = Math.min(now + inviteTtlMs, auth.expiresAt);
    const invite = newCredential();
    auth.inviteHash = credentialHash(invite);
    auth.inviteExpiresAt = expiresAt;
    auth.inviteVersion += 1;
    return { invite, inviteVersion: auth.inviteVersion, inviteExpiresInMs: expiresAt - now };
  };

  const checkRoomSession = (room, role, credential) => {
    const auth = room?.auth;
    if (!credential || !auth || auth.expiresAt <= Date.now()) return false;
    const expected = role === 'pc' ? auth.pcHash : auth.phoneHash;
    return Boolean(expected && timingSafeEqual(expected, credentialHash(credential)));
  };

  const getOrCreateRoom = (code, allowCreate = true) => {
    let room = rooms.get(code);
    if (room) {
      room.lastActive = Date.now();
      return room;
    }
    if (!allowCreate) return null;
    if (rooms.size >= maxRooms) {
      // 淘汰最久未活跃且无活跃连接的房间
      let victim = null;
      for (const r of rooms.values()) {
        if (r.pcs.size === 0 && r.phones.size === 0) {
          if (!victim || r.lastActive < victim.lastActive) victim = r;
        }
      }
      if (victim) retireRoom(victim);
      else {
        return null;
      }
    }
    room = {
      code,
      createdAt: Date.now(),
      lastActive: Date.now(),
      pcs: new Set(),
      phones: new Set(),
      photos: [],
      lastFeedbackAt: 0,
      lastFeedbackCongested: false,
      lastFeedbackSevere: false,
      lastFeedbackReceivers: -1,
      lastFeedbackInFlight: 0,
    };
    rooms.set(code, room);
    return room;
  };

  const roomSnapshot = (room) => ({
    room: room.code,
    pcCount: room.pcs.size,
    phoneCount: room.phones.size,
    phones: [...room.phones].map((c) => ({ device: c.device, live: !!c.live })),
    photos: room.photos.map((p) => ({
      id: p.id,
      name: p.name,
      size: p.buffer.length,
      mime: p.mime,
      mode: p.mode,
      ts: p.ts,
      url: `/api/rooms/${room.code}/photo/${p.id}`,
    })),
    ...(room.auth && {
      inviteVersion: room.auth.inviteVersion,
      invitePending: Boolean(room.auth.inviteHash && room.auth.inviteExpiresAt > Date.now()),
    }),
  });

  const broadcastRoomState = (room) => {
    const payload = { type: 'room_state', ...roomSnapshot(room) };
    for (const c of room.pcs) c.ws.sendJson(payload);
    const phoneState = room.auth ? { type: 'room_state', room: room.code, pcCount: room.pcs.size } : payload;
    const pcs = [...room.pcs];
    const activeReceivers = pcs.filter((pc) => pc.previewVisible && pc.ws.readyState === 1).length;
    const previewCodecs = pcs.length && room.phones.size === 1
      ? PREVIEW_CODECS.filter((codec) => pcs.every((pc) => pc.previewCodecs.includes(codec)))
      : [];
    const phonePayload = { ...phoneState, previewCodecs, activeReceivers };
    for (const c of room.phones) c.ws.sendJson(phonePayload);
  };

  const requestPhoneKeyframe = (room, pc, now) => {
    if (now - pc.lastRelayKeyframeAt < RELAY_KEYFRAME_COOLDOWN_MS) return;
    pc.lastRelayKeyframeAt = now;
    for (const phone of room.phones) phone.ws.sendJson({ type: 'preview_keyframe' });
  };

  const sendPreviewFeedback = (room, now, force = false) => {
    if (!room.phones.size) return;
    let activeReceivers = 0;
    let maxInFlight = 0;
    let maxQueue = 0;
    let congested = false;
    let severe = false;
    let hasAckPeer = false;
    for (const pc of room.pcs) {
      if (pc.ws.readyState !== 1 || !pc.previewVisible) continue;
      activeReceivers++;
      if (pc.ackEnabled) hasAckPeer = true;
      const inFlight = pc.ackEnabled ? Math.max(0, pc.previewSent - pc.previewAcked) : 0;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      if (pc.previewQueue > maxQueue) maxQueue = pc.previewQueue;
      const pcSevere = pc.awaitingKeyframe
        || pc.ws.bufferedAmount >= 262144
        || (pc.ackEnabled && inFlight >= VIDEO_MAX_INFLIGHT);
      const pcCongested = pcSevere
        || pc.ws.bufferedAmount >= 131072
        || (pc.ackEnabled && (inFlight >= VIDEO_SOFT_INFLIGHT || pc.previewQueue >= PC_QUEUE_CONGESTED || Boolean(pc.pendingJpeg)));
      if (pcSevere) severe = true;
      if (pcCongested) congested = true;
    }
    const windowOpened = (maxInFlight < JPEG_MAX_INFLIGHT && room.lastFeedbackInFlight >= JPEG_MAX_INFLIGHT)
      || (maxInFlight === 0 && room.lastFeedbackInFlight > 0);
    const changed = congested !== room.lastFeedbackCongested
      || severe !== room.lastFeedbackSevere
      || activeReceivers !== room.lastFeedbackReceivers
      || windowOpened;
    if (!force && !changed && (!hasAckPeer || now - room.lastFeedbackAt < FEEDBACK_INTERVAL_MS)) return;
    room.lastFeedbackAt = now;
    room.lastFeedbackCongested = congested;
    room.lastFeedbackSevere = severe;
    room.lastFeedbackReceivers = activeReceivers;
    room.lastFeedbackInFlight = maxInFlight;
    const feedback = {
      type: 'preview_feedback',
      congested,
      severe,
      inFlight: maxInFlight,
      queue: maxQueue,
      activeReceivers,
    };
    for (const phone of room.phones) phone.ws.sendJson(feedback);
  };

  const checkToken = (req, urlObj) => {
    if (!token) return true;
    const headerTok = String(req.headers['x-relay-token'] || '').trim();
    const queryTok = String(urlObj.searchParams.get('token') || '').trim();
    return headerTok === token || queryTok === token;
  };

  const serveStatic = async (req, res, pathname) => {
    if (!webDir) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return true;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }
    let rel = decoded.replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    const full = resolve(webDir, rel);
    if (full !== webDir && !full.startsWith(webDir + sep)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }
    let target = full;
    try {
      const st = await stat(target);
      if (st.isDirectory()) target = join(target, 'index.html');
      const finalSt = await stat(target);
      if (!finalSt.isFile()) return false;
      const ext = extname(target).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Content-Length', finalSt.size);
      if (ext === '.html') res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      const data = await readFile(target);
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  const handleRequest = async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const rawPath = String(req.url || '/').split('?')[0];
    if (/(?:^|\/)\.\.(?:\/|$)|%2e%2e|%5c|\\/i.test(rawPath)) {
      return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    }
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // 1. 健康检查
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'sorting-twin-relay',
        version: '1.0.0',
        rooms: rooms.size,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        authRequired: authMode !== 'none',
        authMode,
        staticHosted: Boolean(webDir),
      });
    }

    // 2. 手机拍摄端独立页面（/m 或 /m/:code）
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/m' || /^\/m\/[A-Za-z0-9]{4,12}\/?$/.test(pathname))) {
      const html = await getMobileHtml();
      const buf = Buffer.from(html, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Length', buf.length);
      if (req.method === 'HEAD') res.end();
      else res.end(buf);
      return;
    }

    // 3. 房间与照片 API
    if (pathname.startsWith('/api/rooms')) {
      if (!accessKeyHash && !checkToken(req, urlObj)) {
        return sendJson(res, 401, { ok: false, error: '访问口令无效或缺失（X-Relay-Token）' });
      }
      const credential = accessKeyHash ? bearerToken(req) : '';
      const deny = () => sendJson(res, 401, { ok: false, error: '凭证无效或已过期，请重新连接或扫码' });

      // POST /api/rooms — 创建新房间
      if (req.method === 'POST' && pathname === '/api/rooms') {
        if (accessKeyHash && (!credential || !timingSafeEqual(accessKeyHash, credentialHash(credential)))) return deny();
        const code = generateRoomCode(rooms);
        const room = getOrCreateRoom(code, true);
        if (!room) return sendJson(res, 503, { ok: false, error: '活跃房间数已达上限，请稍后重试' });
        let pairing = {};
        if (accessKeyHash) {
          const pcSession = newCredential();
          const now = Date.now();
          room.auth = {
            pcHash: credentialHash(pcSession),
            phoneHash: null,
            expiresAt: now + SESSION_TTL_MS,
            inviteVersion: 0,
          };
          pairing = { pcSession, ...issueInvite(room, now) };
        }
        return sendJson(res, 201, {
          ok: true,
          room: room.code,
          expiresInSec: Math.floor(roomTtlMs / 1000),
          ...pairing,
        });
      }

      const pairingMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})\/(pair|invite)$/);
      if (accessKeyHash && req.method === 'POST' && pairingMatch) {
        const room = rooms.get(pairingMatch[1].toUpperCase());
        const now = Date.now();
        const auth = room?.auth;
        if (pairingMatch[2] === 'pair') {
          if (!credential || !auth?.inviteHash || auth.inviteExpiresAt <= now ||
              !timingSafeEqual(auth.inviteHash, credentialHash(credential))) return deny();
          auth.inviteHash = null;
          const phoneSession = newCredential();
          auth.phoneHash = credentialHash(phoneSession);
          room.lastActive = now;
          broadcastRoomState(room);
          return sendJson(res, 201, { ok: true, phoneSession });
        }
        if (!checkRoomSession(room, 'pc', credential)) return deny();
        auth.phoneHash = null;
        for (const client of room.phones) client.ws.close(4001, 'Phone unpaired');
        room.lastActive = now;
        return sendJson(res, 201, { ok: true, ...issueInvite(room, now) });
      }

      // GET /api/rooms/:code — 查询房间状态
      const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/);
      if (accessKeyHash && req.method === 'DELETE' && roomMatch) {
        const room = rooms.get(roomMatch[1].toUpperCase());
        if (!checkRoomSession(room, 'pc', credential)) return deny();
        retireRoom(room);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && roomMatch) {
        const code = roomMatch[1].toUpperCase();
        if (!ROOM_RE.test(code)) return sendJson(res, 400, { ok: false, error: '房间码格式无效' });
        const room = accessKeyHash ? rooms.get(code) : getOrCreateRoom(code, true);
        if (accessKeyHash && !checkRoomSession(room, 'pc', credential)) return deny();
        if (!room) return sendJson(res, 503, { ok: false, error: '活跃房间数已达上限' });
        return sendJson(res, 200, { ok: true, ...roomSnapshot(room) });
      }

      // POST /api/rooms/:code/photo — 手机上传原图（支持原始二进制与 multipart/form-data）
      const uploadMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})\/photo$/);
      if (req.method === 'POST' && uploadMatch) {
        const code = uploadMatch[1].toUpperCase();
        if (!ROOM_RE.test(code)) return sendJson(res, 400, { ok: false, error: '房间码格式无效' });
        const room = accessKeyHash ? rooms.get(code) : getOrCreateRoom(code, true);
        if (accessKeyHash && !checkRoomSession(room, 'phone', credential)) return deny();
        if (!room) return sendJson(res, 503, { ok: false, error: '活跃房间数已达上限' });
        let rawBody;
        try {
          rawBody = await readBody(req, maxPhotoBytes);
        } catch (err) {
          return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
        }
        if (accessKeyHash && (rooms.get(code) !== room || !checkRoomSession(room, 'phone', credential))) return deny();
        let imgBuf = rawBody;
        let rawName = req.headers['x-file-name'] || '';
        const ct = String(req.headers['content-type'] || '');
        if (/^multipart\/form-data/i.test(ct)) {
          const parsed = extractMultipartFile(rawBody, ct);
          if (!parsed) return sendJson(res, 400, { ok: false, error: '未在 multipart 表单中找到图片文件' });
          imgBuf = parsed.data;
          if (!rawName && parsed.fileName) rawName = parsed.fileName;
        }
        const mime = detectImageMime(imgBuf);
        if (!mime) {
          return sendJson(res, 415, { ok: false, error: '仅支持 JPEG 或 PNG 原图（请确认照片格式非 HEIC）' });
        }
        const name = sanitizeFileName(rawName, mime);
        const mode = String(req.headers['x-capture-mode'] || 'upload') === 'snapshot' ? 'snapshot' : 'upload';
        const id = randomUUID().replace(/-/g, '').slice(0, 12);
        const ts = Date.now();
        const record = { id, name, mime, mode, ts, buffer: imgBuf };
        room.photos.push(record);
        room.lastActive = ts;
        totalPhotoBytes += imgBuf.length;
        photoLru.push({ roomCode: code, id, size: imgBuf.length });

        while (room.photos.length > maxPhotosPerRoom) {
          const old = room.photos.shift();
          totalPhotoBytes = Math.max(0, totalPhotoBytes - old.buffer.length);
        }
        evictMemoryIfNeeded();

        const meta = {
          type: 'photo',
          room: code,
          id,
          name,
          size: imgBuf.length,
          mime,
          mode,
          ts,
          url: `/api/rooms/${code}/photo/${id}`,
        };
        for (const pc of room.pcs) pc.ws.sendJson(meta);
        return sendJson(res, 200, { ok: true, ...meta, deliveredTo: room.pcs.size });
      }

      // GET /api/rooms/:code/photo/:id — 电脑端下载原图字节
      const photoMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})\/photo\/([A-Za-z0-9_-]{4,36})$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && photoMatch) {
        const code = photoMatch[1].toUpperCase();
        const id = photoMatch[2];
        const room = rooms.get(code);
        if (accessKeyHash && !checkRoomSession(room, 'pc', credential)) return deny();
        const photo = room?.photos.find((p) => p.id === id);
        if (!photo) return sendJson(res, 404, { ok: false, error: '照片不存在或已过期' });
        room.lastActive = Date.now();
        res.statusCode = 200;
        res.setHeader('Content-Type', photo.mime);
        res.setHeader('Content-Length', photo.buffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-File-Name', encodeURIComponent(photo.name));
        if (req.method === 'HEAD') res.end();
        else res.end(photo.buffer);
        return;
      }

      return sendJson(res, 404, { ok: false, error: '未知接口路径' });
    }

    // 4. 可选静态前端托管
    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, pathname))) {
      return;
    }

    // 5. 未托管静态前端时的根路径引导页
    if (req.method === 'GET' && pathname === '/') {
      const info = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>视觉分拣中转服务</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.6;color:#222}code{background:#f2f0eb;padding:2px 6px;border-radius:4px}</style></head><body><h2>视觉分拣 · 手机照片串流中转服务运行中</h2><p>请在电脑端打开「视觉分拣数字孪生」页面，点击顶栏 <b>手机串流</b> 并填入本服务地址即可扫码连拍。</p><p>手机手动输入配对码入口：<a href="/m">/m</a> · 健康检查：<a href="/api/health">/api/health</a></p></body></html>`;
      const buf = Buffer.from(info, 'utf8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  };

  const server = options.tlsCert && options.tlsKey
    ? https.createServer({ cert: readFileSync(options.tlsCert), key: readFileSync(options.tlsKey) }, (req, res) => {
        handleRequest(req, res).catch((err) => {
          console.error('[relay] request error:', err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
        });
      })
    : http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          console.error('[relay] request error:', err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
        });
      });

  // WebSocket 升级路由：/ws?room=CODE&role=pc|phone&device=...
  server.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const code = String(urlObj.searchParams.get('room') || '').toUpperCase().trim();
    const role = urlObj.searchParams.get('role') === 'phone' ? 'phone' : 'pc';
    const existingRoom = rooms.get(code);
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((item) => item.trim());
    const session = protocols[1]?.match(/^session\.([A-Za-z0-9_-]{43})$/)?.[1];
    const authorized = accessKeyHash
      ? protocols[0] === SESSION_PROTOCOL && checkRoomSession(existingRoom, role, session)
      : checkToken(req, urlObj);
    if (!authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const device = String(urlObj.searchParams.get('device') || (role === 'phone' ? '手机' : '电脑')).slice(0, 48);
    if (!ROOM_RE.test(code)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const room = accessKeyHash ? existingRoom : getOrCreateRoom(code, true);
    if (!room) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const ws = acceptWebSocket(req, socket, head, {
      maxPayloadBytes: 2 * 1024 * 1024,
      protocol: accessKeyHash ? SESSION_PROTOCOL : '',
    });
    if (!ws) return;
    ws.on('error', () => ws.terminate());

    const client = {
      ws,
      role,
      device,
      live: false,
      alive: true,
      previewCodecs: [],
      lastKeyframeRequest: 0,
      ackEnabled: false,
      previewVisible: true,
      previewSent: 0,
      previewAcked: 0,
      previewQueue: 0,
      awaitingKeyframe: false,
      pendingJpeg: null,
      lastRelayKeyframeAt: 0,
    };
    const bucket = role === 'phone' ? room.phones : room.pcs;
    bucket.add(client);
    room.lastActive = Date.now();
    broadcastRoomState(room);

    ws.on('pong', () => { client.alive = true; });

    ws.on('text', (raw) => {
      client.alive = true;
      const now = Date.now();
      room.lastActive = now;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        ws.sendJson({ type: 'pong', ts: msg.ts ?? now });
        return;
      }
      if (role === 'phone' && msg.type === 'stream_state') {
        client.live = Boolean(msg.live);
        if (!client.live) {
          for (const pc of room.pcs) {
            pc.pendingJpeg = null;
            pc.awaitingKeyframe = false;
          }
        }
        const ev = {
          type: 'stream_state',
          live: client.live,
          mode: msg.mode === 'live' ? 'live' : 'photo',
          width: Number(msg.width) || 0,
          height: Number(msg.height) || 0,
          device: client.device,
        };
        for (const pc of room.pcs) pc.ws.sendJson(ev);
        broadcastRoomState(room);
      } else if (role === 'pc' && msg.type === 'preview_codecs' && Array.isArray(msg.codecs)) {
        if (msg.ack === true) client.ackEnabled = true;
        const accepted = PREVIEW_CODECS.filter((codec) => msg.codecs.includes(codec));
        if (accepted.join() !== client.previewCodecs.join()) {
          client.previewCodecs = accepted;
          client.awaitingKeyframe = false;
          broadcastRoomState(room);
        }
      } else if (role === 'pc' && msg.type === 'preview_ack') {
        client.ackEnabled = true;
        const ackCount = Math.max(0, Math.floor(Number(msg.count) || 0));
        if (ackCount > client.previewAcked) {
          client.previewAcked = Math.min(ackCount, client.previewSent);
        }
        client.previewQueue = Math.max(0, Math.floor(Number(msg.queue) || 0));
        // JPEG 单槽覆盖模式：收到 ACK 腾出窗口后立即发送最新一帧
        if (
          client.pendingJpeg &&
          client.previewVisible &&
          client.ws.readyState === 1 &&
          client.ws.bufferedAmount < 131072 &&
          client.previewSent - client.previewAcked < JPEG_MAX_INFLIGHT
        ) {
          const nextBuf = client.pendingJpeg;
          client.pendingJpeg = null;
          if (client.ws.sendBinary(nextBuf)) client.previewSent++;
        }
        sendPreviewFeedback(room, now);
      } else if (role === 'pc' && msg.type === 'preview_visible') {
        const visible = Boolean(msg.visible);
        if (visible !== client.previewVisible) {
          client.previewVisible = visible;
          client.pendingJpeg = null;
          client.awaitingKeyframe = Boolean(client.previewCodecs.length);
          if (!visible) client.lastRelayKeyframeAt = 0;
          broadcastRoomState(room);
          if (visible && client.previewCodecs.length) requestPhoneKeyframe(room, client, now);
        }
      } else if (role === 'pc' && msg.type === 'preview_keyframe') {
        if (!client.previewCodecs.length || now - client.lastKeyframeRequest < 250) return;
        client.lastKeyframeRequest = now;
        client.awaitingKeyframe = true;
        for (const phone of room.phones) phone.ws.sendJson({ type: 'preview_keyframe' });
      } else if (role === 'pc' && msg.type === 'shutter') {
        for (const phone of room.phones) phone.ws.sendJson({ type: 'shutter', ts: now });
      } else if (role === 'pc' && msg.type === 'pc_status') {
        const ev = {
          type: 'pc_status',
          stage: String(msg.stage || '').slice(0, 32),
          text: String(msg.text || '').slice(0, 240),
          level: ['ok', 'warn', 'err', ''].includes(msg.level) ? msg.level : '',
        };
        for (const phone of room.phones) phone.ws.sendJson(ev);
      }
    });

    // 二进制帧：手机预览 -> 电脑（JPEG 单槽覆盖 / 视频帧按 GOP 感知丢包 + ACK 端到端流控）
    ws.on('binary', (buf) => {
      client.alive = true;
      if (role !== 'phone' || !buf.length) return;
      const now = Date.now();
      room.lastActive = now;
      const isVideo = buf.length > 10 && buf.readUInt32BE(0) === PREVIEW_MAGIC;
      const isKeyframe = isVideo && buf[9] === 1;
      let congestionEvent = false;
      let feedbackDirty = false;

      for (const pc of room.pcs) {
        if (pc.ws.readyState !== 1) continue;
        if (!pc.previewVisible) {
          if (isVideo) pc.awaitingKeyframe = true;
          else pc.pendingJpeg = null;
          continue;
        }
        if (isVideo) {
          pc.pendingJpeg = null;
          const inFlight = pc.ackEnabled ? Math.max(0, pc.previewSent - pc.previewAcked) : 0;
          if (pc.awaitingKeyframe) {
            if (!isKeyframe) {
              requestPhoneKeyframe(room, pc, now);
              continue;
            }
            const canResume = pc.ws.bufferedAmount < 262144
              && (!pc.ackEnabled || inFlight < VIDEO_KEYFRAME_MAX_INFLIGHT);
            if (!canResume) {
              requestPhoneKeyframe(room, pc, now);
              congestionEvent = true;
              continue;
            }
            pc.awaitingKeyframe = false;
            feedbackDirty = true;
            if (pc.ws.sendBinary(buf)) pc.previewSent++;
            continue;
          }
          const limit = isKeyframe ? VIDEO_KEYFRAME_MAX_INFLIGHT : VIDEO_MAX_INFLIGHT;
          const congested = pc.ws.bufferedAmount >= 262144
            || (pc.ackEnabled && (inFlight >= limit || pc.previewQueue >= 6));
          if (congested) {
            pc.awaitingKeyframe = true;
            requestPhoneKeyframe(room, pc, now);
            congestionEvent = true;
            continue;
          }
          if (pc.ws.sendBinary(buf)) pc.previewSent++;
          continue;
        }

        // JPEG 降级路径：启用 ACK 的电脑使用单槽覆盖（Latest-Frame-Only），旧客户端保持缓冲上限兜底
        pc.awaitingKeyframe = false;
        if (pc.ackEnabled) {
          const inFlight = Math.max(0, pc.previewSent - pc.previewAcked);
          if (inFlight < JPEG_MAX_INFLIGHT && pc.ws.bufferedAmount < 131072) {
            pc.pendingJpeg = null;
            if (pc.ws.sendBinary(buf)) pc.previewSent++;
          } else {
            pc.pendingJpeg = buf;
            congestionEvent = true;
          }
        } else if (pc.ws.bufferedAmount < 262144) {
          if (pc.ws.sendBinary(buf)) pc.previewSent++;
        }
      }

      if (congestionEvent || feedbackDirty) sendPreviewFeedback(room, now, congestionEvent);
    });

    ws.on('close', () => {
      bucket.delete(client);
      if (role === 'phone' && client.live) {
        for (const pc of room.pcs) {
          pc.pendingJpeg = null;
          pc.awaitingKeyframe = false;
          pc.ws.sendJson({ type: 'stream_state', live: false, device: client.device });
        }
      }
      broadcastRoomState(room);
    });
  });

  // 定时清理过期空闲房间 & 心跳保活
  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.auth?.expiresAt <= now ||
          (room.pcs.size === 0 && room.phones.size === 0 && now - room.lastActive > roomTtlMs)) {
        retireRoom(room);
        continue;
      }
      for (const c of [...room.pcs, ...room.phones]) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }
  }, 30000);
  gcTimer.unref();

  return {
    server,
    rooms,
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          server.removeListener('error', rejectListen);
          const addr = server.address();
          resolveListen({
            host,
            port: typeof addr === 'object' && addr ? addr.port : port,
            tls: Boolean(options.tlsCert && options.tlsKey),
            webDir,
          });
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(gcTimer);
        for (const room of rooms.values()) {
          for (const c of [...room.pcs, ...room.phones]) c.ws.close(1001, 'Server shutting down');
        }
        server.close(() => resolveClose());
      }),
  };
}

function parseCliArgs(argv) {
  const out = {
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST || '0.0.0.0',
    webDir: process.env.WEB_DIR || '',
    token: process.env.RELAY_TOKEN || '',
    accessKey: process.env.RELAY_ACCESS_KEY || '',
    tlsCert: process.env.TLS_CERT || '',
    tlsKey: process.env.TLS_KEY || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) out.host = argv[++i];
    else if (a === '--web-dir' && argv[i + 1]) out.webDir = argv[++i];
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (a === '--cert' && argv[i + 1]) out.tlsCert = argv[++i];
    else if (a === '--key' && argv[i + 1]) out.tlsKey = argv[++i];
    else if (a === '--no-web') out.webDir = null;
  }
  if (out.webDir === '') {
    const defaultDist = resolve(HERE, '..', 'dist');
    const localWeb = resolve(HERE, 'web');
    if (existsSync(join(localWeb, 'index.html'))) out.webDir = localWeb;
    else if (existsSync(join(defaultDist, 'index.html'))) out.webDir = defaultDist;
    else out.webDir = null;
  }
  return out;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const cfg = parseCliArgs(process.argv.slice(2));
  const relay = createRelayServer(cfg);
  const info = await relay.listen();
  const proto = info.tls ? 'https' : 'http';
  console.log(`[sorting-twin-relay] listening on ${proto}://${info.host}:${info.port}`);
  console.log(`[sorting-twin-relay] mobile capture: ${proto}://<YOUR_IP>:${info.port}/m`);
  if (info.webDir) console.log(`[sorting-twin-relay] hosting static web app from: ${info.webDir}`);
  else console.log('[sorting-twin-relay] relay-only mode (no static web dir configured)');
  if (cfg.accessKey) console.log('[sorting-twin-relay] one-time phone pairing enabled');
  else if (cfg.token) console.log('[sorting-twin-relay] token authentication enabled');
  const shutdown = () => {
    console.log('\n[sorting-twin-relay] shutting down...');
    relay.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
