/**
 * 普通攻击（自动攻击）。规格书 7.6 + 8.1 的节奏表。
 *
 * ★★ **这一节的规则一直存在，但从来没有实现。**
 *
 *   `WeaponDef.swingInterval` / `swingPercent` 每件武器都有，`data.test.ts`
 *   还在校验它们（验收 #31「双手高单击低攻速、双持反之」）——
 *   但在 M11 之前，`swingInterval` 在整个 `sim/` 里**一次都没有被引用**，
 *   只在客户端的装备对比面板里用于**显示**。
 *
 *   后果不是「少一个功能」，而是**战士根本没有资源来源**：
 *   怒气 `start: 0, regenPerSecond: 0`，全职业只有冲锋 +15。
 *   `scripts/balance-report.ts` 跑出战士 0% 胜率就是这么来的。
 *
 * ── 7.6 的四条，逐条对应到代码 ──────────────────────────────
 *
 * | 规格书原文 | 实现 |
 * |---|---|
 * | 攻击计时到达时检查目标是否仍在武器距离、前方和可攻击状态 | `attempt()` 的四道检查 |
 * | 不满足时**本次挥击落空** | 返回 `miss`，**计时照常推进** |
 * | 攻击计时**不会被换装刷新** | `swings` 只在 `beginSwing` 时写 —— 换装路径不碰它 |
 * | 只能被控制、缴械、失去目标/距离/视线阻止 | 见 `blockedReason()`；**专用打断不在其中** |
 *
 * ★ 「不能被『脚踢』类技能打断」（8.1）在这里是**结构性**成立的：
 *   本模块根本不接 `interrupt.ts`，也没有可被打断的状态 ——
 *   普通攻击没有施法条，`applyInterrupt()` 找不到任何东西可打断。
 */

import { hasLineOfSight, inRange, isFacing } from '../math/geometry.js';
import { getWeapon } from '../data/index.js';
import type { EffectDef } from '../data/schema.js';
import { COMBAT_SWING } from '../constants/combat.js';
import { Resource, School } from '../types/enums.js';
import type { EntityId } from '../types/ids.js';
import { effectiveModifiersOf, type AuraStore } from './aura.js';
import { hitCircleOf, isSelectableBy, type CombatEntity } from './entity.js';
import { getEntity, listEntities, type World } from './world.js';

/**
 * 每个实体的挥击计时。
 *
 * ★★ **没有条目的实体不进行普通攻击** —— 与 `TickDeps.movement` 同一个设计。
 *   这不是性能优化，是**兼容性保证**：M1–M9 的 141 项验收跑在试验场里，
 *   而试验场的假人不该突然开始自动攻击。谁要自动攻击，谁显式登记一条。
 *   （4.x：「右键点击敌方目标：开始或停止普通攻击」—— 本来就是个开关。）
 */
export type SwingStore = Map<EntityId, SwingState>;

export interface SwingState {
  /** 下一次挥击的绝对时刻 */
  nextSwingAt: number;
}

export const createSwingStore = (): SwingStore => new Map();

/**
 * 这个实体**此刻**的挥击间隔，秒。
 *
 * ★★ **`AuraModifiers.attackSpeed` 的唯一消费方（W26）。** 在此之前守护型
 *   护甲的 `attackSpeed: 1.08` 只写在 `advantage/cost` 文案里 ——「攻速降低」
 *   是一句谎话，五种护甲的横向取舍（10.8 / 验收 #32）因此少了一条真实代价。
 *
 * ★★ **方向：这个字段乘的是「间隔」，不是「速度」**（schema 原文：
 *   「攻击间隔乘算，0.9 = 攻速快 10%」）。所以 `> 1 = 更慢`：
 *   守护甲 1.08 = 每刀多花 8% 时间；BOSS 狂暴 0.75 = 每刀少花 25% 时间。
 *   接反了就是「守护甲攻速加快 8%」—— 文案与实现双重说谎，且没有断言会红。
 *
 * ★ 单列成函数而不是写在 `tickSwings` 里：登记侧（`MatchLoop.syncSwings` /
 *   `CombatDirector.syncBotSwings`）算**第一刀**的时刻时用的必须是同一个数，
 *   两处各写一遍 `swingInterval × attackSpeed` 迟早漂移成「开打第一刀不吃
 *   护甲代价」。
 */
