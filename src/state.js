// 全局 state、流程状态机与事件。
// 第 5 节的数据接口类型定义也写在这里（JSDoc）。

/* ------------------------------------------------------------------ */
/* 类型定义                                                             */
/* ------------------------------------------------------------------ */

/**
 * 照片（已按 EXIF 方向转正）
 * @typedef {Object} ImageInput
 * @property {ImageBitmap} bitmap
 * @property {number} width
 * @property {number} height
 * @property {string} fileName
 * @property {{ focal35: number|null, focalMm: number|null, lensModel: string|null,
 *              make: string|null, model: string|null, orientation?: number|null }} exif
 *   orientation 为 EXIF 原始方向值（1 / 3 / 6 / 8），fromCalib 用它判断竖拍方向
 */

/**
 * 模块 1：内参（对应当前照片的实际分辨率和方向）
 * @typedef {Object} Intrinsics
 * @property {number} fx
 * @property {number} fy
 * @property {number} cx
 * @property {number} cy
 * @property {number} width
 * @property {number} height
 * @property {'exif'|'calib'|'truth'} source
 */

/**
 * 模块 2：一个 ArUco 码
 * corners 顺序：码自身的左上、右上、右下、左下（像素）
 * @typedef {Object} Marker
 * @property {number} id
 * @property {[[number,number],[number,number],[number,number],[number,number]]} corners
 */

/**
 * 模块 2：底板标定结果
 * H：底板 (X, Y, 1) → 像素 (u, v, 1)；Hinv 方向相反
 * @typedef {Object} BoardCalib
 * @property {Marker[]} markers
 * @property {number[][]} H
 * @property {number[][]} Hinv
 * @property {number} reprojErrPx
 * @property {HTMLCanvasElement} rectified   正射图
 * @property {PaperOutline|null} [paper]     实测纸张轮廓（测不出纸边时为 null）
 */

/**
 * 实测纸张轮廓（底板坐标，mm）。打印机会把内容整体印偏几毫米，所以纸张的实际位置
 * 与设计位置（0..W × 0..H）可能有偏差；纸张大小用来判断打印比例。
 * @typedef {Object} PaperOutline
 * @property {number[][]|null} corners  四角：左下、右下、右上、左上；任一条边测不出时为 null
 * @property {{left:number|null, right:number|null, bottom:number|null, top:number|null}} edges 纸边相对设计位置的外移
 * @property {{[edge:string]: 'outside'|'contrast'|null}} reasons 测不出的原因
 * @property {number|null} widthMm
 * @property {number|null} heightMm
 * @property {number|null} scaleX    打印比例（长边）
 * @property {number|null} scaleY    打印比例（短边）
 */

/**
 * 模块 3：手机位姿。Pc = R·Pw + t，position = C = −Rᵀt
 * @typedef {Object} CameraPose
 * @property {number[][]} R            3×3
 * @property {number[]} t              [3]
 * @property {[number,number,number]} position   C: [X, Y, Z]
 * @property {number} heightMm
 * @property {number} pitchDeg
 * @property {number} reprojErrPx
 */

/**
 * 模块 4：检测结果（原图像素）
 * @typedef {Object} Detection
 * @property {number} cls
 * @property {string} name
 * @property {number} score
 * @property {[number,number,number,number]} box   [x1, y1, x2, y2]
 */

/**
 * 模块 4：零件。x, y 为当前选用方法的结果；xPlane, yPlane 为方法 1（不修正）的结果
 * @typedef {Object} Part
 * @property {number} id
 * @property {number} cls
 * @property {string} name
 * @property {number} score
 * @property {number} x
 * @property {number} y
 * @property {number} heightMm
 * @property {number} xPlane
 * @property {number} yPlane
 * @property {boolean} reachable
 */

/**
 * 模块 6：分拣任务
 * @typedef {Object} PickTask
 * @property {number} partId
 * @property {number} binId
 * @property {[number,number,number]} from
 * @property {[number,number,number]} to
 */

/**
 * 合成图真值（步骤 3 生成）
 * @typedef {Object} GroundTruth
 * @property {Intrinsics} intrinsics
 * @property {number[][]} R
 * @property {number[]} t
 * @property {[number,number,number]} position
 * @property {number} pitchDeg
 * @property {Marker[]} markers
 * @property {{ cls: number, x: number, y: number, heightMm: number,
 *              box: [number,number,number,number] }[]} parts
 */

/* ------------------------------------------------------------------ */
/* 状态机                                                               */
/* ------------------------------------------------------------------ */

/** 流程状态，按先后顺序排列 */
export const STAGES = /** @type {const} */ ([
  'idle', 'imageLoaded', 'calibrated', 'posed', 'detected', 'sceneBuilt', 'sorting', 'done',
]);

