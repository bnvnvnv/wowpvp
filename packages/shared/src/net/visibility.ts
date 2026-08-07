/**
 * 快照视野裁剪。docs/08 §4，规格书 5.3 / 8.5 / 10.6 / 12.2，验收 #5 / #36。
 *
 * ★★ **本文件唯一的设计目标：让「客户端能看到它不该看到的东西」写不出来。**
 *
 *   验收 #5 是「未被发现的潜行目标不能被点击、Tab 或小地图选中」。
 *   有两种实现方式，只有一种是对的：
 *
 *     ✗ 把 `stealthed: true` 发给客户端，让客户端别画 —— 改前端就能透视
 *     ✓ 未被发现的潜行者对该客户端而言**根本不存在**（docs/08 §4.1 原话）
 *
 *   所以裁剪必须发生在**构建**快照的时候，而不是构建完再过滤。
 *   本文件因此不提供任何「先建全量快照」的函数：`buildSnapshot()` 的签名里
 *   `viewer` 是**必填**参数，拿不到接收者就一个快照也建不出来。
 *
 * ★ 与 M6 的 `enemyLoadoutView()`、M8 的 `hiddenAtQuality(role: DecorativeRole)`
 *   是同一个思路：把规则做成类型/签名层面的事实，而不是靠记得遵守。
 */

import { RANGE } from '../constants/combat.js';
import type { Vec3 } from '../math/vec3.js';
import type { ArmorId, ClassId, EntityId, TeamId, WeaponId } from '../types/ids.js';
import type { School } from '../types/enums.js';
import { isFriendly, isHiddenFromViewer, type CombatEntity } from '../sim/entity.js';
import { aurasOf, moveSpeedMultiplierOf, type AuraStore } from '../sim/aura.js';
import {
  availableArmors, availableWeapons, enemyLoadoutView,
  type Loadout, type LoadoutView, type SwapKind, type SwapStore,
} from '../sim/loadout.js';
import { getArmor, getWeapon } from '../data/index.js';
import type { FlagState } from '../types/enums.js';
import type { CtfState } from '../sim/match/flag.js';
import { secondsToNextWave, type RespawnState } from '../sim/match/respawn.js';
import type { MovementState } from '../sim/movement.js';
import type { GroundStore } from '../sim/groundArea.js';
import type { ProjectileStore } from '../sim/projectile.js';
import { dropViewFor, type ArsenalStore, type DropKind } from '../sim/arsenal.js';
import { listEntities, type World } from '../sim/world.js';

// ════════════════════════════════════════════════════════════════
//  可见性判定
// ════════════════════════════════════════════════════════════════

export interface VisibilityContext {
  /** 夺旗对局才传。12.2：旗手位置对双方持续可见 */
  ctf?: CtfState;
}

/**
 * S7：来源不可见时，光环 id 被掩成这个中性 token。
 * ★ 客户端所有按 auraId 分派的逻辑（护盾/控制/化形/复活保护）都不匹配它，
 *   于是自然回落到「一个不知来历的 debuff」的中性显示 —— 正是要的效果。
 * ★ 放在 visibility.ts 而不是 protocol.ts：protocol 反过来 import 本文件的
 *   快照类型，常量搁这边免了循环依赖。
 */
export const HIDDEN_AURA_ID = 'hidden';

/**
 * docs/08 §4.1 的判定阶梯：实体 `target` 是否进入 `viewer` 的快照。
 *
 * 注意与「能否选中」的区别：
 *   · **死人要进快照** —— 客户端得画出尸体、播死亡表现、显示「已阵亡」的队伍框
 *   · **untargetable（剑刃风暴）要进快照** —— 它不能被选中，但当然看得见
 *   两者都由 `sim/entity.ts` 的 `isSelectableBy()` 负责，不是可见性问题。
 *   本函数只裁掉一种东西：未被发现的潜行者。
 */
export const isVisibleTo = (
  target: CombatEntity,
  viewer: CombatEntity,
  ctx: VisibilityContext = {},
): boolean => {
  // 自己永远看得见自己
  if (target.id === viewer.id) return true;
  // 队友的潜行对己方可见（docs/08 §4.1 第二条）
  if (isFriendly(target, viewer)) return true;

  /**
   * ★ 12.2：「旗手位置对双方持续可见。」
   *
   *   这一条**优先于**潜行裁剪。12.3 规定旗手不能潜行、8.4 规定使用潜行/
   *   完全无敌时先掉旗，所以正常流程下两条不会同时成立 —— 但那是**别的模块**
   *   在维护的不变量，不该由本文件假定它一定成立。
   *   万一哪天掉旗那条链断了（M8 就真的断过一次：客户端从没调用
   *   `dropFlagBeforeSkill()`），这里显式放行能保证「旗手隐身」不会同时
   *   变成「旗手消失」—— 那会让防守方彻底找不到旗。
   */
  if (ctx.ctf && isFlagCarrier(target, ctx.ctf)) return true;

  // 其余情况只有一条裁剪规则：未被发现的潜行者
  return !isHiddenFromViewer(target, viewer);
};

const isFlagCarrier = (e: CombatEntity, ctf: CtfState): boolean =>
  Object.values(ctf.flags).some((f) => f.carrierId === e.id);

