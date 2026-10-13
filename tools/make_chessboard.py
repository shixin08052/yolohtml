#!/usr/bin/env python3
"""生成 A4 横向的标定棋盘格 PNG（300 DPI），打印时选"实际大小 / 100%"。

默认 10 × 7 个方格（9 × 6 个内角点），方格 25 mm，与 calibrate_camera.py 的默认值一致。
打印后用尺子量几个方格的实际边长，标定时用 --square 填实测值。

用法示例：
    python tools/make_chessboard.py
    python tools/make_chessboard.py --square 24 --out chessboard_24mm.png
"""
import argparse
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description='生成 A4 横向棋盘格（300 DPI PNG）')
    ap.add_argument('--cols', type=int, default=9, help='每行内角点数（默认 9，即 10 列方格）')
    ap.add_argument('--rows', type=int, default=6, help='每列内角点数（默认 6，即 7 行方格）')
    ap.add_argument('--square', type=float, default=25.0, help='方格边长 mm（默认 25）')
    ap.add_argument('--dpi', type=int, default=300, help='分辨率（默认 300）')
    ap.add_argument('--out', type=Path, default=Path('chessboard_a4.png'), help='输出文件（默认 chessboard_a4.png）')
    args = ap.parse_args()

    from PIL import Image, ImageDraw

    page_w, page_h = 297.0, 210.0  # A4 横向，mm
    nx, ny = args.cols + 1, args.rows + 1
    bw, bh = nx * args.square, ny * args.square
    if bw > page_w - 20 or bh > page_h - 20:
        raise SystemExit(f'棋盘 {bw:.0f} × {bh:.0f} mm 放不进 A4（留 10 mm 边距），请减小 --square')
    px = args.dpi / 25.4
    img = Image.new('L', (round(page_w * px), round(page_h * px)), 255)
    d = ImageDraw.Draw(img)
    x0 = (page_w - bw) / 2
    y0 = (page_h - bh) / 2
    for r in range(ny):
        for c in range(nx):
            if (r + c) % 2 == 0:
                d.rectangle([round((x0 + c * args.square) * px), round((y0 + r * args.square) * px),
                             round((x0 + (c + 1) * args.square) * px) - 1, round((y0 + (r + 1) * args.square) * px) - 1], fill=0)
    d.text((round(10 * px), round((page_h - 8) * px)),
           f'chessboard {args.cols}x{args.rows} inner corners, square {args.square} mm, print at 100%', fill=0)
    img.save(args.out, dpi=(args.dpi, args.dpi))
    print(f'已生成 {args.out}：{nx} × {ny} 个方格（{args.cols} × {args.rows} 个内角点），方格 {args.square} mm')


if __name__ == '__main__':
    main()
