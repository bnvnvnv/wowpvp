/**
 * X26：客户端光环注册表。用户 2026-08-11 拍板原话
 * 「体验上没区别就尽量减轻服务端负担」—— 两条出路里选了 ②（客户端建表），
 * 零协议改动、零带宽、零服务端 CPU。
 *
 * ★★ 本文件里分量最重的三条是**门禁**而不是功能：
 *   ① **覆盖率** —— 数据源码里写着的每一枚 `AuraDef` 都要进表。
 *      判据故意用**另一种方法**得出（直接扫源码文本），而不是把实现的
 *      深走再写一遍：两种方法都说 63 枚，才叫真的对上了。
 *   ② **撞 id** —— 同一个 id 两处定义成不同的 def 是数据 bug，测试要抓。
 *   ③ **S7** —— 掩码光环连表都不许查，一处都不许放宽。
 *
 * ★ 为什么覆盖率值得一条这么重的门禁：漏掉一枚的后果是**静默**的 ——
 *   那枚 debuff 在 HUD 上退回 unknown、图标退成色块、身上没有学派色壳，
 *   而画面不会报错、类型不会红、别的测试也不会红。铁律⑦记着 8 处同族翻车。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HIDDEN_AURA_ID, School } from '@wowpvp/shared';

import {
  auraDefById,
  auraEntryById,
  auraIdCollisions,
  auraKindById,
  auraNameById,
  auraRegistryIds,
  auraSkillById,
} from './auraRegistry.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SHARED_DATA = join(HERE, '../../../shared/src/data');

/**
 * 数据源码里出现过的每一个 `AuraDef` **字面量** id —— 与实现完全无关的第二条判据。
 *
 * ★ 手法：`dispelType: DispelType.X` 是 `AuraDef` 在整棵数据树里的**指纹**
 *   （8.4 的驱散归属，必填、别的类型都没有），逐个往上找最近的 `id: '...'`。
 *   字面量里 `id` 永远排在最前面，中间只隔着 name/kind/duration 这些标量与注释。
 * ⚠️ 刻意排除 `schema.ts`（那里的是接口定义与文档）与 `*.test.ts`。
 */
const auraIdsInSource = (): Set<string> => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('schema.ts')) files.push(p);
    }
  };
  walk(SHARED_DATA);

  const ids = new Set<string>();
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/dispelType:\s*DispelType\./.test(line)) return;
      for (let j = i; j >= 0; j--) {
        const m = /^\s*id:\s*'([^']+)'/.exec(lines[j]!);
        if (m) {
          ids.add(m[1]!);
          return;
        }
      }
      throw new Error(`${f}:${i + 1} 的 AuraDef 字面量往上找不到 id —— 扫描手法该改了`);
    });
  }
  return ids;
};

describe('★★ X26 门禁①：注册表覆盖率', () => {
  it('★★ 数据源码里的每一枚 AuraDef 都进了表 —— 漏一枚是静默的', () => {
    const inSource = auraIdsInSource();
    const inRegistry = new Set(auraRegistryIds());
    expect(inSource.size, '源码扫描一枚都没找到 —— 扫描手法失效了，这条门禁形同虚设')
      .toBeGreaterThan(50);
    const missing = [...inSource].filter((id) => !inRegistry.has(id));
    expect(
      missing,
      '这些光环写在数据里却查不到：要么深走漏了一种嵌套（铁律⑦），要么新来源没接进 buildRegistry',
    ).toEqual([]);
  });

  it('★ 反向也要对上：表里不许有源码里没有的 id（否则是把别的东西认成了光环）', () => {
    const inSource = auraIdsInSource();
    const extra = auraRegistryIds().filter((id) => !inSource.has(id));
    expect(extra, 'looksLikeAura 把非光环对象收进来了').toEqual([]);
  });

  it('★★ 铁律⑦：八种嵌套逐个取样，一种都不许漏', () => {
    // 每一条都是从真实数据里 dump 出来核对过的，不是编的 id
    const nested: readonly [string, string][] = [
      ['mage.frostbolt.chill', 'lockedProjectile.onHit —— W23 法术弹道迁移之后的主战场'],
      ['ffa.stardust', 'delayedGroundImpact.onImpact —— 陨星落地'],
      ['mage.blizzard.chill', 'spawnGroundArea.onTick —— 地面区域每跳'],
      ['deathknight.winter_domain_chill', 'onTick 里的第二枚，且 id 前两段不是技能 id'],
      ['hunter.serpent_sting.poison', 'onHit 里的毒（毒感知的学派色靠它）'],
      ['warrior.hamstring', '顶层 applyAura —— 最平凡的那一种也要在'],
      ['consumable.battle_draught', '消耗品：SKILL_BY_ID 一枚都覆盖不到这一池'],
      ['ffa.giant_growth', '大乱斗道具：PARTY_CONSUMABLES 是第二池'],
      ['boss.enrage', 'sim/boss.ts 直接施加，不经任何 applyAura'],
    ];
    for (const [id, where] of nested) {
      expect(auraDefById(id), `${id} 掉出注册表了（${where}）`).toBeDefined();
    }
  });

  it('★ 表的规模不许缩水 —— 掉数量是唯一会先冒头的症状', () => {
    expect(auraRegistryIds().length).toBeGreaterThanOrEqual(63);
  });
});