// ════════════════════════════════════════════════════════════════
//  快照结构
// ════════════════════════════════════════════════════════════════

/**
 * 敌人的装备视图。★ 结构上没有备用装备字段 —— 见 `enemyLoadoutView()`
 * （10.6 / 验收 #36）。这里只是把它搬进快照类型，不重新定义规则。
 */
export interface EnemyEquipmentSnapshot {
  currentWeaponId: WeaponId | undefined;
  /** 只暴露护甲**原型**，不暴露具体哪一套 */
  armorArchetype: string | undefined;
  /** 换装动作可见，但看不出在换什么 */
  swapping: boolean;
}

/** 队友的装备视图：完整装备栏（含备用与道具）*/
export interface AllyEquipmentSnapshot {
  currentWeaponId: WeaponId;
  currentArmorId: ArmorId;
  spareWeaponIds: readonly WeaponId[];
  spareArmorIds: readonly ArmorId[];
  /**
   * `availableWeapons()` 的结果（默认 + 备用），供 15.3 的装备栏列表直接用。
   *
   * ★★ **不能让 UI 自己拼 `[current, ...spares]`。** `LoadoutView.allWeapons`
   *   的注释已经把这个坑写清楚了：换到备用武器后 spares 里**仍然**含着它，
   *   拼出来会把当前武器列两遍，同时默认武器凭空消失 —— 而 10.6 要求
   *   默认装备永远在列表里。试验场靠 `availableWeapons()` 避开它，
   *   联网侧不下发的话就会在**另一条路径上**重新踩一遍。
   */
  allWeaponIds: readonly WeaponId[];
  allArmorIds: readonly ArmorId[];
  consumableIds: readonly string[];
  swapping: boolean;
  /** 15.3 换装进度条需要的两样。★ 只在换装中才有，与 `swapping` 同源 */
  swapKind?: SwapKind;
  swapEndsAt?: number;
}

export interface AuraSnapshot {
  auraId: string;
  stacks: number;
  /** 剩余秒数。persistent 光环为 null */
  remaining: number | null;
  /**
   * 吸收盾的剩余量 / 初始量。**只有吸收类光环才有这两个字段**（>0 才投影）。
   *
   * ★★ 14.3 要求护盾有「激活/承伤/衰减/破裂」四种反馈，而联网侧此前
   *   **一份数据都没有** —— `NetworkScene.updateMarkersFor` 只能如实不画，
   *   那条注释就是本字段要还的欠条（docs/14 §M16d 的两笔协议债之一）。
   *
   * ★ 不泄露任何东西：纯数字、没有 id、没有来源，且只挂在**已经可见**的
   *   实体上（不可见的实体整个不进快照 —— verify:m10 第 1 条验的就是这个）。
   *   「敌人的盾还剩多少」本来就是 14.3 要求双方都看得见的信息：
   *   看不出盾快破了，「先破盾再爆发」这条打法就不存在。
   */
  absorbRemaining?: number;
  absorbInitial?: number;
  /**
   * 施加这个光环的技能学派。**只对控制类光环投影**（有 `drCategory` 的那些）。
   *
   * ★ 为什么需要它：控制光环的 id 被统一改写成 `control.<kind>`，
   *   表现层无法像护盾那样从 id 反查回技能 —— 而 14.3 要求
   *   「定身附着脚部」这类标记能读出是什么定住了你（冰系是冰棱、自然系是藤蔓）。
   * ★ 不泄露任何东西：它是**已经可见**的实体身上、**已经可见**的控制状态
   *   （`flags.rooted` 等本来就在快照里）的一个属性描述，
   *   不含来源 id、不含技能 id、不透露任何不可见实体的存在。
   */
  school?: School;
}

/**
 * 重放所需的权威移动状态。★ 字段就是 `stepMovement()` 会从上一帧读走的那些 ——
 * 加字段前先确认它真的参与积分，否则只是白占带宽。
 */
export interface SelfMovementSnapshot {
  velocity: Vec3;
  grounded: boolean;
  airSpeedCap: number;
  fallStartY: number;
  /**
   * 当前移动速度倍率（减速/加速光环 + 装备 + 12.3 旗手上限的聚合结果）。
   *
   * ★★ **必须下发，不能让客户端自己算。** 客户端手里只有快照，而
   *   `AuraSnapshot` 不带 modifiers，仓库里也没有 `auraId → AuraDef` 的注册表
   *   （AuraDef 匿名嵌在技能 effects 里，控制光环的 id 还被改写成 `control.<kind>`）。
   *   要客户端重算就得复制 11 个光环源 + 2 个护甲源 + 8.4 的聚合语义 + 两道下限，
   *   任何一点偏差都会退化成**持续橡皮筋**：预测按满速走、服务器按减速走，
   *   每份快照都把角色往回拽一次，而这类 bug 不会让任何断言变红。
   *
   * ★ 它与服务器 `tickWorld` 用的是**同一个** `moveSpeedMultiplierOf()`。
   * ★ 只发给自己（`isSelf` 分支），不新增任何可见性面。
   */
  speedMultiplier: number;
}

/**
 * 快照里可显示的状态标志（15.2 目标框 / 14.3 控制标记 / 8.4 免疫的视觉区别）。
 * ★ 见 `EntitySnapshot.flags` 的注释：潜行相关字段刻意不在这里。
 */
