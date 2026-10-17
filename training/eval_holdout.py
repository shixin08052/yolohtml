#!/usr/bin/env python3
"""独立测试集评估：用一个或多个模型在从未参与训练的照片上评估，打印对比表。

独立测试集的文件夹结构（与 parts_data.zip 一样）：
    holdout/images/*.jpg   prepare_images.py 转正后的照片
    holdout/labels/*.txt   YOLO 标注（只框本体，类别 0 resistor、2 led）

用法示例：
    python eval_holdout.py --data holdout --models runs/parts/weights/best.pt
    python eval_holdout.py --data holdout --models best.pt v1=best_v1.onnx --project runs --name holdout
模型可以写成"名字=路径"，名字用在对比表里；.onnx 模型按 batch 1 评估。
"""
import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAMES = ['resistor', 'capacitor', 'led', 'screw']  # 与 parts.yaml 一致


def main():
    ap = argparse.ArgumentParser(description='独立测试集评估，多个模型对比')
    ap.add_argument('--data', type=Path, required=True, help='独立测试集文件夹（含 images/ 和 labels/）')
    ap.add_argument('--models', nargs='+', required=True, help='模型路径，可写成 名字=路径（.pt 或 .onnx）')
    ap.add_argument('--imgsz', type=int, default=1024, help='输入尺寸（默认 1024）')
    ap.add_argument('--conf', type=float, default=0.001, help='评估用的置信度下限（默认 0.001，算 mAP 的标准做法）')
    ap.add_argument('--project', type=Path, default=HERE / 'runs' / 'holdout', help='结果（图表）保存目录')
    ap.add_argument('--name', default='eval', help='本次评估的名字，每个模型存到 <project>/<name>_<模型名>')
    ap.add_argument('--device', default=None, help='设备，例如 0 或 cpu（默认：.pt 自动选，.onnx 用 cpu）')
    args = ap.parse_args()

    data = args.data.resolve()
    images = sorted(p for p in (data / 'images').glob('*') if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})
    if not images:
        sys.exit(f'{data / "images"} 里没有照片')
    missing = [p.name for p in images if not (data / 'labels' / f'{p.stem}.txt').exists()]
    if missing:
        sys.exit(f'{len(missing)} 张照片没有标注：{", ".join(missing[:10])}')
    counts = [0] * len(NAMES)
    for p in images:
        for line in (data / 'labels' / f'{p.stem}.txt').read_text(encoding='utf-8').splitlines():
            if line.strip():
                counts[int(line.split()[0])] += 1
    print(f'独立测试集：{len(images)} 张照片 · ' + '，'.join(f'{n} {c}' for n, c in zip(NAMES, counts) if c))

    # ultralytics 的数据集配置要求有 train / val，这里都指向同一个文件夹，只用 test
    yaml = data / 'holdout.yaml'
    yaml.write_text('\n'.join([f'path: {data.as_posix()}', 'train: images', 'val: images', 'test: images', 'names:',
                               *[f'  {i}: {n}' for i, n in enumerate(NAMES)]]) + '\n', encoding='utf-8')

    from ultralytics import YOLO

    rows = []
    for spec in args.models:
        label, _, path = spec.rpartition('=')
        label = label or Path(path).stem
        onnx = path.endswith('.onnx')
        # .onnx 默认用 CPU 版 onnxruntime 跑（与网页 WASM 一致，也避开 Colab 上 GPU 版 onnxruntime 与 CUDA 版本不匹配）
        device = args.device or ('cpu' if onnx else None)
        model = YOLO(path, task='detect')
        m = model.val(data=str(yaml), split='test', imgsz=args.imgsz, conf=args.conf,
                      batch=1 if onnx else 8, rect=False, device=device, plots=True,
                      project=str(args.project), name=f'{args.name}_{label}', exist_ok=True, verbose=False)
        b = m.box
        row = {'模型': label, '类别': 'all', 'P': b.mp, 'R': b.mr, 'mAP50': b.map50, 'mAP50-95': b.map}
        rows.append(row)
        for i, c in enumerate(b.ap_class_index):
            p, r, ap50, ap = b.class_result(i)
            rows.append({'模型': label, '类别': NAMES[int(c)], 'P': p, 'R': r, 'mAP50': ap50, 'mAP50-95': ap})

    print('\n| 模型 | 类别 | P | R | mAP50 | mAP50-95 |\n| --- | --- | --- | --- | --- | --- |')
    for r in rows:
        print(f"| {r['模型']} | {r['类别']} | {r['P']:.3f} | {r['R']:.3f} | {r['mAP50']:.3f} | {r['mAP50-95']:.3f} |")
    print(f'\n图表（混淆矩阵、预测示例 val_batch*_pred.jpg）在 {args.project}/{args.name}_<模型名>/')


if __name__ == '__main__':
    main()
