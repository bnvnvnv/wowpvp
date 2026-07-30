/**
 * 可访问性设置测试。规格书 17.2。
 *
 * ★ 重点是两条否定式规则：
 *   · 「危险区域不能只依赖颜色」→ 非颜色通道**不能有开关**
 *   · 「降低特效」不能成为第二个隐藏关键信息的入口（复用验收 #48 的保证）
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, Action } from '../input/InputManager.js';
import { ESSENTIAL_ROLES, QUALITY_ORDER } from '../render/quality.js';
import {
  ColorblindMode,
  DEFAULT_ACCESSIBILITY,
  INDEPENDENT_TOGGLES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UNSWITCHABLE_CHANNELS,
  clampUiScale,
  loadAccessibility,
  normalizeAccessibility,
  paletteFor,
  saveAccessibility,
  shakeAmplitude,
  showNamePlate,
  showWeaponParticles,
  visibleWithSettings,
  type AccessibilitySettings,
} from './accessibility.js';

const settings = (over: Partial<AccessibilitySettings> = {}): AccessibilitySettings =>
  normalizeAccessibility({ ...DEFAULT_ACCESSIBILITY, ...over });

// ════════════════════════════════════════════════════════════════

describe('17.2 全部按键可重绑', () => {
  /** ★ 键位不在设置对象里 —— 它从 M1 起就在 InputManager，本来就是数据驱动的 */
  it('★ 每一个 Action 都有默认键位（没有硬编码在事件处理里的按键）', () => {
    for (const action of Object.values(Action)) {
      expect(DEFAULT_BINDINGS[action], `Action ${action} 缺少默认键位`).toBeTruthy();
    }
  });

  it('★ 可访问性设置里没有第二份键位表（避免两个真相来源）', () => {
    expect(Object.keys(DEFAULT_ACCESSIBILITY)).not.toContain('bindings');
    expect(Object.keys(DEFAULT_ACCESSIBILITY)).not.toContain('keys');
  });
});

// ════════════════════════════════════════════════════════════════

