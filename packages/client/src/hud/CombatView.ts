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
  School,
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
  /**
   * X17：身上的光环，供目标框/自身框的光环行（`auraRow.ts`）。
   *
   * ★★ **可选**是有意的，理由与 `HudSkillSlot.gcdRemaining` 完全相同：
   *   生产方有两个（本地 director 与快照视图），任何一方还没接线时
   *   「没填」必须是一个合法状态 —— 而不是编译错误、也不是一个空控件。
   *   `auraRowHtml` 对空行返回空串，于是未接线时目标框的 HTML 与
   *   改造前**逐字节一致**。
   * ⚠️ 这里放的是**已经可以给玩家看的**光环。裁剪（谁能看见谁的什么）
   *   是服务器 `net/visibility.ts` 的事，HUD 不做第二次判断也不该做。
   */
  auras?: readonly HudAura[];
}

/** 增益 / 减益 / 说不清。★ `unknown` 专门留给 S7 掩码（`HIDDEN_AURA_ID`）*/
export type HudAuraKind = 'buff' | 'debuff' | 'unknown';

/**
 * HUD 眼里的一枚光环。★ 同样刻意**只列 HUD 真的读的字段** ——
 * `AuraInstance` 上的 `sourceId` / `damageAccumulated` / `nextTickAt`
 * 一个都不在这里：它们是规则层的记账，混进表现层就成了将来误用的入口。
 */
export interface HudAura {
  /**
   * 光环 id。★ **`HIDDEN_AURA_ID`（`'hidden'`）是一个合法值** ——
   *   服务器对「会泄露施加者职业」的光环就是发这个中性 token（S7）。
   *   消费方（`auraRow.ts`）对它不查名字、不查学派、不查图标。
   */
  id: string;
  kind: HudAuraKind;
  /**
   * 到期时刻，与 `CombatView.now` **同钟**。
   *
   * ★ 发**事实**而不是 `remaining`，与 P11 给 `AuraSnapshot.expiresAt` 的
   *   理由一字不差：一份快照在插值期间会被读很多次，`remaining` 越读越旧，
   *   `expiresAt` 在光环整个生命周期里不变。
   * ★ `persistent`（潜行、德鲁伊形态）不填或填 `Infinity` —— 光环行
   *   因此不画倒计时，而不是画一个不动的数字。
   */
  expiresAt?: number;
  stacks?: number;
  /** 学派，供格子取色。查不到不填，消费方回落中性灰 —— 不许编颜色 */
  school?: School;
  /** 吸收盾剩余量 / 初始量（14.3 的「强度衰减」）。只有护盾类才有 */
  absorbRemaining?: number;
  absorbInitial?: number;
  /**
   * 玩家可见名。★ **仍然可选**，即使 X26 起联网侧多半填得出来
   * （`data/auraRegistry.ts` 按技能数据表建的 `auraId → AuraDef`）：
   * `control.*`、S7 掩码、以及将来 sim 现造的光环在表里没有条目。
   * 查不到就别填 —— 消费方退回 id，不编中文名。
   */
  name?: string;
}

/** 技能栏一格。与 `CombatDirector.SkillSlotView` 同构 */
export interface HudSkillSlot {
  skill: SkillDef;
  cooldownRemaining: number;
  blocker: CastFailure;
  /**
   * 公共冷却剩余/总时长，秒（合同 C1）。
   *
   * ★ **可选**是有意的：生产方有两个（本地 director 与快照视图），
   *   快照视图只能尽力而为。可选字段让「没填」是一个合法状态而不是
   *   编译错误 —— HUD 侧对应地退回原来的静态「公共冷却」文字，
   *   不会画出一个停在 0 的假扫层。
   * ⚠️ 与 `cooldownRemaining`（本技能自身冷却）是**两件事**：
   *   GCD 期间 7 个格子一起转，自身冷却只有那一个格子转。
   */
  gcdRemaining?: number;
  gcdTotal?: number;
  /**
   * 本格当前的**全部**不可用原因（合同 C1）。
   *
   * ★ `blocker` 只有一个名额，而实战里经常同时超距 + 没资源；
   *   只报一个会让玩家「走近了还是不能放」连着惊讶两次。
   *   HUD 按「位置→视线→朝向→资源→冷却→状态」挑首个显示
   *   （判定在 skillTooltip.ts 的 `pickBlocker`）。
   */
  blockers?: CastFailure[];
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
