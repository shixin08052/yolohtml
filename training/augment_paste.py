#!/usr/bin/env python3
"""透明 LED 复制粘贴：补透明 LED 太少的问题（训练集里透明 LED 60 个，有色 LED 469 个），并多造一些"挤在一起"的透明 LED。

做法（只动训练集，验证 / 测试集原样复制）：
1. 从训练集照片里抠出透明 LED（led_kind.py 按饱和度判断）。挨在一起的零件整团抠（团里的电阻、有色 LED 也带上标注），
   抠图边缘外留一圈白纸；边缘那一圈里如果还有团外的零件，这个来源不用（不然会粘出半个没标注的零件）。
2. 每张训练照片生成一张变体：在白纸的空白处（不压已有零件、不压定位码）粘 1–3 团。
   - 有一半概率把 2–4 颗单个透明 LED 紧挨着粘成一团（灯体框贴边或略有间隙），专门练"多颗透明 LED 挤在一起"；
   - 粘之前按目标位置的纸面颜色调整抠图的亮度和色调（各通道增益），不同光照的照片之间粘过去不突兀；
   - 随机旋转 90° 的倍数、翻转、缩放 0.85–1.15；
   - 合成时每个像素取 alpha 最大的那一层：灯体框内 alpha = 1，向外渐变到 0，相邻的两颗不会互相盖掉灯体。
3. 训练图统一缩到长边 2048（模型输入 1024，再大没有用，读图还慢）。

用法：
    python augment_paste.py --src datasets/parts --out datasets/parts_aug --variants 1
"""
import argparse
import random
import shutil
from pathlib import Path

import cv2
import numpy as np

from led_kind import box_px, classify, read_labels

HERE = Path(__file__).resolve().parent
LONG_SIDE = 2048


def expand(b, p):
    return (b[0] - p, b[1] - p, b[2] + p, b[3] + p)


def inter(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def load(ip, labels_dir):
    img = cv2.imread(str(ip))
    s = LONG_SIDE / max(img.shape[:2])
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]
    rows = read_labels(labels_dir / f'{ip.stem}.txt')
    return img, rows, [box_px(r, w, h) for r in rows]


def ring_median(patch, frac=0.12):
    """抠图四周一圈（纸面）的各通道中位数"""
    h, w = patch.shape[:2]
    t = max(2, int(min(h, w) * frac))
    ring = np.concatenate([patch[:t].reshape(-1, 3), patch[-t:].reshape(-1, 3), patch[:, :t].reshape(-1, 3), patch[:, -t:].reshape(-1, 3)])
    return np.median(ring, axis=0).astype(np.float32)


def collect_sources(train_images, train_labels, include_colored=False):
    """抠出所有透明 LED（单颗或整团）。返回 [{patch, boxes:[(cls, x1,y1,x2,y2) 相对抠图], single}]"""
    sources = []
    for ip in sorted(train_images.glob('*.jpg')):
        img, rows, boxes = load(ip, train_labels)
        kinds = classify(img, rows)
        n = len(boxes)
        # 并查集：两个框（扩大 30% 后）相交就算挨在一起
        parent = list(range(n))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        sizes = [max(b[2] - b[0], b[3] - b[1]) for b in boxes]
        for i in range(n):
            for j in range(i + 1, n):
                if inter(expand(boxes[i], 0.3 * sizes[i]), expand(boxes[j], 0.3 * sizes[j])):
                    parent[find(i)] = find(j)
        groups = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)
        h, w = img.shape[:2]
        for members in groups.values():
            has_clear = any(kinds[i] == 'clear' for i in members)
            if not has_clear and not (include_colored and any(kinds[i] == 'color' for i in members)):
                continue
            ub = (min(boxes[i][0] for i in members), min(boxes[i][1] for i in members),
                  max(boxes[i][2] for i in members), max(boxes[i][3] for i in members))
            pad = 0.45 * max(sizes[i] for i in members)
            x1, y1, x2, y2 = map(int, expand(ub, pad))
            if x1 < 0 or y1 < 0 or x2 > w or y2 > h:
                continue
            if any(inter((x1, y1, x2, y2), boxes[k]) for k in range(n) if k not in members):
                continue  # 边上有团外的零件
            patch = img[y1:y2, x1:x2].copy()
            rel = [(rows[i][0], boxes[i][0] - x1, boxes[i][1] - y1, boxes[i][2] - x1, boxes[i][3] - y1) for i in members]
            sources.append({'patch': patch, 'boxes': rel, 'single': len(members) == 1, 'from': ip.stem, 'clear': has_clear})
    return sources


