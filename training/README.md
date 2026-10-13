# 步骤 13：本地训练 YOLO26n 与相机标定

本文档同时写给**用户**和**用户本地的 Claude Code**。训练在用户自己的电脑（NVIDIA 显卡）上进行，不用云 GPU。

> **给本地 Claude Code 的说明**
> - 按章节顺序执行。标有 **【需要用户】** 的步骤要停下来，告诉用户要做什么、做完后告诉你，再继续。
> - 命令默认在仓库根目录下的 `training/` 目录里执行（第 9 节的标定在仓库根目录执行）。Windows 用 PowerShell，命令和 Linux / macOS 不同的地方都分别写了。
> - 每步做完，把关键输出（版本号、数量、指标、形状）记下来，最后一并汇报给用户，并写进第 11 节的 `training/REPORT.md`。
> - 不要修改 `src/` 下的网页代码；训练只产生 `public/models/best.onnx`、`public/models/best.json`、`public/intrinsics.json` 三个要提交的文件。
> - 遇到报错先看第 12 节"常见问题"。

---

## 0. 总流程

| # | 做什么 | 谁做 | 产出 |
| --- | --- | --- | --- |
| 1 | 检查显卡和 Python | Claude Code | — |
| 2 | 建虚拟环境、装 PyTorch（CUDA 版）和 ultralytics，确认支持 YOLO26 | Claude Code | `training/.venv` |
| 3 | 拍训练照片 | **用户** | `training/raw/*.HEIC` |
| 4 | 照片转正、转 JPG | Claude Code | `training/data/images/*.jpg` |
| 5 | 标注 | **用户**（Claude Code 协助） | `training/data/labels/*.txt` |
| 6 | 划分训练 / 验证 / 测试集（8 : 1 : 1） | Claude Code | `training/datasets/parts/` |
| 7 | 训练 | Claude Code | `training/runs/detect/parts/weights/best.pt` |
| 8 | 导出 ONNX、生成对比数据 | Claude Code | `public/models/best.onnx`、`best.json`、`training/dumps/` |
| 9 | 打印棋盘格、拍照、标定 | **用户** 拍照，Claude Code 跑脚本 | `public/intrinsics.json` |
| 10 | 提交并推送 | Claude Code | — |

---

## 1. 检查环境

```powershell
nvidia-smi          # 看显卡型号、显存、驱动支持的最高 CUDA 版本（右上角 "CUDA Version"）
python --version    # 建议 3.10 – 3.12；Windows 上可以用 py -0 列出已装的版本
git status          # 确认在本仓库、分支 claude/stoic-dijkstra-21en1i，且已拉取最新代码
```

- 没有 `nvidia-smi`：先装 NVIDIA 显卡驱动。
- 没有 Python 3.10–3.12：从 python.org 装 3.12（勾选 "Add python.exe to PATH"）。PyTorch 对最新的 Python 版本支持通常会晚一些，所以不要用太新的版本。

## 2. 安装

```powershell
cd training
py -3.12 -m venv .venv                 # Linux / macOS：python3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1           # Linux / macOS：source .venv/bin/activate
python -m pip install -U pip
```

PowerShell 提示"禁止运行脚本"时，先执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

**PyTorch（CUDA 版）**：到 <https://pytorch.org/get-started/locally/> 选 Stable / 你的系统 / Pip / Python / 对应的 CUDA，复制它给出的命令。例如驱动支持 CUDA 12.6 及以上时：

```powershell
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
```

不要直接 `pip install torch`：在 Windows 上那样装的是只能用 CPU 的版本。装完检查：

```powershell
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-')"
```

必须输出 `True` 和显卡名，否则训练会跑在 CPU 上（非常慢）。

**其余依赖**：

```powershell
pip install -r requirements.txt
yolo checks                                            # 打印 ultralytics、torch、CUDA 版本
python -c "from ultralytics import YOLO; m = YOLO('yolo26n.pt'); print(m.info())"   # 自动下载 yolo26n.pt 并确认能加载
```

**YOLO26 支持情况（2026-10-13 实测）**：<<YOLO26_NOTES>>

## 3. 拍训练照片【需要用户】

训练照片要和实际使用时的照片尽量一样：

- **场景**：零件放在打印好的 A4 标定板上（照片里要能看到 4 个码），用 iPhone 主摄（1×），不要人像模式、不要裁剪。HEIC 或 JPG 都行。
- **零件**：电阻、电解电容、LED、螺丝四类。**LED 要躺平放**（像平时随手放在桌上那样），引脚露在外面。每张放 4–10 个，类别混着放，有的靠近、有的分散，偶尔让两个零件挨在一起。
- **角度和距离**：俯角 45°–90°（正上方到斜 45°）都要有；手机离桌面 20–40 cm；横拍竖拍都可以。
- **光线**：白天自然光、台灯、有阴影的都拍一些。
- **数量**：至少 150 张，每类零件累计至少 300 个（同一个零件换位置、换角度再拍就算新的一个）。再另外留 5–10 张从没用过的照片，步骤 15 端到端测试用，**不要放进训练集**。
- 拍完把照片（不要经过微信等压缩）拷到 `training/raw/`。

