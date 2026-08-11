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
import { getArmor, getClass, getWeapon } from '../data/index.js';
import type { FlagState } from '../types/enums.js';
import { ctfInOvertime, ctfTimeRemaining, type CtfState } from '../sim/match/flag.js';
import { secondsToNextWave, type RespawnState } from '../sim/match/respawn.js';
import { movementLockOf, type MovementState } from '../sim/movement.js';
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

/**
 * P11 数字量化（有损）。`world.time += dt` 的浮点累加让几乎每个数都拖着
 * 17 位小数尾巴。方向与下界的论证见 `EntitySnapshot` 文件头第 3 条：
 * position 的 2 位是 Predictor 死区决定的硬下界；health/资源用 round 不用
 * floor —— hasResourceFor 的「宁可显示可用」口径的安全侧。
 */
const q2 = (v: number): number => Math.round(v * 100) / 100;
const q3 = (v: number): number => Math.round(v * 1000) / 1000;
const q1 = (v: number): number => Math.round(v * 10) / 10;
const q1Record = (m: ReadonlyMap<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of m) out[k] = q1(v);
  return out;
};

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
  /** 叠层。★ 省略 = 1（绝大多数光环不叠层，P11：默认值不付字节）*/
  stacks?: number;
  /**
   * 到期时刻（**服务器时间**，与 `Snapshot.time` 同钟）。persistent 光环省略。
   * ★ P11 把此前的 `remaining: number | null` 改成了这个口径 —— 与同文件
   *   `GroundAreaSnapshot.expiresAt` / `ProjectileSnapshot.impactAt` /
   *   `ArmorySnapshot.availableAt` / `EntitySnapshot.gcdUntil` 归一：
   *   服务器发**事实**（何时到期），剩余量由客户端用 `time` 自己算。
   *   remaining 本来就是这批字段里唯一的例外，而且每 tick 都在变 ——
   *   对将来的 delta 编码是纯噪声；expiresAt 在光环整个生命周期里不变。
   */
  expiresAt?: number;
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
  /**
   * 定身/昏迷的移动锁（`movementLockOf(flags)`）。与 speedMultiplier 同理：
   * 参与积分就必须同源下发，否则被定身的瞬间预测照走、快照往回拽 ——
   * 同一种橡皮筋。可选字段：老服务器不发时客户端按 'none' 处理。
   */
  lock?: 'none' | 'move' | 'full';
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

/**
 * P11：`EntitySnapshot.f` 位掩码的位序。
 *
 * ★★ **此前 9 个布尔带着长键名每 tick 每实体全量重发** —— 12v12 快照里
 *   flags 一项就占 30%（163B/实体），而绝大多数 tick 里它们全是 false。
 *   现在合成一个整数：常态（活着、没瞬移、无任何状态）掩码为 0，
 *   **整个字段省略** —— 与 `cooldowns`/`gcdUntil` 同一条「可选即事实」的规矩。
 *
 * ★ bit0 是 **dead** 而不是 alive —— 位序按「常态为 0」取，活着是常态。
 * ★ `carryingFlag` 此前在快照里发了**两遍**（顶层 + flags 内同一个值），
 *   合并进掩码顺带消掉这处重复。
 * ⚠️ 加位只能**追加**，不能重排 —— 客户端按同一张表解码（两端 import 同一份）。
 */
export const ENTITY_FLAG_BITS = {
  dead: 1 << 0,
  teleported: 1 << 1,
  stunned: 1 << 2,
  feared: 1 << 3,
  rooted: 1 << 4,
  silenced: 1 << 5,
  disarmed: 1 << 6,
  carryingFlag: 1 << 7,
  immuneAll: 1 << 8,
  immunePhysical: 1 << 9,
  immuneMagic: 1 << 10,
} as const;

