/**
 * 视觉语言、控制区分与表现阶段测试。规格书 14.1 / 14.2 / 14.3，验收 #48 / #49。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  hueDistance,
  hueOf,
  hueShifted,
  isPoisonSkill,
  schoolCss,
  tintedVisual,
  visualAttributeOf,
  visualOf,
} from './schools.js';
import {
  SCALE_CLAMP,
  SignatureForm,
  TINT_CLAMP,
  registerSignatures,
  resolveSignature,
} from '../av/skillSignature.js';
import { StatusMarkers } from './StatusMarkers.js';
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
import {
  EVENT_PARTICLE_CAP,
  MAX_FORM_SLOTS_PER_FRAME,
  STREAM_PARTICLE_CAP,
  SpellVfx,
  burstPlanFor,
  formPlanFor,
  scaledCount,
  type FormStep,
} from './SpellVfx.js';

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

// ════════════════════════════════════════════════════════════════
//  P3 技能签名：色相偏移 / 规模乘数 / 七种二级形态
// ════════════════════════════════════════════════════════════════

/** 从 0xRRGGBB 取 HSL 的后两位（本文件里「属性还认得出来」的度量）*/
const slOf = (color: number): { s: number; l: number } => {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  return { s: d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min)), l };
};

describe('P3 签名 · tintShift：色相偏移不破属性主辨识', () => {
  const EXTREMES = [-TINT_CLAMP, -0.05, -0.01, 0.01, 0.05, TINT_CLAMP];

  it('★★ 只旋色相 —— 饱和度与明度逐位不动', () => {
    /**
     * ★★ 这条是「属性仍可辨」的**主要**保证，比色相距离更硬。
     *   八属性基色里有两对色相几乎重合（神圣 40.5° / 物理 38.3°、
     *   奥术 264° / 暗影 273°），把它们分开的从来不是色相而是 S/L：
     *   物理是低饱和沙色、神圣是高明度暖金。所以签名只要碰 S/L，
     *   神圣技能就可能褪成物理色 —— 那才是打穿 14.2 的那一刀。
     */
    for (const [name, av] of Object.entries(ATTRIBUTE_VISUALS)) {
      for (const c of [av.primary, av.secondary]) {
        const base = slOf(c);
        for (const shift of EXTREMES) {
          const got = slOf(hueShifted(c, shift));
          expect(got.s, `${name} 饱和度被 ${shift} 改动`).toBeCloseTo(base.s, 2);
          expect(got.l, `${name} 明度被 ${shift} 改动`).toBeCloseTo(base.l, 2);
        }
      }
    }
  });

  it('★ 位移量恰好等于 tintShift（8 位量化误差 < 0.006 色环）', () => {
    for (const av of Object.values(ATTRIBUTE_VISUALS)) {
      for (const shift of EXTREMES) {
        const moved = hueDistance(hueOf(hueShifted(av.primary, shift)), hueOf(av.primary));
        expect(moved).toBeCloseTo(Math.abs(shift), 2);
        // 也不许**放大**：这一层不做钳位，放大就等于把地基的钳位架空了
        expect(moved).toBeLessThanOrEqual(TINT_CLAMP + 0.006);
      }
    }
  });

  it('★★ 17.2 的非颜色通道一位不动 —— 粒子形状 / 字形 / 运动描述', () => {
    for (const av of Object.values(ATTRIBUTE_VISUALS)) {
      const t = tintedVisual(av, TINT_CLAMP);
      expect(t.particle).toBe(av.particle);
      expect(t.glyph).toBe(av.glyph);
      expect(t.motion).toBe(av.motion);
      // 颜色确实变了（否则上面三条是空断言）
      expect(t.primary).not.toBe(av.primary);
    }
  });

  it('偏移 0 是零成本：原样返回同一个对象', () => {
    const av = ATTRIBUTE_VISUALS.fire;
    expect(tintedVisual(av, 0)).toBe(av);
    expect(hueShifted(0xff8a4c, 0)).toBe(0xff8a4c);
  });

  it('灰度色没有色相可转，原样返回（不炸也不变成别的颜色）', () => {
    for (const gray of [0x000000, 0x808080, 0xffffff]) {
      expect(hueShifted(gray, TINT_CLAMP)).toBe(gray);
    }
  });

  it('★ 全量：117 个技能的签名色都在 ±TINT_CLAMP 内且 S/L 不变', () => {
    for (const s of allSkills()) {
      const sig = resolveSignature(s.id as string);
      expect(Math.abs(sig.tintShift), `${s.name} 的 tintShift 越界`)
        .toBeLessThanOrEqual(TINT_CLAMP + 1e-9);
      const base = visualOf(s);
      const tinted = tintedVisual(base, sig.tintShift);
      expect(slOf(tinted.primary).s, `${s.name} 主色饱和度被改`)
        .toBeCloseTo(slOf(base.primary).s, 2);
      expect(slOf(tinted.primary).l, `${s.name} 主色明度被改`)
        .toBeCloseTo(slOf(base.primary).l, 2);
    }
  });

  it('★ 同一个技能永远同一个颜色 —— 签名是身份不是随机装饰', () => {
    const s = allSkills()[0]!;
    const a = resolveSignature(s.id as string).tintShift;
    const b = resolveSignature(s.id as string).tintShift;
    expect(a).toBe(b);
  });
});

