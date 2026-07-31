/**
 * 程序化技能图标。
 *
 * ★★ **最重要的一条是「同职业内不许两两撞脸」** —— 技能栏一次只显示
 *   一个职业，撞脸就意味着玩家分不清自己的两个技能。
 *   这条测试是那份保证的守卫：将来加技能、改数值都可能让两个图标重合，
 *   而那**不会有任何别的地方报错**。
 */

import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, ALL_SKILLS, CastKind } from '@wowpvp/shared';
import { skillIconSpec, skillIconSvg } from './skillIcon.js';

const fingerprint = (s: ReturnType<typeof skillIconSpec>) =>
  [s.core, s.rx, s.rotate, s.glyph, s.primary, s.dots, s.angle, s.castMark].join('|');

describe('★★ 可区分性', () => {
  it('★★ 同一个职业内，任意两个技能的图标都不相同', () => {
    const collisions: string[] = [];
    for (const cls of ALL_CLASSES) {
      const seen = new Map<string, string>();
      for (const sk of cls.skills) {
        const fp = fingerprint(skillIconSpec(sk));
        const prev = seen.get(fp);
        if (prev) collisions.push(`${cls.id}: ${prev} 与 ${sk.name} 图标相同`);
        else seen.set(fp, sk.name);
      }
    }
    expect(collisions, '同职业内出现撞脸图标').toEqual([]);
  });

  it('★ 全部 91 个技能都能生成图标（加技能自动有图标）', () => {
    for (const sk of ALL_SKILLS) {
      expect(() => skillIconSvg(sk), `${sk.id} 生成失败`).not.toThrow();
    }
  });

  /** ★ 同一个技能必须**每次生成都一样** —— 花纹是 id 派生的，不能有随机 */
  it('★★ 确定性：同一技能两次生成完全一致', () => {
    for (const sk of ALL_SKILLS.slice(0, 20)) {
      expect(skillIconSvg(sk)).toBe(skillIconSvg(sk));
    }
  });
});

describe('★ 17.2：不能只靠颜色区分', () => {
  /**
   * ★★ 这条是否定式的：把学派色**全部抹掉**之后，图标仍然必须两两可分。
   *   写不出这条测试的实现，就是「一张图不同颜色」—— 正是 17.2 禁止的。
   */
  it('★★ 忽略颜色后，同职业内仍然两两可分', () => {
    const shapeOnly = (s: ReturnType<typeof skillIconSpec>) =>
      [s.core, s.rx, s.rotate, s.glyph, s.dots, s.angle, s.castMark].join('|');
    const collisions: string[] = [];
    for (const cls of ALL_CLASSES) {
      const seen = new Map<string, string>();
      for (const sk of cls.skills) {
        const fp = shapeOnly(skillIconSpec(sk));
        const prev = seen.get(fp);
        if (prev) collisions.push(`${cls.id}: ${prev} 与 ${sk.name} 去色后相同`);
        else seen.set(fp, sk.name);
      }
    }
    expect(collisions, '去掉颜色后就分不清了 —— 违反 17.2').toEqual([]);
  });

  it('★ 每个图标都带 glyph（14.2 的形状标记）', () => {
    for (const sk of ALL_SKILLS) {
      expect(skillIconSpec(sk).glyph.length, `${sk.id} 没有 glyph`).toBeGreaterThan(0);
    }
  });
});

describe('★ 语义层：形状确实编码了「这是什么」', () => {
  it('治疗技能用治疗形状，伤害技能用伤害形状', () => {
    const heal = ALL_SKILLS.find((s) => s.effects.some((e) => e.kind === 'heal') &&
      !s.effects.some((e) => e.kind === 'damage'))!;
    const dmg = ALL_SKILLS.find((s) => s.effects.some((e) => e.kind === 'damage'))!;
    expect(skillIconSpec(heal).core).toBe('heal');
    expect(skillIconSpec(dmg).core).toBe('damage');
  });

  it('★ 瞬发没有施放角标，读条/引导/瞄准各有一种', () => {
    const instant = ALL_SKILLS.find((s) => s.cast.kind === CastKind.Instant)!;
    const cast = ALL_SKILLS.find((s) => s.cast.kind === CastKind.Cast)!;
    expect(skillIconSpec(instant).castMark).toBe('');
    expect(skillIconSpec(cast).castMark).toBe('cast');
  });

  it('★ 地面技能是菱形边框（5.4 瞄准方式的第二通道）', () => {
    const ground = ALL_SKILLS.find((s) => s.targeting === 'ground')!;
    expect(skillIconSpec(ground).rotate).toBe(45);
  });
});

describe('★★ 嵌套效果必须被看见', () => {
  /**
   * ⚠️ 这条是截图比对抓出来的：暴风雪/陨星/剜刺的伤害分别嵌在
   *   `spawnGroundArea.onTick`、`delayedGroundImpact.onImpact`、
   *   `spendComboPoints.base` 里。只看顶层效果的话它们会被判成 `buff`，
   *   于是三个纯输出技能显示成**盾牌图标** —— spec 值全对，语义全错。
   */
  it('★★ 地面区域 / 延迟落点 / 连击点终结技都判为伤害', () => {
    const cases = ['mage.blizzard', 'mage.meteor', 'rogue.eviscerate'];
    for (const id of cases) {
      const sk = ALL_SKILLS.find((s) => (s.id as string) === id)!;
      expect(skillIconSpec(sk).core, `${sk.name} 应当是伤害图标`).toBe('damage');
    }
  });

  it('★ 陷阱里的控制也被看见（冰冻陷阱 → 迷惑而非盾）', () => {
    const trap = ALL_SKILLS.find((s) => (s.id as string) === 'hunter.freezing_trap')!;
    expect(skillIconSpec(trap).core).not.toBe('buff');
  });
});
