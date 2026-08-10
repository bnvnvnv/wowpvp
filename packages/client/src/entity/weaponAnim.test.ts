/**
 * 武器 → 攻击片段的选择（W14 余账，用户实测「没有看到有拿武器攻击」）。
 *
 * ★★ 这一批断言的形态是**逐件武器**而不是「逐个分支」：分支覆盖只能证明
 *   `case 'dualWield'` 会返回双持片段，证明不了**匕首这件武器**会被认成双持。
 *   而两个字段（`handedness` / `isRanged`）的组合恰恰在真实数据里各种打架 ——
 *   法杖是 `staff` 且远程、圣典是 `oneHand` 且远程、猎人的弓是 `ranged`
 *   而法师的魔杖也是 `ranged`。逐件盯住，才是「实际选中了什么」的证据。
 */

import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '@wowpvp/shared';

import {
  SWING_TARGET_SECONDS,
  swingClipsFor,
  swingStyleFor,
  swingTimeScaleFor,
  type SwingStyle,
} from './weaponAnim.js';

/** 八个玩家模型共有的 22 个片段（从 GLB 逐个 dump 核对，A14 之鉴：不许写不存在的名字）*/
const REAL_CLIPS = new Set([
  'Death_A', 'Hit_A', 'Idle', 'Jump_Idle', 'Running_A', 'Walking_A',
  'Running_Strafe_Left', 'Running_Strafe_Right', 'Walking_Backwards',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '2H_Melee_Attack_Chop',
  'Block', 'Dualwield_Melee_Attack_Chop', '2H_Ranged_Shoot',
  'Spellcast_Raise', 'Spellcast_Shoot', 'Spellcasting',
  'Cheer', 'Lie_Idle', 'Sit_Floor_Down', 'Sit_Floor_Idle',
]);

/** 期望口径：武器 id → 攻击风格。**每一件**注册武器都在表里（下面有全覆盖断言）*/
const EXPECTED: Readonly<Record<string, SwingStyle>> = {
  // 单手：剑盾 / 匕首小圆盾 / 符文剑骨盾 / 法刃 / 权杖圣典 / 回旋斧
  'warrior.sword_shield': 'oneHand',
  'paladin.sword_shield': 'oneHand',
  'deathknight.runeblade_boneshield': 'oneHand',
  'rogue.dagger_buckler': 'oneHand',
  'mage.spellblade_focus': 'oneHand',
  'druid.mace_totem': 'oneHand',
  'ffa.boomerang_axe': 'oneHand',
  // 双持
  'warrior.dual_swords': 'dualWield',
  'deathknight.dual_runeblades': 'dualWield',
  'rogue.dual_daggers': 'dualWield',
  'rogue.dual_swords': 'dualWield',
  // 双手（含长柄、BOSS 巨锤）
  'warrior.greatsword': 'twoHand',
  'paladin.two_hand_hammer': 'twoHand',
  'deathknight.runeblade_2h': 'twoHand',
  'druid.polearm': 'twoHand',
  'boss.molten_maul': 'twoHand',
  'ffa.colossus_hammer': 'twoHand',
  // 弓 / 弩
  'hunter.short_bow': 'bow',
  'hunter.long_bow': 'bow',
  'hunter.heavy_crossbow': 'bow',
  'ffa.drumstick_bow': 'bow',
  // 施法器：法杖 / 魔杖 / 权杖圣典 —— handedness 里混在 staff/ranged/oneHand 三档
  'mage.staff': 'spell',
  'mage.wand_orb': 'spell',
  'priest.two_hand_staff': 'spell',
  'priest.scepter_codex': 'spell',
  'priest.wand_relic': 'spell',
  'paladin.scepter_codex': 'spell',
  'druid.nature_staff': 'spell',
  'ffa.colossus_staff': 'spell',
};

describe('W14 武器 → 攻击风格（逐件）', () => {
  it('★★ 注册表里每一件武器都被这张表盯着（新武器 = 红灯）', () => {
    const ids = [...WEAPON_BY_ID.keys()].sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(ids);
  });

  for (const [id, style] of Object.entries(EXPECTED)) {
    it(`★ ${id} → ${style}`, () => {
      expect(swingStyleFor(id)).toBe(style);
    });
  }

  it('★★ 弓与魔杖都是 isRanged，但不共用动作（拿魔杖不许做拉弓）', () => {
    expect(WEAPON_BY_ID.get('hunter.long_bow')?.isRanged).toBe(true);
    expect(WEAPON_BY_ID.get('mage.wand_orb')?.isRanged).toBe(true);
    expect(swingClipsFor(swingStyleFor('hunter.long_bow'))[0]).toBe('2H_Ranged_Shoot');
    expect(swingClipsFor(swingStyleFor('mage.wand_orb'))[0]).toBe('Spellcast_Shoot');
  });

  it('★ 徒手 / 未知 id → unarmed（BOSS 拿武器之前也走这条）', () => {
    expect(swingStyleFor(undefined)).toBe('unarmed');
    expect(swingStyleFor('nope.not_a_weapon')).toBe('unarmed');
  });
});

