/**
 * 战场装备对比的纯函数单测。规格书 15.3 第三条，验收 #35。
 *
 * ★ 为什么单独开一个文件而不是塞进 `hud.test.ts`：
 *   那边的用例全部拿**真实职业数据**（`mage.weapons`）当输入，验的是
 *   「对任意两把真武器都不会输出垃圾」。而 P8 新加的 modifiers 差异行有
 *   八个分支（乘算 5 条 + 加算 3 条）和一条 `lowerIsBetter` 反向规则，
 *   真数据里凑不齐、也不该为了凑测试去改平衡数值 —— 所以这里用**合成
 *   WeaponDef**逐条钉死，两边分工不重叠。
 *
 * ★★ 这里唯一真正会"骗玩家"的地方是 `lowerIsBetter`：受到伤害 100%→110%
 *   数字在涨，但对玩家是**变差**。箭头写反不会让任何断言变红、也不会
 *   崩溃，只会让玩家照着 ↑ 捡一件更脆的装备。所以这条单独一个用例。
 */

import { describe, expect, it } from 'vitest';
import {
  ArmorArchetype,
  asArmorId,
  asClassId,
  asWeaponId,
  type ArmorDef,
  type WeaponDef,
} from '@wowpvp/shared';
import { compareArmors, compareWeapons } from './LoadoutPanel.js';

/**
 * 最小可用 `WeaponDef`：只填 schema.ts 里的必填字段，
 * 数值抄自 `data/classes/warrior.ts` 的「单手剑 + 盾牌」，
 * 免得凭空编一组三围（编出来的数字会让"这行差异该不该出现"变得没法讲）。
 */
const weapon = (over: Partial<WeaponDef> = {}): WeaponDef => ({
  id: asWeaponId('test.weapon'),
  name: '测试武器',
  classId: asClassId('warrior'),
  isDefault: false,
  handedness: 'oneHand',
  swingInterval: 1.7,
  swingPercent: 0.9,
  reach: 2.8,
  advantage: '测试夹具，不参与平衡',
  cost: '测试夹具，不参与平衡',
  ...over,
});

/** 最小可用 `ArmorDef`。基线原型 = 无任何倾向（10.6 的默认护甲档） */
const armor = (over: Partial<ArmorDef> = {}): ArmorDef => ({
  id: asArmorId('test.armor'),
  name: '测试护甲',
  classId: asClassId('warrior'),
  isDefault: false,
  archetype: ArmorArchetype.Baseline,
  modifiers: {},
  advantage: '测试夹具，不参与平衡',
  cost: '测试夹具，不参与平衡',
  ...over,
});

describe('★ 15.3 第三条 compareWeapons —— P8 补上的 modifiers 差异行', () => {
  // 三围完全相同，差别只在 modifiers：P8 之前这两把武器比出来是**空列表**，
  // 即玩家看到的是「没有区别」，而实际上暴击轴和承伤都变了
  const current = weapon({ id: asWeaponId('test.plain'), name: '素装' });
  const candidate = weapon({
    id: asWeaponId('test.crit'),
    name: '暴击刀',
    modifiers: { critChance: 0.1, critDamage: 1.2, damageTaken: 1.1 },
  });

  it('★ 暴击几率是**加算**类：缺省基数 0，写成 +0% → +10%', () => {
    // 加算与乘算的基数不同（0 vs 1）。写错基数会得到「+100% → +110%」
    // 这种既不报错也完全没意义的一行
    expect(compareWeapons(current, candidate)).toContain('↑ 暴击几率 +0% → +10%');
  });

  it('★ 暴击伤害是**乘算**类：缺省基数 100%，写成 100% → 120%', () => {
    expect(compareWeapons(current, candidate)).toContain('↑ 暴击伤害 100% → 120%');
  });

  it('★★ 受到伤害升高 = 变差，箭头必须朝下（lowerIsBetter 反向规则）', () => {
    expect(compareWeapons(current, candidate)).toContain('↓ 受到伤害 100% → 110%');
  });

  it('三围相同时一条三围差异都不出 —— 只列真正变了的项', () => {
    const diff = compareWeapons(current, candidate);
    for (const label of ['攻击距离', '攻击间隔', '单次伤害', '类型']) {
      expect(diff.some((l) => l.includes(label)), label).toBe(false);
    }
    // 改了三项 modifiers，就正好三行，不多也不少
    expect(diff).toHaveLength(3);
  });

  it('没有当前武器时给「新武器」，不给一屏差异行', () => {
    expect(compareWeapons(undefined, candidate)).toEqual(['新武器：暴击刀']);
  });
});

