# 步骤 13 任务文档：在 Google Colab 上训练 YOLO26n，并完成相机标定

本文档是**交给另一个对话（或另一个 Claude）执行的任务说明**。执行者按章节顺序做，标 **【需要用户】** 的步骤要停下来请用户操作。训练在 **Google Colab 的免费 / 付费 GPU** 上进行；拍照、标注和相机标定在用户本地完成。

---

## 0. 背景（执行者先读）

- 仓库：`shixin08052/yolohtml`，分支 `claude/stoic-dijkstra-21en1i`。这是一个纯前端网页（"视觉分拣数字孪生"），步骤 1–12 已完成。总任务书在 `docs/TASKS.md`，步骤 13 的原始要求见其中"步骤 13"一节。
- 本步骤**只产出**这几个文件并提交到上述分支，**不要改 `src/` 下的网页代码**：
  - `public/models/best.onnx`：训练好的零件检测模型（ONNX，输入 1024）
  - `public/models/best.json`：模型说明（类别、输入尺寸、输出格式），`export.py` 自动生成
  - `public/models/yolo26n_coco.onnx` 和 `.json`：官方 COCO 模型（步骤 14 先用它打通网页推理）
  - `public/intrinsics.json`：相机标定结果
  - `training/REPORT.md`：训练报告（第 9 节）
  - `public/samples/real/`：3 张测试照片及其 ONNX 推理结果（步骤 14 对比用）
- 脚本已经写好并测试过（见第 8 节"已验证的事实"），都在 `training/` 和 `tools/` 下，每个都支持 `--help`：

| 脚本 | 作用 |
| --- | --- |
| `training/prepare_images.py` | HEIC / JPG → 按 EXIF 方向转正的 JPG |
| `training/autolabel.py` | 按颜色预标注：红色 LED、蓝色电阻，只框本体（见第 2 节） |
| `training/detections_to_yolo.py` | 网页"框选"保存的 `*.detections.json` → YOLO 标注 `*.txt` |
| `training/split_dataset.py` | 按照片划分训练 / 验证 / 测试 = 8 : 1 : 1（种子 42），生成带绝对路径的 `datasets/parts/parts.yaml` |
| `training/train.py`（`train.sh`） | 训练，默认 `yolo26n.pt`、imgsz 1024、150 轮、batch 自动 |
| `training/export.py`（`export.sh`） | 导出 ONNX（默认端到端输出 `[1, 300, 6]`），复制到 `public/models/` 并写说明 json |
| `training/predict_dump.py` | 推理结果写成网页 `*.detections.json` 格式，供步骤 14 对比 |
| `tools/make_chessboard.py` | 生成棋盘格矢量 PDF（默认 A4 横向，9 × 6 内角点，方格 25 mm，带 100 mm 比例尺；`--paper a3/letter`、`--square`）；现成的在 `tools/chessboard_a4.pdf` |
| `tools/calibrate_camera.py` | 棋盘格标定 → `public/intrinsics.json` |

- 类别（顺序固定，必须与 `training/parts.yaml` 一致）：`0 resistor 色环电阻`、`1 capacitor 电解电容`、`2 led LED`、`3 screw 螺丝`。
  - 网页（`src/config.js`）后来只保留电阻、LED 两类（ID 0、1），按类别名对应模型输出（`resistor`、`led`），所以这里的 4 类表不用改，已标注的数据和已训练的模型都照常可用；重新训练时也可以只用这两类。

---

## 1. 拍训练照片【需要用户】

训练照片要和实际使用时一样：

- **场景**：零件放在打印好的 A4 标定板上（照片里能看到 4 个码），iPhone 主摄 1×，不要人像模式、不要裁剪。HEIC、JPG 都行。
- **零件**：四类混放，每张 4–10 个，有的分散、有的挨在一起。**LED 躺平放**，引脚露在外面。
- **角度和距离**：俯角 45°–90° 都要有；手机离桌面 20–40 cm；横拍竖拍都可以。
- **光线**：自然光、台灯、有阴影的都拍一些。
- **数量**：至少 150 张，每类累计至少 300 个（同一个零件换位置、换角度再拍就算新的一个）。另外留 5–10 张从不用于训练的照片，给步骤 15 端到端测试。
- 照片原样拷出（不要经过微信等压缩），放进一个文件夹，例如 `raw/`。

