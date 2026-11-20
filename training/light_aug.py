"""训练用的光照增强（在线，每个 batch 现算）：透明 LED 在不同光照下长得很不一样，数据又少，只能靠增强多见几种光。

通过 ultralytics 的 augmentations 训练参数接到它的 Albumentations 那一步（马赛克、仿射之后，HSV 之前），只改像素，不动框。
大部分用 albumentations 现成的变换；它没有的"过曝""大块软阴影""台灯斜照"在这里自己写
（写成模块里的类，Windows 上数据加载是多进程 spawn，lambda 传不过去）。

评估脚本 eval_light.py 里的光照变化是另外写的、参数也不同，避免拿练习题当考题。
"""
import albumentations as A
import cv2
import numpy as np


class Overexpose(A.ImageOnlyTransform):
    """过曝：整体乘 1.3–2.0 再截断，亮部糊成一片白（透明灯体的轮廓最容易丢）"""

    def __init__(self, gain=(1.3, 2.0), p=0.5):
        super().__init__(p=p)
        self.gain = gain

    def apply(self, img, **params):
        g = np.random.uniform(*self.gain)
        lift = np.random.uniform(0, 25)
        return np.clip(img.astype(np.float32) * g + lift, 0, 255).astype(np.uint8)

    def get_transform_init_args_names(self):
        return ('gain',)


def _field(h, w, kind):
    """光照场（0–1）：kind = 'edge' 一条软边分开明暗；'spot' 一个亮斑向外衰减；'blob' 一块椭圆阴影"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    s = float(max(h, w))
    if kind == 'edge':
        ang = np.random.uniform(0, 2 * np.pi)
        cx, cy = np.random.uniform(0.2, 0.8) * w, np.random.uniform(0.2, 0.8) * h
        soft = np.random.uniform(0.005, 0.06) * s  # 软边宽度：硬阴影（太阳）到软阴影（台灯）
        d = (xx - cx) * np.cos(ang) + (yy - cy) * np.sin(ang)
        return 1 / (1 + np.exp(-np.clip(d / soft, -30, 30)))
    cx, cy = np.random.uniform(0.1, 0.9) * w, np.random.uniform(0.1, 0.9) * h
    rx, ry = np.random.uniform(0.15, 0.6) * s, np.random.uniform(0.15, 0.6) * s
    ang = np.random.uniform(0, np.pi)
    dx, dy = xx - cx, yy - cy
    u = dx * np.cos(ang) + dy * np.sin(ang)
    v = -dx * np.sin(ang) + dy * np.cos(ang)
    return np.exp(-0.5 * ((u / rx) ** 2 + (v / ry) ** 2))


class SoftShadow(A.ImageOnlyTransform):
    """大块阴影（手、手机、身体、台灯罩挡光）：亮暗比 1 : 0.3–0.75，阴影里略偏冷"""

    def __init__(self, strength=(0.25, 0.7), p=0.5):
        super().__init__(p=p)
        self.strength = strength

    def apply(self, img, **params):
        h, w = img.shape[:2]
        m = _field(h, w, 'edge' if np.random.random() < 0.6 else 'blob')[..., None]
        k = np.random.uniform(*self.strength)
        tint = np.array([1.0, 1.0, 1.0], np.float32) + np.random.uniform(-0.08, 0.08, 3).astype(np.float32)
        f = img.astype(np.float32)
        dark = f * (1 - k) * tint
        return np.clip(f * (1 - m) + dark * m, 0, 255).astype(np.uint8)

    def get_transform_init_args_names(self):
        return ('strength',)


class Spotlight(A.ImageOnlyTransform):
    """台灯 / 窗户斜照：一处亮、四周暗，亮处常接近过曝"""

    def __init__(self, p=0.5):
        super().__init__(p=p)

    def apply(self, img, **params):
        h, w = img.shape[:2]
        m = _field(h, w, 'spot')[..., None]
        lo = np.random.uniform(0.35, 0.8)
        hi = np.random.uniform(1.1, 1.8)
        return np.clip(img.astype(np.float32) * (lo + (hi - lo) * m), 0, 255).astype(np.uint8)

    def get_transform_init_args_names(self):
        return ()


class Glare(A.ImageOnlyTransform):
    """镜面反光：几块小而亮的白斑（透明灯体、纸面在强光下的反光）"""

    def __init__(self, p=0.5):
        super().__init__(p=p)

    def apply(self, img, **params):
        h, w = img.shape[:2]
        f = img.astype(np.float32)
        layer = np.zeros((h, w), np.float32)
        for _ in range(np.random.randint(1, 4)):
            c = (int(np.random.uniform(0, w)), int(np.random.uniform(0, h)))
            ax = (int(np.random.uniform(0.02, 0.12) * w), int(np.random.uniform(0.02, 0.12) * h))
            cv2.ellipse(layer, c, ax, np.random.uniform(0, 180), 0, 360, np.random.uniform(0.3, 0.8), -1)
        k = max(3, int(0.04 * max(h, w)) | 1)
        layer = cv2.GaussianBlur(layer, (k, k), 0)[..., None]
        return np.clip(f + (255 - f) * layer, 0, 255).astype(np.uint8)

    def get_transform_init_args_names(self):
        return ()


def build(strength=1.0):
    """光照增强流水线；strength 统一缩放各项的概率"""
    p = lambda x: min(1.0, x * strength)  # noqa: E731（只在这里用，不会被 pickle）
    return [
        # 全局曝光 / 对比度 / 伽马
        A.OneOf([
            A.RandomBrightnessContrast(brightness_limit=(-0.4, 0.3), contrast_limit=(-0.4, 0.25), p=1),
            A.RandomGamma(gamma_limit=(55, 180), p=1),
            A.RandomToneCurve(scale=0.2, p=1),
        ], p=p(0.5)),
        Overexpose(p=p(0.15)),
        # 不均匀光照
        A.OneOf([SoftShadow(p=1), Spotlight(p=1), A.RandomShadow(p=1)], p=p(0.4)),
        Glare(p=p(0.1)),
        # 色温（暖光 3000 K 到阴天 9000 K）
        A.PlanckianJitter(mode='blackbody', temperature_limit=(3000, 9000), p=p(0.3)),
        # 手机在暗处的噪声、抖动、压缩
        A.OneOf([A.ISONoise(color_shift=(0.01, 0.04), intensity=(0.1, 0.4), p=1), A.GaussNoise(std_range=(0.01, 0.04), p=1)], p=p(0.15)),
        A.OneOf([A.MotionBlur(blur_limit=(3, 5), p=1), A.GaussianBlur(blur_limit=(3, 5), p=1)], p=p(0.1)),
        A.ImageCompression(quality_range=(55, 95), p=p(0.15)),
        A.CLAHE(p=p(0.05)),
        A.ToGray(p=p(0.02)),
    ]