export interface DisplayFlags {
  stunned: boolean;
  feared: boolean;
  rooted: boolean;
  silenced: boolean;
  disarmed: boolean;
  carryingFlag: boolean;
  /** 8.4 三种免疫要有明显视觉区别 */
  immuneAll: boolean;
  immunePhysical: boolean;
  immuneMagic: boolean;
}

export interface EntitySnapshot {
  id: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;
  position: Vec3;
  yaw: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  /** 15.2：敌方资源值也要发，目标框需要显示 */
  resources: Readonly<Record<string, number>>;
  maxResources: Readonly<Record<string, number>>;
  auras: readonly AuraSnapshot[];
  carryingFlag: boolean;
  /**
   * 可显示的状态标志。15.2 要求目标框显示状态，14.3 / M8 的控制标记也读它。
   *
   * ★★ **不是整个 `StatusFlags`，只是能显示的那一部分。**
   *   `stealthed` / `stealthRevealed` **刻意不在这里** —— 未被发现的潜行者
   *   压根不进快照（`isVisibleTo`），而**进了快照的潜行者**（队友、旗手）
   *   把「他在潜行」发出去是安全的；但把这两个字段做成通用字段会诱使
   *   将来有人「顺手也发给敌人」，那就退回到 docs/08 §4.1 明确否掉的
   *   「发 stealthed 让客户端别画」那条路上了。
   *
   * ⚠️ 在此之前快照**根本没有状态标志** —— 联网场景的 HUD 因此无法显示
   *   「昏迷 / 沉默 / 缴械」，而 15.2 要求它显示。这是接 HUD 时才暴露的缺口，
   *   与 `teleported`、`selfMovement` 是同一类：**规则在，数据没传**。
   */
  flags: DisplayFlags;
  /**
   * 本 tick 这个实体是**瞬移**过来的（闪现、击退、位置纠正、复活）。
   *
   * ★★ **13.4 的硬要求靠它：「传送、位置纠正和大位移不能被识别为高速跑步」。**
   *   客户端对其他玩家做 100ms 插值，两帧之间位置差得远时它分不清
   *   「跑得快」和「闪现了」—— 插过去的话角色会以 40 米/秒滑行，
   *   而 `AnimationController` 会把那个速度判成冲刺。
   *
   * ★ 用**服务器的事实**而不是客户端的距离阈值来判：距离启发式在
   *   「20 米闪现」和「网络抖动导致两帧间隔变长」之间会猜错，
   *   而 `MovementState.teleported`（M1 就留了）是权威的。
   */
  teleported: boolean;
  /**
   * 自己的完整移动状态。★ 只有**自己**有这个字段（与 `cooldowns` 同理）。
   *
   * ★★ **没有它，客户端预测永远无法精确收敛。**
   *   docs/08 §5 第 6 步要「从权威状态出发重放剩余输入」，而 `stepMovement`
   *   读的**不止位置**：速度（有加速度）、是否着地、空中速度上限、起跳高度
   *   都参与下一步的积分。只发位置的话，重放会从「正确的位置 + 错误的速度」
   *   出发，于是每次对账都差一点点 —— 而那个「一点点」看起来就像网络抖动，
   *   查起来极难。（这条是 `Predictor` 的重放不变量测试逼出来的。）
   *
   * ★ 只发给自己，所以 12v12 的快照里也只有一份 —— 不是每个实体都带。
   */
  selfMovement?: SelfMovementSnapshot;
  /**
   * 技能冷却。★ 只有**自己**有这个字段。
   * docs/08 §4.3：敌方技能冷却不发 —— 规格书没要求，而且会削弱博弈。
   * 做成可选字段而不是「填个空对象」，是为了让「不小心发出去」需要显式赋值。
   */
  cooldowns?: Readonly<Record<string, number>>;
  /**
   * 5.1 焦点目标。★ 只有**自己**有这个字段，且**只在焦点对自己可见时**才有。
   *
   * ★★ P10：没有它，联网侧的焦点整条链路是死的 —— 协议早有
   *   `SetTarget slot:'focus'`、服务器早有 `toggleFocus`，但焦点是一个
   *   **切换**（同一目标再按一次清除），客户端本地猜出来的状态迟早与服务器分叉
   *   （服务器会因目标不可选中而静默不设）。所以由服务器回读，不由客户端记账。
   *
   * ★ 「焦点不可见就不发」是结构性的、不是保险起见：焦点可能在设定之后
   *   潜行遁走（`pruneInvalidTargets` 会在下一 tick 清掉它，但快照可以在
   *   任何时刻构建）。发一个我看不见的实体 id 就是把验收 #5 从
   *   「不能选中」放宽成「能确认他还在」。看不见的焦点等于没有焦点。
   */
  focusId?: EntityId;
  /**
   * 公共冷却的结束时刻（服务器时间）。★ 只有**自己**有，且**只在 GCD 还没走完时**才有
   *   —— 没有这个字段就是「不在 GCD 中」，与 `cooldowns` 同一条「可选即事实」的规矩。
   *
   * ★ 为什么需要：`cooldowns` 只有**技能自身**的冷却，GCD 是另一个量
   *   （`CombatEntity.gcdUntil`）。缺了它，联网侧技能栏画不出 GCD 转圈 ——
   *   而 GCD 恰恰是「按了为什么没反应」最常见的答案。
   * ★ 敌方的不发，理由与 `cooldowns` 同条（docs/08 §4.3：削弱博弈）。
   */
  gcdUntil?: number;
  /**
   * 装备。队友是完整视图，敌人是裁剪视图 —— **两个不相交的类型**。
   * 想在敌人视图里读备用装备是类型错误（10.6 / 验收 #36）。
   */
  equipment: AllyEquipmentSnapshot | EnemyEquipmentSnapshot;
}

