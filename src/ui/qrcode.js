// 纯前端零依赖 QR 码编码器（ISO/IEC 18004 Model 2，字节模式，纠错等级 M，版本 1–10，最多支持 213 字节 UTF-8）。
// 直接绘制到 <canvas>，不依赖外部在线二维码接口，也不在 CSS 里使用 data: URI。

// 版本 1–10 的校正图形中心坐标（ISO/IEC 18004 附录 E）
const ALIGN_CENTERS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// 纠错等级 M（版本 1–10）的 RS 分块定义（ISO/IEC 18004 表 9）：
// 每项为 { totalData, ecPerBlock, blocks: [[count, dataPerBlock], ...] }
const EC_M_BLOCKS = [
  null,
  { totalData: 16, ecPerBlock: 10, blocks: [[1, 16]] },
  { totalData: 28, ecPerBlock: 16, blocks: [[1, 28]] },
  { totalData: 44, ecPerBlock: 26, blocks: [[1, 44]] },
  { totalData: 64, ecPerBlock: 18, blocks: [[2, 32]] },
  { totalData: 86, ecPerBlock: 24, blocks: [[2, 43]] },
  { totalData: 108, ecPerBlock: 16, blocks: [[4, 27]] },
  { totalData: 124, ecPerBlock: 18, blocks: [[4, 31]] },
  { totalData: 154, ecPerBlock: 22, blocks: [[2, 38], [2, 39]] },
  { totalData: 182, ecPerBlock: 22, blocks: [[3, 36], [2, 37]] },
  { totalData: 216, ecPerBlock: 26, blocks: [[4, 43], [1, 44]] },
];

// GF(256) 指数/对数表（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11d）
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 构造 n 次 Reed-Solomon 生成多项式系数（降幂，不含首项 1） */
function rsGenerator(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly.subarray(1);
}

/** 计算数据块的 Reed-Solomon 纠错码字 */
export function rsRemainder(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j], factor);
    }
  }
  return rem;
}

/** 根据 UTF-8 字节长度选择最小的 QR 版本（1–10，纠错等级 M） */
function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const ccBits = v >= 10 ? 16 : 8;
    const capBytes = Math.floor((EC_M_BLOCKS[v].totalData * 8 - 4 - ccBits) / 8);
    if (byteLen <= capBytes) return v;
  }
  throw new Error(`QR 内容过长（${byteLen} 字节，最大支持 213 字节）`);
}

/** 编码字节流为数据码字 + 交织后的纠错码字 */
function buildCodewords(bytes, version) {
  const spec = EC_M_BLOCKS[version];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  // 0100 = Byte mode
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);

  const totalDataBits = spec.totalData * 8;
  // 终止符（最多 4 个 0）
  const term = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  // 补齐到整字节
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(spec.totalData);
  let di = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    data[di++] = v;
  }
  // 填充交替字节 0xEC / 0x11
  const pad = [0xec, 0x11];
  for (let p = 0; di < spec.totalData; p++) data[di++] = pad[p & 1];

  // 切分 RS 块并计算每块纠错码字
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, len] of spec.blocks) {
    for (let c = 0; c < count; c++) {
      const blk = data.subarray(offset, offset + len);
      offset += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsRemainder(blk, spec.ecPerBlock));
    }
  }

  // 按列交织数据码字，再交织纠错码字
  const out = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) out.push(ec[i]);
  }
  return Uint8Array.from(out);
}

/** 计算格式信息 15 位（纠错等级 M = 0b00，加掩码 0x5412） */
export function formatInfoBits(mask) {
  const data = (0b00 << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 计算版本信息 18 位（仅版本 >= 7） */
export function versionInfoBits(version) {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

const MASK_FNS = [
  (r, c) => ((r + c) & 1) === 0,
  (r) => (r & 1) === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => ((Math.floor(r / 2) + Math.floor(c / 3)) & 1) === 0,
  (r, c) => ((r * c) & 1) + ((r * c) % 3) === 0,
  (r, c) => ((((r * c) & 1) + ((r * c) % 3)) & 1) === 0,
  (r, c) => ((((r + c) & 1) + ((r * c) % 3)) & 1) === 0,
];

function buildBaseMatrix(version) {
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Uint8Array(size));
  const fn = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = dark ? 1 : 0;
    fn[r][c] = 1;
  };

  // 三个定位图形 + 白色分隔区
  const placeFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // 定位条（行 6 / 列 6）
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, (i & 1) === 0);
    setFn(i, 6, (i & 1) === 0);
  }

  // 校正图形
  const centers = ALIGN_CENTERS[version];
  for (const r0 of centers) {
    for (const c0 of centers) {
      if (fn[r0][c0]) continue; // 避开三个定位图形角落
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(r0 + dr, c0 + dc, dist !== 1);
        }
      }
    }
  }

  // 预留格式信息区域（先占位，掩码选择后写入）+ 固定暗模块
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFn(8, i, false);
      setFn(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFn(8, i, false);
    setFn(i, 8, false);
  }
  setFn(size - 8, 8, true); // 固定暗模块

  // 版本信息（版本 >= 7）
  if (version >= 7) {
    const vBits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(b, a, dark);
      setFn(a, b, dark);
    }
  }

  return { size, mod, fn };
}