export const swingIntervalOf = (auras: AuraStore, e: CombatEntity, now: number): number =>
  (getWeapon(e.weaponId)?.swingInterval ?? 2) * effectiveModifiersOf(auras, e, now).attackSpeed;

/**
 * 开始自动攻击（4.x 右键目标）。
 * ★ 已经在挥击中时**不重置计时** —— 反复点右键不该刷新攻击节奏。
 */
export const beginSwing = (store: SwingStore, id: EntityId, now: number, interval: number): void => {
  if (store.has(id)) return;
  store.set(id, { nextSwingAt: now + interval });
};

/** 停止自动攻击 */
export const stopSwing = (store: SwingStore, id: EntityId): void => {
  store.delete(id);
};

export type SwingMiss =
  | 'noTarget' | 'outOfRange' | 'wrongFacing' | 'noLineOfSight'
  | 'controlled' | 'disarmed' | 'dead' | 'targetInvalid';

export interface SwingResult {
  attackerId: EntityId;
  targetId?: EntityId;
  /** 命中时带效果，交给调用方走统一结算 */
  effects?: EffectDef[];
  miss?: SwingMiss;
  /**
   * 这一发是**远程武器被贴脸后改出的近战挥击**（7.6）。
   *
   * ⚠️ 表现层**目前还没读它**，如实记在这里：客户端的 `onSwing` 对所有白字
   *   一律播 `playMeleeSwing()`（近战动画），所以贴脸挥击碰巧看着是对的，
   *   而**远处开弓播的也是挥砍动画** —— 那个错早于本次改动，属于「远程
   *   射击动画」这件还没做的事。等射击动画补上时，这个标志就是那个分叉点：
   *   `pointBlank` 为真播挥砍，为假播射击。
   */
  pointBlank?: boolean;
}

/**
 * 7.6：这一发是不是「贴脸挥击」—— 拿远程武器的人被近战贴上来了。
 *
 * ★ 只对远程武器成立。近战武器本来就是挥击，不存在切换。
 */
export const isPointBlankSwing = (
  attacker: CombatEntity, target: CombatEntity | undefined,
): boolean => {
  if (!target) return false;
  const weapon = getWeapon(attacker.weaponId);
  if (!weapon?.isRanged) return false;
  return inRange(
    hitCircleOf(attacker), hitCircleOf(target), COMBAT_SWING.RANGED_MELEE_RANGE, 0,
  );
};

/**
 * 8.1：「只能被控制、缴械、失去目标/距离/视线阻止。」
 * ★ 这个列表就是那句话 —— 想加一条阻止条件，先去规格书里找依据。
 */
const blockedReason = (
  world: World, attacker: CombatEntity, target: CombatEntity | undefined,
): SwingMiss | undefined => {
  if (!attacker.alive) return 'dead';
  // 7.3 硬控制停止一切主动动作
  if (attacker.flags.stunned || attacker.flags.feared) return 'controlled';
  // ★ 缴械挡普通攻击，沉默**不挡**（验收 #17）—— 普攻是武器动作，不是法术
  if (attacker.flags.disarmed) return 'disarmed';
  if (attacker.flags.cannotAttack) return 'controlled';

  if (!target) return 'noTarget';
  if (!target.alive || !isSelectableBy(target, attacker)) return 'targetInvalid';
  /**
   * 4.x/7.6：普通攻击只对**敌方**目标 —— 友方硬目标（治疗时选中队友）不是
   * 开火依据。登记侧（服务器 syncSwings / 试验场 syncBotSwings）已经按
   * `target.team !== e.team` 挡了一道，这里是结算侧的第二道门：登记与结算
   * 之间目标可以换（玩家把硬目标切到队友身上），信任调用方就是队友挨打。
   */
  if (target.team === attacker.team) return 'targetInvalid';

  const weapon = getWeapon(attacker.weaponId);
  const reach = weapon?.reach ?? 0;
  if (!inRange(hitCircleOf(attacker), hitCircleOf(target), reach, 0)) return 'outOfRange';

  /**
   * 7.6：近战要求目标在前方。远程武器不要求（只要有视线）——
   * ★ 但**贴脸挥击也是挥击**：切成近战的那一发同样要求目标在前方，
   *   否则「转身背对就打不到」这条近战规则会被远程武器绕过去。
   */
  if ((!weapon?.isRanged || isPointBlankSwing(attacker, target)) &&
      !isFacing(attacker.position, attacker.yaw, target.position)) {
    return 'wrongFacing';
  }
  if (!hasLineOfSight(hitCircleOf(attacker), hitCircleOf(target), world.obstacles)) {
    return 'noLineOfSight';
  }
  return undefined;
};

