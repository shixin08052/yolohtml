// 测试用：不依赖浏览器，把码按比特矩阵画进 RGBA 数组。
import { markerBits } from '../../src/vision/aruco.js';

/**
 * @param {number} W
 * @param {number} H
 * @param {{id:number, x:number, y:number, mod:number, rot?:number}[]} items
 *   x, y：码本体左上角（像素）；mod：每格像素；rot：顺时针旋转 90° 的次数
 * @returns {{image:{width:number,height:number,data:Uint8ClampedArray},
 *            truth:{id:number, corners:number[][]}[]}}
 *   truth.corners 为码自身左上、右上、右下、左下在图像中的位置
 */
export function rasterMarkers(W, H, items) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const truth = [];
  for (const { id, x, y, mod, rot = 0 } of items) {
    const bits = markerBits(id);
    const n = bits.length;
    const M = n + 2;
    const rotCell = (gx, gy, size) => {
      let a = gx, b = gy;
      for (let k = 0; k < rot; k++) [a, b] = [size - b, a];
      return [a, b];
    };
    for (let gy = 0; gy < M; gy++) {
      for (let gx = 0; gx < M; gx++) {
        const inner = gx > 0 && gy > 0 && gx < M - 1 && gy < M - 1;
        if (inner && bits[gy - 1][gx - 1] === 1) continue; // 白格
        const [cx, cy] = rotCell(gx, gy, M - 1);
        for (let py = 0; py < mod; py++) {
          for (let px = 0; px < mod; px++) {
            const p = ((y + cy * mod + py) * W + x + cx * mod + px) * 4;
            data[p] = data[p + 1] = data[p + 2] = 0;
          }
        }
      }
    }
    const corners = [[0, 0], [M, 0], [M, M], [0, M]].map(([gx, gy]) => {
      const [a, b] = rotCell(gx, gy, M);
      return [x + a * mod, y + b * mod];
    });
    truth.push({ id, corners });
  }
  return { image: { width: W, height: H, data }, truth };
}