## 4. 照片转正、转 JPG

```powershell
python prepare_images.py raw data/images
```

把 EXIF 里记录的方向"烧"进像素，HEIC 转成 JPG，文件名不变。之后所有环节（标注工具、训练、网页）看到的都是同一张转正后的图。

## 5. 标注【需要用户】

**标注规则（两种方式都一样）**：

- 每个零件画一个**紧贴零件**的矩形框，包住整个零件，**电阻、LED 的引脚也要框进去**（网页要靠引脚判断 LED 的朝向）。
- 类别：`0 resistor 色环电阻`、`1 capacitor 电解电容`、`2 led LED`、`3 screw 螺丝`。顺序不能错，必须和 `parts.yaml`、网页 `src/config.js` 一致。
- 被遮住一半以上、或在照片边缘只露出一点的零件可以不标。
- 标定板上的码、文字不要标。

**方式 A：用本项目网页的"框选"工具（推荐，坐标约定和网页完全一致）**

1. 在仓库根目录 `npm install` 后 `npm run dev`，浏览器打开终端显示的地址（也可以直接用 GitHub Pages 上的页面）。
2. "上传照片"选 `training/data/images/` 里的一张 → 等标定、位姿完成 → 调试视图点"框选"，选类别、拖框；点框可以移动、拉角，Delete 删除。
3. 信息面板"检测与映射"里点"保存检测结果"，得到 `<照片名>.detections.json`，放进 `training/data/detections/`。
4. 全部标完后转换：

   ```powershell
   python detections_to_yolo.py --images data/images --detections data/detections --labels data/labels
   ```

   照片里没识别到码时网页不能框选（框选在位姿求出后才开启），这种照片用方式 B 标，或者删掉。

**方式 B：Label Studio**

```powershell
pip install label-studio
label-studio start
```

新建项目 → 导入 `data/images` → 模板选 "Object Detection with Bounding Boxes"，标签按上面的顺序建 4 个（名字用 resistor、capacitor、led、screw）→ 标完导出 "YOLO" 格式 → 把导出包里的 `labels/*.txt` 放进 `training/data/labels/`。导出包里的 `classes.txt` 必须是 resistor、capacitor、led、screw 的顺序，不一致就要改类别号。

标完后，Claude Code 检查：每张照片都有同名 `.txt`、类别号都在 0–3、每类数量够不够（第 6 节会打印）。

## 6. 划分数据集

```powershell
python split_dataset.py --images data/images --labels data/labels
```

按照片随机划分 训练 : 验证 : 测试 = 8 : 1 : 1（种子固定为 42，可复现），打印每个集合的照片数和各类别框数，生成 `datasets/parts/`（含带绝对路径的 `parts.yaml` 和记录划分结果的 `split.json`）。加 `--dry-run` 只看划分结果不复制文件。

## 7. 训练

```powershell
python train.py                        # Linux / macOS 也可以 bash train.sh
```

默认 `yolo26n.pt`、`imgsz=1024`、`epochs=150`、`batch=-1`（按显存自动选批大小）、`patience=50`（50 轮没有提升就提前结束）。结果在 `runs/detect/parts/`：

- `weights/best.pt`：验证集上最好的权重
- `results.png`、`results.csv`：每轮的损失和 mAP 曲线
- `confusion_matrix.png`：混淆矩阵
- 训练结束时终端会打印验证集的 P、R、mAP50、mAP50-95（总体和每类）

参考：笔记本 RTX 显卡、150 张照片、150 轮，大约 0.5–2 小时。中断了可以 `python train.py --resume` 接着训练。

训练完在测试集上评估一次（结果写进报告）：

```powershell
yolo detect val model=runs/detect/parts/weights/best.pt data=datasets/parts/parts.yaml split=test imgsz=1024
```

**期望**：测试集 mAP50 ≥ 0.9。明显偏低时，先看混淆矩阵是哪两类分不清，再补拍这些类别的照片。

## 8. 导出 ONNX 与对比数据

```powershell
python export.py                       # 导出 best.pt → ONNX（imgsz 1024），复制到 ../public/models/best.onnx
python export.py --weights yolo26n.pt --copy-to ../public/models/yolo26n_coco.onnx   # 官方 COCO 模型，步骤 14 先用它打通网页推理
```

`export.py` 会打印输入输出形状，并在 ONNX 旁边写一份 `.json`（类别名、输入尺寸、输出格式），网页推理（步骤 14）按它解码。<<EXPORT_NOTES>>

生成对比数据（步骤 14 用来核对网页推理结果）：

