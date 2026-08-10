/**
 * X17 联网侧的光环投影（`AuraSnapshot` → `HudAura`）。
 *
 * ★★ 这一支钉的是**诚实**而不是形状：快照里没有 buff/debuff 向、没有名字，
 *   投影敢不敢如实说「不知道」是 X17 在联网路径上唯一的判断题。
 *   编一个 kind 出来，玩家就会按增益/减益的边框色做决策 —— 而那个颜色
 *   来自客户端的臆测，不是服务器发的事实。
 */

import { describe, expect, it } from 'vitest';
import { HIDDEN_AURA_ID, School, type AuraSnapshot } from '@wowpvp/shared';

import { toHudAura } from './SnapshotCombatView.js';

const snap = (over: Partial<AuraSnapshot> = {}): AuraSnapshot => ({
  auraId: 'mage.frostbolt.chill',
  ...over,
});

describe('toHudAura', () => {
  it('★★ 查不到向的光环如实报 unknown —— 快照根本没带这个信息', () => {
    expect(toHudAura(snap()).kind).toBe('unknown');
  });

  it('★ `control.*` 例外：那个 id 是 sim 自己拼的，同处写死 debuff（结构事实）', () => {
    expect(toHudAura(snap({ auraId: 'control.stun' })).kind).toBe('debuff');
    expect(toHudAura(snap({ auraId: 'control.root' })).kind).toBe('debuff');
  });

  it('★★ S7 掩码：连「是增益还是减益」都不从旁边漏出去', () => {
    const a = toHudAura(snap({ auraId: HIDDEN_AURA_ID, school: School.Shadow }));
    expect(a.kind).toBe('unknown');
    expect(a.id).toBe(HIDDEN_AURA_ID);
  });

  it('expiresAt / stacks 省略时**不补默认值** —— 缺席本身是 P11 的口径', () => {
    const a = toHudAura(snap());
    expect(a.expiresAt).toBeUndefined(); // persistent：光环行因此不画倒计时
    expect(a.stacks).toBeUndefined(); // = 1，消费方按这个口径写的
  });

  it('带值的字段原样透传（到期时刻是**事实**，不换算成剩余量）', () => {
    const a = toHudAura(snap({ expiresAt: 128.5, stacks: 3, school: School.Frost }));
    expect(a.expiresAt).toBe(128.5);
    expect(a.stacks).toBe(3);
    expect(a.school).toBe(School.Frost);
  });

  it('14.3 护盾：吸收量两项都在（光环行据此画一条退下去的条）', () => {
    const a = toHudAura(snap({ auraId: 'priest.shield', absorbRemaining: 300, absorbInitial: 1200 }));
    expect(a.absorbRemaining).toBe(300);
    expect(a.absorbInitial).toBe(1200);
  });

  it('★ 一律不填 name —— 能查到的只有「施加它的技能」名，那不是光环名', () => {
    expect(toHudAura(snap()).name).toBeUndefined();
    expect(toHudAura(snap({ auraId: 'control.stun' })).name).toBeUndefined();
  });
});
