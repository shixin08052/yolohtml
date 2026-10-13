#!/usr/bin/env python3
"""生成标定棋盘格：默认输出 A4 横向的矢量 PDF，打印时选"实际大小 / 100%"，方格就是指定的毫米数。

默认 10 × 7 个方格（9 × 6 个内角点），方格 25 mm，与 calibrate_camera.py 的默认值一致。
页面下方有一条 100 mm 比例尺，打印后量一下它就知道有没有被缩放；标定时 --square 填实测的方格边长。
PDF 不依赖任何第三方库（手写最小 PDF）；输出文件名以 .png 结尾时改为输出 300 DPI 的 PNG（需要 pillow）。

用法示例：
    python tools/make_chessboard.py                          # chessboard_a4.pdf
    python tools/make_chessboard.py --paper letter           # 美式信纸
    python tools/make_chessboard.py --paper a3 --square 35   # A3 大棋盘
    python tools/make_chessboard.py --out chessboard_a4.png  # PNG
"""
import argparse
from pathlib import Path

PAPERS = {'a4': (297.0, 210.0), 'a3': (420.0, 297.0), 'letter': (279.4, 215.9)}  # 横向，mm
MARGIN = 10.0  # 棋盘离纸边至少这么多 mm（大多数打印机四边各有 3–5 mm 打印不到）
PT = 72 / 25.4  # 1 mm = 2.835 pt


def layout(args):
    """返回 (纸宽, 纸高, 黑格列表 [(x, y, w, h)]，文字 [(x, y, 字号, 内容)], 线段 [(x0, y0, x1, y1)])，单位 mm，原点在左上角"""
    page_w, page_h = PAPERS[args.paper]
    if args.portrait:
        page_w, page_h = page_h, page_w
    nx, ny = args.cols + 1, args.rows + 1
    s = args.square
    bw, bh = nx * s, ny * s
    foot = 12  # 棋盘下方留给说明文字和比例尺的高度，mm
    if bw > page_w - 2 * MARGIN or bh > page_h - 2 * MARGIN - foot:
        raise SystemExit(f'棋盘 {bw:.0f} × {bh:.0f} mm 放不进 {args.paper.upper()}'
                         f'（四边留 {MARGIN:.0f} mm、下方留 {foot} mm 写说明），请减小 --square')
    x0 = (page_w - bw) / 2
    y0 = (page_h - foot - bh) / 2
    squares = [(x0 + c * s, y0 + r * s, s, s) for r in range(ny) for c in range(nx) if (r + c) % 2 == 0]

    # 棋盘下方：第一行说明文字，第二行 100 mm 比例尺（左对齐）
    ty = y0 + bh + 5
    texts = [(x0, ty, 9, f'Chessboard {args.cols} x {args.rows} inner corners, square {s:g} mm, '
                         f'{args.paper.upper()} {"portrait" if args.portrait else "landscape"}. '
                         'Print at 100% / Actual size.')]
    ruler = 100.0 if bw >= 100 else 50.0
    rx, ry = x0, ty + 6
    lines = [(rx, ry, rx + ruler, ry)] + [(rx + k * 10, ry - (2.5 if k % 5 == 0 else 1.5), rx + k * 10, ry)
                                         for k in range(int(ruler / 10) + 1)]
    texts.append((rx + ruler + 2, ry, 7, f'{ruler:g} mm (measure to check the print scale)'))
    return page_w, page_h, squares, texts, lines


def write_pdf(path, page_w, page_h, squares, texts, lines):
    """手写单页 PDF：页面尺寸即纸张尺寸，黑格是填充矩形，文字用内置 Helvetica"""
    H = page_h * PT
    f = lambda v: f'{v:.3f}'.rstrip('0').rstrip('.')
    ops = ['0 g']
    for x, y, w, h in squares:  # PDF 原点在左下角，y 要翻转
        ops.append(f'{f(x * PT)} {f(H - (y + h) * PT)} {f(w * PT)} {f(h * PT)} re')
    ops.append('f')
    ops.append('0.3 w')
    for xa, ya, xb, yb in lines:
        ops.append(f'{f(xa * PT)} {f(H - ya * PT)} m {f(xb * PT)} {f(H - yb * PT)} l')
    ops.append('S')
    for x, y, size, s in texts:
        s = s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        ops.append(f'BT /F1 {size} Tf {f(x * PT)} {f(H - y * PT)} Td ({s}) Tj ET')
    content = '\n'.join(ops).encode('latin-1')

    objs = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {f(page_w * PT)} {f(H)}] '
         f'/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>').encode(),
        b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f'{i} 0 obj\n'.encode() + o + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode()
    out += b''.join(f'{o:010d} 00000 n \n'.encode() for o in offsets)
    out += f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    Path(path).write_bytes(bytes(out))


def write_png(path, dpi, page_w, page_h, squares, texts, lines):
    from PIL import Image, ImageDraw

    px = dpi / 25.4
    img = Image.new('L', (round(page_w * px), round(page_h * px)), 255)
    d = ImageDraw.Draw(img)
    for x, y, w, h in squares:
        d.rectangle([round(x * px), round(y * px), round((x + w) * px) - 1, round((y + h) * px) - 1], fill=0)
    for xa, ya, xb, yb in lines:
        d.line([round(xa * px), round(ya * px), round(xb * px), round(yb * px)], fill=0, width=max(1, round(0.3 * px)))
    for x, y, _, s in texts:
        d.text((round(x * px), round((y - 3) * px)), s, fill=0)
    img.save(path, dpi=(dpi, dpi))


def main():
    ap = argparse.ArgumentParser(description='生成标定棋盘格（默认 A4 横向矢量 PDF）')
    ap.add_argument('--cols', type=int, default=9, help='每行内角点数（默认 9，即 10 列方格）')
    ap.add_argument('--rows', type=int, default=6, help='每列内角点数（默认 6，即 7 行方格）')
    ap.add_argument('--square', type=float, default=25.0, help='方格边长 mm（默认 25）')
    ap.add_argument('--paper', choices=sorted(PAPERS), default='a4', help='纸张（默认 a4）')
    ap.add_argument('--portrait', action='store_true', help='竖向（默认横向）')
    ap.add_argument('--dpi', type=int, default=300, help='只对 PNG 有效：分辨率（默认 300）')
    ap.add_argument('--out', type=Path, help='输出文件，.pdf 或 .png（默认 chessboard_<纸张>.pdf）')
    args = ap.parse_args()

    out = args.out or Path(f'chessboard_{args.paper}.pdf')
    page = layout(args)
    if out.suffix.lower() == '.png':
        write_png(out, args.dpi, *page)
    else:
        write_pdf(out, *page)
    print(f'已生成 {out}：{args.cols + 1} × {args.rows + 1} 个方格（{args.cols} × {args.rows} 个内角点），'
          f'方格 {args.square:g} mm，{args.paper.upper()} {"竖向" if args.portrait else "横向"}')
    print('打印时选"实际大小 / 100%"（不要选"适合页面"），打印后量一下比例尺和方格边长')


if __name__ == '__main__':
    main()
