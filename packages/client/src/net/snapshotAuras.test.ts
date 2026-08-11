/**
 * X17 联网侧的光环投影（`AuraSnapshot` → `HudAura`）。
 *
 * ★★ 这一支钉的是**诚实**而不是形状：快照里没有 buff/debuff 向、没有名字。
 *   X17 时的诚实是「如实说不知道」；X26 之后诚实换了一种形式 ——
 *   **数据里写着的那些照实说，表外的仍然说不知道**。两头都不许臆测：
 *   编一个 kind 出来，玩家就会按增益/减益的边框色做决策，
 *   而那个颜色来自客户端的猜测；反过来，明明查得出来还报 unknown，
 *   则是把玩家手里本来就有的信息藏起来。
 */

import { describe, expect, it } from 'vitest';
import { HIDDEN_AURA_ID, School, type AuraSnapshot } from '@wowpvp/shared';

import { auraDefById, auraRegistryIds, auraSchoolById } from '../data/auraRegistry.js';
import { toHudAura } from './SnapshotCombatView.js';

const snap = (over: Partial<AuraSnapshot> = {}): AuraSnapshot => ({
  auraId: 'mage.frostbolt.chill',
  ...over,
});

describe('toHudAura', () => {
  it('★★ X26 正面用例：数据里写着的光环报得出真实的向（此前一律 unknown）', () => {
    // 寒冷藏在 `mage.frostbolt` 的 `lockedProjectile.onHit` 里（铁律⑦）——
    // 注册表递归下探得到它，于是联网局的光环行终于画得出红框 + `－` 角标
    expect(toHudAura(snap()).kind).toBe('debuff');
    expect(toHudAura(snap({ auraId: 'mage.ice_barrier' })).kind).toBe('buff');
  });

  it('★★ 注册表外的 id 仍然 unknown —— 兜底一条都不许删', () => {
    // sim 现造的光环（将来新加的系统光环）在数据表里根本没有条目
    expect(toHudAura(snap({ auraId: 'sim.invented.at.runtime' })).kind).toBe('unknown');
    expect(toHudAura(snap({ auraId: 'sim.invented.at.runtime' })).name).toBeUndefined();
  });

  it('★ `control.*` 例外：那个 id 是 sim 自己拼的，同处写死 debuff（结构事实）', () => {
    expect(toHudAura(snap({ auraId: 'control.stun' })).kind).toBe('debuff');
    expect(toHudAura(snap({ auraId: 'control.root' })).kind).toBe('debuff');
  });

  it('★★ S7 掩码：连「是增益还是减益」都不从旁边漏出去', () => {
    const a = toHudAura(snap({ auraId: HIDDEN_AURA_ID, school: School.Shadow }));
    expect(a.kind).toBe('unknown');
    expect(a.id).toBe(HIDDEN_AURA_ID);
    // X26 收紧点：掩码**连注册表都不许查**，所以名字也一个字都不给
    expect(a.name, '掩码光环被查出了名字 —— 等于把服务器刚抹掉的来源说回来')
      .toBeUndefined();
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

  it('★★ X26 正面用例：name 是**光环自己的名字**，不是施加它的技能名', () => {
    // 旧启发式（id 去掉最后一段查技能）会给出「寒冰箭」—— 那是技能名。
    // 注册表给的是 `AuraDef.name`，玩家在光环行上看到的是「寒冷」
    expect(toHudAura(snap()).name).toBe('寒冷');
    expect(toHudAura(snap({ auraId: 'warrior.mortal_wounds' })).name).toBe('致死创伤');
  });

  it('★ `control.*` 照旧不填 name —— 「昏迷」是 sim 的内部分类名，不是光环名', () => {
    expect(toHudAura(snap({ auraId: 'control.stun' })).name).toBeUndefined();
    expect(toHudAura(snap({ auraId: 'control.stun' })).kind).toBe('debuff');
  });

  it('★ 快照没带学派时由注册表补上（chip 取色终于不是一片灰）', () => {
    // `visibility.ts` 只给**控制类**光环带 school（P11 字节预算），
    // 而 id 没被掩掉就意味着这枚光环是公开的 —— 学派从本地数据推出来不多说一个字
    expect(toHudAura(snap()).school).toBe(School.Frost);
    // 快照带了就以快照为准：那是服务器**施加时**算出来的实际学派，更权威
    expect(toHudAura(snap({ school: School.Shadow })).school).toBe(School.Shadow);
  });
});

/**
 * ★★ **X26 收口：「这枚光环是什么颜色」只许有一个答案。**
 *
 *   X26 给联网侧的 `toHudAura` 加了第三级回落「`def.school` 查不到就问
 *   **施加它的技能**」，而本地侧 `LocalCombatView.hudAurasOf` 仍然只填
 *   `a.def.school` —— 实测**63 枚光环里有 53 枚**自己不写 `school`
 *   （断筋、致死创伤、剑刃风暴、审判、毒刃…）。于是同一枚断筋在试验场是
 *   中性灰 `#9aa3b6`、在联网局是钢铁色 `#d8cbb4`：判据从一处变成了两处，
 *   而 `vfx/debuffAura.ts` 里刚写下「两条路各写一遍迟早会漂，玩家只会发现
 *   『单机是冰蓝的、联机是灰的』」。
 *
 * ★ 这一条对着**整张注册表**比，而不是挑几枚：单边用例（上面那一支）
 *   109 条全绿也照不出两条投影之间的分歧 —— 它只测了其中一条。
 */
describe('★★ 同一 auraId 经两条投影得到同一个 school（X26 收口门禁）', () => {
  it('★★ 全注册表逐枚一致（本地判据 = 联网判据）', () => {
    const diverged: string[] = [];
    for (const id of auraRegistryIds()) {
      // 本地：`LocalCombatView.hudAurasOf` 的那一行（实例 > 注册表）
      const local = auraDefById(id)?.school ?? auraSchoolById(id);
      // 联网：快照不带 school 时的 `toHudAura`
      const net = toHudAura(snap({ auraId: id })).school;
      if (local !== net) diverged.push(`${id}: 本地=${local} 联网=${net}`);
    }
    expect(diverged, '两条投影对同一枚光环给出了不同的学派色').toEqual([]);
  });

  it('★★ 正面：53 枚自己不写 school 的光环确实推得出来（不是「两边同样是空」）', () => {
    const derived = auraRegistryIds()
      .filter((id) => auraDefById(id)?.school === undefined && auraSchoolById(id) !== undefined);
    expect(derived.length, '回落整个失效了 —— 上面那条会变成「两边同样一片灰」也绿')
      .toBeGreaterThan(40);
    // 逐条点名几枚玩家最常看到的
    expect(auraSchoolById('warrior.hamstring')).toBe(School.Physical);
    expect(auraSchoolById('warrior.mortal_wounds')).toBe(School.Physical);
    expect(auraSchoolById('paladin.judgement')).toBe(School.Holy);
  });
});
