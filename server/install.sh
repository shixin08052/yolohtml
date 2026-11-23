#!/usr/bin/env bash
# 视觉分拣数字孪生 · 手机照片串流中转服务 一键安装脚本（Linux / systemd）
# 兼容 Ubuntu / Debian / CentOS / Rocky / Alma / Alibaba Cloud Linux（x86_64 & arm64）
#
# 常用用法：
#   1) 开启 HTTPS/WSS 域名模式（推荐，自动申请免费 TLS 证书，支持 GitHub Pages 直连 + 实时取景）：
#      sudo bash install.sh --https forward.davidshi.codes
#
#   2) 开启 HTTPS/WSS + 同时在同域名托管电脑端网页界面：
#      sudo bash install.sh --https forward.davidshi.codes --with-web
#
#   3) 仅安装轻量中转服务（纯 IP HTTP，默认 8787 端口）：
#      sudo bash install.sh
#
#   4) 自定义端口 / 访问口令：
#      sudo bash install.sh --https forward.davidshi.codes --token mysecret
#
#   5) 查看状态 / 卸载：
#      sudo bash install.sh --status
#      sudo bash install.sh --uninstall

set -euo pipefail

APP_NAME="sorting-twin-relay"
INSTALL_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
CADDY_CONF_DIR="/etc/caddy/conf.d"
CADDY_SITE_FILE="${CADDY_CONF_DIR}/${APP_NAME}.caddy"
REPO_URL="https://github.com/shixin08052/yolohtml.git"
RAW_BASE="https://raw.githubusercontent.com/shixin08052/yolohtml/main/server"

PORT="8787"
HOST="0.0.0.0"
TOKEN=""
WITH_WEB="0"
HTTPS_DOMAIN=""
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)
      PORT="${2:-8787}"
      shift 2
      ;;
    --host)
      HOST="${2:-0.0.0.0}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --with-web)
      WITH_WEB="1"
      shift
      ;;
    --https)
      HTTPS_DOMAIN="${2:-}"
      shift 2
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $1（使用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

# 规范化 --https 域名（容忍不小心带上 https:// 或末尾斜杠）
if [[ -n "$HTTPS_DOMAIN" ]]; then
  HTTPS_DOMAIN="${HTTPS_DOMAIN#http://}"
  HTTPS_DOMAIN="${HTTPS_DOMAIN#https://}"
  HTTPS_DOMAIN="${HTTPS_DOMAIN%%/*}"
  HTTPS_DOMAIN="$(printf '%s' "$HTTPS_DOMAIN" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
fi

log() { printf '\033[1;36m[relay]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[ERR ]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    err "请使用 root 或 sudo 运行本脚本（例如：sudo bash install.sh --https 你的域名）"
  fi
}

if [[ "$ACTION" == "status" ]]; then
  systemctl status "${APP_NAME}" --no-pager || true
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    echo ""
    log "本机健康检查（http://127.0.0.1:${PORT:-8787}/api/health）："
    curl -fsS --max-time 4 "http://127.0.0.1:${PORT:-8787}/api/health" && echo "" || warn "本机健康检查未响应"
  fi
  if [[ -f "${CADDY_SITE_FILE}" ]]; then
    echo ""
    systemctl status caddy --no-pager -n 10 || true
    DOM="$(awk '/^[^#[:space:]]+[[:space:]]*\{/ {print $1; exit}' "${CADDY_SITE_FILE}" || true)"
    if [[ -n "$DOM" ]]; then
      echo ""
      log "HTTPS 健康检查（https://${DOM}/api/health）："
      curl -fsS --max-time 6 "https://${DOM}/api/health" && echo "" || warn "HTTPS 健康检查未响应"
    fi
  fi
  exit 0
fi

if [[ "$ACTION" == "uninstall" ]]; then
  require_root
  log "正在停止并卸载 ${APP_NAME}..."
  systemctl stop "${APP_NAME}" 2>/dev/null || true
  systemctl disable "${APP_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}" "${ENV_FILE}"
  systemctl daemon-reload
  rm -rf "${INSTALL_DIR}"
  if [[ -f "${CADDY_SITE_FILE}" ]]; then
    rm -f "${CADDY_SITE_FILE}"
    if systemctl is-active --quiet caddy 2>/dev/null; then
      systemctl reload caddy 2>/dev/null || true
    fi
    log "已移除 Caddy 站点配置 ${CADDY_SITE_FILE}"
  fi
  ok "已卸载 ${APP_NAME}"
  exit 0
