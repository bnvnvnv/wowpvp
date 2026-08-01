/**
 * M11 第 1 项：`custom` handler 收敛后的**行为**测试。
 *
 * ★★ **这些测试之所以重要，是因为被迁移掉的那些 handler 从来没有生效过。**
 *
 *   `custom` 的兜底实现在 `effects/displacement.ts`：没有注册对应 handler 时
 *   **只记一条事件、不产生任何效果**（注释原话：「custom 本来就是『引擎暂不理解』的标记」）。
 *   而这几个 handler 名字在 `packages/shared/src/sim/` 里**一个都不存在**。
 *
 *   也就是说：数据里写了、技能描述里写了、`counters` 文案里也写了，
 *   但「减速逐渐恢复」「速度下限 80%」「审判易伤」这三条规则
 *   **四个阶段以来一次都没有真的发生过**。单测全绿、验收全绿 ——
 *   因为从来没有人测过它们。这正是本项目反复踩的那个坑的又一个变种。
 *
 *   所以这里测的不是「迁移前后一致」，而是**「现在它终于生效了」**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { deathknight, druid, paladin, rogue } from './index.js';
import { asTeamId, TEAM_BLUE, TEAM_RED, type EntityId } from '../types/ids.js';
import { School } from '../types/enums.js';
import { ccDurationTakenFor, neutralModifiers } from '../sim/modifiers.js';
import { vec3 } from '../math/vec3.js';
import { applyAura, createAuraStore, effectiveModifiersOf, type AuraStore } from '../sim/aura.js';
import { createEntity, type CombatEntity } from '../sim/entity.js';
import { validateCast } from '../sim/casting.js';
import { CastFailure } from '../types/enums.js';
import { createDrStore } from '../sim/dr.js';
import { createProjectileStore } from '../sim/projectile.js';
import { dealDamage } from '../sim/effects/index.js';
import { addEntity, allocEntityId, createWorld, type World } from '../sim/world.js';
import type { AuraDef, EffectDef, SkillDef } from './schema.js';

let world: World;
let auras: AuraStore;
let caster: CombatEntity;
let other: CombatEntity;
let victim: CombatEntity;

const spawn = (cls: typeof paladin, team: ReturnType<typeof asTeamId>): CombatEntity =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(0, 0, 0)));

beforeEach(() => {
  world = createWorld([]);
  auras = createAuraStore();
  caster = spawn(paladin, TEAM_RED);
  other = spawn(paladin, TEAM_RED);
  victim = spawn(deathknight, TEAM_BLUE);
});

/** 从技能里取出它施加的那个光环定义 —— 测的是**真实数据**，不是手写的夹具 */
const auraOf = (skill: SkillDef, auraId: string): AuraDef => {
  const find = (effects: readonly EffectDef[]): AuraDef | undefined => {
    for (const e of effects) {
      if (e.kind === 'applyAura' && e.aura.id === auraId) return e.aura;
      if (e.kind === 'spendResource') {
        const inner = find([e.base]);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  const found = find(skill.effects);
  if (!found) throw new Error(`技能 ${skill.id} 里找不到光环 ${auraId}`);
  return found;
};

const skillOf = (cls: typeof paladin, id: string): SkillDef => {
  const s = cls.skills.find((x) => (x.id as string) === id);
  if (!s) throw new Error(`找不到技能 ${id}`);
  return s;
};

// ════════════════════════════════════════════════════════════════

describe('★★ 冰霜锁链：减速随时间衰减（原 decayAuraModifier）', () => {
  const chains = () =>
    auraOf(skillOf(deathknight, 'deathknight.chains_of_ice'), 'deathknight.chains_of_ice');

  it('★★ 刚施加时是 60% 减速，4 秒后恢复到无减速', () => {
    const def = chains();
    expect(def.decay, '数据里没有 decay —— 迁移没做或被回退了').toBeDefined();

    applyAura(auras, victim, def, caster.id, 0);

    const at0 = effectiveModifiersOf(auras, victim, 0).moveSpeed;
    const at2 = effectiveModifiersOf(auras, victim, 2).moveSpeed;
    const at4 = effectiveModifiersOf(auras, victim, 4).moveSpeed;

    expect(at0, '起手不是 60% 减速').toBeCloseTo(0.4, 6);
    // ★ 这一条是关键：迁移之前 at2 === at0 === 0.4（衰减从未发生）
    expect(at2, '中途没有恢复 —— 衰减没有生效').toBeCloseTo(0.7, 6);
    expect(at4, '4 秒后没有恢复到无减速').toBeCloseTo(1.0, 6);
  });

  it('★ 衰减是单调的（不会中途反弹）', () => {
    applyAura(auras, victim, chains(), caster.id, 0);
    let prev = -Infinity;
    for (let t = 0; t <= 4; t += 0.5) {
      const v = effectiveModifiersOf(auras, victim, t).moveSpeed;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('★★ 死亡脚步：移动速度下限（原 applyMoveSpeedFloor）', () => {
  const advance = () =>
    auraOf(skillOf(deathknight, 'deathknight.deaths_advance'), 'deathknight.deaths_advance');

  it('★★ 带着重减速时速度仍不低于基础的 80%', () => {
    const def = advance();
    expect(def.modifiers?.moveSpeedFloor, '数据里没有 moveSpeedFloor').toBe(0.8);

    // 先来一发 70% 减速
    const heavySlow: AuraDef = {
      id: 'test.heavy_slow', name: '重减速', kind: 'debuff', duration: 10,
      modifiers: { moveSpeed: 0.3 },
    } as AuraDef;
    applyAura(auras, victim, heavySlow, caster.id, 0);

    const slowedOnly = effectiveModifiersOf(auras, victim, 0);
    expect(slowedOnly.moveSpeed, '夹具本身就不减速，这条测试没意义').toBeLessThan(0.5);

    // 再开死亡脚步
    applyAura(auras, victim, def, victim.id, 0);
    const withFloor = effectiveModifiersOf(auras, victim, 0);

    // ★ 迁移之前这里等于 0.3 —— 下限从未生效
    expect(
      Math.max(withFloor.moveSpeed, withFloor.moveSpeedFloor),
      '速度下限没有把 30% 抬回 80%',
    ).toBeCloseTo(0.8, 6);
  });
});

describe('★★ 审判：只对该圣骑士生效的易伤（原 judgementVulnerability）', () => {
  const judgement = () => auraOf(skillOf(paladin, 'paladin.judgement'), 'paladin.judgement');

  it('★★ 施加者打他 +10%，别人打他不加', () => {
    const def = judgement();
    expect(def.casterScoped, '数据里没有 casterScoped').toBe(true);
    expect(def.modifiers?.damageTaken, '数据里没有 damageTaken —— 易伤根本没有数值').toBe(1.1);

    applyAura(auras, victim, def, caster.id, 0);

    const fromCaster = effectiveModifiersOf(auras, victim, 0, caster.id).damageTaken;
    const fromOther = effectiveModifiersOf(auras, victim, 0, other.id).damageTaken;

    expect(fromCaster, '施加者的伤害没有被放大').toBeCloseTo(1.1, 6);
    // ★ 这一条是 casterScoped 的全部意义：迁移前后都不该是 1.1
    expect(fromOther, '易伤对**所有人**生效了 —— casterScoped 没起作用').toBeCloseTo(1.0, 6);
  });
});

describe('★ 保护祝福：受益者掉旗（原 dropFlagOnTarget）', () => {
  it('★ 效果表里是 dropFlag，且作用于 target 而不是 self', () => {
    const skill = skillOf(paladin, 'paladin.blessing_of_protection');
    const drop = skill.effects.find((e) => e.kind === 'dropFlag');

    expect(drop, '保护祝福里没有 dropFlag 效果').toBeDefined();
    /**
     * ★ `target: 'target'` 是这条的全部要点：保护祝福是**给别人**加免疫，
     *   掉旗的必须是那个别人。`SkillDef.dropsFlagOnUse` 只能表达施法者掉旗，
     *   而圣骑士自己并没有获得免疫 —— 写成 self 等于规则反了。
     */
    expect(drop?.kind === 'dropFlag' && drop.target).toBe('target');
  });
});

describe('★★ M11-2a：抗法护甲只削减**魔法**控制时长', () => {
  /**
   * ★★ 这条测试的重点不是「减免生效了」，而是「**它没有顺带削减物理控制**」。
   *
   *   10.9 / 验收 #32 要求「没有任何一件护甲是全面上位」。抗法（Spellward）
   *   的身份是削减魔法控制，抗控（Tenacity）才是削减所有控制。
   *   如果抗法也减物理，两件护甲就踩线了 —— 而这正是当初宁可
   *   「少表达一半优势」也不肯写成全局 `ccDurationTaken` 的原因。
   */
  const spellwardOf = (cls: typeof paladin) =>
    cls.armors.find((a) => (a.id as string).endsWith('spellward'));

  it('★★ 魔法学派被削减到 0.8，而物理学派不受影响', () => {
    const armor = spellwardOf(paladin);
    expect(armor, '找不到抗法型护甲').toBeDefined();

    const byS = armor!.modifiers?.ccDurationTakenBySchool;
    expect(byS, '抗法护甲没有接入 ccDurationTakenBySchool').toBeDefined();

    expect(byS![School.Fire], '魔法控制没有被削减').toBeCloseTo(0.8, 6);
    expect(byS![School.Shadow]).toBeCloseTo(0.8, 6);
    // ★ 这一条才是它与抗控型的分界线
    expect(
      byS![School.Physical],
      '抗法护甲削减了物理控制 —— 它踩了抗控型护甲的身份（10.9 / 验收 #32）',
    ).toBeUndefined();
  });

  it('★ 聚合后：未单列的学派回落到全局系数', () => {
    const m = neutralModifiers();
    m.ccDurationTaken = 1;
    m.ccDurationTakenBySchool = { [School.Fire]: 0.8 };

    expect(ccDurationTakenFor(m, School.Fire)).toBeCloseTo(0.8, 6);
    expect(ccDurationTakenFor(m, School.Physical)).toBeCloseTo(1, 6);
    // 学派未知（光环周期跳施加的控制）→ 回落全局，与加字段之前的行为一致
    expect(ccDurationTakenFor(m, undefined)).toBeCloseTo(1, 6);
  });
});

describe('★ 迁移完整性', () => {
  /**
   * ★ 这四个 handler 名字不该再出现在数据里。
   *   写成扫描而不是逐个断言，是为了「回退一处就会红」。
   */
  it('★ 已迁移的 custom handler 不再出现在职业数据里', () => {
    const migrated = [
      'decayAuraModifier',
      'applyMoveSpeedFloor',
      'paladin.judgementVulnerability',
      'paladin.dropFlagOnTarget',
    ];
    const leftovers: string[] = [];
    for (const cls of [deathknight, paladin]) {
      for (const skill of cls.skills) {
        const scan = (effects: readonly EffectDef[]): void => {
          for (const e of effects) {
            if (e.kind === 'custom' && migrated.includes(e.handler)) {
              leftovers.push(`${skill.id}: ${e.handler}`);
            }
            if (e.kind === 'spendResource') scan([e.base]);
          }
        };
        scan(skill.effects);
      }
    }
    expect(leftovers).toEqual([]);
  });
});

describe('★★ M11：脱战条件（原 rogue.requireOutOfCombat）', () => {
  /**
   * ★★ 这条 handler **从未注册** —— 潜行此前**没有任何脱战限制**，
   *   团战中随时能起手，与 9.x「脱战 4 秒后才能起手」完全相反。
   *   而 `SkillDef.requires` 在 M11 之前是**死 schema（零读取方）**，
   *   所以迁移的前提是先让 `validateCast()` 真的读它。
   */
  it('★★ 刚受到伤害时潜行被拒绝，脱战满 4 秒后放行', () => {
    const world = createWorld([]);
    const rg = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_RED, vec3(0, 0, 0)));
    for (const [r, max] of rg.maxResources) rg.resources.set(r, max);

    const stealth = rogue.skills.find((s) => (s.id as string) === 'rogue.stealth')!;
    expect(stealth.requires, '数据里没有 requires —— 迁移没做或被回退了').toBeDefined();

    // 刚打过架
    world.time = 10;
    rg.lastCombatAt = 10;
    expect(
      validateCast({ world, caster: rg, skill: stealth, phase: 'start' }),
      '战斗中竟然能进潜行',
    ).toBe(CastFailure.InCombat);

    // 脱战满 4 秒
    world.time = 14.1;
    expect(validateCast({ world, caster: rg, skill: stealth, phase: 'start' }))
      .toBe(CastFailure.Ok);
  });

  /** ★ 受到伤害要**同时**给攻击者和被攻击者打上战斗标记 */
  it('★★ 伤害同时把攻击者和被攻击者拖进战斗', () => {
    const world = createWorld([]);
    world.time = 5;
    const a = addEntity(world, createEntity(allocEntityId(world), rogue, TEAM_RED, vec3(0, 0, 0)));
    const b = addEntity(world, createEntity(allocEntityId(world), paladin, TEAM_BLUE, vec3(0, 0, 2)));
    const store = createAuraStore();

    dealDamage(
      {
        world, auras: store, dr: createDrStore(), projectiles: createProjectileStore(),
        groundAreas: [], traps: [], source: a, skillId: 'x',
        events: [] as never[], resolve: () => {},
      } as never,
      b, 50, School.Physical,
    );

    expect(b.lastCombatAt, '被打的人没进战斗').toBe(5);
    // ★ 只标记被打的人的话，「打完就潜行」的偷袭完全不受限制
    expect(a.lastCombatAt, '攻击者没进战斗 —— 打完就能立刻潜行').toBe(5);
  });

  it('★ 已迁移/已删除的 handler 不再出现在数据里', () => {
    const gone = ['rogue.requireOutOfCombat', 'druid.prowl'];
    const leftovers: string[] = [];
    for (const cls of [rogue, druid]) {
      for (const skill of cls.skills) {
        for (const e of skill.effects) {
          if (e.kind === 'custom' && gone.includes(e.handler)) leftovers.push(`${skill.id}: ${e.handler}`);
        }
      }
    }
    expect(leftovers).toEqual([]);
  });
});
