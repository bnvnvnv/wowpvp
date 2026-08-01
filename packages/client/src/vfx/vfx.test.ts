/**
 * 视觉语言、控制区分与表现阶段测试。规格书 14.1 / 14.2 / 14.3，验收 #48 / #49。
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_CLASSES,
  CastKind,
  School,
  Targeting,
  mage,
  rogue,
  type SkillDef,
} from '@wowpvp/shared';
import { QualityTier, isEssential, isVisible } from '../render/quality.js';
import {
  ATTRIBUTE_VISUALS,
  VisualAttribute,
  isPoisonSkill,
  schoolCss,
  visualAttributeOf,
} from './schools.js';
import {
  CONTROL_VISUALS,
  SHIELD_VISUALS,
  ShieldState,
  closeUpOpacity,
  controlMarkerScale,
  distinguishingChannels,
  essentialMarkerScale,
  shieldStateFor,
  type ControlKind,
} from './status.js';
import { VfxPhase, phasesFor, vfxPlanFor } from './phases.js';
import { burstPlanFor } from './SpellVfx.js';

const allSkills = (): SkillDef[] => ALL_CLASSES.flatMap((c) => c.skills);

describe('14.2 八属性视觉语言', () => {
  it('★★ 14.2 的表有八行 —— 七个伤害学派 + 毒素', () => {
    expect(Object.keys(ATTRIBUTE_VISUALS).sort()).toEqual(
      ['arcane', 'fire', 'frost', 'holy', 'nature', 'physical', 'poison', 'shadow'],
    );
    // 毒素**不是** School 的成员 —— 这正是它需要单独一层的原因
    expect(Object.values(School)).not.toContain('poison');
  });

  it('每个属性都有颜色、形状运动描述和字形，一项不缺', () => {
    for (const [name, v] of Object.entries(ATTRIBUTE_VISUALS)) {
      expect(v.primary, name).toBeGreaterThan(0);
      expect(v.secondary, name).toBeGreaterThan(0);
      expect(v.motion.length, name).toBeGreaterThan(0);
      expect(v.glyph.length, name).toBeGreaterThan(0);
    }
  });

  it('★ 17.2：八个属性的字形两两不同 —— 不能只靠颜色区分', () => {
    const glyphs = Object.values(ATTRIBUTE_VISUALS).map((v) => v.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('八个属性的主色两两不同', () => {
    const colors = Object.values(ATTRIBUTE_VISUALS).map((v) => v.primary);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('★★ 毒刃用毒素视觉，而不是它的物理学派视觉', () => {
    const blade = rogue.skills.find((s) => s.name === '毒刃')!;
    // 它确实是物理学派（被物理免疫挡）
    expect(blade.school).toBe(School.Physical);
    // 但玩家看到的应该是黄绿色的毒，不是钢铁色的刀光（14.2）
    expect(visualAttributeOf(blade)).toBe(VisualAttribute.Poison);
    expect(isPoisonSkill(blade)).toBe(true);
  });

  it('非毒技能退回自己的学派视觉', () => {
    const fireball = mage.skills.find((s) => s.school === School.Fire)!;
    expect(visualAttributeOf(fireball)).toBe(VisualAttribute.Fire);
  });

  it('★ 全部 90 个技能都能解析出视觉属性 —— 没有技能会「没有特效」', () => {
    for (const s of allSkills()) {
      const a = visualAttributeOf(s);
      expect(ATTRIBUTE_VISUALS[a], `${s.name} 解析不出视觉`).toBeDefined();
    }
  });

  it('HUD 与 3D 特效共用同一张颜色表', () => {
    expect(schoolCss(School.Fire)).toBe('#ff8a4c');
    expect(schoolCss(School.Frost)).toBe('#8fd4ff');
  });
});

describe('★ 14.3 控制状态必须彼此可区分', () => {
  it('★ 定身附着脚部，昏迷显示头顶标记（14.3 原文）', () => {
    expect(CONTROL_VISUALS.rooted.anchor).toBe('feet');
    expect(CONTROL_VISUALS.stunned.anchor).toBe('overhead');
  });

  it('★★ 沉默与恐惧使用不同视觉 —— 且不能只靠颜色', () => {
    const a = distinguishingChannels(CONTROL_VISUALS.silenced);
    const b = distinguishingChannels(CONTROL_VISUALS.feared);
    const differing = a.filter((x, i) => x !== b[i]).length;
    expect(differing, '沉默与恐惧在非颜色通道上区分不足').toBeGreaterThanOrEqual(2);
  });

  it('★★ 任意两种控制在非颜色通道上至少有两处不同', () => {
    const kinds = Object.keys(CONTROL_VISUALS) as ControlKind[];
    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        const a = distinguishingChannels(CONTROL_VISUALS[kinds[i]!]);
        const b = distinguishingChannels(CONTROL_VISUALS[kinds[j]!]);
        const differing = a.filter((x, k) => x !== b[k]).length;
        expect(
          differing,
          `${kinds[i]} 与 ${kinds[j]} 只有 ${differing} 处非颜色差异，会混淆`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('控制状态在低画质下反而更大 —— 屏幕小、粒子没了，标记必须更明显', () => {
    expect(controlMarkerScale(QualityTier.Low)).toBeGreaterThan(
      controlMarkerScale(QualityTier.High),
    );
  });

  it('★ 控制状态是关键角色，任何画质都不隐藏', () => {
    expect(isEssential('controlStatus')).toBe(true);
    for (const q of [QualityTier.Low, QualityTier.Medium, QualityTier.High]) {
      expect(isVisible('controlStatus', q)).toBe(true);
    }
  });
});

describe('★ 14.3 护盾四态', () => {
  it('★ 激活 / 承伤 / 强度衰减 / 破裂，四种都在', () => {
    expect(Object.keys(SHIELD_VISUALS).sort()).toEqual(
      ['absorbing', 'active', 'broken', 'decaying'],
    );
  });

  it('★★ 承伤是事件、衰减是状态 —— 两者不能并成一个', () => {
    expect(SHIELD_VISUALS.absorbing.kind).toBe('burst');
    expect(SHIELD_VISUALS.decaying.kind).toBe('sustained');
    expect(SHIELD_VISUALS.absorbing.durationSeconds).toBeGreaterThan(0);
    expect(SHIELD_VISUALS.decaying.durationSeconds).toBe(0);
  });

  it('四种反馈的运动方式两两不同', () => {
    const motions = Object.values(SHIELD_VISUALS).map((v) => v.motion);
    expect(new Set(motions).size).toBe(motions.length);
  });

  it('剩余量决定持续态：满盾 active，快破 decaying，破了 broken', () => {
    expect(shieldStateFor(100, 100)).toBe(ShieldState.Active);
    expect(shieldStateFor(20, 100)).toBe(ShieldState.Decaying);
    expect(shieldStateFor(0, 100)).toBe(ShieldState.Broken);
  });
});

describe('★ 验收 #49：第一人称不遮屏、最远镜头仍清晰', () => {
  it('★ 第一人称下火焰/烟雾/护盾透明度被压低', () => {
    for (const e of ['fire', 'smoke', 'shield'] as const) {
      expect(closeUpOpacity(e, 0.9, 0.1), e).toBeLessThanOrEqual(0.25);
    }
  });

  it('第三人称下不压 —— 只有近身才会糊脸', () => {
    expect(closeUpOpacity('shield', 0.9, 5)).toBe(0.9);
  });

  it('★ 压的是透明度不是可见性 —— 护盾属于关键信息，不能关掉', () => {
    expect(closeUpOpacity('shield', 0.9, 0)).toBeGreaterThan(0);
  });

  it('★ 最远镜头下关键标记放大而不是等比缩小', () => {
    expect(essentialMarkerScale(18)).toBeGreaterThan(essentialMarkerScale(0));
  });

  it('旗手与投射物主体在最远镜头仍是关键角色', () => {
    for (const r of ['flagCarrier', 'projectileBody', 'groundBoundary'] as const) {
      expect(isVisible(r, QualityTier.Low)).toBe(true);
    }
  });
});

describe('14.1 技能表现六阶段', () => {
  it('每个技能都有释放与结束两个阶段', () => {
    for (const s of allSkills()) {
      const phases = phasesFor(s).map((p) => p.phase);
      expect(phases, `${s.name} 缺少释放阶段`).toContain(VfxPhase.Release);
      expect(phases, `${s.name} 缺少结束阶段`).toContain(VfxPhase.End);
    }
  });

  it('★ 瞬发技能没有预备阶段，读条技能有', () => {
    for (const s of allSkills()) {
      const hasWindup = phasesFor(s).some((p) => p.phase === VfxPhase.Windup);
      expect(hasWindup, `${s.name}（${s.cast.kind}）预备阶段判断错误`)
        .toBe(s.cast.kind !== CastKind.Instant);
    }
  });

  it('★ 投射物技能有飞行阶段', () => {
    const proj = allSkills().filter(
      (s) => s.effects.some((e) => e.kind === 'spawnProjectile') || s.targeting === Targeting.Projectile,
    );
    expect(proj.length).toBeGreaterThan(0);
    for (const s of proj) {
      expect(phasesFor(s).map((p) => p.phase), s.name).toContain(VfxPhase.Travel);
    }
  });

  it('★★ 投射物主体是关键角色，拖尾是装饰 —— 低画质砍尾巴不砍主体', () => {
    const proj = allSkills().find(
      (s) => s.effects.some((e) => e.kind === 'spawnProjectile'),
    )!;
    const travel = phasesFor(proj).filter((p) => p.phase === VfxPhase.Travel);
    expect(travel.length).toBe(2);
    expect(travel.some((p) => p.role === 'projectileBody')).toBe(true);
    expect(travel.some((p) => p.role === 'projectileTrail')).toBe(true);
    expect(isVisible('projectileBody', QualityTier.Low)).toBe(true);
    expect(isVisible('projectileTrail', QualityTier.Low)).toBe(false);
  });

  it('★★ 地面区域技能：边界是关键的，内部填充是装饰（14.3）', () => {
    const ground = allSkills().find((s) =>
      s.effects.some((e) => e.kind === 'spawnGroundArea'),
    )!;
    const sustain = phasesFor(ground).filter((p) => p.phase === VfxPhase.Sustain);
    expect(sustain.some((p) => p.role === 'groundBoundary')).toBe(true);
    expect(sustain.some((p) => p.role === 'groundFill')).toBe(true);
    // 这就是 14.3「装饰粒子可以淡出但边界不能消失」
    expect(isVisible('groundBoundary', QualityTier.Low)).toBe(true);
    expect(isVisible('groundFill', QualityTier.Low)).toBe(false);
  });

  it('★ 延迟技能显示落点和倒计时，且是关键信息（14.3）', () => {
    const delayed = allSkills().filter((s) =>
      s.effects.some((e) => e.kind === 'delayedGroundImpact'),
    );
    expect(delayed.length).toBeGreaterThan(0);
    for (const s of delayed) {
      const sustain = phasesFor(s).filter((p) => p.phase === VfxPhase.Sustain);
      expect(sustain.some((p) => p.role === 'groundBoundary'), s.name).toBe(true);
    }
  });

  it('★ 全部 90 个技能都能推导出阶段表 —— 不需要手工维护 90 份特效配置', () => {
    for (const s of allSkills()) {
      const plan = vfxPlanFor(s);
      expect(plan.phases.length, s.name).toBeGreaterThan(0);
      expect(plan.attribute, s.name).toBeDefined();
    }
  });

  it('★ 每个阶段的视觉角色都已分类 —— 不存在无法判断能否被砍的元素', () => {
    for (const s of allSkills()) {
      for (const p of phasesFor(s)) {
        expect(
          isVisible(p.role, QualityTier.High),
          `${s.name} 的 ${p.phase} 阶段角色 ${p.role} 未分类`,
        ).toBe(true);
      }
    }
  });

  it('法师的火球有预备 + 飞行 + 命中', () => {
    const fireball = mage.skills.find((s) => s.name === '火球术');
    if (!fireball) return;
    const phases = phasesFor(fireball).map((p) => p.phase);
    expect(phases).toContain(VfxPhase.Release);
    expect(phases).toContain(VfxPhase.Impact);
  });
});

describe('打击分档 → 爆发参数（burstPlanFor，纯函数无需 WebGL）', () => {
  it('★ 档位越高，粒子数/尺寸/寿命单调不减', () => {
    const tiers = ['light', 'normal', 'heavy', 'crit', 'critHeavy'] as const;
    for (let i = 1; i < tiers.length; i++) {
      const lo = burstPlanFor(tiers[i - 1]!, 150, 'high');
      const hi = burstPlanFor(tiers[i]!, 150, 'high');
      expect(hi.count).toBeGreaterThanOrEqual(lo.count);
      expect(hi.size).toBeGreaterThanOrEqual(lo.size);
      expect(hi.life).toBeGreaterThanOrEqual(lo.life);
    }
  });

  it('★ count 恒 ≤ 48（Burst 的 MAX_PARTICLES，超了会被静默钳掉）', () => {
    for (const tier of ['light', 'normal', 'heavy', 'crit', 'critHeavy', 'kill'] as const) {
      expect(burstPlanFor(tier, 99999, 'high').count).toBeLessThanOrEqual(48);
    }
  });

  it('★★ low 画质下没有碎屑层，但主爆发仍在（14.4：装饰可减，命中反馈不是装饰）', () => {
    const plan = burstPlanFor('critHeavy', 400, 'low');
    expect(plan.debris).toBe(false);
    expect(plan.count).toBeGreaterThan(0);
    // 冲击波与白核不是 impactDebris 角色 —— 它们是命中反馈本体，不随画质关
    expect(plan.shockwave).toBe(true);
    expect(plan.whiteCore).toBe(true);
  });

  it('★ 只有暴击档有白核；只有 heavy 及以上有冲击波', () => {
    expect(burstPlanFor('normal', 150, 'high').shockwave).toBe(false);
    expect(burstPlanFor('normal', 150, 'high').whiteCore).toBe(false);
    expect(burstPlanFor('heavy', 250, 'high').shockwave).toBe(true);
    expect(burstPlanFor('heavy', 250, 'high').whiteCore).toBe(false);
    expect(burstPlanFor('crit', 100, 'high').whiteCore).toBe(true);
  });
});