fi

require_root

# 1. 检测包管理器并安装基础工具
PKG=""
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
fi

pkg_install() {
  case "$PKG" in
    apt) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    *) return 1 ;;
  esac
}

ensure_cmd() {
  local cmd="$1" pkg="$2"
  if command -v "$cmd" >/dev/null 2>&1; then return 0; fi
  log "正在安装依赖 ${pkg}..."
  pkg_install "$pkg" || err "缺少命令 ${cmd} 且无法自动安装 ${pkg}，请手动安装后重试"
}

ensure_cmd curl curl
if [[ ! -f /etc/ssl/certs/ca-certificates.crt && ! -f /etc/pki/tls/certs/ca-bundle.crt ]]; then
  log "正在安装 CA 根证书..."
  pkg_install ca-certificates || true
fi

# 2. 检查或安装 Node.js（中转服务需 >= 18，启用 --with-web 构建前端需 >= 20.19；自动安装 Node.js 22 LTS）
need_node=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  NODE_MINOR="$(node -p "process.versions.node.split('.')[1]" 2>/dev/null || echo 0)"
  if [[ "$WITH_WEB" == "1" ]]; then
    if [[ "$NODE_MAJOR" -gt 20 || ( "$NODE_MAJOR" -eq 20 && "$NODE_MINOR" -ge 19 ) ]]; then
      need_node=0
      ok "检测到 Node.js $(node -v)"
    else
      warn "当前 Node.js $(node -v) 低于前端构建要求的 20.19+，将自动升级为 Node.js 22 LTS..."
    fi
  elif [[ "$NODE_MAJOR" -ge 18 ]]; then
    need_node=0
    ok "检测到 Node.js $(node -v)"
  else
    warn "当前 Node.js 版本 $(node -v) 低于 18，将自动升级为 Node.js 22 LTS..."
  fi
fi

if [[ "$need_node" -eq 1 ]]; then
  log "正在安装 Node.js 22 LTS..."
  case "$PKG" in
    apt)
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl gnupg ca-certificates
      curl -fsSL --retry 3 https://deb.nodesource.com/setup_22.x | bash -
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
      ;;
    dnf|yum)
      curl -fsSL --retry 3 https://rpm.nodesource.com/setup_22.x | bash -
      "$PKG" install -y -q nodejs
      ;;
    *)
      err "请先手动安装 Node.js >= 20 后再重新执行脚本"
      ;;
  esac
  ok "Node.js $(node -v) 安装完成"
fi

# 3. 准备服务端程序文件
mkdir -p "${INSTALL_DIR}"
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/relay-server.mjs" && -f "${SCRIPT_DIR}/ws.mjs" && -f "${SCRIPT_DIR}/mobile-standalone.html" ]]; then
  log "从本地目录复制中转服务文件..."
  cp -f "${SCRIPT_DIR}/relay-server.mjs" "${SCRIPT_DIR}/ws.mjs" "${SCRIPT_DIR}/mobile-standalone.html" "${INSTALL_DIR}/"
else
  log "从 GitHub 下载中转服务文件..."
  for f in relay-server.mjs ws.mjs mobile-standalone.html; do
    curl -fsSL --retry 3 --retry-delay 2 "${RAW_BASE}/${f}" -o "${INSTALL_DIR}/${f}"
  done
fi
chmod +x "${INSTALL_DIR}/relay-server.mjs"

# 4. 可选：部署静态网页前端（--with-web 或本地已有 ../dist）
WEB_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/../dist/index.html" ]]; then
  log "检测到本地 dist 产物，同步到 ${INSTALL_DIR}/web ..."
  rm -rf "${INSTALL_DIR}/web"
  cp -r "${SCRIPT_DIR}/../dist" "${INSTALL_DIR}/web"
  WEB_DIR="${INSTALL_DIR}/web"
elif [[ "$WITH_WEB" == "1" ]]; then
  ensure_cmd git git
  log "正在拉取前端仓库并构建静态网页（首次约需 1-2 分钟）..."
  if [[ -d "${INSTALL_DIR}/repo/.git" ]]; then
    git -C "${INSTALL_DIR}/repo" fetch --depth 1 origin main
    git -C "${INSTALL_DIR}/repo" reset --hard origin/main
  else
    rm -rf "${INSTALL_DIR}/repo"
    git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}/repo"
  fi
  (
    cd "${INSTALL_DIR}/repo"
    NODE_OPTIONS="--max-old-space-size=1024" npm ci --no-audit --no-fund
    NODE_OPTIONS="--max-old-space-size=1024" npm run build
  )
  rm -rf "${INSTALL_DIR}/web"
  cp -r "${INSTALL_DIR}/repo/dist" "${INSTALL_DIR}/web"
  WEB_DIR="${INSTALL_DIR}/web"
  ok "前端静态页面构建完成并已集成"
