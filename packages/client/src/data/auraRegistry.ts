/**
 * X26：**客户端光环注册表** —— `auraId → AuraDef`（外加「是谁施加的」）。
 *
 * ★★ **为什么在客户端建表，而不是给协议加 1 bit。**
 *   用户 2026-08-11 拍板原话：「体验上没区别就尽量减轻服务端负担」。
 *   两条出路（X26 总账写着）里，① 给 `AuraSnapshot` 加一位 kind 要过
 *   P11 的字节预算与 codec、每帧每实体每枚光环都要多发一次；
 *   ② 客户端按技能数据表自建索引则是**零协议改动、零带宽、零服务端 CPU**，
 *   而玩家看到的东西一模一样 —— 技能数据两端同源，客户端手里本来就有全套。
 *   选 ②。
 *
 * ★★ **它回答的是快照回答不了的三个问题**：
 *   · 这枚光环是增益还是减益（`AuraSnapshot` 不带 kind）
 *   · 它叫什么（不带 name，HUD 只能显示内部 id）
 *   · 是哪个技能施加的（图标 / 学派色的精确来源，见下面 `skill` 字段的 ★★）
 *
 * ── 铁律⑦：递归下探，而且是**结构化**下探 ────────────────────────
 *
 * ★★ 光环**不只**藏在 `applyAura.aura` 里。W23/W25 之后它们散在
 *   `lockedProjectile.onHit`（寒冷、毒蛇钉刺）、`delayedGroundImpact.onImpact`
 *   （星尘）、`spawnGroundArea.onTick`（冰霜风暴、凛冬彻骨）、
 *   `spawnTrap.onTrigger`、`onNthHit.effects`、`spendComboPoints.base`、
 *   以及光环自己的 `periodic.effects` 里 —— 已经有 8 处同族翻车。
 *
 * ★★ 所以这里**不写 effect kind 的 case 表**，而是**无差别深走**整棵数据树：
 *   任何一个带 `dispelType` + `id` + `kind` 的对象就是一枚 `AuraDef`。
 *   case 表的失败模式是「新加一种嵌套 effect ⇒ 里面的光环静默查不到 ⇒
 *   那枚 debuff 在 HUD 上退回 unknown」，没有任何测试会红。
 *   深走则**加什么都自动覆盖**，代价只有构建时多走一遍静态数据（懒建一次）。
 *
 * ── S7 红线 ──────────────────────────────────────────────────────
 *
 * ★★ `HIDDEN_AURA_ID`（服务器掩掉施加者不可见的光环时用的中性 token）
 *   **连查都不许查** —— `auraEntryById` 第一行就返回 undefined。
 *   服务器刚刚把 id、学派、吸收量一起抹掉，注册表要是还能按那个 token
 *   查出点什么，等于给潜行者报点；而且是最难发现的那种泄漏：
 *   画面上只是「好像对得上」，没有任何断言会红。
 *   ⚠️ 这条不是「顺手加的保险」：数据里将来真出现一枚 id 叫 `hidden` 的光环，
 *     没有这一行就会当场从旁边漏回去。
 */

import {
  BOSS_ENRAGE_AURA,
  CONSUMABLES,
  HIDDEN_AURA_ID,
  PARTY_CONSUMABLES,
  SKILL_BY_ID,
  type AuraDef,
  type SkillDef,
} from '@wowpvp/shared';

/**
 * 注册表里的一条。
 *
 * ★★ **`skill` 是这张表真正的增值**，不是附赠品。光环 id 的前两段
 *   **不一定**是技能 id —— 实测四条对不上：`warrior.mortal_wounds` 来自
 *   致死打击、`deathknight.winter_domain_chill` 来自寒冬领域、
 *   大乱斗的 `ffa.greasy` / `ffa.stardust` 来自鸡腿雨与陨星。
 *   靠「id 去掉最后一段猜技能」的旧启发式，这四条全部落空：
 *   图标退成色块、学派色退成中性灰。拿着技能就能直接问
 *   `visualAttributeOf(skill)`，**而且那个函数是毒感知的**
 *   （毒刃学派是物理，玩家该看到黄绿而不是钢铁色）。
 *
 * ★ `skill` 可空：消耗品（战斗药剂、巨人化药水）与 BOSS 狂暴不是技能施加的。
 */
