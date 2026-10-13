#!/usr/bin/env python3
"""棋盘格相机标定：读取一个文件夹里的棋盘格照片，输出网页用的 public/intrinsics.json。

用法示例：
    python tools/calibrate_camera.py photos/chessboard --square 25
    python tools/calibrate_camera.py photos/chessboard --square 24.5 --cols 9 --rows 6 --out public/intrinsics.json

要点：
- 棋盘格默认 9 × 6 个内角点（即 10 × 7 个方格），方格边长用 --square 指定（mm，打印后用尺子量）。
  边长只影响外参，不影响内参；但照样请填实测值。
- 照片必须是同一台手机、同一个镜头（主摄 1×）、同一分辨率，不要裁剪、不要用人像模式。
- 照片会先按 EXIF 方向转正；竖拍的照片再逆时针转 90° 回到传感器的横向，统一在横向（例如 4032 × 3024）下标定。
  网页按照片方向自动旋转内参（src/vision/intrinsics.js 的 fromCalib）。
- OpenCV 的像素中心在整数坐标上，网页约定像素 (i, j) 覆盖 [i, i+1)、中心在 +0.5，
  所以写出的 cx、cy 比 OpenCV 的结果各加 0.5。
- 输出格式：{ fx, fy, cx, cy, width, height, dist, rms, ... }，width / height 为参考分辨率（横向）。
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

EXTS = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.bmp'}


def load_image(path):
    """读图并按 EXIF 方向转正，返回灰度 numpy 数组。HEIC 需要 pillow-heif。"""
    import numpy as np
    from PIL import Image, ImageOps

    if path.suffix.lower() in {'.heic', '.heif'}:
        try:
            import pillow_heif
        except ImportError:
            sys.exit('读取 HEIC 需要 pillow-heif：pip install pillow-heif（或先把照片导出为 JPG）')
        pillow_heif.register_heif_opener()
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        return np.array(im.convert('L'))


def main():
    ap = argparse.ArgumentParser(description='棋盘格相机标定，输出网页用的 intrinsics.json')
    ap.add_argument('folder', type=Path, help='棋盘格照片所在文件夹')
    ap.add_argument('--square', type=float, required=True, help='方格边长（mm，打印后实测）')
    ap.add_argument('--cols', type=int, default=9, help='每行内角点数（默认 9）')
    ap.add_argument('--rows', type=int, default=6, help='每列内角点数（默认 6）')
    ap.add_argument('--out', type=Path, default=Path('public/intrinsics.json'), help='输出文件（默认 public/intrinsics.json）')
    ap.add_argument('--min-images', type=int, default=10, help='至少需要多少张成功检测的照片（默认 10）')
    ap.add_argument('--show-errors', action='store_true', help='逐张打印重投影误差')
    args = ap.parse_args()

    import cv2
    import numpy as np

    files = sorted(p for p in args.folder.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        sys.exit(f'{args.folder} 里没有照片')

    pattern = (args.cols, args.rows)
    objp = np.zeros((args.cols * args.rows, 3), np.float32)
    objp[:, :2] = np.mgrid[0:args.cols, 0:args.rows].T.reshape(-1, 2) * args.square

    obj_pts, img_pts, used = [], [], []
    size = None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 1e-4)
    for f in files:
        gray = load_image(f)
        if gray.shape[0] > gray.shape[1]:
            # 竖拍：逆时针转 90° 回到传感器横向
            gray = cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)
        h, w = gray.shape
        if size is None:
            size = (w, h)
        elif size != (w, h):
            print(f'  跳过 {f.name}：分辨率 {w} × {h} 与第一张 {size[0]} × {size[1]} 不同')
            continue
        # 先在缩小图上找角点（快），再回到原图亚像素精修
        scale = min(1.0, 1600 / max(w, h))
        small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else gray
        flags = cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
        ok, corners = cv2.findChessboardCorners(small, pattern, flags)
        if not ok:
            print(f'  跳过 {f.name}：没找到 {args.cols} × {args.rows} 个内角点')
            continue
        corners = corners / scale
        corners = cv2.cornerSubPix(gray, corners.astype(np.float32), (11, 11), (-1, -1), criteria)
        obj_pts.append(objp)
        img_pts.append(corners)
        used.append(f.name)
        print(f'  ✓ {f.name}')

    n = len(used)
    print(f'成功检测 {n} / {len(files)} 张')
    if n < args.min_images:
        sys.exit(f'成功的照片少于 {args.min_images} 张，请补拍（棋盘格占画面 1/3 以上，从不同角度、不同位置拍，覆盖画面四角）')

    rms, K, dist, rvecs, tvecs = cv2.calibrateCamera(obj_pts, img_pts, size, None, None)
    w, h = size

    per_image = []
    for i in range(n):
        proj, _ = cv2.projectPoints(obj_pts[i], rvecs[i], tvecs[i], K, dist)
        err = np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - img_pts[i].reshape(-1, 2)) ** 2, axis=1)))
        per_image.append(float(err))
    if args.show_errors:
        for name, e in sorted(zip(used, per_image), key=lambda x: -x[1]):
            print(f'  {name}: {e:.3f} px')

    fx, fy = float(K[0, 0]), float(K[1, 1])
    cx, cy = float(K[0, 2]) + 0.5, float(K[1, 2]) + 0.5  # OpenCV 像素中心在整数坐标 → 网页约定 +0.5
    f35 = fx * 43.27 / np.hypot(w, h)
    out = {
        '说明': '棋盘格标定结果（tools/calibrate_camera.py 生成）。width / height 为参考分辨率（传感器横向）；cx、cy 已换成网页的像素中心约定（OpenCV 结果 + 0.5）。',
        'fx': round(fx, 3),
        'fy': round(fy, 3),
        'cx': round(cx, 3),
        'cy': round(cy, 3),
        'width': w,
        'height': h,
        'dist': [round(float(x), 6) for x in dist.ravel()],
        'rms': round(float(rms), 4),
        'images': n,
        'squareMm': args.square,
        'pattern': [args.cols, args.rows],
        'equivFocal35': round(float(f35), 2),
        'date': datetime.now().strftime('%Y-%m-%d %H:%M'),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'RMS 重投影误差：{rms:.3f} px')
    print(f'fx = {fx:.1f}，fy = {fy:.1f}，cx = {cx:.1f}，cy = {cy:.1f}（{w} × {h}）')
    print(f'折合等效焦距 {f35:.2f} mm（iPhone 13 Pro 主摄标称 26 mm）')
    if rms > 1.0:
        print('注意：RMS 大于 1 px，建议删掉误差最大的几张（--show-errors 查看）后重跑。')
    print(f'已写入 {args.out}')


if __name__ == '__main__':
    main()
