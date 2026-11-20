#!/usr/bin/env python3
"""加强光照增强 + 透明 LED 复制粘贴后训练（本地 GPU）。其余超参数与第三版（train.py 默认）相同，方便对比。

先：
    python split_dataset.py --images data/images --labels data/labels --test-images holdout/images --test-labels holdout/labels --ratios 9 1 0
    python augment_paste.py                       # → datasets/parts_aug（训练集多一倍，带粘贴的透明 LED）
再：
    python train_light.py                         # → runs/detect/light/weights/best.pt
    python export.py --weights runs/detect/light/weights/best.pt ...
    python eval_light.py --model <best.onnx> --compare runs/eval_old.json

--no-light 关掉光照增强（只看复制粘贴的作用）；--data 换成 datasets/parts/parts.yaml 就不用复制粘贴。
"""
import argparse
import platform
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--data', type=Path, default=HERE / 'datasets' / 'parts_aug' / 'parts.yaml')
    ap.add_argument('--model', default='yolo26n.pt')
    ap.add_argument('--imgsz', type=int, default=1024)
    ap.add_argument('--epochs', type=int, default=150)
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--workers', type=int, default=4 if platform.system() == 'Windows' else 8)
    ap.add_argument('--device', default='0')
    ap.add_argument('--name', default='light')
    ap.add_argument('--project', type=Path, default=HERE / 'runs' / 'detect')
    ap.add_argument('--strength', type=float, default=1.0, help='光照增强强度（各项概率乘这个数）')
    ap.add_argument('--no-light', action='store_true', help='不加光照增强')
    ap.add_argument('--resume', action='store_true')
    args = ap.parse_args()

    from ultralytics import YOLO

    extra = {}
    if not args.no_light:
        import light_aug
        extra['augmentations'] = light_aug.build(args.strength)
        print('光照增强：' + ', '.join(type(t).__name__ for t in extra['augmentations']))

    if args.resume:
        YOLO(str(args.project / args.name / 'weights' / 'last.pt')).train(resume=True)
        return
    YOLO(args.model).train(
        data=str(args.data), imgsz=args.imgsz, epochs=args.epochs, batch=args.batch, workers=args.workers,
        device=args.device, project=str(args.project), name=args.name, exist_ok=True,
        patience=50, seed=0, plots=True, cache='ram', **extra,
    )
    print(f'训练完成：{args.project / args.name / "weights" / "best.pt"}')


if __name__ == '__main__':  # Windows 多进程加载数据必须有这一行
    main()
