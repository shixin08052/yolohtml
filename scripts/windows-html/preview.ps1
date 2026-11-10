param(
  [int]$Port = 17826,
  [switch]$NoBrowser,
  [string]$ReadyFile
)
$ErrorActionPreference = 'Stop'
$previewRoot = $PSScriptRoot
$previewInfo = Get-Content -LiteralPath (Join-Path $previewRoot 'release-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# 在内存中使用 Windows 自带 .NET；不生成 exe，也不需要 Node.js / Python。
# TcpListener 仅绑定本机回环，普通用户运行，不需要 HTTP URL 预留权限。
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public sealed class HtmlDemoServer : IDisposable {
    private readonly TcpListener listener;
    private readonly string root;
    private readonly string health;
    private volatile bool running;
    public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }

    public HtmlDemoServer(string directory, int port, string healthJson) {
        root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        health = healthJson;
        listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start(32);
        running = true;
        new Thread(Accept) { IsBackground = true }.Start();
    }
    private void Accept() {
        while (running) {
            try {
                TcpClient client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate { Serve(client); });
            } catch (SocketException) { if (running) Thread.Sleep(50); }
              catch (ObjectDisposedException) { return; }
        }
    }
    private static void Headers(Stream stream, int status, string type, long length) {
        string reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : "Method Not Allowed";
        string text = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type +
            "\r\nContent-Length: " + length + "\r\nConnection: close\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n" +
            (status == 405 ? "Allow: GET, HEAD\r\n" : "") + "\r\n";
        byte[] bytes = Encoding.ASCII.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
    }
    private static void Text(Stream stream, int status, string text, bool head) {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        Headers(stream, status, "text/plain; charset=utf-8", bytes.Length);
        if (!head) stream.Write(bytes, 0, bytes.Length);
    }
    private static string Mime(string path) {
        switch (Path.GetExtension(path).ToLowerInvariant()) {
            case ".html": return "text/html; charset=utf-8";
            case ".js": case ".mjs": return "text/javascript; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".wasm": return "application/wasm";
            case ".onnx": return "application/octet-stream";
            case ".png": return "image/png";
            case ".jpg": case ".jpeg": return "image/jpeg";
            case ".svg": return "image/svg+xml";
            case ".ico": return "image/x-icon";
            case ".woff": return "font/woff";
            case ".woff2": return "font/woff2";
            case ".txt": return "text/plain; charset=utf-8";
            default: return null;
        }
    }
    private void Serve(TcpClient client) {
        using (client) {
            try {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 15000;
                using (NetworkStream stream = client.GetStream()) {
                    // 限制请求头大小，不等待 Chrome 的空闲预连接阻塞其他请求。
                    byte[] buffer = new byte[16384];
                    int count = 0;
                    string request = "";
                    while (count < buffer.Length) {
                        int n = stream.Read(buffer, count, buffer.Length - count);
                        if (n == 0) return;
                        count += n;
                        request = Encoding.ASCII.GetString(buffer, 0, count);
                        if (request.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
                    }
                    int headerEnd = request.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                    if (headerEnd < 0) { Text(stream, 400, "Invalid request", false); return; }
                    string[] first = request.Split(new string[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
                    if (first.Length != 3) { Text(stream, 400, "Invalid request", false); return; }
                    bool head = first[0] == "HEAD";
                    if (first[0] != "GET" && !head) { Text(stream, 405, "GET and HEAD only", false); return; }
                    // 拒绝其他 Host，服务始终只给本机浏览器访问。
                    string[] lines = request.Substring(0, headerEnd).Split(new string[] { "\r\n" }, StringSplitOptions.None);
                    string host = null;
                    foreach (string line in lines) if (line.StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) host = line.Substring(5).Trim();
                    if (!String.Equals(host, "127.0.0.1:" + Port, StringComparison.OrdinalIgnoreCase) &&
                        !String.Equals(host, "localhost:" + Port, StringComparison.OrdinalIgnoreCase)) { Text(stream, 403, "Local access only", head); return; }
                    string path = Uri.UnescapeDataString(first[1].Split('?')[0]);
                    if (!path.StartsWith("/", StringComparison.Ordinal) || path.IndexOf('\\') >= 0 || path.IndexOf('\0') >= 0 || path.IndexOf(':') >= 0) {
                        Text(stream, 403, "Invalid path", head); return;
                    }
                    foreach (string segment in path.Split('/')) if (segment == "..") { Text(stream, 403, "Invalid path", head); return; }
                    if (path == "/__demo_health") {
                        byte[] bytes = Encoding.UTF8.GetBytes(health);
                        Headers(stream, 200, "application/json; charset=utf-8", bytes.Length);
                        if (!head) stream.Write(bytes, 0, bytes.Length);
                        return;
                    }
                    string file = Path.GetFullPath(Path.Combine(root, path == "/" ? "index.html" : path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
                    if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) { Text(stream, 403, "Invalid path", head); return; }
                    string type = Mime(file);
                    if (type == null || !File.Exists(file)) { Text(stream, 404, "Not found", head); return; }
                    using (FileStream input = File.OpenRead(file)) {
                        Headers(stream, 200, type, input.Length);
                        if (!head) input.CopyTo(stream);
                    }
                }
            } catch (IOException) { }
              catch (SocketException) { }
              catch (Exception) { /* 单个请求失败不终止展示服务。 */ }
        }
    }
    public void Dispose() { running = false; listener.Stop(); }
}
'@

$previewServer = $null
try {
  $previewHealth = @{ app = 'sorting-twin-html'; version = $previewInfo.version } | ConvertTo-Json -Compress
  for ($previewAttempt = 0; $previewAttempt -lt 10; $previewAttempt++) {
    try {
      $previewServer = New-Object HtmlDemoServer($previewRoot, ($Port + $previewAttempt), $previewHealth)
      break
    } catch {
      if ($Port -eq 0 -or $previewAttempt -eq 9) { throw }
    }
  }
  $previewUrl = 'http://127.0.0.1:' + $previewServer.Port + '/'
  if ($ReadyFile) {
    @{ url = $previewUrl; version = $previewInfo.version } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyFile -Encoding UTF8
  }
  Write-Host ''
  Write-Host ('  视觉分拣数字孪生 · HTML 展示版 v' + $previewInfo.version) -ForegroundColor Cyan
  Write-Host ''
  Write-Host ('  演示页面：' + $previewUrl + '?demo')
  Write-Host ('  完整模式：' + $previewUrl + '?demo=0')
  Write-Host ('  打印底板：' + $previewUrl + 'board.html')
  Write-Host ''
  Write-Host '  展示时保持此窗口运行，可以最小化。结束展示时关闭窗口即可。'
  Write-Host '  模型识别和分拣可离线运行；DeepSeek 助手需要联网和 API Key。'
  Write-Host ''
  if (!$NoBrowser) { Start-Process ($previewUrl + '?demo') }
  while ($true) { Start-Sleep -Milliseconds 250 }
} catch {
  Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($previewServer) { $previewServer.Dispose() }
}
