// 全部可调参数。长度单位 mm，角度在代码内部用弧度。

export const BOARD = { width: 420, height: 297, thickness: 3 };

// ArUco：4×4 字典，ID 0–3，边长 50 mm，码外边距板边 15 mm
// 码"上方"统一朝 +Y（远离操作者）
export const MARKERS = {
  size: 50,
  centers: { 0: [40, 40], 1: [380, 40], 2: [380, 257], 3: [40, 257] },
};

// 零件允许出现的区域：底板内缩 15 mm，再挖掉 4 个码（各外扩 5 mm）
export const WORK_AREA = { margin: 15, markerPadding: 5 };

// 默认相机：iPhone 13 Pro 主摄
export const CAMERA = { expectedFocal35: 26, refWidth: 4032, refHeight: 3024 };

// 类别（高度为占位值，等实测后替换）
export const CLASSES = [
  { id: 0, key: 'resistor',  name: '色环电阻', heightMm: 3,  color: '#c8a165' },
  { id: 1, key: 'capacitor', name: '电解电容', heightMm: 12, color: '#3b6fb6' },
  { id: 2, key: 'led',       name: 'LED',      heightMm: 9,  color: '#d94c4c' },
  { id: 3, key: 'screw',     name: '螺丝',     heightMm: 4,  color: '#9aa0a6' },
  { id: 4, key: 'nut',       name: '螺母',     heightMm: 3,  color: '#7d8590' },
  { id: 5, key: 'washer',    name: '垫片',     heightMm: 1,  color: '#b0b6bd' },
];

// 机械臂：底座旋转 + 大臂 + 小臂 + 腕部俯仰，夹爪始终竖直向下
export const ARM = {
  base: [210, -80, 0],   // 底板前边中点外侧
  L0: 90,                // 底座高
  L1: 240,               // 大臂
  L2: 220,               // 小臂
  L3: 80,                // 腕关节到指尖
  approach: 60,          // 抓取 / 放置前在目标正上方的悬停高度
};

// 料盒：每类一个，左右各 3 个
export const BINS = [
  { id: 0, cls: 0, center: [-70, 60],  size: [70, 80, 40] },
  { id: 1, cls: 1, center: [-70, 150], size: [70, 80, 40] },
  { id: 2, cls: 2, center: [-70, 240], size: [70, 80, 40] },
  { id: 3, cls: 3, center: [490, 60],  size: [70, 80, 40] },
  { id: 4, cls: 4, center: [490, 150], size: [70, 80, 40] },
  { id: 5, cls: 5, center: [490, 240], size: [70, 80, 40] },
];

export const DETECT = { imgsz: 1024, scoreThreshold: 0.4, iouThreshold: 0.5 };
