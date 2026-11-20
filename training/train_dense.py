"""Fine-tune crowded small-part detection; checkpoints chosen on val, never IMG_9902."""
import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data', type=Path, default=HERE / 'datasets/parts_dense_v1/parts.yaml')
    ap.add_argument('--model', type=Path, default=HERE / 'runs/detect/light/weights/best.pt')
    ap.add_argument('--name', required=True)
    ap.add_argument('--imgsz', type=int, default=1024)
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--workers', type=int, default=1)
    ap.add_argument('--seed', type=int, default=18)
    ap.add_argument('--lr', type=float, default=0.00035)
    ap.add_argument('--warmup-bias-lr', type=float, default=0.00035)
    ap.add_argument('--mosaic', type=float, default=0.2)
    ap.add_argument('--scale', type=float, default=0.2)
    ap.add_argument('--degrees', type=float, default=10)
    ap.add_argument('--translate', type=float, default=0.05)
    args = ap.parse_args()
    import albumentations as A
    from ultralytics import YOLO
    from light_aug import Overexpose, SoftShadow, Spotlight
    augmentations = [
        A.RandomBrightnessContrast(brightness_limit=(-0.18, 0.18), contrast_limit=(-0.18, 0.18), p=0.25),
        A.RandomGamma(gamma_limit=(80, 130), p=0.2),
        A.OneOf([SoftShadow(strength=(0.15, 0.45), p=1), Spotlight(p=1)], p=0.15),
        Overexpose(gain=(1.15, 1.6), p=0.08),
        A.PlanckianJitter(mode='blackbody', temperature_limit=(3500, 8500), p=0.12),
        A.ImageCompression(quality_range=(85, 100), p=0.1),
    ]
    YOLO(str(args.model)).train(
        data=str(args.data), imgsz=args.imgsz, epochs=args.epochs, batch=args.batch,
        workers=args.workers, device=0, project=str(HERE / 'runs/detect'), name=args.name, exist_ok=False,
        optimizer='AdamW', lr0=args.lr, lrf=0.1, cos_lr=True, warmup_epochs=2, warmup_bias_lr=args.warmup_bias_lr,
        weight_decay=0.0005, patience=25, seed=args.seed, plots=True, cache=False,
        degrees=args.degrees, translate=args.translate, scale=args.scale, fliplr=0.5, flipud=0.1,
        mosaic=args.mosaic, close_mosaic=15, mixup=0, hsv_h=0.01, hsv_s=0.2, hsv_v=0.2,
        augmentations=augmentations, nms=False, save_period=20,
    )


if __name__ == '__main__':
    main()
