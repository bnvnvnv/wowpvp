/**
 * 数据注册表。
 *
 * 新增一个职业只需两步：
 *   1. 新建 `classes/<职业>.ts` 并导出 `ClassDef`
 *   2. 在下面的 ALL_CLASSES 里加一行
 * 其余（按 id 查技能、查武器、完整性校验、文档生成）全部自动生效。
 */

import type {
  ArmorDef,
  ClassDef,
  SkillDef,
  WeaponDef,
} from './schema.js';
import type { ArmorId, ClassId, SkillId, WeaponId } from '../types/ids.js';

import { boss } from './classes/boss.js';
import { deathknight } from './classes/deathknight.js';
import { druid } from './classes/druid.js';
import { hunter } from './classes/hunter.js';
import { mage } from './classes/mage.js';
import { paladin } from './classes/paladin.js';
import { priest } from './classes/priest.js';
import { rogue } from './classes/rogue.js';
import { warrior } from './classes/warrior.js';
import {
  isPartyItemId, PARTY_CONSUMABLES, PARTY_SKILLS, PARTY_WEAPONS,
} from './party.js';

/** 八个首发职业（规格书 1.1）。顺序即 UI 中的展示顺序 */
export const ALL_CLASSES: readonly ClassDef[] = [
  warrior,
  paladin,
  deathknight,
  rogue,
  hunter,
  mage,
  priest,
  druid,
];

/**
 * **不可选**的特殊职业：场上会出现、但玩家选不到的实体（当前只有大 BOSS）。
 *
 * ★★ 分成两张表而不是给 `ClassDef` 加一个 `playable: boolean` 字段 ——
 *   因为「可选职业」的清单被**大量**地方当作穷尽集合使用：客户端的技能图标表
 *   （缺一个就红）、八属性技能签名、`ALL_SKILLS` 的 117 项下限、配平报告的
 *   对战矩阵、选人界面。多一个布尔字段，这些地方就要各自记得过滤一次，
 *   而**忘记过滤不会报错**，只会让 BOSS 悄悄出现在选人界面或让 CI 要求
 *   给一个永不上技能栏的技能配图标。两张表则相反：什么都不改的地方
 *   自动只看得见八个可选职业。
 *
 * ★ 特殊职业**进注册表**（下面的 `*_BY_ID`）：`getClass` / `getSkill` /
 *   `getWeapon` 必须查得到它，否则 sim 里 BOSS 的技能查不到定义、
 *   普攻查不到武器间隔 —— 那才是真正会静默出错的地方。
 */
export const SPECIAL_CLASSES: readonly ClassDef[] = [boss];

/** 注册表覆盖的全部职业 = 可选 + 特殊。★ 只有查表用它，清单类用途一律用 ALL_CLASSES */
const REGISTERED_CLASSES: readonly ClassDef[] = [...ALL_CLASSES, ...SPECIAL_CLASSES];

export { warrior, paladin, deathknight, rogue, hunter, mage, priest, druid, boss };
/** ★ BOSS 的 classId 单独导出：判断「这个实体是不是 BOSS」的唯一字面量来源 */
export { BOSS_CLASS_ID, BOSS_ENRAGE_AURA } from './classes/boss.js';

/** 大乱斗派对道具内容包（不属于任何职业，只从 FFA 掉落获得）*/
export * from './party.js';
/**
 * 消耗品目录。★ 此前只有 sim 内部按相对路径 import 得到它 ——
 * 于是客户端拿不到 `getConsumable`，地上的消耗品在 HUD 上只能显示 id。
 * 与武器/护甲一样从注册表出口暴露。
 */
export * from './consumables.js';

// ── 索引 ─────────────────────────────────────────────────────────

const buildIndex = <T>(items: Iterable<[string, T]>): ReadonlyMap<string, T> => {
  const m = new Map<string, T>();
  for (const [k, v] of items) m.set(k, v);
  return m;
};

export const CLASS_BY_ID: ReadonlyMap<string, ClassDef> = buildIndex(
  REGISTERED_CLASSES.map((c) => [c.id as string, c] as [string, ClassDef]),
);

