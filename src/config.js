// 全部可调参数。长度单位 mm，角度在代码内部用弧度。

// 底板：A4 横向，就是一张普通 A4 纸（70–80 g/m² 的纸厚约 0.1 mm）
export const BOARD = { width: 297, height: 210, thickness: 0.1 };

// ArUco：4×4 字典，ID 0–3，边长 40 mm，码外边距板边 12 mm
// 码"上方"统一朝 +Y（远离操作者）
export const MARKERS = {
  size: 40,
  centers: { 0: [32, 32], 1: [265, 32], 2: [265, 178], 3: [32, 178] },
};

// 零件允许出现的区域：底板内缩 12 mm，再挖掉 4 个码（各外扩 5 mm）
export const WORK_AREA = { margin: 12, markerPadding: 5 };

// 默认相机：iPhone 13 Pro 主摄
export const CAMERA = { expectedFocal35: 26, refWidth: 4032, refHeight: 3024 };

// 类别（高度为占位值，等实测后替换）
export const CLASSES = [
  { id: 0, key: 'resistor',  name: '色环电阻', heightMm: 3,  color: '#c8a165' },
  { id: 1, key: 'capacitor', name: '电解电容', heightMm: 12, color: '#3b6fb6' },
  { id: 2, key: 'led',       name: 'LED',      heightMm: 9,  color: '#d94c4c' },
  { id: 3, key: 'screw',     name: '螺丝',     heightMm: 4,  color: '#9aa0a6' },
];

// 机械臂：底座旋转 + 大臂 + 小臂 + 腕部俯仰 + 腕部转动，夹爪始终竖直向下，转动夹爪让两指对准零件
export const ARM = {
  base: [148.5, 290, 0], // 底板远端（远离操作者一侧）中点外侧，不挡拍照视线
  L0: 80,                // 底座高
  L1: 200,               // 大臂
  L2: 180,               // 小臂
  L3: 70,                // 腕关节到指尖
  approach: 60,          // 抓取 / 放置前在目标正上方的悬停高度
};

// 料盒壁厚（mm）：盒底上表面高 BIN_WALL
export const BIN_WALL = 2;

// 料盒：每类一个，左右各 2 个（size 为 X 宽、Y 长、高，mm）
export const BINS = [
  { id: 0, cls: 0, center: [-40, 70],  size: [60, 66, 35] },
  { id: 1, cls: 1, center: [-40, 140], size: [60, 66, 35] },
  { id: 2, cls: 2, center: [337, 70],  size: [60, 66, 35] },
  { id: 3, cls: 3, center: [337, 140], size: [60, 66, 35] },
];

export const DETECT = { imgsz: 1024, scoreThreshold: 0.4, iouThreshold: 0.5 };
