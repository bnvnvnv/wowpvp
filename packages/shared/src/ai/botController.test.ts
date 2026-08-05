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
import { mage, warrior } from '../data/index.js';
import { CastKind, School } from '../types/enums.js';
import { asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { vec3 } from '../math/vec3.js';
import { createEntity } from '../sim/entity.js';
import type { CastState, CastingStore } from '../sim/casting.js';
import type { GroundArea } from '../sim/groundArea.js';
import { addEntity, allocEntityId, createWorld } from '../sim/world.js';
import {
  burstDamageOf,
  decideBotAction,
  hasDamage,
  isHealSkill,
  isInterruptSkill,
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
      createdAt: 0, impactAt: 2, onImpact: [],
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
