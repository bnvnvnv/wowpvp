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
import { isFriendly, isHiddenFromViewer, type CombatEntity } from '../sim/entity.js';
import { aurasOf, type AuraStore } from '../sim/aura.js';
import { enemyLoadoutView, type Loadout, type SwapStore } from '../sim/loadout.js';
import type { CtfState } from '../sim/match/flag.js';
import type { MovementState } from '../sim/movement.js';
import { listEntities, type World } from '../sim/world.js';

// ════════════════════════════════════════════════════════════════
//  可见性判定
// ════════════════════════════════════════════════════════════════

export interface VisibilityContext {
  /** 夺旗对局才传。12.2：旗手位置对双方持续可见 */
  ctf?: CtfState;
}

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
  consumableIds: readonly string[];
  swapping: boolean;
}

export interface AuraSnapshot {
  auraId: string;
  stacks: number;
  /** 剩余秒数。persistent 光环为 null */
  remaining: number | null;
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
   * 装备。队友是完整视图，敌人是裁剪视图 —— **两个不相交的类型**。
   * 想在敌人视图里读备用装备是类型错误（10.6 / 验收 #36）。
   */
  equipment: AllyEquipmentSnapshot | EnemyEquipmentSnapshot;
}

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

export interface MatchSnapshot {
  /** 8.5 战斗抑制当前值 */
  dampening: number;
  suddenDeath: boolean;
  /** 仅决胜阶段有值。见 SuddenDeathBlip 的注释 */
  suddenDeathBlips?: readonly SuddenDeathBlip[];
  /** 夺旗对局才有。竞技场为 undefined —— 与 15.4 两种 HUD 视图不相交同源 */
  flags?: readonly {
    team: TeamId;
    state: string;
    position: Vec3;
    /** 12.2：旗手身份对双方可见 */
    carrierId?: EntityId;
  }[];
  score?: Readonly<Record<string, number>>;
}

export interface Snapshot {
  tick: number;
  /** 接收者自己的实体 id，客户端用它区分「我」和别人 */
  you: EntityId;
  entities: readonly EntitySnapshot[];
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
  /**
   * 每个实体的移动状态，用来取 `teleported`（13.4，见 `EntitySnapshot.teleported`）。
   *
   * ★ 可选：纯规则测试和不驱动移动的调用方（试验场）不需要构造它。
   *   没传就一律 `teleported: false` —— 那对「位置由别处驱动」的实体是对的。
   */
  movement?: ReadonlyMap<EntityId, MovementState>;
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
  }

  return { tick: deps.tick, you: viewer.id, entities, match };
};

const snapshotEntity = (
  e: CombatEntity,
  viewer: CombatEntity,
  deps: SnapshotDeps,
): EntitySnapshot => {
  const isSelf = e.id === viewer.id;
  const friendly = isFriendly(e, viewer);

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
    auras: aurasOf(deps.auras, e.id).map((a) => ({
      auraId: a.def.id,
      stacks: a.stacks,
      remaining: Number.isFinite(a.expiresAt) ? Math.max(0, a.expiresAt - deps.world.time) : null,
    })),
    carryingFlag: e.flags.carryingFlag,
    equipment: friendly
      ? allyEquipment(e, deps)
      : enemyEquipment(e, deps),
  };

  // docs/08 §4.3：只有自己能看到自己的冷却
  if (isSelf) snap.cooldowns = Object.fromEntries(e.cooldowns);

  // docs/08 §5 第 6 步：只有自己需要重放，所以也只有自己带完整移动状态
  if (isSelf) {
    const m = deps.movement?.get(e.id);
    if (m) {
      snap.selfMovement = {
        velocity: { ...m.velocity },
        grounded: m.grounded,
        airSpeedCap: m.airSpeedCap,
        fallStartY: m.fallStartY,
      };
    }
  }

  return snap;
};

const allyEquipment = (e: CombatEntity, deps: SnapshotDeps): AllyEquipmentSnapshot => {
  const l = deps.loadouts.get(e.id);
  return {
    currentWeaponId: e.weaponId,
    currentArmorId: e.armorId,
    spareWeaponIds: l ? [...l.spareWeapons] : [],
    spareArmorIds: l ? [...l.spareArmors] : [],
    consumableIds: l ? l.consumables.map(String) : [],
    swapping: deps.swaps.has(e.id),
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
  { id: '4.3-cooldown', what: '敌方技能冷却不发', acceptance: 'docs/08 §4.3' },
  { id: '4.3-spectate', what: '观战只能跟随己方存活玩家', acceptance: '11.4' },
  { id: '8.5', what: '决胜阶段发无 id 的粗略位置标记，不使潜行者变为可选中', acceptance: '#5 + 8.5' },
  { id: '12.2', what: '旗手位置始终对双方可见', acceptance: '12.2' },
] as const;
