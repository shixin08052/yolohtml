#!/usr/bin/env python3
"""按颜色把 LED 标注框分成"透明"和"有色"，供分开统计识别率用（标注里 LED 不分颜色）。

判据：框中心区域（去掉四周 25%）像素的饱和度。有色 LED 灯体饱和度高；透明 LED 灯体基本是灰白，
只有反光和透出的底色，饱和度低。阈值 CLEAR_SAT 是看过独立测试集的拼图（--montage）后定的。

用法：
    python led_kind.py --images holdout/images --labels holdout/labels --montage runs/led_montage.jpg
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

LED_CLS = 2
CLEAR_SAT = 70  # 中心区域饱和度的 75 分位低于它算透明


def read_labels(path):
    rows = []
    if path.exists():
        for line in path.read_text().splitlines():
            p = line.split()
            if len(p) == 5:
                rows.append((int(p[0]), *map(float, p[1:])))
    return rows


def box_px(row, w, h):
    _, cx, cy, bw, bh = row
    return cx * w - bw * w / 2, cy * h - bh * h / 2, cx * w + bw * w / 2, cy * h + bh * h / 2


def led_saturation(img, box):
    """框中心区域饱和度的 75 分位（有色灯体的大部分像素都饱和，透明灯体只有零星的彩色反光）"""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = box
    mx, my = (x2 - x1) * 0.25, (y2 - y1) * 0.25
    xa, ya, xb, yb = int(max(0, x1 + mx)), int(max(0, y1 + my)), int(min(w, x2 - mx)), int(min(h, y2 - my))
    if xb <= xa or yb <= ya:
        return 0.0
    hsv = cv2.cvtColor(img[ya:yb, xa:xb], cv2.COLOR_BGR2HSV)
    return float(np.percentile(hsv[..., 1], 75))


def classify(img, rows):
    """每个框：'resistor' / 'clear' / 'color'"""
    h, w = img.shape[:2]
    kinds = []
    for r in rows:
        if r[0] != LED_CLS:
            kinds.append('resistor' if r[0] == 0 else str(r[0]))
            continue
        kinds.append('clear' if led_saturation(img, box_px(r, w, h)) < CLEAR_SAT else 'color')
    return kinds


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--images', type=Path, required=True)
    ap.add_argument('--labels', type=Path, required=True)
    ap.add_argument('--montage', type=Path, help='把所有 LED 按饱和度排序拼成一张图')
    args = ap.parse_args()

    crops = []
    for ip in sorted(args.images.glob('*.jpg')):
        img = cv2.imread(str(ip))
        h, w = img.shape[:2]
        for r in read_labels(args.labels / f'{ip.stem}.txt'):
            if r[0] != LED_CLS:
                continue
            b = box_px(r, w, h)
            s = led_saturation(img, b)
            x1, y1, x2, y2 = b
            pad = 0.4 * max(x2 - x1, y2 - y1)
            c = img[int(max(0, y1 - pad)):int(min(h, y2 + pad)), int(max(0, x1 - pad)):int(min(w, x2 + pad))]
            crops.append((s, ip.stem, cv2.resize(c, (96, 96))))
    crops.sort(key=lambda t: t[0])
    n_clear = sum(s < CLEAR_SAT for s, *_ in crops)
    print(f'LED {len(crops)} 个，其中透明 {n_clear} 个（阈值 {CLEAR_SAT}）')
    if args.montage:
        tiles = []
        for s, name, c in crops:
            c = c.copy()
            cv2.putText(c, f'{s:.0f}', (2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255) if s < CLEAR_SAT else (0, 200, 0), 1)
            tiles.append(c)
        cols = 16
        while len(tiles) % cols:
            tiles.append(np.zeros_like(tiles[0]))
        rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
        args.montage.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(args.montage), np.vstack(rows))
        print(f'拼图：{args.montage}')


if __name__ == '__main__':
    main()
