/**
 * HUD 的数据契约。
 *
 * ★★ **这个文件存在的理由，是 docs/13「判断二」被证伪了。**
 *
 *   路线图当初写：「两者共用 render / camera / hud / vfx / settings 全部表现层
 *   代码……这也顺便验证了一件事：如果表现层能同时吃本地模拟和远端快照，
 *   说明它确实没有偷偷依赖模拟内部状态。」
 *
 *   M10 接联网场景时**验出来的答案是：它依赖了。**
 *   `CombatHud.update()` 收的是 `CombatDirector`，并直接读 `dir.world` /
 *   `dir.player` 这些 **sim 内部类型** —— 而联网客户端手里只有 `EntitySnapshot`，
 *   压根没有 `World`，也没有 `CombatEntity`。
 *
 *   所以这里把 HUD 真正用到的东西收敛成一个**窄接口**：
 *   本地模拟（`CombatDirector`）与快照视图各实现一份，HUD 两边都能用。
 *
 * ★ 接口刻意**只列 HUD 真的读的字段**，不是把 `CombatEntity` 照抄一遍。
 *   照抄的话「快照视图」就得伪造一堆用不到的字段（碰撞半径、目标槽位、
 *   gcdUntil…），而每一个伪造出来的字段都是将来某人误用的入口。
 */

import type {
  CastFailure,
  CastState,
  ClassId,
  DisplayFlags,
  EntityId,
  SkillDef,
  TeamId,
  Vec3,
  WeaponId,
} from '@wowpvp/shared';

/**
 * HUD 眼里的一个单位。
 *
 * ★ `CombatEntity` 结构上已经满足它（字段名与含义一致），所以
 *   `CombatDirector` 不需要做任何适配；快照视图则把 `EntitySnapshot`
 *   转成这个形状。
 */
export interface HudUnit {
  id: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;
  position: Vec3;
  height: number;
  alive: boolean;
  health: number;
  maxHealth: number;
  /** ★ Map 而不是 Record —— 与 `CombatEntity` 一致，快照视图负责转换 */
  resources: ReadonlyMap<string, number>;
  maxResources: ReadonlyMap<string, number>;
  /**
   * 当前武器。★ 可空 —— 敌人的 `EnemyEquipmentSnapshot.currentWeaponId`
   *   本来就可能是 undefined（10.6 只暴露当前武器，而他可能没装备）。
   *   `CombatEntity.weaponId` 是必填的，赋给可空字段没有问题。
   */
  weaponId: WeaponId | undefined;
  flags: DisplayFlags;
}

/** 技能栏一格。与 `CombatDirector.SkillSlotView` 同构 */
export interface HudSkillSlot {
  skill: SkillDef;
  cooldownRemaining: number;
  blocker: CastFailure;
}

export interface HudLogEntry {
  time: number;
  text: string;
  kind: 'ok' | 'fail' | 'interrupt' | 'info';
}

/**
 * HUD 需要的全部信息。
 *
 * ⚠️ 往这里加成员之前先问一句：**HUD 真的需要它，还是只是「顺手能拿到」？**
 *   这个接口窄的价值就在于它挡住了「反正 director 上有，就直接读」——
 *   而那正是当初 `dir.world` 混进 HUD 的方式。
 */
export interface CombatView {
  /**
   * 当前模拟时间，秒。★ 施法条要用它算剩余时长。
   *   HUD 原本读的是 `dir.world.time` —— 那是它对 `World` 的**唯一**依赖，
   *   收敛成一个数字之后，快照视图用 `Snapshot.time` 就能满足。
   */
  readonly now: number;
  readonly player: HudUnit;
  readonly target: HudUnit | undefined;
  readonly focus: HudUnit | undefined;
  /** 自己当前的施法状态。没有则 undefined */
  readonly playerCast: CastState | undefined;
  readonly skills: readonly SkillDef[];
  readonly log: readonly HudLogEntry[];

  /** 场上其他可见单位（不含自己），供姓名板 */
  visibleUnits(): readonly HudUnit[];
  /** 某个单位的施法状态，供姓名板上的施法条 */
  castOf(unit: HudUnit): CastState | undefined;
  /** 自己到某个单位的距离，供目标框 */
  distanceTo(unit: HudUnit): number;
  skillSlots(): readonly HudSkillSlot[];
  /** 点击姓名板选中。★ 联网实现会发 SetTarget 而不是直接改本地状态 */
  selectById(id: number): void;
}
