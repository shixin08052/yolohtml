import { describe, it, expect } from 'vitest';
import { encodeQR, formatInfoBits, versionInfoBits, rsRemainder } from '../src/ui/qrcode.js';

// ISO/IEC 18004 独立校验器：从矩阵读出格式信息、反掩码、提取码字并验证 RS 纠错余数为 0，再解码字节载荷
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const SPEC_M = [
  null,
  { ec: 10, blocks: [[1, 16]] },
  { ec: 16, blocks: [[1, 28]] },
  { ec: 26, blocks: [[1, 44]] },
  { ec: 18, blocks: [[2, 32]] },
  { ec: 24, blocks: [[2, 43]] },
  { ec: 16, blocks: [[4, 27]] },
  { ec: 18, blocks: [[4, 31]] },
  { ec: 22, blocks: [[2, 38], [2, 39]] },
  { ec: 22, blocks: [[3, 36], [2, 37]] },
  { ec: 26, blocks: [[4, 43], [1, 44]] },
];
const MASKS = [
  (r, c) => ((r + c) & 1) === 0,
  (r) => (r & 1) === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => ((Math.floor(r / 2) + Math.floor(c / 3)) & 1) === 0,
  (r, c) => ((r * c) & 1) + ((r * c) % 3) === 0,
  (r, c) => ((((r * c) & 1) + ((r * c) % 3)) & 1) === 0,
  (r, c) => ((((r + c) & 1) + ((r * c) % 3)) & 1) === 0,
];

function decodeMatrixRoundTrip(qr) {
  const { size, version, modules } = qr;
  // 读取两份格式信息并确认完全一致
  let f1 = 0;
  for (let i = 0; i <= 5; i++) f1 = (f1 << 1) | modules[8][i];
  f1 = (f1 << 1) | modules[8][7];
  f1 = (f1 << 1) | modules[8][8];
  f1 = (f1 << 1) | modules[7][8];
  for (let i = 5; i >= 0; i--) f1 = (f1 << 1) | modules[i][8];

  let f2 = 0;
  for (let i = 0; i < 7; i++) f2 = (f2 << 1) | modules[size - 1 - i][8];
  for (let i = 0; i < 8; i++) f2 = (f2 << 1) | modules[8][size - 8 + i];
  expect(f1).toBe(f2);
  expect(f1).toBe(formatInfoBits(qr.mask));
  expect(modules[size - 8][8]).toBe(1); // 固定暗模块

  // 标出功能模块位置
  const fn = Array.from({ length: size }, () => new Uint8Array(size));
  const markRect = (r0, c0, h, w) => {
    for (let r = Math.max(0, r0); r < Math.min(size, r0 + h); r++) {
      for (let c = Math.max(0, c0); c < Math.min(size, c0 + w); c++) fn[r][c] = 1;
    }
  };
  markRect(0, 0, 9, 9);
  markRect(0, size - 8, 9, 8);
  markRect(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i++) {
    fn[6][i] = 1;
    fn[i][6] = 1;
  }
  for (const r0 of ALIGN[version]) {
    for (const c0 of ALIGN[version]) {
      if (fn[r0][c0]) continue;
      markRect(r0 - 2, c0 - 2, 5, 5);
    }
  }
  if (version >= 7) {
    markRect(0, size - 11, 6, 3);
    markRect(size - 11, 0, 3, 6);
  }

  // 按曲折顺序读出位并反掩码
  const bits = [];
  const maskFn = MASKS[qr.mask];
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (fn[r][c]) continue;
        bits.push(maskFn(r, c) ? modules[r][c] ^ 1 : modules[r][c]);
      }
    }
    upward = !upward;
  }

  const cwCount = Math.floor(bits.length / 8);
  const cws = new Uint8Array(cwCount);
  for (let i = 0; i < cwCount; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    cws[i] = v;
  }

  // 反交织 RS 块并验证每块纠错码完全匹配
  const spec = SPEC_M[version];
  const blockLens = [];
  for (const [cnt, len] of spec.blocks) for (let i = 0; i < cnt; i++) blockLens.push(len);
  const dataBlocks = blockLens.map((len) => new Uint8Array(len));
  const ecBlocks = blockLens.map(() => new Uint8Array(spec.ec));
  let idx = 0;
  const maxLen = Math.max(...blockLens);
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < blockLens.length; b++) {
      if (i < blockLens[b]) dataBlocks[b][i] = cws[idx++];
    }
  }
  for (let i = 0; i < spec.ec; i++) {
    for (let b = 0; b < blockLens.length; b++) {
      ecBlocks[b][i] = cws[idx++];
    }
  }
  for (let b = 0; b < blockLens.length; b++) {
    expect(Array.from(rsRemainder(dataBlocks[b], spec.ec))).toEqual(Array.from(ecBlocks[b]));
  }

  // 拼回连续数据位，解析 Byte Mode 载荷
  const allData = new Uint8Array(blockLens.reduce((a, b) => a + b, 0));
  let off = 0;
  for (const blk of dataBlocks) {
    allData.set(blk, off);
    off += blk.length;
  }
  const dBits = [];
  for (const byte of allData) for (let b = 7; b >= 0; b--) dBits.push((byte >>> b) & 1);
  const readBits = (pos, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dBits[pos + i];
    return v;
  };
  expect(readBits(0, 4)).toBe(0b0100);
  const ccLen = version >= 10 ? 16 : 8;
  const len = readBits(4, ccLen);
  const payload = new Uint8Array(len);
  for (let i = 0; i < len; i++) payload[i] = readBits(4 + ccLen + i * 8, 8);
  return new TextDecoder().decode(payload);
}

describe('QR 码编码器（ISO/IEC 18004）', () => {
  it('格式信息与版本信息符合 ISO/IEC 18004 附录 C / D 标准值', () => {
    expect(formatInfoBits(0)).toBe(0x5412);
    expect(formatInfoBits(1)).toBe(0x5125);
    expect(formatInfoBits(2)).toBe(0x5e7c);
    expect(formatInfoBits(4)).toBe(0x45f9);
    expect(versionInfoBits(7)).toBe(0x07c94);
    expect(versionInfoBits(8)).toBe(0x085bc);
    expect(versionInfoBits(9)).toBe(0x09a99);
    expect(versionInfoBits(10)).toBe(0x0a4d3);
  });

  it('版本 1 到版本 10（含多块交织与 V10 16-bit 长度）全链路解码与 RS 校验均精确还原', () => {
    const samples = [
      'HI', // V1
      'http://198.51.100.10:8787/m/K7M4P2', // V3（典型 IP 串流地址）
      'https://cam.example.com/m/A7K3P9?token=demo-secret-12345', // V4（2 块交织）
      'https://shixin08052.github.io/yolohtml/mobile.html?room=K7M4P2&relay=https%3A%2F%2Fcam.example.com', // V6（4 块交织）
      'A'.repeat(120), // V7（带版本信息）
      'B'.repeat(150), // V8（不等长 RS 分块：38/39）
      'C'.repeat(178), // V9（不等长 RS 分块：36/37）
      'D'.repeat(210), // V10（16-bit 长度字段 + 5 块交织）
      '中文测试·视觉分拣数字孪生', // UTF-8
    ];
    for (const text of samples) {
      const qr = encodeQR(text);
      expect(qr.size).toBe(qr.version * 4 + 17);
      expect(decodeMatrixRoundTrip(qr)).toBe(text);
    }
  });

  it('超长字符串（> 213 字节）抛出清晰错误', () => {
    expect(() => encodeQR('x'.repeat(220))).toThrow(/过长/);
  });
});
