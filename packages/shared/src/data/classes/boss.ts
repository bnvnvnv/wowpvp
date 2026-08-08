/**
 * 熔岩魔王 —— 地图里随机刷新的中立大 BOSS（玩家需求：「打死掉装备；很强、
 * 不容易打死、且很容易几下秒杀玩家」）。规则在 `sim/boss.ts`，本文件只有数据。
 *
 * ★★ **它是一个 `ClassDef`，但不是一个可选职业。**
 *
 *   走 ClassDef 这条路是为了「不开新通道」：BOSS 因此是一个普通
 *   `CombatEntity`，天然获得移动积分、施法两个出口、光环、普攻、可见性裁剪、
 *   快照下发、死亡漏斗 —— 一行都不用为它重写。代价只有一处：必须让它
 *   **进得了注册表却进不了选人界面**，见 `data/index.ts` 的 `SPECIAL_CLASSES`
 *   与 `isPlayableClass()`（`selectClass` 用它把「选 BOSS 出场」挡在门外）。
 *
 * ★ 它**不在** `ALL_CLASSES` / `ALL_SKILLS` / `ALL_WEAPONS` 里：那三张表是
 *   「玩家能用的东西」的清单，客户端的图标表、技能签名、配平报告全都按它们
 *   穷尽校验。把 BOSS 塞进去等于要求给它配技能图标与八属性签名，
 *   而它一次都不会出现在技能栏上。
 *
 * ── 数值（⚠️ 全部是**占位值**，未经配平实测）───────────────────────
 *
 *   | 项 | 值 | 取值理由 |
 *   |---|---|---|
 *   | 生命 | 15000 | 玩家 900–1200，即「一个人打不动、一群人打得动」的量级 |
 *   | 白字 | 1.8×100 = 180/击，2.6 秒一击 | 站着挨打约 70 DPS，够疼但不是秒杀 |
 *   | 巨力挥击 | 470 | 玩家血量的 40–50%：**两三下致死**，正是需求原话 |
 *   | 践踏 | 300 + 击退 6 米 | 半血级 AOE，配 1.2 秒抬腿给出「跑出去」的窗口 |
 *   | 狂暴 | 30% 血以下，伤害 +40%、攻速 +25% | 拖久了会翻车，逼出「集火收尾」 |
 *
 *   两个技能都是**读条**而不是瞬发，这是有意的：需求要「几下秒杀」，
 *   但秒杀必须**看得见**才是玩法而不是猝死 —— 1.8 秒挥击可被打断，
 *   1.2 秒践踏不可打断但能跑出圈。反制方式逐条写在 `counters` 里。
 */

import {
  ArmorArchetype,
  CastKind,
  DispelType,
  School,
  TargetFilter,
  Targeting,
} from '../../types/enums.js';
import { asArmorId, asClassId, asSkillId, asWeaponId } from '../../types/ids.js';
import type { ArmorDef, AuraDef, ClassDef, SkillDef, WeaponDef } from '../schema.js';

export const BOSS_CLASS_ID = asClassId('boss');

// ── 技能 ─────────────────────────────────────────────────────────

const skills: SkillDef[] = [
  {
    id: asSkillId('boss.crush'),
    name: '巨力挥击',
    classId: BOSS_CLASS_ID,
    targeting: Targeting.Direct,
    targetFilter: TargetFilter.Enemy,
    // ★ 比武器触及远一点：抡起来的锤头比站位更靠前，也让「贴脸就安全」不成立
    range: { min: 0, max: 6 },
    shape: { kind: 'single' },
    /**
     * ★★ 1.8 秒**可打断**读条 —— BOSS 的致命一击必须是**看得见的**。
     *   瞬发 470 点伤害只会读成「我莫名其妙死了」；读条则同时给出三条出路：
     *   打断、拉开 6 米、交减伤。这是「很容易几下秒杀玩家」与「不是猝死」
     *   能同时成立的唯一写法。
     */
    cast: { kind: CastKind.Cast, time: 1.8, movable: false, interruptible: true },
    school: School.Physical,
    cooldown: 6,
    triggersGcd: true,
    requiresFacing: true,
    requiresLos: true,
    counters:
      '1.8 秒读条且**可被专用打断**（脚踢/拳击/法术反制都吃得住）；读条中 BOSS 无法移动，拉开 6 米即落空；伤害是物理，减伤护甲、格挡与吸收护盾全部照常生效。',
    effects: [{ kind: 'damage', school: School.Physical, amount: { flat: 470 } }],
    description: '抡起熔岩巨锤砸向目标，造成 470 点物理伤害。读条 1.8 秒，可被打断。',
  },
  {
    id: asSkillId('boss.stomp'),
    name: '践踏',
    classId: BOSS_CLASS_ID,
    targeting: Targeting.SelfCenter,
    targetFilter: TargetFilter.Enemy,
    range: { min: 0, max: 9 },
    shape: { kind: 'circle', radius: 9, maxTargets: 12 },
    /**
     * ★ 不可打断，但有 1.2 秒抬腿。与巨力挥击刻意做成**两种**反制：
     *   一个用打断解，一个用脚解 —— 全场只有一种解法的 BOSS 只会训练出
     *   一种站位。
     */
    cast: { kind: CastKind.Cast, time: 1.2, movable: false, interruptible: false },
    school: School.Physical,
    cooldown: 14,
    triggersGcd: true,
    counters:
      '抬腿 1.2 秒且范围就是脚下 9 米的圆 —— 跑出去就完全躲开；击退距离受抗击退护甲与「自由祝福」削减；不可打断是它与巨力挥击的分工，别把打断留给它。',
    effects: [
      { kind: 'damage', school: School.Physical, amount: { flat: 300 } },
      { kind: 'knockback', distance: 6 },
    ],
    description: '重踏地面，对周围 9 米内的敌人造成 300 点物理伤害并击退 6 米。',
  },
];

