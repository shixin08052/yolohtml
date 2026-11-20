#!/usr/bin/env python3
"""光照鲁棒性评估：在独立测试集上，把照片改成不同光照后跑 ONNX 模型，按"电阻 / 透明 LED / 有色 LED"分别统计召回率。

- 推理与网页一致：等比缩放到 1024、填灰 114、onnxruntime；挑框规则照搬 src/vision/yolo.js 的 selectDetections
  （≥ 0.4 的同类去重后全留；0.25–0.4 的只在与已留的框都几乎不重叠时补上）。
- 光照变化是确定性的（每张照片固定随机种子），新旧模型看到的是同一批图。这里的实现与训练增强（augment_light.py）
  分开写、参数也不同，避免"考题和练习题一模一样"；但它终归是合成的，只能当真实光照变化的近似。
- 匹配：同类、IoU ≥ 0.5，按分数从高到低一对一。漏检 = 召回不到；误检 = 没对上任何标注的框；"错类" = 与异类标注 IoU ≥ 0.5。

用法：
    python eval_light.py --model ../public/models/best.onnx --out runs/eval_old.json
    python eval_light.py --model runs/detect/light/weights/best.onnx --out runs/eval_new.json --compare runs/eval_old.json
"""
import argparse
import json
import zlib
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from led_kind import box_px, classify, read_labels

HERE = Path(__file__).resolve().parent
IMGSZ = 1024
SCORE, LOW, LOW_MAX_IOU, DEDUP_IOU = 0.4, 0.25, 0.3, 0.7
KINDS = ('resistor', 'clear', 'color')
KIND_NAMES = {'resistor': '电阻', 'clear': '透明 LED', 'color': '有色 LED'}


# ---------------- 光照变化（评估用） ----------------
def _soft_mask(h, w, rng, kind):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    if kind == 'shadow':
        # 一大块带软边的阴影：一条随机方向的直线把画面分开，一侧变暗（手、手机、身体挡光）
        ang = rng.uniform(0, np.pi)
        cx, cy = rng.uniform(0.35, 0.65) * w, rng.uniform(0.35, 0.65) * h
        d = (xx - cx) * np.cos(ang) + (yy - cy) * np.sin(ang)
        return 1 / (1 + np.exp(-d / (0.015 * max(h, w))))
    # 台灯斜照：一个亮斑 + 向四周衰减
    cx, cy = rng.uniform(0.25, 0.75) * w, rng.uniform(0.25, 0.75) * h
    r = 0.45 * max(h, w)
    return np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))


def relight(img, cond, seed):
    """img: BGR uint8 → 同尺寸 BGR uint8"""
    if cond == 'original':
        return img
    rng = np.random.default_rng(seed)
    f = img.astype(np.float32) / 255.0
    h, w = f.shape[:2]
    if cond == 'dim':  # 光线暗：曝光 ×0.35，加暗部噪声（手机在暗处会拉 ISO）
        f = f * 0.35
        f = f + rng.normal(0, 0.012, f.shape).astype(np.float32)
    elif cond == 'overexposed':  # 过曝：亮部糊成一片白，透明灯体的边最容易丢
        f = np.clip(f * 1.7 + 0.05, 0, 1)
    elif cond == 'warm':  # 暖光（白炽灯 / 暖色台灯）
        f = f * np.array([0.62, 0.88, 1.12], np.float32)  # BGR
    elif cond == 'cool':  # 冷光 / 阴天窗边
        f = f * np.array([1.15, 0.97, 0.78], np.float32)
    elif cond == 'shadow':  # 半边阴影（亮暗比约 1 : 0.35），阴影里略偏蓝
        m = _soft_mask(h, w, rng, 'shadow')[..., None]
        dark = f * np.array([0.42, 0.36, 0.33], np.float32)
        f = f * (1 - m) + dark * m
    elif cond == 'spotlight':  # 台灯斜照：中间亮四周暗，亮斑附近接近过曝
        m = _soft_mask(h, w, rng, 'spot')[..., None]
        f = f * (0.35 + 1.25 * m)
    elif cond == 'flat':  # 低对比（散射光 / 镜头起雾）
        f = 0.55 * f + 0.35
    return (np.clip(f, 0, 1) * 255).astype(np.uint8)