```powershell
python predict_dump.py --weights runs/detect/parts/weights/best.pt datasets/parts/images/test --out dumps/best
python predict_dump.py --weights ../public/models/best.onnx datasets/parts/images/test --out dumps/best_onnx
```

每张图得到一个 `<照片名>.detections.json`，格式与网页"保存检测结果"相同，可以在网页里"载入检测结果"直接查看。`.pt` 和 `.onnx` 两份结果应该几乎一样（框坐标相差 < 1 像素）。挑 3 张测试照片和它们的 `dumps/best_onnx/*.detections.json` 复制到 `public/samples/real/`，步骤 14 拿来和网页结果对比。

## 9. 相机标定【需要用户拍照】

在**仓库根目录**执行：

```powershell
python tools/make_chessboard.py        # 生成 chessboard_a4.png：10 × 7 个方格（9 × 6 个内角点），方格 25 mm
```

1. **【需要用户】** 用 A4 纸打印 `chessboard_a4.png`，打印时选"实际大小 / 100%"，不要"适合页面"。用尺子量 5 个方格的总长度除以 5，得到方格边长（例如 24.9 mm）。把纸贴平在硬板上。
2. **【需要用户】** 用和拍零件**同一台 iPhone、主摄 1×**拍 15–25 张：棋盘格占画面的 1/3 以上，从正面、左右上下倾斜 20°–45° 等不同角度拍，让棋盘格出现在画面的中间和四个角附近；对焦清晰、没有反光。横拍竖拍都行（脚本会统一转回横向）。照片拷到 `calib_photos/`。
3. 标定：

   ```powershell
   python tools/calibrate_camera.py calib_photos --square 24.9 --show-errors
   ```

   输出 `public/intrinsics.json`，并打印 RMS 重投影误差、fx、fy、cx、cy 和折合的等效焦距。

**期望**：RMS < 1 像素；等效焦距约 26 mm（iPhone 13 Pro 主摄）；cx、cy 接近图像中心（4032 × 3024 时约 2016、1512）。RMS 偏大时用 `--show-errors` 看哪几张误差最大，删掉后重跑。

脚本已在合成棋盘格上验证：已知 fx = 1514.2 时标定得到 1515.0（误差 0.05%），主点误差 < 0.5 像素。

## 10. 提交并推送

```powershell
cd ..                                  # 回到仓库根目录
git add public/models/best.onnx public/models/best.json public/intrinsics.json training/REPORT.md
git add public/models/yolo26n_coco.onnx public/models/yolo26n_coco.json   # 如果导出了 COCO 模型
git add public/samples/real                                              # 如果复制了对比样例
git commit -m "步骤 13：训练好的零件检测模型与相机标定结果"
git push origin claude/stoic-dijkstra-21en1i
```

`training/raw`、`data`、`datasets`、`runs`、`dumps` 和 `calib_photos/` 已在 `.gitignore` 里，不会被提交（照片和训练中间结果体积很大）。

推送后，用户回到云端会话告诉 Claude"训练和标定完成"，继续步骤 14。

## 11. 训练报告 `training/REPORT.md`

本地 Claude Code 把下面这些写进 `training/REPORT.md` 并一起提交（论文 / 报告会用到）：

- 环境：系统、显卡、驱动 / CUDA、Python、torch、ultralytics 版本
- 数据：照片总数、各集合照片数、各类别框数（`split_dataset.py` 的输出）
- 训练参数：模型、imgsz、epochs（实际跑了多少轮）、batch、训练用时
- 结果：验证集和测试集的 P、R、mAP50、mAP50-95（总体和每类），附 `results.png`、`confusion_matrix.png` 的路径
- 导出：ONNX 文件大小、输入输出形状
- 标定：照片数、成功检测数、RMS、fx、fy、cx、cy、等效焦距

## 12. 常见问题

- **`torch.cuda.is_available()` 是 False**：装成了 CPU 版的 torch。`pip uninstall torch torchvision`，再按第 2 节用 pytorch.org 给出的 CUDA 版命令重装。
- **显存不够（CUDA out of memory）**：`python train.py --batch 8`，还不够就 `--batch 4`。
- **Windows 上训练卡在加载数据 / 报 multiprocessing 错误**：`python train.py --workers 0`。
- **`yolo26n.pt` 下载失败**：从 <https://github.com/ultralytics/assets/releases> 找到 `yolo26n.pt` 手动下载，放进 `training/`。
- **标注框和照片错位**：照片没有先经过 `prepare_images.py` 转正，或者标注工具读的是原始 HEIC。删掉标注，用 `data/images` 里转正后的 JPG 重新标。
- **某类 mAP 很低**：这类照片太少或太单一，补拍 30–50 张这一类为主的照片，重新标注、划分、训练。
- **标定时很多照片"没找到内角点"**：棋盘格太小、太斜、有反光或不完整。`--cols`、`--rows` 要填内角点数（不是方格数）。
