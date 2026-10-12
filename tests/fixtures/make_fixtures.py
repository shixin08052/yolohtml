"""生成单元测试用的小 JPEG（带 / 不带 EXIF）。

用法：python tests/fixtures/make_fixtures.py [输出目录] [宽] [高]
依赖：pillow、piexif。默认在本目录生成 80×60 的小图；传入宽高可生成大图（用于浏览器测试）。
每张图在"正确显示方向"的左上角画一个红块，用来检查 EXIF 方向是否被正确应用。
"""
import os
import sys

import piexif
from PIL import Image, ImageDraw

out = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
W = int(sys.argv[2]) if len(sys.argv) > 2 else 80
H = int(sys.argv[3]) if len(sys.argv) > 3 else 60


def displayed(w, h):
    """正确方向下的画面：灰底，左上角红块，右下角蓝块"""
    im = Image.new('RGB', (w, h), (200, 200, 200))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w // 4, h // 4], fill=(220, 30, 30))
    d.rectangle([w * 3 // 4, h * 3 // 4, w - 1, h - 1], fill=(30, 30, 220))
    return im


def exif(focal35, focal_mm, lens, orientation=1):
    zeroth = {
        piexif.ImageIFD.Make: b'Apple',
        piexif.ImageIFD.Model: b'iPhone 13 Pro',
        piexif.ImageIFD.Orientation: orientation,
    }
    ex = {
        piexif.ExifIFD.FocalLengthIn35mmFilm: focal35,
        piexif.ExifIFD.FocalLength: (int(round(focal_mm * 100)), 100),
        piexif.ExifIFD.LensModel: lens.encode(),
    }
    return piexif.dump({'0th': zeroth, 'Exif': ex})


MAIN = 'iPhone 13 Pro back triple camera 5.7mm f/1.5'
TELE = 'iPhone 13 Pro back triple camera 9mm f/2.8'

# 横拍：像素即显示方向
displayed(W, H).save(os.path.join(out, 'landscape_26.jpg'), quality=90, exif=exif(26, 5.7, MAIN, 1))
# 竖拍：传感器横向存储，Orientation = 6（显示时顺时针转 90°）
# 显示画面为 H×W 的竖图；存储的像素 = 显示画面逆时针转 90°
displayed(H, W).rotate(90, expand=True).save(os.path.join(out, 'portrait_26.jpg'), quality=90, exif=exif(26, 5.7, MAIN, 6))
# 长焦镜头
displayed(W, H).save(os.path.join(out, 'tele_77.jpg'), quality=90, exif=exif(77, 9.0, TELE, 1))
# 没有 EXIF（例如经微信转发）
displayed(W, H).save(os.path.join(out, 'no_exif.jpg'), quality=90)
print('已生成到', out)
