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

### 方案 A：纯 IP 直连 + 同时托管网页端（推荐，无域名即可完整使用）

在云服务器安全组放行 **TCP 8787**，然后 SSH 登录服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash -s -- --with-web
```

安装完成后，任意电脑打开 `http://<你的服务器IP>:8787/`（演示模式 `http://<你的服务器IP>:8787/?demo`），点击顶栏 **「手机串流」** 即可自动识别中转服务并弹出二维码，手机微信或相机扫码即可连拍。

### 方案 B：仅运行轻量中转服务（搭配本机展示包使用）

如果你在展示电脑上运行本机离线展示包（`启动展示.cmd`，打开 `http://127.0.0.1:17826/`），服务器只需跑极轻量的中转程序（内存占用 < 40 MB）：

```bash
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash
```

然后在电脑页面的「手机串流」中填入 `http://<你的服务器IP>:8787` 即可（仅传输照片，模型与 3D 资源完全走本机，零公网带宽消耗）。

### 方案 C：开启 HTTPS / WSS（支持 GitHub Pages 直连 + 手机实时视频取景）

如果希望从 `https://shixin08052.github.io/yolohtml/` 直接连入，或启用手机浏览器 **实时取景串流**：

- 任意域名（无论国外还是国内 DNS 提供商，海外服务器均无需备案），添加一条 `A` 记录指向服务器 IP，放行 **TCP 80 与 443** 后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/shixin08052/yolohtml/main/server/install.sh | sudo bash -s -- --https cam.yourdomain.com --with-web
```

脚本会自动安装 Caddy 并申请免费 Let's Encrypt 证书。

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
