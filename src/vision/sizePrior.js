// 按元件的固定尺寸修正检测框。LED 的大小是固定的（本体 8.5 × 5.8 mm），朝向看引脚就知道，
// 于是照片里一个 LED 的框该有多大可以算出来。几个 LED 挤在一起时，靠外的那几个有清楚的边界（外侧是空白纸面），
// 框得准；中间的边界不明显，框容易偏大——伸进旁边零件那一侧，或者两个并排的合成一个框。
// 1. 比例尺：同一张照片里框得正常的 LED（置信度够高、引脚看得清）的"实际框 / 按尺寸推算的框"取中位数
//    （灯头是圆顶、离纸面有高度，照片里的框和模型尺寸差一个比例，各张照片略有不同）；
// 2. 大了一倍左右：多半是两个挨着的 LED 合成了一个框（靠外的两个角各是一个 LED 的边界）——在两个对角各放一个
//    LED 大小的框（大小按各自的引脚朝向定），两个都看到自己的引脚、基本不重叠，才算拆对了；
//    合成的框引脚朝两个方向、看不清朝向时，按"任何朝向下一个 LED 的框最大多大"判断是否偏大；
// 3. 偏大但不到一倍（或拆不开）：挨着别的零件的那一头边界不清，裁到一个 LED 的大小；
//    朝空白纸面的那一头边界清楚，保留。两头都不挨着别的零件时不动（可能只是影子）。
// 纯函数：框都是原图像素，朝向由调用方给（yawOf，一般看引脚）。

export const SIZE = {
  trim: 1.3,         // 某一方向超过预期的 1.3 倍算偏大（三张实拍里正常的框都在 1.15 以内）
  splitArea: 1.5,    // 面积超过预期的 1.5 倍：试着拆成两个
  splitMaxIou: 0.35, // 拆出的两个框重叠不超过这个（重叠太多说明其实只有一个，只是框长了）
  splitMinCover: 0.6, // 拆出的两个框一起至少盖住大框的这么多
  dupIou: 0.5,       // 修正出来的框与别的框重叠超过这个：那个零件已经有框，修正出来的不要
  slack: 1.05,       // 裁到预期大小的 1.05 倍
  refScore: 0.6,     // 置信度达到这个的才拿来定比例尺
  minRefs: 3,        // 参考框少于这个数时用默认比例
  scale: 0.93,       // 默认比例（三张实拍的中位数）
  scaleRange: [0.75, 1.3],
  nearMm: 1.5,       // "挨着别的零件"：别的框外扩这么多后与要裁的那一条重叠
  minContest: 0.05,  // 那一条至少有这么大比例挨着别的零件才裁
  headBias: 0.1,     // 两头都挨着时，偏向裁灯头那头（引脚那头有引脚伸出，边界更清楚）
};

/** 3×3 矩阵作用在点上（含透视除法） */
const apply = (M, x, y) => {
  const w = M[2][0] * x + M[2][1] * y + M[2][2];
  return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w];
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 按尺寸推算的框：底板上 (X, Y) 处、朝向 rotDeg 的 L × D 矩形在照片上的外接框大小（像素），
 * 以及灯头方向在照片上的单位向量
 * @param {number[][]} H 底板 mm → 照片像素
 * @returns {{ w: number, h: number, head: number[] }}
 */
export function bodyBoxPx(H, X, Y, rotDeg, [L, D]) {
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts = [[-L / 2, -D / 2], [L / 2, -D / 2], [L / 2, D / 2], [-L / 2, D / 2]].map(([u, v]) => apply(H, X + u * c - v * s, Y + u * s + v * c));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const o = apply(H, X, Y);
  const t = apply(H, X + c, Y + s);
  const n = Math.hypot(t[0] - o[0], t[1] - o[1]) || 1;
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), head: [(t[0] - o[0]) / n, (t[1] - o[1]) / n] };
}

/** 矩形 a 被一组矩形 bs 盖住的比例（重叠部分直接相加，封顶 1；只用来比较两头哪边挨得多） */
function covered(a, bs) {
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  if (area <= 0) return 0;
  let s = 0;
  for (const b of bs) s += Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return Math.min(1, s / area);
}

/**
 * 纸面颜色：框外一圈（marginPx 宽）像素的中位数（挤在一起时这一圈里也有别的零件，但多数还是纸）
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 */
export function paperColor(img, box, marginPx) {
  const { width: W, height: Hh, data } = img;
  const ch = [[], [], []];
  const step = Math.max(1, Math.round(marginPx / 6));
  const x0 = Math.max(0, Math.floor(box[0] - marginPx));
  const x1 = Math.min(W - 1, Math.ceil(box[2] + marginPx));
  const y0 = Math.max(0, Math.floor(box[1] - marginPx));
  const y1 = Math.min(Hh - 1, Math.ceil(box[3] + marginPx));
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) continue;
      const k = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) ch[c].push(data[k + c]);
    }
  }
  return ch[0].length ? ch.map(median) : null;
}