/**
 * 玩家**能选**的职业（3.1 选人界面 / `selectClass` 的唯一判据）。
 *
 * ★★ 没有它的话，`selectClass` 里那句 `if (!getClass(classId))` 会**放行
 *   `classId: 'boss'`** —— 客户端点不出来，但协议是不受信任输入，
 *   一条手写消息就能让玩家顶着 15000 血和 470 伤害的巨锤开局。
 *   「注册表里有」和「玩家能选」从此是两件事，判据也就必须是两个。
 */
export const isPlayableClass = (id: ClassId): boolean =>
  ALL_CLASSES.some((c) => (c.id as string) === (id as string));

/**
 * ★★ `ALL_SKILLS` / `ALL_WEAPONS` 只含**可选职业池** —— 大 BOSS
 *   （SPECIAL_CLASSES）与大乱斗派对道具（`data/party.ts`）都刻意不在里面：
 *   这两个数组的既有读者全都在问「八个职业有什么」（验收 #31 的武器取舍、
 *   附录A#3 的九项标注、图标表/技能签名/配平矩阵的穷尽校验…），
 *   混进特殊内容那些断言问的就不再是它们想问的问题了。
 *
 * ★ 但**按 id 查得到**是另一回事：`getSkill()` / `getWeapon()` 是 sim 的
 *   唯一入口（`tickDepsOf` 把 `getSkill` 直接传给 `tickWorld`），查不到
 *   就等于「捡到了引擎不认识的武器」—— 表现是白字消失、技能放不出来
 *   且**没有任何报错**。所以两张索引表是**全注册职业池 ∪ 派对池**
 *   （REGISTERED_CLASSES 含 BOSS）。
 */
export const ALL_SKILLS: readonly SkillDef[] = ALL_CLASSES.flatMap((c) => c.skills);
export const SKILL_BY_ID: ReadonlyMap<string, SkillDef> = buildIndex(
  [...REGISTERED_CLASSES.flatMap((c) => c.skills), ...PARTY_SKILLS]
    .map((s) => [s.id as string, s] as [string, SkillDef]),
);

export const ALL_WEAPONS: readonly WeaponDef[] = ALL_CLASSES.flatMap((c) => c.weapons);
export const WEAPON_BY_ID: ReadonlyMap<string, WeaponDef> = buildIndex(
  [...REGISTERED_CLASSES.flatMap((c) => c.weapons), ...PARTY_WEAPONS]
    .map((w) => [w.id as string, w] as [string, WeaponDef]),
);

export const ALL_ARMORS: readonly ArmorDef[] = ALL_CLASSES.flatMap((c) => c.armors);
export const ARMOR_BY_ID: ReadonlyMap<string, ArmorDef> = buildIndex(
  REGISTERED_CLASSES.flatMap((c) => c.armors).map((a) => [a.id as string, a] as [string, ArmorDef]),
);

export const getClass = (id: ClassId): ClassDef | undefined => CLASS_BY_ID.get(id as string);
export const getSkill = (id: SkillId): SkillDef | undefined => SKILL_BY_ID.get(id as string);
export const getWeapon = (id: WeaponId): WeaponDef | undefined => WEAPON_BY_ID.get(id as string);
export const getArmor = (id: ArmorId): ArmorDef | undefined => ARMOR_BY_ID.get(id as string);

// ── 完整性校验 ───────────────────────────────────────────────────

export interface DataIssue {
  where: string;
  problem: string;
}

/**
 * 是否是规格书 7.2 意义上的「专用打断」。
 *
 * 判据：技能带 interrupt 效果，且**不**附带沉默减益。
 * 附带沉默的（牧师沉默）属于 8.x 的「等价沉默」，按普通技能对待 —— 会触发公共冷却。
 * 这个区分直接来自规格书：七个职业的打断在表格里写了「瞬发，脱离公共冷却」，牧师沉默没写。
 */