describe('W14 攻击风格 → 候选片段', () => {
  const STYLES: readonly SwingStyle[] = ['unarmed', 'oneHand', 'dualWield', 'twoHand', 'bow', 'spell'];

  it('★★ A14 之鉴：候选表里没有一个模型里不存在的片段名', () => {
    const bogus = STYLES
      .flatMap((s) => [...swingClipsFor(s, 0), ...swingClipsFor(s, 1)])
      .filter((n) => !REAL_CLIPS.has(n));
    expect([...new Set(bogus)], '候选表写了模型里没有的片段（死分支）').toEqual([]);
  });

  it('★★ 首选片段逐风格：这才是「大剑不再抡单手斜劈」的判据', () => {
    expect(swingClipsFor('dualWield')[0]).toBe('Dualwield_Melee_Attack_Chop');
    expect(swingClipsFor('twoHand')[0]).toBe('2H_Melee_Attack_Chop');
    expect(swingClipsFor('bow')[0]).toBe('2H_Ranged_Shoot');
    expect(swingClipsFor('spell')[0]).toBe('Spellcast_Shoot');
    expect(swingClipsFor('oneHand')[0]).toBe('1H_Melee_Attack_Slice_Diagonal');
    expect(swingClipsFor('unarmed')[0]).toBe('1H_Melee_Attack_Slice_Diagonal');
  });

  it('★ 单手片段按挥砍序号奇偶交替（连播同一刀会读成贴图循环）', () => {
    expect(swingClipsFor('oneHand', 0)[0]).toBe('1H_Melee_Attack_Slice_Diagonal');
    expect(swingClipsFor('oneHand', 1)[0]).toBe('1H_Melee_Attack_Chop');
    expect(swingClipsFor('oneHand', 2)[0]).toBe('1H_Melee_Attack_Slice_Diagonal');
    // 双持的首选不受交替影响，交替只作用在兜底位
    expect(swingClipsFor('dualWield', 1)[0]).toBe('Dualwield_Melee_Attack_Chop');
    expect(swingClipsFor('dualWield', 1)[1]).toBe('1H_Melee_Attack_Chop');
  });

  it('★ 每个风格都有兜底候选（13.4：缺专属动作时用最接近的）', () => {
    for (const s of STYLES) expect(swingClipsFor(s).length).toBeGreaterThanOrEqual(2);
  });
});

describe('W14 挥砍倍速：要在下一刀之前播完', () => {
  it('★★ 双持匕首 0.7 秒一刀，1.27 秒的片段必须被压进节奏里', () => {
    const ts = swingTimeScaleFor(1.267, 'rogue.dual_daggers');
    expect(1.267 / ts, '播不完就只看得见抬手，永远看不到落刀').toBeLessThanOrEqual(0.7);
  });

  it('★ 慢武器不被拖慢：1H 剑盾仍是旧的 ~0.8 秒手感', () => {
    const ts = swingTimeScaleFor(1.067, 'warrior.sword_shield');
    expect(1.067 / ts).toBeCloseTo(SWING_TARGET_SECONDS, 2);
  });

  it('★ 倍速永远 ≥ 1（不把素材放慢成卡顿）且 ≤ 2.4（不抽搐）', () => {
    for (const w of WEAPON_BY_ID.values()) {
      for (const d of [0.5, 1.0, 1.633, 4]) {
        const ts = swingTimeScaleFor(d, w.id as string);
        expect(ts, `${w.id} @${d}s`).toBeGreaterThanOrEqual(1);
        expect(ts, `${w.id} @${d}s`).toBeLessThanOrEqual(2.4);
      }
    }
  });

  it('★ 没有武器 / 时长为 0 也给得出一个正常倍速（不 NaN、不除零）', () => {
    expect(swingTimeScaleFor(1.067, undefined)).toBeCloseTo(1.067 / SWING_TARGET_SECONDS, 5);
    expect(swingTimeScaleFor(0, 'rogue.dual_daggers')).toBe(1);
    expect(Number.isFinite(swingTimeScaleFor(1, 'nope.not_a_weapon'))).toBe(true);
  });
});
