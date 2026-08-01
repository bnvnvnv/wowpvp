/**
 * 镜头震动 —— 创伤（trauma）模型。打击感改造引入（docs/07 §1.7）。
 *
 * ★ 17.2「减弱镜头震动」的接线对象：docs/10 已知偏差 #3 等的就是它。
 *   四个输出通道（yaw/pitch/roll/pullIn）**各自**过 `shakeAmplitude()` ——
 *   那是唯一入口，见 accessibility.ts 的注释。
 *
 * ★★ 防穿墙是**结构性**的，不靠运行时检查（docs/07 §1.4：镜头穿墙 =
 *   免费的信息优势）：
 *     · 角度通道：位置一个字节都不动，只在 lookAt 之后叠旋转 ——
 *       相机位置未改变，不可能进入几何体
 *     · 位移通道：只输出 `pullIn ≥ 0`，CameraController 用**减法**把它
 *       从碰撞探测后的距离里扣掉 —— 镜头只会朝锚点拉近，永不推远
 *
 * ★ 噪声用确定性的哈希值噪声而不是 Math.random()：
 *   每帧独立随机在高帧率下读作「嗡」而不是「震」，低帧率下幅度失真；
 *   确定性还让 sample() 可测（同一时刻采样两次结果相同）。
 */

import {
  shakeAmplitude,
  type AccessibilitySettings,
} from '../settings/accessibility.js';

export const SHAKE = {
  /** 创伤衰减速度 1/s。满创伤约 0.36 秒归零 —— 再长就从「一记」变成「一直在抖」 */
  DECAY: 2.8,
  /** 噪声频率 Hz。18 读作「震」，低于 10 读作「晃」（晕）*/
  FREQUENCY: 18,
  /** shake=1 时的角度峰值（弧度）。60° FOV 下超过 1.5° 就开始不适 */
  MAX_YAW: 0.020, // ≈1.15°
  MAX_PITCH: 0.016, // ≈0.92°
  /** roll 最不易致晕，可以大一点 */
  MAX_ROLL: 0.030, // ≈1.72°
  /** shake=1 时最多把镜头**拉近**多少米。★ 只拉近，见文件头 */
  MAX_PULL_IN: 0.28,
  /**
   * 各事件加多少创伤。★ 只有**牵涉本地玩家**的事件才加（HitFeedback 负责
   * 这条筛选）—— 12v12 里 24 个人对轰，不筛画面会一直在抖。
   */
  TRAUMA: {
    /** 自己挨到轻击（DoT 跳等）：几乎不可感（trauma² 后 ≈0.004）*/
    selfHitLight: 0.06,
    selfHit: 0.18,
    selfHeavy: 0.38,
    selfCrit: 0.5,
    selfCritHeavy: 0.62,
    /** 自己**打出**暴击：手感属于攻击方，但要明显弱于挨打 */
    dealtCrit: 0.22,
    dealtHeavy: 0.12,
    dealtKill: 0.3,
    selfDeath: 0.6,
    /** 视野内他人死亡的上限，按距离线性衰减到 0（NEARBY_DEATH_RANGE 外为 0）*/
    nearbyDeathMax: 0.14,
  },
} as const;

/** 附近死亡的感知半径（米）。与 RANGE.SHORT 同源的「近距离」概念 */
export const NEARBY_DEATH_RANGE = 12;

/** 一维哈希值噪声：整点取哈希、其间平滑插值。确定性、无状态 */
const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  // 归一到 [-1, 1]
  return ((x >>> 0) / 0xffffffff) * 2 - 1;
};

/** 平滑插值的一维值噪声，t 任意实数，输出 [-1, 1] */
const valueNoise = (t: number, channel: number): number => {
  const i = Math.floor(t);
  const f = t - i;
  const k = f * f * (3 - 2 * f); // smoothstep
  const a = hash(i * 4 + channel);
  const b = hash((i + 1) * 4 + channel);
  return a + (b - a) * k;
};

export interface ShakeSample {
  yaw: number;
  pitch: number;
  roll: number;
  /** ≥ 0。CameraController 只做减法 */
  pullIn: number;
}

const ZERO: ShakeSample = { yaw: 0, pitch: 0, roll: 0, pullIn: 0 };

export class CameraShake {
  /** 当前创伤 [0,1]。实际强度 = trauma²（小创伤几乎不可见，大创伤很明显）*/
  private trauma = 0;
  /** 噪声相位（秒）。由 update 推进 —— 顿帧时跟着世界一起慢，是想要的效果 */
  private time = 0;

  /**
   * 加创伤。★ 取 max **不累加** —— 12v12 里五个人同时打你，
   * 累加会瞬间打满并持续一秒。
   */
  add(trauma: number): void {
    this.trauma = Math.min(1, Math.max(this.trauma, trauma));
  }

  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - SHAKE.DECAY * dt);
  }

  get active(): boolean {
    return this.trauma > 0;
  }

  /** 诊断只读：当前创伤值（diag-feel 脚本观察用）*/
  get traumaLevel(): number {
    return this.trauma;
  }

  /**
   * 本帧采样。★ 全部四个通道都过 `shakeAmplitude()` —— 唯一入口，
   * cameraShake=0 时四项**必须**全零（CameraShake.test.ts 钉着）。
   */
  sample(s: AccessibilitySettings): ShakeSample {
    if (this.trauma <= 0) return ZERO;
    const shake = this.trauma * this.trauma;
    const t = this.time * SHAKE.FREQUENCY;
    return {
      yaw: shakeAmplitude(SHAKE.MAX_YAW * shake * valueNoise(t, 0), s),
      pitch: shakeAmplitude(SHAKE.MAX_PITCH * shake * valueNoise(t, 1), s),
      roll: shakeAmplitude(SHAKE.MAX_ROLL * shake * valueNoise(t, 2), s),
      // pullIn 用噪声的绝对值 —— 它只能是「拉近多少」，不能有方向
      pullIn: shakeAmplitude(SHAKE.MAX_PULL_IN * shake * Math.abs(valueNoise(t, 3)), s),
    };
  }
}