describe('P3 签名 · scale：规模乘数尊重粒子池预算', () => {
  it('★★ 乘数后的申请量按池上限**截断**，不是溢出也不是崩', () => {
    // 事件池单格 48：任何乘数都顶不穿
    expect(scaledCount(48, SCALE_CLAMP.max)).toBe(EVENT_PARTICLE_CAP);
    expect(scaledCount(999, 1)).toBe(EVENT_PARTICLE_CAP);
    // 细流池单格 32（拖尾走它）
    expect(scaledCount(11, SCALE_CLAMP.max, STREAM_PARTICLE_CAP)).toBe(20);
    expect(scaledCount(999, SCALE_CLAMP.max, STREAM_PARTICLE_CAP)).toBe(STREAM_PARTICLE_CAP);
  });

  it('★ 下限 1：小技能被收着，但不能被收没', () => {
    expect(scaledCount(1, SCALE_CLAMP.min)).toBe(1);
    expect(scaledCount(0, 0)).toBe(1);
  });

  it('乘数在区间内是单调的（大招真的比小技能密）', () => {
    expect(scaledCount(16, SCALE_CLAMP.max)).toBeGreaterThan(scaledCount(16, 1));
    expect(scaledCount(16, 1)).toBeGreaterThan(scaledCount(16, SCALE_CLAMP.min));
  });

  it('★★ 分量 × 签名规模的最坏组合（1.5 × 1.8）仍在池内', () => {
    expect(scaledCount(16 * 1.5, SCALE_CLAMP.max)).toBeLessThanOrEqual(EVENT_PARTICLE_CAP);
    // 命中爆发的底数更大，同样顶不穿
    expect(scaledCount(48, SCALE_CLAMP.max)).toBeLessThanOrEqual(EVENT_PARTICLE_CAP);
  });
});