export const isDedicatedInterrupt = (s: SkillDef): boolean =>
  s.effects.some((e) => e.kind === 'interrupt') && !s.effects.some((e) => e.kind === 'silence');

/** 是否满足验收 #21「专用打断或等价沉默」*/
export const hasInterruptOrSilence = (c: ClassDef): boolean =>
  c.skills.some((s) => s.effects.some((e) => e.kind === 'interrupt' || e.kind === 'silence'));

/**
 * 运行时数据体检。TypeScript 能保证「字段存在且类型正确」，
 * 但保证不了「这个 id 指向的技能真的存在」「每个职业真的有打断」这类跨对象约束 ——
 * 这里补上。`data.test.ts` 会断言返回空数组。
 */
export const validateData = (): DataIssue[] => {
  const issues: DataIssue[] = [];
  const seenIds = new Set<string>();

  for (const cls of REGISTERED_CLASSES) {
    const where = `class:${cls.id}`;
    /**
     * ★ 特殊职业（BOSS）**同样过体检** —— 它的技能一样会进 sim 结算，
     *   id 写错、读条时间为 0、距离超过 45 米在它身上一样是缺陷。
     *   唯一豁免的是下面那条验收 #21（必须有打断/沉默）：那是**对手要能
     *   反制玩家**的要求，BOSS 不是玩家，给它一个打断只会让它更难打。
     */
    const playable = isPlayableClass(cls.id);

    // 默认武器/护甲必须存在且被标记为 isDefault
    const defW = cls.weapons.find((w) => (w.id as string) === (cls.defaultWeaponId as string));
    if (!defW) issues.push({ where, problem: `defaultWeaponId ${cls.defaultWeaponId} 不在 weapons 列表中` });
    else if (!defW.isDefault) issues.push({ where, problem: `默认武器 ${defW.id} 的 isDefault 为 false` });

    const defA = cls.armors.find((a) => (a.id as string) === (cls.defaultArmorId as string));
    if (!defA) issues.push({ where, problem: `defaultArmorId ${cls.defaultArmorId} 不在 armors 列表中` });

    // 10.6：始终保留 1 套不可删除的职业默认武器和默认护甲
    if (cls.weapons.filter((w) => w.isDefault).length !== 1)
      issues.push({ where, problem: '必须恰好有一个 isDefault 武器（10.6）' });
    if (cls.armors.filter((a) => a.isDefault).length !== 1)
      issues.push({ where, problem: '必须恰好有一个 isDefault 护甲（10.6）' });

    // 验收 #21：每个**可选**职业必须有至少一个专用打断或等价沉默（豁免见上）
    const hasInterrupt = cls.skills.some((s) =>
      s.effects.some((e) => e.kind === 'interrupt' || e.kind === 'silence'),
    );
    if (playable && !hasInterrupt)
      issues.push({ where, problem: '没有任何专用打断或等价沉默技能（验收 #21）' });

    // 7.2：专用打断不触发公共冷却。
    // 注意区分「专用打断」与「等价沉默」：规格书 9.7 的牧师沉默同时停止施法**并**施加
    // 3 秒沉默减益，表格里没有标「脱离公共冷却」——它是 8.x 允许的等价沉默，不是专用打断。
    // 因此判据是「只打断、不附带沉默减益」。
    for (const s of cls.skills) {
      if (isDedicatedInterrupt(s) && s.triggersGcd) {
        issues.push({ where: `skill:${s.id}`, problem: '专用打断不应触发公共冷却（7.2）' });
      }
    }

    for (const s of cls.skills) {
      const sw = `skill:${s.id}`;
      if (seenIds.has(s.id as string)) issues.push({ where: sw, problem: 'id 重复' });
      seenIds.add(s.id as string);

      if ((s.classId as string) !== (cls.id as string))
        issues.push({ where: sw, problem: `classId 是 ${s.classId}，应为 ${cls.id}` });
      if (!(s.id as string).startsWith(`${cls.id}.`))
        issues.push({ where: sw, problem: `id 应以 "${cls.id}." 开头` });

      // 附录A#3：反制方式必须写清楚，不能留空或敷衍
      if (s.counters.trim().length < 10)
        issues.push({ where: sw, problem: 'counters 过短，附录A#3 要求写明反制方式' });
      if (s.description.trim().length === 0)
        issues.push({ where: sw, problem: 'description 为空' });

      // 7.1：瞬发技能不能被普通打断
      if (s.cast.kind === 'instant' && s.cast.interruptible)
        issues.push({ where: sw, problem: '瞬发技能不能标记为可打断（7.1）' });
      // 7.1：读条与引导必须有大于 0 的时间，否则就该是瞬发
      if ((s.cast.kind === 'cast' || s.cast.kind === 'aimedShot') && s.cast.time <= 0)
        issues.push({ where: sw, problem: '读条/瞄准射击的 time 必须大于 0（否则应为瞬发）' });
      // 6.1：距离不能超过最大选中距离
      if (s.range.max > 45)
        issues.push({ where: sw, problem: `range.max ${s.range.max} 超过最大选中距离 45 米（6.1）` });
      if (s.range.min > s.range.max)
        issues.push({ where: sw, problem: 'range.min 大于 range.max' });
    }

    // 武器：附录A#4 的六项标注
    for (const w of cls.weapons) {
      const ww = `weapon:${w.id}`;
      if ((w.classId as string) !== (cls.id as string))
        issues.push({ where: ww, problem: `classId 是 ${w.classId}，应为 ${cls.id}` });
      if (w.advantage.trim().length === 0) issues.push({ where: ww, problem: 'advantage 为空（附录A#4）' });
      if (w.cost.trim().length === 0) issues.push({ where: ww, problem: 'cost 为空（附录A#4）' });
      if (w.swingInterval <= 0) issues.push({ where: ww, problem: 'swingInterval 必须大于 0' });
      if (w.reach <= 0) issues.push({ where: ww, problem: 'reach 必须大于 0' });

      // grants/removes 指向的技能必须存在
      for (const id of [...(w.grantsSkills ?? []), ...(w.removesSkills ?? [])]) {
        if (!cls.skills.some((s) => (s.id as string) === (id as string)))
          issues.push({ where: ww, problem: `引用了不存在的技能 ${id}` });
      }
      for (const key of Object.keys(w.skillModifiers ?? {})) {
        if (!cls.skills.some((s) => (s.id as string) === key))
          issues.push({ where: ww, problem: `skillModifiers 引用了不存在的技能 ${key}` });
      }
    }

    // 护甲：17.1 不能有全面上位装备
    for (const a of cls.armors) {
      const aw = `armor:${a.id}`;
      if ((a.classId as string) !== (cls.id as string))
        issues.push({ where: aw, problem: `classId 是 ${a.classId}，应为 ${cls.id}` });
      if (!a.isDefault && a.cost.trim().length === 0)
        issues.push({ where: aw, problem: '非默认护甲必须有明确代价（17.1 / 验收 #32）' });
    }

    // 武器的视觉缩放：只影响外观，但写错了没有任何别的地方会发现（见 schema）
    for (const w of cls.weapons) {
      if (w.renderScale !== undefined && (w.renderScale < 0.5 || w.renderScale > 4)) {
        issues.push({
          where: `weapon:${w.id}`,
          problem: `renderScale ${w.renderScale} 超出 [0.5, 4]`,
        });
      }
    }
  }

  issues.push(...validatePartyItems(seenIds));
  return issues;
};