/** 编码侧（服务器 snapshotEntity 用）。掩码为 0 时调用方省略字段 */
export const packEntityFlags = (
  alive: boolean,
  teleported: boolean,
  flags: {
    stunned: boolean; feared: boolean; rooted: boolean; silenced: boolean;
    disarmed: boolean; carryingFlag: boolean;
    immuneAll: boolean; immunePhysical: boolean; immuneMagic: boolean;
  },
): number =>
  (alive ? 0 : ENTITY_FLAG_BITS.dead) |
  (teleported ? ENTITY_FLAG_BITS.teleported : 0) |
  (flags.stunned ? ENTITY_FLAG_BITS.stunned : 0) |
  (flags.feared ? ENTITY_FLAG_BITS.feared : 0) |
  (flags.rooted ? ENTITY_FLAG_BITS.rooted : 0) |
  (flags.silenced ? ENTITY_FLAG_BITS.silenced : 0) |
  (flags.disarmed ? ENTITY_FLAG_BITS.disarmed : 0) |
  (flags.carryingFlag ? ENTITY_FLAG_BITS.carryingFlag : 0) |
  (flags.immuneAll ? ENTITY_FLAG_BITS.immuneAll : 0) |
  (flags.immunePhysical ? ENTITY_FLAG_BITS.immunePhysical : 0) |
  (flags.immuneMagic ? ENTITY_FLAG_BITS.immuneMagic : 0);

/** 解码侧（客户端 hydrate 用）。掩码字段缺席时传 0 */
export const displayFlagsOf = (f: number): DisplayFlags => ({
  stunned: (f & ENTITY_FLAG_BITS.stunned) !== 0,
  feared: (f & ENTITY_FLAG_BITS.feared) !== 0,
  rooted: (f & ENTITY_FLAG_BITS.rooted) !== 0,
  silenced: (f & ENTITY_FLAG_BITS.silenced) !== 0,
  disarmed: (f & ENTITY_FLAG_BITS.disarmed) !== 0,
  carryingFlag: (f & ENTITY_FLAG_BITS.carryingFlag) !== 0,
  immuneAll: (f & ENTITY_FLAG_BITS.immuneAll) !== 0,
  immunePhysical: (f & ENTITY_FLAG_BITS.immunePhysical) !== 0,
  immuneMagic: (f & ENTITY_FLAG_BITS.immuneMagic) !== 0,
});

/**
 * 快照里的实体 —— **wire 形态**（P11 瘦身后的传输形状）。
 *
 * ★★ 三条瘦身规则，每条都有对应的还原方：
 *   1. **位掩码 `f`**：alive/teleported/DisplayFlags 九项合成一个整数，
 *      常态（掩码 0）整个字段省略。解码用 `displayFlagsOf()`。
 *   2. **静态块首见即发**：`name/team/classId/maxHealth/maxResources`
 *      一局内不变，只在「该接收者第一次看到这个实体」的那份快照里携带
 *      （含潜行者现身、宠物召出 —— 判据是进没进过这条会话的可见集合，
 *      见 `SnapshotDeps.seen`），之后省略。客户端按实体 id 缓存。
 *   3. **数字量化**：position 2 位小数（⚠️ 硬下界不是口味 —— 量化步长 s
 *      的表观偏差上界 √3·s/2，s=0.01 得 0.0087m < Predictor 的
 *      IGNORE_BELOW=0.02m，落在「当没偏」档；再粗每次对账都会掉进
 *      平滑档 = 持续橡皮筋，且不会有任何断言变红）、yaw 3 位、
 *      health/resources 1 位（用 round 不用 floor —— hasResourceFor 是
 *      「宁可显示可用」的保守口径，round 落在安全侧）。
 *
 * 客户端在**解码边界**（NetworkScene 的 hydrate）把它还原成
 * `HydratedEntitySnapshot`，下游（插值器/HUD/画面）读的仍是完整形状 ——
 * 与试验场共用的那些契约（DisplayFlags 等）一个都不用改。
 */
export interface EntitySnapshot {
  id: EntityId;
  position: Vec3;
  yaw: number;
  health: number;
  /** 15.2：敌方资源值也要发，目标框需要显示 */
  resources: Readonly<Record<string, number>>;
  auras: readonly AuraSnapshot[];
  /**
   * 状态位掩码（`ENTITY_FLAG_BITS`）。**省略 = 0 = 活着且无任何状态**。
   *
   * ★★ 潜行相关字段刻意不在位表里（原 flags 字段的规矩原样搬来）：
   *   未被发现的潜行者压根不进快照（`isVisibleTo`），而进了快照的潜行者
   *   把「他在潜行」发出去是安全的；做成通用位会诱使将来有人「顺手也发给
   *   敌人」，那就退回到 docs/08 §4.1 明确否掉的路上了。
   */
  f?: number;
}