/**
 * 把自己的装备快照还原成 15.3 装备栏要的 `LoadoutView`。
 *
 * ★★ **存在的意义是让联网侧与试验场共用同一个 `LoadoutPanel`。**
 *   不提供它的话，联网侧要么没有装备栏（15.3 在联网局里不成立），
 *   要么照着快照另写一个渲染器 —— 而「同一个界面两份实现」在本仓库
 *   已经出过一次事（`updateMarkersFor` 与试验场的护盾判据分叉）。
 *
 * ★ `getWeapon` / `getArmor` 是纯查表，客户端有同一份数据包，
 *   所以这里还原出来的 def 与服务器手里的是同一个对象内容。
 */
export const loadoutViewFromSnapshot = (
  eq: AllyEquipmentSnapshot,
  now: number,
): LoadoutView => ({
  currentWeapon: getWeapon(eq.currentWeaponId),
  currentArmor: getArmor(eq.currentArmorId),
  spareWeapons: eq.spareWeaponIds.map(getWeapon),
  spareArmors: eq.spareArmorIds.map(getArmor),
  allWeapons: eq.allWeaponIds.map(getWeapon),
  allArmors: eq.allArmorIds.map(getArmor),
  swapProgress:
    eq.swapKind !== undefined && eq.swapEndsAt !== undefined
      ? { kind: eq.swapKind, remaining: Math.max(0, eq.swapEndsAt - now) }
      : null,
});

/**
 * 8.5 决胜阶段的粗略位置标记。
 *
 * ★★ **这个类型故意没有 `id` 字段。**
 *
 *   8.5 要求「决胜阶段所有玩家大致位置可见」，而验收 #5 要求「未被发现的
 *   潜行目标不能被**点击、Tab 或小地图选中**」。两条看起来冲突，实际不冲突 ——
 *   前者要的是「知道人在哪」，后者禁止的是「把他当成目标」。
 *
 *   所以决胜阶段的位置走这个**独立通道**，而不是把潜行者塞回实体列表：
 *   标记没有实体 id，而选中链路（点击 / Tab / 小地图）全都要 id 才能工作，
 *   于是「决胜阶段能选中潜行者」在结构上不可能发生。
 *
 *   位置还按 `SUDDEN_DEATH_BLIP_GRID` 量化过 —— 「大致位置」就该是大致的，
 *   给出精确坐标等于把 #5 从「不能选中」放宽成「能被精确追杀」。
 */
export interface SuddenDeathBlip {
  team: TeamId;
  /** 已量化的粗略位置 */
  position: Vec3;
}

/** 决胜阶段粗略位置的量化网格，米。取 6.1 的短距离档的一半 */
export const SUDDEN_DEATH_BLIP_GRID = RANGE.SHORT / 2;

/**
 * 投射物快照。14.4：「不能隐藏……投射物主体」—— 在此之前投射物只存在于
 * 服务器的 `ProjectileStore` 里，联网客户端**什么都看不见**，这直接违反 14.4。
 *
 * ★★ **刻意没有 `sourceId` / `targetId`。**
 *   画一发飞行体只需要位置与技能（取属性色），带实体引用则是白送泄露面：
 *   `verify:m10` 第 1 条验的是「隐形实体的 id 不出现在**传输字节**里」，
 *   不带就天然不可能泄露 —— 与 `SuddenDeathBlip` 没有 id 是同一个手法。
 */
export interface ProjectileSnapshot {
  id: number;
  kind: 'homing' | 'colliding' | 'delayedImpact';
  skillId: string;
  /** homing/colliding 是当前位置；delayedImpact 是落点圆心 */
  position: Vec3;
  /** 仅 delayedImpact：落点半径 */
  radius?: number;
  /** 仅 delayedImpact：落地时刻（14.3 倒计时要用，服务器时间）*/
  impactAt?: number;
  /** 仅 delayedImpact：创建时刻 */
  createdAt?: number;
}

/**
 * 地面区域快照。14.3：「真实边界在整个有效期内持续显示」——
 * 同样在此之前联网客户端看不到任何地面区域。
 *
 * ★★ **只发 `areas`，永远不发 `traps`。**
 *   陷阱（9.5）的玩法就是「看不见，踩上才触发」—— 把它放进快照等于
 *   把猎人的核心机制标在敌人地图上。构建函数根本不读 `store.traps`。
 */
export interface GroundAreaSnapshot {
  id: number;
  skillId: string;
  center: Vec3;
  radius: number;
  /** 过期时刻（服务器时间），客户端可显示剩余 */
  expiresAt: number;
}