## 2. 标注【需要用户，执行者协助】

**规则**：每个零件一个紧贴的矩形框，**只框本体，不框引脚**（电阻框色环那一段，LED 框红色灯体；夹爪只夹本体，引脚太细、又常弯，框进去反而让框忽大忽小）；被遮住一半以上或只露一点的可以不标；码和文字不标。本项目只用电阻（0）和 LED（2），电容（1）、螺丝（3）不标，但类别顺序保持不变。

网页已按"只框本体"修改（2026-10-13）：3D 模型尺寸已知（含引脚），原点在本体中心，知道本体中心和朝向就能摆出整个零件；夹取点就是框中心；朝向在框外扩约 10 mm 的范围里估计（把一段引脚算进去，判断 LED 灯头朝哪）。

先把照片转正（在用户电脑上执行，需要 Python 3.10+，`pip install pillow pillow-heif`）：

```bash
python training/prepare_images.py raw data/images
```

**预标注（推荐，先跑这个）**：零件放在标定板上、LED 是红色、电阻是蓝色时，可以按颜色自动框出本体（只需要 `pip install opencv-python numpy`，CPU 几秒一张）：

```bash
cd training
python autolabel.py --images data/images --labels data/labels --preview data/preview
```

- 靠 4 个码求标定板位置，只在零件区域（板内缩 12 mm、挖掉码）里找，地面和文字不会误检；找不到码的照片会列出来，需要手工标或删掉。
- 打印每张照片的电阻、LED 个数，和大多数照片不同的单独列出（两个零件挨在一起会合成一个框），优先检查这些。
- `data/preview/` 里是画好框的缩略图，翻一遍就能看出问题。
- 已有的标注默认不覆盖（免得冲掉手工改过的），要重新生成加 `--overwrite`。
- 修正：在 makesense.ai 里导入照片 → Object Detection → Actions → Import Annotations → 选 YOLO，把 `data/labels/` 里的 `*.txt` 和 `labels.txt` 一起选上 → 改完 Export Annotations（YOLO），用导出的 `*.txt` 覆盖 `data/labels/`。

然后二选一（手工标注，或修正预标注）：

**方式 A：用本项目网页的"框选"工具（坐标约定与网页完全一致）**
1. 打开网页（GitHub Pages，或在仓库根目录 `npm install && npm run dev`）。
2. "上传照片"选 `data/images/` 里的一张 → 等标定和位姿完成 → 调试视图点"框选"，选类别后拖框；点框可移动、拉角，Delete 删除。
3. 信息面板"检测与映射"里点"保存检测结果"，把下载的 `<照片名>.detections.json` 放进 `data/detections/`。
4. 全部标完后转换：`python training/detections_to_yolo.py --images data/images --detections data/detections --labels data/labels`

照片里识别不到码时网页不能框选（框选要等位姿求出），这类照片用方式 B，或者删掉。

**方式 B：Label Studio**（`pip install label-studio`，`label-studio start`）
新建项目 → 导入 `data/images` → 模板 "Object Detection with Bounding Boxes"，按上面的顺序建 4 个标签（resistor、capacitor、led、screw）→ 导出 "YOLO" 格式 → 把 `labels/*.txt` 放进 `data/labels/`。检查导出的 `classes.txt` 顺序，不一致就要改类别号。

**打包上传**：把 `data/images/` 和 `data/labels/` 打成 `parts_data.zip`（压缩包里直接是 `images/`、`labels/` 两个文件夹），上传到 Google Drive 的 `MyDrive/yolohtml/`。

## 3. Colab：准备环境

新建 Colab 笔记本，**"修改 → 笔记本设置 → 硬件加速器"选 GPU**（免费版一般是 T4），然后依次运行下面的单元格。

> 更省事：直接打开写好的笔记本 `training/colab_train.ipynb`（Colab 里"文件 → 打开笔记本 → GitHub"，或下载后"上传笔记本"），内容与下面第 3–5 节的单元格相同，从上到下运行即可。

```python
# 单元格 1：确认 GPU、挂载 Google Drive
!nvidia-smi
from google.colab import drive
drive.mount('/content/drive')
```

