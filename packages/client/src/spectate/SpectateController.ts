/**
 * 观战镜头。规格书 11.4，docs/08 §4.3。
 *
 * ★★ **11.4 的核心是一条否定式规则：「不能自由镜头穿墙找潜行目标。」**
 *
 *   这条与验收 #5 同源 —— 观战镜头如果能自由飞，就等于给了透视：
 *   死掉的队友可以飞到敌方后排报点，潜行者藏不住任何东西。
 *   而且它是**免费**的透视：只要死一次就能拿到，于是「先送一个」
 *   会变成一种战术。
 *
 * ★ 这个类的做法是**根本不提供自由镜头这个状态**：
 *
 *   它的状态只有一个字段 —— `followingId`。没有 `freeCameraPosition`、
 *   没有 `detached: boolean`、没有 `mode: 'follow' | 'free'`。
 *   镜头位置永远由「被跟随者的位置」推导出来（`cameraTargetOf()`），
 *   所以「飞到某个坐标」在这里**写不出来**，必须先给这个类加一个
 *   它现在没有的状态字段。
 *
 * ★ 可跟随名单来自 `net/visibility.ts` 的 `spectatableFor()` ——
 *   规则（只能跟随己方存活玩家）只有一个实现处，客户端不重写一份。
 *   本文件只负责「在名单里怎么切换」和「镜头怎么摆」。
 */

import { spectatableFor, type CombatEntity, type World } from '@wowpvp/shared';

export interface SpectateTarget {
  id: number;
  name: string;
  classId: string;
}

export class SpectateController {
  /**
   * 当前跟随的队友。
   *
   * ★ **这是本类唯一的状态。** 没有自由镜头坐标，所以观战视角
   *   永远被己方队友的位置约束住（11.4）。
   */
  private followingId: number | null = null;

  /**
   * 可观战的队友名单。★ 直接用 shared 的 `spectatableFor()` ——
   * 「只能跟随己方存活玩家」这条规则不在客户端重写。
   */
  available(world: World, viewer: CombatEntity): CombatEntity[] {
    return spectatableFor(world, viewer);
  }

  /** 当前是否处于观战状态 */
  get active(): boolean {
    return this.followingId !== null;
  }

  get following(): number | null {
    return this.followingId;
  }

  /**
   * 进入观战 / 切换到下一个队友。
   *
   * 返回新的跟随目标；没有可跟随的队友时返回 undefined 并退出观战 ——
   * ★ 注意是**退出**而不是「保持在最后一个位置继续看」。
   *   后者等于在全队阵亡后把镜头留在敌方半场，那正是自由镜头的效果。
   */
  cycle(world: World, viewer: CombatEntity): CombatEntity | undefined {
    const list = this.available(world, viewer);
    if (list.length === 0) {
      this.followingId = null;
      return undefined;
    }

    const currentIndex = list.findIndex((e) => (e.id as number) === this.followingId);
    // 未在观战 / 上一个目标已经不在名单里 → 从头开始
    const next = list[(currentIndex + 1) % list.length]!;
    this.followingId = next.id as number;
    return next;
  }

  /** 退出观战（重连、回到准备阶段）*/
  stop(): void {
    this.followingId = null;
  }

  /**
   * 每 tick 校验跟随目标是否仍然合法。
   *
   * ⚠️ 必须每 tick 调用：被跟随的队友随时可能死。不校验的话镜头会停在
   * 他倒下的地方继续看 —— 又是一次免费的自由镜头。
   *
   * 返回当前应当跟随的实体；返回 undefined 表示没有合法目标（应显示死亡界面）。
   */
  resolve(world: World, viewer: CombatEntity): CombatEntity | undefined {
    if (this.followingId === null) return undefined;

    const list = this.available(world, viewer);
    const still = list.find((e) => (e.id as number) === this.followingId);
    if (still) return still;

    // 被跟随者死了 → 自动切到下一个仍然存活的队友，而不是留在原地
    return this.cycle(world, viewer);
  }

  /**
   * 镜头应当看向哪里。
   *
   * ★ 返回的是**实体的位置**，不是一个可以任意设定的坐标 ——
   *   签名里没有任何让调用方自选位置的余地。
   */
  cameraTargetOf(entity: CombatEntity): { x: number; y: number; z: number } {
    return { ...entity.position };
  }
}
