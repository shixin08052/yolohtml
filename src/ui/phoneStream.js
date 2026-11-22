// 电脑端「手机照片串流」面板与中转客户端（双模式：原图直传 + 实时取景远程快门）
// 搭配 server/relay-server.mjs 使用；支持自动发现同源中转服务、二维码扫码配对、实时状态回传。
import { renderQRToCanvas } from './qrcode.js';

const STORAGE_URL = 'yolohtml.relayUrl';
const STORAGE_TOKEN = 'yolohtml.relayToken';
const STORAGE_AUTO = 'yolohtml.relayAutoLoad';
const SESSION_ROOM = 'yolohtml.relayRoom';
export const DEFAULT_RELAY_URL = 'https://forward.davidshi.codes';

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
  let savedUrl = '';
  let savedToken = '';
  let autoLoad = true;
  let savedRoom = '';
  try {
    savedUrl = localStorage.getItem(STORAGE_URL) || '';
    savedToken = localStorage.getItem(STORAGE_TOKEN) || '';
    const autoRaw = localStorage.getItem(STORAGE_AUTO);
    if (autoRaw === '0') autoLoad = false;
    savedRoom = sessionStorage.getItem(SESSION_ROOM) || '';
  } catch {
    // 无存储权限时忽略
  }
  const explicitUrl = normalizeRelayUrl(q.get('relay') || savedUrl);
  const initialUrl = explicitUrl;
  const initialToken = q.get('relayToken') || savedToken;

  let serverUrl = initialUrl;
  let token = initialToken;
  let room = savedRoom;
  let connected = false;
  let connecting = false;
  let userDisconnected = false;
  let phoneCount = 0;
  let phoneDevices = [];
  let liveActive = false;
  let liveDims = '';
  let ws = null;
  let wsRetryTimer = 0;
  let pingTimer = 0;
  let retryMs = 1200;
  let liveFpsCount = 0;
  let liveFpsTs = 0;
  let liveFpsText = '';
  let drawingLive = false;
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
          <input id="sp-token" class="stream-input" type="password" placeholder="服务器访问口令（如已启用 --token）" autocomplete="off" />
        </div>
        <div class="stream-server-foot">
          <span id="sp-conn-note" class="muted small">填入已部署的中转服务地址并连接</span>
          <button type="button" class="stream-link-btn" id="sp-toggle-token">口令设置</button>
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
        <div class="stream-qr-box">
          <canvas id="sp-qr" width="184" height="184" aria-label="手机扫码连接二维码"></canvas>
        </div>
        <div class="stream-pair-info">
          <div class="stream-label">房间配对码</div>
          <div class="stream-code" id="sp-code">------</div>
          <div class="stream-peer" id="sp-peer">等待手机扫码进入…</div>
          <div class="stream-pair-btns">
            <button type="button" class="btn btn-small" id="sp-copy">复制链接</button>
            <button type="button" class="btn btn-small" id="sp-new-room">换房间</button>
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
  const autoloadInput = $p('sp-autoload');
  urlInput.value = serverUrl;
  tokenInput.value = token;
  autoloadInput.checked = autoLoad;
  if (token) $p('sp-token-row').hidden = false;

  const setError = (msg) => {
    const el = $p('sp-error');
    el.hidden = !msg;
    el.textContent = msg || '';
  };

  const mobilePageUrl = () => {
    if (!serverUrl || !room) return '';
    const base = `${serverUrl}/m/${encodeURIComponent(room)}`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  };

  const apiHeaders = (extra = {}) => {
    const h = { ...extra };
    if (token) h['X-Relay-Token'] = token;
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
    urlInput.disabled = connected || connecting;
    $p('sp-pair').hidden = !connected;
    $p('sp-options').hidden = !connected;
    $p('sp-live-box').hidden = !connected || !liveActive;

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

    onStateChange({ connected, phoneCount, live: liveActive, room });
  };

  const renderPairCard = () => {
    const url = mobilePageUrl();
    $p('sp-code').textContent = fmtRoom(room);
    const link = $p('sp-mobile-link');
    link.href = url;
    link.textContent = url;
    if (url) {
      try {
        renderQRToCanvas($p('sp-qr'), url, { sizePx: 184 });
      } catch (err) {
        console.error('[phoneStream] QR render error:', err);
      }
    }
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
      const fullUrl = new URL(meta.url, serverUrl).href;
      const resp = await fetch(fullUrl, { headers: apiHeaders(), cache: 'no-store' });
      if (!resp.ok) throw new Error(`拉取照片失败（HTTP ${resp.status}）`);
      const blob = await resp.blob();
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

  const drawLiveFrame = async (blob) => {
    if (drawingLive) return;
    drawingLive = true;
    try {
      const bmp = await createImageBitmap(blob);
      const canvas = $p('sp-live-canvas');
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      if (!liveActive) {
        liveActive = true;
        updateStatusUi();
      }
      liveFpsCount++;
      const now = performance.now();
      if (!liveFpsTs) liveFpsTs = now;
      else if (now - liveFpsTs >= 1000) {
        liveFpsText = `${Math.round((liveFpsCount * 1000) / (now - liveFpsTs))} fps`;
        liveFpsCount = 0;
        liveFpsTs = now;
        $p('sp-live-badge').textContent = `LIVE${liveDims ? ' · ' + liveDims : ''} · ${liveFpsText}`;
      }
    } catch {
      // 忽略损坏帧
    } finally {
      drawingLive = false;
    }
  };

  const closeSocket = () => {
    clearTimeout(wsRetryTimer);
    clearInterval(pingTimer);
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
    if (token) params.set('token', token);
    const wsUrl = `${wsProto}//${u.host}${u.pathname.replace(/\/+$/, '')}/ws?${params.toString()}`;

    const sock = new WebSocket(wsUrl);
    sock.binaryType = 'blob';
    ws = sock;

    sock.onopen = () => {
      retryMs = 1200;
      connected = true;
      connecting = false;
      setError('');
      renderPairCard();
      updateStatusUi();
      pingTimer = setInterval(() => sendWsJson({ type: 'ping', ts: Date.now() }), 20000);
    };

    sock.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        drawLiveFrame(ev.data);
        return;
      }
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'room_state') {
        const prevPhones = phoneCount;
        phoneCount = Number(msg.phoneCount) || 0;
        phoneDevices = Array.isArray(msg.phones) ? msg.phones : [];
        if (phoneCount === 0) liveActive = false;
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
        liveActive = Boolean(msg.live);
        liveDims = msg.width && msg.height ? `${msg.width}×${msg.height}` : '';
        $p('sp-live-badge').textContent = liveActive ? `LIVE${liveDims ? ' · ' + liveDims : ''}` : 'LIVE';
        updateStatusUi();
      }
    };

    sock.onclose = () => {
      clearInterval(pingTimer);
      if (ws !== sock) return;
      ws = null;
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

  const disconnect = () => {
    connected = false;
    connecting = false;
    phoneCount = 0;
    phoneDevices = [];
    liveActive = false;
    pendingPhoto = null;
    closeSocket();
    updateStatusUi();
  };

  const connect = async ({ forceNewRoom = false } = {}) => {
    const raw = urlInput.value;
    const norm = normalizeRelayUrl(raw);
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
      if (token) localStorage.setItem(STORAGE_TOKEN, token);
      else localStorage.removeItem(STORAGE_TOKEN);
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
      if (health.authRequired && !token) {
        $p('sp-token-row').hidden = false;
        tokenInput.focus();
        throw new Error('该中转服务启用了访问口令，请填写口令后再连接。');
      }

      // 2. 创建或复用配对房间
      if (forceNewRoom || !room) {
        const roomResp = await fetch(`${serverUrl}/api/rooms`, {
          method: 'POST',
          headers: apiHeaders(),
          signal: AbortSignal.timeout(6000),
        });
        if (roomResp.status === 401) {
          $p('sp-token-row').hidden = false;
          tokenInput.focus();
          throw new Error('访问口令错误，请核对后重试。');
        }
        if (!roomResp.ok) throw new Error(`创建房间失败（HTTP ${roomResp.status}）`);
        const data = await roomResp.json();
        room = data.room;
        try { sessionStorage.setItem(SESSION_ROOM, room); } catch {}
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
  $p('sp-disconnect').addEventListener('click', () => {
    userDisconnected = true;
    disconnect();
    message('已断开手机照片串流连接', 'info');
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !connected && !connecting) {
      userDisconnected = false;
      connect();
    }
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
  $p('sp-new-room').addEventListener('click', () => {
    if (!connected) return;
    seenPhotoIds.clear();
    receivedHistory.length = 0;
    pendingPhoto = null;
    renderHistory();
    closeSocket();
    connected = false;
    connect({ forceNewRoom: true });
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
      if (!explicitUrl && !urlInput.value.trim() && !/\.github\.io$/i.test(location.hostname)) {
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