describe('★★ X26 门禁②：同一 id 不许两处定义不同的 def', () => {
  it('★★ 撞 id 清单恒为空（撞了就是数据 bug，不是表的问题）', () => {
    expect(
      auraIdCollisions().map((c) => `${c.id}：${c.sources.join(' 与 ')}`),
      '同一枚光环被两处写成了不同的数 —— 玩家看到哪一份取决于遍历顺序',
    ).toEqual([]);
  });

  it('★ 一枚多用是**合法**的，前提是定义一致 —— 门禁不许把它误判成撞 id', () => {
    // 潜行/消失共用 `rogue.stealth`（工厂函数，两个不同的对象、同样的内容），
    // 霜矢/冰枪术共用 `mage.frostbolt.chill`（同一个 const 对象）。
    // 两种「一枚多用」的写法都得放行，否则这条门禁一上线就是红的
    expect(auraDefById('rogue.stealth')?.kind).toBe('buff');
    expect(auraDefById('mage.frostbolt.chill')?.kind).toBe('debuff');
    expect(auraIdCollisions()).toEqual([]);
  });
});

describe('★★ X26 门禁③：S7 红线一处都不许放宽', () => {
  it('★★ 掩码光环连表都不许查 —— 查了等于从旁边漏', () => {
    expect(auraEntryById(HIDDEN_AURA_ID)).toBeUndefined();
    expect(auraDefById(HIDDEN_AURA_ID)).toBeUndefined();
    expect(auraSkillById(HIDDEN_AURA_ID)).toBeUndefined();
    expect(auraKindById(HIDDEN_AURA_ID), '掩码泄露了增益/减益向').toBeUndefined();
    expect(auraNameById(HIDDEN_AURA_ID), '掩码泄露了名字').toBeUndefined();
  });

  it('★ 表里也不该有这个 token（数据真起了个叫 hidden 的光环，上面那条才是最后一道）', () => {
    expect(auraRegistryIds()).not.toContain(HIDDEN_AURA_ID);
  });

  it('★★ 源码门禁：拦截写在**查表之前** —— 顺序错了这条红线就废了', () => {
    const src = readFileSync(join(HERE, 'auraRegistry.ts'), 'utf8');
    const body = /export const auraEntryById[\s\S]*?\n\};/.exec(src)?.[0] ?? '';
    expect(body.length, '找不到 auraEntryById —— 这条门禁失效了').toBeGreaterThan(0);
    expect(body).toContain('if (id === HIDDEN_AURA_ID) return undefined;');
    expect(
      body.indexOf('HIDDEN_AURA_ID'),
      '掩码拦截跑到查表后面去了',
    ).toBeLessThan(body.indexOf('.byId.get('));
  });
});

describe('★ X26：注册表答得出的三个问题', () => {
  it('★★ 增益/减益向 —— 这就是快照答不出、协议本来要加 1 bit 才有的那一位', () => {
    expect(auraKindById('mage.frostbolt.chill')).toBe('debuff');
    expect(auraKindById('mage.ice_barrier')).toBe('buff');
    expect(auraKindById('rogue.rupture.bleed')).toBe('debuff');
    // 表外的一律 undefined —— 调用方退 unknown，不许猜
    expect(auraKindById('control.stun')).toBeUndefined();
    expect(auraKindById('sim.invented.at.runtime')).toBeUndefined();
  });

  it('★ 玩家可见名是**光环自己的**名字，不是施加它的技能名', () => {
    expect(auraNameById('mage.frostbolt.chill')).toBe('寒冷');
    expect(auraSkillById('mage.frostbolt.chill')?.name).toBe('霜矢');
  });

  it('★★ 「是哪个技能施加的」—— 四条 id 前两段不是技能 id 的光环靠它才认得出', () => {
    // 旧启发式（id 去掉最后一段查技能）对这四条全部落空：
    // 图标退成色块、学派色退成中性灰。这一条就是那笔账
    const pairs: readonly [string, string][] = [
      ['warrior.mortal_wounds', 'warrior.mortal_strike'],
      ['deathknight.winter_domain_chill', 'deathknight.winter_domain'],
      ['ffa.greasy', 'ffa.drumstick_volley'],
      ['ffa.stardust', 'ffa.starfall'],
    ];
    for (const [auraId, skillId] of pairs) {
      expect(auraSkillById(auraId)?.id, `${auraId} 认不出是谁施加的`).toBe(skillId);
    }
  });

  it('★ 消耗品与 BOSS 狂暴没有施加技能 —— 如实空着，不硬凑一个', () => {
    expect(auraDefById('consumable.battle_draught')?.name).toBe('战斗药剂');
    expect(auraSkillById('consumable.battle_draught')).toBeUndefined();
    expect(auraSkillById('boss.enrage')).toBeUndefined();
  });

  it('★ 学派：定义里没写就退回施加技能的学派（光环行的 chip 取色吃这个）', () => {
    expect(auraSkillById('mage.frostbolt.chill')?.school).toBe(School.Frost);
    expect(auraSkillById('priest.shadow_word_pain.dot')?.school).toBe(School.Shadow);
  });
});
