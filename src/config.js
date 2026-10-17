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

// 固定内参：所有照片都用同一台 iPhone 13 Pro 的主摄拍（4:3，4032 × 3024，横向），直接用棋盘格标定的结果，
// 不再从网页读取 intrinsics.json、也不按 EXIF 换算。数值来自 tools/calibrate_camera.py（2026-10-13，26 张，RMS 1.32 px），
// 重新标定后把 public/intrinsics.json 里的 fx、fy、cx、cy 抄到这里。
export const FIXED_INTRINSICS = { fx: 3060.356, fy: 3063.542, cx: 2002.641, cy: 1514.248, width: 4032, height: 3024 };

// 类别：只有手头的两种元件（都躺平放置）。key 与模型类别名对应：模型输出的类别 ID 按名字换成这里的 ID
export const CLASSES = [
  { id: 0, key: 'resistor', name: '色环电阻', heightMm: 2.4, color: '#3f7fd0' }, // 1/4 W 蓝色金属膜电阻：本体 Φ2.4×6.3
  { id: 1, key: 'led',      name: 'LED',      heightMm: 5.8, color: '#d94c4c' },
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

// LED 的颜色（按灯体像素判断，见 vision/leads.js）：名称、3D 与界面用的颜色；按颜色分拣时每种颜色一个料盒
export const LED_COLORS = {
  red: { name: '红色', hex: '#d94c4c' },
  green: { name: '绿色', hex: '#3aa65a' },
  blue: { name: '蓝色', hex: '#3d6be0' },
  yellow: { name: '黄色', hex: '#e0ad2e' },
  clear: { name: '透明', hex: '#9fb4bf' },
};

// 料盒：按需出现——电阻一个盒；LED 按颜色，照片里有几种颜色就有几个盒（robot/bins.js 的 binsFor）。
// 盒子的位置从下面的格位里依次取：电阻固定在左中，LED 先右中，再右远、右近、左远、左近、前方
export const BIN_SIZE = [60, 66, 35]; // X 宽、Y 长、高（mm）
export const BIN_SLOTS = {
  leftMid: [-40, 105],
  rightMid: [337, 105],
  rightFar: [337, 180],
  rightNear: [337, 30],
  leftFar: [-40, 180],
  leftNear: [-40, 30],
  front: [148.5, -55], // 底板前方（操作者一侧）：七种同时出现时才用到
};

// 不分颜色时的两个料盒（单元测试、颜色未知的 LED 用）
export const BINS = [
  { id: 0, cls: 0, key: 'resistor', label: '色环电阻', hex: '#3f7fd0', center: BIN_SLOTS.leftMid, size: BIN_SIZE },
  { id: 1, cls: 1, key: 'led', label: 'LED', hex: '#d94c4c', center: BIN_SLOTS.rightMid, size: BIN_SIZE },
];

// 检测：输入尺寸、置信度阈值、NMS 阈值（只用于原始输出）、同类去重阈值
// 去重：训练数据少，端到端模型偶尔对同一个零件出两个框（IoU 0.96–0.98，分数 0.5–0.75），同类 IoU 大于 dedupIou 的只留高分。
// 阈值取 0.9：几颗 LED 斜着并排贴在一起时，轴对齐的框彼此重叠也很多（可到 0.7–0.85），阈值太低会把真的第二颗删掉
export const DETECT = { imgsz: 1024, scoreThreshold: 0.4, iouThreshold: 0.5, dedupIou: 0.9 };

// 模型文件（public/models/，步骤 13 导出）：parts 为零件模型，coco 为官方 COCO 模型（调试用）
export const MODELS = {
  parts: { label: '零件模型', file: 'models/best.onnx' },
  coco: { label: '官方 COCO（调试）', file: 'models/yolo26n_coco.onnx' },
};
