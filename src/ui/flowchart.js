// 信息面板"状态"分区里的流程图：整条流程（含出错分支）画成 SVG，按当前状态给每个节点上色。
// flowStatuses、flowSvg 都是纯函数（只拼字符串，不碰 DOM），便于测试。
//
// 主流程：选择照片 → 读取照片·内参 → 识别码·单应性 → 手机位姿 → 零件检测 → 坐标映射·建场景 → 转场 → 机械臂分拣 → 完成
// 出错分支：读不了照片、识别不到码、位姿无效、检测失败（→ 手动框选 → 回到建场景）、有零件够不到（跳过）
// 演示模式在建场景和转场之间多一步"正视图 · 确认识别结果"（flowNodes({ demo: true })）

/** 节点状态 */
export const FLOW_STATUS = ['todo', 'active', 'done', 'error', 'warn', 'idle'];

/** 主流程节点（按顺序）；hint 为该步进行中 / 等待时的提示 */
export const MAIN_NODES = [
  { id: 'input', label: '选择照片（上传 / 示例）', hint: '等待上传照片，或从右上角选择示例' },
  { id: 'image', label: '读取照片 · 内参', hint: '读取照片、按 EXIF 或标定文件确定内参' },
  { id: 'calib', label: '识别码 · 单应性', hint: '识别 4 个 ArUco 码，求底板到照片的单应性' },
  { id: 'pose', label: '手机位姿', hint: '由单应性和内参求手机的位置与朝向' },
  { id: 'detect', label: '零件检测（YOLO + 颜色）', hint: '模型推理找零件，颜色分割补漏' },
  { id: 'scene', label: '坐标映射 · 建 3D 场景', hint: '检测框映射到底板坐标，摆放 3D 零件' },
  { id: 'transition', label: '照片 → 3D 转场', hint: '切到 3D 视图播放转场' },
  { id: 'sort', label: '机械臂分拣', hint: '点"开始"让机械臂把零件放进料盒' },
  { id: 'done', label: '分拣完成', hint: '全部零件已放进料盒' },
];

/** 演示模式多出的一步：建好场景后先给出正视图、框出元件，确认后才转场 */
export const CONFIRM_NODE = { id: 'confirm', label: '正视图 · 确认识别结果', hint: '核对正视图上框出的元件，点"确认"开始建模' };

/**
 * 主流程节点
 * @param {{ demo?: boolean }} [opts]
 */
export function flowNodes({ demo = false } = {}) {
  if (!demo) return MAIN_NODES;
  const i = MAIN_NODES.findIndex((n) => n.id === 'transition');
  return [...MAIN_NODES.slice(0, i), CONFIRM_NODE, ...MAIN_NODES.slice(i)];
}

/** 出错 / 分支节点：from 为所在主流程节点（与它同一行）；at 为放在哪个主流程节点那一行（默认 = from） */
export const SIDE_NODES = [
  { id: 'e_image', from: 'image', label: '读不了照片', sub: '换 JPG 或重新选择' },
  { id: 'e_calib', from: 'calib', label: '识别不到码', sub: '重拍：整张板入镜' },
  { id: 'e_pose', from: 'pose', label: '位姿无效', sub: '换内参来源或重拍' },
  { id: 'e_detect', from: 'detect', label: '检测失败', sub: '推理出错 / 无检测文件' },
  { id: 'manual', from: 'e_detect', at: 'scene', label: '手动框选零件', sub: '框好后继续建场景', to: 'scene' },
  { id: 'e_sort', from: 'sort', label: '有零件够不到', sub: '跳过，其余照常分拣' },
];

/** 分支节点所在的行 */
const sideRow = (nodes, n) => nodes.findIndex((m) => m.id === (n.at ?? n.from));

const STAGE_ORDER = ['idle', 'imageLoaded', 'calibrated', 'posed', 'detected', 'sceneBuilt', 'sorting', 'done'];
const at = (stage, s) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(s);

/** 步骤条 / store.fail 的步骤 key → 主流程节点 */
const ERROR_NODE = { image: 'image', calib: 'calib', pose: 'pose', detect: 'detect', scene: 'scene', sort: 'sort' };
/** 主流程节点 → 对应的出错节点 */
const ERROR_SIDE = { image: 'e_image', calib: 'e_calib', pose: 'e_pose', detect: 'e_detect' };

/**
 * 各节点的状态
 * @param {{
 *   stage: string,                       // store.state.stage
 *   error?: { step: string }|null,       // store.state.error
 *   loading?: boolean,                   // 正在读取照片（还没进入 imageLoaded）
 *   transitionDone?: boolean,            // 这个场景的转场已经播过（或正在播）
 *   transitionPlaying?: boolean,
 *   skipped?: number,                    // 分拣规划里够不到的零件数
 *   manual?: boolean,                    // 检测结果来自手动框选
 *   demo?: boolean,                      // 演示模式（多一步"确认识别结果"）
 *   confirmed?: boolean,                 // 演示模式：识别结果已确认
 * }} s
 * @returns {Record<string, 'todo'|'active'|'done'|'error'|'warn'|'idle'>}
 */
