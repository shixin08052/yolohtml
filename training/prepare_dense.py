"""Create full-scene, mixed-LED paste and closer-view training examples, train split only."""
import argparse
import json
import random
import shutil
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

from augment_paste import collect_sources, load, make_variant, write_labels
from led_kind import box_px, classify, read_labels

HERE = Path(__file__).resolve().parent


def crop_example(img, rows, rng):
    h, w = img.shape[:2]
    boxes = [box_px(row, w, h) for row in rows]
    kinds = classify(img, rows)
    choices = [i for i, k in enumerate(kinds) if k == 'clear'] or [i for i, r in enumerate(rows) if r[0] == 2]
    if not choices:
        choices = list(range(len(rows)))
    if not choices:
        return None
    for _ in range(40):
        b = boxes[rng.choice(choices)]
        fraction = rng.uniform(0.45, 0.72)
        cw, ch = int(w * fraction), int(h * fraction)
        cx = (b[0] + b[2]) / 2 + rng.uniform(-0.2, 0.2) * cw
        cy = (b[1] + b[3]) / 2 + rng.uniform(-0.2, 0.2) * ch
        x = int(np.clip(cx - cw / 2, 0, w - cw))
        y = int(np.clip(cy - ch / 2, 0, h - ch))
        labels = []
        partial = False
        for row, box in zip(rows, boxes):
            ix = max(0, min(box[2], x + cw) - max(box[0], x))
            iy = max(0, min(box[3], y + ch) - max(box[1], y))
            if ix * iy == 0:
                continue
            if ix * iy < 0.999 * (box[2] - box[0]) * (box[3] - box[1]):
                partial = True
                break  # never create an unlabelled partial body at the crop edge
            labels.append((row[0], ((box[0] + box[2]) / 2 - x) / cw,
                           ((box[1] + box[3]) / 2 - y) / ch, (box[2] - box[0]) / cw, (box[3] - box[1]) / ch))
        if not partial and labels:
            return img[y:y + ch, x:x + cw].copy(), labels
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--src', type=Path, default=HERE / 'datasets/parts')
    ap.add_argument('--out', type=Path, default=HERE / 'datasets/parts_dense_v1')
    ap.add_argument('--seed', type=int, default=18)
    args = ap.parse_args()
    if args.out.exists():
        raise SystemExit(f'Refusing to overwrite {args.out}')
    rng = random.Random(args.seed)
    for split in ('train', 'val', 'test'):
        for kind in ('images', 'labels'):
            (args.out / kind / split).mkdir(parents=True)
    for split in ('val', 'test'):
        for kind in ('images', 'labels'):
            shutil.copytree(args.src / kind / split, args.out / kind / split, dirs_exist_ok=True)
    ti, tl = args.src / 'images/train', args.src / 'labels/train'
    oi, ol = args.out / 'images/train', args.out / 'labels/train'
    sources = collect_sources(ti, tl, include_colored=True)
    clear = [s for s in sources if s['clear']]
    color = [s for s in sources if not s['clear']]
    # Equalize the source-pool probabilities without touching validation or holdout.
    weighted = sources + clear * max(0, round(len(color) / max(1, len(clear))) - 1)
    manifest = {'seed': args.seed, 'source': str(args.src.resolve()), 'sources': len(sources),
                'clear_sources': len(clear), 'examples': []}
    counts = Counter()

    def save(name, img, rows, parent, kind):
        cv2.imwrite(str(oi / f'{name}.jpg'), img, [cv2.IMWRITE_JPEG_QUALITY, 96])
        write_labels(ol / f'{name}.txt', rows)
        counts.update(str(int(r[0])) for r in rows)
        manifest['examples'].append({'name': name, 'parent': parent, 'kind': kind, 'objects': len(rows)})

    for ip in sorted(ti.glob('*.jpg')):
        original = cv2.imread(str(ip))
        rows = read_labels(tl / f'{ip.stem}.txt')
        s = min(1.0, 3072 / max(original.shape[:2]))
        full = cv2.resize(original, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else original
        save(ip.stem, full, rows, ip.stem, 'full')
        closer = crop_example(original, rows, rng)
        if closer:
            save(f'{ip.stem}_close', *closer, ip.stem, 'close')
        img, _, boxes = load(ip, tl)
        own = [source for source in weighted if source['from'] != ip.stem]
        pasted, pasted_rows = make_variant(img, rows, boxes, own, rng)
        if pasted is not None:
            save(f'{ip.stem}_mixed', pasted, pasted_rows, ip.stem, 'mixed_paste')
    text = (args.src / 'parts.yaml').read_text(encoding='utf-8')
    (args.out / 'parts.yaml').write_text(text.replace(args.src.resolve().as_posix(), args.out.resolve().as_posix()), encoding='utf-8')
    manifest['class_counts'] = dict(counts)
    (args.out / 'augmentation_manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'images': len(manifest['examples']), 'classes': dict(counts),
                      'kinds': dict(Counter(e['kind'] for e in manifest['examples'])),
                      'sources': len(sources), 'clear_sources': len(clear)}, indent=2), flush=True)


if __name__ == '__main__':
    main()
