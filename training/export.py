#!/usr/bin/env python3
"""把训练好的权重导出为 ONNX（imgsz 1024），打印输入输出形状，并复制到网页的 public/models/。

同时写一份 public/models/best.json（类别名、输入尺寸、输出形状、导出参数），步骤 14 的网页推理按它解码。

用法示例：
    python export.py
    python export.py --weights runs/detect/parts/weights/best.pt --copy-to ../public/models/best.onnx
    python export.py --weights yolo26n.pt --copy-to ../public/models/yolo26n_coco.onnx   # 官方 COCO 模型，步骤 14 先用它打通流程
"""
import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent


def describe(onnx_path):
    """用 onnxruntime 读出输入输出的名字与形状"""
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    io = {
        'inputs': [{'name': i.name, 'shape': i.shape, 'type': i.type} for i in sess.get_inputs()],
        'outputs': [{'name': o.name, 'shape': o.shape, 'type': o.type} for o in sess.get_outputs()],
    }
    meta = sess.get_modelmeta().custom_metadata_map
    return io, meta


def main():
    ap = argparse.ArgumentParser(description='导出 ONNX 并复制到 public/models/')
    ap.add_argument('--weights', type=Path, default=HERE / 'runs' / 'detect' / 'parts' / 'weights' / 'best.pt', help='训练得到的权重（默认 runs/detect/parts/weights/best.pt）')
    ap.add_argument('--imgsz', type=int, default=1024, help='输入尺寸（默认 1024）')
    ap.add_argument('--opset', type=int, default=None, help='ONNX opset（默认由 ultralytics 决定）')
    ap.add_argument('--copy-to', type=Path, default=HERE.parent / 'public' / 'models' / 'best.onnx', help='复制到哪里（默认 public/models/best.onnx）')
    ap.add_argument('--no-copy', action='store_true', help='只导出，不复制')
    args = ap.parse_args()

    import ultralytics
    from ultralytics import YOLO

    if not args.weights.exists() and args.weights.suffix != '.pt':
        raise SystemExit(f'找不到权重 {args.weights}')
    model = YOLO(str(args.weights))
    kw = {'format': 'onnx', 'imgsz': args.imgsz, 'simplify': True, 'dynamic': False}
    if args.opset:
        kw['opset'] = args.opset
    onnx_path = Path(model.export(**kw))
    io, meta = describe(onnx_path)

    print(f'ultralytics {ultralytics.__version__}，导出 {onnx_path}')
    for i in io['inputs']:
        print(f'  输入 {i["name"]}: {i["shape"]} {i["type"]}')
    for o in io['outputs']:
        print(f'  输出 {o["name"]}: {o["shape"]} {o["type"]}')
    out_shape = io['outputs'][0]['shape']
    nc = len(model.names)
    if len(out_shape) == 3 and out_shape[2] == 6:
        layout = 'end2end'  # [1, N, 6]：x1, y1, x2, y2, score, cls（已去重，不用 NMS）
        print(f'  → 端到端输出：每行 [x1, y1, x2, y2, 置信度, 类别]，最多 {out_shape[1]} 个框，网页只需按置信度过滤')
    elif len(out_shape) == 3 and out_shape[1] == 4 + nc:
        layout = 'raw'  # [1, 4 + nc, N]：cx, cy, w, h, 各类得分，需要 NMS
        print(f'  → 原始输出：[1, 4 + {nc}, {out_shape[2]}]，网页需要解码并做 NMS')
    else:
        layout = 'unknown'
        print('  → 未识别的输出形状，请把上面的形状告诉网页端（步骤 14）')

    if args.no_copy:
        return
    args.copy_to.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx_path, args.copy_to)
    info = {
        '说明': 'export.py 生成：网页推理（步骤 14）按这里的输入尺寸、类别和输出格式解码',
        'file': args.copy_to.name,
        'weights': args.weights.name,
        'imgsz': args.imgsz,
        'names': {int(k): v for k, v in model.names.items()},
        'layout': layout,
        **io,
        'metadata': meta,
        'ultralytics': ultralytics.__version__,
        'date': datetime.now().strftime('%Y-%m-%d %H:%M'),
    }
    info_path = args.copy_to.with_suffix('.json')
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    size = args.copy_to.stat().st_size / 1e6
    print(f'已复制到 {args.copy_to}（{size:.1f} MB），说明写入 {info_path}')


if __name__ == '__main__':
    main()
