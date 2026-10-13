#!/usr/bin/env python3
"""用 ultralytics 推理，把检测框写成网页的 *.detections.json 格式，用于和网页推理结果对比（步骤 14）。

输出格式与网页"保存检测结果"一致，可以直接在网页里"载入检测结果"查看：
    { "image": "IMG_0001.jpg", "width": 4032, "height": 3024,
      "detections": [ { "cls": 0, "name": "色环电阻", "score": 0.93, "box": [x1, y1, x2, y2] }, ... ] }
坐标为按 EXIF 转正后的原图像素。

用法示例：
    python predict_dump.py --weights runs/detect/parts/weights/best.pt photos/IMG_0001.jpg
    python predict_dump.py --weights ../public/models/best.onnx data/images --out dumps
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTS = {'.jpg', '.jpeg', '.png', '.heic', '.heif'}
# 与 src/config.js 的 CLASSES 一致
NAMES_ZH = ['色环电阻', '电解电容', 'LED', '螺丝']


def load_bgr(path):
    """读图并按 EXIF 方向转正，返回 BGR numpy 数组（ultralytics 约定）"""
    import numpy as np
    from PIL import Image, ImageOps

    if path.suffix.lower() in {'.heic', '.heif'}:
        import pillow_heif

        pillow_heif.register_heif_opener()
    with Image.open(path) as im:
        rgb = np.array(ImageOps.exif_transpose(im).convert('RGB'))
    return rgb[:, :, ::-1].copy()


def main():
    ap = argparse.ArgumentParser(description='ultralytics 推理 → 网页 *.detections.json 格式')
    ap.add_argument('inputs', type=Path, nargs='+', help='图片文件或文件夹')
    ap.add_argument('--weights', required=True, help='模型权重（.pt 或导出的 .onnx）')
    ap.add_argument('--imgsz', type=int, default=1024, help='输入尺寸（默认 1024）')
    ap.add_argument('--conf', type=float, default=0.4, help='置信度阈值（默认 0.4，与 src/config.js 的 DETECT.scoreThreshold 一致）')
    ap.add_argument('--iou', type=float, default=0.5, help='NMS 的 IoU 阈值（默认 0.5；YOLO26 端到端模型不用 NMS）')
    ap.add_argument('--out', type=Path, default=HERE / 'dumps', help='输出文件夹（默认 training/dumps）')
    ap.add_argument('--device', default=None, help='推理设备，例如 0 或 cpu（默认自动）')
    args = ap.parse_args()

    from ultralytics import YOLO

    files = []
    for p in args.inputs:
        files += sorted(q for q in p.iterdir() if q.suffix.lower() in EXTS) if p.is_dir() else [p]
    if not files:
        sys.exit('没有找到图片')
    model = YOLO(args.weights, task='detect')
    args.out.mkdir(parents=True, exist_ok=True)
    for f in files:
        img = load_bgr(f)
        h, w = img.shape[:2]
        # rect=False：.pt 也按正方形 imgsz × imgsz 填充（predict 默认 rect=True 会缩成最小矩形），与 ONNX、网页的输入一致
        r = model.predict(img, imgsz=args.imgsz, conf=args.conf, iou=args.iou, rect=False, device=args.device, verbose=False)[0]
        dets = []
        for (x1, y1, x2, y2), c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist()):
            c = int(c)
            dets.append({
                'cls': c,
                'name': NAMES_ZH[c] if c < len(NAMES_ZH) else str(c),
                'score': round(float(s), 4),
                'box': [round(float(v), 2) for v in (x1, y1, x2, y2)],
            })
        out = {
            '说明': f'predict_dump.py 推理结果（权重 {Path(args.weights).name}，imgsz {args.imgsz}，conf {args.conf}）',
            'image': f.name,
            'width': w,
            'height': h,
            'detections': dets,
        }
        dst = args.out / f'{f.stem}.detections.json'
        dst.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'  {f.name}：{len(dets)} 个 → {dst}')


if __name__ == '__main__':
    main()