elif [[ -f "${INSTALL_DIR}/web/index.html" ]]; then
  WEB_DIR="${INSTALL_DIR}/web"
fi

# 5. 创建系统服务账号（无登录 shell）并配置 systemd 服务
SERVICE_USER="sorting-relay"
NOLOGIN_BIN="$(command -v nologin || echo /sbin/nologin)"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell "${NOLOGIN_BIN}" "${SERVICE_USER}" 2>/dev/null || SERVICE_USER="root"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}" 2>/dev/null || true

LISTEN_HOST="$HOST"
if [[ -n "$HTTPS_DOMAIN" ]]; then
  # 启用 HTTPS 反向代理时，Node 仅监听本机回环端口，由反向代理对外提供 80/443
  LISTEN_HOST="127.0.0.1"
fi

ENV_TMP="$(mktemp "${ENV_FILE}.XXXXXXXX")"
cat > "${ENV_TMP}" <<EOF
PORT=${PORT}
HOST=${LISTEN_HOST}
RELAY_TOKEN=${TOKEN}
WEB_DIR=${WEB_DIR}
EOF
if [[ -f "${ENV_FILE}" ]]; then
  awk '/^RELAY_ACCESS_KEY=/ { key=$0 } END { if (key) print key }' "${ENV_FILE}" >> "${ENV_TMP}"
fi
chmod 600 "${ENV_TMP}"
mv -f "${ENV_TMP}" "${ENV_FILE}"

NODE_BIN="$(command -v node)"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Sorting Twin Mobile Photo Stream Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/relay-server.mjs
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null 2>&1
systemctl restart "${APP_NAME}"

# 6. 验证本机中转服务健康状态（最多等待 6 秒）
LOCAL_OK=0
for _ in 1 2 3 4 5 6; do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    LOCAL_OK=1
    break
  fi
  sleep 1
done
if [[ "$LOCAL_OK" -ne 1 ]]; then
  warn "中转服务启动异常，请查看日志：journalctl -u ${APP_NAME} -n 50 --no-pager"
  exit 1
fi
ok "中转服务已在 ${LISTEN_HOST}:${PORT} 启动并通过健康检查"

# 7. 自动放行本机防火墙（先放行再启动 Caddy，确保首次 ACME 申请证书不被拦截）
open_port() {
  local p="$1" proto="${2:-tcp}"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
    ufw allow "${p}/${proto}" >/dev/null 2>&1 || true
    log "已通过 ufw 放行 ${proto^^} ${p}"
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="${p}/${proto}" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    log "已通过 firewalld 放行 ${proto^^} ${p}"
  fi
}

if [[ -n "$HTTPS_DOMAIN" ]]; then
  open_port 80 tcp
  open_port 443 tcp
  open_port 443 udp
else
  open_port "${PORT}" tcp
fi

PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"

# 8. 可选：配置 Caddy 自动 HTTPS / WSS（含 80/443 端口冲突检测与已有站点保护）
HTTPS_READY=0
PORT_CONFLICT=""

find_port_conflict() {
  local out=""
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -tlnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print}' | grep -vi 'caddy' || true)"
  elif command -v netstat >/dev/null 2>&1; then
    out="$(netstat -tlnp 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print}' | grep -vi 'caddy' || true)"
  fi
  printf '%s' "$out"
}

