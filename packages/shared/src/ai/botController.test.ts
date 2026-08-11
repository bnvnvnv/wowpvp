/**
 * P1a：AI 决策层 —— 打断、难度分档、按威力出招。
 *
 * ★ 夹具手法：感知是**白盒**喂的（CastState 直接塞进 CastingStore、血量直接
 *   写字段），断言落在**决策产出**上（返回的 MovementInput/CastIntent）——
 *   决策层是纯函数，这正是它可测性的全部意义。
 * ★ 这些测试同时是 `pnpm balance` 之外的第二张回归网：balance 只看结果胜率，
 *   这里钉「为什么会赢」的具体行为（会打断、按威力选招）。
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CLASSES, druid, getWeapon, hunter, mage, priest, rogue, warrior,
} from '../data/index.js';
import { PARTY_SKILLS } from '../data/party.js';
import type { AuraDef, SkillDef } from '../data/schema.js';
import { CastKind, DispelType, DrCategory, School, TargetFilter } from '../types/enums.js';
import { asSkillId, asWeaponId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { createEntity, type CombatEntity } from '../sim/entity.js';
import type { CastState, CastingStore } from '../sim/casting.js';
import type { GroundArea } from '../sim/groundArea.js';
import type { AuraInstance, AuraStore } from '../sim/aura.js';
import { applyDr, createDrStore } from '../sim/dr.js';
import { TRINKET_COOLDOWN_KEY } from '../sim/tick.js';
import { addEntity, allocEntityId, createWorld } from '../sim/world.js';
import {
  burstDamageOf,
  ccCategoryOf,
  decideBotAction,
  hasDamage,
  healTargets,
  isEscapeSkill,
  isGapCloserSkill,
  isHealSkill,
  isInterruptSkill,
  isSelfDefenseSkill,
  isSpeedBurstSkill,
  toLocalMove,
  type BotPerception,
} from './botController.js';

/** 固定序列 rng —— 决策层要求注入随机源，测试给一条可控的 */
const seqRng = (values: number[] = [0.5]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

const setup = (foeDistance = 20) => {
  const world = createWorld();
  const self = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(0, 0, 0)));
  const foe = addEntity(
    world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, foeDistance)),
  );
  for (const e of [self, foe]) {
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
  }
  const casting: CastingStore = new Map();
  return { world, self, foe, casting };
};

/** 一条正在读的（默认可打断的）合成施法状态 */
const castOf = (over: Partial<CastState> = {}): CastState => ({
  skillId: asSkillId('warrior.mortal_strike'),
  kind: CastKind.Cast,
  startedAt: 0,
  endsAt: 1.5,
  facing: 0,
  startPosition: vec3(0, 0, 20),
  school: School.Physical,
  interruptible: true,
  requiresStationary: true,
  ...over,
});

const perceive = (
  s: ReturnType<typeof setup>,
  over: Partial<BotPerception> = {},
): BotPerception => ({
  world: s.world, casting: s.casting, self: s.self, foe: s.foe, rng: seqRng(), ...over,
});

const COUNTERSPELL = asSkillId('mage.counterspell');

describe('P1a 打断：看到读条就踢（难度决定会不会/多快）', () => {
  it('★★ normal：敌人读了 0.5 秒可打断法术 → 打出断法', () => {
    const s = setup(20); // 断法 30m 射程内
    s.casting.set(s.foe.id, castOf());
    s.world.time = 0.5; // 读条已进行 0.5s ≥ normal 反应 0.35s

    const a = decideBotAction(perceive(s, { difficulty: 'normal' }));
    expect(a.cast?.skillId).toBe(COUNTERSPELL);
  });

  it('★★ easy：同样的局面永不打断（新手对手不会留打断）', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf());
    s.world.time = 1.0; // 反应时间再充裕也不踢

    const a = decideBotAction(perceive(s, { difficulty: 'easy' }));
    expect(a.cast?.skillId).not.toBe(COUNTERSPELL);
  });

  it('★ 反应时间：读条刚 0.2s，normal 反应不过来、hard 踢得出', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf());
    s.world.time = 0.2;

    expect(decideBotAction(perceive(s, { difficulty: 'normal' })).cast?.skillId)
      .not.toBe(COUNTERSPELL);
    expect(decideBotAction(perceive(s, { difficulty: 'hard' })).cast?.skillId)
      .toBe(COUNTERSPELL);
  });

  it('★★ 假读条的博弈成立：短晃一下（<0.35s 就停）骗不出 normal 的打断', () => {
    const s = setup(20);
    // 敌人 0.3s 前起手 —— normal 档还在「反应」中，此刻不踢；
    // 真人假读条正是靠这个窗口把读条取消掉，打断就没被骗出来
    s.casting.set(s.foe.id, castOf());
    s.world.time = 0.3;
    const a = decideBotAction(perceive(s, { difficulty: 'normal' }));
    expect(a.cast?.skillId).not.toBe(COUNTERSPELL);
  });

  it('★ 不可打断（盾牌标记）的读条不踢 —— 踢了也是白进冷却', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf({ interruptible: false }));
    s.world.time = 1.0;

    const a = decideBotAction(perceive(s, { difficulty: 'hard' }));
    expect(a.cast?.skillId).not.toBe(COUNTERSPELL);
  });

  it('★ 快读完的条不追踢（余量 <0.1s 踢不中）', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf({ endsAt: 1.5 }));
    s.world.time = 1.45; // 只剩 0.05s

    const a = decideBotAction(perceive(s, { difficulty: 'hard' }));
    expect(a.cast?.skillId).not.toBe(COUNTERSPELL);
  });
});

describe('P1a 出招：normal/hard 按单发威力，easy 保持随机', () => {
  it('★★ normal 出招是**确定性**的最大威力技能（同局面 20 次同一张牌）', () => {
    const s = setup(20);
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = decideBotAction(perceive(s, { difficulty: 'normal', rng: seqRng([i / 20]) }));
      if (a.cast) picks.add(a.cast.skillId as string);
    }
    expect(picks.size, `normal 档还在随机出招：${[...picks].join(',')}`).toBe(1);

    // 而且选的确实是可用伤害技能里 burstDamageOf 最大的那个
    const picked = [...picks][0]!;
    const damaging = mage.skills.filter(
      (sk) => sk.targeting !== 'ground' && !isHealSkill(sk) && hasDamage(sk)
        && sk.range.max >= 20,
    );
    const best = damaging.reduce((a, b) =>
      burstDamageOf(a, s.self) >= burstDamageOf(b, s.self) ? a : b);
    expect(picked).toBe(best.id as string);
  });

  it('★ easy 保持均匀随机（多次调用出现 ≥2 种不同技能）', () => {
    const s = setup(20);
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const a = decideBotAction(perceive(s, { difficulty: 'easy', rng: seqRng([i / 40]) }));
      if (a.cast) picks.add(a.cast.skillId as string);
    }
    expect(picks.size).toBeGreaterThanOrEqual(2);
  });

  it('★ 不传难度 = normal（balance 与既有调用方的默认口径）', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf());
    s.world.time = 0.5;
    expect(decideBotAction(perceive(s)).cast?.skillId).toBe(COUNTERSPELL);
  });
});

