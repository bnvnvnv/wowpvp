/**
 * 10.8 护甲横向方案工厂。
 *
 * 五种原型的「优势/代价」结构对所有职业一致（17.1：临时装备必须横向取舍，
 * 不能同时提高伤害、攻速、防御、移动和控制），只有数值幅度可按职业微调。
 * 用工厂生成而不是手写 8×6 个对象，可以保证没有任何一件是全面上位（验收 #32）。
 */

import { ArmorArchetype } from '../types/enums.js';
import { asArmorId, type ArmorId, type ClassId } from '../types/ids.js';
import type { AuraModifiers, ArmorDef } from './schema.js';

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
    modifiers: { damageTaken: 1.12 },
    advantage: '法术伤害与魔法控制承受降低',
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

/** 抗法型的减伤只对法术生效，sim 层按 school 区分；这里单列出来避免误用为全局减伤 */
export const SPELLWARD_MAGIC_DAMAGE_TAKEN = 0.82;
export const SPELLWARD_MAGIC_CC_DURATION = 0.8;

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
    archetype: ArmorArchetype.Guardian,
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