export function flowStatuses(s) {
  const { stage, error = null, loading = false, transitionDone = false, transitionPlaying = false, skipped = 0, manual = false, demo = false, confirmed = false } = s;
  const done = {
    input: loading || at(stage, 'imageLoaded'),
    image: at(stage, 'imageLoaded'),
    calib: at(stage, 'calibrated'),
    pose: at(stage, 'posed'),
    detect: at(stage, 'detected'),
    scene: at(stage, 'sceneBuilt'),
    confirm: at(stage, 'sceneBuilt') && confirmed,
    transition: at(stage, 'sceneBuilt') && transitionDone && !transitionPlaying && (!demo || confirmed),
    sort: stage === 'done',
    done: stage === 'done',
  };
  const out = {};
  const errNode = error ? ERROR_NODE[error.step] : null;
  let activeSet = false;
  let stopped = false; // 出错之后的步骤都停着（即使上一张照片曾经做完）
  for (const n of flowNodes({ demo })) {
    if (n.id === errNode) {
      out[n.id] = 'error';
      activeSet = true;
      stopped = true;
    } else if (stopped) {
      out[n.id] = 'todo';
    } else if (done[n.id]) {
      out[n.id] = 'done';
    } else if (!activeSet) {
      out[n.id] = 'active';
      activeSet = true;
    } else {
      out[n.id] = 'todo';
    }
  }
  // "选择照片"出错时（读不了照片），照片这一步标红
  if (error?.step === 'image') out.input = 'done';
  for (const n of SIDE_NODES) out[n.id] = 'idle';
  if (errNode && ERROR_SIDE[errNode]) out[ERROR_SIDE[errNode]] = 'error';
  if (errNode === 'detect') out.manual = 'active';
  else if (manual && done.detect) out.manual = 'done';
  if (skipped > 0 && done.scene) out.e_sort = 'warn';
  return out;
}

/** 当前要提示的节点：出错的、否则进行中的 */
export function currentNode(statuses) {
  const nodes = flowNodes({ demo: 'confirm' in statuses });
  return nodes.find((n) => statuses[n.id] === 'error') ?? nodes.find((n) => statuses[n.id] === 'active') ?? null;
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

const W = 320;
const ROW = 46;
const NH = 32;
const TOP = 6;
const MAIN = { x: 6, w: 164 };
const SIDE = { x: 196, w: 118 };
const rowY = (i) => TOP + i * ROW;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * 流程图 SVG（颜色用 CSS 类，跟随主题）
 * @param {ReturnType<typeof flowStatuses>} st
 */
export function flowSvg(st) {
  const nodes = flowNodes({ demo: 'confirm' in st });
  const H = rowY(nodes.length - 1) + NH + TOP;
  const parts = [];
  const edge = (d, cls, marker = 'arrow') => parts.push(`<path class="fc-edge ${cls}" d="${d}" marker-end="url(#fc-${marker}-${cls.split(' ')[0]})"/>`);
  // 主流程的竖线
  nodes.slice(0, -1).forEach((n, i) => {
    const next = nodes[i + 1];
    const cls = st[n.id] === 'done' && (st[next.id] === 'done' || st[next.id] === 'active') ? 'on' : 'off';
    const x = MAIN.x + MAIN.w / 2;
    edge(`M${x} ${rowY(i) + NH} V${rowY(i + 1) - 2}`, cls);
  });
  // 分支
  for (const n of SIDE_NODES) {
    const row = sideRow(nodes, n);
    const y = rowY(row) + NH / 2;
    if (n.from === 'e_detect') {
      // 检测失败 → 手动框选（竖线），手动框选 → 建场景（向左）
      const x = SIDE.x + SIDE.w / 2;
      const on = st.manual === 'active' || st.manual === 'done';
      edge(`M${x} ${rowY(sideRow(nodes, SIDE_NODES.find((m) => m.id === 'e_detect'))) + NH} V${rowY(row) - 2}`, st.manual === 'active' ? 'err' : on ? 'on' : 'off');
      edge(`M${SIDE.x} ${y} H${MAIN.x + MAIN.w + 2}`, st.manual === 'done' ? 'on' : 'off');
    } else {
      const cls = st[n.id] === 'error' ? 'err' : st[n.id] === 'warn' ? 'warn' : 'off';
      edge(`M${MAIN.x + MAIN.w} ${y} H${SIDE.x - 2}`, `${cls} dash`);
    }
  }
  // 节点
  nodes.forEach((n, i) => {
    const s = st[n.id];
    const y = rowY(i);
    const mark = s === 'done' ? '✓ ' : s === 'error' ? '✕ ' : '';
    parts.push(
      `<g class="fc-node fc-${s}" data-node="${n.id}"><rect x="${MAIN.x}" y="${y}" width="${MAIN.w}" height="${NH}" rx="8"/>` +
        `<text x="${MAIN.x + MAIN.w / 2}" y="${y + NH / 2}" class="fc-label">${esc(mark + n.label)}</text></g>`,
    );
  });
  for (const n of SIDE_NODES) {
    const s = st[n.id];
    const y = rowY(sideRow(nodes, n));
    parts.push(
      `<g class="fc-node fc-side fc-${s}" data-node="${n.id}"><rect x="${SIDE.x}" y="${y}" width="${SIDE.w}" height="${NH}" rx="8"/>` +
        `<text x="${SIDE.x + SIDE.w / 2}" y="${y + 11}" class="fc-label">${esc(n.label)}</text>` +
        `<text x="${SIDE.x + SIDE.w / 2}" y="${y + 24}" class="fc-sub">${esc(n.sub)}</text></g>`,
    );
  }
  const markers = ['on', 'off', 'err', 'warn']
    .map((c) => `<marker id="fc-arrow-${c}" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="fc-head ${c}" d="M0 0 L8 4 L0 8 z"/></marker>`)
    .join('');
  return `<svg class="flowchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="流程图"><defs>${markers}</defs>${parts.join('')}</svg>`;
}
