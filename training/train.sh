#!/usr/bin/env bash
# 训练 YOLO26n（Linux / macOS / Git Bash）。Windows PowerShell 用 python train.py，参数相同。
# 先运行 split_dataset.py 生成 datasets/parts/parts.yaml。
set -euo pipefail
cd "$(dirname "$0")"
yolo detect train model=yolo26n.pt data=datasets/parts/parts.yaml imgsz=1024 epochs=150 batch=-1 \
  project=runs/detect name=parts exist_ok=True patience=50 seed=0 "$@"