describe('P1b 方向转换（最容易搞反的一环）', () => {
  // yaw=0 时 forward = yawToDir(0) = (0,0,-1)，即 -Z 是「前」
  it('★★ 朝向正前方 → forward=1', () => {
    const m = toLocalMove({ x: 0, z: -1 }, 0);
    expect(m.forward).toBeCloseTo(1, 6);
    expect(m.strafe).toBeCloseTo(0, 6);
  });

  it('★★ 朝向正后方 → forward=-1（后退，吃 65% 惩罚是移动系统的事）', () => {
    const m = toLocalMove({ x: 0, z: 1 }, 0);
    expect(m.forward).toBeCloseTo(-1, 6);
  });

  it('★ 正右方 → strafe=+1（与 movement.ts 的 right=(-f.z,0,f.x) 同约定）', () => {
    const m = toLocalMove({ x: 1, z: 0 }, 0);
    expect(m.strafe).toBeCloseTo(1, 6);
    expect(m.forward).toBeCloseTo(0, 6);
  });

  it('★ 转身后仍然正确（yaw=π 时 +Z 变成「前」）', () => {
    const m = toLocalMove({ x: 0, z: 1 }, Math.PI);
    expect(m.forward).toBeCloseTo(1, 6);
  });

  it('★ 零向量不产生 NaN（原地不动）', () => {
    expect(toLocalMove({ x: 0, z: 0 }, 1.2)).toEqual({ forward: 0, strafe: 0 });
  });
});

