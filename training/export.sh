#!/usr/bin/env bash
# 导出 ONNX（imgsz 1024）并打印输入输出形状，复制到 public/models/best.onnx。
# Windows PowerShell 用 python export.py，参数相同。
set -euo pipefail
cd "$(dirname "$0")"
python export.py --weights runs/detect/parts/weights/best.pt --imgsz 1024 "$@"
