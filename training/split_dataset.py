#!/usr/bin/env python3
"""按照片划分训练 / 验证 / 测试集（默认 8 : 1 : 1，随机种子固定），并生成训练用的数据集配置。

输入：照片文件夹 + 同名 YOLO 标注文件夹（img.jpg ↔ img.txt）。
输出（默认 datasets/parts）：
    images/{train,val,test}/*.jpg
    labels/{train,val,test}/*.txt
    parts.yaml  —— 以 training/parts.yaml 为模板、path 写成绝对路径（ultralytics 会把相对路径解析到它自己的
                   数据集目录下，而不是 yaml 所在目录，所以这里写绝对路径最稳妥）
    split.json  —— 每个集合里有哪些照片，方便复现和报告引用

独立测试集：给了 --test-images / --test-labels 时，测试集直接用这批另外拍的照片，
训练数据只按 TRAIN : VAL 划分成训练集和验证集（--ratios 的第三个数不起作用）。

用法示例：
    python split_dataset.py --images data/images --labels data/labels
    python split_dataset.py --images data/images --labels data/labels --test-images holdout/images --test-labels holdout/labels
    python split_dataset.py --images data/images --labels data/labels --out datasets/parts --seed 42 --dry-run
"""
import argparse
import json
import random
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPLITS = ('train', 'val', 'test')


def split_counts(n, ratios):
    """各集合的数量：按比例取整，余数给训练集；照片够 3 张时验证、测试集至少各 1 张"""
    r = [x / sum(ratios) for x in ratios]
    n_val = round(n * r[1])
    n_test = round(n * r[2])
    if n >= 3:
        n_val = max(1, n_val)
        n_test = max(1, n_test)
    return n - n_val - n_test, n_val, n_test


def load_names(template):
    """从 parts.yaml 读类别名（只认 "  id: name" 形式，免得依赖 pyyaml）"""
    names = {}
    in_names = False
    for line in template.read_text(encoding='utf-8').splitlines():
        s = line.split('#')[0].rstrip()
        if s.startswith('names:'):
            in_names = True
            continue
        if in_names:
            if not s.startswith(' ') or ':' not in s:
                if s:
                    in_names = False
                continue
            k, v = s.strip().split(':', 1)
            names[int(k)] = v.strip()
    return names


def main():
    ap = argparse.ArgumentParser(description='按照片划分训练 / 验证 / 测试集（8:1:1，随机种子固定）')
    ap.add_argument('--images', type=Path, required=True, help='照片文件夹（.jpg / .png）')
    ap.add_argument('--labels', type=Path, required=True, help='YOLO 标注文件夹（与照片同名的 .txt）')
    ap.add_argument('--out', type=Path, default=HERE / 'datasets' / 'parts', help='输出目录（默认 training/datasets/parts）')
    ap.add_argument('--ratios', type=float, nargs=3, default=(8, 1, 1), metavar=('TRAIN', 'VAL', 'TEST'), help='划分比例（默认 8 1 1）')
    ap.add_argument('--test-images', type=Path, help='独立测试集照片文件夹；给了就不从训练数据里抽测试集')
    ap.add_argument('--test-labels', type=Path, help='独立测试集标注文件夹（与 --test-images 一起给）')
    ap.add_argument('--seed', type=int, default=42, help='随机种子（默认 42）')
    ap.add_argument('--template', type=Path, default=HERE / 'parts.yaml', help='数据集配置模板（默认 training/parts.yaml）')
    ap.add_argument('--dry-run', action='store_true', help='只打印划分结果，不复制文件')
    args = ap.parse_args()

    def collect(img_dir, lab_dir):
        imgs = sorted(p for p in img_dir.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})
        if not imgs:
            sys.exit(f'{img_dir} 里没有照片')
        missing = [p.name for p in imgs if not (lab_dir / f'{p.stem}.txt').exists()]
        if missing:
            sys.exit(f'{lab_dir}：{len(missing)} 张照片没有标注：{", ".join(missing[:10])}')
        return imgs

    if (args.test_images is None) != (args.test_labels is None):
        sys.exit('--test-images 和 --test-labels 要一起给')
    images = collect(args.images, args.labels)
    labels = {'train': args.labels, 'val': args.labels, 'test': args.labels}
    order = list(images)
    random.Random(args.seed).shuffle(order)
    if args.test_images:
        test = collect(args.test_images, args.test_labels)
        same = sorted({p.stem for p in images} & {p.stem for p in test})
        if same:
            sys.exit(f'{len(same)} 张照片同时出现在训练数据和独立测试集里（{", ".join(same[:10])}），测试集必须是没参与训练的照片')
        n_val = max(1, round(len(order) * args.ratios[1] / (args.ratios[0] + args.ratios[1])))
        n_train = len(order) - n_val
        parts = {'train': order[:n_train], 'val': order[n_train:], 'test': test}
        labels['test'] = args.test_labels
    else:
        n_train, n_val, n_test = split_counts(len(order), args.ratios)
        parts = {'train': order[:n_train], 'val': order[n_train:n_train + n_val], 'test': order[n_train + n_val:]}

    names = load_names(args.template)
    print(f'训练数据 {len(images)} 张照片，种子 {args.seed}' + (f'；独立测试集 {len(parts["test"])} 张' if args.test_images else ''))
    for s in SPLITS:
        inst = [0] * len(names)
        for p in parts[s]:
            for line in (labels[s] / f'{p.stem}.txt').read_text(encoding='utf-8').splitlines():
                if line.strip():
                    inst[int(line.split()[0])] += 1
        print(f'  {s:5s} {len(parts[s]):4d} 张 · ' + '，'.join(f'{names[i]} {inst[i]}' for i in range(len(names))))
    if args.dry_run:
        return

    for s in SPLITS:
        for sub in ('images', 'labels'):
            d = args.out / sub / s
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True)
        for p in parts[s]:
            shutil.copy2(p, args.out / 'images' / s / p.name)
            shutil.copy2(labels[s] / f'{p.stem}.txt', args.out / 'labels' / s / f'{p.stem}.txt')

    out_abs = args.out.resolve()
    yaml = [
        '# 由 split_dataset.py 生成，请勿手改（改 training/parts.yaml 后重跑）',
        f'path: {out_abs.as_posix()}',
        'train: images/train',
        'val: images/val',
        'test: images/test',
        'names:',
        *[f'  {i}: {names[i]}' for i in sorted(names)],
    ]
    (args.out / 'parts.yaml').write_text('\n'.join(yaml) + '\n', encoding='utf-8')
    (args.out / 'split.json').write_text(
        json.dumps({'seed': args.seed, 'ratios': list(args.ratios), 'independentTest': bool(args.test_images), **{s: [p.name for p in parts[s]] for s in SPLITS}}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    print(f'已写入 {out_abs}（训练配置：{(args.out / "parts.yaml").resolve()}）')


if __name__ == '__main__':
    main()