```python
# 单元格 2：取代码。仓库是私有的话，用 GitHub 个人访问令牌（只读权限即可）：
#   !git clone https://<令牌>@github.com/shixin08052/yolohtml.git
# 或者用户在本地把仓库打成 zip 上传到 Drive 再解压
!git clone -b claude/stoic-dijkstra-21en1i https://github.com/shixin08052/yolohtml.git /content/yolohtml
%cd /content/yolohtml/training
```

```python
# 单元格 3：安装依赖。Colab 自带 CUDA 版 torch，不要重装 torch
!pip install -q -r requirements.txt
!yolo checks
import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))
```

必须输出 `True` 和显卡名。`yolo checks` 打印的 ultralytics 版本要 ≥ 8.4.0（YOLO26 从 8.4.0 开始支持；本文档用 8.4.176 验证过，见第 8 节）。

## 4. Colab：数据集与训练

```python
# 单元格 4：解压数据并划分
!mkdir -p data && unzip -q -o /content/drive/MyDrive/yolohtml/parts_data.zip -d data
!python split_dataset.py --images data/images --labels data/labels
```

记下打印的各集合照片数和各类别框数（写进报告）。

```python
# 单元格 5：训练。结果直接写到 Drive，Colab 断线也不丢
!python train.py --project /content/drive/MyDrive/yolohtml/runs --name parts
```

- 默认 `yolo26n.pt`、imgsz 1024、150 轮、batch 自动（T4 上大约 8–16）、50 轮不提升就提前停止。150 张照片在 T4 上大约 1–2 小时。
- **Colab 断线**：重新连接后重跑单元格 1–4（数据要重新解压），然后 `!python train.py --project /content/drive/MyDrive/yolohtml/runs --name parts --resume`。
- 显存不够：加 `--batch 8`，还不够用 `--batch 4`。

```python
# 单元格 6：在测试集上评估（结果写进报告）
!yolo detect val model=/content/drive/MyDrive/yolohtml/runs/parts/weights/best.pt data=datasets/parts/parts.yaml split=test imgsz=1024
```

**期望**：测试集 mAP50 ≥ 0.9。明显偏低时看 `runs/parts/confusion_matrix.png` 哪两类混淆，请用户补拍这些类别的照片（每类再拍 30–50 张），重新标注、划分、训练。

## 5. Colab：导出 ONNX 与对比数据

```python
# 单元格 7：导出
!python export.py --weights /content/drive/MyDrive/yolohtml/runs/parts/weights/best.pt
!python export.py --weights yolo26n.pt --copy-to ../public/models/yolo26n_coco.onnx
```

每次导出会打印输入输出形状。**期望**：输入 `images: [1, 3, 1024, 1024]`，输出 `output0: [1, 300, 6]`，并提示"端到端输出"。导出文件和 `best.json` / `yolo26n_coco.json` 在 `/content/yolohtml/public/models/`。

```python
# 单元格 8：对比数据（步骤 14 用来核对网页推理结果）
!python predict_dump.py --weights ../public/models/best.onnx datasets/parts/images/test --out dumps/best_onnx
!mkdir -p ../public/samples/real
# 挑 3 张测试照片，连同它们的推理结果一起放进 public/samples/real/
import json, shutil, glob, os
picked = sorted(glob.glob('datasets/parts/images/test/*.jpg'))[:3]
for p in picked:
    stem = os.path.splitext(os.path.basename(p))[0]
    shutil.copy(p, '../public/samples/real/')
    shutil.copy(f'dumps/best_onnx/{stem}.detections.json', '../public/samples/real/')
print(picked)
```

**注意**：以网页为准的对比数据用 `.onnx` 推理（上面的命令）。不要拿 `.pt` 的推理结果当参照，原因见第 8 节第 4 条。

```python
# 单元格 9：把产出打包，下载到本地
!cd .. && zip -r /content/drive/MyDrive/yolohtml/step13_outputs.zip public/models public/samples/real
!cp /content/drive/MyDrive/yolohtml/runs/parts/results.png /content/drive/MyDrive/yolohtml/runs/parts/confusion_matrix.png /content/drive/MyDrive/yolohtml/
```

## 6. 相机标定【需要用户拍照，本地执行】

