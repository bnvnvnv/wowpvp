/**
 * P4：骨骼动画的**距离/视锥分级**（LOD）。
 *
 * ★★ 出发点是 X10 的真机结论：低画质砍掉 60% 绘制调用，帧率**反而更差** ——
 *   也就是瓶颈偏「每实体的 CPU 开销」而不是 GPU 提交量。12v12 里每帧要推
 *   24 个 `AnimationMixer`，而其中大多数人离你二三十米、在屏幕上只有巴掌大，
 *   甚至根本不在视野里。他们的骨骼**不需要**每帧算一遍。
 *
 * ★★ **分频不是丢帧，是攒帧。**
 *
 *   这是本文件唯一真正需要小心的地方。「隔一帧更新一次」有两种写法：
 *     · 错的：`if (frame % 2) return;` —— 每两帧只喂一次 dt，
 *       动画时间只走了一半，远处的人会变成**慢动作**（而且离得越远越慢）。
 *     · 对的：把跳过那几帧的 dt **攒起来**，轮到自己那一帧一次喂进去。
 *       动画时间一秒还是一秒，只是采样密度从 60Hz 降到 30/20Hz。
 *   `AnimStride` 的整个存在意义就是让第二种写法成为唯一写得出来的写法：
 *   它只有一个出口 `feed()`，要么返回「本帧不喂」，要么返回**攒够的总时长**。
 *   单测 `animLod.test.ts` 钉的就是「喂进去的总时长 === 走过的总时长」。
 *
 * ★ 判据只吃距离与「在不在视野里」，**不吃画质档位** —— 14.4 的关键元素
 *   （角色）不允许被画质隐藏，而分频虽然不是隐藏，但把它挂在画质上迟早
 *   会长成「低画质角色不动」。距离是玩家自己能理解的东西：远处的人本来
 *   就看不清腿。
 */

/**
 * 分级阈值。⚠️ 三个数字都是**占位值**，取的是「一眼看不出差别」的保守档，
 * 没有实测出处 —— 真机上要不要再激进，等 X10 的第二轮肉眼判定。
 *
 * · `FULL_RATE_METERS` 12 米：贴身缠斗（近战 5 米内）与「围着你打的那一圈」
 *   全部落在这以内，全速播。
 * · `HALF_RATE_METERS` 25 米：12 米到 25 米半频（60fps 下 30Hz）。
 *   30Hz 是动画 LOD 的常见起点，这个距离上角色高度只剩屏幕的十分之一。
 * · 更远：三分频（20Hz）——恰好是服务器 tick 率，远处的人本来也只有
 *   20Hz 的位置更新，骨骼比位置还密没有意义。
 */
export const ANIM_LOD = {
  FULL_RATE_METERS: 12,
  HALF_RATE_METERS: 25,
  /** 视锥外：完全跳过（位置照常更新，见 `CharacterView.setTransform`）*/
  OFFSCREEN_STRIDE: Number.POSITIVE_INFINITY,
  /**
   * 视锥外攒帧的**上限**（秒）。
   *
   * ★★ 这是本文件里唯一一处「攒帧不丢帧」的例外，写在这里是为了它被看见：
   *   一个人转出视野 40 秒再转回来，把 40 秒一次喂进 mixer 没有任何观感收益
   *   （循环片段取模之后落在同一个姿势上），却会让镜头一甩就出现一帧尖峰 ——
   *   而「镜头一甩就卡一下」正是 X10 要修的那种毛病。
   *   超过这个上限的部分**丢弃**：屏幕外的动画时间没有观众。
   */
  OFFSCREEN_CATCHUP_CAP: 0.5,
} as const;

/**
 * 这一帧该几分之一频率推进骨骼。
 *
 * @param distance 实体到镜头的距离（米）
 * @param onScreen 包围球是否与视锥相交
 * @returns 1 = 每帧、2 = 半频、3 = 三分频、`Infinity` = 视锥外不推进
 */
export const animStrideFor = (distance: number, onScreen: boolean): number => {
  if (!onScreen) return ANIM_LOD.OFFSCREEN_STRIDE;
  if (distance <= ANIM_LOD.FULL_RATE_METERS) return 1;
  if (distance <= ANIM_LOD.HALF_RATE_METERS) return 2;
  return 3;
};

/**
 * 一个实体的攒帧器。**唯一出口是 `feed()`**（见文件头 ★★）。
 *
 * ★ 无状态可言：两个字段都是「攒了多少」与「攒了几帧」，
 *   `CharacterView` 每帧调一次 `feed()` 就够了。
 */
export class AnimStride {
  /** 攒着还没喂给 mixer 的时长（秒）*/
  private pending = 0;
  /** 攒了几帧 */
  private frames = 0;

  /**
   * 走过 `dt` 秒，返回**这一帧要喂给 mixer 的时长**；`undefined` = 本帧不喂。
   *
   * @param stride `animStrideFor()` 的返回值
   */
  feed(dt: number, stride: number): number | undefined {
    this.pending += dt;
    this.frames++;

    if (stride === ANIM_LOD.OFFSCREEN_STRIDE) {
      // 视锥外：一律不喂，但攒着（封顶见 OFFSCREEN_CATCHUP_CAP 的注释）
      if (this.pending > ANIM_LOD.OFFSCREEN_CATCHUP_CAP) {
        this.pending = ANIM_LOD.OFFSCREEN_CATCHUP_CAP;
      }
      return undefined;
    }

    if (this.frames < stride) return undefined;
    const owed = this.pending;
    this.pending = 0;
    this.frames = 0;
    /**
     * ★ dt 恰好为 0 时返回 0 而不是 undefined：调用方据此仍然会调
     *   `mixer.update(0)`，与分级之前逐字相同（three 对 0 是幂等的）。
     *   把它当成「不喂」会让「暂停帧」在两条路上表现不一致。
     */
    return owed;
  }

  /** 攒着还没喂出去的时长。★ 只给单测与自检读 */
  get owed(): number {
    return this.pending;
  }
}