function writeFormat(mod, size, mask) {
  const bits = formatInfoBits(mask);
  const bit = (i) => (bits >>> i) & 1;

  // 左上副本（bit 14 -> bit 0）
  for (let i = 0; i <= 5; i++) mod[8][i] = bit(14 - i);
  mod[8][7] = bit(8);
  mod[8][8] = bit(7);
  mod[7][8] = bit(6);
  for (let i = 0; i <= 5; i++) mod[5 - i][8] = bit(5 - i);

  // 左下 + 右上副本
  for (let i = 0; i < 7; i++) mod[size - 1 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) mod[8][size - 8 + i] = bit(7 - i);
}

/** ISO/IEC 18004 掩码惩罚评分（四项规则） */
function penaltyScore(mod, size) {
  let score = 0;
  // 规则 1：同行/同列连续 5 个及以上同色模块
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (mod[r][c] === mod[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (mod[r][c] === mod[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
    }
  }
  // 规则 3：类定位图形 1:1:3:1:1 比例前后带 4 个白格
  const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let mA = true;
      let mB = true;
      for (let k = 0; k < 11; k++) {
        if (mod[r][c + k] !== patA[k]) mA = false;
        if (mod[r][c + k] !== patB[k]) mB = false;
      }
      if (mA || mB) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      let mA = true;
      let mB = true;
      for (let k = 0; k < 11; k++) {
        if (mod[r + k][c] !== patA[k]) mA = false;
        if (mod[r + k][c] !== patB[k]) mB = false;
      }
      if (mA || mB) score += 40;
    }
  }
  // 规则 4：暗模块占比偏离 50%
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mod[r][c];
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * 将字符串编码为 QR 矩阵
 * @param {string} text
 * @returns {{ version: number, size: number, mask: number, modules: Uint8Array[] }}
 */
export function encodeQR(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const { size, mod: baseMod, fn } = buildBaseMatrix(version);

  // 先写入未掩码的数据位
  const dataBits = new Uint8Array(codewords.length * 8);
  for (let i = 0; i < codewords.length; i++) {
    const cw = codewords[i];
    for (let b = 0; b < 8; b++) dataBits[i * 8 + b] = (cw >>> (7 - b)) & 1;
  }

  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = null;

  for (let mask = 0; mask < 8; mask++) {
    const mod = baseMod.map((row) => row.slice());
    const maskFn = MASK_FNS[mask];
    let bi = 0;
    let upward = true;
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col = 5;
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (fn[r][c]) continue;
          const bit = bi < dataBits.length ? dataBits[bi++] : 0;
          mod[r][c] = maskFn(r, c) ? bit ^ 1 : bit;
        }
      }
      upward = !upward;
    }
    writeFormat(mod, size, mask);
    const s = penaltyScore(mod, size);
    if (s < bestScore) {
      bestScore = s;
      bestMask = mask;
      bestModules = mod;
    }
  }

  return { version, size, mask: bestMask, modules: bestModules };
}

/**
 * 将文本渲染成高清 QR 码到 Canvas（自带 4 模块白边静区，暗色主题下也可秒扫）
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{ sizePx?: number, dark?: string, light?: string, quiet?: number }} [opts]
 */
export function renderQRToCanvas(canvas, text, opts = {}) {
  const { sizePx = 220, dark = '#141311', light = '#ffffff', quiet = 4 } = opts;
  const qr = encodeQR(text);
  const total = qr.size + quiet * 2;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cell = Math.max(2, Math.floor((sizePx * dpr) / total));
  const px = cell * total;
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${sizePx}px`;
  canvas.style.height = `${sizePx}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let r = 0; r < qr.size; r++) {
    const row = qr.modules[r];
    for (let c = 0; c < qr.size; c++) {
      if (row[c]) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
  return qr;
}