/**
 * 大乱斗派对道具的体检（`data/party.ts`）。
 *
 * ★★ 它们**不在** `ALL_CLASSES` 里，所以上面那个大循环一条都覆盖不到 ——
 *   派对道具是「另一个池子」，需要另一组判据：
 *     · 前缀就是规则（`isPartyItemId` 决定人人可捡），写错前缀 = 悄悄变成
 *       一件谁都捡不起来的武器
 *     · 不许混进职业池（混进去会破坏「每职业恰好三套武器方案」）
 *     · grants 指向的必须是**派对技能**（职业技能被派对武器授予会让
 *       `skillsAvailableWith` 给出一个跨职业的技能栏）
 */
const validatePartyItems = (seenSkillIds: ReadonlySet<string>): DataIssue[] => {
  const issues: DataIssue[] = [];
  const partySkillIds = new Set(PARTY_SKILLS.map((s) => s.id as string));
  const classWeaponIds = new Set(ALL_WEAPONS.map((w) => w.id as string));

  for (const s of PARTY_SKILLS) {
    const where = `partySkill:${s.id}`;
    if (!isPartyItemId(s.id as string))
      issues.push({ where, problem: 'id 应以 "ffa." 开头（前缀即规则，见 party.ts）' });
    if (seenSkillIds.has(s.id as string))
      issues.push({ where, problem: 'id 与某个职业技能重复' });
    // 附录A#3：反制方式必须写清楚 —— 派对道具越夸张越要写明怎么破
    if (s.counters.trim().length < 10)
      issues.push({ where, problem: 'counters 过短，附录A#3 要求写明反制方式' });
    if (s.description.trim().length === 0)
      issues.push({ where, problem: 'description 为空' });
    if (s.cast.kind === 'instant' && s.cast.interruptible)
      issues.push({ where, problem: '瞬发技能不能标记为可打断（7.1）' });
    if ((s.cast.kind === 'cast' || s.cast.kind === 'aimedShot') && s.cast.time <= 0)
      issues.push({ where, problem: '读条/瞄准射击的 time 必须大于 0' });
    if (s.range.max > 45)
      issues.push({ where, problem: `range.max ${s.range.max} 超过最大选中距离 45 米（6.1）` });
  }

  for (const w of PARTY_WEAPONS) {
    const where = `partyWeapon:${w.id}`;
    if (!isPartyItemId(w.id as string))
      issues.push({ where, problem: 'id 应以 "ffa." 开头（前缀即规则，见 party.ts）' });
    if (classWeaponIds.has(w.id as string))
      issues.push({ where, problem: '同一个 id 也出现在职业武器池里' });
    // 10.6：默认武器不可删除、永不掉落 —— 派对武装恰恰只靠掉落获得
    if (w.isDefault) issues.push({ where, problem: '派对武装不能是任何职业的默认武器' });
    if (w.advantage.trim().length === 0) issues.push({ where, problem: 'advantage 为空（附录A#4）' });
    if (w.cost.trim().length === 0) issues.push({ where, problem: 'cost 为空（附录A#4）' });
    if (w.swingInterval <= 0) issues.push({ where, problem: 'swingInterval 必须大于 0' });
    if (w.reach <= 0) issues.push({ where, problem: 'reach 必须大于 0' });
    if (w.renderScale !== undefined && (w.renderScale < 0.5 || w.renderScale > 4))
      issues.push({ where, problem: `renderScale ${w.renderScale} 超出 [0.5, 4]` });
    for (const id of [...(w.grantsSkills ?? []), ...(w.removesSkills ?? [])]) {
      if (!partySkillIds.has(id as string))
        issues.push({ where, problem: `引用了不存在的派对技能 ${id}` });
    }
  }

  for (const c of PARTY_CONSUMABLES) {
    const where = `partyConsumable:${c.id}`;
    if (!isPartyItemId(c.id as string))
      issues.push({ where, problem: 'id 应以 "ffa." 开头（前缀即规则，见 party.ts）' });
    // 10.2：消耗品**没有**职业归属（10.1 的临时增益人人可用）
    if (c.classId !== undefined)
      issues.push({ where, problem: '派对消耗品不该有 classId（人人可用）' });
    if (c.effects.length === 0) issues.push({ where, problem: '没有任何效果' });
    // 16.2「增益期间击杀」按 buffSeconds 计窗口，为 0 时那条统计恒为 0
    if (c.buffSeconds <= 0) issues.push({ where, problem: 'buffSeconds 必须为正（16.2 的记账窗口）' });
    if (c.description.trim().length === 0) issues.push({ where, problem: 'description 为空' });
  }

  return issues;
};
