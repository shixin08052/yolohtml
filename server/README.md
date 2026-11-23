# 手机照片串流中转服务（Linux 一键部署）

为「视觉分拣数字孪生」提供手机到电脑的跨网络照片串流能力，零第三方 npm 依赖（仅需 Node.js >= 18）。

## 支持的双模式

1. **原图拍照 / 相册直传（默认，纯 IP HTTP 即可用）**
   - 手机扫码后调用原生相机拍照或从相册选图，原始 JPEG/PNG 字节（完整保留 1200 万像素与 EXIF 焦距信息）经 HTTP POST 推送到电脑并自动触发识别与 3D 建模。
   - 电脑识别进度与元件数量会实时回显到手机屏幕上。
2. **实时取景串流 + 远程快门（HTTPS 下可用）**
   - 手机实时向电脑推送后置摄像头取景画面，支持电脑端与手机端一键触发高清抓拍识别。
   - 受 iOS / Android 浏览器安全策略限制，实时摄像头调用需要通过 `https://` 访问。

## 快速安装（Linux 服务器）

### 方案 A：HTTPS / WSS 域名模式（推荐，支持 GitHub Pages / 展示包一键直连 + 实时视频取景）

确认域名（如 `forward.davidshi.codes`）已添加 `A` 记录指向服务器 IP，并在云服务器安全组放行 **TCP 80 与 443**，然后 SSH 登录服务器执行：

```bash
# 仅跑轻量中转服务（推荐搭配 GitHub Pages 或本机展示包，服务器内存占用 < 40 MB）
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash -s -- --https forward.davidshi.codes
```

如果想让 `https://forward.davidshi.codes/` 同时直接托管电脑端网页界面，加上 `--with-web`：

```bash
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash -s -- --https forward.davidshi.codes --with-web
```

脚本会自动完成：
- 安装 Node.js 22 LTS 与中转服务（`systemd` 守护 + 开机自启）；
- 自动放行本机 `ufw` / `firewalld` 的 80 与 443 端口；
- 若 80/443 空闲，自动安装 Caddy（含静态二进制兜底）并向 Let's Encrypt 申请免费 HTTPS 证书，同时保护 `/etc/caddy/Caddyfile` 已有站点；
- 若 80/443 已被现有 Nginx 占用，自动生成可直接引用的 Nginx 反代模板 `/opt/sorting-twin-relay/nginx-<域名>.conf` 并给出接入指引，绝不破坏已有网站。

### 方案 B：纯 IP 直连（无域名时使用）

在云服务器安全组放行 **TCP 8787**，然后 SSH 登录服务器执行：

```bash
# 纯 IP + 同时托管网页端
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash -s -- --with-web

# 或仅跑轻量中转（搭配本机离线展示包 http://127.0.0.1:17826/）
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash
```

## 电脑密钥与一次性扫码配对

在 `/etc/sorting-twin-relay.env` 中设置 `RELAY_ACCESS_KEY`，使用随机生成的高强度密钥（例如 `openssl rand -hex 32` 的输出），然后重启 `sorting-twin-relay`。电脑在「手机串流」中输入密钥后创建房间，手机扫描二维码进入，可继续使用原图直传、实时取景和远程快门。此模式需要配套的新版电脑端，公网访问使用 HTTPS。

二维码 5 分钟内有效且只能兑换一次。每个房间可配对一台手机，短线重连可继续使用原会话。电脑点「重新配对」可撤销手机权限并生成新二维码，点「断开」会关闭整个房间。房间会话最长 8 小时。设置 `RELAY_ACCESS_KEY` 后，旧 `RELAY_TOKEN` 不再用于鉴权。

## 可选参数

| 参数 | 说明 |
| --- | --- |
| `--port 8787` | 指定监听端口（默认 `8787`） |
| `--token <口令>` | 启用访问口令，防止公网陌生人使用中转服务 |
| `--with-web` | 自动构建并由中转服务托管前端页面 |
| `--https <域名>` | 自动配置 Caddy HTTPS/WSS 反向代理 |
| `--status` | 查看运行状态与健康检查 |
| `--uninstall` | 停止并彻底卸载服务 |

## 常用运维命令

```bash
# 查看实时日志
journalctl -u sorting-twin-relay -f

# 重启 / 停止服务
sudo systemctl restart sorting-twin-relay
sudo systemctl stop sorting-twin-relay

# 验证健康状态
curl http://127.0.0.1:8787/api/health
```
