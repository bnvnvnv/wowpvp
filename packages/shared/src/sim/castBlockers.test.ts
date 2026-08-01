/**
 * 技术债 #3：施法失败原因的优先级。
 *
 * ★★ 这个文件测的是**两个函数的分工**，不是某一个的正确性：
 *
 *   · `validateCast()` 是门禁 —— 单一答案，顺序由 7.4 步骤 1 规定
 *     （资源在距离之前），而且它的返回值是统计归因的依据。
 *   · `describeCastBlockers()` 是提示 —— 全部答案，服务 15.2 的提示质量。
 *
 *   技术债的原始抱怨是「怒气为 0 的战士站在 30 米外，收到的提示是
 *   『资源不足』而不是『超出距离』」。解法不是改门禁顺序（那会连带改统计），
 *   而是并排加一个报告器。所以下面第一条测试**同时**断言两者 ——
 *   门禁仍然回资源，报告器同时给出两条。
 */

import { describe, expect, it } from 'vitest';
import { warrior } from '../data/index.js';
import { CastFailure } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { box } from '../data/maps/schema.js';
import { createEntity } from './entity.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import { describeCastBlockers, validateCast } from './casting.js';
import type { SkillDef } from '../data/schema.js';

const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

const setup = () => {
  const world: World = createWorld([ground]);
  const caster = addEntity(
    world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)),
  );
  const foe = addEntity(
    world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(0, 0, 3)),
  );
  for (const [r, max] of caster.maxResources) caster.resources.set(r, max);
  return { world, caster, foe };
};

/** 一个近战、要资源、要朝向的技能 —— 战士的主力技能都符合 */
const meleeCostSkill = (): SkillDef => {
  const s = warrior.skills.find(
    (k) => k.cost !== undefined && k.range.max <= 5 && k.cast.time === 0,
  );
  if (!s) throw new Error('找不到一个近战 + 有消耗的瞬发技能');
  return s;
};

describe('★★ 技术债 #3：门禁与提示的分工', () => {
  it('★★ 资源不足 + 距离太远：门禁回「资源」，报告器两条都给', () => {
    const { world, caster, foe } = setup();
    const skill = meleeCostSkill();

    // 制造抱怨里那个场景：怒气为 0，且站在 30 米外
    caster.resources.set(skill.cost!.resource, 0);
    foe.position = vec3(0, 0, 30);
    caster.yaw = dirToYaw(sub(foe.position, caster.position));

    const ctx = { world, caster, skill, target: foe, phase: 'start' as const };

    /**
     * ★ 门禁**必须**仍然回「资源不足」—— 7.4 步骤 1 把资源列在距离之前，
     *   而且 CastFailure 是统计归因的依据。这条测试在这里正是为了
     *   **阻止**有人「顺手把顺序改得更合理」。
     */
    expect(
      validateCast(ctx),
      '门禁顺序被改了 —— 那会连带改变 CastFailure 的语义与统计归因',
    ).toBe(CastFailure.NotEnoughResource);

    // ★ 而报告器要把两条都说出来
    const blockers = describeCastBlockers(ctx);
    expect(blockers).toContain(CastFailure.NotEnoughResource);
    expect(blockers).toContain(CastFailure.OutOfRange);

    // ★ 且「距离」排在「资源」前面 —— 玩家先该解决的是走近点
    expect(
      blockers.indexOf(CastFailure.OutOfRange),
      '报告顺序应当把更可操作的位置问题排在前面（15.2）',
    ).toBeLessThan(blockers.indexOf(CastFailure.NotEnoughResource));
  });

  it('★ 一切就绪时返回空数组', () => {
    const { world, caster, foe } = setup();
    const skill = meleeCostSkill();
    foe.position = vec3(0, 0, 2);
    caster.yaw = dirToYaw(sub(foe.position, caster.position));

    const ctx = { world, caster, skill, target: foe, phase: 'start' as const };
    expect(validateCast(ctx)).toBe(CastFailure.Ok);
    expect(describeCastBlockers(ctx)).toEqual([]);
  });

  it('★ 死亡是压倒性的：只报这一条，不再列一堆次要项', () => {
    const { world, caster, foe } = setup();
    const skill = meleeCostSkill();
    caster.alive = false;
    caster.resources.set(skill.cost!.resource, 0);
    foe.position = vec3(0, 0, 30);

    expect(
      describeCastBlockers({ world, caster, skill, target: foe, phase: 'start' }),
      '死人不需要知道自己还缺怒气',
    ).toEqual([CastFailure.Dead]);
  });

  it('★ 多个状态类阻碍同时成立时全部列出', () => {
    const { world, caster, foe } = setup();
    const skill = meleeCostSkill();
    foe.position = vec3(0, 0, 2);
    caster.yaw = dirToYaw(sub(foe.position, caster.position));
    caster.flags.disarmed = true;   // 物理技能 → 被缴械挡住
    caster.cooldowns.set(skill.id, world.time + 5);

    const blockers = describeCastBlockers({
      world, caster, skill, target: foe, phase: 'start',
    });
    expect(blockers).toContain(CastFailure.Disarmed);
    expect(blockers).toContain(CastFailure.OnCooldown);
    expect(blockers.length, '两条都该在').toBeGreaterThanOrEqual(2);
  });

  /**
   * ★ 报告器**不能**比门禁更宽松：门禁说不行的场景，报告器必须至少给出一条。
   *   否则 HUD 会显示「可以放」而按下去失败 —— 那正是验收 #8 要防的
   *   「指示器显示合法 → 按下去却失败」的另一种形态。
   */
  it('★★ 门禁拒绝时报告器不得为空', () => {
    const skill = meleeCostSkill();
    const breakIt: { name: string; apply: (s: ReturnType<typeof setup>) => void }[] = [
      { name: '资源不足', apply: (s) => s.caster.resources.set(skill.cost!.resource, 0) },
      { name: '距离太远', apply: (s) => { s.foe.position = vec3(0, 0, 40); } },
      { name: '昏迷', apply: (s) => { s.caster.flags.stunned = true; } },
      { name: '冷却中', apply: (s) => s.caster.cooldowns.set(skill.id, s.world.time + 9) },
      { name: '缴械', apply: (s) => { s.caster.flags.disarmed = true; } },
    ];

    for (const { name, apply } of breakIt) {
      const s = setup();
      s.foe.position = vec3(0, 0, 2);
      s.caster.yaw = dirToYaw(sub(s.foe.position, s.caster.position));
      apply(s);

      const ctx = { world: s.world, caster: s.caster, skill, target: s.foe, phase: 'start' as const };
      const gate = validateCast(ctx);
      expect(gate, `「${name}」没能让门禁拒绝，这个场景没构造成功`).not.toBe(CastFailure.Ok);
      expect(
        describeCastBlockers(ctx).length,
        `「${name}」：门禁回 ${gate} 但报告器说没问题 —— HUD 会显示「可以放」而按下去失败`,
      ).toBeGreaterThan(0);
    }
  });
});
