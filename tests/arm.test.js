import { describe, it, expect } from 'vitest';
import { createArm, moveDuration } from '../src/scene/arm.js';
import { ikWorld, fkWorld } from '../src/robot/ik.js';
import { fromThree } from '../src/math/coords.js';
import { ARM, BINS } from '../src/config.js';

describe('机械臂模型', () => {
  const arm = createArm({ requestRender: () => {} });

  it('模型层级算出的指尖与 fk 一致（连杆不脱节）', () => {
    const targets = [[20, 20, 0], [277, 190, 60], [148.5, 105, 30], ...BINS.map((b) => [b.center[0], b.center[1], b.size[2] + ARM.approach])];
    for (const P of targets) {
      const s = ikWorld(P, ARM);
      expect(s.reachable).toBe(true);
      arm.setAngles(s.angles);
      const tip = fromThree(arm.tipFromScene());
      const f = fkWorld(s.angles, ARM);
      for (let i = 0; i < 3; i++) {
        expect(tip[i]).toBeCloseTo(f[i], 6);
        expect(tip[i]).toBeCloseTo(P[i], 6);
      }
    }
  });

  it('初始姿态可达', () => {
    expect(arm.homeAngles).toHaveLength(4);
  });

  it('运动时长随转角增加，有上下限', () => {
    const a = [0, 0.5, -1, 0];
    expect(moveDuration(a, a)).toBe(450);
    expect(moveDuration(a, [Math.PI, 0.5, -1, 0])).toBe(1800);
    expect(moveDuration(a, [0.5, 0.5, -1, 0])).toBeGreaterThan(moveDuration(a, [0.2, 0.5, -1, 0]));
  });
});
