import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyHtmlRelease } from './verify-html-release.mjs';

if (process.platform !== 'win32') throw new Error('Build this Windows HTML demonstration package on Windows.');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = join(root, 'release');
const name = `SortingTwin-v${pkg.version}-html-windows`;
const directory = join(output, name);
const archive = join(output, name + '.zip');
const generatedBy = 'sorting-twin-html-release';
await mkdir(output, { recursive: true });
// 只替换本脚本生成且位于 release/ 内的同版本目录。
if (relative(output, directory).includes(sep) || !directory.startsWith(output + sep)) throw new Error('Invalid release destination');
let previous;
try { previous = JSON.parse(await readFile(join(directory, 'release-info.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  if (previous.generatedBy !== generatedBy) throw new Error('Refusing to replace an unrelated directory');
  await rm(directory, { recursive: true });
} else {
  try { await stat(directory); throw new Error('Release directory already exists without release metadata'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await cp(join(root, 'dist'), directory, { recursive: true, filter: (path) => !path.endsWith('.gitkeep') });
const windowsFiles = join(root, 'scripts', 'windows-html');
// Windows PowerShell 5.1 需要 UTF-8 BOM 才能正确读取中文。
const preview = await readFile(join(windowsFiles, 'preview.ps1'), 'utf8');
await writeFile(join(directory, 'preview.ps1'), '\uFEFF' + preview.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n'));
await writeFile(join(directory, '启动展示.cmd'), (await readFile(join(windowsFiles, 'start.cmd'), 'utf8')).replace(/\r?\n/g, '\r\n'));
const instructions = `视觉分拣数字孪生系统 v${pkg.version} · Windows HTML 展示版

开始展示
1. 先将整个 ZIP 解压到本机文件夹，不要直接在压缩包内运行。
2. 双击“启动展示.cmd”。无需安装 Node.js、Python 或其他运行环境，无需管理员权限。
3. 浏览器会打开演示模式。点击“一键看演示”，使用内置实拍照片完成识别、3D 重建和分拣。
4. 保持启动窗口运行，可以最小化；结束展示时关闭该窗口即可。

展示内容
- 内置模型、WASM 和 6 张示例，可离线识别、3D 展示、选择元件清单、分拣及导出指令。
- AI 助手使用 DeepSeek，需联网并填写自己的 API Key；离线时使用手动元件清单。
- 接口设置和缓存保存在当前电脑的浏览器中；此包不包含任何 API Key。
- 仅按所选清单收集元件；挡路元件移动到板上空位，优先处理遮挡最少的目标。

打开其他页面
- 完整模式：启动窗口中“完整模式”对应的地址。
- 标定底板：启动窗口中“打印底板”对应的地址，按 100% 比例打印。
- 合成测试图：同一地址下的 synth.html。

环境与常见问题
- 支持 Windows 10 / 11，建议使用较新的 Microsoft Edge 或 Google Chrome。
- 不要直接双击 index.html：浏览器会限制 file:// 下的 Worker、模型与 WASM；请通过启动脚本打开。
- 网页文件是标准静态 HTML，也可直接部署到任意 HTTP/HTTPS 静态网站。
- 启动脚本只在 127.0.0.1 本机监听，不对局域网开放；默认端口 17826，冲突时自动尝试后续 9 个端口。
- 如浏览器未自动打开，复制启动窗口中的“演示页面”地址到 Edge / Chrome。
- 如果企业电脑策略禁用了 PowerShell 脚本，请将网页部署到已有静态服务器后展示。
- WebGPU 不可用时会回退到 WASM，首次加载模型可能稍慢。
- 显示与动画遵循系统浅色/深色及“减少动态效果”设置。

文件校验
release-manifest.json 记录各文件 SHA-256；ZIP 同目录的 .sha256 文件用于核对压缩包完整性。
`;
await writeFile(join(directory, '使用说明.txt'), '\uFEFF' + instructions.replace(/\n/g, '\r\n'));
await writeFile(join(directory, 'release-info.json'), JSON.stringify({ generatedBy, version: pkg.version, platform: 'Windows 10/11', format: 'static-html', builtAt: new Date().toISOString() }, null, 2));

// 随静态产物保留生产依赖的授权文本与模型原始授权说明。
const licenses = join(directory, 'licenses');
await mkdir(licenses);
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const notices = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev || /node_modules\/(?:@types\/|undici-types)/.test(location)) continue;
  const folder = join(root, location);
  const metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  const files = (await readdir(folder)).filter((file) => /^(?:licen[sc]e|notice|third.?party)/i.test(file) && !/\.json$/i.test(file));
  notices.push(`${metadata.name} ${entry.version} (${metadata.license ?? entry.license ?? 'see bundled notice'})`);
  for (const file of files) {
    if (!(await stat(join(folder, file))).isFile()) continue;
    await cp(join(folder, file), join(licenses, metadata.name.replace(/[@/]/g, '_') + '-' + file));
  }
}
for (const file of ['best.json', 'yolo26n_coco.json']) {
  const model = JSON.parse(await readFile(join(directory, 'models', file), 'utf8'));
  notices.push(`Model ${model.file}: ${model.metadata?.license ?? 'see models/' + file}; ${model.metadata?.docs ?? ''}`);
}
await writeFile(join(directory, 'THIRD-PARTY-NOTICES.txt'), notices.join('\r\n') + '\r\n');

async function filesIn(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(path));
    else result.push(path);
  }
  return result.sort();
}
const manifest = { version: pkg.version, files: {} };
for (const file of await filesIn(directory)) {
  const bytes = await readFile(file);
  manifest.files[relative(directory, file).split(sep).join('/')] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Verifying packaged Windows preview and all web resources...');
const verification = await verifyHtmlRelease(directory);
console.log(JSON.stringify(verification));

const quotePS = (value) => "'" + value.replace(/'/g, "''") + "'";
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Compress-Archive -LiteralPath ${quotePS(directory)} -DestinationPath ${quotePS(archive)} -CompressionLevel Optimal -Force`], { stdio: 'inherit', windowsHide: true });
// 真正从 ZIP 解压到含中文和空格的新路径，核对所有文件并再次启动预览。
const extracted = await mkdtemp(join(output, '.archive-check-'));
let archiveVerification;
try {
  const destination = join(extracted, '解压 验收');
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quotePS(archive)} -DestinationPath ${quotePS(destination)}`], { stdio: 'inherit', windowsHide: true });
  const unpacked = join(destination, name);
  const unpackedManifest = JSON.parse(await readFile(join(unpacked, 'release-manifest.json'), 'utf8'));
  for (const [file, entry] of Object.entries(unpackedManifest.files)) {
    const bytes = await readFile(join(unpacked, file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Archive integrity mismatch: ${file}`);
  }
  archiveVerification = await verifyHtmlRelease(unpacked);
} finally {
  if (!extracted.startsWith(output + sep)) throw new Error('Invalid verification directory');
  await rm(extracted, { recursive: true, force: true });
}
const archiveBytes = await readFile(archive);
const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
await writeFile(archive + '.sha256', `${sha256}  ${name}.zip\r\n`);
await writeFile(join(output, name + '-verification.json'), JSON.stringify({ ...verification, archiveVerified: true, extractedResources: archiveVerification.resources, archive: name + '.zip', bytes: archiveBytes.length, sha256 }, null, 2));
console.log(`Release: ${archive} (${(archiveBytes.length / 1048576).toFixed(1)} MB)`);
