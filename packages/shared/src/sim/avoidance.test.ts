/**
 * 8.x 闪避 / 招架 / 格挡，以及它们依赖的确定性随机源。
 *
 * ★★ 这一组规则的数据（`dodgeFront` / `parry` / `block`）从 M0 就在 schema 里，
 *   护甲与武器也在用（剑盾「正面格挡 20%」、匕首「招架 +15%」、
 *   盗贼闪避「5 秒内正面闪避提高 50%」）—— 但 `combat.ts` 里
 *   **从来没有任何闪避判定**，三个字段一直是死数据。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mage, warrior } from '../data/index.js';
import { School } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { createAuraStore, applyAura, type AuraStore } from './aura.js';
import { createDrStore } from './dr.js';
import { createProjectileStore } from './projectile.js';
import { createEntity, type CombatEntity } from './entity.js';
import { addEntity, allocEntityId, createWorld, deriveRngSeed, nextRandom, type World } from './world.js';
import { dealDamage } from './effects/index.js';
import type { AuraDef } from '../data/schema.js';

let world: World; let auras: AuraStore;
let atk: CombatEntity; let def: CombatEntity;

const ctx = () => ({
  world, auras, dr: createDrStore(), projectiles: createProjectileStore(),
  groundAreas: [], traps: [], source: atk, skillId: 'test',
  events: [] as never[], resolve: () => {},
}) as never;

const setup = (seed = 1) => {
  world = createWorld([], seed);
  auras = createAuraStore();
  atk = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)));
  def = addEntity(world, createEntity(allocEntityId(world), mage, TEAM_BLUE, vec3(0, 0, 2)));
  def.yaw = dirToYaw(sub(atk.position, def.position)); // 面向攻击者
  def.health = def.maxHealth;
};

beforeEach(() => setup());

/** 一个「必定闪避」的光环，用来把概率钉死，不依赖运气 */
const alwaysDodge = (): AuraDef => ({
  id: 'test.dodge', name: '必闪', kind: 'buff', duration: 99,
  modifiers: { dodgeFront: 1 },
} as AuraDef);
const alwaysParry = (): AuraDef => ({
  id: 'test.parry', name: '必架', kind: 'buff', duration: 99,
  modifiers: { parry: 1 },
} as AuraDef);

describe('★★ 确定性随机：同种子 ⇒ 同结果', () => {
  it('★★ 同一个种子跑两遍，随机序列完全一致', () => {
    const a = [...Array(10)].map(() => nextRandom({ rng: deriveRngSeed(7, 3) }));
    const b = [...Array(10)].map(() => nextRandom({ rng: deriveRngSeed(7, 3) }));
    expect(a).toEqual(b);
  });

  it('★★ 不同实体的流互不相同（否则同队所有人会同时闪避）', () => {
    const s1 = deriveRngSeed(7, 1);
    const s2 = deriveRngSeed(7, 2);
    expect(s1).not.toBe(s2);
  });

  /**
   * ★★ **按实体分流的全部意义**：攻击者掷再多骰子，也不该改变
   *   被攻击者的下一次闪避结果。全局单流做不到这一点 ——
   *   那正是我放弃全局流的原因。
   */
  it('★★ 攻击者掷骰不扰动被攻击者的序列', () => {
    const before = def.rng;
    for (let i = 0; i < 50; i++) nextRandom(atk);
    expect(def.rng, '攻击者的掷骰改变了被攻击者的随机流').toBe(before);
  });

  it('★ 每个实体的流由 world.seed 派生 —— 换种子换整局', () => {
    setup(1); const r1 = def.rng;
    setup(999); const r2 = def.rng;
    expect(r1).not.toBe(r2);
  });
});

describe('★★ 8.x 规避判定', () => {
  it('★★ 100% 正面闪避时物理伤害完全落空', () => {
    applyAura(auras, def, alwaysDodge(), def.id, 0);
    const hp = def.health;
    const dealt = dealDamage(ctx(), def, 200, School.Physical);
    expect(dealt, '闪避没有生效').toBe(0);
    expect(def.health).toBe(hp);
  });

  /** ★ 9.x 闪避那条原话：「**法术不受影响**」*/
  it('★★ 闪避对法术无效（9.x：法术不受影响）', () => {
    applyAura(auras, def, alwaysDodge(), def.id, 0);
    const dealt = dealDamage(ctx(), def, 200, School.Fire);
    expect(dealt, '法术被闪避了 —— 规格书说法术不受影响').toBeGreaterThan(0);
  });

  /**
   * ★★ 闪避/格挡是**正面**的（字段名就是 `dodgeFront`）——
   *   背刺绕过它们，与 6.5 的背后攻击加成是同一条空间逻辑。
   */
  it('★★ 从背后攻击绕过正面闪避', () => {
    applyAura(auras, def, alwaysDodge(), def.id, 0);
    def.yaw = dirToYaw(sub(def.position, atk.position)); // 背对攻击者
    const dealt = dealDamage(ctx(), def, 200, School.Physical);
    expect(dealt, '背后攻击仍然被正面闪避挡住了').toBeGreaterThan(0);
  });

  it('★ 招架记录时刻 —— 反击刺的 recentlyParried 靠它', () => {
    applyAura(auras, def, alwaysParry(), def.id, 0);
    world.time = 12;
    dealDamage(ctx(), def, 100, School.Physical);
    expect(def.lastParryAt, '招架没有被记录').toBe(12);
  });

  it('★ 规避时发出带 avoided 的伤害事件（815：命中反馈要能区分格挡/闪避）', () => {
    applyAura(auras, def, alwaysDodge(), def.id, 0);
    const events: { t: string; avoided?: string }[] = [];
    const c = { ...(ctx() as object), events } as never;
    dealDamage(c, def, 100, School.Physical);
    const dmg = events.find((e) => e.t === 'damage');
    expect(dmg?.avoided).toBe('dodge');
  });

  it('★ 没有规避属性时正常吃伤害（证明上面不是「全都挡住」）', () => {
    const hp = def.health;
    const dealt = dealDamage(ctx(), def, 150, School.Physical);
    expect(dealt).toBeGreaterThan(0);
    expect(def.health).toBeLessThan(hp);
  });

  it('★ 昏迷时不闪避（7.3：无法行动）', () => {
    applyAura(auras, def, alwaysDodge(), def.id, 0);
    def.flags.stunned = true;
    expect(dealDamage(ctx(), def, 200, School.Physical)).toBeGreaterThan(0);
  });
});