/**
 * 地面掉落物快照。10.2：「不符合职业的玩家**能看到**掉落物和所属职业，
 * 但交互时提示『职业不匹配』，物品不会消失。」
 *
 * ★★ **刻意没有任何实体 id** —— 与 `ProjectileSnapshot` / `SuddenDeathBlip`
 *   同一个手法。掉落物不属于任何人，画它只需要位置、是什么、归谁的职业。
 *
 * ★★ `pickable` 是**按接收者**算的，而且算它的是 sim 的 `dropViewFor()`，
 *   不是网络层自己判一遍。10.2 的可拾取判据（职业归属、槽位上限、宠物、
 *   已拥有）只有 `checkPickup()` 一处实现 —— 客户端因此**无法**算出一个
 *   与服务器不同的答案，和 M3 的 `GroundIndicator` 不做几何计算是同一条规矩。
 *   （不这么做的典型后果：图标是亮的，按下去却提示「职业不匹配」。）
 */
export interface DropSnapshot {
  id: number;
  kind: DropKind;
  position: Vec3;
  /** 10.2「看得到所属职业」。消耗品没有归属，显示「通用」 */
  ownerClassName: string;
  itemName: string;
  /** 对**这个**接收者是否可拾取 */
  pickable: boolean;
  /**
   * P8：武器/护甲的定义 id（`getWeapon/getArmor` 可查回完整定义）。
   * 消耗品不填。★ 没有它，15.3 第三条「拾取时新旧对比」在客户端根本
   * 做不出来 —— 对比卡 UI 早就写好（`LoadoutPanel.pickupCandidate`），
   * 因为快照只有名字字符串而零调用方，死了一整个里程碑。
   * 泄露面为零：装备定义是公开数据，双方都看得到掉落物（10.2）。
   */
  itemId?: string;
}

/**
 * 军械点快照。10.4：「固定、可预测的补给点和倒计时」+「刷新前 5 秒显示
 * 小地图图标、地面光柱、文字和音效」。
 *
 * ★★ **刻意不发 `openedBy`。** 那是一个实体 id，而客户端只需要知道
 *   「这一轮还开不开得了」。发出去就白送一个泄露面：军械箱是全场公开的
 *   物件，任何人都看得见它的状态，于是「谁开的」会把一个可能不可见的
 *   实体的存在标在地图上 —— 与 `ProjectileSnapshot` 不带 sourceId 同理。
 *
 * ★ 预告窗口（5 秒）由客户端用 `availableAt - now` 自己算：
 *   服务器发**事实**（下一轮什么时候到），不发**表现判断**（该不该闪）。
 */
export interface ArmorySnapshot {
  id: number;
  position: Vec3;
  /** 下一次可用的时刻，服务器时间 */
  availableAt: number;
  /** 这一轮已被人打开（不说是谁）。10.4 的先到者独占 */
  opened: boolean;
}

export interface MatchSnapshot {
  /** 8.5 战斗抑制当前值 */
  dampening: number;
  suddenDeath: boolean;
  /** 仅决胜阶段有值。见 SuddenDeathBlip 的注释 */
  suddenDeathBlips?: readonly SuddenDeathBlip[];
  /** 夺旗对局才有。竞技场为 undefined —— 与 15.4 两种 HUD 视图不相交同源 */
  flags?: readonly {
    team: TeamId;
    state: FlagState;
    position: Vec3;
    /** 12.2：旗手身份对双方可见 */
    carrierId?: EntityId;
  }[];
  score?: Readonly<Record<string, number>>;
  /**
   * W12 夺旗三项（15.4 右列的数据源，此前 HUD 有组件、快照没数据）。
   * 三个都是**全场公开事实**，零泄露面：
   *   · `scoreToWin` 是房主开局前定的规则（12.1）
   *   · `focusStacks` 的效果双方都在承受（12.4 要求显示出来）
   *   · `respawnIn` 的波次是全局钟（12.6：波次让防守方有可预测的进攻窗口 ——
   *     「可预测」本来就是规则的一部分，瞒着谁都不对）
   */
  scoreToWin?: number;
  focusStacks?: number;
  /** 距下一次复活波次的秒数（12.6）。夺旗对局才有 */
  respawnIn?: number;
}

export interface Snapshot {
  tick: number;
  /** 接收者自己的实体 id，客户端用它区分「我」和别人 */
  you: EntityId;
  entities: readonly EntitySnapshot[];
  /** 14.4 投射物主体。对所有接收者相同（不带实体引用，见类型注释）*/
  projectiles: readonly ProjectileSnapshot[];
  /** 14.3 地面区域边界。只含 areas，永不含 traps（见类型注释）*/
  grounds: readonly GroundAreaSnapshot[];
  /** 10.2 地面掉落物。`pickable` 按接收者算（见类型注释）*/
  drops: readonly DropSnapshot[];
  /** 10.4 军械点与它的倒计时 */
  armories: readonly ArmorySnapshot[];
  match: MatchSnapshot;
}

// ════════════════════════════════════════════════════════════════
//  构建
// ════════════════════════════════════════════════════════════════