标定只需要 CPU，在用户电脑的仓库根目录执行（`pip install opencv-python pillow pillow-heif`）：

```bash
python tools/make_chessboard.py        # 生成 chessboard_a4.pdf：10 × 7 个方格（9 × 6 个内角点），方格 25 mm；也可直接用仓库里的 tools/chessboard_a4.pdf
```

1. **【需要用户】** 用 Edge / Acrobat 等 PDF 阅读器打开 `chessboard_a4.pdf`，A4 打印，缩放选"实际大小 / 100%"（不要选"适合页面"；Windows"照片"的打印窗口会缩放，不要用）。先量页面下方的 100 mm 比例尺确认没被缩放，再量 5 个方格总长除以 5，得到实际方格边长（例如 24.9 mm）。贴平在硬板上。
2. **【需要用户】** 用**同一台 iPhone、主摄 1×** 拍 15–25 张：棋盘格占画面 1/3 以上，正面、左右上下倾斜 20°–45° 都拍，让棋盘格出现在画面中间和四个角附近，清晰、无反光。照片放进 `calib_photos/`。
3. 运行：

   ```bash
   python tools/calibrate_camera.py calib_photos --square 24.9 --show-errors
   ```

   写出 `public/intrinsics.json`，打印 RMS 重投影误差、fx、fy、cx、cy、等效焦距。

**期望**：RMS < 1 像素；等效焦距约 26 mm；4032 × 3024 时 cx、cy 接近 2016、1512。RMS 偏大就删掉 `--show-errors` 里误差最大的几张后重跑。

## 7. 提交

在用户本地仓库（分支 `claude/stoic-dijkstra-21en1i`）：

1. 解压 `step13_outputs.zip` 到仓库根目录（得到 `public/models/*`、`public/samples/real/*`）。
2. 确认 `public/intrinsics.json` 已由第 6 节生成。
3. 写 `training/REPORT.md`（第 9 节）。
4. 提交并推送：

   ```bash
   git add public/models public/samples/real public/intrinsics.json training/REPORT.md
   git commit -m "步骤 13：训练好的零件检测模型与相机标定结果"
   git push origin claude/stoic-dijkstra-21en1i
   ```

照片、数据集、训练中间结果不要提交（`.gitignore` 已排除 `training/raw`、`data`、`datasets`、`runs`、`dumps` 和 `calib_photos/`）。推送后告诉用户：回到原来的对话说"步骤 13 完成"，继续步骤 14。

## 8. 已验证的事实（2026-10-13，ultralytics 8.4.176、torch 2.14.1、onnxruntime 1.31.0）

1. **YOLO26 支持**：ultralytics 8.4.x 带 `yolo26.yaml` 等配置；`YOLO('yolo26n.pt')` 自动从 `github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt` 下载（5.3 MB，80 类 COCO）。
2. **导出格式**：
   - ultralytics 只有在 `export(..., nms=False)` 时才走 YOLO26 的端到端（NMS-free）分支（exporter 里 `model.end2end = (nms is False)`）。这时输出 `[1, 300, 6]`，每行 `[x1, y1, x2, y2, 置信度, 类别]`，坐标在 1024 × 1024 输入图上，按置信度降序。`export.py` 默认就这样导出。
   - 默认 `nms=None` 导出的是原始输出 `[1, 4 + 类别数, 21504]`（imgsz 1024），需要自己解码和做 NMS。`export.py --raw` 可以导出这种。
   - opset 18，算子只有常见的 Conv、Resize、TopK、GatherElements 等，onnxruntime-web 支持。yolo26n 的 ONNX 约 10 MB。
