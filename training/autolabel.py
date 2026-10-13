#!/usr/bin/env python3
"""预标注：按颜色在标定板上找零件本体，写成 YOLO 标注，导入标注工具后人工检查、修正。

只适用于本项目的场景：白色 A4 标定板 + 红色 LED（类别 2）+ 蓝色色环电阻（类别 0），框只包住本体、不含引脚。
做法：
1. 用 4 个 ArUco 码（DICT_4X4_50，ID 0–3）求出标定板到照片的单应，只在零件区域里找
   （板内缩 12 mm，挖掉 4 个码，与 src/config.js 的 WORK_AREA 一致），地面、码和板边文字都不会误检。
2. 在 HSV 颜色空间里取红色（LED 灯体）和蓝色（电阻本体）像素，闭运算把色环、高光连成一块，
   每个连通块的外接矩形就是一个框；块里红色像素多算 LED，蓝色多算电阻。
引脚是银灰色、饱和度低，自然不会被框进去。

已知局限（导入标注工具后人工修正）：
- 两个零件挨在一起时会合成一个框
- 找不到 4 个码中的至少 2 个的照片跳过，需要手工标注
- 不同颜色的电阻（如米色碳膜电阻）找不到

用法示例：
    python autolabel.py --images data/images --labels data/labels --preview data/preview
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

import numpy as np

# 与 src/config.js 一致：BOARD、MARKERS、WORK_AREA（单位 mm，原点在板左下角，+Y 远离操作者）
BOARD_W, BOARD_H = 297, 210
MARKER_SIZE = 40
MARKER_CENTERS = {0: (32, 32), 1: (265, 32), 2: (265, 178), 3: (32, 178)}
WORK_MARGIN, MARKER_PADDING = 12, 5

NAMES = ['resistor', 'capacitor', 'led', 'screw']  # 与 parts.yaml 一致
RESISTOR, LED = 0, 2


def imread(path):
    """支持中文路径的 cv2.imread"""
    import cv2
    data = np.fromfile(str(path), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)


def board_homography(img):
    """标定板 mm → 照片像素的单应；找到的码少于 2 个时返回 None"""
    import cv2
    det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50))
    corners, ids, _ = det.detectMarkers(img)
    if ids is None:
        return None, 0
    src, dst = [], []
    found = 0
    for c, i in zip(corners, ids.ravel()):
        if int(i) not in MARKER_CENTERS:
            continue
        found += 1
        cx, cy = MARKER_CENTERS[int(i)]
        h = MARKER_SIZE / 2
        # OpenCV 角点顺序：码的左上、右上、右下、左下；码"上方"朝 +Y
        for b, p in zip([(cx - h, cy + h), (cx + h, cy + h), (cx + h, cy - h), (cx - h, cy - h)], c[0]):
            src.append(b)
            dst.append(p)
    if found < 2:
        return None, found
    H, _ = cv2.findHomography(np.float32(src), np.float32(dst), cv2.RANSAC, 5)
    return H, found


def to_img(H, pts):
    import cv2
    return cv2.perspectiveTransform(np.float32(pts).reshape(-1, 1, 2), H).reshape(-1, 2)


def work_area_mask(shape, H):
    """零件区域：板内缩 WORK_MARGIN，挖掉 4 个码（各外扩 MARKER_PADDING）"""
    import cv2
    m = WORK_MARGIN
    mask = np.zeros(shape[:2], np.uint8)
    outline = to_img(H, [(m, m), (BOARD_W - m, m), (BOARD_W - m, BOARD_H - m), (m, BOARD_H - m)])
    cv2.fillPoly(mask, [outline.astype(np.int32)], 255)
    h = MARKER_SIZE / 2 + MARKER_PADDING
    for cx, cy in MARKER_CENTERS.values():
        sq = to_img(H, [(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)])
        cv2.fillPoly(mask, [sq.astype(np.int32)], 0)
    return mask, outline


def find_parts(img, H, args):
    """返回 [(类别, x, y, w, h)]（像素）"""
    import cv2
    roi, _ = work_area_mask(img.shape, H)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    red = ((hue <= 10) | (hue >= 170)) & (sat >= args.red_sat) & (val >= args.red_val)
    blue = (hue >= 80) & (hue <= 130) & (sat >= args.blue_sat)
    colored = ((red | blue) & (roi > 0)).astype(np.uint8)

    # 板中心附近 1 mm 对应的像素数，用来定闭运算核大小和最小面积
    p = to_img(H, [(BOARD_W / 2 - 5, BOARD_H / 2), (BOARD_W / 2 + 5, BOARD_H / 2)])
    px_mm = float(np.linalg.norm(p[1] - p[0])) / 10
    k = max(3, int(round(px_mm * args.close_mm)) | 1)
    closed = cv2.morphologyEx(colored, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(closed)
    parts = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < (args.min_mm * px_mm) ** 2:
            continue
        sel = lab[y:y + h, x:x + w] == i
        n_red = int((red[y:y + h, x:x + w] & sel).sum())
        n_blue = int((blue[y:y + h, x:x + w] & sel).sum())
        parts.append((LED if n_red > n_blue else RESISTOR, int(x), int(y), int(w), int(h)))
    return parts


def draw_preview(img, H, parts, out, max_side=1600):
    import cv2
    vis = img.copy()
    if H is not None:
        _, outline = work_area_mask(img.shape, H)
        cv2.polylines(vis, [outline.astype(np.int32)], True, (0, 200, 0), 3)
    for c, x, y, w, h in parts:
        color = (0, 0, 255) if c == LED else (255, 0, 0)
        cv2.rectangle(vis, (x, y), (x + w, y + h), color, 3)
        cv2.putText(vis, NAMES[c], (x, max(0, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, color, 3)
    k = max_side / max(vis.shape[:2])
    if k < 1:
        vis = cv2.resize(vis, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode('.jpg', vis, [cv2.IMWRITE_JPEG_QUALITY, 85])
    buf.tofile(str(out))


def main():
    ap = argparse.ArgumentParser(description='按颜色预标注：红色 LED（2）、蓝色电阻（0），只框本体')
    ap.add_argument('--images', type=Path, required=True, help='转正后的照片文件夹（prepare_images.py 的输出）')
    ap.add_argument('--labels', type=Path, required=True, help='输出 YOLO 标注的文件夹')
    ap.add_argument('--preview', type=Path, help='把框画在照片上存到这个文件夹，方便快速检查')
    ap.add_argument('--overwrite', action='store_true', help='覆盖已有的标注（默认跳过，免得冲掉手工修改过的）')
    ap.add_argument('--red-sat', type=int, default=100, help='红色最低饱和度 0–255（默认 100）')
    ap.add_argument('--red-val', type=int, default=50, help='红色最低亮度 0–255（默认 50）')
    ap.add_argument('--blue-sat', type=int, default=60, help='蓝色最低饱和度 0–255（默认 60）')
    ap.add_argument('--close-mm', type=float, default=1.5, help='闭运算核大小，mm（默认 1.5）')
    ap.add_argument('--min-mm', type=float, default=2.0, help='连通块最小面积 = 这个边长的正方形，mm（默认 2）')
    args = ap.parse_args()

    try:
        import cv2
        cv2.aruco.ArucoDetector
    except (ImportError, AttributeError):
        sys.exit('需要 OpenCV 4.7 以上：pip install -U opencv-python')

    images = sorted(p for p in args.images.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})
    if not images:
        sys.exit(f'{args.images} 里没有照片')
    args.labels.mkdir(parents=True, exist_ok=True)
    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
    # makesense.ai 导入 YOLO 标注时要一起选上这个文件
    (args.labels / 'labels.txt').write_text('\n'.join(NAMES) + '\n', encoding='utf-8')

    results = {}
    skipped, no_board = [], []
    for img_path in images:
        out = args.labels / f'{img_path.stem}.txt'
        if out.exists() and not args.overwrite:
            skipped.append(img_path.name)
            continue
        img = imread(img_path)
        if img is None:
            print(f'  {img_path.name}：读不出来，跳过')
            continue
        H, found = board_homography(img)
        if H is None:
            no_board.append(f'{img_path.name}（找到 {found} 个码）')
            if args.preview:
                draw_preview(img, None, [], args.preview / f'{img_path.stem}.jpg')
            continue
        parts = find_parts(img, H, args)
        ih, iw = img.shape[:2]
        lines = [f'{c} {(x + w / 2) / iw:.6f} {(y + h / 2) / ih:.6f} {w / iw:.6f} {h / ih:.6f}' for c, x, y, w, h in parts]
        out.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
        n_res = sum(c == RESISTOR for c, *_ in parts)
        n_led = sum(c == LED for c, *_ in parts)
        results[img_path.name] = (n_res, n_led)
        print(f'  {img_path.name}：电阻 {n_res}，LED {n_led}')
        if args.preview:
            draw_preview(img, H, parts, args.preview / f'{img_path.stem}.jpg')

    print(f'\n完成：{len(results)} 张写入 {args.labels}')
    if results:
        tot_r = sum(r for r, _ in results.values())
        tot_l = sum(l for _, l in results.values())
        print(f'各类别框数：resistor {tot_r}，led {tot_l}')
        common, _ = Counter(results.values()).most_common(1)[0]
        odd = [f'{k}（电阻 {r}，LED {l}）' for k, (r, l) in results.items() if (r, l) != common]
        if odd:
            print(f'\n大多数照片是 电阻 {common[0]}、LED {common[1]}。下面 {len(odd)} 张数量不同，'
                  '可能有漏框、两个零件合成一个框或误检，请优先检查：')
            for s in odd:
                print('  ' + s)
    if no_board:
        print(f'\n{len(no_board)} 张没找到标定板（码少于 2 个），没有写标注，需要手工标或删掉：')
        for s in no_board:
            print('  ' + s)
    if skipped:
        print(f'\n{len(skipped)} 张已有标注，跳过（要重新生成加 --overwrite）')


if __name__ == '__main__':
    main()