describe('★ 15.3 第三条 compareWeapons —— 三围仍在比（P8 没把老路径挤掉）', () => {
  const current = weapon();

  it('攻击距离 / 攻击间隔 / 单次伤害 各出一条，带单位', () => {
    const diff = compareWeapons(
      current,
      // 数值取「双手巨剑」档：更远、更慢、更重
      weapon({ reach: 3.4, swingInterval: 2.4, swingPercent: 1.55 }),
    );
    expect(diff).toContain('↑ 攻击距离 2.8m → 3.4m');
    // ★ P8 修正：攻击间隔变长 = 攻速变慢 = 变差 → 箭头朝下（lowerIsBetter），
    //   与 modifiers/护甲侧同一条口径 —— 箭头是好坏方向，不是数值方向
    expect(diff).toContain('↓ 攻击间隔 1.7s → 2.4s');
    // swingPercent 是倍率（1.55 = 155%），换算成百分数才好读
    expect(diff).toContain('↑ 单次伤害 90% → 155%');
    expect(diff).toHaveLength(3);
  });

  it('单手 → 双手 用 ⇄ 而不是 ↑↓：类型变化没有高低之分', () => {
    expect(compareWeapons(current, weapon({ handedness: 'twoHand' }))).toContain(
      '⇄ 类型 单手 → 双手',
    );
  });
});

describe('★ 15.3 第三条：差异行截断到 6 行（换装窗口只有 0.8 秒）', () => {
  it('★ 三围 + 类型 + 八项 modifiers 共 12 行，只留前 6 行', () => {
    const diff = compareWeapons(
      weapon(),
      weapon({
        reach: 3.4,
        swingInterval: 2.4,
        swingPercent: 1.55,
        handedness: 'twoHand',
        modifiers: {
          damageDealt: 1.2,
          damageTaken: 1.1,
          moveSpeed: 0.9,
          resourceGain: 1.15,
          critDamage: 1.2,
          critChance: 0.1,
          block: 0.2,
          parry: 0.05,
        },
      }),
    );
    expect(diff).toHaveLength(6);
    // 留下的必须是完整的行，不能截出半行来
    for (const line of diff) expect(line, line).toMatch(/^[↑↓⇄] /);
  });
});

describe('★ compareArmors 原行为不回退（P8 只动了武器侧）', () => {
  it('★★ 受到伤害**降低** = 变好，箭头朝上', () => {
    const diff = compareArmors(
      armor({ modifiers: { damageTaken: 1 } }),
      armor({ modifiers: { damageTaken: 0.85 } }),
    );
    expect(diff).toContain('↑ 受到伤害 100% → 85%');
  });

  it('控制时长降低也是变好；移动速度则是数值越高越好', () => {
    const diff = compareArmors(
      armor({ modifiers: {} }),
      armor({ modifiers: { ccDurationTaken: 0.8, moveSpeed: 1.1 } }),
    );
    expect(diff).toContain('↑ 控制时长 100% → 80%');
    expect(diff).toContain('↑ 移动速度 100% → 110%');
  });

  it('原型变化用 ⇄，且整体不超过 4 行', () => {
    const diff = compareArmors(
      armor(),
      armor({
        archetype: ArmorArchetype.Guardian,
        modifiers: { damageTaken: 0.85, moveSpeed: 0.95, ccDurationTaken: 0.9 },
      }),
    );
    expect(diff[0]).toBe('⇄ 原型 baseline → guardian');
    expect(diff.length).toBeLessThanOrEqual(4);
  });

  it('没有当前护甲时给「新护甲」', () => {
    expect(compareArmors(undefined, armor({ name: '板甲' }))).toEqual(['新护甲：板甲']);
  });
});
