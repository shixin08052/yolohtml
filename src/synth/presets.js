// 合成图的 3 个预设视角。相机看向底板中心，离中心 distance mm。
// 斜拍时加一点偏航，避免测试只覆盖完全对称的情况。
import { BOARD } from '../config.js';

export const SYNTH_TARGET = [BOARD.width / 2, BOARD.height / 2, 0];

export const SYNTH_PRESETS = [
  { key: 'synth_90', label: '合成图 · 俯角 90°', pitchDeg: 90, yawDeg: 0, rollDeg: 0, distance: 300 },
  { key: 'synth_65', label: '合成图 · 俯角 65°', pitchDeg: 65, yawDeg: 6, rollDeg: 0, distance: 300 },
  { key: 'synth_45', label: '合成图 · 俯角 45°', pitchDeg: 45, yawDeg: -8, rollDeg: 2, distance: 300 },
];
