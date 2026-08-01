/**
 * 镜头震动（docs/07 §1.7、docs/10 偏差 #3 的关闭证据）。
 *
 * ★★ 最重要的一条是「cameraShake=0 → 四通道全零」——
 *   17.2 的「减弱镜头震动」设置项等了三个里程碑，等的就是这个断言。
 */

import { describe, expect, it } from 'vitest';
import { CameraShake, SHAKE } from './CameraShake.js';
import { DEFAULT_ACCESSIBILITY } from '../settings/accessibility.js';

const settings = (cameraShake: number) => ({ ...DEFAULT_ACCESSIBILITY, cameraShake });

describe('创伤模型', () => {
  it('★ add 取 max 不累加，且钳制在 1', () => {
    const s = new CameraShake();
    s.add(0.6);
    s.add(0.3); // 更小的不覆盖
    s.update(0);
    expect(s.traumaLevel).toBeCloseTo(0.6);
    s.add(5); // 钳到 1
    expect(s.traumaLevel).toBe(1);
  });

  it('★ 按 DECAY 线性衰减，满创伤约 1/DECAY 秒归零', () => {
    const s = new CameraShake();
    s.add(1);
    s.update(1 / SHAKE.DECAY + 0.01);
    expect(s.traumaLevel).toBe(0);
    expect(s.active).toBe(false);
  });

  it('★ 强度是 trauma²：0.5 创伤的幅度约为满创伤的 1/4，不是 1/2', () => {
    const a = new CameraShake();
    const b = new CameraShake();
    a.add(1);
    b.add(0.5);
    // 同一时刻采样（time 都是 0），噪声相同 → 幅度比 = shake 比
    const sa = a.sample(settings(1));
    const sb = b.sample(settings(1));
    if (sa.yaw !== 0) expect(sb.yaw / sa.yaw).toBeCloseTo(0.25, 5);
    if (sa.roll !== 0) expect(sb.roll / sa.roll).toBeCloseTo(0.25, 5);
  });
});

describe('★★ shakeAmplitude 是唯一入口（偏差 #3 的兑现）', () => {
  it('★★ cameraShake=0 时 sample 四通道**全部**为零', () => {
    const s = new CameraShake();
    s.add(1);
    s.update(0.02);
    const out = s.sample(settings(0));
    // Math.abs：负向噪声 × 0 会得到 -0，而 Object.is(-0, 0) 是 false
    expect(Math.abs(out.yaw)).toBe(0);
    expect(Math.abs(out.pitch)).toBe(0);
    expect(Math.abs(out.roll)).toBe(0);
    expect(Math.abs(out.pullIn)).toBe(0);
  });

  it('★ cameraShake=0.5 时幅度恰好是全强度的一半', () => {
    const s = new CameraShake();
    s.add(1);
    s.update(0.02);
    const full = s.sample(settings(1));
    const half = s.sample(settings(0.5));
    expect(half.yaw).toBeCloseTo(full.yaw * 0.5, 10);
    expect(half.pullIn).toBeCloseTo(full.pullIn * 0.5, 10);
  });

  it('★ 噪声是确定性的：同一时刻采样两次结果相同（不是 Math.random）', () => {
    const s = new CameraShake();
    s.add(0.8);
    s.update(0.1);
    const a = s.sample(settings(1));
    const b = s.sample(settings(1));
    expect(a).toEqual(b);
  });

  it('★ pullIn 恒 ≥ 0 —— CameraController 的减法防穿墙依赖这个符号', () => {
    const s = new CameraShake();
    s.add(1);
    // 扫一段时间轴，pullIn 任何时刻都不能是负数（负 = 推远 = 可能穿墙）
    for (let i = 0; i < 200; i++) {
      s.update(0.016);
      expect(s.sample(settings(1)).pullIn).toBeGreaterThanOrEqual(0);
      if (!s.active) break;
    }
  });
});