def transform(src, rng):
    """随机旋转 90° 倍数 / 翻转 / 缩放；框跟着变"""
    p = src['patch']
    bx = [list(b) for b in src['boxes']]
    for _ in range(rng.randrange(4)):  # 顺时针转 90°：(x, y) → (H - y, x)
        H = p.shape[0]
        p = cv2.rotate(p, cv2.ROTATE_90_CLOCKWISE)
        bx = [[c, H - y2, x1, H - y1, x2] for c, x1, y1, x2, y2 in bx]
    if rng.random() < 0.5:
        W = p.shape[1]
        p = p[:, ::-1]
        bx = [[c, W - x2, y1, W - x1, y2] for c, x1, y1, x2, y2 in bx]
    s = rng.uniform(0.85, 1.15)
    p = cv2.resize(np.ascontiguousarray(p), None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    bx = [[c, x1 * s, y1 * s, x2 * s, y2 * s] for c, x1, y1, x2, y2 in bx]
    return p, bx


def alpha_for(shape, boxes):
    """灯体框（略放大）内 1，向抠图边缘线性降到 0"""
    h, w = shape[:2]
    inside = np.zeros((h, w), np.uint8)
    for _, x1, y1, x2, y2 in boxes:
        e = 0.12 * max(x2 - x1, y2 - y1)
        cv2.rectangle(inside, (int(x1 - e), int(y1 - e)), (int(np.ceil(x2 + e)), int(np.ceil(y2 + e))), 1, -1)
    d_body = cv2.distanceTransform(1 - inside, cv2.DIST_L2, 3)  # 到灯体的距离
    yy, xx = np.mgrid[0:h, 0:w]
    d_edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)  # 到抠图边缘的距离
    a = d_edge / np.maximum(d_edge + d_body, 1e-3)
    a[inside > 0] = 1
    return np.clip(a, 0, 1) ** 0.8


def place_ok(gray, x1, y1, x2, y2, occupied, paper):
    h, w = gray.shape
    if x1 < 0 or y1 < 0 or x2 > w or y2 > h:
        return False
    if any(inter((x1, y1, x2, y2), o) for o in occupied):
        return False
    reg = gray[y1:y2, x1:x2]
    return reg.mean() > 0.8 * paper and reg.std() < 14  # 在纸面上（亮、平），不压定位码、桌面