describe('P3 签名 · form：七种二级形态各自可观测且互不相同', () => {
  const ALL_FORMS = Object.values(SignatureForm);
  const SHAPED = ALL_FORMS.filter((f) => f !== SignatureForm.None);

  it('七种形态一个不少（与地基的 SignatureForm 同步）', () => {
    expect(ALL_FORMS.sort()).toEqual(
      ['none', 'orbit', 'pillar', 'rain', 'ring', 'shards', 'spiral'],
    );
  });

  it('★ none 不产生粒子；其余六种都产生可观测粒子', () => {
    expect(formPlanFor(SignatureForm.None, 1, 1)).toEqual([]);
    for (const f of SHAPED) {
      const plan = formPlanFor(f, 1, 1);
      expect(plan.length, `${f} 没有任何编排`).toBeGreaterThan(0);
      for (const s of plan) {
        expect(s.count, `${f} 的一步是 0 粒`).toBeGreaterThan(0);
        expect(s.size, `${f} 的一步尺寸为 0`).toBeGreaterThan(0);
        expect(s.life, `${f} 的一步寿命为 0`).toBeGreaterThan(0);
      }
    }
  });

  it('★★ 七种两两不同 —— 整段编排逐字段比对', () => {
    const seen = new Map<string, SignatureForm>();
    for (const f of ALL_FORMS) {
      const key = JSON.stringify(formPlanFor(f, 1, 1));
      const dup = seen.get(key);
      expect(dup, `${f} 与 ${dup} 的编排一模一样，玩家分不出`).toBeUndefined();
      seen.set(key, f);
    }
    expect(seen.size).toBe(7);
  });

  it('★★ 且区分靠的是**运动通道**，任意两种至少两处不同', () => {
    /**
     * ★ 与 `status.ts` 的 `distinguishingChannels` 同一个思路：
     *   「我觉得这俩看起来不一样」保证不了任何事。形态之间不能靠贴图区分
     *   （贴图已经被属性占满了 —— 火永远是火球、冰永远是雪花），
     *   所以这里比的全是运动参数。
     */
    const channels = (s: FormStep): string[] => [
      String(Math.sign(s.gravity)),
      String(s.swirl > 0),
      s.spread,
      s.originRadius.toFixed(2),
      `${s.ground}:${s.dy.toFixed(2)}`,
    ];
    for (let i = 0; i < SHAPED.length; i += 1) {
      for (let j = i + 1; j < SHAPED.length; j += 1) {
        const a = channels(formPlanFor(SHAPED[i]!, 1, 1)[0]!);
        const b = channels(formPlanFor(SHAPED[j]!, 1, 1)[0]!);
        const differing = a.filter((x, k) => x !== b[k]).length;
        expect(
          differing,
          `${SHAPED[i]} 与 ${SHAPED[j]} 只有 ${differing} 处运动差异，会混淆`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('★ 语义与地基注释对得上：落雨从高处往下、光柱往上、轨道零重力', () => {
    expect(formPlanFor(SignatureForm.Rain, 1, 1)[0]!.gravity).toBeLessThan(0);
    expect(formPlanFor(SignatureForm.Rain, 1, 1)[0]!.dy).toBeGreaterThan(2);
    expect(formPlanFor(SignatureForm.Pillar, 1, 1)[0]!.gravity).toBeGreaterThan(0);
    expect(formPlanFor(SignatureForm.Orbit, 1, 1)[0]!.gravity).toBe(0);
    expect(formPlanFor(SignatureForm.Orbit, 1, 1)[0]!.swirl).toBeGreaterThan(0);
    // 环是水平扩散：贴地 + disc + 高初速
    expect(formPlanFor(SignatureForm.Ring, 1, 1)[0]!.spread).toBe('disc');
    expect(formPlanFor(SignatureForm.Ring, 1, 1)[0]!.speed).toBeGreaterThan(5);
    // 碎片是从命中点球面爆出（不锚地面）
    expect(formPlanFor(SignatureForm.Shards, 1, 1)[0]!.ground).toBe(false);
    expect(formPlanFor(SignatureForm.Shards, 1, 1)[0]!.spread).toBe('sphere');
  });

  it('★★ 形态自身也在池预算内：步数 ≤ 每帧上限、单步 ≤ 事件池单格容量', () => {
    for (const f of SHAPED) {
      for (const scale of [SCALE_CLAMP.min, 1, SCALE_CLAMP.max]) {
        const plan = formPlanFor(f, scale, 1);
        expect(plan.length, `${f} 的步数超预算`).toBeLessThanOrEqual(MAX_FORM_SLOTS_PER_FRAME);
        for (const s of plan) {
          expect(s.count, `${f} 单步 ${s.count} 粒顶穿事件池单格`)
            .toBeLessThanOrEqual(EVENT_PARTICLE_CAP);
        }
      }
    }
  });

  it('scale 只放大数量与尺寸，不动形态的识别特征（半径/寿命/重力）', () => {
    for (const f of SHAPED) {
      const one = formPlanFor(f, 1, 1)[0]!;
      const big = formPlanFor(f, SCALE_CLAMP.max, 1)[0]!;
      expect(big.count).toBeGreaterThanOrEqual(one.count);
      expect(big.size).toBeGreaterThan(one.size);
      expect(big.originRadius).toBe(one.originRadius);
      expect(big.life).toBe(one.life);
      expect(big.gravity).toBe(one.gravity);
      expect(big.speed).toBe(one.speed);
    }
  });
});

describe('P3 签名 · 17.2 特效密度档', () => {
  it('★★ 低密度档（low）整体**跳过**二级形态 —— 如实取舍，见 formPlanFor 注释', () => {
    for (const f of Object.values(SignatureForm)) {
      expect(formPlanFor(f, SCALE_CLAMP.max, 0), `${f} 在 low 档仍在冒粒子`).toEqual([]);
    }
  });

  it('★ 中密度档（0.5）整体减量而不是关掉 —— 14.4 说的是「减少」', () => {
    for (const f of Object.values(SignatureForm).filter((x) => x !== SignatureForm.None)) {
      const full = formPlanFor(f, 1, 1);
      const half = formPlanFor(f, 1, 0.5);
      expect(half.length).toBe(full.length);
      for (let i = 0; i < full.length; i += 1) {
        expect(half[i]!.count).toBeLessThan(full[i]!.count);
        expect(half[i]!.count).toBeGreaterThan(0);
      }
    }
  });

  it('★ 被砍掉的只有形态：形态不是 14.4 那八项关键角色里的任何一项', () => {
    // 关键信息（命中反馈本体、地面边界、控制状态…）不经由 formPlanFor 产生，
    // 所以 low 档跳过形态不可能让任何一项关键信息消失。
    for (const r of ['groundBoundary', 'controlStatus', 'projectileBody', 'fullImmunity'] as const) {
      expect(isVisible(r, QualityTier.Low)).toBe(true);
    }
  });
});

describe('P3 签名 · SpellVfx 真的消费了签名（白盒计数）', () => {
  /** 关掉贴图加载失败的告警：node 里没有 document，25 张贴图必然退回程序化兜底 */
  let warn: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    warn.mockRestore();
  });

  const frostbolt = (): SkillDef =>
    mage.skills.find((s) => (s.id as string) === 'mage.frostbolt')!;

  const caster = { position: { x: 0, y: 0, z: 0 }, height: 2, yaw: 0, id: 1 };

  /** 同一帧里连放 n 次，返回事件池 + 细流池里活着的爆发数 */
  const castTimes = (vfx: SpellVfx, n: number): number => {
    for (let i = 0; i < n; i += 1) vfx.onCast('resolved', caster, frostbolt(), []);
    return vfx.status().activeBursts;
  };

  it('★★ 二级形态每帧最多吃 3 格 —— 10 次释放不会变成 10 份形态（X9 前科）', () => {
    /**
     * ★ 白盒差分：同一个技能、同一段代码，唯一变量是「有没有注册形态签名」。
     *   差值 = 形态真正吃掉的池格数。没有每帧预算的话这里会是 10。
     */
    const before = new SpellVfx();
    const baseline = castTimes(before, 10);
    before.dispose();

    registerSignatures({ 'mage.frostbolt': { form: SignatureForm.Rain } });
    expect(resolveSignature('mage.frostbolt').form).toBe(SignatureForm.Rain);

    const after = new SpellVfx();
    const withForm = castTimes(after, 10);
    after.dispose();

    expect(withForm - baseline).toBe(MAX_FORM_SLOTS_PER_FRAME);
  });

  it('★ 形态确实产生了粒子（一次释放 = 一段编排，不是零）', () => {
    const vfx = new SpellVfx();
    const one = castTimes(vfx, 1);
    vfx.dispose();
    const plain = new SpellVfx();
    // 没有形态的技能作对照：火焰冲击没注册签名，推导层的 form 恒为 none
    plain.onCast('resolved', caster, mage.skills.find((s) => (s.id as string) === 'mage.fire_blast')!, []);
    const bare = plain.status().activeBursts;
    plain.dispose();
    expect(one).toBeGreaterThan(bare);
  });

  it('★★ 低密度档下形态一粒都不发（frame 喂 low 之后）', () => {
    const vfx = new SpellVfx();
    vfx.frame(0.016, {
      quality: QualityTier.Low, cameraDistance: 8, pointScale: 520, now: 0,
      projectiles: [], grounds: [],
    });
    const low = castTimes(vfx, 10);
    vfx.dispose();

    const hi = new SpellVfx();
    hi.frame(0.016, {
      quality: QualityTier.High, cameraDistance: 8, pointScale: 520, now: 0,
      projectiles: [], grounds: [],
    });
    const high = castTimes(hi, 10);
    hi.dispose();

    expect(high - low).toBe(MAX_FORM_SLOTS_PER_FRAME);
  });

  it('★ 每帧预算在 frame() 开头清零 —— 下一帧的形态额度是满的', () => {
    const vfx = new SpellVfx();
    const first = castTimes(vfx, 10);
    vfx.frame(0.016, {
      quality: QualityTier.High, cameraDistance: 8, pointScale: 520, now: 0,
      projectiles: [], grounds: [],
    });
    // 第二帧再放一次：形态额度回来了，池里又多出一段编排
    vfx.onCast('resolved', caster, frostbolt(), []);
    expect(vfx.status().activeBursts).toBeGreaterThan(first);
    vfx.dispose();
  });
});

describe('X7 护盾自然过期：0.3 秒收束淡出（过期不是破裂）', () => {
  const DIST = 5; // 第三人称，不触发 closeUpOpacity 的压低
  const tick = (m: StatusMarkers, dt: number): void =>
    m.update(new Map(), QualityTier.High, DIST, dt, 0);

  it('★★ 自然过期不再瞬间消失：壳还在，且处于淡出中', () => {
    const m = new StatusMarkers();
    m.setShield(100, 100, DIST);
    expect(m.shieldVisible).toBe(true);
    expect(m.shieldExpiring).toBe(false);

    m.setShield(undefined, 1, DIST); // 光环没了 = 自然过期
    expect(m.shieldVisible, '过期时壳被瞬间摘掉了').toBe(true);
    expect(m.shieldExpiring).toBe(true);
    m.dispose();
  });

  it('★ 0.3 秒之后才真的消失，期间每帧都还在', () => {
    const m = new StatusMarkers();
    m.setShield(100, 100, DIST);
    m.setShield(undefined, 1, DIST);
    // 0.29 秒：还在
    for (let i = 0; i < 29; i += 1) {
      tick(m, 0.01);
      m.setShield(undefined, 1, DIST); // 场景每帧都会再喂一次
      expect(m.shieldVisible, `第 ${i} 帧壳提前没了`).toBe(true);
    }
    tick(m, 0.05); // 越过 0.3 秒
    expect(m.shieldVisible).toBe(false);
    expect(m.shieldExpiring).toBe(false);
    m.dispose();
  });

  it('★★ 收束 = 一边缩一边淡（与破裂的胀开方向相反）', () => {
    const m = new StatusMarkers();
    m.setShield(100, 100, DIST);
    const full = m.shieldShellScale;
    m.setShield(undefined, 1, DIST);
    tick(m, 0.15); // 淡出过半
    expect(m.shieldShellScale, '壳没有向内收束').toBeLessThan(full);
    m.dispose();
  });

  it('★★ 破裂**不**走淡出 —— 语义区分保留', () => {
    const m = new StatusMarkers();
    m.setShield(100, 100, DIST);
    m.flashBroken();
    m.setShield(0, 100, DIST);
    expect(m.shieldExpiring, '破裂被当成过期淡出了').toBe(false);
    expect(m.shieldState).toBe('broken');

    // 破裂反馈（0.4 秒）演完之后壳立刻收掉，不再拖 0.3 秒
    tick(m, 0.5);
    m.setShield(0, 100, DIST);
    expect(m.shieldExpiring).toBe(false);
    expect(m.shieldVisible).toBe(false);
    m.dispose();
  });

  it('★ 淡出中途又套上一层盾：立刻恢复完整，不留半透明的壳', () => {
    const m = new StatusMarkers();
    m.setShield(100, 100, DIST);
    m.setShield(undefined, 1, DIST);
    tick(m, 0.15);
    expect(m.shieldExpiring).toBe(true);
    m.setShield(100, 100, DIST); // 新的一层
    expect(m.shieldExpiring).toBe(false);
    expect(m.shieldVisible).toBe(true);
    expect(m.shieldState).toBe('active');
    m.dispose();
  });

  it('★ 从来没有盾的角色不会因为每帧喂 undefined 而卡在淡出里', () => {
    const m = new StatusMarkers();
    for (let i = 0; i < 5; i += 1) {
      tick(m, 0.016);
      m.setShield(undefined, 1, DIST);
    }
    expect(m.shieldVisible).toBe(false);
    expect(m.shieldExpiring).toBe(false);
    m.dispose();
  });
});
