#!/usr/bin/env bash
# 视觉分拣数字孪生 · 手机照片串流中转服务 一键安装脚本（Linux / systemd）
# 兼容 Ubuntu / Debian / CentOS / Rocky / Alma / Alibaba Cloud Linux
#
# 常用用法：
#   1) 仅安装轻量中转服务（纯 IP HTTP，默认 8787 端口）：
#      sudo bash install.sh
#
#   2) 安装中转服务 + 同时托管网页端（任意电脑直接打开 http://服务器IP:8787 即可使用）：
#      sudo bash install.sh --with-web
#
#   3) 自定义端口 / 访问口令：
#      sudo bash install.sh --port 8787 --token mysecret
#
#   4) 升级为 HTTPS/WSS（自动配置 Caddy 免费证书，支持 GitHub Pages 直连与实时视频取景）：
#      sudo bash install.sh --https cam.yourdomain.com
#      （若暂无域名，也可尝试免配置泛解析域名：--https <IP横线形式>.sslip.io）
#
#   5) 卸载：
#      sudo bash install.sh --uninstall

set -euo pipefail

APP_NAME="sorting-twin-relay"
INSTALL_DIR="/opt/${APP_NAME}"
ENV_FILE="/etc/${APP_NAME}.env"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
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
      sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $1（使用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

log() { printf '\033[1;36m[relay]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[ERR ]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    err "请使用 root 或 sudo 运行本脚本（例如：sudo bash install.sh）"
  fi
}

if [[ "$ACTION" == "status" ]]; then
  systemctl status "${APP_NAME}" --no-pager || true
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    echo ""
    curl -fsS "http://127.0.0.1:${PORT:-8787}/api/health" && echo "" || warn "健康检查未响应"
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
  ok "已卸载 ${APP_NAME}（如曾配置 Caddy，请按需手动清理 /etc/caddy/Caddyfile）"
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

ensure_cmd() {
  local cmd="$1" pkg="$2"
  if command -v "$cmd" >/dev/null 2>&1; then return 0; fi
  log "正在安装依赖 ${pkg}..."
  case "$PKG" in
    apt) apt-get update -qq && apt-get install -y -qq "$pkg" ;;
    dnf) dnf install -y -q "$pkg" ;;
    yum) yum install -y -q "$pkg" ;;
    *) err "缺少命令 ${cmd} 且无法自动识别包管理器，请手动安装 ${pkg}" ;;
  esac
}

ensure_cmd curl curl
ensure_cmd ca-certificates ca-certificates || true

# 2. 检查或安装 Node.js >= 18（优先安装 Node.js 20 LTS）
need_node=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    need_node=0
    ok "检测到 Node.js $(node -v)"
  else
    warn "当前 Node.js 版本 $(node -v) 低于 18，将自动升级为 Node.js 20 LTS..."
  fi
fi

if [[ "$need_node" -eq 1 ]]; then
  log "正在安装 Node.js 20 LTS..."
  case "$PKG" in
    apt)
      apt-get update -qq
      apt-get install -y -qq curl gnupg ca-certificates
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      "$PKG" install -y -q nodejs
      ;;
    *)
      err "请先手动安装 Node.js >= 18 后再重新执行脚本"
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
    curl -fsSL "${RAW_BASE}/${f}" -o "${INSTALL_DIR}/${f}"
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

# 5. 创建系统服务账号（无登录 shell）并配置环境变量
SERVICE_USER="sorting-relay"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}" 2>/dev/null || SERVICE_USER="root"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}" 2>/dev/null || true

LISTEN_HOST="$HOST"
if [[ -n "$HTTPS_DOMAIN" ]]; then
  # 启用 Caddy HTTPS 反代时，Node 仅监听本机回环端口，由 Caddy 对外提供 80/443
  LISTEN_HOST="127.0.0.1"
fi

cat > "${ENV_FILE}" <<EOF
PORT=${PORT}
HOST=${LISTEN_HOST}
RELAY_TOKEN=${TOKEN}
WEB_DIR=${WEB_DIR}
EOF
chmod 600 "${ENV_FILE}"

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

# 6. 可选：配置 Caddy 自动 HTTPS / WSS
if [[ -n "$HTTPS_DOMAIN" ]]; then
  log "正在为域名 ${HTTPS_DOMAIN} 配置 Caddy 自动 HTTPS/WSS..."
  if ! command -v caddy >/dev/null 2>&1; then
    case "$PKG" in
      apt)
        apt-get update -qq
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        apt-get update -qq && apt-get install -y -qq caddy
        ;;
      dnf|yum)
        "$PKG" install -y -q 'dnf-command(copr)' 2>/dev/null || true
        dnf copr enable -y @caddy/caddy 2>/dev/null || true
        "$PKG" install -y -q caddy
        ;;
      *)
        err "请先手动安装 Caddy 后重新执行 --https"
        ;;
    esac
  fi
  mkdir -p /etc/caddy
  cat > /etc/caddy/Caddyfile <<EOF
${HTTPS_DOMAIN} {
    encode gzip
    request_body {
        max_size 30MB
    }
    reverse_proxy 127.0.0.1:${PORT}
}
EOF
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  ok "Caddy HTTPS 反向代理已启动（自动申请免费 TLS 证书）"
fi

# 7. 自动放行本机防火墙（若已启用 ufw / firewalld）
open_port() {
  local p="$1"
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
    ufw allow "${p}/tcp" >/dev/null 2>&1 || true
    log "已通过 ufw 放行 TCP ${p}"
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="${p}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    log "已通过 firewalld 放行 TCP ${p}"
  fi
}

if [[ -n "$HTTPS_DOMAIN" ]]; then
  open_port 80
  open_port 443
else
  open_port "${PORT}"
fi

# 8. 健康检查
sleep 1
if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  warn "服务启动异常，请查看日志：journalctl -u ${APP_NAME} -n 50 --no-pager"
  exit 1
fi

PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo ""
ok "视觉分拣 · 手机照片串流中转服务安装成功！"
echo "================================================================"
if [[ -n "$HTTPS_DOMAIN" ]]; then
  BASE_URL="https://${HTTPS_DOMAIN}"
  echo "  中转服务地址（HTTPS/WSS）： ${BASE_URL}"
  echo "  手机端扫码入口：            ${BASE_URL}/m"
  echo "  支持功能：原图拍照直传 + 实时视频取景串流 + GitHub Pages 直连"
  echo "  防火墙提醒：请在云服务器安全组放行 TCP 80 和 443 端口"
else
  BASE_URL="http://${PUBLIC_IP}:${PORT}"
  echo "  中转服务地址（纯 IP HTTP）：${BASE_URL}"
  echo "  手机端扫码入口：            ${BASE_URL}/m"
  echo "  健康检查：                  ${BASE_URL}/api/health"
  echo "  防火墙提醒：请在云服务器安全组放行 TCP ${PORT} 端口"
fi
if [[ -n "$WEB_DIR" ]]; then
  echo "  电脑端完整界面（已托管）：  ${BASE_URL}/"
  echo "  电脑端演示模式（已托管）：  ${BASE_URL}/?demo"
else
  echo "  提示：如需把网页端也直接部署在这台服务器上，运行："
  echo "        sudo bash install.sh --with-web"
fi
if [[ -n "$TOKEN" ]]; then
  echo "  访问口令：已启用（需在电脑端中转设置里填入相同口令）"
fi
echo ""
echo "  常用运维命令："
echo "    查看日志：journalctl -u ${APP_NAME} -f"
echo "    重启服务：systemctl restart ${APP_NAME}"
echo "    检查状态：systemctl status ${APP_NAME}"
echo "================================================================"