CONDS = ('original', 'dim', 'overexposed', 'warm', 'cool', 'shadow', 'spotlight', 'flat')
COND_NAMES = {'original': '原图', 'dim': '暗光', 'overexposed': '过曝', 'warm': '暖光', 'cool': '冷光',
              'shadow': '半边阴影', 'spotlight': '台灯斜照', 'flat': '低对比'}


# ---------------- 推理（与网页一致） ----------------
def letterbox(img, imgsz=IMGSZ):
    h, w = img.shape[:2]
    s = imgsz / max(h, w)
    nw, nh = round(w * s), round(h * s)
    # 网页直接对解码像素做双线性插值，再除以 255；不能用 INTER_AREA，
    # 也不能先取整成 uint8（透明 LED 的低分框会受这点差异影响）。
    canvas = np.full((imgsz, imgsz, 3), 114, np.float32)
    dx, dy = (imgsz - nw) // 2, (imgsz - nh) // 2
    canvas[dy:dy + nh, dx:dx + nw] = cv2.resize(img.astype(np.float32), (nw, nh), interpolation=cv2.INTER_LINEAR)
    x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return x, nw / w, nh / h, dx, dy


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def select(raw):
    """src/vision/yolo.js 的 selectDetections"""
    keep = []
    for d in sorted([d for d in raw if d['score'] >= SCORE], key=lambda d: -d['score']):
        if all(k['cls'] != d['cls'] or iou(k['box'], d['box']) <= DEDUP_IOU for k in keep):
            keep.append(d)
    for d in sorted([d for d in raw if LOW <= d['score'] < SCORE], key=lambda d: -d['score']):
        if all(iou(k['box'], d['box']) <= LOW_MAX_IOU for k in keep):
            keep.append(d)
    return keep


def detect(sess, img):
    shape = sess.get_inputs()[0].shape
    if not isinstance(shape[2], int) or shape[2] != shape[3]:
        raise ValueError(f'Expected a fixed square input, got {shape}')
    x, gx, gy, dx, dy = letterbox(img, shape[2])
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
    raw = []
    for x1, y1, x2, y2, score, cls in out:
        if score < LOW:
            continue
        h, w = img.shape[:2]
        box = (np.clip((x1 - dx) / gx, 0, w), np.clip((y1 - dy) / gy, 0, h),
               np.clip((x2 - dx) / gx, 0, w), np.clip((y2 - dy) / gy, 0, h))
        raw.append({'box': box, 'score': float(score), 'cls': int(cls)})
    return select(raw)


def match(dets, gts):
    """返回 (每个标注是否命中, 误检数, 错类数)"""
    hit = [False] * len(gts)
    fp = wrong = 0
    for d in sorted(dets, key=lambda d: -d['score']):
        best, bi = 0.5, -1
        for i, (cls, box) in enumerate(gts):
            if not hit[i] and cls == d['cls']:
                v = iou(d['box'], box)
                if v >= best:
                    best, bi = v, i
        if bi >= 0:
            hit[bi] = True
        else:
            fp += 1
            if any(cls != d['cls'] and iou(d['box'], box) >= 0.5 for cls, box in gts):
                wrong += 1
    return hit, fp, wrong