/** 状态的界面文字 */
export const STAGE_LABELS = {
  idle: '等待照片',
  imageLoaded: '照片已读入',
  calibrated: '底板已标定',
  posed: '位姿已求出',
  detected: '零件已检测',
  sceneBuilt: '场景已建立',
  sorting: '分拣中',
  done: '分拣完成',
};

/** 每个状态写入的数据字段；回退到某状态时，其后状态的字段被清空 */
const STAGE_FIELDS = {
  imageLoaded: ['image', 'intrinsics', 'truth'],
  calibrated: ['calib'],
  posed: ['pose'],
  detected: ['detections', 'parts'],
  sceneBuilt: [],
  sorting: ['tasks', 'skipped'],
  done: [],
};

/** 步骤条上的 6 个步骤：label 为界面文字，stage 为该步骤完成后到达的状态 */
export const STEPS = [
  { key: 'image',  label: '照片', stage: 'imageLoaded' },
  { key: 'calib',  label: '标定', stage: 'calibrated' },
  { key: 'pose',   label: '位姿', stage: 'posed' },
  { key: 'detect', label: '检测', stage: 'detected' },
  { key: 'scene',  label: '场景', stage: 'sceneBuilt' },
  { key: 'sort',   label: '分拣', stage: 'done' },
];

/** 状态的序号，用于比较先后 */
export function stageIndex(stage) {
  const i = STAGES.indexOf(stage);
  if (i < 0) throw new Error(`未知状态：${stage}`);
  return i;
}

/** 创建一份空 state */
export function createState() {
  return {
    stage: 'idle',
    /** @type {ImageInput|null} */ image: null,
    /** @type {Intrinsics|null} */ intrinsics: null,
    /** @type {GroundTruth|null} */ truth: null,
    /** @type {BoardCalib|null} */ calib: null,
    /** @type {CameraPose|null} */ pose: null,
    /** @type {Detection[]|null} */ detections: null,
    /** @type {Part[]|null} */ parts: null,
    /** @type {PickTask[]|null} */ tasks: null,
    /** @type {Part[]|null} */ skipped: null,
    /** 失败信息：{ step, reason } 或 null */
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* Store：state + 事件                                                  */
/* ------------------------------------------------------------------ */

/**
 * 简单的事件仓库。事件：
 * - 'change'      任何变化，detail = { stage, state }
 * - 'stage:<名>'  进入某状态，detail = state
 * - 'error'       某步失败，detail = { step, reason }
 */
export class Store {
  constructor() {
    this.state = createState();
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  emit(type, detail) {
    for (const fn of [...(this._handlers.get(type) ?? [])]) fn(detail);
  }

  /**
   * 进入下一个状态并写入数据。
   * 只能前进到 "当前状态的下一个"，或重跑某个已完成的步骤（此时后续数据清空）。
   * @param {string} stage 目标状态
   * @param {Object} [patch] 要写入 state 的字段
   */
  advance(stage, patch = {}) {
    const target = stageIndex(stage);
    const current = stageIndex(this.state.stage);
    if (target > current + 1) {
      throw new Error(`不能从 ${this.state.stage} 跳到 ${stage}`);
    }
    if (target <= current) this._clearAfter(target - 1);
    Object.assign(this.state, patch, { stage, error: null });
    this.emit(`stage:${stage}`, this.state);
    this.emit('change', { stage, state: this.state });
  }

  /**
   * 回退到某状态（用于单独重跑后面的步骤），清空其后的数据。
   * @param {string} stage
   */
  rollback(stage) {
    const target = stageIndex(stage);
    if (target > stageIndex(this.state.stage)) return;
    this._clearAfter(target);
    this.state.stage = stage;
    this.state.error = null;
    this.emit('change', { stage, state: this.state });
  }

  /**
   * 记录某步失败：状态停在当前，不前进。
   * @param {string} step  STEPS 中的 key
   * @param {string} reason
   */
  fail(step, reason) {
    this.state.error = { step, reason };
    this.emit('error', this.state.error);
    this.emit('change', { stage: this.state.stage, state: this.state });
  }

  /** 清空全部数据回到 idle */
  reset() {
    this.state = createState();
    this.emit('change', { stage: 'idle', state: this.state });
  }

  /** 清空序号大于 idx 的状态写入的字段 */
  _clearAfter(idx) {
    for (let i = idx + 1; i < STAGES.length; i++) {
      for (const f of STAGE_FIELDS[STAGES[i]] ?? []) this.state[f] = null;
    }
  }
}

/** 全局唯一的 store */
export const store = new Store();