/**
 * 区域里"不是纸"的像素比例：box 里去掉 holes（若干矩形）后剩下的部分
 * 与纸面颜色差得多的算零件（透明 LED 也有高光、暗边和里面的支架，与纸面差得开）
 */
export function foreground(img, box, holes, paper, { step = 2, tol = 40 } = {}) {
  const { width: W, data } = img;
  let n = 0;
  let fg = 0;
  for (let y = Math.ceil(box[1]); y < box[3]; y += step) {
    for (let x = Math.ceil(box[0]); x < box[2]; x += step) {
      if (holes.some((h) => x >= h[0] && x < h[2] && y >= h[1] && y < h[3])) continue;
      const k = (y * W + x) * 4;
      n++;
      if (Math.abs(data[k] - paper[0]) + Math.abs(data[k + 1] - paper[1]) + Math.abs(data[k + 2] - paper[2]) > tol) fg++;
    }
  }
  return n ? fg / n : 0;
}

/**
 * 拆出的两个框贴到零件上：两个框先放在大框的对角，但大框往往比两个零件合起来还宽一点（框进了一段引脚、影子），
 * 放在对角会把两个零件拉开。这里让每个框在大框里平移（大小不变），挪到盖住"不是纸"的像素最多的地方；
 * 已被另一个框盖住的像素、落在别的零件框（exclude）里的像素不算，所以两个框各自贴到自己那个零件上。轮流挪两遍，每个方向最多挪框大小的两成。
 * @returns {number[][]}
 */
export function snapToParts(img, B, subs, paper, { tol = 40, rounds = 2, maxShift = 0.2, minGain = 0.05, exclude = [] } = {}) {
  const { width: W, data } = img;
  const x0 = Math.ceil(B[0]);
  const y0 = Math.ceil(B[1]);
  const w = Math.max(1, Math.floor(B[2]) - x0);
  const h = Math.max(1, Math.floor(B[3]) - y0);
  // 大框里"不是纸"的像素的积分图
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const k = ((y0 + y) * W + x0 + x) * 4;
      const inOther = exclude.some((e) => x0 + x >= e[0] && x0 + x < e[2] && y0 + y >= e[1] && y0 + y < e[3]);
      if (!inOther && Math.abs(data[k] - paper[0]) + Math.abs(data[k + 1] - paper[1]) + Math.abs(data[k + 2] - paper[2]) > tol) row++;
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row;
    }
  }
  const cnt = (b) => {
    const ax = Math.max(0, Math.min(w, Math.round(b[0] - x0)));
    const bx = Math.max(0, Math.min(w, Math.round(b[2] - x0)));
    const ay = Math.max(0, Math.min(h, Math.round(b[1] - y0)));
    const by = Math.max(0, Math.min(h, Math.round(b[3] - y0)));
    if (bx <= ax || by <= ay) return 0;
    return S[by * (w + 1) + bx] - S[ay * (w + 1) + bx] - S[by * (w + 1) + ax] + S[ay * (w + 1) + ax];
  };
  const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const out = subs.map((b) => [...b]);
  for (let r = 0; r < rounds; r++) {
    for (let j = 0; j < out.length; j++) {
      const b = out[j];
      const o = out[1 - j];
      const bw = b[2] - b[0];
      const bh = b[3] - b[1];
      // 只在原来（对角）位置附近微调：每个方向最多挪框大小的 maxShift，免得被旁边零件的本体、引脚拉走
      const s0 = subs[j];
      const xr = [Math.max(B[0], s0[0] - maxShift * bw), Math.min(B[2] - bw, s0[0] + maxShift * bw)];
      const yr = [Math.max(B[1], s0[1] - maxShift * bh), Math.min(B[3] - bh, s0[1] + maxShift * bh)];
      let best = null;
      for (let x = xr[0]; x <= xr[1] + 1e-9; x += 1) {
        for (let y = yr[0]; y <= yr[1] + 1e-9; y += 1) {
          const c = [x, y, x + bw, y + bh];
          const ov = inter(c, o);
          const v = cnt(c) - (ov[2] > ov[0] && ov[3] > ov[1] ? cnt(ov) : 0);
          // 一样多时取离原来位置近的
          const d = Math.abs(x - b[0]) + Math.abs(y - b[1]);
          if (!best || v > best.v + 1e-9 || (Math.abs(v - best.v) <= 1e-9 && d < best.d)) best = { v, d, c };
        }
      }
      // 多盖住的零件像素不够多（不到框面积的 minGain）时不挪：差一点的多半是旁边的引脚、影子
      const ov0 = inter(b, o);
      const v0 = cnt(b) - (ov0[2] > ov0[0] && ov0[3] > ov0[1] ? cnt(ov0) : 0);
      if (best.v - v0 > minGain * bw * bh) out[j] = best.c;
    }
  }
  return out;
}

