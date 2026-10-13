#!/usr/bin/env python3
"""训练 YOLO26n 零件检测模型（本地 GPU）。等价于 train.sh 里的 yolo 命令，Windows 上直接用这个。

用法示例：
    python train.py
    python train.py --epochs 150 --batch 8 --device 0
    python train.py --resume            # 中断后从上次的 last.pt 接着训练

训练结果在 runs/detect/<name>/，最好的权重是 runs/detect/<name>/weights/best.pt。
"""
import argparse
import platform
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description='训练 YOLO26n 零件检测模型')
    ap.add_argument('--data', type=Path, default=HERE / 'datasets' / 'parts' / 'parts.yaml', help='数据集配置（split_dataset.py 生成）')
    ap.add_argument('--model', default='yolo26n.pt', help='预训练权重（默认 yolo26n.pt，首次运行自动下载）')
    ap.add_argument('--imgsz', type=int, default=1024, help='输入尺寸（默认 1024，网页推理也用 1024）')
    ap.add_argument('--epochs', type=int, default=150, help='训练轮数（默认 150）')
    ap.add_argument('--batch', type=float, default=-1, help='批大小；-1 = 按显存自动选（默认）；0–1 之间的小数 = 占用显存比例')
    ap.add_argument('--workers', type=int, default=2 if platform.system() == 'Windows' else 8, help='数据加载进程数（Windows 默认 2）')
    ap.add_argument('--device', default='0', help='GPU 编号（默认 0）；没有 GPU 时填 cpu')
    ap.add_argument('--name', default='parts', help='本次训练的名字（结果在 runs/detect/<name>）')
    ap.add_argument('--patience', type=int, default=50, help='验证集指标这么多轮没有提升就提前停止（默认 50）')
    ap.add_argument('--seed', type=int, default=0, help='随机种子（默认 0）')
    ap.add_argument('--resume', action='store_true', help='从 runs/detect/<name>/weights/last.pt 继续训练')
    args = ap.parse_args()

    from ultralytics import YOLO

    if args.resume:
        last = HERE / 'runs' / 'detect' / args.name / 'weights' / 'last.pt'
        YOLO(str(last)).train(resume=True)
        return

    if not args.data.exists():
        raise SystemExit(f'找不到数据集配置 {args.data}，请先运行 split_dataset.py')
    batch = int(args.batch) if args.batch == int(args.batch) else args.batch
    model = YOLO(args.model)
    model.train(
        data=str(args.data),
        imgsz=args.imgsz,
        epochs=args.epochs,
        batch=batch,
        workers=args.workers,
        device=args.device,
        project=str(HERE / 'runs' / 'detect'),
        name=args.name,
        exist_ok=True,
        patience=args.patience,
        seed=args.seed,
        plots=True,
    )
    best = HERE / 'runs' / 'detect' / args.name / 'weights' / 'best.pt'
    print(f'训练完成，最好的权重：{best}')
    print('下一步：python export.py 导出 ONNX')


if __name__ == '__main__':  # Windows 上多进程加载数据必须有这一行
    main()