export interface SnapshotDeps {
  world: World;
  auras: AuraStore;
  swaps: SwapStore;
  loadouts: ReadonlyMap<EntityId, Loadout>;
  tick: number;
  dampening: number;
  suddenDeath: boolean;
  ctf?: CtfState;
  /** 12.6 复活波次（夺旗才有）。快照只读它的下一波时刻，不推进它 */
  respawn?: RespawnState;
  /**
   * 每个实体的移动状态，用来取 `teleported`（13.4，见 `EntitySnapshot.teleported`）。
   *
   * ★ 可选：纯规则测试和不驱动移动的调用方（试验场）不需要构造它。
   *   没传就一律 `teleported: false` —— 那对「位置由别处驱动」的实体是对的。
   */
  movement?: ReadonlyMap<EntityId, MovementState>;
  /** 投射物（14.4 主体可见）。可选：老调用方与纯规则测试不传就是空数组 */
  projectiles?: ProjectileStore;
  /** 地面区域（14.3 边界可见）。★ 只会读 `areas`，`traps` 结构上不进快照 */
  ground?: GroundStore;
  /**
   * 临时武装（10.2 掉落物 / 10.4 军械点）。
   * 可选：经典竞技场、夺旗与纯规则测试不传就是两个空数组
   * （`store.enabled` 为假时它本来也是空的 —— 验收 #28）。
   */
  arsenal?: ArsenalStore;
}

/**
 * 为**某一个接收者**构建快照。
 *
 * ★ `viewer` 是必填参数，而且本文件不导出任何不带 viewer 的变体 ——
 *   「先建一份全量快照再按人过滤」这种写法在这里根本没有入口。
 *   那种写法的危险在于：全量快照一旦存在，就迟早会有人为了省一次遍历
 *   而把它直接广播出去。
 */
export const buildSnapshot = (deps: SnapshotDeps, viewer: CombatEntity): Snapshot => {
  const ctx: VisibilityContext = deps.ctf ? { ctf: deps.ctf } : {};

  const entities: EntitySnapshot[] = [];
  for (const e of listEntities(deps.world)) {
    if (!isVisibleTo(e, viewer, ctx)) continue;
    entities.push(snapshotEntity(e, viewer, deps));
  }

  // 14.4 投射物主体 + 14.3 地面边界。不带实体引用，所以不经过可见性裁剪 ——
  // 没有可泄露的字段（见 ProjectileSnapshot / GroundAreaSnapshot 的类型注释）
  const projectiles: ProjectileSnapshot[] = (deps.projectiles?.items ?? []).map((p) =>
    p.kind === 'delayedImpact'
      ? {
          id: p.id, kind: p.kind, skillId: String(p.skillId),
          position: { ...p.center }, radius: p.radius,
          impactAt: p.impactAt, createdAt: p.createdAt,
        }
      : { id: p.id, kind: p.kind, skillId: String(p.skillId), position: { ...p.position } },
  );
  // ★ 只读 areas。traps 连变量都不取 —— 「不小心也发了陷阱」在这里写不出来
  const grounds: GroundAreaSnapshot[] = (deps.ground?.areas ?? []).map((a) => ({
    id: a.id, skillId: a.skillId, center: { ...a.center },
    radius: a.radius, expiresAt: a.expiresAt,
  }));

  /**
   * 10.2 掉落物 / 10.4 军械点。
   *
   * ★ 掉落物**逐接收者**算可拾取性，所以它在 viewer 分支里而不是像
   *   projectiles 那样对所有人相同 —— 但它同样不带任何实体 id，
   *   泄露面为零（见 `DropSnapshot` 的类型注释）。
   * ★ `pickable` 走 sim 的 `dropViewFor()`，网络层不自己判一遍。
   */
  const viewerLoadout = deps.loadouts.get(viewer.id);
  const drops: DropSnapshot[] = (deps.arsenal?.drops ?? []).map((d) => {
    const view = viewerLoadout ? dropViewFor(d, viewer, viewerLoadout) : undefined;
    const itemId = d.weaponId ?? d.armorId;
    return {
      id: d.id,
      kind: d.kind,
      position: { ...d.position },
      ownerClassName: view?.ownerClassName ?? '通用',
      itemName: view?.itemName ?? '未知物品',
      // ★ 没有装备栏（观战者的跟随视角等）一律不可拾取 —— 保守的那一边
      pickable: view?.pickableByViewer ?? false,
      // P8：武器/护甲带定义 id，客户端才能做 15.3 的新旧对比（消耗品不带）
      ...(itemId !== undefined ? { itemId: itemId as string } : {}),
    };
  });
  const armories: ArmorySnapshot[] = (deps.arsenal?.armories ?? []).map((a) => ({
    id: a.id,
    position: { ...a.position },
    availableAt: a.availableAt,
    // ★ 只发布尔值，不发 openedBy（见 ArmorySnapshot 的类型注释）
    opened: a.openedBy !== undefined,
  }));

  const match: MatchSnapshot = {
    dampening: deps.dampening,
    suddenDeath: deps.suddenDeath,
  };
  if (deps.suddenDeath) {
    match.suddenDeathBlips = buildSuddenDeathBlips(deps.world);
  }
  if (deps.ctf) {
    match.flags = Object.values(deps.ctf.flags).map((f) => ({
      team: f.team,
      state: f.state,
      position: { ...f.position },
      ...(f.carrierId !== undefined ? { carrierId: f.carrierId } : {}),
    }));
    match.score = { ...deps.ctf.score };
    match.scoreToWin = deps.ctf.scoreToWin;
    match.focusStacks = deps.ctf.focusStacks;
  }
  if (deps.respawn) {
    match.respawnIn = secondsToNextWave(deps.respawn, deps.world.time);
  }

  return { tick: deps.tick, you: viewer.id, entities, projectiles, grounds, drops, armories, match };
};