def make_variant(img, rows, boxes, sources, rng):
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    paper = float(np.percentile(gray, 90))
    occupied = [expand(b, 0.6 * max(b[2] - b[0], b[3] - b[1])) for b in boxes]
    singles = [s for s in sources if s['single']]
    best_a = np.zeros((h, w), np.float32)
    best_c = np.zeros_like(img, dtype=np.float32)
    new = []
    for _ in range(rng.randint(1, 3)):
        # 一团：现成的整团 / 单颗，或者临时把几颗单颗拼成一团
        if rng.random() < 0.5 and singles:
            parts = [transform(rng.choice(singles), rng) for _ in range(rng.randint(2, 4))]
            # 依次挨着放：下一颗贴在上一颗灯体框的右边或下边，间隙 -5%（略压）到 +15%
            items, cx, cy = [], 0.0, 0.0
            for k, (p, bx) in enumerate(parts):
                _, bx1, by1, bx2, by2 = bx[0]
                if k == 0:
                    ox, oy = 0.0, 0.0
                else:
                    pb = items[-1][2]
                    gap = rng.uniform(-0.05, 0.15) * (bx2 - bx1 + by2 - by1) / 2
                    if rng.random() < 0.5:
                        ox, oy = pb[2] + gap - bx1, pb[1] + rng.uniform(-0.4, 0.4) * (pb[3] - pb[1]) - by1
                    else:
                        ox, oy = pb[0] + rng.uniform(-0.4, 0.4) * (pb[2] - pb[0]) - bx1, pb[3] + gap - by1
                items.append((p, (ox, oy), (bx1 + ox, by1 + oy, bx2 + ox, by2 + oy), bx))
            # 团内一颗的灯体被另一颗压了超过 15% 就放弃这一团
            bodies = [it[2] for it in items]
            def ov(a, b):
                ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
                return ix * iy / ((a[2] - a[0]) * (a[3] - a[1]))
            if any(ov(a, b) > 0.15 for i, a in enumerate(bodies) for j, b in enumerate(bodies) if i != j):
                continue
            group = [(p, off, bx) for p, off, _, bx in items]
        else:
            p, bx = transform(rng.choice(sources), rng)
            group = [(p, (0.0, 0.0), bx)]
        gx1 = min(off[0] for _, off, _ in group)
        gy1 = min(off[1] for _, off, _ in group)
        gx2 = max(off[0] + p.shape[1] for p, off, _ in group)
        gy2 = max(off[1] + p.shape[0] for p, off, _ in group)
        gw, gh = int(np.ceil(gx2 - gx1)), int(np.ceil(gy2 - gy1))
        for _ in range(60):  # 找一块空白纸面
            tx, ty = rng.randrange(0, max(1, w - gw)), rng.randrange(0, max(1, h - gh))
            if place_ok(gray, tx, ty, tx + gw, ty + gh, occupied, paper):
                break
        else:
            continue
        target_ring = ring_median(img[ty:ty + gh, tx:tx + gw])
        for p, (ox, oy), bx in group:
            px, py = int(round(tx + ox - gx1)), int(round(ty + oy - gy1))
            ph, pw = p.shape[:2]
            if px < 0 or py < 0 or px + pw > w or py + ph > h:
                continue
            gain = np.clip(target_ring / np.maximum(ring_median(p), 1), 0.5, 2.0)
            col = np.clip(p.astype(np.float32) * gain, 0, 255)
            a = alpha_for(p.shape, bx)
            ra, rc = best_a[py:py + ph, px:px + pw], best_c[py:py + ph, px:px + pw]
            m = a > ra
            ra[m] = a[m]
            rc[m] = col[m]
            for c, x1, y1, x2, y2 in bx:
                new.append((int(c), px + x1, py + y1, px + x2, py + y2))
        occupied.append((tx, ty, tx + gw, ty + gh))
    if not new:
        return None, None
    a = best_a[..., None]
    out = (img.astype(np.float32) * (1 - a) + best_c * a).round().astype(np.uint8)
    all_rows = list(rows) + [(c, (x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h) for c, x1, y1, x2, y2 in new]
    return out, all_rows


def write_labels(path, rows):
    path.write_text('\n'.join(f'{int(r[0])} {r[1]:.6f} {r[2]:.6f} {r[3]:.6f} {r[4]:.6f}' for r in rows) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', type=Path, default=HERE / 'datasets' / 'parts', help='split_dataset.py 的输出')
    ap.add_argument('--out', type=Path, default=HERE / 'datasets' / 'parts_aug')
    ap.add_argument('--variants', type=int, default=1, help='每张训练照片生成几张粘贴变体（默认 1）')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    if args.out.exists():
        shutil.rmtree(args.out)
    for split in ('val', 'test'):
        shutil.copytree(args.src / 'images' / split, args.out / 'images' / split)
        shutil.copytree(args.src / 'labels' / split, args.out / 'labels' / split)
    ti, tl = args.src / 'images' / 'train', args.src / 'labels' / 'train'
    oi, ol = args.out / 'images' / 'train', args.out / 'labels' / 'train'
    oi.mkdir(parents=True)
    ol.mkdir(parents=True)

    sources = collect_sources(ti, tl)
    print(f'透明 LED 来源 {len(sources)} 个（单颗 {sum(s["single"] for s in sources)}，整团 {sum(not s["single"] for s in sources)}）')
    added = 0
    for ip in sorted(ti.glob('*.jpg')):
        img, rows, boxes = load(ip, tl)
        cv2.imwrite(str(oi / ip.name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        write_labels(ol / f'{ip.stem}.txt', rows)
        for v in range(args.variants):
            own = [s for s in sources if s['from'] != ip.stem] or sources
            out, all_rows = make_variant(img, rows, boxes, own, rng)
            if out is None:
                continue
            name = f'{ip.stem}_paste{v}'
            cv2.imwrite(str(oi / f'{name}.jpg'), out, [cv2.IMWRITE_JPEG_QUALITY, 95])
            write_labels(ol / f'{name}.txt', all_rows)
            added += len(all_rows) - len(rows)
    yaml = (args.src / 'parts.yaml').read_text(encoding='utf-8').replace(args.src.resolve().as_posix(), args.out.resolve().as_posix())
    (args.out / 'parts.yaml').write_text(yaml, encoding='utf-8')
    n = len(list(oi.glob('*.jpg')))
    print(f'训练集 {n} 张（含粘贴变体），新粘上的零件框 {added} 个；配置：{args.out / "parts.yaml"}')


if __name__ == '__main__':
    main()