def evaluate(model, images, labels):
    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(str(model), so, providers=['CPUExecutionProvider'])
    res = {c: {k: [0, 0] for k in KINDS} | {'fp': 0, 'wrong': 0} for c in CONDS}
    misses = {c: [] for c in CONDS}
    for ip in sorted(images.glob('*.jpg')):
        img = cv2.imread(str(ip))
        h, w = img.shape[:2]
        rows = read_labels(labels / f'{ip.stem}.txt')
        kinds = classify(img, rows)  # 按原图分透明 / 有色
        gts = [(r[0], box_px(r, w, h)) for r in rows]
        seed = zlib.crc32(ip.stem.encode())
        for c in CONDS:
            hit, fp, wrong = match(detect(sess, relight(img, c, seed)), gts)
            for k, ok in zip(kinds, hit):
                if k in res[c]:
                    res[c][k][0] += ok
                    res[c][k][1] += 1
            res[c]['fp'] += fp
            res[c]['wrong'] += wrong
            misses[c] += [f'{ip.stem}:{k}' for k, ok in zip(kinds, hit) if not ok]
    return {'model': str(model), 'protocol': {
        'preprocess': 'bilinear float32, RGB / 255, NCHW, centered padding 114',
        'imgsz': sess.get_inputs()[0].shape[2], 'score': SCORE, 'low': LOW, 'dedup_iou': DEDUP_IOU,
        'low_max_iou': LOW_MAX_IOU, 'match_iou': 0.5,
        'led_kind': 'original-image saturation heuristic (led_kind.py)',
    }, 'results': res, 'misses': misses}


def table(cur, prev=None):
    lines = ['| 光照 | ' + ' | '.join(KIND_NAMES[k] + ' 召回' for k in KINDS) + ' | 误检 | 错类 |', '|' + ' --- |' * (len(KINDS) + 3)]
    tot = {k: [0, 0] for k in KINDS}
    ptot = {k: [0, 0] for k in KINDS}
    for c in CONDS:
        r = cur['results'][c]
        p = prev['results'][c] if prev else None
        cells = []
        for k in KINDS:
            n, d = r[k]
            tot[k][0] += n
            tot[k][1] += d
            s = f'{n}/{d} ({n / d:.0%})'
            if p:
                pn = p[k][0]
                ptot[k][0] += pn
                ptot[k][1] += p[k][1]
                s += f' ← {pn}' if pn != n else ''
            cells.append(s)
        fp = f"{r['fp']}" + (f" ← {p['fp']}" if p and p['fp'] != r['fp'] else '')
        wr = f"{r['wrong']}" + (f" ← {p['wrong']}" if p and p['wrong'] != r['wrong'] else '')
        lines.append(f'| {COND_NAMES[c]} | ' + ' | '.join(cells) + f' | {fp} | {wr} |')
    cells = []
    for k in KINDS:
        s = f'{tot[k][0]}/{tot[k][1]} ({tot[k][0] / tot[k][1]:.1%})'
        if prev:
            s += f' ← {ptot[k][0] / ptot[k][1]:.1%}'
        cells.append(s)
    lines.append('| **合计** | ' + ' | '.join(cells) + ' | | |')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--model', type=Path, required=True, help='ONNX 模型（端到端输出 [1, N, 6]）')
    ap.add_argument('--images', type=Path, default=HERE / 'holdout' / 'images')
    ap.add_argument('--labels', type=Path, default=HERE / 'holdout' / 'labels')
    ap.add_argument('--out', type=Path, help='结果写成 json')
    ap.add_argument('--compare', type=Path, help='上一次的结果 json：表格里"← 数字"是它的值')
    ap.add_argument('--samples', type=Path, help='把每种光照的第一张图存到这个目录（看效果）')
    args = ap.parse_args()

    if args.samples:
        args.samples.mkdir(parents=True, exist_ok=True)
        ip = sorted(args.images.glob('*.jpg'))[0]
        img = cv2.imread(str(ip))
        tiles = [cv2.resize(relight(img, c, zlib.crc32(ip.stem.encode())), (504, 378)) for c in CONDS]
        for t, c in zip(tiles, CONDS):
            cv2.putText(t, c, (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
        cv2.imwrite(str(args.samples / 'conditions.jpg'), np.vstack([np.hstack(tiles[i:i + 4]) for i in (0, 4)]))

    cur = evaluate(args.model, args.images, args.labels)
    prev = json.loads(args.compare.read_text(encoding='utf-8')) if args.compare else None
    print(table(cur, prev))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
