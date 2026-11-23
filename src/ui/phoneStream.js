// 电脑端「手机照片串流」面板与中转客户端（双模式：原图直传 + 实时取景远程快门）
// 搭配 server/relay-server.mjs 使用；支持自动发现同源中转服务、二维码扫码配对、实时状态回传。
import { renderQRToCanvas } from './qrcode.js';

const STORAGE_URL = 'yolohtml.relayUrl';
const STORAGE_ACCESS_KEY = 'yolohtml.relayAccessKey';
const STORAGE_AUTO = 'yolohtml.relayAutoLoad';
const SESSION_ROOM = 'yolohtml.relayRoom';
const SESSION_PROTOCOL = 'sorting-twin.v1';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const LEGACY_RELAY_URL = 'http://38.59.227.180:8787';
const LIVE_FRAME_INTERVAL = 1000 / 30;
const PREVIEW_MAGIC = 0x53545031;
const PREVIEW_CODECS = [
  { id: 1, name: 'h264', codec: 'avc1.42001f' },
  { id: 2, name: 'vp8', codec: 'vp8' },
];
/* global __BUNDLED_RELAY_KEY__ */
export const DEFAULT_RELAY_URL = 'https://forward.davidshi.codes';
const BUNDLED_RELAY_KEY = typeof __BUNDLED_RELAY_KEY__ === 'string' ? __BUNDLED_RELAY_KEY__.trim() : '';

async function supportedPreviewCodecs() {
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return new Map();
  const results = await Promise.all(PREVIEW_CODECS.map(async ({ name, codec }) => {
    // 优先使用浏览器默认解码（允许硬件加速），软解作为降级备选
    const primary = { codec, optimizeForLatency: true };
    const software = { ...primary, hardwareAcceleration: 'prefer-software' };
    const [pRes, sRes] = await Promise.all([
      VideoDecoder.isConfigSupported(primary).catch(() => null),
      VideoDecoder.isConfigSupported(software).catch(() => null),
    ]);
    const configs = [];
    if (pRes?.supported) configs.push(primary);
    if (sRes?.supported) configs.push(software);
    return configs.length ? [name, configs] : null;
  }));
  return new Map(results.filter(Boolean));
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtRoom = (c) => (c && c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c || '------');

/** 规范化用户输入的中转服务器地址（自动补协议、去末尾斜杠） */
export function normalizeRelayUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(s);
    s = (isLocal ? 'http://' : 'https://') + s;
  }
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/** 检测混合内容限制：HTTPS 页面不能直接请求公网 HTTP 中转服务 */
export function isMixedContentBlocked(relayUrl, pageProtocol = location.protocol) {
  if (pageProtocol !== 'https:' || !relayUrl.startsWith('http://')) return false;
  try {
    const host = new URL(relayUrl).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return true;
  }
}

/** 仅在连接默认 HTTPS 中转域名时返回构建期注入的演示访问密钥 */
export function resolveDefaultRelayKey(relayUrl, bundledKey = BUNDLED_RELAY_KEY) {
  const key = String(bundledKey || '').trim();
  return key && normalizeRelayUrl(relayUrl) === DEFAULT_RELAY_URL ? key : '';
}

/**
 * 创建手机照片串流控制器与界面
 * @param {{
 *   mountRoot: HTMLElement,
 *   onPhoto: (file: File, meta: { id: string, mode: string, size: number }) => void,
 *   isBusyEditing?: () => boolean,
 *   onStateChange?: (st: { connected: boolean, phoneCount: number, live: boolean, room: string }) => void,
 *   message?: (text: string, level?: string) => void,
 * }} deps
 */