const snapshotEntity = (
  e: CombatEntity,
  viewer: CombatEntity,
  deps: SnapshotDeps,
): EntitySnapshot => {
  const isSelf = e.id === viewer.id;
  const friendly = isFriendly(e, viewer);
  const ctx: VisibilityContext = deps.ctf ? { ctf: deps.ctf } : {};
  /**
   * ★ S7：光环 id（`rogue.rupture`）泄露施加者职业。施加者对 viewer 不可见时
   *   （潜行的盗贼挂完 DoT 又遁形），把 auraId 掩成中性 token —— 目标身上
   *   「有个 debuff」照常，但不说是谁的什么。施加者可见 / 是自己或队友 /
   *   已离场时不掩（正常显示）。
   * ★ 这是**持续**泄露面（每 tick 一份快照）；AuraApplied 那条一次性的在
   *   `redactFor` 里用同一口径处理。
   */
  const auraSourceVisible = (a: { sourceId: EntityId }): boolean => {
    const src = deps.world.entities.get(a.sourceId);
    return !src || isVisibleTo(src, viewer, ctx);
  };

  const snap: EntitySnapshot = {
    id: e.id,
    name: e.name,
    team: e.team,
    classId: e.classId,
    position: { ...e.position },
    yaw: e.yaw,
    teleported: deps.movement?.get(e.id)?.teleported ?? false,
    health: e.health,
    maxHealth: e.maxHealth,
    alive: e.alive,
    resources: Object.fromEntries(e.resources),
    maxResources: Object.fromEntries(e.maxResources),
    auras: aurasOf(deps.auras, e.id).map((a) => {
      // S7：施加者不可见 → 掩 id、连学派一起藏（学派也是线索）
      const hidden = !auraSourceVisible(a);
      return {
        auraId: hidden ? HIDDEN_AURA_ID : a.def.id,
        stacks: a.stacks,
        remaining: Number.isFinite(a.expiresAt) ? Math.max(0, a.expiresAt - deps.world.time) : null,
        // ★ 非吸收光环一个字节都不带（八职业 90 技能里只有 4 个盾）
        //   掩码的 debuff 本就来自敌人，不会是自己/队友给的盾，无需保留吸收量
        ...(!hidden && a.absorbRemaining > 0
          ? { absorbRemaining: a.absorbRemaining, absorbInitial: a.absorbInitial }
          : {}),
        // ★ 同理：只有**控制类**光环带学派（掩码时连学派也不给）
        ...(!hidden && a.def.drCategory !== undefined && a.def.school !== undefined
          ? { school: a.def.school }
          : {}),
      };
    }),
    carryingFlag: e.flags.carryingFlag,
    flags: {
      stunned: e.flags.stunned,
      feared: e.flags.feared,
      rooted: e.flags.rooted,
      silenced: e.flags.silenced,
      disarmed: e.flags.disarmed,
      carryingFlag: e.flags.carryingFlag,
      immuneAll: e.flags.immuneAll,
      immunePhysical: e.flags.immunePhysical,
      immuneMagic: e.flags.immuneMagic,
    },
    equipment: friendly
      ? allyEquipment(e, deps)
      : enemyEquipment(e, deps),
  };

  // docs/08 §4.3：只有自己能看到自己的冷却
  if (isSelf) {
    snap.cooldowns = Object.fromEntries(e.cooldowns);
    // GCD 只在还没走完时下发（见字段注释：没有字段 = 不在 GCD 中）
    if (e.gcdUntil > deps.world.time) snap.gcdUntil = e.gcdUntil;
    /**
     * 5.1 焦点回读。★ 只发**对自己可见**的焦点 —— 见 `focusId` 的字段注释：
     *   看不见的焦点等于没有焦点，否则就等于告诉我「那个隐身的人还在场上」。
     */
    const focus = e.targets.focus !== undefined
      ? deps.world.entities.get(e.targets.focus)
      : undefined;
    if (focus && isVisibleTo(focus, viewer, ctx)) snap.focusId = focus.id;
  }

  // docs/08 §5 第 6 步：只有自己需要重放，所以也只有自己带完整移动状态
  if (isSelf) {
    const m = deps.movement?.get(e.id);
    if (m) {
      snap.selfMovement = {
        velocity: { ...m.velocity },
        grounded: m.grounded,
        airSpeedCap: m.airSpeedCap,
        fallStartY: m.fallStartY,
        // ★ 与 tickWorld 第 2 步**同一个函数** —— 两边同源才谈得上预测收敛
        speedMultiplier: moveSpeedMultiplierOf(deps.auras, e, deps.world.time),
      };
    }
  }

  return snap;
};

const allyEquipment = (e: CombatEntity, deps: SnapshotDeps): AllyEquipmentSnapshot => {
  const l = deps.loadouts.get(e.id);
  const swap = deps.swaps.get(e.id);
  return {
    currentWeaponId: e.weaponId,
    currentArmorId: e.armorId,
    spareWeaponIds: l ? [...l.spareWeapons] : [],
    spareArmorIds: l ? [...l.spareArmors] : [],
    // ★ 走 sim 的 `availableWeapons()`，不在这里手拼（见类型注释）
    allWeaponIds: l ? [...availableWeapons(l)] : [],
    allArmorIds: l ? [...availableArmors(l)] : [],
    consumableIds: l ? l.consumables.map(String) : [],
    swapping: swap !== undefined,
    ...(swap ? { swapKind: swap.kind, swapEndsAt: swap.endsAt } : {}),
  };
};

