/**
 * X30 后半：**被击晕的摇头晃脑**（用户 2026-08-11 拍板：
 * 「被击晕应该有摇头晃脑的动作而不是简单停在那里」）。
 *
 * ★★ **先核对素材，再决定怎么做**（A14 之鉴）：八个玩家 GLB 的动画清单
 *   逐个 dump 过 —— 22 个片段里**没有任何 Dizzy / Stunned / Daze 类片段**
 *   （清单见 `weaponAnim.test.ts` 的 `REAL_CLIPS`）。昏迷现在播的是
 *   `Hit_A` 的 0.55 倍速循环，也就是「反复踉跄」，人是站直的。
 *   所以晃头只有程序化一条路 —— 与 P6 的闪避侧闪同一个先例
 *   （素材缺就程序化，将来素材到位换片段的落点写在调用处）。
 *
 * ★ 本文件只有**纯算术**（相位、幅度、权重推进），不碰 three.js ——
 *   于是「晃得对不对、解除停不停、死了晃不晃」全部能在 Node 里逐条断言，
 *   骨骼的拧法留给 `CharacterView.applyStunWobble`。
 *   与 `animLayer.ts`（纯数据）/ `CharacterView`（真骨架）是同一种分法。
 */

/** 摇头的三个轴。★ 单位一律弧度，正负方向按 three.js 的右手系 */
export interface WobbleSample {
  /** 绕 Y：左右转头 */
  yaw: number;
  /** 绕 X：点头。★ 恒 ≥ 0 —— 晕的人是**低着头**的，不会仰头 */
  pitch: number;
  /** 绕 Z：侧倾 */
  roll: number;
}

export const STUN_WOBBLE = {
  /**
   * 画圈角速度，rad/s。3.2 ≈ 每 2 秒转一圈。
   * ★ 这个频率是刻意压低的：晃得快读作「在挣扎」，晃得慢才读作「晕」。
   */
  RATE: 3.2,
  /** 三轴幅度（弧度）。头骨用满，整模回落时乘 `BODY_FACTOR` */
  YAW: 0.26,
  PITCH: 0.14,
  ROLL: 0.2,
  /**
   * 整模回落时的幅度折减。
   * ★ 0.35 而不是 1：拧**整个模型**等于连脚一起转，幅度给满会读成
   *   「角色在原地转圈」而不是「他在晃头」。
   */
  BODY_FACTOR: 0.35,
  /**
   * 淡入 / 淡出秒数。
   * ★★ 「解除即停」是判据、不是「一帧内瞬间归零」：0.12 秒的收势仍然是
   *   人眼里的「立刻停」，而硬切会让头**卡在**当前的偏移上一帧 ——
   *   在 60fps 下那是一次可见的抽搐。淡入更短（0.08）：中控那一下要即时。
   */
  FADE_IN: 0.08,
  FADE_OUT: 0.12,
} as const;

/**
 * 某一时刻的晃动量。
 *
 * ★★ `yaw` 与 `roll` 差 90°（sin / cos）—— 这就是「**画圈**」而不是
 *   「左右摇」：两个正交轴上的同频简谐、相位差四分之一周期，
 *   合成出来的就是一个圆。同相位的话头只会在一条斜线上来回摆，
 *   读作「摇头说不」，不是晕。
 * ★ `pitch` 走**半频**且做了半波偏置（`0.5 + 0.5·sin`）：
 *   低头的深浅在变，但**永远是低头**。让它过零会变成「点头 + 仰头」，
 *   那是清醒的人在打瞌睡，不是被打晕。
 *
 * @param t      相位钟（秒）。被晕期间累加，解除归零
 * @param weight 0..1 的淡入淡出权重。0 = 完全不晃（解除 / 死亡）
 */
export const stunWobbleAt = (t: number, weight = 1): WobbleSample => {
  const w = Math.min(1, Math.max(0, weight));
  const a = t * STUN_WOBBLE.RATE;
  return {
    yaw: Math.sin(a) * STUN_WOBBLE.YAW * w,
    roll: Math.cos(a) * STUN_WOBBLE.ROLL * w,
    pitch: (0.5 + 0.5 * Math.sin(a * 0.5)) * STUN_WOBBLE.PITCH * w,
  };
};

/** 权重朝目标推进一帧。target = 1 用淡入速度，0 用淡出速度 */
export const wobbleWeightStep = (current: number, target: number, dt: number): number => {
  const rising = target > current;
  const step = dt / (rising ? STUN_WOBBLE.FADE_IN : STUN_WOBBLE.FADE_OUT);
  return rising ? Math.min(target, current + step) : Math.max(target, current - step);
};

/**
 * 这套 flags 该不该晃。**判据只有这一处**，两个场景共用。
 *
 * ★★ 7.3：昏迷、恐惧、变形**都置 `stunned`**（`sim/aura.ts` 的
 *   `if (f.stunned || f.feared) flags.stunned = true`）。所以：
 *   · **恐惧要排掉** —— 被恐惧的人在**乱跑**，站着晃头是错的表达，
 *     而且 14.3 明确要求恐惧与昏迷的视觉不能混（`StatusMarkers` 那边
 *     用的也是「恐惧盖昏迷」的同一条优先级，两处口径必须一致）
 *   · **变形不在这里排** —— 那要看模型挂没挂上小动物，是 `CharacterView`
 *     自己知道的事（小鸡没有人形骨架），判据放在这儿反而够不着
 */
export const stunWobbleActive = (flags: { stunned: boolean; feared: boolean }): boolean =>
  flags.stunned && !flags.feared;
