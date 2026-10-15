// 分拣动画播放器：按 robot/sequence.js 展开的动作序列驱动机械臂和零件。
// 用自己的时钟（每帧累加 帧间隔 × 速度），所以暂停、调速在一段动作中途也立即生效。
import { ARM } from '../config.js';
import { ikWorld, lerpAngles } from '../robot/ik.js';
import { dropPose } from '../robot/drop.js';

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * @param {{
 *   arm: ReturnType<import('./arm.js').createArm>,
 *   partsLayer: ReturnType<import('./parts.js').createPartsLayer>,
 *   requestRender: () => void,
 *   onProgress?: (p: { task: number|null, phase: string, seg: number, total: number }) => void,
 *   onState?: (state: 'idle'|'running'|'paused'|'done') => void,
 * }} deps
 */
export function createSortPlayer({ arm, partsLayer, requestRender, onProgress = () => {}, onState = () => {} }) {
  let segs = [];
  let idx = 0;
  let t = 0; // 当前段已播放的时间（ms，已乘速度）
  let speed = 1;
  let state = 'idle';
  let raf = 0;
  let last = 0;

  const setState = (s) => {
    state = s;
    onState(s);
  };

  /** 按进度 k（0–1）摆放一段动作 */
  function apply(s, k) {
    if (s.type === 'move') {
      arm.setAngles(lerpAngles(s.from, s.to, easeInOutCubic(k)));
    } else if (s.type === 'line') {
      const e = easeInOutCubic(k);
      const P = s.from.map((x, i) => x + (s.to[i] - x) * e);
      arm.setAngles(ikWorld(P, ARM, { gripYaw: s.gripYaw, check: false }).angles);
    } else if (s.type === 'grip') {
      arm.setGap(s.from + (s.to - s.from) * k);
    } else if (s.type === 'drop') {
      partsLayer.setPose(s.partId, dropPose(s, k));
    }
  }

  /** 一段动作结束时的瞬间动作：零件挂到夹爪上 / 放回场景 */
  function finish(s) {
    if (s.type === 'attach') {
      const node = partsLayer.nodeOf(s.partId);
      if (node) {
        partsLayer.finishMethodAnimation(); // 刚切换过定位方法、零件还在移动时：先摆到位再夹起
        arm.group.updateMatrixWorld(true);
        arm.gripNode.attach(node); // 保持世界位置不变
        partsLayer.setMoved(s.partId);
      }
    } else if (s.type === 'detach') {
      const node = partsLayer.nodeOf(s.partId);
      if (node) {
        partsLayer.group.attach(node); // 保持世界位置不变，接下来的 drop 段让它落下
        partsLayer.setMoved(s.partId, { hideLabel: true });
      }
    }
  }

  function report() {
    const s = segs[idx];
    onProgress({ task: s ? s.task : null, phase: s ? s.phase : '完成', seg: idx, total: segs.length });
  }

  function frame(now) {
    raf = 0;
    if (state !== 'running') return;
    const dt = Math.min(100, now - last); // 切到后台再回来时不要一下跳过很多
    last = now;
    t += dt * speed;
    let changed = false;
    while (idx < segs.length) {
      const s = segs[idx];
      if (t < s.ms) {
        apply(s, s.ms ? t / s.ms : 1);
        break;
      }
      apply(s, 1);
      finish(s);
      t -= s.ms;
      idx++;
      changed = true;
    }
    if (changed) report();
    requestRender();
    if (idx >= segs.length) {
      setState('done');
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function run() {
    last = performance.now();
    setState('running');
    raf = requestAnimationFrame(frame);
  }

  return {
    /** 载入动作序列（回到第一段，不开始播放） */
    load(list) {
      cancelAnimationFrame(raf);
      raf = 0;
      segs = list;
      idx = 0;
      t = 0;
      setState('idle');
      report();
    },
    start() {
      if (state === 'running' || !segs.length || idx >= segs.length) return;
      arm.stop();
      run();
    },
    pause() {
      if (state !== 'running') return;
      cancelAnimationFrame(raf);
      raf = 0;
      setState('paused');
    },
    resume() {
      if (state === 'paused') run();
    },
    /** 停止播放（不恢复场景，由调用方重建零件、机械臂回初始姿态） */
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      segs = [];
      idx = 0;
      t = 0;
      setState('idle');
    },
    setSpeed(s) {
      speed = s;
    },
    get state() {
      return state;
    },
    get speed() {
      return speed;
    },
  };
}
