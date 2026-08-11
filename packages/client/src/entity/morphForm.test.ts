/**
 * X29：「画面上是不是小鸡」的判据统一（8.2 迷惑）。
 *
 * ★★ 这一族测试的存在理由是**实测到过的分家**：联网侧按单一光环 id
 *   （`'control.incapacitate'`）判，而气旋囚笼自带 id（`druid.cyclone`）——
 *   同一发技能，试验场是小鸡、联网局是人形角色边走边晃头
 *   （sim 按递减类别判「该游走」，所以他还在走；摇头的否决只否决小鸡，
 *   所以他还在晃）。判据本体现在只有一处：sim 的 `isMorphedFormAura`。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HIDDEN_AURA_ID, isMorphedFormAura } from '@wowpvp/shared';

import { auraDefById, indexedAuraIds } from '../vfx/debuffAura.js';
import { isMorphedByAuraIds, morphFormOfAuraId } from './morphForm.js';

const ids = (...list: string[]): { auraId: string }[] => list.map((auraId) => ({ auraId }));

describe('X29 · 快照侧的形态判据', () => {
  it('★ 化形术那一族（合成 id `control.incapacitate`）= 小鸡', () => {
    expect(isMorphedByAuraIds(ids('control.incapacitate'))).toBe(true);
  });

  it('★★ 气旋囚笼（自带 id `druid.cyclone`）= 小鸡 —— 修之前联网侧是人形', () => {
    const def = auraDefById('druid.cyclone');
    expect(def, '数据里找不到气旋囚笼的光环 —— 索引或技能数据变了').toBeDefined();
    expect(isMorphedFormAura(def!), '这枚光环本来就该被判成化形态').toBe(true);
    expect(
      isMorphedByAuraIds(ids('druid.cyclone')),
      '联网侧又漏了自带 id 的化形 —— 人形角色会边走边晃头',
    ).toBe(true);
  });

  it('★ 恐惧/昏迷/定身/沉默都不是化形（同属控制，但形态不同）', () => {
    for (const id of ['control.fear', 'control.stun', 'control.root', 'control.silence', 'control.disarm']) {
      expect(isMorphedByAuraIds(ids(id)), `${id} 被判成了小鸡`).toBe(false);
    }
  });

  it('★ S7 掩码与查不到的 id 一律不是化形（掩掉的东西不该反推出模型变化）', () => {
    expect(isMorphedByAuraIds(ids(HIDDEN_AURA_ID))).toBe(false);
    expect(isMorphedByAuraIds(ids('totally.unknown.aura'))).toBe(false);
    expect(morphFormOfAuraId('totally.unknown.aura')).toBeUndefined();
    expect(isMorphedByAuraIds([])).toBe(false);
  });

  it('★★ 与本地 sim 侧逐枚一致：索引里每一枚光环，两条路答案相同', () => {
    /**
     * 联网侧只有 id（反查 → 判据），本地 sim 侧手里就是 `AuraDef`（直接判据）。
     * 两条路必须对**每一枚**光环给同一个答案 —— 否则「单机是小鸡、
     * 联机是人形」那类漂移会重新长出来，而画面上没有任何断言会红。
     */
    for (const id of indexedAuraIds()) {
      const def = auraDefById(id)!;
      expect(isMorphedByAuraIds(ids(id)), `${id} 两条路不一致`).toBe(isMorphedFormAura(def));
    }
  });

  it('★ 一串光环里只要有一枚是化形就算（叠了 DoT 也还是小鸡）', () => {
    expect(isMorphedByAuraIds(ids('warlock.corruption', 'control.incapacitate'))).toBe(true);
  });
});

describe('★★ X29 · 接线锁：两个场景都问同一条判据', () => {
  /**
   * ★★ 场景类要 WebGL 才构造得出来，「判据又分了两份」既不是类型错误
   *   也不是运行时错误 —— 只会表现为「联机里被气旋的人是人形」，
   *   只能锁源码（与 `stunWobble.test.ts` 的接线锁同一手法）。
   */
  const sceneSrc = (file: string): string =>
    readFileSync(`${fileURLToPath(new URL('.', import.meta.url))}../scenes/${file}`, 'utf8');

  it('★★ 联网场景：自己与远端都走 `isMorphedByAuraIds`', () => {
    const src = sceneSrc('NetworkScene.ts');
    const hits = src.match(/setMorphed\(isMorphedByAuraIds\(/g) ?? [];
    expect(hits.length, '联网侧只接了一半（自己或远端漏了）').toBeGreaterThanOrEqual(2);
  });

  it('★★ 联网场景：不许再拿光环 id 跟字面常量比', () => {
    const src = sceneSrc('NetworkScene.ts');
    expect(src, '又出现了「按单一 id 判化形」—— 那正是气旋囚笼漏掉的成因')
      .not.toMatch(/===\s*'control\.|===\s*MORPH_AURA_ID/);
  });

  it('★★ 试验场：判据走 sim 的 `isMorphedFormAura`，不再手写递减类别比较', () => {
    const src = sceneSrc('TestbedScene.ts');
    expect(src).toMatch(/isMorphedFormAura\(a\.def\)/);
    expect(src, '手写的那份判据回来了').not.toMatch(/drCategory === DrCategory\.Incapacitate/);
  });
});