ensure_caddy_systemd() {
  local caddy_bin
  caddy_bin="$(command -v caddy)"
  if ! systemctl list-unit-files caddy.service 2>/dev/null | grep -q '^caddy\.service'; then
    getent group caddy >/dev/null 2>&1 || groupadd --system caddy
    id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell "${NOLOGIN_BIN}" caddy
    mkdir -p /etc/caddy /var/lib/caddy
    chown -R caddy:caddy /var/lib/caddy
    cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=${caddy_bin} run --environ --config /etc/caddy/Caddyfile
ExecReload=${caddy_bin} reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
  fi
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    ok "检测到 Caddy $(caddy version 2>/dev/null | awk '{print $1}')"
    ensure_caddy_systemd
    return 0
  fi
  log "正在安装 Caddy（自动申请与续期免费 Let's Encrypt HTTPS 证书）..."
  local installed=0
  case "$PKG" in
    apt)
      if apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg curl \
        && curl -1sLf --retry 3 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
        && curl -1sLf --retry 3 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
        && chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list \
        && apt-get update -qq \
        && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy; then
        installed=1
      fi
      ;;
    dnf)
      if dnf install -y -q 'dnf-command(copr)' 2>/dev/null \
        && dnf copr enable -y @caddy/caddy 2>/dev/null \
        && dnf install -y -q caddy; then
        installed=1
      fi
      ;;
  esac

  if [[ "$installed" -eq 0 ]]; then
    warn "包管理器安装 Caddy 未成功，改用官方预编译二进制安装..."
    local arch
    case "$(uname -m)" in
      x86_64|amd64) arch="amd64" ;;
      aarch64|arm64) arch="arm64" ;;
      *) err "不支持的 CPU 架构 $(uname -m)，请手动安装 Caddy" ;;
    esac
    curl -fsSL --retry 3 --retry-delay 2 "https://caddyserver.com/api/download?os=linux&arch=${arch}" -o /usr/local/bin/caddy
    chmod 755 /usr/local/bin/caddy
  fi

  command -v caddy >/dev/null 2>&1 || err "Caddy 安装失败，请检查网络连接后重试"
  ensure_caddy_systemd
  ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}') 安装完成"
}