export function createPhoneStream({ mountRoot, onPhoto, isBusyEditing = () => false, onStateChange = () => {}, message = () => {} }) {
  const q = new URLSearchParams(location.search);
  const canRememberKey = LOOPBACK_HOSTS.includes(location.hostname);
  let savedUrl = '';
  let rememberedKey = null;
  let autoLoad = true;
  let savedRoom = '';
  try {
    savedUrl = localStorage.getItem(STORAGE_URL) || '';
    localStorage.removeItem('yolohtml.relayToken');
    const autoRaw = localStorage.getItem(STORAGE_AUTO);
    if (autoRaw === '0') autoLoad = false;
    savedRoom = sessionStorage.getItem(SESSION_ROOM) || '';
  } catch {
    // 无存储权限时忽略
  }
  if (canRememberKey) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_ACCESS_KEY) || 'null');
      if (typeof saved?.url === 'string' && typeof saved.key === 'string') rememberedKey = saved;
    } catch {}
  }
  const preferredUrl = normalizeRelayUrl(q.get('relay') || savedUrl);
  const initialUrl = preferredUrl === LEGACY_RELAY_URL ? DEFAULT_RELAY_URL : preferredUrl;
  let serverUrl = initialUrl;
  let token = '';
  let pairingAuth = false;
  let pcSession = '';
  let invite = null;
  let inviteTimer = 0;
  let reconnectFailures = 0;
  let roomClosing = false;
  let room = savedRoom;
  let connected = false;
  let connecting = false;
  let userDisconnected = false;
  let phoneCount = 0;
  let phoneDevices = [];
  let liveActive = false;
  let ws = null;
  let wsRetryTimer = 0;
  let pingTimer = 0;
  let retryMs = 1200;
  let liveFpsCount = 0;
  let liveFpsTs = 0;
  let decodingLive = false;
  const pendingLiveFrames = [];
  const decodedLiveFrames = [];
  let liveRafId = 0;
  let lastLiveDrawAt = 0;
  let liveGeneration = 0;
  let previewRecvCount = 0;
  let lastAckCount = 0;
  let lastAckAt = 0;
  let ackTimer = 0;
  let lastSentVisible = null;
  let previewCodecSupport;
  let previewDecoderConfigs = new Map();
  let videoPreviewDecoder = null;
  let lastKeyframeRequestAt = -Infinity;
  const videoDecoderFailures = new Map();
  let pendingPhoto = null;
  let sameOriginChecked = false;
  let sameOriginAvailable = false;
  const seenPhotoIds = new Set();
  const receivedHistory = []; // { id, name, size, mime, mode, ts, url }

  /* ---------------- DOM：浮层面板 + 底部收起状态条 ---------------- */
  const panel = document.createElement('section');
  panel.id = 'stream-panel';
  panel.className = 'stream-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '手机照片串流');
  panel.innerHTML = `
    <div class="stream-head">
      <div class="stream-head-title">
        <span class="stream-dot" id="sp-dot" aria-hidden="true"></span>
        <div>
          <h3>手机照片串流</h3>
          <p id="sp-subtitle" class="muted small">扫码配对后，手机拍原图或实时取景直达电脑</p>
        </div>
      </div>
      <div class="stream-head-btns">
        <button type="button" class="icon-btn text" id="sp-minimize" title="最小化为角落悬浮条，保持后台连接">收起</button>
        <button type="button" class="icon-btn" id="sp-close" aria-label="关闭">×</button>
      </div>
    </div>

    <div class="stream-body">
      <!-- 服务器连接配置 -->
      <div class="stream-server">
        <label class="stream-label" for="sp-url">中转服务器地址</label>
        <div class="stream-row">
          <input id="sp-url" class="stream-input" type="text" placeholder="例如 https://forward.davidshi.codes" spellcheck="false" autocomplete="off" />
          <button type="button" class="btn btn-primary btn-small" id="sp-connect">连接</button>
          <button type="button" class="btn btn-small" id="sp-disconnect" hidden>断开</button>
        </div>
        <div class="stream-token-row" id="sp-token-row" hidden>
          <input id="sp-token" class="stream-input" type="password" placeholder="电脑访问密钥" autocomplete="off" />
          <label class="check" id="sp-remember-wrap" hidden><input type="checkbox" id="sp-remember-key" />在此浏览器记住密钥</label>
        </div>
        <div class="stream-server-foot">
          <span id="sp-conn-note" class="muted small">填入已部署的中转服务地址并连接</span>
          <button type="button" class="stream-link-btn" id="sp-toggle-token">访问密钥</button>
        </div>
      </div>

      <!-- 混合内容拦截提示 -->
      <div id="sp-mixed-warn" class="stream-warn" hidden>
        <b>HTTPS 页面无法直连明文 HTTP 中转服务</b>
        <p>浏览器安全策略会拦截当前 HTTPS 页面向 <code>http://</code> 发起请求。可选择以下任意方式：</p>
        <ol>
          <li>直接在新标签页打开服务器托管的页面：<a id="sp-open-http" href="#" target="_blank" rel="noopener"></a>（或使用本机展示包）；</li>
          <li>在服务器执行 <code>sudo bash install.sh --https 你的域名</code> 开启免费 HTTPS/WSS 后再从本页直连。</li>
        </ol>
      </div>

      <!-- 错误提示 -->
      <div id="sp-error" class="stream-error" hidden></div>

      <!-- 配对与二维码区 -->
      <div id="sp-pair" class="stream-pair" hidden>
        <div class="stream-qr-box" id="sp-qr-box">
          <canvas id="sp-qr" width="184" height="184" aria-label="手机扫码连接二维码"></canvas>
        </div>
        <div class="stream-pair-info">
          <div class="stream-label">房间配对码</div>
          <div class="stream-code" id="sp-code">------</div>
          <div class="stream-peer" id="sp-peer">等待手机扫码进入…</div>
          <p class="muted small" id="sp-invite-note" hidden></p>
          <div class="stream-pair-btns">
            <button type="button" class="btn btn-small" id="sp-copy">复制链接</button>
            <button type="button" class="btn btn-small" id="sp-new-room">换房间</button>
            <button type="button" class="btn btn-small" id="sp-refresh-invite" hidden>重新配对</button>
          </div>
          <a id="sp-mobile-link" class="stream-mobile-url" href="#" target="_blank" rel="noopener"></a>
        </div>
      </div>

      <!-- 实时取景预览区（当手机切换到实时取景模式时自动出现） -->
      <div id="sp-live-box" class="stream-live" hidden>
        <div class="stream-live-head">
          <span class="stream-live-badge" id="sp-live-badge">LIVE</span>
          <button type="button" class="btn btn-primary btn-small" id="sp-shutter">远程拍一张并识别</button>
        </div>
        <div class="stream-live-stage">
          <canvas id="sp-live-canvas"></canvas>
        </div>
      </div>

      <!-- 暂存新照片横幅（关闭自动载入或正在手动框选时出现） -->
      <div id="sp-pending" class="stream-pending" hidden>
        <span id="sp-pending-text">收到手机新照片</span>
        <button type="button" class="btn btn-primary btn-small" id="sp-load-pending">立即载入识别</button>
      </div>

      <!-- 接收策略与历史 -->
      <div id="sp-options" class="stream-options" hidden>
        <label class="check"><input type="checkbox" id="sp-autoload" checked /> 收到手机照片后自动识别建模</label>
        <button type="button" class="btn btn-small" id="sp-request-shot" title="通知已连接的手机端拍照">提醒手机拍照</button>
      </div>

      <div id="sp-history-wrap" class="stream-history-wrap" hidden>
        <div class="stream-label">本次已接收照片</div>
        <div id="sp-history" class="stream-history"></div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const mini = document.createElement('div');
  mini.id = 'stream-mini';
  mini.className = 'stream-mini';
  mini.hidden = true;
  mini.innerHTML = `
    <span class="stream-dot" id="sm-dot" aria-hidden="true"></span>
    <span class="stream-mini-text" id="sm-text">手机串流</span>
    <button type="button" class="btn btn-primary btn-small" id="sm-shutter" hidden>远程拍照</button>
    <button type="button" class="btn btn-primary btn-small" id="sm-load" hidden>载入新图</button>
    <button type="button" class="icon-btn text" id="sm-open">展开</button>`;
  mountRoot.appendChild(mini);

  const $p = (id) => panel.querySelector(`#${id}`);
  const $m = (id) => mini.querySelector(`#${id}`);

  const urlInput = $p('sp-url');
  const tokenInput = $p('sp-token');
  const rememberInput = $p('sp-remember-key');
  const autoloadInput = $p('sp-autoload');
  const liveCanvas = $p('sp-live-canvas');
  const liveCtx = liveCanvas?.getContext?.('2d', { alpha: false }) ?? null;
  let inputKeyUrl = '';
  urlInput.value = serverUrl;
  autoloadInput.checked = autoLoad;
  $p('sp-remember-wrap').hidden = !canRememberKey;

  const restoreAccessKey = (relayUrl) => {
    if (inputKeyUrl && inputKeyUrl !== relayUrl) {
      tokenInput.value = '';
      rememberInput.checked = false;
      inputKeyUrl = '';
    }
    const bundledKey = resolveDefaultRelayKey(relayUrl);
    if (rememberedKey?.url === relayUrl && !tokenInput.value) {
      tokenInput.value = rememberedKey.key;
      rememberInput.checked = true;
      inputKeyUrl = relayUrl;
      $p('sp-token-row').hidden = false;
    } else if (bundledKey && !tokenInput.value) {
      tokenInput.value = bundledKey;
      rememberInput.checked = false;
      inputKeyUrl = relayUrl;
    }
  };

  const rememberVerifiedKey = () => {
    if (!canRememberKey || !rememberInput.checked || !pairingAuth || !pcSession) return;
    try {
      const record = { url: serverUrl, key: token };
      localStorage.setItem(STORAGE_ACCESS_KEY, JSON.stringify(record));
      rememberedKey = record;
    } catch {}
  };

  restoreAccessKey(initialUrl);

  const setError = (msg) => {
    const el = $p('sp-error');
    el.hidden = !msg;
    el.textContent = msg || '';
  };

  const mobilePageUrl = () => {
    if (!serverUrl || !room) return '';
    const base = `${serverUrl}/m/${encodeURIComponent(room)}`;
    if (pairingAuth) return invite ? `${base}#invite=${encodeURIComponent(invite.value)}` : '';
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  };

  const apiHeaders = (extra = {}) => {
    const h = { ...extra };
    if (pairingAuth && pcSession) h.Authorization = `Bearer ${pcSession}`;
    else if (!pairingAuth && token) h['X-Relay-Token'] = token;
    return h;
  };

  const updateStatusUi = () => {
    const stateClass = !connected ? '' : phoneCount > 0 ? 'on' : 'wait';
    $p('sp-dot').className = `stream-dot ${stateClass}`;
    $m('sm-dot').className = `stream-dot ${stateClass}`;

    $p('sp-connect').hidden = connected;
    $p('sp-connect').disabled = connecting;
    $p('sp-connect').textContent = connecting ? '连接中…' : '连接';
    $p('sp-disconnect').hidden = !connected;
    $p('sp-disconnect').disabled = roomClosing;
    $p('sp-new-room').disabled = roomClosing;
    $p('sp-refresh-invite').hidden = !pairingAuth;
    urlInput.disabled = connected || connecting;
    $p('sp-pair').hidden = !connected;
    $p('sp-options').hidden = !connected;
    $p('sp-live-box').hidden = !connected || !liveActive;
    panel.classList.toggle('is-live-preview', connected && liveActive && !panel.hidden);

    if (!connected) {
      $p('sp-subtitle').textContent = '扫码配对后，手机拍原图或实时取景直达电脑';
      $p('sp-conn-note').textContent = connecting ? '正在握手并分配配对房间…' : '填入已部署的中转服务地址并连接';
      $p('sp-peer').textContent = '等待手机扫码进入…';
      $p('sp-peer').className = 'stream-peer';
    } else if (phoneCount > 0) {
      const names = phoneDevices.map((d) => d.device).filter(Boolean).join('、') || '手机';
      $p('sp-subtitle').textContent = liveActive ? `${names} 正在实时取景串流` : `${names} 已连接，随时可拍照直传`;
      $p('sp-conn-note').textContent = `已连接中转服务 · 房间 ${fmtRoom(room)}`;
      $p('sp-peer').textContent = `● ${names} 已连接${liveActive ? ' · 实时取景中' : ' · 原图直传就绪'}`;
      $p('sp-peer').className = 'stream-peer ok';
    } else {
      $p('sp-subtitle').textContent = `房间 ${fmtRoom(room)} 已就绪，请用手机扫码`;
      $p('sp-conn-note').textContent = `已连接中转服务 · 等待手机加入`;
      $p('sp-peer').textContent = '等待手机扫码进入…';
      $p('sp-peer').className = 'stream-peer wait';
    }

    $p('sp-request-shot').disabled = !connected || phoneCount === 0;
    $p('sp-shutter').disabled = !connected || phoneCount === 0;

    // 收起状态条仅在已连接且面板隐藏时显示
    mini.hidden = !connected || !panel.hidden;
    if (!mini.hidden) {
      $m('sm-text').textContent =
        phoneCount > 0
          ? `手机已连 · ${fmtRoom(room)}${liveActive ? ' · LIVE' : ''}`
          : `等手机扫码 · ${fmtRoom(room)}`;
      $m('sm-shutter').hidden = !(phoneCount > 0 && liveActive);
      $m('sm-load').hidden = !pendingPhoto;
    }

    $p('sp-pending').hidden = !pendingPhoto;
    if (pendingPhoto) {
      $p('sp-pending-text').textContent = `收到新照片：${pendingPhoto.name}（${fmtSize(pendingPhoto.size)}）`;
    }

    onStateChange({ connected, phoneCount, live: liveActive, room, panelOpen: !panel.hidden });
    syncPreviewVisibility();
  };

  const renderPairCard = () => {
    const url = mobilePageUrl();
    $p('sp-code').textContent = fmtRoom(room);
    const link = $p('sp-mobile-link');
    link.hidden = !url;
    if (url) link.href = url;
    else link.removeAttribute('href');
    link.textContent = pairingAuth ? '打开手机配对链接' : url;
    $p('sp-qr-box').hidden = !url;
    $p('sp-copy').hidden = !url;
    const note = $p('sp-invite-note');
    note.hidden = !pairingAuth;
    note.textContent = invite ? '二维码 5 分钟内有效，仅可扫码配对一次。' :
      '需要让手机重新加入时，点「重新配对」生成二维码。原手机会断开。';
    if (url) {
      try {
        renderQRToCanvas($p('sp-qr'), url, { sizePx: 184 });
      } catch (err) {
        console.error('[phoneStream] QR render error:', err);
      }
    }
  };

  const setInvite = (data) => {
    clearTimeout(inviteTimer);
    invite = data?.invite ? { value: data.invite, version: data.inviteVersion } : null;
    if (invite) inviteTimer = setTimeout(() => setInvite(null), data.inviteExpiresInMs);
    renderPairCard();
  };

  const renderHistory = () => {
    const wrap = $p('sp-history-wrap');
    const list = $p('sp-history');
    wrap.hidden = receivedHistory.length === 0;
    list.innerHTML = '';
    for (const item of receivedHistory) {
      const row = document.createElement('div');
      row.className = 'stream-hist-item';
      const time = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      row.innerHTML = `
        <div class="stream-hist-meta">
          <div class="stream-hist-name"></div>
          <div class="muted small">${item.mode === 'snapshot' ? '实时抓拍' : '原图直传'} · ${fmtSize(item.size)} · ${time}</div>
        </div>
        <button type="button" class="btn btn-small">载入</button>`;
      row.querySelector('.stream-hist-name').textContent = item.name;
      row.querySelector('button').addEventListener('click', () => loadRemotePhoto(item));
      list.appendChild(row);
    }
  };

  const sendWsJson = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  const loadRemotePhoto = async (meta) => {
    try {
      const photoRoom = room;
      const fullUrl = pairingAuth
        ? `${serverUrl}/api/rooms/${encodeURIComponent(photoRoom)}/photo/${encodeURIComponent(meta.id)}`
        : new URL(meta.url, serverUrl).href;
      const resp = await fetch(fullUrl, { headers: apiHeaders(), cache: 'no-store' });
      if (!resp.ok) throw new Error(`拉取照片失败（HTTP ${resp.status}）`);
      const blob = await resp.blob();
      if (photoRoom !== room) return;
      const file = new File([blob], meta.name || `phone_${meta.id}.jpg`, { type: meta.mime || blob.type || 'image/jpeg' });
      if (pendingPhoto?.id === meta.id) pendingPhoto = null;
      updateStatusUi();
      // 收到照片自动开始识别时，如果面板还开着，自动收起为悬浮条以便直接观看识别与 3D 场景
      if (!panel.hidden && autoLoad) {
        panel.hidden = true;
        updateStatusUi();
      }
      onPhoto(file, meta);
    } catch (err) {
      message(`拉取手机照片失败：${err.message}`, 'error');
      sendPcStatus('error', `电脑拉取失败：${err.message}`, 'err');
    }
  };

  const handleIncomingPhoto = (meta, fromInitialSync = false) => {
    if (!meta?.id || seenPhotoIds.has(meta.id)) return;
    seenPhotoIds.add(meta.id);
    receivedHistory.unshift(meta);
    if (receivedHistory.length > 8) receivedHistory.length = 8;
    renderHistory();

    if (fromInitialSync) return;

    if (autoLoad && !isBusyEditing()) {
      message(`收到手机照片：${meta.name}（${fmtSize(meta.size)}），自动开始识别…`, 'info');
      sendPcStatus('loading', `电脑已收到 ${meta.name}，开始读取…`, '');
      loadRemotePhoto(meta);
    } else {
      pendingPhoto = meta;
      updateStatusUi();
      const reason = isBusyEditing() ? '当前正在修改框选，已暂存手机新照片' : '已收到手机新照片，点击“载入新图”开始识别';
      message(`${reason}：${meta.name}`, 'info');
      sendPcStatus('queued', '照片已送达电脑（等待电脑端点击载入）', 'warn');
    }
  };

  const isPreviewVisible = () => !panel.hidden && (typeof document === 'undefined' || !document.hidden);

  const dropLiveQueues = () => {
    liveGeneration++;
    pendingLiveFrames.length = 0;
    for (const bitmap of decodedLiveFrames.splice(0)) bitmap.close();
    if (liveRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(liveRafId);
    }
    liveRafId = 0;
    lastLiveDrawAt = 0;
  };

  const syncPreviewVisibility = () => {
    const visible = isPreviewVisible();
    if (!visible) {
      dropLiveQueues();
      if (videoPreviewDecoder) videoPreviewDecoder.awaitingKeyframe = true;
    }
    if (ws && ws.readyState === WebSocket.OPEN && visible !== lastSentVisible) {
      lastSentVisible = visible;
      sendWsJson({ type: 'preview_visible', visible });
    }
  };

  const flushPreviewAck = () => {
    clearTimeout(ackTimer);
    ackTimer = 0;
    if (!ws || ws.readyState !== WebSocket.OPEN || previewRecvCount === lastAckCount) return;
    lastAckCount = previewRecvCount;
    lastAckAt = performance.now();
    sendWsJson({
      type: 'preview_ack',
      count: previewRecvCount,
      queue: decodedLiveFrames.length + pendingLiveFrames.length,
    });
  };

  const schedulePreviewAck = (immediate = false) => {
    const now = performance.now();
    if (immediate || previewRecvCount - lastAckCount >= 3 || now - lastAckAt >= 100) {
      flushPreviewAck();
    } else if (!ackTimer) {
      ackTimer = setTimeout(flushPreviewAck, 50);
    }
  };

  const clearLivePreview = () => {
    dropLiveQueues();
    closeVideoPreviewDecoder();
    liveActive = false;
    liveFpsCount = 0;
    liveFpsTs = 0;
    $p('sp-live-badge').textContent = 'LIVE';
  };

  const renderLiveLoop = (now) => {
    liveRafId = 0;
    if (!decodedLiveFrames.length || !isPreviewVisible()) return;
    // 30fps 对齐 60Hz 显示器（每 2 次 vsync = 33.3ms）；队列积压 >= 3 帧时提速到单 vsync 追平
    const minInterval = decodedLiveFrames.length >= 3 ? 14 : 26;
    if (lastLiveDrawAt && now - lastLiveDrawAt < minInterval) {
      liveRafId = requestAnimationFrame(renderLiveLoop);
      return;
    }
    if (decodedLiveFrames.length >= 4) {
      decodedLiveFrames.shift().close();
    }
    const bitmap = decodedLiveFrames.shift();
    lastLiveDrawAt = now;
    const width = bitmap.displayWidth ?? bitmap.width;
    const height = bitmap.displayHeight ?? bitmap.height;
    try {
      if (liveCanvas.width !== width || liveCanvas.height !== height) {
        liveCanvas.width = width;
        liveCanvas.height = height;
      }
      liveCtx?.drawImage(bitmap, 0, 0);
      if (!liveActive) {
        liveActive = true;
        updateStatusUi();
      }
      if (!liveFpsTs) liveFpsTs = now;
      else {
        liveFpsCount++;
        const elapsed = now - liveFpsTs;
        if (elapsed >= 1000) {
          const fps = Math.round(liveFpsCount * 1000 / elapsed);
          $p('sp-live-badge').textContent = `LIVE · ${width}×${height} · ${fps} fps`;
          liveFpsCount = 0;
          liveFpsTs = now;
        }
      }
    } finally {
      bitmap.close();
    }
    if (decodedLiveFrames.length) {
      liveRafId = requestAnimationFrame(renderLiveLoop);
    }
  };

  const bufferLiveFrame = (frame) => {
    if (!isPreviewVisible()) {
      frame.close();
      return;
    }
    while (decodedLiveFrames.length >= 4) decodedLiveFrames.shift().close();
    decodedLiveFrames.push(frame);
    if (!liveRafId && typeof requestAnimationFrame === 'function') {
      liveRafId = requestAnimationFrame(renderLiveLoop);
    }
  };

  const queueLiveFrame = async (blob) => {
    if (!isPreviewVisible()) return;
    // JPEG 降级模式只保留最新待解码帧，杜绝解码积压
    if (pendingLiveFrames.length >= 2) pendingLiveFrames.shift();
    pendingLiveFrames.push(blob);
    if (decodingLive) return;
    decodingLive = true;
    try {
      while (pendingLiveFrames.length) {
        const nextFrame = pendingLiveFrames.shift();
        const generation = liveGeneration;
        const bitmap = await createImageBitmap(nextFrame).catch(() => null);
        if (!bitmap) continue;
        if (generation !== liveGeneration || !isPreviewVisible()) {
          bitmap.close();
          continue;
        }
        bufferLiveFrame(bitmap);
      }
    } finally {
      decodingLive = false;
    }
  };

  const advertisePreviewCodecs = async (socket) => {
    previewCodecSupport ??= supportedPreviewCodecs();
    previewDecoderConfigs = await previewCodecSupport;
    const codecs = [...previewDecoderConfigs.entries()]
      .filter(([name, configs]) => (videoDecoderFailures.get(name) || 0) < Math.max(2, configs.length))
      .map(([name]) => name);
    if (socket === ws) sendWsJson({ type: 'preview_codecs', codecs, ack: true });
  };

  const closeVideoPreviewDecoder = () => {
    const decoder = videoPreviewDecoder;
    videoPreviewDecoder = null;
    if (decoder?.instance && decoder.instance.state !== 'closed') decoder.instance.close();
  };

  const requestPreviewKeyframe = () => {
    const now = performance.now();
    if (now - lastKeyframeRequestAt < 300) return;
    lastKeyframeRequestAt = now;
    sendWsJson({ type: 'preview_keyframe' });
  };

  const decodeVideoPreview = (packet, header) => {
    if (!isPreviewVisible()) return;
    const format = PREVIEW_CODECS.find(({ id }) => id === header.getUint8(8));
    const configs = previewDecoderConfigs.get(format?.name);
    const failures = videoDecoderFailures.get(format?.name) || 0;
    const maxFailures = configs ? Math.max(2, configs.length) : 0;
    if (!configs?.length || failures >= maxFailures) return;
    const config = configs[Math.min(failures, configs.length - 1)];
    const sequence = header.getUint32(4);
    const isKeyframe = header.getUint8(9) === 1;
    const current = videoPreviewDecoder;
    if (current && current.format !== format) {
      closeVideoPreviewDecoder();
    }
    if (!videoPreviewDecoder) {
      if (!isKeyframe) {
        requestPreviewKeyframe();
        return;
      }
      const decoder = { format, sequence: (sequence - 1) >>> 0, awaitingKeyframe: false };
      const fail = () => {
        if (videoPreviewDecoder !== decoder) return;
        closeVideoPreviewDecoder();
        const nextFailures = (videoDecoderFailures.get(format.name) || 0) + 1;
        videoDecoderFailures.set(format.name, nextFailures);
        if (nextFailures >= maxFailures) advertisePreviewCodecs(ws);
        else requestPreviewKeyframe();
      };
      decoder.fail = fail;
      videoPreviewDecoder = decoder;
      try {
        decoder.instance = new VideoDecoder({
          output: (frame) => {
            if (videoPreviewDecoder === decoder) bufferLiveFrame(frame);
            else frame.close();
          },
          error: fail,
        });
        decoder.instance.configure(config);
      } catch {
        fail();
        return;
      }
    }
    const decoder = videoPreviewDecoder;
    const expected = (decoder.sequence + 1) >>> 0;
    const gap = sequence !== expected;
    const overloaded = decoder.instance.decodeQueueSize > 8;
    if (gap || overloaded) {
      if (overloaded) {
        try {
          decoder.instance.reset();
          decoder.instance.configure(config);
        } catch {
          decoder.fail();
          return;
        }
      }
      if (!isKeyframe) {
        decoder.awaitingKeyframe = true;
        requestPreviewKeyframe();
        return;
      }
      decoder.awaitingKeyframe = false;
    } else if (decoder.awaitingKeyframe) {
      if (!isKeyframe) {
        requestPreviewKeyframe();
        return;
      }
      decoder.awaitingKeyframe = false;
    }
    decoder.sequence = sequence;
    try {
      decoder.instance.decode(new EncodedVideoChunk({
        type: isKeyframe ? 'key' : 'delta',
        timestamp: Math.round(sequence * LIVE_FRAME_INTERVAL * 1000),
        data: new Uint8Array(packet, 10),
      }));
    } catch {
      decoder.fail();
    }
  };

  const handlePreviewPacket = (packet) => {
    if (!packet.byteLength) return;
    const header = new DataView(packet);
    const isVideo = packet.byteLength > 10 && header.getUint32(0) === PREVIEW_MAGIC;
    previewRecvCount++;
    schedulePreviewAck(!isVideo);
    if (isVideo) {
      decodeVideoPreview(packet, header);
    } else {
      if (videoPreviewDecoder) closeVideoPreviewDecoder();
      queueLiveFrame(new Blob([packet], { type: 'image/jpeg' }));
    }
  };

  const closeSocket = () => {
    clearTimeout(wsRetryTimer);
    clearInterval(pingTimer);
    clearTimeout(ackTimer);
    ackTimer = 0;
    previewRecvCount = 0;
    lastAckCount = 0;
    lastAckAt = 0;
    lastSentVisible = null;
    clearLivePreview();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch {}
      ws = null;
    }
  };

  const openSocket = () => {
    closeSocket();
    if (!serverUrl || !room) return;
    const u = new URL(serverUrl);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ room, role: 'pc', device: '电脑工作站' });
    if (!pairingAuth && token) params.set('token', token);
    const wsUrl = `${wsProto}//${u.host}${u.pathname.replace(/\/+$/, '')}/ws?${params.toString()}`;

    const sock = pairingAuth
      ? new WebSocket(wsUrl, [SESSION_PROTOCOL, `session.${pcSession}`])
      : new WebSocket(wsUrl);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    sock.onopen = () => {
      reconnectFailures = 0;
      retryMs = 1200;
      connected = true;
      connecting = false;
      lastSentVisible = null;
      setError('');
      renderPairCard();
      updateStatusUi();
      pingTimer = setInterval(() => sendWsJson({ type: 'ping', ts: Date.now() }), 20000);
      advertisePreviewCodecs(sock);
    };

    sock.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handlePreviewPacket(ev.data);
        return;
      }
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'room_state') {
        if (invite?.version === msg.inviteVersion && msg.invitePending === false) setInvite(null);
        const prevPhones = phoneCount;
        phoneCount = Number(msg.phoneCount) || 0;
        phoneDevices = Array.isArray(msg.phones) ? msg.phones : [];
        if (phoneCount === 0) clearLivePreview();
        if (prevPhones === 0 && phoneCount > 0) {
          message(`手机已连入房间 ${fmtRoom(room)}，可随时拍照直传`, 'ok');
        }
        if (Array.isArray(msg.photos)) {
          for (const p of msg.photos) handleIncomingPhoto(p, true);
        }
        updateStatusUi();
      } else if (msg.type === 'photo') {
        handleIncomingPhoto(msg, false);
      } else if (msg.type === 'stream_state') {
        if (!msg.live) clearLivePreview();
        else if (!liveActive) {
          liveActive = true;
          $p('sp-live-badge').textContent = 'LIVE · 等待画面…';
        }
        updateStatusUi();
      }
    };

    sock.onclose = (event) => {
      clearInterval(pingTimer);
      clearTimeout(ackTimer);
      ackTimer = 0;
      if (ws !== sock) return;
      ws = null;
      lastSentVisible = null;
      clearLivePreview();
      updateStatusUi();
      if (roomClosing) return;
      if (pairingAuth && (event.code === 4001 || ++reconnectFailures >= 3)) {
        resetConnection();
        setError('房间连接已结束，请重新连接并让手机扫码。');
        return;
      }
      if (connected) {
        $p('sp-conn-note').textContent = '中转连接中断，正在自动重连…';
        wsRetryTimer = setTimeout(openSocket, retryMs);
        retryMs = Math.min(8000, Math.round(retryMs * 1.6));
      }
    };

    sock.onerror = () => {
      if (!connected) {
        connecting = false;
        setError('WebSocket 握手失败，请检查服务器端口与防火墙设置。');
        updateStatusUi();
      }
      try { sock.close(); } catch {}
    };
  };

  const resetConnection = () => {
    connected = false;
    connecting = false;
    phoneCount = 0;
    phoneDevices = [];
    liveActive = false;
    pendingPhoto = null;
    closeSocket();
    if (pairingAuth) {
      pcSession = '';
      room = '';
      setInvite(null);
      seenPhotoIds.clear();
      receivedHistory.length = 0;
      renderHistory();
    }
    updateStatusUi();
  };

  const disconnect = async () => {
    if (roomClosing) return false;
    if (pairingAuth && pcSession) {
      roomClosing = true;
      updateStatusUi();
      try {
        const response = await fetch(`${serverUrl}/api/rooms/${encodeURIComponent(room)}`, {
          method: 'DELETE',
          headers: apiHeaders(),
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok && response.status !== 401) throw new Error();
      } catch {
        setError('未能确认房间已关闭，请重试。');
        if (!ws) openSocket();
        return false;
      } finally {
        roomClosing = false;
        updateStatusUi();
      }
    }
    resetConnection();
    return true;
  };

  const connect = async ({ forceNewRoom = false } = {}) => {
    if (connecting) return;
    const raw = urlInput.value;
    const norm = normalizeRelayUrl(raw);
    restoreAccessKey(norm);
    token = tokenInput.value.trim();
    setError('');
    $p('sp-mixed-warn').hidden = true;

    if (!norm) {
      setError('请输入有效的中转服务器地址（例如 https://forward.davidshi.codes）。');
      return;
    }
    urlInput.value = norm;
    serverUrl = norm;

    if (isMixedContentBlocked(norm)) {
      $p('sp-mixed-warn').hidden = false;
      const a = $p('sp-open-http');
      a.href = `${norm}/`;
      a.textContent = `${norm}/`;
      return;
    }

    try {
      localStorage.setItem(STORAGE_URL, serverUrl);
    } catch {
      // 忽略存储限制
    }

    connecting = true;
    updateStatusUi();

    try {
      // 1. 校验中转服务健康状态
      const healthResp = await fetch(`${serverUrl}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!healthResp.ok) throw new Error(`健康检查失败（HTTP ${healthResp.status}）`);
      const health = await healthResp.json();
      if (health?.service !== 'sorting-twin-relay') {
        throw new Error('目标地址不是视觉分拣中转服务，请核对地址与端口。');
      }
      pairingAuth = health.authMode === 'pairing';
      if (pairingAuth) {
        const relay = new URL(serverUrl);
        if (relay.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(relay.hostname)) {
          throw new Error('请使用 HTTPS 中转地址提交电脑访问密钥。');
        }
      }
      if (health.authRequired && !token) {
        $p('sp-token-row').hidden = false;
        tokenInput.focus();
        throw new Error('请输入电脑访问密钥后再连接。');
      }

      // 2. 创建或复用配对房间
      if (pairingAuth || forceNewRoom || !room) {
        const roomResp = await fetch(`${serverUrl}/api/rooms`, {
          method: 'POST',
          headers: pairingAuth ? { Authorization: `Bearer ${token}` } : apiHeaders(),
          redirect: pairingAuth ? 'error' : 'follow',
          signal: AbortSignal.timeout(6000),
        });
        if (roomResp.status === 401) {
          $p('sp-token-row').hidden = false;
          tokenInput.focus();
          throw new Error('访问密钥有误，请核对后重试。');
        }
        if (!roomResp.ok) throw new Error(`创建房间失败（HTTP ${roomResp.status}）`);
        const data = await roomResp.json();
        room = data.room;
        if (pairingAuth) {
          pcSession = data.pcSession;
          inputKeyUrl = serverUrl;
          rememberVerifiedKey();
          reconnectFailures = 0;
          setInvite(data);
        } else {
          try { sessionStorage.setItem(SESSION_ROOM, room); } catch {}
        }
      }

      // 3. 建立 WebSocket 长连接
      openSocket();
    } catch (err) {
      connecting = false;
      connected = false;
      const hint = /Failed to fetch|NetworkError|Load failed|AbortError/i.test(err.message)
        ? `无法连接到 ${serverUrl}，请确认服务器已运行且安全组已放行对应端口。`
        : err.message;
      setError(hint);
      updateStatusUi();
    }
  };

  /** 如果当前网页正是由中转服务器直接托管，自动检测同源 /api/health 并自动连接 */
  const probeSameOrigin = async () => {
    if (sameOriginChecked) return sameOriginAvailable;
    sameOriginChecked = true;
    try {
      const resp = await fetch(`${location.origin}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data?.service === 'sorting-twin-relay') {
        sameOriginAvailable = true;
        if (!urlInput.value.trim()) {
          urlInput.value = location.origin;
          serverUrl = location.origin;
        }
        return true;
      }
    } catch {
      // 非同源托管，静默忽略
    }
    return false;
  };

  const triggerShutter = () => {
    if (!connected || phoneCount === 0) return;
    sendWsJson({ type: 'shutter', ts: Date.now() });
    message(liveActive ? '已向手机发送远程快门指令…' : '已提醒手机端拍照上传', 'info');
  };

  /** 将电脑端的识别进度与结果回传给手机屏幕 */
  const sendPcStatus = (stage, text, level = '') => {
    if (!connected || phoneCount === 0) return;
    sendWsJson({ type: 'pc_status', stage, text, level });
  };

  /* ---------------- 交互事件绑定 ---------------- */
  $p('sp-connect').addEventListener('click', () => {
    userDisconnected = false;
    connect();
  });
  $p('sp-disconnect').addEventListener('click', async () => {
    userDisconnected = true;
    if (await disconnect()) message('已断开手机照片串流连接', 'info');
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connected && !connecting) {
      userDisconnected = false;
      connect();
    }
  });
  urlInput.addEventListener('change', () => restoreAccessKey(normalizeRelayUrl(urlInput.value)));
  tokenInput.addEventListener('input', () => {
    inputKeyUrl = normalizeRelayUrl(urlInput.value) || DEFAULT_RELAY_URL;
  });
  rememberInput.addEventListener('change', () => {
    const selectedUrl = normalizeRelayUrl(urlInput.value);
    if (rememberInput.checked) {
      if (selectedUrl === serverUrl && tokenInput.value.trim() === token) rememberVerifiedKey();
      return;
    }
    if (rememberedKey?.url !== selectedUrl) return;
    try {
      localStorage.removeItem(STORAGE_ACCESS_KEY);
      rememberedKey = null;
    } catch {}
  });
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connected && !connecting) {
      userDisconnected = false;
      connect();
    }
  });
  $p('sp-toggle-token').addEventListener('click', () => {
    const row = $p('sp-token-row');
    row.hidden = !row.hidden;
    if (!row.hidden) tokenInput.focus();
  });
  $p('sp-new-room').addEventListener('click', async () => {
    if (!connected || !(await disconnect())) return;
    seenPhotoIds.clear();
    receivedHistory.length = 0;
    pendingPhoto = null;
    renderHistory();
    connect({ forceNewRoom: true });
  });
  $p('sp-refresh-invite').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const session = pcSession;
    button.disabled = true;
    try {
      const result = await fetch(`${serverUrl}/api/rooms/${encodeURIComponent(room)}/invite`, {
        method: 'POST',
        headers: apiHeaders(),
        signal: AbortSignal.timeout(6000),
      });
      if (!result.ok) throw new Error();
      const data = await result.json();
      if (pcSession === session) setInvite(data);
    } catch {
      setError('生成二维码失败，请重试。');
    } finally {
      button.disabled = false;
    }
  });
  $p('sp-copy').addEventListener('click', async () => {
    const url = mobilePageUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message('已复制手机串流链接，可直接发给手机打开', 'ok');
    } catch {
      prompt('复制以下链接到手机浏览器打开：', url);
    }
  });
  $p('sp-shutter').addEventListener('click', triggerShutter);
  $p('sp-request-shot').addEventListener('click', triggerShutter);
  $m('sm-shutter').addEventListener('click', triggerShutter);
  $p('sp-load-pending').addEventListener('click', () => {
    if (pendingPhoto) loadRemotePhoto(pendingPhoto);
  });
  $m('sm-load').addEventListener('click', () => {
    if (pendingPhoto) loadRemotePhoto(pendingPhoto);
  });
  autoloadInput.addEventListener('change', (e) => {
    autoLoad = e.target.checked;
    try { localStorage.setItem(STORAGE_AUTO, autoLoad ? '1' : '0'); } catch {}
  });

  const hidePanel = () => {
    panel.hidden = true;
    updateStatusUi();
  };
  const openPanel = async () => {
    panel.hidden = false;
    updateStatusUi();
    if (!connected && !connecting) {
      if (!initialUrl && !urlInput.value.trim() && !/\.github\.io$/i.test(location.hostname)) {
        const found = await probeSameOrigin();
        if (found) {
          urlInput.value = location.origin;
          serverUrl = location.origin;
        }
      }
      if (!urlInput.value.trim()) {
        urlInput.value = DEFAULT_RELAY_URL;
        serverUrl = DEFAULT_RELAY_URL;
      }
      restoreAccessKey(normalizeRelayUrl(urlInput.value));
      if (!userDisconnected && urlInput.value.trim()) {
        connect();
      } else {
        urlInput.focus();
      }
    }
  };

  $p('sp-minimize').addEventListener('click', hidePanel);
  $p('sp-close').addEventListener('click', hidePanel);
  $m('sm-open').addEventListener('click', openPanel);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) hidePanel();
  });
  document.addEventListener('visibilitychange', syncPreviewVisibility);

  // 如果地址带 ?relay=...，启动时自动静默连接中转服务
  if (q.get('relay') && initialUrl) {
    setTimeout(() => connect(), 120);
  }

  updateStatusUi();

  return {
    open: openPanel,
    close: hidePanel,
    toggle: () => (panel.hidden ? openPanel() : hidePanel()),
    disconnect,
    sendPcStatus,
    get state() {
      return { connected, phoneCount, live: liveActive, room, serverUrl };
    },
  };
}