/**
 * ★ 走 `enemyLoadoutView()` 而不是自己挑字段。
 *   验收 #36 的实现处只有一个，网络层照抄它的返回值就不可能泄露备用装备。
 */
const enemyEquipment = (e: CombatEntity, deps: SnapshotDeps): EnemyEquipmentSnapshot => {
  const v = enemyLoadoutView(e, deps.swaps);
  return {
    currentWeaponId: v.currentWeapon?.id,
    armorArchetype: v.armorArchetype,
    swapping: v.swapping,
  };
};

/**
 * 8.5：决胜阶段所有玩家的大致位置。
 * 位置量化到 `SUDDEN_DEATH_BLIP_GRID` 网格 —— 「大致」不能给成精确坐标。
 */
const buildSuddenDeathBlips = (world: World): SuddenDeathBlip[] =>
  listEntities(world)
    .filter((e) => e.alive && !e.isPet)
    .map((e) => ({
      team: e.team,
      position: {
        x: quantize(e.position.x),
        y: quantize(e.position.y),
        z: quantize(e.position.z),
      },
    }));

const quantize = (v: number): number =>
  Math.round(v / SUDDEN_DEATH_BLIP_GRID) * SUDDEN_DEATH_BLIP_GRID;

// ════════════════════════════════════════════════════════════════
//  观战（11.4：不能自由镜头穿墙找潜行目标）
// ════════════════════════════════════════════════════════════════

/**
 * 死亡后可以观战的目标列表。
 *
 * ★ 11.4 / docs/08 §4.3：**只能跟随己方存活玩家。**
 *   这条与验收 #5 同源 —— 观战镜头如果能自由飞，就等于给了透视：
 *   死掉的队友可以飞到敌方后排报点，潜行者藏不住任何东西。
 *
 *   返回**实体列表**而不是「可以去的坐标」，是为了让调用方只能做「跟随某个人」，
 *   做不出「飞到某个位置」。观战镜头的自由度因此受己方队友的位置约束。
 */
export const spectatableFor = (world: World, viewer: CombatEntity): CombatEntity[] =>
  listEntities(world).filter(
    (e) => e.alive && !e.isPet && isFriendly(e, viewer) && e.id !== viewer.id,
  );

/** 观战快照与活人共用同一条裁剪链路 —— 死了不会因此看到更多东西 */
export const buildSpectatorSnapshot = (
  deps: SnapshotDeps,
  viewer: CombatEntity,
  following: CombatEntity,
): Snapshot | undefined => {
  // ★ 只能跟随己方存活玩家。不合法的跟随目标返回 undefined，
  //   而不是「退化成自由镜头」—— 后者正好是 11.4 禁止的那种情况
  if (!isFriendly(following, viewer) || !following.alive || following.isPet) return undefined;
  // 视角是队友的，所以裁剪也按**队友**来做：他看不见的潜行者观战者也看不见
  return buildSnapshot(deps, following);
};

// ════════════════════════════════════════════════════════════════
//  自检
// ════════════════════════════════════════════════════════════════

/**
 * 断言一份已构建的快照里不含任何对该接收者隐形的实体。
 *
 * 这是给**服务器发送前**用的兜底自检，不是给测试用的 ——
 * 上面那些结构性保证都是「让错误写法难写」，这一条是「万一还是写出来了，
 * 在发出去之前崩掉」。验收 #5 是安全边界，宁可掉线也不能透视。
 */
export const assertNoHiddenEntities = (
  snapshot: Snapshot,
  world: World,
  viewer: CombatEntity,
  ctx: VisibilityContext = {},
): void => {
  for (const s of snapshot.entities) {
    const e = world.entities.get(s.id);
    if (!e) continue;
    if (!isVisibleTo(e, viewer, ctx)) {
      throw new Error(
        `快照泄露：实体 ${s.id}（${s.name}）对接收者 ${viewer.id} 不可见却进了快照。` +
          `见 docs/08 §4.1 与验收 #5。`,
      );
    }
  }
};

/** 供文档生成与测试引用：本文件实现了哪几条按接收者裁剪的规则 */
export const CULLING_RULES = [
  { id: '4.1', what: '未被发现的潜行者完全不进快照', acceptance: '#5' },
  { id: '4.2', what: '敌人只暴露当前武器与护甲原型，备用装备不发', acceptance: '#36' },
  { id: '4.3-cooldown', what: '敌方技能冷却与公共冷却不发', acceptance: 'docs/08 §4.3' },
  { id: '4.3-focus', what: '焦点目标只回读给自己，且焦点不可见时不发', acceptance: '#5 + 5.1' },
  { id: '4.3-spectate', what: '观战只能跟随己方存活玩家', acceptance: '11.4' },
  { id: '8.5', what: '决胜阶段发无 id 的粗略位置标记，不使潜行者变为可选中', acceptance: '#5 + 8.5' },
  { id: '12.2', what: '旗手位置始终对双方可见', acceptance: '12.2' },
] as const;
