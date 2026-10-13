#!/usr/bin/env python3
"""网页框选结果（*.detections.json）→ YOLO 标注（*.txt）。

网页调试视图的"框选"工具保存的文件格式：
    { "image": "IMG_0001.HEIC", "width": 4032, "height": 3024,
      "detections": [ { "cls": 0, "name": "色环电阻", "score": 1, "box": [x1, y1, x2, y2] }, ... ] }
坐标是按 EXIF 转正后的原图像素。YOLO 标注每行 "类别 中心x 中心y 宽 高"，都按图像宽高归一化到 0–1，
所以和照片是否缩放无关（只要宽高比相同）。

用法示例：
    python detections_to_yolo.py --images data/images --detections data/detections --labels data/labels
"""
import argparse
import json
import sys
from pathlib import Path

NUM_CLASSES = 4  # 与 src/config.js 的 CLASSES、parts.yaml 一致


def main():
    ap = argparse.ArgumentParser(description='网页 *.detections.json → YOLO *.txt 标注')
    ap.add_argument('--images', type=Path, required=True, help='转正后的照片文件夹（prepare_images.py 的输出）')
    ap.add_argument('--detections', type=Path, required=True, help='*.detections.json 所在文件夹')
    ap.add_argument('--labels', type=Path, required=True, help='输出 YOLO 标注的文件夹')
    ap.add_argument('--allow-missing', action='store_true', help='没有标注的照片当作背景图（写空标注），否则报错')
    args = ap.parse_args()

    from PIL import Image

    images = sorted(p for p in args.images.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})
    if not images:
        sys.exit(f'{args.images} 里没有照片')
    args.labels.mkdir(parents=True, exist_ok=True)
    counts = [0] * NUM_CLASSES
    missing = []
    for img in images:
        js = args.detections / f'{img.stem}.detections.json'
        out = args.labels / f'{img.stem}.txt'
        if not js.exists():
            missing.append(img.name)
            if args.allow_missing:
                out.write_text('', encoding='utf-8')
            continue
        data = json.loads(js.read_text(encoding='utf-8'))
        dets = data['detections'] if isinstance(data, dict) else data
        with Image.open(img) as im:
            iw, ih = im.size
        W = data.get('width', iw) if isinstance(data, dict) else iw
        H = data.get('height', ih) if isinstance(data, dict) else ih
        if abs(W / H - iw / ih) > 0.01:
            sys.exit(f'{js.name} 记录的尺寸 {W} × {H} 与照片 {img.name}（{iw} × {ih}）方向或比例不同')
        lines = []
        for d in dets:
            c = int(d['cls'])
            if not 0 <= c < NUM_CLASSES:
                sys.exit(f'{js.name}：类别 {c} 无效（只有 0–{NUM_CLASSES - 1}）')
            x1, y1, x2, y2 = d['box']
            x1, x2 = sorted((max(0.0, x1), min(W, x2)))
            y1, y2 = sorted((max(0.0, y1), min(H, y2)))
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
            lines.append(f'{c} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}')
            counts[c] += 1
        out.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
    names = ['resistor', 'capacitor', 'led', 'screw']
    print('各类别框数：' + '，'.join(f'{n} {k}' for n, k in zip(names, counts)))
    if missing:
        msg = f'{len(missing)} 张照片没有 *.detections.json：{", ".join(missing[:10])}{" …" if len(missing) > 10 else ""}'
        if not args.allow_missing:
            sys.exit(msg + '（确实没有零件的照片可加 --allow-missing 当背景图）')
        print(msg + '，已写空标注')
    print(f'完成：{len(images)} 张，标注写入 {args.labels}')


if __name__ == '__main__':
    main()