/**
 * P11 波3：快照的**每人私有段**（`SnapshotMessage.self`）。
 *
 * ★★ 实体数组是 (世界, 接收者队伍) 的函数（对抗性验证过：潜行裁剪、
 *   光环掩码、可见性全部只读队伍），**逐人的量恰好只有这几个** ——
 *   所以服务器把实体段按队伍构建+序列化一次全队共享，私有段单独拼进
 *   每人的消息。把私有字段再塞回实体数组 = 拆掉共享构建，别那么做。
 *
 * 各字段语义与出处（原来都挂在自己的实体上）：
 *   · `cooldowns` / `gcdUntil` —— docs/08 §4.3：只有自己能看到自己的冷却。
 *     gcdUntil 只在 GCD 未走完时有；「没有字段 = 不在 GCD 中」
 *   · `selfMovement` —— docs/08 §5 第 6 步重放的全部积分状态。没有它，
 *     预测从「正确位置 + 错误速度」出发，每次对账都差一点点
 *   · `focusId` —— 5.1 焦点回读，且只在焦点对自己可见时有（P10）
 *   · `pickableDropIds` —— 10.2 可拾取性按接收者算（sim 的 dropViewFor），
 *     共享段的 drops 只带物品事实，「我能不能捡」在这里
 *
 * ★ 观战跟随（11.4）时整个 self 段是**被跟随队友**的 —— 与此前
 *   `buildSpectatorSnapshot` 复用队友视角的语义逐字相同。
 */
export interface SelfStateSnapshot {
  cooldowns: Readonly<Record<string, number>>;
  gcdUntil?: number;
  focusId?: EntityId;
  selfMovement?: SelfMovementSnapshot;
  /** 只在有临时武装的对局里有意义；无掉落时省略 */
  pickableDropIds?: readonly number[];
}

/** P11 波3：一局不变的实体静态块，走每会话的 `EntityMeta` 通道首见即发 */
export interface EntityStaticsSnapshot {
  name: string;
  team: TeamId;
  classId: ClassId;
  maxHealth: number;
  maxResources: Readonly<Record<string, number>>;
}

/**
 * 客户端 hydrate 之后的实体形状 —— 下游（插值器/HUD/画面）读的完整形态。
 *
 * ★ wire 形态（`EntitySnapshot`）里省掉的一切在这里都是必填：静态块从
 *   首见缓存合回来、位掩码展开回 `DisplayFlags`、装备从 `EntityLoadouts`
 *   通道的缓存合回来。**服务器不产出这个类型** —— 它只存在于客户端
 *   解码边界之后，所以「静态块忘了发」在客户端表现为 hydrate 缺缓存，
 *   不会静默产出一个字段为 undefined 的实体（hydrate 会兜底跳过并告警）。
 */