describe('P1b 躲圈：站在敌方伤害区域里就往外走', () => {
  /** 造一片敌人放的伤害地面区域，圆心压在 self 脚下偏移处 */
  const dangerArea = (
    s: ReturnType<typeof setup>, center: ReturnType<typeof vec3>, radius = 6,
  ): GroundArea => ({
    id: 1, areaId: 'x', skillId: 'x', sourceId: s.foe.id,
    center, radius, createdAt: 0, expiresAt: 99, tickInterval: 0.5, nextTickAt: 0,
    onTick: [{ kind: 'damage', school: School.Fire, amount: { flat: 30 } }],
    blocksTargetingFromOutside: false, revealsStealth: false,
  });

  it('★★ 站在圈里 → 沿「圆心指向自己」的方向出圈', () => {
    const s = setup(20);
    // 圆心在自己身后（+Z 侧 3 米），自己应当往 -Z（前方，即朝敌人）跑出去
    const ground = { areas: [dangerArea(s, vec3(0, 0, 3))], traps: [] };
    const a = decideBotAction(perceive(s, { difficulty: 'normal', ground }));
    // 逃离方向 = 自己 - 圆心 = -Z；yaw 朝敌人（+Z 方向的敌人 → yaw=π）
    // 于是「-Z」在本地坐标里是**后退**
    expect(a.move.forward).toBeLessThan(-0.9);
  });

  it('★★ 圈在正前方（敌人脚下）→ 往后退出圈，而不是继续冲进去', () => {
    const s = setup(6);
    const ground = { areas: [dangerArea(s, vec3(0, 0, 6), 8)], traps: [] };
    const a = decideBotAction(perceive(s, { difficulty: 'normal', ground }));
    expect(a.move.forward).toBeLessThan(0);
  });

  it('★ 圈外不动摇站位（只处理「已经站进去了」，绕开是路径规划）', () => {
    const s = setup(20);
    const ground = { areas: [dangerArea(s, vec3(50, 0, 50), 3)], traps: [] };
    const a = decideBotAction(perceive(s, { difficulty: 'normal', ground }));
    // 「没有在逃」= forward 非负（逃离这些用例的圈都会产生负 forward）。
    // ⚠️ 不写死 1：20 米对法师（站位 32m）已在射程内，站位本来就是 0
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  it('★★ 队友/自己放的区域不躲（旋刃斩不该把自己吓跑）', () => {
    const s = setup(20);
    const mine = { ...dangerArea(s, vec3(0, 0, 3)), sourceId: s.self.id };
    const a = decideBotAction(perceive(s, { difficulty: 'normal', ground: { areas: [mine], traps: [] } }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  it('★★ 没伤害的区域不躲（烟雾弹/照明弹不该把人赶跑）', () => {
    const s = setup(20);
    const smoke = { ...dangerArea(s, vec3(0, 0, 3)), onTick: [] };
    const a = decideBotAction(perceive(s, { difficulty: 'normal', ground: { areas: [smoke], traps: [] } }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  it('★ easy 档不躲圈（木桩手感，与它不打断同源）', () => {
    const s = setup(20);
    const ground = { areas: [dangerArea(s, vec3(0, 0, 3))], traps: [] };
    const a = decideBotAction(perceive(s, { difficulty: 'easy', ground }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  it('★★ 待落的陨星（delayedImpact）同样躲；已经砸完的不躲', () => {
    const s = setup(20);
    const impact = {
      kind: 'delayedImpact' as const, id: 1, skillId: asSkillId('mage.meteor'),
      sourceId: s.foe.id, center: vec3(0, 0, 3), radius: 6,
      createdAt: 0, impactAt: 2, targetFilter: TargetFilter.Enemy, onImpact: [],
    };
    s.world.time = 1; // 还没落
    expect(decideBotAction(perceive(s, {
      difficulty: 'normal', projectiles: { items: [impact], nextId: 2 },
    })).move.forward).toBeLessThan(-0.9);

    s.world.time = 3; // 已经砸完 —— 没有威胁了
    expect(decideBotAction(perceive(s, {
      difficulty: 'normal', projectiles: { items: [impact], nextId: 2 },
    })).move.forward).toBeGreaterThanOrEqual(0);
  });
});

/**
 * ⚠️ **「远程被贴脸就后退」（风筝）实现过、实测后回滚。** 详见
 * `botController.ts` 走位段的注释：基线 52.4→85.7pp，法师/牧师反而暴跌，
 * 分离验证证明元凶是风筝。根因是规则的乘积（后退 65% 追不掉 + 移动打断读条），
 * 不是实现 bug。这条测试把结论钉住 —— 免得下一个人「顺手把风筝加回来」。
 */
describe('P1b 风筝：**刻意不做**（规则不支持纯后退）', () => {
  it('★★ 远程被贴脸也不后退 —— 后退 65% 追不掉，且全程读不完条', () => {
    const s = setup(3); // 法师被贴到 3 米
    const a = decideBotAction(perceive(s, { difficulty: 'normal' }));
    expect(a.move.forward, '加回了纯后退风筝 —— 先看那段注释里的基线数据')
      .toBeGreaterThanOrEqual(0);
  });

  it('★ 近战贴脸照常进场（贴身就是他们的活）', () => {
    const world = createWorld();
    const self = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)));
    const foe = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_BLUE, vec3(0, 0, 2)));
    for (const e of [self, foe]) for (const [r, max] of e.maxResources) e.resources.set(r, max);
    const a = decideBotAction({
      world, casting: new Map(), self, foe, rng: seqRng(), difficulty: 'normal',
    });
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });
});

// ── P4：四类死键接通 ─────────────────────────────────────────────

/** 任意职业对任意职业的通用夹具（P4 的场景常常不是法师打战士）*/
const duel = (
  selfClass: typeof mage, foeClass: typeof mage, foeDistance: number,
): { world: ReturnType<typeof createWorld>; self: CombatEntity; foe: CombatEntity;
     casting: CastingStore } => {
  const world = createWorld();
  const self = addEntity(world, createEntity(allocEntityId(world), selfClass, TEAM_RED, vec3(0, 0, 0)));
  const foe = addEntity(
    world, createEntity(allocEntityId(world), foeClass, TEAM_BLUE, vec3(0, 0, foeDistance)),
  );
  for (const e of [self, foe]) {
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
  }
  return { world, self, foe, casting: new Map() };
};

/** 手搓一条挂在 targetId 身上的光环实例（决策层只读 def 与归属）*/
const auraOn = (targetId: CombatEntity['id'], def: Partial<AuraDef>): AuraInstance => ({
  def: {
    id: 'test.aura', name: '测试', kind: 'buff', duration: 10,
    dispelType: DispelType.None, ...def,
  } as AuraDef,
  sourceId: targetId, targetId,
  appliedAt: 0, expiresAt: 99, stacks: 1,
  absorbRemaining: 0, absorbInitial: 0, damageAccumulated: 0,
  nextTickAt: 0, actualDuration: 10,
});

const storeWith = (...auras: AuraInstance[]): AuraStore => {
  const m: AuraStore = new Map();
  for (const a of auras) {
    const list = m.get(a.targetId) ?? [];
    list.push(a);
    m.set(a.targetId, list);
  }
  return m;
};

describe('P4 保命：血线告急开保命键', () => {
  it('★★ 法师 30% 血 → 开出一个自我防御键（冰封庇护/寒冰护体一族）', () => {
    const s = duel(mage, warrior, 20);
    s.self.health = s.self.maxHealth * 0.3;
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras: new Map() }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked && isSelfDefenseSkill(picked), `实际选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★★ 身上已有保命增益 → 不叠盾（否则会把全部保命键一秒倒光）', () => {
    const s = duel(mage, warrior, 20);
    s.self.health = s.self.maxHealth * 0.3;
    const auras = storeWith(auraOn(s.self.id, {
      id: 'mage.ice_barrier', modifiers: {}, absorb: 150,
    }));
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || !isSelfDefenseSkill(picked)).toBe(true);
  });

  it('★ easy 不开保命（新手对手挨打站桩，与不打断同源）', () => {
    const s = duel(mage, warrior, 20);
    s.self.health = s.self.maxHealth * 0.3;
    const a = decideBotAction(perceive(s, { difficulty: 'easy', auras: new Map() }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || !isSelfDefenseSkill(picked)).toBe(true);
  });

  it('★ 血量健康时不开保命（保命键冷却长，交早了真要命时空窗）', () => {
    const s = duel(mage, warrior, 20);
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras: new Map() }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || !isSelfDefenseSkill(picked)).toBe(true);
  });
});

describe('P4 控制：会用控制，且带递减/免疫判断', () => {
  it('★★ 击杀窗口（对手 30% 血）→ 出控制锁杀', () => {
    const s = duel(mage, warrior, 20);
    s.foe.health = s.foe.maxHealth * 0.3;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked && ccCategoryOf(picked) !== undefined, `实际选了 ${a.cast?.skillId}`).toBe(true);
  });

  it('★★ 该类别递减到 25% → 不出这手控制（半衰以下不值一个公共冷却）', () => {
    const s = duel(mage, warrior, 20);
    s.foe.health = s.foe.maxHealth * 0.3;
    const dr = createDrStore();
    // 把法师控制会用到的两条链都打进半衰以下（变形术走 Incapacitate，新星走 Root）
    for (const cat of [DrCategory.Incapacitate, DrCategory.Root]) {
      applyDr(dr, s.foe.id, cat, 4, 0);
      applyDr(dr, s.foe.id, cat, 4, 0);
    }
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras: new Map(), dr }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || ccCategoryOf(picked) === undefined,
      `递减 25% 还在出控制：${a.cast?.skillId}`).toBe(true);
  });

  it('★★ 对手已被硬控 → 不控上叠控（浪费自己的递减预算）', () => {
    const s = duel(mage, mage, 20); // 对手法师（远程武器）→ 不触发风筝，纯看出招
    s.foe.health = s.foe.maxHealth * 0.3;
    s.foe.flags.stunned = true;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || ccCategoryOf(picked) === undefined).toBe(true);
  });

  it('★★ 对手开着完全免疫 → 控制绝不空放（8.4）', () => {
    const s = duel(mage, warrior, 20);
    s.foe.health = s.foe.maxHealth * 0.3;
    s.foe.flags.immuneAll = true;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked === undefined || ccCategoryOf(picked) === undefined).toBe(true);
  });

  it('★ 牧师的「沉默」是打断混合体 —— 不当普通控制在击杀窗口花掉（踢留给读条）', () => {
    const s = duel(priest, warrior, 20);
    s.foe.health = s.foe.maxHealth * 0.3; // kill window，但对面没在读条
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.cast?.skillId).not.toBe(asSkillId('priest.silence'));
  });
});

describe('W23b 反向测试：迟到的控制仍会出手（飞行时间门实测恶化后回滚）', () => {
  /**
   * ★★ 这是一条**反向测试**（P1b 风筝同款）：钉住的是「不拦」这个结论。
   *
   * W23 归因时校验者指认：变形术 25m 要飞 0.45s，替补打断判据只看
   * `remaining > 0.1`，余量不够时 CC 落地条已读完 →「白丢 GCD 白吃 DR」。
   * 按此实现了飞行时间门（remaining > flight + 0.1 才出手），实测（种子 1）：
   * **法师 16.7→9.5pp、极差 78.6→83.3，死骑（原嫌疑对象）分毫未动** ——
   * 假设错在「迟到的控制不是白丢」：晚半秒落地的变形照样吃满持续时间，
   * 拦掉它 bot 只会改放伤害填充，净减控制覆盖率。已回滚。
   * 想重新拦：先给这条测试一个更好的变红理由（比如 bot 学会了把省下的
   * GCD 花在更值的地方），并重新归因。
   */
  it('★★ 余量 0.4s < 变形术飞行 0.45s —— 迟到的变形术照样出手（拦过、恶化、回滚）', () => {
    const s = duel(mage, warrior, 25);
    s.self.cooldowns.set(COUNTERSPELL, 999); // 踢在冷却 → 走替补打断路
    s.casting.set(s.foe.id, castOf({ endsAt: 1.0 }));
    s.world.time = 0.6; // remaining = 0.4
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked && ccCategoryOf(picked) !== undefined, `实际选了 ${a.cast?.skillId}`).toBe(true);
  });
});

describe('P4 驱散：按下去能清掉东西才按', () => {
  it('★★ 自己身上有可驱散的魔法减益 → 对自己净化', () => {
    const s = duel(priest, warrior, 20);
    const auras = storeWith(auraOn(s.self.id, {
      kind: 'debuff', dispelType: DispelType.Magic,
    }));
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras, dr: createDrStore() }));
    expect(a.cast?.skillId).toBe(asSkillId('priest.dispel_magic'));
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★★ 对手身上有可偷的魔法增益 → 偷掉它', () => {
    const s = duel(priest, warrior, 20);
    const auras = storeWith(auraOn(s.foe.id, {
      kind: 'buff', dispelType: DispelType.Magic,
    }));
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras, dr: createDrStore() }));
    expect(a.cast?.skillId).toBe(asSkillId('priest.dispel_magic'));
    expect(a.cast?.targetId).toBe(s.foe.id);
  });

  it('★★ 没有可清目标 → 绝不按（不可驱散的减益不算目标）', () => {
    const s = duel(priest, warrior, 20);
    const auras = storeWith(auraOn(s.self.id, {
      kind: 'debuff', dispelType: DispelType.None, // 流血一类，净化不掉
    }));
    const a = decideBotAction(perceive(s, { difficulty: 'normal', auras, dr: createDrStore() }));
    expect(a.cast?.skillId).not.toBe(asSkillId('priest.dispel_magic'));
  });
});

describe('P4 位移：远程拉开、近战贴上（贴不上就加速追）', () => {
  it('★★ 猎人被贴脸 → 后撤跃', () => {
    const s = duel(hunter, warrior, 3);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.cast?.skillId).toBe(asSkillId('hunter.disengage'));
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★★ 战士够不着 → 冲锋贴上去', () => {
    const s = duel(warrior, mage, 15);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.cast?.skillId).toBe(asSkillId('warrior.charge'));
  });

  it('★★ 先控再退：近战对手被定身且贴身 → 后退拉开（安全风筝）', () => {
    const s = duel(mage, warrior, 3);
    s.foe.flags.rooted = true;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeLessThan(0);
  });

  it('★★ 对手**没**被控住 → 绝不后退（P1b 回滚的 85.7pp 惨案钉在这）', () => {
    const s = duel(mage, warrior, 3);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward, '纯后退风筝又回来了 —— 先看走位段注释里的基线数据')
      .toBeGreaterThanOrEqual(0);
  });

  it('★ 对手拿远程武器 → 被控了也不退（对远程退换不来安全，只废自己读条）', () => {
    const s = duel(mage, hunter, 8);
    s.foe.flags.rooted = true;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  it('★ 拉够 12 米就停（不是退满 standOff —— 分步归因抓过「用走路换输出」）', () => {
    const s = duel(mage, warrior, 13);
    s.foe.flags.rooted = true;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
  });

  // ── 近战追击两级：gap closer → 加速（E：让加速类技能对近战不再是死键）──

  /**
   * ★ 不依赖新数据的那一条：战士**没有**加速键，冲锋是他追人的唯一手段。
   *   它守的是「加了第二级之后第一级没被挤掉」——「有突进时不选加速」的
   *   完整优先级由下面盗贼那条钉（盗贼两样都有）。
   */
  it('★★ 战士 15m 外冲锋可用 → 仍然出冲锋（近战第一级没被新分支挤掉）', () => {
    const s = duel(warrior, mage, 15);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = warrior.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked !== undefined && isGapCloserSkill(picked),
      `实际选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.targetId).toBe(s.foe.id);
  });

  /**
   * 盗贼是全花名册**唯一**同时握着突进（影袭步 18m/CD20）与加速（疾跑
   * moveSpeed 1.7/8s/CD120，对齐 WoW 疾跑口径）的近战 —— 两级次序只有拿他才测得全。
   * ★ 疾跑由另一条并行任务加进 rogue.ts；这里先把夹具前提钉住，数据要是
   *   被回滚，红的是这条前提而不是下面两条行为断言（失败时好归因）。
   */
  const ROGUE_DASH = rogue.skills.find(isSpeedBurstSkill);

  it('★ 夹具前提：盗贼有加速键（疾跑）与突进键（影袭步）', () => {
    expect(ROGUE_DASH, '盗贼没有加速键 —— rogue.sprint 被回滚了？').toBeDefined();
    expect(rogue.skills.some(isGapCloserSkill), '影袭步').toBe(true);
  });

  it('★★ 盗贼 15m 外两样都可用 → 出影袭步，不开疾跑（瞬间到位 > 跑过去）', () => {
    const s = duel(rogue, mage, 15);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = rogue.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked !== undefined && isGapCloserSkill(picked),
      `次序反了：有影袭步却选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.skillId).not.toBe(ROGUE_DASH?.id);
  });

  it('★★ 盗贼 15m 外、影袭步进冷却 → 开疾跑追（近战加速此前是死键）', () => {
    const s = duel(rogue, mage, 15);
    // 把全部突进键塞冷却（影袭步 CD20）—— 逼出第二级；用冷却而不是清能量，
    // 免得顺带把别的键也废掉（同 B2 夹具的理由）
    for (const sk of rogue.skills.filter(isGapCloserSkill)) s.self.cooldowns.set(sk.id, 999);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.cast?.skillId, `突进全在冷却里却选了 ${a.cast?.skillId}`).toBe(ROGUE_DASH?.id);
    // ★ 加速是自身增益 —— 目标必须是自己（冲锋才指对手）
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★ 近战贴身（d=2）→ 不走位移支，照常输出（追击只在 d > GAP_CLOSE_MIN_D 触发）', () => {
    const s = duel(rogue, mage, 2);
    for (const sk of rogue.skills.filter(isGapCloserSkill)) s.self.cooldowns.set(sk.id, 999);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    const picked = rogue.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked !== undefined && isSpeedBurstSkill(picked),
      `贴脸还开加速 —— 追击分支的距离门破了（实际选了 ${a.cast?.skillId}）`).toBe(false);
    expect(picked !== undefined && isGapCloserSkill(picked)).toBe(false);
    /**
     * 落到常规出招步骤 → 目标是**对手**（位移两支一个指自己[加速]、一个指
     * 对手[冲锋]，所以只看 targetId 不够，上面两条分类器断言才是主判据）。
     * ⚠️ 这里刻意**不**断言「选中的技能有伤害」：开局无连击点、不在背后的
     *   盗贼此刻实际选的是隐匿（能量满，但剜刺/割裂要连击点、背袭要绕后，
     *   validateCast 全判掉）—— 那是盗贼技能组的资源前提，不是追击分支的事。
     */
    expect(a.cast?.targetId).toBe(s.foe.id);
  });
});

describe('P4 分类器：形态切换与交易型保命的排除', () => {
  it('★★ 迅猫/巨熊形态既不算加速键也不算保命键（变身会封死施法套件）', () => {
    const catForm = druid.skills.find((sk) => (sk.id as string) === 'druid.cat_form')!;
    const bearForm = druid.skills.find((sk) => (sk.id as string) === 'druid.bear_form')!;
    expect(isSpeedBurstSkill(catForm)).toBe(false);
    expect(isSelfDefenseSkill(bearForm)).toBe(false);
  });

  it('★ 龟甲护体不算常规保命（cannotAttack 交易键，只在对面读条时特批）', () => {
    const turtle = hunter.skills.find((sk) => (sk.id as string) === 'hunter.turtle_guard'
      || sk.effects.some((e) => e.kind === 'applyAura' && e.aura.flags?.cannotAttack === true))!;
    expect(isSelfDefenseSkill(turtle)).toBe(false);
  });

  it('★ 分类器认得出各族代表', () => {
    expect(hunter.skills.some(isEscapeSkill), '后撤跃').toBe(true);
    expect(warrior.skills.some(isGapCloserSkill), '冲锋').toBe(true);
    expect(hunter.skills.some(isSpeedBurstSkill), '猎豹守护').toBe(true);
    expect(mage.skills.some(isSelfDefenseSkill), '冰封庇护').toBe(true);
    expect(mage.skills.some((sk) => ccCategoryOf(sk) !== undefined), '变形/新星').toBe(true);
    // 断招踢带 interrupt —— 不算控制（踢要留给打断步骤）
    const kick = warrior.skills.find(isInterruptSkill)!;
    expect(ccCategoryOf(kick)).toBeUndefined();
  });
});

describe('P5 hard 留踢：打断只交给值得的读条', () => {
  const HOLY_LIGHT = asSkillId('priest.holy_light');   // 治疗，1.2s
  const SCORCH = asSkillId('mage.scorch');             // 伤害，0 读条？—— 用合成条控制时长

  it('★★ hard 面对短读条伤害技能不踢（留踢）；normal 照踢', () => {
    // 合成一条 0.8s 的伤害读条（skillId 指向灼烧 —— 非治疗、名义短读条）
    const shortDamage = (s: ReturnType<typeof setup>): void => {
      s.casting.set(s.foe.id, castOf({
        skillId: SCORCH, startedAt: 0, endsAt: 0.8, school: School.Fire,
      }));
      s.world.time = 0.5;
    };
    const s1 = setup(20);
    shortDamage(s1);
    expect(decideBotAction(perceive(s1, { difficulty: 'hard' })).cast?.skillId,
      'hard 把踢交给了 0.8s 的伤害读条').not.toBe(COUNTERSPELL);

    const s2 = setup(20);
    shortDamage(s2);
    expect(decideBotAction(perceive(s2, { difficulty: 'normal' })).cast?.skillId,
      'normal 应保持看条就踢').toBe(COUNTERSPELL);
  });

  it('★★ hard 面对治疗读条必踢 —— 不论读条多短', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf({
      skillId: HOLY_LIGHT, startedAt: 0, endsAt: 0.9, school: School.Holy,
    }));
    s.world.time = 0.5;
    expect(decideBotAction(perceive(s, { difficulty: 'hard' })).cast?.skillId)
      .toBe(COUNTERSPELL);
  });

  it('★ hard 面对长读条伤害技能照踢（1.5s ≥ 门槛）', () => {
    const s = setup(20);
    s.casting.set(s.foe.id, castOf({ skillId: SCORCH, startedAt: 0, endsAt: 1.5 }));
    s.world.time = 0.5;
    expect(decideBotAction(perceive(s, { difficulty: 'hard' })).cast?.skillId)
      .toBe(COUNTERSPELL);
  });
});

describe('P5 战斗意志：被硬控且要命时解控', () => {
  const controlled = (s: ReturnType<typeof setup>): void => {
    s.self.flags.stunned = true;
  };

  it('★★ 被昏迷 + 自身半血 → 交饰品', () => {
    const s = setup(20);
    controlled(s);
    s.self.health = s.self.maxHealth * 0.4;
    const a = decideBotAction(perceive(s, { difficulty: 'normal' }));
    expect(a.trinket).toBe(true);
    expect(a.cast, '昏迷中不该同时出招').toBeUndefined();
  });

  it('★★ 被昏迷 + 对手进击杀窗口 → 交饰品（控住的每秒都在给他喘息）', () => {
    const s = setup(20);
    controlled(s);
    s.foe.health = s.foe.maxHealth * 0.3;
    expect(decideBotAction(perceive(s, { difficulty: 'hard' })).trinket).toBe(true);
  });

  it('★★ 满血互控的开场肾击不交（90 秒的解控不花在不要命的控上）', () => {
    const s = setup(20);
    controlled(s);
    expect(decideBotAction(perceive(s, { difficulty: 'normal' })).trinket).toBeFalsy();
  });

  it('★ 饰品在冷却 → 不交', () => {
    const s = setup(20);
    controlled(s);
    s.self.health = s.self.maxHealth * 0.4;
    s.self.cooldowns.set(TRINKET_COOLDOWN_KEY, 999);
    expect(decideBotAction(perceive(s, { difficulty: 'normal' })).trinket).toBeFalsy();
  });

  it('★ easy 不认识饰品栏（与不打断同源）', () => {
    const s = setup(20);
    controlled(s);
    s.self.health = s.self.maxHealth * 0.4;
    expect(decideBotAction(perceive(s, { difficulty: 'easy' })).trinket).toBeFalsy();
  });

  it('★ 没被控不交（它是解控键不是保命键）', () => {
    const s = setup(20);
    s.self.health = s.self.maxHealth * 0.4;
    expect(decideBotAction(perceive(s, { difficulty: 'normal' })).trinket).toBeFalsy();
  });
});

/**
 * ⚠️ 这一组与上面「P1b 风筝：**刻意不做**」并**不**矛盾，看之前先读
 * `botController.ts` 里 `retreating` 的注释：被打回的是 `forward:-1` 的
 * **倒走**（65% 速度追不掉近战）且无条件触发；这里是**转身满速跑**、hard 专属、
 * 七道门全中才出手的残局动作。两者只在「离对手更远」这一点上像，机制不同。
 */
describe('B2 hard 苟住：弹尽粮绝时转身满速跑', () => {
  /**
   * 残局夹具：自己 25% 血（低于 RETREAT_HEALTH 0.3）、**保命键全部塞进冷却**。
   * ★ 用 `cooldowns.set(id, 999)` 而不是清空蓝条：两者都由 validateCast 一并
   *   判掉（这正是「结合魔法值与冷却」落地的地方），但冷却只影响指定的那几个
   *   技能，不会顺带把别的键也废掉 —— 夹具意图更干净、失败时更好归因。
   * ★ 法师**没有治疗技能**，「没有可用治疗」这道门天然成立（下面有一条测试
   *   把这个前提钉住，将来给法师加了奶就会当场红）。
   */
  const cornered = (
    s: ReturnType<typeof duel>, opts: { keepGuard?: boolean } = {},
  ): void => {
    s.self.health = s.self.maxHealth * 0.25;
    const guards = mage.skills.filter(isSelfDefenseSkill);
    // keepGuard：留下第一张保命牌可用 —— 用来钉「手里还有牌就先开牌，不跑」
    for (const sk of guards.slice(opts.keepGuard === true ? 1 : 0)) {
      s.self.cooldowns.set(sk.id, 999);
    }
  };

  /** 背向对手的 yaw —— 与实现取同一个式子（自己 − 对手），不另抄一份约定 */
  const awayYaw = (s: ReturnType<typeof duel>): number =>
    dirToYaw(sub(s.self.position, s.foe.position));
  /** 面向对手的 yaw（常规站位下的朝向）*/
  const towardYaw = (s: ReturnType<typeof duel>): number =>
    dirToYaw(sub(s.foe.position, s.self.position));

  it('★ 夹具前提：法师没有治疗技能（将来加了奶，这条先红）', () => {
    expect(mage.skills.some(isHealSkill)).toBe(false);
  });

  it('★★ hard + 25% 血 + 保命/治疗全不可用 + 近战对手满血 → 转身背对、满速跑', () => {
    const s = duel(mage, warrior, 20);
    cornered(s);
    const a = decideBotAction(perceive(s, {
      difficulty: 'hard', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.yaw, 'yaw 没转过来 —— 面向对手的后退就是被回滚的那版倒走')
      .toBeCloseTo(awayYaw(s), 6);
    expect(a.move.forward, '逃跑必须是 forward:1 的满速跑，不是 -1 的 65% 倒走')
      .toBe(1);
  });

  it('★★ 同场景 normal 不逃（这笔账要判断力，难度分档调的正是判断力）', () => {
    const s = duel(mage, warrior, 20);
    cornered(s);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
    expect(a.move.yaw).toBeCloseTo(towardYaw(s), 6);
  });

  it('★★ 对手拿远程武器（法师）→ 不逃：转身跑等于送后背，只废掉自己输出', () => {
    const s = duel(mage, mage, 20);
    cornered(s);
    const a = decideBotAction(perceive(s, {
      difficulty: 'hard', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
    expect(a.move.yaw).toBeCloseTo(towardYaw(s), 6);
  });

  it('★★ 对手血比自己更低 → 不逃，拼掉他（互殁竞速里逃跑等于弃权）', () => {
    const s = duel(mage, warrior, 20);
    cornered(s);
    s.foe.health = s.self.health - 1;
    const a = decideBotAction(perceive(s, {
      difficulty: 'hard', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
    expect(a.move.yaw).toBeCloseTo(towardYaw(s), 6);
  });

  it('★★ 还有一张可用保命键 → 不逃，先把牌打出去（决策链上保命步在前）', () => {
    const s = duel(mage, warrior, 20);
    cornered(s, { keepGuard: true });
    const a = decideBotAction(perceive(s, {
      difficulty: 'hard', auras: new Map(), dr: createDrStore(),
    }));
    expect(a.move.forward).toBeGreaterThanOrEqual(0);
    expect(a.move.yaw).toBeCloseTo(towardYaw(s), 6);
    const picked = mage.skills.find((sk) => sk.id === a.cast?.skillId);
    expect(picked !== undefined && isSelfDefenseSkill(picked),
      `手里还有保命牌却选了 ${a.cast?.skillId}`).toBe(true);
  });
});

/**
 * B1：治疗协作 —— 奶**血最少的队友**，不只是奶自己。
 *
 * ★ 用户反馈「BOT 都是单独行动，团队 PK 没有配合逻辑」的第一刀。
 * ⚠️ 这一组里最重要的是那条「敌人塞进名册也奶不到」—— 它钉的是
 *   **不开第二条施法通道**：队友治疗与自我治疗走同一个 `usableOn`
 *   （即同一个 `validateCast`），`TargetFilter.Ally` 由结算侧判，
 *   决策层不抄一份会漂移的镜像。P3 的「HPS 恒 0」就是从验错目标来的。
 */
describe('B1 治疗协作：healTargets（该奶谁）', () => {
  /**
   * 一个实体，只用来喂纯函数（不需要 world 上下文）。
   * ⚠️ 共用一个 world 才拿得到**互不相同**的 id —— 每次新建 world 的话
   *   `allocEntityId` 会从头发号，去重逻辑会把两个人当成同一个人。
   */
  const world = createWorld();
  const entity = (cls: typeof mage, team: typeof TEAM_RED, pct: number): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(0, 0, 0)));
    e.health = e.maxHealth * pct;
    return e;
  };

  it('★★ 不传队友 = 队伍里只有我一个（老调用方逐位不变）', () => {
    const healthy = entity(priest, TEAM_RED, 1.0);
    expect(healTargets(healthy)).toEqual([]);

    const hurt = entity(priest, TEAM_RED, 0.4);
    expect(healTargets(hurt).map((e) => e.id)).toEqual([hurt.id]);
  });

  it('★★ 队友比自己残 → 队友排前面（这就是「配合」的全部内容）', () => {
    const self = entity(priest, TEAM_RED, 0.45);
    const ally = entity(warrior, TEAM_RED, 0.2);
    expect(healTargets(self, [ally]).map((e) => e.id)).toEqual([ally.id, self.id]);
  });

  it('★ 血量 ≥ 阈值的人不进列表（满血队友不值一个公共冷却）', () => {
    const self = entity(priest, TEAM_RED, 1.0);
    const full = entity(warrior, TEAM_RED, 1.0);
    const half = entity(warrior, TEAM_RED, 0.5); // 恰好等于阈值 → 不进（判据是 <）
    expect(healTargets(self, [full, half])).toEqual([]);
  });

  it('★ 死人与宠物不奶（死人奶不活，宠物不是配合）', () => {
    const self = entity(priest, TEAM_RED, 1.0);
    const corpse = entity(warrior, TEAM_RED, 0.1);
    corpse.alive = false;
    const pet = entity(warrior, TEAM_RED, 0.1);
    pet.isPet = true;
    expect(healTargets(self, [corpse, pet])).toEqual([]);
  });

  it('★ 自己出现在名册里不会被算两遍（调用方直接把整队丢进来）', () => {
    const self = entity(priest, TEAM_RED, 0.3);
    expect(healTargets(self, [self]).map((e) => e.id)).toEqual([self.id]);
  });

  it('★★ 血量平手按实体 id 排 —— 没有二级键，回放会在这里分叉', () => {
    const self = entity(priest, TEAM_RED, 1.0);
    const a = entity(warrior, TEAM_RED, 0.3);
    const b = entity(warrior, TEAM_RED, 0.3);
    // ⚠️ 两个方向喂进去必须得到同一个答案（数组顺序不许决定奶谁）
    const first = healTargets(self, [a, b]).map((e) => e.id);
    const second = healTargets(self, [b, a]).map((e) => e.id);
    expect(first).toEqual(second);
  });
});

describe('B1 治疗协作：决策链会把奶按到队友身上', () => {
  /** 在 self 同队造一个 z 米外、血量为 pct 的队友 */
  const allyAt = (
    s: ReturnType<typeof duel>, z: number, pct: number,
  ): CombatEntity => {
    const e = addEntity(
      s.world, createEntity(allocEntityId(s.world), warrior, TEAM_RED, vec3(0, 0, z)),
    );
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    e.health = e.maxHealth * pct;
    return e;
  };

  /** 决策产出的那一发是不是治疗 */
  const castHeal = (skillId: unknown): boolean =>
    priest.skills.some((sk) => sk.id === skillId && isHealSkill(sk));

  it('★★ 自己满血、队友 20% → 把奶按在**队友**身上（此前只会奶自己）', () => {
    const s = duel(priest, warrior, 20);
    const ally = allyAt(s, 5, 0.2);
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), allies: [ally],
    }));
    expect(castHeal(a.cast?.skillId), `实际选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.targetId).toBe(ally.id);
  });

  /**
   * ⚠️ 血量取 0.4 而不是更低：低于 `SURVIVAL_HEALTH`(0.35) 会先走**保命键**
   *   那一步（护心屏障），那是决策链既有的优先级，不是治疗顺序的事。
   */
  it('★★ 自己更残 → 先奶自己（顺序就是血量百分比，不偏心）', () => {
    const s = duel(priest, warrior, 20);
    const ally = allyAt(s, 5, 0.45);
    s.self.health = s.self.maxHealth * 0.4;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), allies: [ally],
    }));
    expect(castHeal(a.cast?.skillId), `实际选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★★ 最残的队友够不着（40 米 > 30 米治疗射程）→ 退回来奶自己，不干等', () => {
    const s = duel(priest, warrior, 20);
    const farAlly = allyAt(s, 40, 0.1);
    s.self.health = s.self.maxHealth * 0.4;
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), allies: [farAlly],
    }));
    expect(castHeal(a.cast?.skillId), `实际选了 ${a.cast?.skillId}`).toBe(true);
    expect(a.cast?.targetId).toBe(s.self.id);
  });

  it('★★ 敌人塞进名册也奶不到他 —— 走的是 TargetFilter.Ally 的 validateCast', () => {
    const s = duel(priest, warrior, 20);
    s.foe.health = s.foe.maxHealth * 0.1; // 全场最残的就是他
    const a = decideBotAction(perceive(s, {
      // ⚠️ 故意喂一份**错的**名册：把敌人当队友。决策层不自己判敌我，
      //   靠 validateCast 判 —— 所以这里必须自然地一发奶也按不到他身上
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), allies: [s.foe],
    }));
    expect(castHeal(a.cast?.skillId), `把奶按到敌人身上了：${a.cast?.skillId}`).toBe(false);
  });

  it('★ easy 不奶队友（与它不打断/不躲圈/不参与集火同一条难度门）', () => {
    const s = duel(priest, warrior, 20);
    const ally = allyAt(s, 5, 0.2);
    const a = decideBotAction(perceive(s, {
      difficulty: 'easy', auras: new Map(), dr: createDrStore(), allies: [ally],
    }));
    expect(a.cast?.targetId).not.toBe(ally.id);
  });

  it('★ 不传 allies → 逐位退回老行为（自己半血才奶，且只奶自己）', () => {
    const s = duel(priest, warrior, 20);
    allyAt(s, 5, 0.05); // 队友快死了，但没进感知 → 决策层看不见他
    const a = decideBotAction(perceive(s, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(),
    }));
    expect(castHeal(a.cast?.skillId)).toBe(false);
  });

  /**
   * ★★ `pnpm balance` 的 168 场是这份逻辑的回归网，而它的复现依赖
   *   「同一个种子 → 同一串 rng 消耗」。治疗步骤是唯一用 rng 的分支，
   *   一旦它在**不出手**的路径上也摸一次随机源，整份基线会整体漂移
   *   （而且是那种「数字全变了但说不清为什么」的漂移）。
   */
  it('★★ 不出手就不碰随机源（谁都不用奶 / 奶不到 → rng 零消耗）', () => {
    const count = (): { rng: () => number; calls: () => number } => {
      let n = 0;
      return { rng: () => { n++; return 0.5; }, calls: () => n };
    };

    const idle = count();
    const s1 = duel(priest, warrior, 20);
    decideBotAction(perceive(s1, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), rng: idle.rng,
      allies: [], // 全队满血
    }));
    expect(idle.calls(), '没人要奶却摸了随机源').toBe(0);

    const unreachable = count();
    const s2 = duel(priest, warrior, 20);
    const farAlly = addEntity(
      s2.world, createEntity(allocEntityId(s2.world), warrior, TEAM_RED, vec3(0, 0, 40)),
    );
    farAlly.health = farAlly.maxHealth * 0.1;
    decideBotAction(perceive(s2, {
      difficulty: 'normal', auras: new Map(), dr: createDrStore(), rng: unreachable.rng,
      allies: [farAlly],
    }));
    expect(unreachable.calls(), '一发都验不过却摸了随机源').toBe(0);
  });
});

describe('P1a 工具函数', () => {
  it('isInterruptSkill 认得出八职业的专用打断', () => {
    expect(mage.skills.some(isInterruptSkill)).toBe(true);
    expect(warrior.skills.some(isInterruptSkill)).toBe(true);
  });

  it('★ burstDamageOf 把 DoT 整段计入（剑刃风暴的伤害全在周期跳里）', () => {
    const s = setup();
    const bladestorm = warrior.skills.find((sk) => (sk.id as string) === 'warrior.bladestorm')!;
    expect(burstDamageOf(bladestorm, s.self)).toBeGreaterThan(0);
  });

  it('半血保命仍然优先于输出（既有行为不回退）', () => {
    const s = setup(20);
    s.self.health = s.self.maxHealth * 0.3;
    // 法师没有治疗技能 → 仍然输出；这条只守卫「半血分支不抛错、不回退」
    expect(() => decideBotAction(perceive(s, { difficulty: 'normal' }))).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
//  W23 / W25：弹道迁移前后，bot 对同一技能的判断必须逐位不变
// ════════════════════════════════════════════════════════════════

/**
 * ★★ **这组测试守的是一条结构红线，不是一个数值。**
 *
 *   W23 把 21 个法术的载荷从技能顶层挪进了 `lockedProjectile.onHit`，
 *   W25 又把 4 条物理远程（瞄准射击/震慑箭/掷锤/致盲）挪了进去。
 *   bot 的三个判据（`hasDamage` / `burstDamageOf` / `ccCategoryOf`）
 *   全部是**顶层扫描**出身 —— 不跟着下探的话：
 *     · `hasDamage` 全假 → 法师/牧师/德鲁伊/圣骑士的选招池只剩杂项
 *     · `burstDamageOf` 归零 → argmax 退化成「随便按一个」
 *     · `ccCategoryOf` 全空 → 制裁之锤/扼喉/化形术/纠缠根须不再被当控制
 *   三条任意一条漏掉，`pnpm balance` 的基线都会整体塌穿，而**单测全绿**
 *   （这正是 `totalDamageOf` 头部记着的旋刃斩/暴风雪/陨星三次老教训）。
 *
 * 手法：拿真实数据里的迁移技能，构造一份「迁移前」的等价 SkillDef
 * （把 `lockedProjectile.onHit` 摊回顶层），逐项比对两者的判断结果。
 * 这样将来无论谁再动这三个函数，等价性都会被当场钉住。
 */
const unmigrate = (sk: SkillDef): SkillDef => ({
  ...sk,
  effects: sk.effects.flatMap((e) => (e.kind === 'lockedProjectile' ? e.onHit : [e])),
});

/**
 * ★★ 夹具**必须从全花名册里筛**，不能手写职业名。
 *
 *   初版写的是 `[druid, hunter, mage, priest, warrior, rogue]` —— 战士与盗贼
 *   一个迁移技能都没有（纯属凑数），而真正有迁移技能的**圣骑士（3 条）
 *   与死骑（2 条）不在列表里**：21 个迁移技能只覆盖了 16 个，漏掉的正是
 *   上面那段注释点名的制裁之锤与扼喉。守门的又只有一条
 *   `length > 0`，16 的时候照样绿 —— 夹具漏抓职业这件事本身没人看着。
 *   现在下限钉成「全花名册里带 lockedProjectile 的条数」，漏一个就红。
 */
const ALL_SKILLS: readonly SkillDef[] = [
  ...ALL_CLASSES.flatMap((c) => c.skills),
  ...PARTY_SKILLS,
];

const MIGRATED_SKILLS: readonly SkillDef[] = ALL_SKILLS.filter((sk) =>
  sk.effects.some((e) => e.kind === 'lockedProjectile'),
);

describe('★★ W23/W25：bot 估值在弹道迁移前后逐位不变', () => {
  it('★★ 夹具前提：全花名册的迁移技能一个不漏（漏抓职业本身要红）', () => {
    expect(MIGRATED_SKILLS.length, '一个迁移技能都没抓到 —— 夹具或数据出问题了').
      toBeGreaterThanOrEqual(25);
    // 手写职业名的老夹具漏掉的就是这两家 —— 逐条点名，别再靠计数兜
    const ids = MIGRATED_SKILLS.map((sk) => sk.id as string);
    for (const id of [
      'paladin.judgement', 'paladin.hammer_of_justice', 'paladin.holy_bolt',
      'deathknight.chains_of_ice', 'deathknight.strangulate',
      /**
       * ★★ W25 的四条物理远程。**瞄准射击是猎人 bot 的主力输出** ——
       *   `burstDamageOf` 认不出它，猎人的 argmax 会从 300% 武器伤害的
       *   那一发退化成随便按一个填充键，而猎人已经是基线最低的一档。
       *   掷锤与致盲进的是 `ccCategoryOf` 那条（控制步骤），漏了等于
       *   战士/盗贼各少一个控制键。
       */
      'hunter.aimed_shot', 'hunter.concussive_shot',
      'warrior.storm_bolt', 'rogue.blind',
    ]) {
      expect(ids, `${id} 没进夹具 —— 它的 bot 判据没有任何断言站在断点上`).toContain(id);
    }
  });

  it('★★ W25：猎人/战士/盗贼手上仍然有 bot 认得出来的伤害与控制键', () => {
    /**
     * ★★ 上面那三条等价断言是「迁移前后一致」，**两边同时坏掉时它们照样绿**
     *   （`hasDamage` 恒假 = 恒假）。这条是正面断言，与法师那条同族 ——
     *   W23 当时只写了法系三家，物理远程这批要自己站一条。
     */
    expect(hunter.skills.filter(hasDamage).length, '猎人的伤害技能 bot 全认不出来了').
      toBeGreaterThan(2);
    const aimed = hunter.skills.find((sk) => (sk.id as string) === 'hunter.aimed_shot')!;
    expect(hasDamage(aimed), '瞄准射击不再算伤害技能 —— 猎人 bot 的主力输出哑火').toBe(true);
    const s = setup();
    expect(burstDamageOf(aimed, s.self), '瞄准射击的单发威力归零了').toBeGreaterThan(0);

    // 控制侧：掷锤仍是昏迷链、致盲仍是迷惑链
    const stormBolt = warrior.skills.find((sk) => (sk.id as string) === 'warrior.storm_bolt')!;
    expect(ccCategoryOf(stormBolt), '掷锤不再被当控制键').toBe(DrCategory.Stun);
    const blind = rogue.skills.find((sk) => (sk.id as string) === 'rogue.blind')!;
    expect(ccCategoryOf(blind), '致盲不再被当控制键').toBe(DrCategory.Incapacitate);
  });

  it('★★ hasDamage：迁移前后一致（漏了它法系 bot 直接哑火）', () => {
    for (const sk of MIGRATED_SKILLS) {
      expect(hasDamage(sk), `${sk.id as string} 的伤害形状认不出来了`).toBe(
        hasDamage(unmigrate(sk)),
      );
    }
  });

  it('★★ burstDamageOf：迁移前后逐位相等（argmax 选招的输入）', () => {
    const s = setup();
    for (const sk of MIGRATED_SKILLS) {
      expect(burstDamageOf(sk, s.self), `${sk.id as string} 的单发威力变了`).toBe(
        burstDamageOf(unmigrate(sk), s.self),
      );
    }
  });

  it('★★ burstDamageOf：onHit 里的 DoT 同样吃「已经在跳就不重挂」的去重', () => {
    // 暗言术·痛 / 月火 / 毒蛇钉刺三条**零冷却 DoT** 迁移后全在 onHit 里 ——
    // 那正是 P3b 把牧师基线打到 0.0% 的原案发现场，去重必须跟着下探
    const s = setup();
    const swp = priest.skills.find((sk) => (sk.id as string) === 'priest.shadow_word_pain')!;
    const ticking = new Set(['priest.shadow_word_pain.dot']);
    expect(burstDamageOf(swp, s.self, ticking)).toBe(
      burstDamageOf(unmigrate(swp), s.self, ticking),
    );
    // 且「已经在跳」时确实降权了（否则这条断言测的是两个零）
    expect(burstDamageOf(swp, s.self, ticking)).toBeLessThan(burstDamageOf(swp, s.self));
  });

  it('★★ ccCategoryOf：迁移前后一致（化形术/纠缠根须仍被当控制键）', () => {
    for (const sk of MIGRATED_SKILLS) {
      expect(ccCategoryOf(sk), `${sk.id as string} 的控制类别丢了`).toBe(
        ccCategoryOf(unmigrate(sk)),
      );
    }
    // 正面：法师的化形术必须仍然是一条迷惑链控制
    const poly = mage.skills.find((sk) => (sk.id as string) === 'mage.polymorph')!;
    expect(ccCategoryOf(poly)).toBe(DrCategory.Incapacitate);
  });

  it('★★ 法师手上仍然有能被 bot 认出来的伤害技能（哑火的正面断言）', () => {
    expect(mage.skills.filter(hasDamage).length).toBeGreaterThan(3);
    expect(priest.skills.filter(hasDamage).length).toBeGreaterThan(2);
    expect(druid.skills.filter(hasDamage).length).toBeGreaterThan(2);
  });
});

// ════════════════════════════════════════════════════════════════
//  W27 收口：估值与结算读同一张武器改写表
// ════════════════════════════════════════════════════════════════

/**
 * ★★ **这组守的是「bot 用哪套数字选招」。**
 *
 *   W27 把 `WeaponDef.skillModifiers.damageMultiplier` 接进了结算
 *   （`effects/combat.dealDamage`），但 `burstDamageOf` 那一支没跟上 ——
 *   于是 bot **用接线前的数字选招、按接线后的数字结算**。实测偏差：
 *   长弓的瞄准射击被低估 13%（实伤 ×1.15、估值 ×1）、匕首圆盾的肾击
 *   被高估 43%（实伤 ×0.7），bot 会持续优先按一个已经削掉三成的技能。
 *
 *   ⚠️ 这条不只是「AI 打得笨一点」：`scripts/balance-report.ts` 跑的正是
 *   bot 对战，不同步会让极差位移里混进「bot 选错招」的分量，
 *   与「数值真的变了」再也分不开 —— 下一轮拿那个数字调配平就会调错方向。
 */
describe('★★ W27：burstDamageOf 与结算共用 skillModifiers', () => {
  /** 临时拔掉一把真实武器的整张改写表，跑完还原 */
  const withoutMods = <T>(weaponId: string, fn: () => T): T => {
    const w = getWeapon(asWeaponId(weaponId)) as
      { skillModifiers?: Record<string, unknown> };
    const prev = w.skillModifiers;
    w.skillModifiers = undefined;
    try { return fn(); } finally { w.skillModifiers = prev; }
  };

  const withWeapon = (cls: typeof hunter, weaponId: string): CombatEntity => {
    const world = createWorld();
    const e = addEntity(world, createEntity(allocEntityId(world), cls, TEAM_RED, vec3(0, 0, 0)));
    e.weaponId = asWeaponId(weaponId);
    return e;
  };

  it('★★ 加强方向：长弓的瞄准射击估值 ×1.15（与实伤同一个数）', () => {
    const h = withWeapon(hunter, 'hunter.long_bow');
    const aimed = hunter.skills.find((sk) => (sk.id as string) === 'hunter.aimed_shot')!;
    const base = withoutMods('hunter.long_bow', () => burstDamageOf(aimed, h));
    expect(base, '基线归零了，这条比的是两个零').toBeGreaterThan(0);
    expect(burstDamageOf(aimed, h) / base).toBeCloseTo(1.15, 6);
  });

  it('★★ 削弱方向：匕首圆盾的肾击估值 ×0.7（高估 43% 正是选招偏差的来源）', () => {
    const r = withWeapon(rogue as unknown as typeof hunter, 'rogue.dagger_buckler');
    const kidney = rogue.skills.find((sk) => (sk.id as string) === 'rogue.kidney_shot')!;
    const base = withoutMods('rogue.dagger_buckler', () => burstDamageOf(kidney, r));
    expect(base).toBeGreaterThan(0);
    expect(burstDamageOf(kidney, r) / base).toBeCloseTo(0.7, 6);
  });

  it('★★ 无改写逐位不变：短弓没有瞄准射击那条 → 与拔掉整张表**逐位**相同', () => {
    const h = withWeapon(hunter, 'hunter.short_bow');
    const aimed = hunter.skills.find((sk) => (sk.id as string) === 'hunter.aimed_shot')!;
    expect(burstDamageOf(aimed, h))
      .toBe(withoutMods('hunter.short_bow', () => burstDamageOf(aimed, h)));
  });

  it('★★ 嵌套载荷同样吃（法杖的暴风雪 ×1.15 全在 spawnGroundArea.onTick 里）', () => {
    const m = withWeapon(mage as unknown as typeof hunter, 'mage.staff');
    const blizzard = mage.skills.find((sk) => (sk.id as string) === 'mage.blizzard')!;
    const base = withoutMods('mage.staff', () => burstDamageOf(blizzard, m));
    expect(base).toBeGreaterThan(0);
    expect(burstDamageOf(blizzard, m) / base).toBeCloseTo(1.15, 6);
  });

  /**
   * ★★ **DoT 逐跳刻意不乘。** `tick.ts` 第 4 步给光环周期跳传的是
   *   `t.aura.def.id` 而不是技能 id，所以 DoT 的每一跳**实伤**本来就不吃
   *   武器加成（见 `effects/combat.weaponSkillModOf` 的 ⚠️）。估值跟着乘
   *   只是把偏差换个方向。这条钉的就是「别顺手把 DoT 也乘了」。
   *
   * ★ 用暗言术·痛：它是**纯 DoT**（伤害整个住在
   *   `lockedProjectile.onHit → applyAura.periodic` 里，一滴直伤都没有），
   *   所以「挂上乘算之后估值**逐位不变**」是个不会被别的分量稀释的判据。
   * ★ 今天没有任何武器给一个带 DoT 的技能填 `damageMultiplier`，所以这里
   *   临时挂一条真实武器上的改写（与 `sim/skillModifiers.test.ts` 同一手法）。
   */
  it('★★ 光环周期跳不乘：纯 DoT 技能挂上乘算后估值逐位不变', () => {
    const swp = priest.skills.find((sk) => (sk.id as string) === 'priest.shadow_word_pain')!;
    const p = withWeapon(priest as unknown as typeof hunter, 'priest.two_hand_staff');
    const before = burstDamageOf(swp, p);
    expect(before, '暗言术·痛的估值归零了 —— 这条比的是两个零').toBeGreaterThan(0);

    const w = getWeapon(asWeaponId('priest.two_hand_staff')) as
      { skillModifiers?: Record<string, unknown> };
    const prev = w.skillModifiers;
    w.skillModifiers = { ...(prev ?? {}), 'priest.shadow_word_pain': { damageMultiplier: 3 } };
    try {
      expect(burstDamageOf(swp, p), 'DoT 也被乘了 —— 实伤并不吃，估值又偏回去了')
        .toBe(before);
    } finally {
      w.skillModifiers = prev;
    }
  });
});