describe('★★ 17.2「危险区域不能只依赖颜色」', () => {
  /**
   * ★★ **这是本文件最重要的一条。**
   *
   *   如果设置里有一个 `showIllegalGlyph: boolean`，玩家把它设成 false 之后，
   *   非法落点就只剩颜色一条通道 —— 一条否定式规则被**设置项**破坏了，
   *   而且是玩家自己在设置界面里关掉的，谁都不会当成 bug 报上来。
   *
   *   所以那些通道在 M3 的 GroundIndicator / M8 的 vfx/status.ts 里是
   *   **无条件**绘制的，设置对象不给它们任何开关。
   */
  it('★★ 设置里不存在任何能关掉非颜色通道的字段', () => {
    const keys = Object.keys(DEFAULT_ACCESSIBILITY);
    for (const channel of UNSWITCHABLE_CHANNELS) {
      expect(keys, `${channel} 不该有开关`).not.toContain(channel);
      // 也不能换个名字偷偷加进来
      const suspicious = keys.filter((k) =>
        k.toLowerCase().includes(channel.toLowerCase().replace(/^(danger|illegal|control|flagState)/, '')),
      );
      expect(suspicious, `疑似 ${channel} 的开关：${suspicious.join(',')}`).toEqual([]);
    }
  });

  it('★ 色盲模式只重映射色相，不提供「关掉形状通道」的选项', () => {
    // 四种模式都必须给出完整的语义色，且不能返回空值让调用方回落到「只用颜色」
    for (const mode of Object.values(ColorblindMode)) {
      const p = paletteFor(mode);
      for (const [k, v] of Object.entries(p)) {
        expect(v, `${mode}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  /** ★ 红绿色盲下敌我两色必须真的不同 —— 否则色盲模式什么也没解决 */
  it('★ 红绿色盲模式下敌我色确实被分开到蓝黄轴', () => {
    for (const mode of [ColorblindMode.Protanopia, ColorblindMode.Deuteranopia]) {
      const p = paletteFor(mode);
      expect(p.hostile).not.toBe(p.friendly);
      expect(p.hostile).not.toBe(paletteFor(ColorblindMode.Off).hostile);
    }
  });

  it('关闭色盲模式时用基础色板', () => {
    expect(paletteFor(ColorblindMode.Off).hostile).toBe('#e5484d');
  });
});

// ════════════════════════════════════════════════════════════════

describe('★ 17.2「降低特效」不能成为第二个隐藏关键信息的入口', () => {
  /**
   * ★★ 验收 #48 的全部保证建立在「关键元素只有一个能被隐藏的出口，
   *   而那个出口不接受 EssentialRole」上。「降低特效」这个设置若能绕过它，
   *   保证就失效了。所以 visibleWithSettings 只是把档位转发给 isVisible。
   */
  it('★★ 最低特效档位下，全部关键元素仍然可见（验收 #48）', () => {
    const s = settings({ effectQuality: 'low' });
    for (const role of Object.values(ESSENTIAL_ROLES)) {
      expect(visibleWithSettings(role, s), `关键元素 ${role} 在最低特效下被隐藏了`).toBe(true);
    }
  });

  it('★ 每个画质档位下关键元素都可见', () => {
    for (const tier of QUALITY_ORDER) {
      const s = settings({ effectQuality: tier });
      for (const role of Object.values(ESSENTIAL_ROLES)) {
        expect(visibleWithSettings(role, s)).toBe(true);
      }
    }
  });

  it('装饰元素在低档位下确实被省掉（否则「降低特效」没有效果）', () => {
    const low = settings({ effectQuality: 'low' });
    const high = settings({ effectQuality: 'high' });
    expect(visibleWithSettings('ember', low)).toBe(false);
    expect(visibleWithSettings('ember', high)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════

describe('17.2「伤害数字、屏幕闪烁、武器粒子、姓名板密度可单独调整」', () => {
  /**
   * ★ 四项必须**互相独立**。塞进一个「特效强度」滑条就等于
   *   「想关粒子必须整体降画质」，17.2 明确不允许。
   */
  it('★★ 四项确实是四个独立字段，改一个不影响其余三个', () => {
    expect(INDEPENDENT_TOGGLES).toHaveLength(4);

    const base = settings();
    for (const key of INDEPENDENT_TOGGLES) {
      const flipped = settings({
        [key]: typeof base[key] === 'boolean' ? !base[key] : 0,
      } as Partial<AccessibilitySettings>);

      for (const other of INDEPENDENT_TOGGLES) {
        if (other === key) continue;
        expect(flipped[other], `改 ${key} 影响了 ${other}`).toEqual(base[other]);
      }
    }
  });

  /** ★ 关粒子不需要降画质 —— 这正是「可单独调整」的含义 */
  it('★ 关掉武器粒子时画质档位不受影响', () => {
    const s = settings({ weaponParticles: false, effectQuality: 'high' });
    expect(showWeaponParticles(s)).toBe(false);
    expect(s.effectQuality).toBe('high');
    // 其他装饰元素仍按高画质显示
    expect(visibleWithSettings('ember', s)).toBe(true);
  });

  it('武器粒子同时受自身开关与画质约束（两者都要满足）', () => {
    expect(showWeaponParticles(settings({ weaponParticles: true, effectQuality: 'high' }))).toBe(true);
    // weaponGlint 的最低档位是 high，所以中画质下即使开着也不画
    expect(showWeaponParticles(settings({ weaponParticles: true, effectQuality: 'medium' }))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════

describe('姓名板密度', () => {
  const opts = (rank: number, isTarget = false) =>
    ({ isCurrentTarget: isTarget, distanceRank: rank, total: 10 });

  it('密度为 1 时全部显示', () => {
    expect(showNamePlate(opts(9), settings({ namePlateDensity: 1 }))).toBe(true);
  });

  it('密度降低时只保留最近的一部分', () => {
    const s = settings({ namePlateDensity: 0.3 });
    expect(showNamePlate(opts(0), s)).toBe(true);
    expect(showNamePlate(opts(2), s)).toBe(true);
    expect(showNamePlate(opts(5), s)).toBe(false);
  });

  /**
   * ★★ 密度设为 0 时**仍然**显示当前目标。
   *   15.2 要求目标框和姓名板给出目标状态；把它一起藏掉就不是
   *   「降低密度」而是「失去目标信息」了。
   */
  it('★★ 密度为 0 时当前目标的姓名板仍然显示（15.2）', () => {
    const s = settings({ namePlateDensity: 0 });
    expect(showNamePlate(opts(9, true), s)).toBe(true);
    expect(showNamePlate(opts(0, false), s)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════

describe('界面缩放与镜头震动', () => {
  it('界面缩放被夹在可读区间内', () => {
    expect(clampUiScale(0.1)).toBe(UI_SCALE_MIN);
    expect(clampUiScale(99)).toBe(UI_SCALE_MAX);
    expect(clampUiScale(1.5)).toBe(1.5);
  });

  /** ★ 17.2 只要求「减弱」震动，但 0 是允许的 —— 震动不携带战斗信息 */
  it('★ 镜头震动可以完全关闭（震动不携带战斗信息，关掉不影响公平）', () => {
    expect(shakeAmplitude(1, settings({ cameraShake: 0 }))).toBe(0);
    expect(shakeAmplitude(1, settings({ cameraShake: 0.5 }))).toBeCloseTo(0.5, 6);
    expect(shakeAmplitude(1, settings({ cameraShake: 1 }))).toBe(1);
  });

  it('震动系数越界时被夹回 [0,1]', () => {
    expect(shakeAmplitude(1, settings({ cameraShake: 5 }))).toBe(1);
    expect(shakeAmplitude(1, settings({ cameraShake: -3 }))).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════

describe('持久化', () => {
  const fakeStorage = (initial?: string) => {
    let value = initial;
    return {
      getItem: () => value ?? null,
      setItem: (_k: string, v: string) => { value = v; },
      read: () => value,
    };
  };

  it('存进去再读出来是同一份设置', () => {
    const s = settings({ colorblind: ColorblindMode.Deuteranopia, uiScale: 1.4, cameraShake: 0 });
    const storage = fakeStorage();
    saveAccessibility(storage, s);
    expect(loadAccessibility(storage)).toEqual(s);
  });

  it('没有存过时用默认值', () => {
    expect(loadAccessibility(fakeStorage())).toEqual(DEFAULT_ACCESSIBILITY);
  });

  /** ★ 一份坏掉的设置不该让游戏打不开 */
  it('★ 损坏的 JSON 回落到默认值而不是抛异常', () => {
    expect(loadAccessibility(fakeStorage('{不是 json'))).toEqual(DEFAULT_ACCESSIBILITY);
  });

  it('★ 越界或伪造的值被规范化，不会带进运行时', () => {
    const storage = fakeStorage(JSON.stringify({
      colorblind: '我瞎编的', uiScale: 999, cameraShake: -5,
      namePlateDensity: 42, effectQuality: 'ultra',
    }));
    const s = loadAccessibility(storage);
    expect(s.colorblind).toBe(ColorblindMode.Off);
    expect(s.uiScale).toBe(UI_SCALE_MAX);
    expect(s.cameraShake).toBe(0);
    expect(s.namePlateDensity).toBe(1);
    expect(s.effectQuality).toBe('high');
  });

  it('没有 storage（SSR / 隐私模式）时不崩', () => {
    expect(loadAccessibility(undefined)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(() => saveAccessibility(undefined, DEFAULT_ACCESSIBILITY)).not.toThrow();
  });
});
