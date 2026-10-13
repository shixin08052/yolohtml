#!/usr/bin/env python3
"""整理原始照片：HEIC / JPG → 按 EXIF 方向转正的 JPG（文件名不变，只换扩展名）。

为什么要转正：iPhone 照片的像素是按传感器方向存的，显示方向记在 EXIF 里。不同软件对 EXIF 的处理不一致，
标注工具、训练程序和网页如果理解不同，框就会错位。先把方向"烧"进像素，后面所有环节看到的都是同一张图。

用法示例：
    python prepare_images.py raw_photos data/images
    python prepare_images.py raw_photos data/images --max-side 2048
"""
import argparse
import sys
from pathlib import Path

EXTS = {'.jpg', '.jpeg', '.png', '.heic', '.heif'}


def main():
    ap = argparse.ArgumentParser(description='HEIC / JPG → 转正后的 JPG')
    ap.add_argument('src', type=Path, help='原始照片文件夹')
    ap.add_argument('dst', type=Path, help='输出文件夹')
    ap.add_argument('--max-side', type=int, default=0, help='长边缩到不超过这么多像素（默认 0 = 不缩放）')
    ap.add_argument('--quality', type=int, default=95, help='JPG 质量（默认 95）')
    args = ap.parse_args()

    from PIL import Image, ImageOps

    files = sorted(p for p in args.src.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        sys.exit(f'{args.src} 里没有照片')
    if any(p.suffix.lower() in {'.heic', '.heif'} for p in files):
        try:
            import pillow_heif
        except ImportError:
            sys.exit('读取 HEIC 需要 pillow-heif：pip install pillow-heif')
        pillow_heif.register_heif_opener()

    args.dst.mkdir(parents=True, exist_ok=True)
    stems = set()
    for f in files:
        if f.stem in stems:
            sys.exit(f'文件名重复：{f.stem}（同名不同扩展名），请改名后重跑')
        stems.add(f.stem)
        with Image.open(f) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            if args.max_side and max(im.size) > args.max_side:
                k = args.max_side / max(im.size)
                im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            out = args.dst / f'{f.stem}.jpg'
            im.save(out, quality=args.quality)
            print(f'  {f.name} → {out.name}（{im.width} × {im.height}）')
    print(f'完成：{len(files)} 张')


if __name__ == '__main__':
    main()
