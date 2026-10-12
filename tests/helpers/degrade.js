// 测试用：模拟打印质量差的码——黑色发灰、带白色斑点（墨粉不匀），再轻微模糊。

/** 固定种子的伪随机数 */
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * @param {{width:number, height:number, data:Uint8ClampedArray}} image 会被原地修改
 * @param {{ink?:number, density?:number, speck?:number, blur?:number, seed?:number}} opts
 *   ink：黑色的灰度；density：斑点密度（每个黑像素成为斑点中心的概率）；
 *   speck：斑点半径（像素）；blur：3×3 均值模糊次数
 */
export function degradePrint(image, { ink = 55, density = 0.02, speck = 1, blur = 1, seed = 7 } = {}) {
  const { width: W, height: H, data } = image;
  const r = rng(seed);
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = data[i * 4];
  const out = Float32Array.from(g, (v) => (v < 128 ? ink : v));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y * W + x] >= 128 || r() >= density) continue;
      const lv = 150 + 80 * r();
      for (let dy = -speck; dy <= speck; dy++) {
        for (let dx = -speck; dx <= speck; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= speck * speck) out[yy * W + xx] = lv;
        }
      }
    }
  }
  let cur = out;
  for (let k = 0; k < blur; k++) {
    const nxt = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) {
              s += cur[yy * W + xx];
              n++;
            }
          }
        }
        nxt[y * W + x] = s / n;
      }
    }
    cur = nxt;
  }
  for (let i = 0; i < W * H; i++) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = cur[i];
  return image;
}