/**
 * @param {{ cls: number, score: number, box: number[] }[]} dets 检测框（原图像素）
 * @param {{
 *   H: number[][], Hinv: number[][],                                  // 底板 mm ↔ 照片像素
 *   dims: Record<number, number[]>,                                    // 按类别：本体 [长, 宽]（mm）；没给的类别不处理
 *   yawOf: (box: number[], others: number[][]) => ({ rotDeg: number, reliable: boolean }|null), // 朝向（others：旁边的框）
 *   img?: { width: number, height: number, data: Uint8ClampedArray },  // 原照片：拆的时候用来挑两个对角里对的那一对
 * }} ctx
 * @param {Partial<typeof SIZE>} [opts]
 * @returns {{ dets: object[], changes: { index: number, kind: 'trim'|'split'|'drop', from: number[], to: number[][] }[], scale: Record<number, number> }}
 *   drop：修正后与别的框重合，去掉
 *   dets：修正后的框（拆开的就地换成几个），改过的带 fit（'trim' / 'split'）和 rawBox（原来的框）
 */
export function fitBoxes(dets, { H, Hinv, dims, yawOf, img = null }, opts = {}) {
  const o = { ...SIZE, ...opts };
  const boxes = dets.map((d) => d.box);
  const othersOf = (i, extra = []) => [...boxes.filter((_, j) => j !== i), ...extra];
  // 一个框：按它的朝向推算的大小，实际 / 推算
  const measure = (box, yaw, cls) => {
    const [X, Y] = apply(Hinv, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
    const p = bodyBoxPx(H, X, Y, yaw.rotDeg, dims[cls]);
    const o0 = apply(H, X, Y);
    const o1 = apply(H, X + 1, Y);
    return { p, r: [(box[2] - box[0]) / p.w, (box[3] - box[1]) / p.h], pxPerMm: Math.hypot(o1[0] - o0[0], o1[1] - o0[1]) };
  };
  const info = dets.map((d, i) => {
    if (!dims[d.cls]) return null;
    const yaw = yawOf(d.box, othersOf(i));
    return yaw?.reliable ? { yaw, ...measure(d.box, yaw, d.cls) } : { yaw: null };
  });

  // 1. 比例尺（按类别）
  const scale = {};
  for (const cls of Object.keys(dims).map(Number)) {
    const refs = info.filter((m, i) => m?.yaw && dets[i].cls === cls && dets[i].score >= o.refScore).map((m) => Math.sqrt(m.r[0] * m.r[1]));
    const s = refs.length >= o.minRefs ? median(refs) : o.scale;
    scale[cls] = Math.min(o.scaleRange[1], Math.max(o.scaleRange[0], s));
  }

  /**
   * 拆成两个：在大框的两个对角各放一个 LED 大小的框（大小按各自看引脚得到的朝向），
   * 两个都看到自己的引脚、基本不重叠、一起盖住大框的大部分，才算拆对；返回两个框或 null
   */
  const splitTwo = (d, i, yaw0) => {
    const B = d.box;
    const s = scale[d.cls];
    const sizeAt = (rot, b) => {
      const [X, Y] = apply(Hinv, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
      const p = bodyBoxPx(H, X, Y, rot, dims[d.cls]);
      return [Math.min(B[2] - B[0], s * p.w * o.slack), Math.min(B[3] - B[1], s * p.h * o.slack)];
    };
    // 角：0 左上、1 右上、2 左下、3 右下
    const anchor = (corner, [w, h]) => {
      const x = corner % 2 ? [B[2] - w, B[2]] : [B[0], B[0] + w];
      const y = corner >= 2 ? [B[3] - h, B[3]] : [B[1], B[1] + h];
      return [x[0], y[0], x[1], y[1]];
    };
    const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const inter = (a, b) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    // 两种对角都放得下时，看大框里没被盖住的地方：对的那一对剩下的是空白纸面，错的那一对剩下的是零件本体
    const [X0, Y0] = apply(Hinv, B[0], B[1]);
    const px = Math.hypot(...[0, 1].map((k) => apply(H, X0 + 1, Y0)[k] - B[k]));
    const paper = img ? paperColor(img, B, 2 * px) : null;
    let best = null;
    for (const rot0 of yaw0 ? [yaw0.rotDeg] : [0, 90]) {
      for (const pair of [[0, 3], [1, 2]]) {
        let subs = pair.map((c) => anchor(c, sizeAt(rot0, B)));
        let ok = true;
        for (let it = 0; it < 2 && ok; it++) {
          subs = subs.map((b, j) => {
            const yaw = ok ? yawOf(b, othersOf(i, [subs[1 - j]])) : null;
            if (!yaw?.reliable) {
              ok = false;
              return b;
            }
            return anchor(pair[j], sizeAt(yaw.rotDeg, b));
          });
        }
        if (!ok) continue;
        const both = inter(subs[0], subs[1]);
        const iou = both / (area(subs[0]) + area(subs[1]) - both);
        const cover = (area(subs[0]) + area(subs[1]) - both) / area(B);
        if (iou > o.splitMaxIou || cover < o.splitMinCover) continue;
        const score = paper ? -foreground(img, B, subs, paper) : cover - iou;
        if (!best || score > best.score) best = { subs, score };
      }
    }
    if (!best) return null;
    return paper ? snapToParts(img, B, best.subs, paper, { exclude: othersOf(i) }) : best.subs;
  };

  const out = [];
  const changes = [];
  dets.forEach((d, i) => {
    const m = info[i];
    if (!m) {
      out.push(d);
      return;
    }
    const s = scale[d.cls];
    let n = null;
    let big;
    let wantSplit;
    if (m.yaw) {
      n = m.r.map((r) => r / s);
      big = [0, 1].filter((a) => n[a] > o.trim);
      wantSplit = n[0] * n[1] >= o.splitArea;
    } else {
      // 朝向看不清（例如两个不同向的 LED 合成一个框，引脚朝两个方向）：和任何朝向下单个 LED 的框比面积
      const [X, Y] = apply(Hinv, (d.box[0] + d.box[2]) / 2, (d.box[1] + d.box[3]) / 2);
      const maxArea = Math.max(...[0, 45, 90, 135].map((r) => {
        const p = bodyBoxPx(H, X, Y, r, dims[d.cls]);
        return p.w * p.h;
      }));
      big = [];
      wantSplit = ((d.box[2] - d.box[0]) * (d.box[3] - d.box[1])) / (s * s * maxArea) >= o.splitArea;
    }
    if (!big.length && !wantSplit) {
      out.push(d);
      return;
    }
    // 2. 拆开
    const subs = wantSplit ? splitTwo(d, i, m.yaw) : null;
    if (subs) {
      for (const b of subs) out.push({ ...d, box: b, fit: 'split', rawBox: d.box });
      changes.push({ index: i, kind: 'split', from: d.box, to: subs });
      return;
    }
    if (!m.yaw) {
      out.push(d);
      return;
    }
    // 3. 裁：挨着别的零件的那一头裁到一个 LED 的大小
    const box = [...d.box];
    const near = o.nearMm * m.pxPerMm;
    const grown = othersOf(i).map((b) => [b[0] - near, b[1] - near, b[2] + near, b[3] + near]);
    for (const a of big) {
      const target = s * (a === 0 ? m.p.w : m.p.h) * o.slack;
      const excess = box[a + 2] - box[a] - target;
      if (excess <= 0) continue;
      const strip = (hi) => {
        const r = [...box];
        if (hi) r[a] = box[a + 2] - excess;
        else r[a + 2] = box[a] + excess;
        return r;
      };
      const c = [covered(strip(false), grown), covered(strip(true), grown)];
      if (Math.max(...c) < o.minContest) continue;
      // 灯头朝这个方向的分量明显时，灯头那头加一点
      const h = Math.abs(m.p.head[a]) > 0.5 ? (m.p.head[a] > 0 ? 1 : 0) : -1;
      if (h >= 0) c[h] += o.headBias;
      if (c[1] >= c[0]) box[a + 2] = box[a] + target;
      else box[a] = box[a + 2] - target;
    }
    if (box.every((v, k) => v === d.box[k])) {
      out.push(d);
      return;
    }
    out.push({ ...d, box, fit: 'trim', rawBox: d.box });
    changes.push({ index: i, kind: 'trim', from: d.box, to: [box] });
  });
  // 4. 修正出来的框与别的框几乎重合（大框是"已经单独框到的一个 + 没框到的一个"合成的，拆出的一半就是那一个）：
  //    那个零件已经有框了，修正出来的这个不要
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const iou = (a, b) => {
    const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
    return i / (area(a) + area(b) - i || 1);
  };
  const kept = out.filter((d) => !d.fit || !out.some((e) => e !== d && e.cls === d.cls && e.rawBox !== d.rawBox && iou(d.box, e.box) > o.dupIou));
  for (const c of changes) c.to = c.to.filter((b) => kept.some((d) => d.box === b));
  return { dets: kept, changes: changes.map((c) => (c.to.length ? c : { ...c, kind: 'drop' })), scale };
}