export interface HydratedEntitySnapshot {
  id: EntityId;
  name: string;
  team: TeamId;
  classId: ClassId;
  position: Vec3;
  yaw: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  resources: Readonly<Record<string, number>>;
  maxResources: Readonly<Record<string, number>>;
  auras: readonly AuraSnapshot[];
  carryingFlag: boolean;
  /** 位掩码展开（`displayFlagsOf`）。与试验场共用的 HudUnit 契约读它 */
  flags: DisplayFlags;
  /** 13.4：本 tick 是瞬移（位掩码 bit1 展开）*/
  teleported: boolean;
  selfMovement?: SelfMovementSnapshot;
  cooldowns?: Readonly<Record<string, number>>;
  focusId?: EntityId;
  gcdUntil?: number;
  /**
   * 装备（来自 `EntityLoadouts` 通道的缓存）。队友是完整视图，敌人是
   * 裁剪视图 —— 两个不相交的类型，想在敌人视图里读备用装备是类型错误
   * （10.6 / 验收 #36）。P11 后它不再每 tick 进快照，改为变化时下发。
   */
  equipment?: AllyEquipmentSnapshot | EnemyEquipmentSnapshot;
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
 * ★★ 可拾取性是**按接收者**算的，而且算它的是 sim 的 `dropViewFor()`，
 *   不是网络层自己判一遍。10.2 的可拾取判据（职业归属、槽位上限、宠物、
 *   已拥有）只有 `checkPickup()` 一处实现 —— 客户端因此**无法**算出一个
 *   与服务器不同的答案，和 M3 的 `GroundIndicator` 不做几何计算是同一条规矩。
 *   （不这么做的典型后果：图标是亮的，按下去却提示「职业不匹配」。）
 * ★ P11 波3：`pickable` 从这里搬去了 `SelfStateSnapshot.pickableDropIds` ——
 *   它是本类型里**唯一**逐接收者的字段，留在这儿会拆掉共享段。
 *   判据的唯一实现（checkPickup → dropViewFor）不动，只换投递位置。
 */
export interface DropSnapshot {
  id: number;
  kind: DropKind;
  position: Vec3;
  /** 10.2「看得到所属职业」。消耗品没有归属，显示「通用」 */
  ownerClassName: string;
  itemName: string;
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
  /**
   * A17：**比赛剩余时间**（秒），15.4 右列「比赛时间」那一栏的数据源。
   *
   * ★ 只在**限时**的夺旗局里有值（`CTF.DURATION` 配了时长）——
   *   不限时的一局不带这个字段，HUD 因此不会画一个永远不动、
   *   数到零也不发生任何事的倒计时（附录A#7 的占位禁令）。
   * ★ 进入加时后它换成「距加时硬上限还剩多久」，含义由 `overtime` 区分。
   * ★ 零泄露面：赛程时钟是全场公开事实，与 `scoreToWin` 同一档。
   */
  timeRemaining?: number;
  /**
   * A17：夺旗已进入突然死亡加时（先得分者胜）。
   *
   * ★ 刻意**不复用** `suddenDeath` —— 那个字段一开就会带出
   *   `suddenDeathBlips`（竞技场的位置揭示），把它挂到夺旗上等于给
   *   潜行旗手点名。两件事同名不同物，各占一个字段。
   */
  overtime?: boolean;
}

/**
 * P11：客户端 hydrate 之后的快照形状 —— `entities` 换成完整形态，
 * drops 合回按接收者的 `pickable`（来自 self.pickableDropIds）。
 */
export interface HydratedSnapshot extends Omit<Snapshot, 'entities' | 'drops'> {
  entities: readonly HydratedEntitySnapshot[];
  drops: readonly HydratedDropSnapshot[];
}

/** hydrate 后的掉落物：合回按接收者的 `pickable`（self.pickableDropIds）*/
export type HydratedDropSnapshot = DropSnapshot & { pickable: boolean };

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
  /**
   * P11 波2（快照 10Hz）：**自上一份快照以来**瞬移过的实体。
   *
   * ★★ `MovementState.teleported` 是**每 tick 的脉冲** —— 快照分频后，
   *   落在非快照 tick 上的瞬移（闪现/击退/复活）会在下一份快照里读到
   *   false，插值器把 20 米的位置跳变当移动去平滑：角色以 40 米/秒滑行,
   *   13.4 / 验收 #47 直接破。服务器逐 tick 累积、随快照消费并清空；
   *   这里读「累积 ∪ 当前 tick」。不传 = 只看当前 tick（20Hz 时二者等价）。
   */
  teleportedSince?: ReadonlySet<EntityId>;
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
   * ★ P11 波3：这里只带**物品事实**（是什么、归谁的职业、在哪）——
   *   全队相同；「我能不能捡」逐接收者，在 `buildSelfState` 的
   *   `pickableDropIds` 里（同样走 sim 的 dropViewFor，判据实现不动）。
   *   不带任何实体 id，泄露面为零（见 `DropSnapshot` 的类型注释）。
   */
  const drops: DropSnapshot[] = (deps.arsenal?.drops ?? []).map((d) => {
    const cls = d.classId === undefined ? undefined : getClass(d.classId);
    const item = d.weaponId ? getWeapon(d.weaponId) : d.armorId ? getArmor(d.armorId) : undefined;
    const itemId = d.weaponId ?? d.armorId;
    return {
      id: d.id,
      kind: d.kind,
      position: { ...d.position },
      ownerClassName: cls?.name ?? (d.classId === undefined ? '通用' : String(d.classId)),
      itemName: item?.name ?? '未知物品',
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
    // A17：限时局才有剩余时间；加时另有一面旗子（见字段注释）
    const remaining = ctfTimeRemaining(deps.ctf, deps.world.time);
    if (remaining !== undefined) match.timeRemaining = remaining;
    if (ctfInOvertime(deps.ctf)) match.overtime = true;
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

  /**
   * 量化见模块级 q1/q2/q3（P11，有损，方向与下界见 `EntitySnapshot` 文件头第 3 条）
   */
  const mask = packEntityFlags(
    e.alive,
    (deps.movement?.get(e.id)?.teleported ?? false) ||
      (deps.teleportedSince?.has(e.id) ?? false),
    e.flags,
  );

  const snap: EntitySnapshot = {
    id: e.id,
    position: { x: q2(e.position.x), y: q2(e.position.y), z: q2(e.position.z) },
    yaw: q3(e.yaw),
    health: q1(e.health),
    resources: q1Record(e.resources),
    auras: aurasOf(deps.auras, e.id).map((a) => {
      // S7：施加者不可见 → 掩 id、连学派一起藏（学派也是线索）
      const hidden = !auraSourceVisible(a);
      return {
        auraId: hidden ? HIDDEN_AURA_ID : a.def.id,
        // P11：省略默认值（stacks=1 / persistent 无到期）—— 见 AuraSnapshot 注释
        ...(a.stacks > 1 ? { stacks: a.stacks } : {}),
        ...(Number.isFinite(a.expiresAt) ? { expiresAt: q2(a.expiresAt) } : {}),
        // ★ 非吸收光环一个字节都不带（八职业 90 技能里只有 4 个盾）
        //   掩码的 debuff 本就来自敌人，不会是自己/队友给的盾，无需保留吸收量
        ...(!hidden && a.absorbRemaining > 0
          ? { absorbRemaining: q1(a.absorbRemaining), absorbInitial: q1(a.absorbInitial) }
          : {}),
        // ★ 同理：只有**控制类**光环带学派（掩码时连学派也不给）
        ...(!hidden && a.def.drCategory !== undefined && a.def.school !== undefined
          ? { school: a.def.school }
          : {}),
      };
    }),
    ...(mask !== 0 ? { f: mask } : {}),
  };

  return snap;
};

/**
 * P11 波3：一局基本不变的静态块投影。MatchLoop 在该会话**首见**这个实体时
 * 随 `EntityMeta` 消息发一次（潜行者现身、宠物召出、重连都自动覆盖 ——
 * 判据是「进没进过这条会话的可见集合」，记账在服务器的每会话 seen）。
 * ★ 从快照里搬出来的动机：它曾是快照实体里**唯一**逐会话不同的部分，
 *   留在里面就没法做「同队共享同一份实体段字节」。
 *
 * ⚠️★ **W26 起 `maxHealth` 不再是「一局不变」的** —— 熊形态的
 *   `maxHealth: 1.2` 接线之后它会在变身进出时跳变。补发走的是与装备完全
 *   同一套「指纹变了才发」的路（`MatchLoop.snapAccounts.hpFp`），而不是
 *   塞回每 tick 的实体段：变身是稀有事件，为它给 24 人 × 10Hz 的每份快照
 *   都加一个字段是 P11 刚砍掉的那种浪费（实测 306KB/s/客户端）。
 *   客户端零改动 —— `SnapshotHydrator.setMeta` 本来就是「带 statics 就覆盖」。
 */
export const staticsOf = (e: CombatEntity): EntityStaticsSnapshot => ({
  name: e.name,
  team: e.team,
  classId: e.classId,
  maxHealth: e.maxHealth,
  maxResources: q1Record(e.maxResources),
});

/**
 * P11 波3：快照的每人私有段（字段清单与规则出处见 `SelfStateSnapshot`）。
 *
 * ★ `viewer` 是**有效视角**：观战跟随时传被跟随的队友 —— 与
 *   `buildSpectatorSnapshot` 复用队友视角的既有语义逐字一致。
 */
export const buildSelfState = (deps: SnapshotDeps, viewer: CombatEntity): SelfStateSnapshot => {
  const ctx: VisibilityContext = deps.ctf ? { ctf: deps.ctf } : {};
  const self: SelfStateSnapshot = {
    // docs/08 §4.3：只有自己能看到自己的冷却
    cooldowns: Object.fromEntries(viewer.cooldowns),
  };
  // GCD 只在还没走完时下发（「可选即事实」）
  if (viewer.gcdUntil > deps.world.time) self.gcdUntil = viewer.gcdUntil;

  /**
   * 5.1 焦点回读。★ 只发**对自己可见**的焦点：看不见的焦点等于没有焦点，
   * 否则就等于告诉我「那个隐身的人还在场上」（验收 #5）。
   */
  const focus = viewer.targets.focus !== undefined
    ? deps.world.entities.get(viewer.targets.focus)
    : undefined;
  if (focus && isVisibleTo(focus, viewer, ctx)) self.focusId = focus.id;

  // docs/08 §5 第 6 步：只有自己需要重放，所以也只有自己带完整移动状态
  const m = deps.movement?.get(viewer.id);
  if (m) {
    self.selfMovement = {
      velocity: { ...m.velocity },
      grounded: m.grounded,
      airSpeedCap: m.airSpeedCap,
      fallStartY: m.fallStartY,
      // ★ 与 tickWorld 第 2 步**同一个函数** —— 两边同源才谈得上预测收敛
      speedMultiplier: moveSpeedMultiplierOf(deps.auras, viewer, deps.world.time),
      // ★ 同上：定身/昏迷的移动锁也是积分输入，同一个 movementLockOf
      lock: movementLockOf(viewer.flags),
    };
  }

  /**
   * 10.2 可拾取性 —— 判据唯一实现仍是 sim 的 `dropViewFor`（→checkPickup），
   * 这里只换投递位置。没有装备栏（极端时序）一律不可拾取 —— 保守的那一边。
   */
  const drops = deps.arsenal?.drops ?? [];
  if (drops.length > 0) {
    const loadout = deps.loadouts.get(viewer.id);
    self.pickableDropIds = loadout
      ? drops.filter((d) => dropViewFor(d, viewer, loadout).pickableByViewer).map((d) => d.id)
      : [];
  }
  return self;
};

/**
 * P11：某接收者视角下这个实体的装备视图。
 *
 * ★★ 装备**不再每 tick 进快照** —— 基本静态的 153B/实体被 20Hz 重发是
 *   快照第二大的字节项。改由服务器（MatchLoop.broadcastSnapshots）按
 *   「指纹变了才发」的节奏走独立的 `EntityLoadouts` 消息，客户端按实体
 *   缓存合回 `HydratedEntitySnapshot.equipment`。
 * ★ 视图只依赖**接收者的阵营**（isFriendly 是纯队伍比较），观战跟随
 *   只能跟队友（11.4）—— 所以按会话缓存指纹不会因视角切换而错型。
 * ★ 裁剪语义原样：敌人走 `enemyLoadoutView()`（10.6 / 验收 #36），
 *   这里只是换了投递通道，不改任何可见性判定。
 */
export const equipmentViewFor = (
  e: CombatEntity,
  viewer: CombatEntity,
  deps: Pick<SnapshotDeps, 'loadouts' | 'swaps'>,
): AllyEquipmentSnapshot | EnemyEquipmentSnapshot =>
  isFriendly(e, viewer) ? allyEquipment(e, deps) : enemyEquipment(e, deps);

const allyEquipment = (
  e: CombatEntity,
  deps: Pick<SnapshotDeps, 'loadouts' | 'swaps'>,
): AllyEquipmentSnapshot => {
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
const enemyEquipment = (
  e: CombatEntity,
  deps: Pick<SnapshotDeps, 'loadouts' | 'swaps'>,
): EnemyEquipmentSnapshot => {
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
/**
 * 11.4 观战跟随的合法性判据 —— **唯一实现**。
 * `buildSpectatorSnapshot` 与服务器的共享段广播（MatchLoop）都用它：
 * 各抄一遍的后果是其中一份漏了 `isPet` 或阵营检查而无人发现。
 */
export const isLegalFollow = (following: CombatEntity, viewer: CombatEntity): boolean =>
  isFriendly(following, viewer) && following.alive && !following.isPet;

export const buildSpectatorSnapshot = (
  deps: SnapshotDeps,
  viewer: CombatEntity,
  following: CombatEntity,
): Snapshot | undefined => {
  // ★ 只能跟随己方存活玩家。不合法的跟随目标返回 undefined，
  //   而不是「退化成自由镜头」—— 后者正好是 11.4 禁止的那种情况
  if (!isLegalFollow(following, viewer)) return undefined;
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
      // ★ P11 后 name 是首见才带的可选字段 —— 报错只用 id，别让兜底断言
      //   在最不该出二次故障的时刻踩 undefined
      throw new Error(
        `快照泄露：实体 ${s.id} 对接收者 ${viewer.id} 不可见却进了快照。` +
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
