/**
 * 10.8 护甲横向方案工厂。
 *
 * 五种原型的「优势/代价」结构对所有职业一致（17.1：临时装备必须横向取舍，
 * 不能同时提高伤害、攻速、防御、移动和控制），只有数值幅度可按职业微调。
 * 用工厂生成而不是手写 8×6 个对象，可以保证没有任何一件是全面上位（验收 #32）。
 */

import { ArmorArchetype, School, isMagicSchool } from '../types/enums.js';
import { asArmorId, type ArmorId, type ClassId } from '../types/ids.js';
import type { AuraModifiers, ArmorDef } from './schema.js';

/** 抗法型的减伤只对法术生效，按 school 区分，不能写成全局 damageTaken */
export const SPELLWARD_MAGIC_DAMAGE_TAKEN = 0.82;
/**
 * 抗法型对**魔法控制**时长的削减。
 *
 * ★ M11 已接入。此前它是个**只定义、无人引用**的常量：schema 当时只有全局的
 *   `ccDurationTaken`，写成全局 0.8 会让抗法护甲顺带削减物理控制 ——
 *   那是抗控型（Tenacity）的身份，两件护甲会互相踩线，而 10.9 / 验收 #32
 *   要求「没有任何一件是全面上位」。当时的选择是**宁可少表达一半优势，
 *   也不要表达错**，于是 advantage 文案收窄成只提伤害。
 *
 *   现在 `ccDurationTakenBySchool` 进了 schema（判据：「按学派区分」这个
 *   需求出现了第二次），`applyControl()` 也能从 `SkillDef.school` 拿到学派，
 *   所以这一半优势可以正确表达了。
 */
export const SPELLWARD_MAGIC_CC_DURATION = 0.8;

const MAGIC_SCHOOLS: readonly School[] = Object.values(School).filter(isMagicSchool);

interface ArchetypeTemplate {
  suffix: string;
  name: string;
  archetype: ArmorArchetype;
  modifiers: AuraModifiers;
  advantage: string;
  cost: string;
}

const TEMPLATES: readonly ArchetypeTemplate[] = [
  {
    suffix: 'offense',
    name: '进攻型护甲',
    archetype: ArmorArchetype.Offense,
    modifiers: { damageDealt: 1.12, resourceGain: 1.15, damageTaken: 1.08, healingTaken: 0.92 },
    advantage: '攻击、法术与资源效率提高',
    cost: '防御下降，受到的治疗降低',
  },
  {
    suffix: 'guardian',
    name: '守护型护甲',
    archetype: ArmorArchetype.Guardian,
    modifiers: { damageTaken: 0.85, block: 0.1, moveSpeed: 0.93, attackSpeed: 1.08, castSpeed: 1.08 },
    advantage: '物理防御与爆发承受能力提高',
    cost: '移动、攻速与施法速度降低',
  },
  {
    suffix: 'mobility',
    name: '机动型护甲',
    archetype: ArmorArchetype.Mobility,
    modifiers: { moveSpeed: 1.12, damageTaken: 1.1, knockbackTaken: 1.25 },
    advantage: '移动与追击能力提高',
    cost: '基础防御与击退抵抗降低',
  },
  {
    suffix: 'spellward',
    name: '抗法型护甲',
    archetype: ArmorArchetype.SpellWard,
    /**
     * ★ 全局 `damageTaken: 1.12` 是**代价**（物理防御降低），
     *   优势由 `damageTakenBySchool` 逐个魔法学派给出。
     *
     *   顺序很重要：`damageTakenFor()` 让单列的学派**覆盖**全局值，
     *   所以魔法伤害吃 0.82、物理伤害吃 1.12，正是 10.8 要的横向取舍。
     *   写成单一的全局 damageTaken 会让抗法护甲连物理伤害一起减
     *   （schema v1.1 加 damageTakenBySchool 的原话就是这个理由）。
     */
    modifiers: {
      damageTaken: 1.12,
      damageTakenBySchool: MAGIC_SCHOOLS.reduce<Partial<Record<School, number>>>(
        (acc, s) => ((acc[s] = SPELLWARD_MAGIC_DAMAGE_TAKEN), acc),
        {},
      ),
      // ★ 只削减**魔法**控制。物理控制（拳击、冲锋昏迷…）不受影响 ——
      //   那是抗控型护甲的领域，两者不能互相取代（10.9 / 验收 #32）
      ccDurationTakenBySchool: MAGIC_SCHOOLS.reduce<Partial<Record<School, number>>>(
        (acc, s) => ((acc[s] = SPELLWARD_MAGIC_CC_DURATION), acc),
        {},
      ),
    },
    advantage: '法术伤害与魔法控制时长降低',
    cost: '物理防御明显降低',
  },
  {
    suffix: 'tenacity',
    name: '抗控型护甲',
    archetype: ArmorArchetype.Tenacity,
    modifiers: { ccDurationTaken: 0.75, knockbackTaken: 0.6, damageDealt: 0.9, healingDone: 0.9, resourceGain: 0.9 },
    advantage: '控制持续时间与击退距离降低',
    cost: '输出、治疗与资源效率降低',
  },
];

export interface ArmorSetOptions {
  /** 职业默认护甲的名字，例如「板甲」「皮甲」 */
  defaultName: string;
  /** 默认护甲的数值修正，默认无修正（标准化基线）*/
  defaultModifiers?: AuraModifiers;
  /** 按 suffix 覆写某个原型的数值 */
  overrides?: Partial<Record<string, Partial<ArchetypeTemplate>>>;
}

/**
 * 生成一个职业的全部护甲方案：1 套默认（不可删除、永不掉落）+ 5 套横向临时方案。
 */
export const makeArmorSet = (classId: ClassId, opts: ArmorSetOptions): ArmorDef[] => {
  const defaultArmor: ArmorDef = {
    id: asArmorId(`${classId}.default`),
    name: opts.defaultName,
    classId,
    isDefault: true,
    archetype: ArmorArchetype.Baseline,
    modifiers: opts.defaultModifiers ?? {},
    advantage: '标准化基线，无任何倾向',
    cost: '没有专精优势',
    appearance: `${classId}_default`,
  };

  const variants = TEMPLATES.map((t): ArmorDef => {
    const o = opts.overrides?.[t.suffix];
    return {
      id: asArmorId(`${classId}.${t.suffix}`),
      name: `${opts.defaultName}·${o?.name ?? t.name}`,
      classId,
      isDefault: false,
      archetype: t.archetype,
      modifiers: { ...t.modifiers, ...o?.modifiers },
      advantage: o?.advantage ?? t.advantage,
      cost: o?.cost ?? t.cost,
      appearance: `${classId}_${t.suffix}`,
    };
  });

  return [defaultArmor, ...variants];
};

export const defaultArmorIdOf = (classId: ClassId): ArmorId => asArmorId(`${classId}.default`);