write_nginx_template() {
  local tpl="${INSTALL_DIR}/nginx-${HTTPS_DOMAIN}.conf"
  cat > "${tpl}" <<EOF
# 适用于已有 Nginx 的服务器：复制到 /etc/nginx/conf.d/ 或 /etc/nginx/sites-enabled/
# 然后执行：nginx -t && systemctl reload nginx && certbot --nginx -d ${HTTPS_DOMAIN}
server {
    listen 80;
    listen [::]:80;
    server_name ${HTTPS_DOMAIN};

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
  echo "${tpl}"
}

if [[ -n "$HTTPS_DOMAIN" ]]; then
  RESOLVED_IP="$(node -e "import('node:dns').then(d=>d.lookup('${HTTPS_DOMAIN}',{family:4},(e,a)=>{if(!e&&a)console.log(a)}))" 2>/dev/null || true)"
  if [[ -n "$RESOLVED_IP" ]]; then
    if [[ "$RESOLVED_IP" == "$PUBLIC_IP" ]]; then
      ok "域名解析已生效：${HTTPS_DOMAIN} -> ${RESOLVED_IP}"
    else
      warn "域名 ${HTTPS_DOMAIN} 当前解析到 ${RESOLVED_IP}，本机公网 IP 为 ${PUBLIC_IP}（如经过 CDN/NAT 请确认 80/443 可回源）"
    fi
  else
    warn "暂未解析到 ${HTTPS_DOMAIN} 的 A 记录，Caddy 证书签发可能稍后重试生效"
  fi

  PORT_CONFLICT="$(find_port_conflict)"
  if [[ -n "$PORT_CONFLICT" ]]; then
    NGINX_TPL="$(write_nginx_template)"
    warn "检测到 80/443 端口已被其他服务占用，为避免影响现有站点，未自动启动 Caddy："
    echo "${PORT_CONFLICT}"
    echo ""
    echo "================================================================"
    echo "  Node 中转服务已成功运行在 127.0.0.1:${PORT}！"
    echo "  接下来请任选一种方式完成 ${HTTPS_DOMAIN} 的 HTTPS 接入："
    echo ""
    echo "  方式 1（保留现有 Nginx）："
    echo "    已生成反代配置模板：${NGINX_TPL}"
    echo "    sudo cp ${NGINX_TPL} /etc/nginx/conf.d/${APP_NAME}.conf"
    echo "    sudo nginx -t && sudo systemctl reload nginx"
    echo "    sudo certbot --nginx -d ${HTTPS_DOMAIN}"
    echo ""
    echo "  方式 2（若原 80/443 服务无需使用，改由 Caddy 自动签证书）："
    echo "    先停用占用 80/443 的服务（如 sudo systemctl disable --now nginx apache2），"
    echo "    再重新执行本安装脚本即可全自动启用 HTTPS。"
    echo "================================================================"
    exit 0
  fi

  install_caddy
  mkdir -p /etc/caddy "${CADDY_CONF_DIR}"

  cat > "${CADDY_SITE_FILE}" <<EOF
# managed by ${APP_NAME}
${HTTPS_DOMAIN} {
    encode zstd gzip
    request_body {
        max_size 30MB
    }
    reverse_proxy 127.0.0.1:${PORT}
}
EOF

  if [[ ! -s /etc/caddy/Caddyfile ]] \
    || grep -q "# managed by ${APP_NAME}" /etc/caddy/Caddyfile 2>/dev/null \
    || grep -q "/usr/share/caddy" /etc/caddy/Caddyfile 2>/dev/null; then
    cat > /etc/caddy/Caddyfile <<EOF
# managed by ${APP_NAME}
import ${CADDY_CONF_DIR}/*.caddy
EOF
  elif grep -Eq "(^|[[:space:]])${HTTPS_DOMAIN}([[:space:]]|\{|$)" /etc/caddy/Caddyfile 2>/dev/null; then
    warn "/etc/caddy/Caddyfile 中已存在 ${HTTPS_DOMAIN} 配置，已跳过重复写入（请确保反代到 127.0.0.1:${PORT}）"
    rm -f "${CADDY_SITE_FILE}"
  elif ! grep -q "import ${CADDY_CONF_DIR}/\*.caddy" /etc/caddy/Caddyfile 2>/dev/null; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
    printf '\n# managed by %s\nimport %s/*.caddy\n' "${APP_NAME}" "${CADDY_CONF_DIR}" >> /etc/caddy/Caddyfile
    log "已备份原 Caddyfile 并以无侵入方式引入 ${CADDY_SITE_FILE}"
  fi

  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  systemctl enable caddy >/dev/null 2>&1
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl restart caddy
  fi
  ok "Caddy 已加载 ${HTTPS_DOMAIN} 配置，正在自动申请 Let's Encrypt 免费 TLS 证书..."

  for _ in $(seq 1 12); do
    if curl -fsS --max-time 4 "https://${HTTPS_DOMAIN}/api/health" >/dev/null 2>&1; then
      HTTPS_READY=1
      break
    fi
    sleep 2
  done

  if [[ "$HTTPS_READY" -eq 1 ]]; then
    ok "HTTPS/TLS 证书签发完成，https://${HTTPS_DOMAIN}/api/health 响应正常！"
  else
    warn "HTTPS 证书仍在签发或云安全组尚未放行 80/443（可稍后执行 curl https://${HTTPS_DOMAIN}/api/health 或 journalctl -u caddy -n 40 查看）"
  fi
fi

echo ""
ok "视觉分拣 · 手机照片串流中转服务安装成功！"
echo "================================================================"
if [[ -n "$HTTPS_DOMAIN" ]]; then
  BASE_URL="https://${HTTPS_DOMAIN}"
  echo "  中转服务地址（HTTPS/WSS）： ${BASE_URL}"
  echo "  手机端扫码入口：            ${BASE_URL}/m"
  echo "  健康检查：                  ${BASE_URL}/api/health"
  echo "  支持功能：原图拍照直传 + 实时视频取景串流 + GitHub Pages / 展示包一键直连"
  echo "  安全组提醒：请确保云服务器安全组已放行 TCP 80 和 443 端口"
else
  BASE_URL="http://${PUBLIC_IP}:${PORT}"
  echo "  中转服务地址（纯 IP HTTP）：${BASE_URL}"
  echo "  手机端扫码入口：            ${BASE_URL}/m"
  echo "  健康检查：                  ${BASE_URL}/api/health"
  echo "  安全组提醒：请在云服务器安全组放行 TCP ${PORT} 端口"
fi
if [[ -n "$WEB_DIR" ]]; then
  echo "  电脑端完整界面（已托管）：  ${BASE_URL}/"
  echo "  电脑端演示模式（已托管）：  ${BASE_URL}/?demo"
else
  echo "  提示：电脑端可直接打开 GitHub Pages 或本机展示包，点「手机串流」一键连接；"
  echo "        如需把网页端也托管在此服务器，加 --with-web 重跑脚本即可。"
fi
if [[ -n "$TOKEN" ]]; then
  echo "  访问口令：已启用（需在电脑端中转设置里填入相同口令）"
fi
echo ""
echo "  常用运维命令："
echo "    查看中转日志：journalctl -u ${APP_NAME} -f"
if [[ -n "$HTTPS_DOMAIN" ]]; then
  echo "    查看证书日志：journalctl -u caddy -n 40 --no-pager"
fi
echo "    重启中转服务：systemctl restart ${APP_NAME}"
echo "    一键健康自检：curl -fsSL ${RAW_BASE}/install.sh | sudo bash -s -- --status"
echo "================================================================"