3. **网页前处理**（步骤 14 照做）：等比缩放到 1024、居中填灰 (114, 114, 114)、RGB、除以 255、NCHW。用这个前处理直接跑 ONNX，与 ultralytics 跑同一个 ONNX 的结果对比：框数、类别、置信度完全一致，坐标最大差 1.5 像素（缩放回原图时的取整差异，步骤 14 再细查）。
4. **`.pt` 与 `.onnx` 的推理结果不一致，这是正常的**：
   - `predict()` 默认 `rect=True`，`.pt` 会填充成最小矩形而不是 1024 正方形。`predict_dump.py` 已传 `rect=False`。
   - 更主要的是，ultralytics 8.4.176 里 `.pt` 推理默认用 YOLO26 的"一对多"检测头 + NMS，而端到端 ONNX 用"一对一"检测头，两个头的输出本来就不同（实测官方模型同一张图：`.pt` 5 个框，`.onnx` 6 个框，置信度不同）。
   - 源码里 `predict()` 也有 `end2end = (nms is False)` 的开关，所以 `predict(..., nms=False)` 应该能让 `.pt` 也用一对一头，**这一点还没验证**。需要 `.pt` 与 `.onnx` 一致时，执行者先做这个实验再改 `predict_dump.py`；步骤 14 的对比只用 `.onnx` 的结果即可。
5. **数据集配置**：ultralytics 把数据集 yaml 里相对的 `path` 解析到它自己的数据集目录（不是 yaml 所在目录），所以 `split_dataset.py` 生成的 `datasets/parts/parts.yaml` 写的是绝对路径。在 Colab 上划分后路径就是 Colab 里的路径，不要拿到本地用。
6. **脚本测试**：
   - 全部脚本 `--help` 正常。
   - `split_dataset.py` 用 20 张假照片测试：划分 16 / 2 / 2，同一种子两次结果相同。
   - `prepare_images.py` 能正确处理 EXIF 方向 = 6 的竖拍照片。
   - 用 3 张合成图（复制成 12 张）走通 转正 → 转标注 → 划分 → `train.py` 训练 1 轮（CPU）→ `export.py` 导出 `[1, 300, 6]` → `predict_dump.py`。
   - `calibrate_camera.py` 用已知内参渲染的 16 张合成棋盘格照片（含竖拍）测试：fx 误差 0.05%，主点误差小于 0.5 像素，RMS 0.16 像素。
   - `make_chessboard.py` 生成的棋盘格能被 OpenCV 识别，300 DPI 下方格 24.98 mm。

## 9. 训练报告 `training/REPORT.md`

执行者整理以下内容（论文 / 报告会用到）：

- 环境：Colab GPU 型号、CUDA、Python、torch、ultralytics、onnxruntime 版本
- 数据：照片总数、各集合照片数、各类别框数（`split_dataset.py` 的输出）
- 训练参数：模型、imgsz、epochs（实际跑了多少轮、是否提前停止）、batch、训练用时
- 结果：验证集和测试集的 P、R、mAP50、mAP50-95（总体和每类）；`results.png`、`confusion_matrix.png` 复制到 `training/report/` 一起提交
- 导出：ONNX 文件大小、输入输出形状
- 标定：照片数、成功检测数、RMS、fx、fy、cx、cy、等效焦距

## 10. 验收标准（对应 docs/TASKS.md 步骤 13）

- [x] 每个 Python 脚本 `--help` 都能正常运行（已验证）
- [x] `split_dataset.py` 用假文件夹测试，划分数量正确（已验证）
- [ ] 【需要用户】按本文档完成拍照、标注、训练，得到 `best.onnx`（测试集 mAP50 ≥ 0.9 为宜）
- [ ] 【需要用户】拍棋盘格照片并跑标定脚本，得到 `intrinsics.json`（RMS < 1 像素）

## 11. 常见问题

- **`torch.cuda.is_available()` 是 False**：没选 GPU 运行时。"修改 → 笔记本设置 → GPU"，然后重新运行。
- **Colab 用量用完 / 断线**：结果在 Drive 的 `yolohtml/runs/parts/` 里，换时间或换账号后按第 4 节 `--resume` 继续。
- **CUDA out of memory**：`--batch 8` 或 `--batch 4`。
- **`git clone` 要求登录**：仓库是私有的，用 GitHub 个人访问令牌（Settings → Developer settings → Personal access tokens，只给这个仓库的只读权限），或者上传仓库 zip。
- **标注框和照片错位**：照片没先用 `prepare_images.py` 转正，或标注工具读的是原始 HEIC。用 `data/images` 里转正后的 JPG 重新标。
- **某类 mAP 很低**：这类照片太少或太单一，补拍 30–50 张这一类为主的照片。
- **标定时很多照片"没找到内角点"**：棋盘格太小、太斜、有反光或不完整；`--cols`、`--rows` 填的是内角点数，不是方格数。
