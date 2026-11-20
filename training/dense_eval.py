"""Evaluate small, crowded parts using the web preprocessing and selection policy.

IMG_9902 and the other holdout photos are development regression cases, never
training inputs. Choose training checkpoints on the original validation split.
"""
import argparse
import json
import time
import zlib
from pathlib import Path

import cv2
import numpy as np

import eval_light as ev
from led_kind import box_px, classify, read_labels

HERE = Path(__file__).resolve().parent


class Predictor:
    def __init__(self, model, size=1024, device='cuda'):
        self.size = size
        self.device = device
        self.model = Path(model)
        if self.model.suffix == '.onnx':
            import onnxruntime as ort
            options = ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.log_severity_level = 3
            self.net = ort.InferenceSession(str(model), options, providers=['CPUExecutionProvider'])
        else:
            import torch
            from ultralytics import YOLO
            torch.set_num_threads(4)
            self.net = YOLO(str(model)).model.to(device).eval()
            self.net.end2end = True

    def raw(self, img, min_score=0.05):
        x, gx, gy, dx, dy = ev.letterbox(img, self.size)
        if self.model.suffix == '.onnx':
            output = self.net.run(None, {self.net.get_inputs()[0].name: x})[0]
        else:
            import torch
            with torch.inference_mode():
                output = self.net(torch.from_numpy(x).to(self.device))
                if isinstance(output, tuple):
                    output = output[0]
                output = output.float().cpu().numpy()
        if output.shape[-1] != 6:
            raise ValueError(f'Expected end-to-end output, got {output.shape}')
        h, w = img.shape[:2]
        dets = []
        for x1, y1, x2, y2, score, cls in output[0]:
            if score < min_score:
                continue
            box = [float(np.clip((x1 - dx) / gx, 0, w)), float(np.clip((y1 - dy) / gy, 0, h)),
                   float(np.clip((x2 - dx) / gx, 0, w)), float(np.clip((y2 - dy) / gy, 0, h))]
            dets.append({'cls': int(cls), 'score': float(score), 'box': box})
        return dets


def selected(raw, score=0.4, low=0.25, low_iou=0.3, dedup=0.7):
    keep = []
    for d in sorted((d for d in raw if d['score'] >= score), key=lambda d: -d['score']):
        if all(k['cls'] != d['cls'] or ev.iou(k['box'], d['box']) <= dedup for k in keep):
            keep.append(d)
    for d in sorted((d for d in raw if low <= d['score'] < score), key=lambda d: -d['score']):
        if all(ev.iou(k['box'], d['box']) <= low_iou for k in keep):
            keep.append(d)
    return keep


def evaluate(model, sizes, conditions=('original',), images=HERE / 'holdout/images', labels=HERE / 'holdout/labels'):
    results = []
    for size in sizes:
        predict = Predictor(model, size)
        totals = {c: {k: [0, 0] for k in ev.KINDS} | {'fp': 0, 'wrong': 0} for c in conditions}
        photos = {}
        durations = []
        for ip in sorted(images.glob('*.jpg')):
            img = cv2.imread(str(ip))
            h, w = img.shape[:2]
            rows = read_labels(labels / f'{ip.stem}.txt')
            gts = [(r[0], box_px(r, w, h)) for r in rows]
            kinds = classify(img, rows)
            for cond in conditions:
                altered = ev.relight(img, cond, zlib.crc32(ip.stem.encode()))
                start = time.perf_counter()
                raw = predict.raw(altered)
                durations.append(time.perf_counter() - start)
                dets = selected(raw)
                hit, fp, wrong = ev.match(dets, gts)
                for kind, ok in zip(kinds, hit):
                    if kind in totals[cond]:
                        totals[cond][kind][0] += int(ok)
                        totals[cond][kind][1] += 1
                totals[cond]['fp'] += fp
                totals[cond]['wrong'] += wrong
                detail = []
                for idx, ((cls, box), kind, ok) in enumerate(zip(gts, kinds, hit)):
                    candidates = [d for d in raw if d['cls'] == cls and ev.iou(d['box'], box) >= 0.5]
                    best = max(candidates, key=lambda d: d['score'], default=None)
                    detail.append({'id': idx + 1, 'kind': kind, 'hit': bool(ok), 'box': list(box),
                                   'best_score_iou50': best['score'] if best else None,
                                   'best_iou': max((ev.iou(d['box'], box) for d in raw if d['cls'] == cls), default=0)})
                photos[f'{ip.stem}/{cond}'] = {'gt': detail, 'dets': dets, 'raw': raw, 'tp': sum(hit), 'fp': fp}
        entry = {'model': str(model), 'imgsz': size, 'results': totals, 'photos': photos,
                 'mean_inference_seconds': float(np.mean(durations[1:] or durations))}
        results.append(entry)
        print(json.dumps({k: v for k, v in entry.items() if k != 'photos'}, ensure_ascii=False), flush=True)
        focus = photos.get('IMG_9902/original', {})
        print('IMG_9902', json.dumps({k: v for k, v in focus.items() if k not in ('raw', 'dets')}, ensure_ascii=False), flush=True)
        del predict
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--model', type=Path, required=True)
    ap.add_argument('--sizes', type=int, nargs='+', default=[1024])
    ap.add_argument('--conditions', nargs='+', default=['original'], choices=ev.CONDS)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    results = evaluate(args.model, args.sizes, args.conditions)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