// ── 狂暴（不是技能，是 sim 规则）─────────────────────────────────

/**
 * 30% 血以下的硬狂暴。
 *
 * ★★ **刻意不做成技能。** 做成技能就要指望 `decideBotAction()` 去按它 ——
 *   而那个决策层只会按「有伤害的」和「保命的」，纯自增益技能它一次都不会用。
 *   那样这条数据会是又一个「写对了没人调用」的死条目（本仓库的老教训）。
 *   现在由 `sim/boss.ts` 在每 tick 按血线**确定性**施加：一定会发生，
 *   而且时机可预测（玩家能学会「压到三成要准备收尾」）。
 *
 * ★ `persistent`：狂暴到死为止，`duration` 只作 HUD 兜底显示。
 */
export const BOSS_ENRAGE_AURA: AuraDef = {
  id: 'boss.enrage',
  name: '狂暴',
  kind: 'buff',
  duration: 600,
  persistent: true,
  dispelType: DispelType.None,
  clearableByTrinket: false,
  school: School.Fire,
  modifiers: { damageDealt: 1.4, attackSpeed: 0.75 },
  description: '生命低于 30% 后暴怒：造成的伤害提高 40%，攻击速度提高 25%。',
};

// ── 武器与护甲 ───────────────────────────────────────────────────

/**
 * ★ 只有一套，且 `isDefault` —— 10.6 的「默认装备不可删除、永不掉落」在这里
 *   顺带保证了「BOSS 的锤子不会掉给玩家」：`spawnDropsFromRoster()` 只挑
 *   `!isDefault` 的备用武器，而 BOSS 一件备用都没有。
 * ★ `reach` 5 米（人形近战 2.8–3.8）：**大体型的表达落在武器触及距离上，
 *   不落在碰撞体上** —— 碰撞体按 13.2 全场统一（见 `createEntity`），
 *   放大它会连带改变软推开、视线与投射物判定。视觉体型放大在客户端。
 */
const weapons: WeaponDef[] = [
  {
    id: asWeaponId('boss.molten_maul'),
    name: '熔岩巨锤',
    classId: BOSS_CLASS_ID,
    isDefault: true,
    handedness: 'twoHand',
    swingInterval: 2.6,
    swingPercent: 1.8,
    reach: 5,
    advantage: '触及距离 5 米，单击极重',
    cost: '攻速极慢，抡空一次就是一个身位的窗口',
  },
];

const armors: ArmorDef[] = [
  {
    id: asArmorId('boss.molten_hide'),
    name: '熔岩硬壳',
    classId: BOSS_CLASS_ID,
    isDefault: true,
    archetype: ArmorArchetype.Guardian,
    /**
     * ⚠️ 占位值：物理减伤 25%。BOSS 的「肉」主要来自 15000 生命而不是减伤 ——
     * 减伤堆高会让治疗职业的贡献被抹平（打不动就是打不动），而血条厚只是慢。
     */
    modifiers: { damageTaken: 0.75 },
    advantage: '皮糙肉厚，承受的伤害降低 25%',
    cost: '笨重，无法躲闪',
  },
];

export const boss: ClassDef = {
  id: BOSS_CLASS_ID,
  name: '熔岩魔王',
  role: '中立世界 BOSS：所有人的敌人，掉落临时武装',
  /** ⚠️ 占位值。见文件头数值表 */
  baseHealth: 15000,
  /** ★ 没有资源池：它的技能不花费任何资源，只受冷却限制 */
  resources: [],
  strengths: '血量极厚、单发伤害致命、范围击退',
  weaknesses: '动作全部带读条、转身慢、没有任何位移与解控手段',
  defaultWeaponId: asWeaponId('boss.molten_maul'),
  defaultArmorId: asArmorId('boss.molten_hide'),
  skills,
  weapons,
  armors,
  autoAttack: { ranged: false, school: School.Physical },
};