export interface AuraEntry {
  def: AuraDef;
  /** 施加它的技能。消耗品 / sim 直接施加的光环没有 —— 见上面的 ★ */
  skill?: SkillDef;
  /** 人类可读的来源。★ 存在的理由只有一个：撞 id 门禁的报错要指得出是哪两处 */
  source: string;
}

/** 同一个 id 被两处定义成**不同**的 def —— 这是数据 bug，门禁要抓 */
export interface AuraIdCollision {
  id: string;
  sources: readonly string[];
}

interface Registry {
  byId: Map<string, AuraEntry>;
  collisions: AuraIdCollision[];
}

/**
 * 一个对象长得像 `AuraDef` 吗。
 * ★ `dispelType` 是它在整棵数据树里**独有**的必填字段（8.4 驱散归属），
 *   配上 `id` + `kind` 三个一起看，不会把别的东西认成光环。
 */
const looksLikeAura = (o: Record<string, unknown>): boolean =>
  typeof o.dispelType === 'string' && typeof o.id === 'string' && typeof o.kind === 'string';

/**
 * 两枚 def 是不是同一份定义（键序无关的深比较）。
 *
 * ★ 用途只有撞 id 门禁：`rogue.stealth`（潜行与消失共用）与
 *   `mage.frostbolt.chill`（霜矢与冰枪术共用）都是**有意**的一枚多用，
 *   合法；而「同一个 id 两处写了不同的数」是数据 bug。
 *   用 `JSON.stringify` 比会把**键序**也算进去，两处手写同样的字段
 *   但顺序不同就会误报 —— 那是最讨厌的一类假红灯。
 */
const sameDef = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => sameDef(ra[k], rb[k]));
};

const register = (
  def: AuraDef,
  skill: SkillDef | undefined,
  source: string,
  reg: Registry,
): void => {
  const prev = reg.byId.get(def.id);
  if (prev === undefined) {
    reg.byId.set(def.id, { def, ...(skill !== undefined ? { skill } : {}), source });
    return;
  }
  // ★ 一枚光环被两个技能施加是合法的（潜行/消失、霜矢/冰枪术）——
  //   前提是两处**定义一致**。先来先得，后来的只做一致性检查。
  if (sameDef(prev.def, def)) return;
  reg.collisions.push({ id: def.id, sources: [prev.source, source] });
};

/**
 * 无差别深走一棵静态数据树，把途中每一枚 `AuraDef` 收进注册表。
 *
 * ★ `seen` 拦的是**共享常量**（`FROST_CHILL` 是一个 const，霜矢与冰枪术
 *   引用的是同一个对象）：走过一次就不必再走，顺带让「同一个对象」
 *   永远不会跟自己撞 id。
 * ⚠️ 数据是静态字面量，没有环 —— `seen` 是省事不是防死循环。
 */
const collect = (
  node: unknown,
  skill: SkillDef | undefined,
  source: string,
  reg: Registry,
  seen: Set<object>,
): void => {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) collect(v, skill, source, reg, seen);
    return;
  }
  const o = node as Record<string, unknown>;
  if (looksLikeAura(o)) register(o as unknown as AuraDef, skill, source, reg);
  // ★ 认出是光环之后**照样往下走**：光环的 `periodic.effects` 里还能再套光环
  for (const v of Object.values(o)) collect(v, skill, source, reg, seen);
};

/**
 * 建表。★ 三个来源，缺一不可：
 *   ① `SKILL_BY_ID` —— 八职业 + BOSS（`SPECIAL_CLASSES`）+ 大乱斗派对技能。
 *      用它而不是 `ALL_SKILLS`：后者只含可选职业池，被 BOSS 的吐息点着了
 *      也该在光环行上读得出来。
 *   ② 消耗品两池 —— `CONSUMABLES`（竞技场补给）与 `PARTY_CONSUMABLES`
 *      （大乱斗道具）。**它们不是技能**，`SKILL_BY_ID` 一枚都覆盖不到，
 *      而巨人化/战斗药剂正是玩家最常在自身框上看见的那几枚增益。
 *   ③ `BOSS_ENRAGE_AURA` —— 由 `sim/boss.ts` 在 30% 血线**直接**施加，
 *      不经任何 applyAura 效果，所以①②都走不到它。
 * ⚠️ 武器与护甲**没有**光环：它们带的是 `AuraModifiers`（持续数值修正），
 *   不是 `AuraDef`（见 `schema.ts` 的 `WeaponDef.modifiers`）。
 *   这不是漏了，是那一侧结构上就没有可收的东西。
 */