export interface SwingDeps {
  world: World;
  auras: AuraStore;
  swings: SwingStore;
}

/**
 * 推进所有挥击计时一个 tick。返回本 tick 发生的挥击。
 *
 * ★ 与 `tickGround` / `tickProjectiles` 同一个形状：**只算出「谁打谁、什么效果」，
 *   不自己结算** —— 结算走 `tickWorld` 那个唯一出口（A2 的教训）。
 */
export const tickSwings = (deps: SwingDeps, now: number): SwingResult[] => {
  const out: SwingResult[] = [];

  for (const attacker of listEntities(deps.world)) {
    const state = deps.swings.get(attacker.id);
    if (!state) continue;              // 没登记 = 不自动攻击
    if (now < state.nextSwingAt) continue;

    /**
     * ★ W26：间隔吃 `attackSpeed` 聚合值（守护甲 1.08 = 慢 8%、BOSS 狂暴
     *   0.75 = 快 25%）。**按挥出这一刀的时刻取值** —— 与「计时是绝对时刻」
     *   同一条纪律：下一刀的时间在这一刀落下时就定死，中途掉了 buff 也不会
     *   把已经走过的间隔追溯重算。
     */
    const interval = swingIntervalOf(deps.auras, attacker, now);
    /**
     * ★★ 7.6：「不满足时本次挥击落空，但**攻击计时不会被换装刷新**。」
     *   所以无论命中还是落空，计时都在这里推进 —— 落空不惩罚、也不奖励。
     *   ⚠️ 写成「命中才推进」的话，够不着目标的近战会攒出一次瞬发暴击。
     */
    state.nextSwingAt = now + interval;

    const target = getEntity(deps.world, attacker.targets.hard);
    const blocked = blockedReason(deps.world, attacker, target);
    if (blocked) {
      out.push({ attackerId: attacker.id, ...(target ? { targetId: target.id } : {}), miss: blocked });
      continue;
    }

    /**
     * 7.6 贴脸挥击：远程武器被近战贴上来就不再射击，改抡。
     * 详见 `COMBAT_SWING.RANGED_MELEE_RANGE` 的注释。
     */
    const pointBlank = isPointBlankSwing(attacker, target);

    const effects: EffectDef[] = [
      {
        kind: 'damage',
        school: School.Physical,
        /**
         * ★ 正常一发的 weaponPercent **必须是 1**：`magnitudeOf` 的基准值
         *   已经是 `swingPercent × 100`（「一次挥击」的定义就在那里），这里
         *   再传 swingPercent 会把它**平方** —— M14 配平时抓到：匕首（0.6）
         *   白字被压到 36/击 而重剑（1.4）膨胀到 196/击，快慢武器的取舍
         *   （验收 #31）被二次幂扭曲。一次挥击 = 100% 武器伤害，就这么多。
         * ★ 贴脸挥击是这个基准的一个**比例**，同理不能再乘 swingPercent。
         */
        amount: { weaponPercent: pointBlank ? COMBAT_SWING.RANGED_MELEE_RATIO : 1 },
      },
    ];

    /**
     * 普通攻击产生怒气。
     *
     * ★ 依据：9.x 的武器表把「**怒气获取 +20%**」写成双持单手剑的优势
     *   （规格书 403 行）—— 那句话只有在「普攻产生怒气」成立时才有意义。
     *   `resourceGain` 修正会自动应用，所以那条武器优势不需要额外代码。
     *
     * ⚠️ **数值是占位值。** 规格书没有给每次挥击的怒气量。
     *   `COMBAT_SWING.RAGE_PER_SWING` 旁边写明了这一点 ——
     *   ★ 这次把「这是占位值」写在数据旁边，因为上一次没写，
     *     结果 19 处伤害数字的由来在代码里完全找不到（PROGRESS 技术债 §2）。
     */
    if (attacker.maxResources.has(Resource.Rage)) {
      effects.push({
        kind: 'gainResource', resource: Resource.Rage,
        amount: COMBAT_SWING.RAGE_PER_SWING,
      });
    }

    out.push({
      attackerId: attacker.id, targetId: target!.id, effects,
      ...(pointBlank ? { pointBlank: true } : {}),
    });
  }

  return out;
};
