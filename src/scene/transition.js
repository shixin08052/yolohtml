// "照片 → 3D"转场（约 4 秒，可重播）与"对比"模式。
// 1. 3D 画面区域改成照片的宽高比，照片盖在上面；相机放在拍照时手机的位姿上
// 2. 1 秒内照片透明度 1 → 0，同时零件从板面"长出来"（onGrow 回调，步骤 10 接入）
// 3. 2 秒内相机飞到默认全景视角（位置线性插值 + 四元数 slerp，easeInOutCubic），
//    画面区域同时恢复全尺寸，手机模型和视锥逐渐显示
// 画面区域只改渲染视口（world.setFrame），不改画布尺寸：每帧改尺寸会清空画布而闪烁
// 4. 启用轨道控制器
import * as THREE from 'three';

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 转场各段时长（ms） */
export const TRANSITION_MS = { hold: 300, fade: 1000, fly: 2000, settle: 300 };

/**
 * @param {{
 *   world: ReturnType<import('./world.js').createWorld>,
 *   container: HTMLElement,      // 3D 画布容器
 *   overlay: HTMLCanvasElement,  // 盖在画布上的照片
 *   phone: ReturnType<import('./phone.js').createPhone>,
 *   onGrow?: (t: number) => void, // 零件生长进度 0 → 1（步骤 10）
 *   onModeChange?: (mode: 'idle'|'playing'|'compare') => void,
 * }} deps
 */
export function createTransition({ world, container, overlay, phone, onGrow = () => {}, onModeChange = () => {} }) {
  let mode = 'idle';
  let raf = 0;

  const setMode = (m) => {
    mode = m;
    onModeChange(m);
  };

  /** 画面区域在容器里的位置与大小（px）；aspect 为 null 时铺满 */
  function fitRect(aspect) {
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (!aspect) return { x: 0, y: 0, w: W, h: H };
    let w = W;
    let h = W / aspect;
    if (h > H) {
      h = H;
      w = H * aspect;
    }
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function setRect(r) {
    world.setFrame(r);
    Object.assign(overlay.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, right: 'auto', bottom: 'auto' });
  }

  function resetRect() {
    world.setFrame(null);
    for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) overlay.style[k] = '';
  }

  /** 把照片画到覆盖层（分辨率跟容器走，最多 2048 宽） */
  function drawOverlay(bitmap, r) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(2048, Math.round(r.w * dpr));
    overlay.width = w;
    overlay.height = Math.round((w * bitmap.height) / bitmap.width);
    overlay.getContext('2d').drawImage(bitmap, 0, 0, overlay.width, overlay.height);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  /** 回到全景：容器铺满、相机默认视角、照片隐藏、手机显示、控制器启用 */
  function finish() {
    stop();
    overlay.hidden = true;
    resetRect();
    world.setControlsActive(true);
    world.setDefaultView();
    phone.setOpacity(1);
    onGrow(1);
    setMode('idle');
  }

  /**
   * 播放转场
   * @param {{ bitmap: ImageBitmap, pose: object, intrinsics: object }} p
   * @returns {Promise<void>}
   */
  function play({ bitmap, pose, intrinsics }) {
    stop();
    setMode('playing');
    world.setControlsActive(false);
    // 手机、零件第一次出现时才编译着色器、生成阴影会卡一下：先让它们全部可见完整渲染一帧
    // （同一个任务里照片随即盖上，这一帧不会被看到）
    phone.setOpacity(1);
    onGrow(1);
    world.render();
    const aspect = intrinsics.width / intrinsics.height;
    const r0 = fitRect(aspect);
    setRect(r0);
    drawOverlay(bitmap, r0);
    overlay.hidden = false;
    overlay.style.opacity = '1';
    phone.setOpacity(0);
    onGrow(0);

    const from = world.photoCameraParams({ pose, intrinsics });
    world.applyCamera(from);
    const { hold, fade, fly, settle } = TRANSITION_MS;
    const t0 = performance.now();
    const lookAt = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);

    /** 飞行进度 e（0–1）时的画面区域与相机。终点（全尺寸画面的默认视角）每帧重算：转场途中画面尺寸可能变化 */
    function flyTo(e) {
      const r0 = fitRect(aspect);
      const r1 = fitRect(null);
      const to = world.getDefaultView(r1.w / r1.h);
      const toQuat = new THREE.Quaternion().setFromRotationMatrix(lookAt.lookAt(to.position, to.target, up));
      setRect({
        x: r0.x + (r1.x - r0.x) * e,
        y: r0.y + (r1.y - r0.y) * e,
        w: r0.w + (r1.w - r0.w) * e,
        h: r0.h + (r1.h - r0.h) * e,
      });
      world.applyCamera(
        {
          position: from.position.clone().lerp(to.position, e),
          quaternion: from.quaternion.clone().slerp(toQuat, e),
          fov: from.fov + (to.fov - from.fov) * e,
          offset: from.offset,
          size: from.size,
        },
        1 - e,
      );
      phone.setOpacity(e);
    }

    return new Promise((resolve) => {
      const frame = (now) => {
        if (mode !== 'playing') return resolve();
        const t = now - t0;
        if (t < hold) {
          // 停在照片上
        } else if (t < hold + fade) {
          const k = (t - hold) / fade;
          overlay.style.opacity = String(1 - k);
          onGrow(easeInOutCubic(k));
        } else {
          // 飞行，以及之后的停顿。某一帧来得晚（主线程忙、手机掉帧）跳过了飞行终点时，这里也会先摆到终点，
          // 不会停在半路、等交给控制器时再跳一下
          if (!overlay.hidden) overlay.hidden = true;
          onGrow(1);
          flyTo(easeInOutCubic(Math.min(1, (t - hold - fade) / fly)));
          if (t >= hold + fade + fly + settle) {
            finish();
            world.render();
            return resolve();
          }
        }
        world.render(); // 同一帧里更新完立即渲染，不等下一轮渲染循环
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  /**
   * 对比模式：相机停在手机位姿，照片以 50% 透明度叠加，用来检查是否重合
   * @param {boolean} on
   */
  function compare(on, { bitmap, pose, intrinsics } = {}) {
    stop();
    if (!on) {
      finish();
      return;
    }
    setMode('compare');
    world.setControlsActive(false);
    const r = fitRect(intrinsics.width / intrinsics.height);
    setRect(r);
    drawOverlay(bitmap, r);
    overlay.hidden = false;
    overlay.style.opacity = '0.5';
    phone.setOpacity(0);
    onGrow(1);
    world.applyCamera(world.photoCameraParams({ pose, intrinsics }));
  }

  /** 停止转场 / 对比，回到全景 */
  function cancel() {
    if (mode !== 'idle') finish();
  }

  return { play, compare, cancel, get mode() { return mode; } };
}
