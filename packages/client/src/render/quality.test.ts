/**
 * 低画质公平测试。规格书 14.4，验收 #48。
 *
 * 验收 #48 是一条否定式规则（「不能隐藏 X」），这类规则最容易在
 * 「跑一遍看看」时通过、然后在某次为了提帧数的改动里悄悄破掉。
 * 所以这里不测「低画质下 X 可见」，而是测**结构本身**：
 * 关键角色根本没有被隐藏的通道。
 */

import { describe, expect, it } from 'vitest';
import {
  DECORATIVE_ROLES,
  ESSENTIAL_ROLES,
  QUALITY_ORDER,
  QUALITY_SETTINGS,
  QualityTier,
  decorativeDensity,
  hiddenAtQuality,
  isDecorative,
  isEssential,
  isVisible,
  type DecorativeRole,
  type VisualRole,
} from './quality.js';

const ALL_ESSENTIAL = Object.values(ESSENTIAL_ROLES);
const ALL_DECORATIVE = Object.values(DECORATIVE_ROLES);

describe('★ 验收 #48：低画质不能隐藏关键信息（14.4）', () => {
  it('★★ 规格书 14.4 点名的八项关键元素一项不少', () => {
    // 逐字来自 14.4 第二条：「不能隐藏角色、目标、旗手、投射物主体、
    // 地面真实边界、控制状态、完全免疫和复活保护」
    expect(new Set(ALL_ESSENTIAL)).toEqual(
      new Set([
        'character',
        'target',
        'flagCarrier',
        'projectileBody',
        'groundBoundary',
        'controlStatus',
        'fullImmunity',
        'spawnProtection',
      ]),
    );
  });

  it('★★ 关键元素在**每一档**画质下都可见', () => {
    for (const role of ALL_ESSENTIAL) {
      for (const q of QUALITY_ORDER) {
        expect(isVisible(role, q), `${role} 在 ${q} 画质下被隐藏了`).toBe(true);
      }
    }
  });

  it('★★ 关键与装饰两张表不相交 —— 否则规则成立与否取决于函数调用顺序', () => {
    const essential = new Set<string>(ALL_ESSENTIAL);
    expect(ALL_DECORATIVE.filter((r) => essential.has(r))).toEqual([]);
  });

  it('每个角色都被明确分类，不存在既不关键也不装饰的孤儿', () => {
    for (const role of [...ALL_ESSENTIAL, ...ALL_DECORATIVE] as VisualRole[]) {
      expect(isEssential(role) !== isDecorative(role), `${role} 分类不明确`).toBe(true);
    }
  });

  it('装饰元素在低画质下确实被砍掉了 —— 否则档位没有意义', () => {
    const hiddenAtLow = ALL_DECORATIVE.filter((r) =>
      hiddenAtQuality(r as DecorativeRole, QualityTier.Low),
    );
    expect(hiddenAtLow.length).toBe(ALL_DECORATIVE.length);
  });

  it('高画质下所有装饰元素都显示', () => {
    for (const r of ALL_DECORATIVE) {
      expect(hiddenAtQuality(r as DecorativeRole, QualityTier.High), r).toBe(false);
    }
  });

  it('14.4「减少」而不是「全无」：中画质装饰密度居中', () => {
    expect(decorativeDensity(QualityTier.High)).toBe(1);
    expect(decorativeDensity(QualityTier.Medium)).toBeGreaterThan(0);
    expect(decorativeDensity(QualityTier.Medium)).toBeLessThan(1);
    expect(decorativeDensity(QualityTier.Low)).toBe(0);
  });

  it('三档设置依次递增，没有反直觉的档位', () => {
    const s = QUALITY_ORDER.map((q) => QUALITY_SETTINGS[q]);
    for (let i = 1; i < s.length; i += 1) {
      expect(s[i]!.shadowMapSize).toBeGreaterThanOrEqual(s[i - 1]!.shadowMapSize);
      expect(s[i]!.particleDensity).toBeGreaterThanOrEqual(s[i - 1]!.particleDensity);
      expect(s[i]!.pixelRatioCap).toBeGreaterThanOrEqual(s[i - 1]!.pixelRatioCap);
    }
  });

  it('★ 低画质关掉阴影与抗锯齿 —— 减的都是装饰，不是信息', () => {
    expect(QUALITY_SETTINGS.low.shadowMapSize).toBe(0);
    expect(QUALITY_SETTINGS.low.antialias).toBe(false);
  });
});