const buildRegistry = (): Registry => {
  const reg: Registry = { byId: new Map(), collisions: [] };
  const seen = new Set<object>();
  for (const skill of SKILL_BY_ID.values()) {
    collect(skill.effects, skill, `技能 ${skill.id as string}`, reg, seen);
  }
  for (const c of [...CONSUMABLES, ...PARTY_CONSUMABLES]) {
    collect(c.effects, undefined, `消耗品 ${c.id as string}`, reg, seen);
  }
  collect(BOSS_ENRAGE_AURA, undefined, 'BOSS 狂暴（sim/boss.ts 直接施加）', reg, seen);
  return reg;
};

/** 懒建一次：全部技能与消耗品走一遍，之后是纯 Map 查询 */
let registry: Registry | undefined;

const loaded = (): Registry => (registry ??= buildRegistry());

/**
 * 按 id 取注册表条目。查不到返回 undefined。
 *
 * ★★ **第一行是 S7 红线**（见文件头）：掩码光环连查都不许查。
 * ★ 除掩码外，天然查不到的还有**运行时拼出来的 id**：
 *   `control.<kind>`（`sim/effects/combat.ts` 把控制光环的 id 统一改写了）
 *   与将来任何 sim 现造的光环。调用方**必须保留 unknown 兜底** ——
 *   注册表补的是「数据里写着的那些」，不是「所有可能出现的 id」。
 */
export const auraEntryById = (id: string): AuraEntry | undefined => {
  if (id === HIDDEN_AURA_ID) return undefined;
  return loaded().byId.get(id);
};

/** 按 id 取光环定义 */
export const auraDefById = (id: string): AuraDef | undefined => auraEntryById(id)?.def;

/** 按 id 取**施加它的技能**（图标 / 学派色的精确来源，见 `AuraEntry.skill` 的 ★★）*/
export const auraSkillById = (id: string): SkillDef | undefined => auraEntryById(id)?.skill;

/** 按 id 取增益/减益向。查不到 undefined —— 调用方退 unknown，别猜 */
export const auraKindById = (id: string): AuraDef['kind'] | undefined => auraDefById(id)?.kind;

/** 按 id 取玩家可见名。查不到 undefined —— 调用方退回 id，别编中文名 */
export const auraNameById = (id: string): string | undefined => auraDefById(id)?.name;

/**
 * 按 id 推**学派**（HUD 光环格子的边色判据）。
 *
 * ★★ **X26 收口：这条回落必须只有一份。** 绝大多数 `AuraDef` 自己**不写**
 *   `school`（63 枚里 53 枚），学派要从**施加它的技能**上取 —— 断筋→物理、
 *   审判→神圣。X26 只把这一级回落加在了联网侧的 `toHudAura` 上，本地侧
 *   `LocalCombatView.hudAurasOf` 仍然只填 `a.def.school`，于是**同一枚断筋
 *   在试验场是中性灰、在联网局是钢铁色** —— 正是 `vfx/debuffAura.ts` 点名
 *   要避免的那条（「两条路各写一遍迟早会漂，而玩家只会发现『单机是冰蓝的、
 *   联机是灰的』」），只是方向反了。两条投影现在都调这个函数。
 *
 * ★ 本地模拟侧手里明明有 `AuraDef`，**仍然走这张表** —— 与 kind / name
 *   同一条纪律：「什么颜色」这件事只许有一个答案。
 * ★ 掩码光环（S7）与运行时现造的 `control.*` 查不到 → undefined，
 *   调用方退中性色。
 */
export const auraSchoolById = (id: string): AuraDef['school'] | undefined => {
  const entry = auraEntryById(id);
  return entry?.def.school ?? entry?.skill?.school;
};

/**
 * 表里的全部 id（诊断 / 门禁用）。
 * ★ 存在的理由是**回归护栏**：覆盖率门禁拿它与数据源码里的
 *   `AuraDef` 字面量逐枚对照 —— 哪天深走漏了一条枝，掉的是这个集合，
 *   而画面上只是「某枚 debuff 忽然没名字了」，不会有别的东西报错。
 */
export const auraRegistryIds = (): readonly string[] => [...loaded().byId.keys()];

/** 同一 id 被两处定义成不同 def 的清单。★ 恒为空是门禁，不是巧合 */
export const auraIdCollisions = (): readonly AuraIdCollision[] => loaded().collisions;
