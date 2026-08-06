/**
 * 数据驱动 schema。
 *
 * 设计原则：**加一个职业、一件武器、一个技能，只写数据，不改引擎**。
 * 引擎（packages/shared/src/sim）只认识 EffectDef 的 kind，通过效果注册表分发；
 * 需要全新机制时才注册一个新的 kind，而不是在职业代码里写 if/else。
 *
 * 附录A#3 强制要求每个技能标注：目标类型、距离、形状、施放时间、是否可移动、
 * 是否可打断、学派、冷却、反制方式 —— 下面这些字段全部是**必填**，
 * TypeScript 会在编译期替我们执行这条约束。
 */

import type {
  ArmorArchetype,
  CastKind,
  DispelType,
  DrCategory,
  Resource,
  School,
  TargetFilter,
  Targeting,
} from '../types/enums.js';
import type { ArmorId, ClassId, ConsumableId, SkillId, WeaponId } from '../types/ids.js';

// ════════════════════════════════════════════════════════════════
//  范围形状
// ════════════════════════════════════════════════════════════════

export type ShapeDef =
  | { kind: 'single' }
  /** maxTargets：范围内最多命中几个单位（群体驱散上限 5）。不填 = 不限 */
  | { kind: 'circle'; radius: number; maxTargets?: number }
  | { kind: 'ring'; innerRadius: number; outerRadius: number; maxTargets?: number }
  | { kind: 'cone'; angleDeg: number; range: number; maxTargets?: number }
  | { kind: 'line'; length: number; width: number; maxTargets?: number }
  | { kind: 'chain'; jumpRange: number; maxTargets: number; falloff?: number };

// ════════════════════════════════════════════════════════════════
//  光环（增益 / 减益）
// ════════════════════════════════════════════════════════════════

/** 数值修正。全部为乘算系数或加算增量，sim 层按 modifier 类型聚合 */
export interface AuraModifiers {
  /** 移动速度乘算，0.6 = 减速 40% */
  moveSpeed?: number;
  /** 受到伤害乘算，0.7 = 减伤 30% */
  damageTaken?: number;
  /** 造成伤害乘算 */
  damageDealt?: number;
  /** 受到治疗乘算，0.75 = 受到治疗降低 25% */
  healingTaken?: number;
  /** 造成治疗乘算 */
  healingDone?: number;
  /** 攻击间隔乘算，0.9 = 攻速快 10% */
  attackSpeed?: number;
  /** 读条时间乘算 */
  castSpeed?: number;
  /** 受到击退距离乘算 */
  knockbackTaken?: number;
  /** 控制持续时间乘算（抗控型护甲）*/
  ccDurationTaken?: number;
  /** 正面闪避几率加算，0.5 = +50% */
  dodgeFront?: number;
  /** 招架几率加算 */
  parry?: number;
  /** 格挡几率加算 */
  block?: number;
  /** 资源获取乘算 */
  resourceGain?: number;
  /** 最大生命乘算（熊形态 +20%）*/
  maxHealth?: number;

  // ── schema v1.1 补充：来自八职业数据落地时暴露的表达缺口 ──────────
  /**
   * 移动速度**下限**（相对基础速度）。与 moveSpeed 乘算不同，这是个人下限。
   * 死亡脚步「6 秒内速度不低于基础速度 80%」→ moveSpeedFloor: 0.8
   */
  moveSpeedFloor?: number;
  /**
   * 按学派区分的承受伤害乘算。未列出的学派回落到 damageTaken。
   * 抗法型护甲、反魔法护罩、骨盾的「法术抗性提高」都需要它 ——
   * 用全局 damageTaken 近似会让抗法护甲连物理伤害一起减，违反 17.1 的横向取舍。
   */
  damageTakenBySchool?: Partial<Record<School, number>>;
  /**
   * 按学派拆分的**控制持续时间**承受乘算（10.8）。
   *
   * ★★ 抗法型护甲（Spellward）的身份是「削减**魔法**控制」，而抗控型护甲
   *   （Tenacity）才是「削减**所有**控制」。只有全局的 `ccDurationTaken`
   *   时，抗法护甲要么表达不了这一半优势，要么顺带削减物理控制 ——
   *   那样两件护甲会互相踩线，而 10.9 / 验收 #32 要求「没有任何一件是全面上位」。
   *   `armors.ts` 当时的选择是**宁可少表达一半优势，也不要表达错**。
   *
   * ★ 加进 schema 的判据与 `damageTakenBySchool` 一致（11-contributing §4 的
   *   「三次即入 schema」）：「按学派区分」这个需求已经出现过两次。
   */
  ccDurationTakenBySchool?: Partial<Record<School, number>>;
  /** 自己**施加**的控制持续时间乘算（施加方向）。与 ccDurationTaken（承受方向）相反 */
  ccDurationDealt?: number;
  /** 造成的吸收护盾量乘算 */
  absorbDone?: number;
  /** 治疗读条时间乘算，独立于通用 castSpeed（权杖+圣典「单体治疗读条 -15%」）*/
  healCastSpeed?: number;
}

/**
 * 随时间衰减的修正。冰霜锁链「初始减速 60%，在 4 秒内逐渐衰减」这类效果
 * 无法用恒定系数表达 —— sim 层按 (now - appliedAt) / duration 在 from→to 之间插值。
 */
export interface AuraDecayDef {
  /** 要衰减的 AuraModifiers 字段名 */
  field: keyof AuraModifiers;
  from: number;
  to: number;
  /** 衰减耗时，秒。不填则等于光环持续时间 */
  duration?: number;
}

/** 控制类标志。一个光环可以同时带多个（例如变形 = 无法行动 + 无法攻击）*/
export interface AuraFlags {
  /** 无法移动 */
  rooted?: boolean;
  /** 无法行动（昏迷/变形/恐惧共用）*/
  stunned?: boolean;
  /** 无法主动控制移动方向，被系统驱赶（恐惧）*/
  feared?: boolean;
  /** 禁止魔法技能，不阻止物理射击与纯武器技能（8.2 / 验收 #17）*/
  silenced?: boolean;
  /** 禁止武器攻击、瞄准射击和武器技能，不阻止纯魔法施法 */
  disarmed?: boolean;
  /** 完全免疫（圣盾术、寒冰屏障）。夺旗中会先掉旗（8.4）*/
  immuneAll?: boolean;
  /** 物理免疫（保护祝福）*/
  immunePhysical?: boolean;
  /** 法术免疫 */
  immuneMagic?: boolean;
  /** 免疫新的减速与定身（自由祝福）*/
  immuneMovementImpair?: boolean;
  /** 免疫新的魔法控制（反魔法护罩）*/
  immuneMagicControl?: boolean;
  /** 无法被选中、攻击或治疗（旋风）*/
  untargetable?: boolean;
  /** 潜行 */
  stealthed?: boolean;
  /** 不能攻击或射击（灵龟守护）*/
  cannotAttack?: boolean;
  /** 免疫减速和定身效果本身（剑刃风暴）*/
  immuneSlowAndRoot?: boolean;
  /** 偏转正面投射物 */
  deflectFrontProjectiles?: boolean;
  /** 复活保护：主动攻击/治疗/使用技能会提前结束（12.6）*/
  spawnProtection?: boolean;
}

export interface PeriodicDef {
  /** 每跳间隔，秒 */
  interval: number;
  effects: EffectDef[];
}

export interface AuraDef {
  id: string;
  name: string;
  /** buff 还是 debuff，决定驱散归属与 UI 分区 */
  kind: 'buff' | 'debuff';
  /** 基础持续时间（秒）。控制类会再乘以递减系数 */
  duration: number;
  /** 可被哪种驱散移除（8.4）*/
  dispelType: DispelType;
  /** 属于哪条控制递减链（8.2）。不填表示不参与递减 */
  drCategory?: DrCategory;
  /**
   * 施加这个光环的技能属于哪个学派。**纯表现用**，规则层不读它。
   *
   * ★ 存在的理由：控制光环的 id 被统一改写成 `control.<kind>`
   *   （见 `sim/effects/combat.ts`），所以表现层**无法**从 id 反查回技能与学派 ——
   *   而 14.3 要求「定身附着脚部」这类标记能读出是什么冻住了你
   *   （冰系定身该是冰蓝的冰棱，不是通用锁链）。
   *   学派在施加时本来就算出来了（用于抗控系数），这里只是把它存下来。
   * ★ 查不到时不填（光环周期跳、投射物二段效果等），表现层回落到中性色。
   */
  school?: School;
  /** 「战斗意志」能否解除（8.3：不能解除持续伤害、普通减速、沉默、降治疗、战斗抑制）*/
  clearableByTrinket?: boolean;
  modifiers?: AuraModifiers;
  flags?: AuraFlags;
  /** 周期性效果：持续伤害 / 持续治疗 */
  periodic?: PeriodicDef;
  /** 吸收护盾量。归零时触发「破裂」表现（14.3）*/
  absorb?: number;
  /**
   * 按最大生命百分比计算的吸收量，与 absorb 二选一。
   * 反魔法护罩「吸收相当于 25% 最大生命的魔法伤害」→ 0.25
   * 写死固定值会在熊形态等改变最大生命的场景下失准。
   */
  absorbPercentMaxHealth?: number;
  /** 该护盾只吸收这些学派的伤害。不填 = 吸收全部（反魔法护罩只吸收魔法）*/
  absorbSchools?: School[];
  /** 受到一定伤害后提前解除（恐惧/变形/定身，8.2）*/
  breakOnDamage?: { threshold: number };
  /** 受到**任何**伤害即解除（冰冻陷阱）。比 breakOnDamage.threshold=1 语义明确 */
  breakOnAnyDamage?: boolean;
  /** 随时间衰减的修正（冰霜锁链）*/
  decay?: AuraDecayDef;
  /**
   * 持续到主动取消 / 切换 / 死亡，不按 duration 自然过期。
   * 潜行、德鲁伊形态属于这一类。设为 true 时 duration 仅作为 UI 兜底显示。
   */
  persistent?: boolean;
  /**
   * 该光环的效果只对**施加者**成立（审判「额外承受 10% 该圣骑士的伤害」）。
   * sim 层在结算时比对伤害来源，来源不匹配则忽略这个光环的修正。
   */
  casterScoped?: boolean;
  maxStacks?: number;
  /**
   * ⚠️ **目前是死数据 —— 全仓库没有任何代码读这个字段**（P4b 全文检索确认）。
   *   实际的施法/命中表现走的是 `client/src/vfx/schools.ts` 的 `visualOf()`：
   *   按技能**学派 + 形状**取八属性视觉，与本键无关。留着它是给 P3
   *   「技能签名」（每技能专属特效/音效）当落点 —— 接线时这里就是那个键；
   *   在那之前**不要**以为改这个字符串能改变任何画面。
   */
  vfx?: string;
  /** 玩家可见的说明文本 */
  description: string;
}

// ════════════════════════════════════════════════════════════════
//  效果
// ════════════════════════════════════════════════════════════════

/** 伤害/治疗量的表达方式 */
export interface Magnitude {
  /** 固定值 */
  flat?: number;
  /** 武器伤害百分比，1.6 = 160% 武器伤害 */
  weaponPercent?: number;
  /** 攻击力/法术强度系数（首版标准化属性，先留接口）*/
  powerCoef?: number;
}

/**
 * 效果定义。新增机制 = 新增一个 kind + 在 sim/effects 注册处理器。
 * 每个效果默认作用于技能选出的目标集合，可用 target 覆写。
 */
export type EffectDef =
  // —— 伤害与治疗 ——
  | { kind: 'damage'; school: School; amount: Magnitude; /** 背后攻击加成，0.5 = +50% */ behindBonus?: number }
  | { kind: 'heal'; amount: Magnitude }
  /** 根据近期承受伤害恢复生命（死亡打击），有上限 */
  | { kind: 'healFromRecentDamage'; percentOfDamageTaken: number; window: number; maxPercentOfMaxHealth: number }
  | { kind: 'healPercentMaxHealth'; percent: number }

  // —— 光环 ——
  | { kind: 'applyAura'; aura: AuraDef; target?: 'self' | 'target' | 'allInShape' }
  | { kind: 'removeAura'; auraIds: string[] }

  // —— 控制 ——
  | { kind: 'stun'; duration: number }
  | { kind: 'incapacitate'; duration: number; breakDamage?: number }
  | { kind: 'fear'; duration: number; breakDamage?: number }
  | { kind: 'root'; duration: number; breakDamage?: number }
  | { kind: 'silence'; duration: number }
  | { kind: 'disarm'; duration: number }

  // —— 打断与驱散 ——
  /** 7.2 专用打断。lockSeconds 只在被打断的是魔法时生效 */
  | { kind: 'interrupt'; schoolLockSeconds: number }
  /**
   * count 可填 'all'：自由祝福要清掉目标身上**所有**移动限制，写 count: 99 是坏味道。
   *
   * `types` 与 `impairs` **二选一**：
   *   · `types` —— 按驱散**类别**选（8.4 的经典口径：驱散魔法、消毒药剂…）
   *   · `impairs` —— 按光环**实际做了什么**选：'slow' = 带减速修正
   *     （`modifiers.moveSpeed < 1`），'movement' = 减速 ∪ 定身（`flags.rooted`）。
   *
   * ★★ 为什么需要第二种：减速的 dispelType 天生五花八门 —— 断筋是 movement、
   *   霜矢是 magic、毒刃是 poison，定身还是 applyControl 统一标的 magic。
   *   「解除减速和定身」类技能（自由庇佑、逃脱、消失）按类别选**永远选不全**，
   *   而把霜矢改标 movement 又会让驱散魔法反而摘不掉它 —— 单一 dispelType
   *   表达不了「既是魔法又是移动限制」。语义筛选直接对齐技能说明的措辞。
   * ★ `dispelType: None`（不可驱散）对两种口径都**依然不可驱散**。
   */
  | { kind: 'dispel'; types?: DispelType[]; count: number | 'all'; from: 'ally' | 'enemy'; /** 10.x 可解除部分完全免疫（群体驱散）*/ canRemoveImmunity?: boolean; impairs?: 'slow' | 'movement' }

  // —— 位移 ——
  /** 冲向敌方目标（冲锋）。必须停在合法位置 */
  | { kind: 'chargeTo'; minRange: number; maxRange: number; stopDistance: number }
  /** 冲向友方（援护、野性冲锋人形）*/
  | { kind: 'chargeToAlly'; stopDistance: number }
  /** 把目标拉到自己附近（死亡之握、信仰飞跃）*/
  | { kind: 'pullTarget'; toDistance: number }
  /** 沿角色面向瞬移（闪现术）*/
  | { kind: 'blinkForward'; distance: number; clearsRoot?: boolean }
  /** 向背后跃出（逃脱）*/
  | { kind: 'leapBackward'; distance: number; clearsSlow?: boolean }
  /** 传送到目标背后合法位置（暗影步）*/
  | { kind: 'teleportBehindTarget'; offset: number }
  | { kind: 'knockback'; distance: number }

  // —— 地面与投射物 ——
  /** 生成持续地面区域（暴风雪、烟雾弹、照明弹、凛冬领域）*/
  /** tickInterval / onTick 可省略：烟雾弹、照明弹是纯功能性区域，没有周期伤害 */
  | { kind: 'spawnGroundArea'; areaId: string; radius: number; duration: number; tickInterval?: number; onTick?: EffectDef[]; /** 区域内单位不能被区域外直接选中（烟雾弹）*/ blocksTargetingFromOutside?: boolean; /** 揭露潜行（照明弹）*/ revealsStealth?: boolean }
  /** 延迟落点（陨石、箭雨）。落点与倒计时全程可见（6.6 / 14.3）*/
  | { kind: 'delayedGroundImpact'; delay: number; radius: number; onImpact: EffectDef[] }
  /** 布置陷阱（冰冻陷阱）*/
  /** singleTrigger 默认 true：冰冻陷阱只对「首个敌人」生效 */
  | { kind: 'spawnTrap'; armTime: number; triggerRadius: number; duration: number; onTrigger: EffectDef[]; singleTrigger?: boolean }
  /** 发射碰撞型投射物 */
  | { kind: 'spawnProjectile'; speed: number; radius: number; pierce: boolean; onHit: EffectDef[] }

  // —— 资源与特殊 ——
  | { kind: 'gainResource'; resource: Resource; amount: number }
  /**
   * 消耗连击点放大效果。
   * 纯线性（base × perPointMultiplier × 点数）无法表达肾击「1 点 1 秒 ~ 5 点 3 秒」这种仿射区间，
   * 因此支持 byPoints 显式列表（索引 0 = 1 点），优先于 perPointMultiplier。
   */
  | { kind: 'spendComboPoints'; perPointMultiplier: number; base: EffectDef; byPoints?: number[] }
  /** spendComboPoints 的泛化：圣骑士圣能、其他点数型资源共用 */
  | { kind: 'spendResource'; resource: Resource; perPointMultiplier: number; base: EffectDef; byPoints?: number[]; max?: number }
  /** 让目标掉旗。保护祝福是「**受益者**掉旗」，SkillDef.dropsFlagOnUse 只能表达施法者掉旗 */
  | { kind: 'dropFlag'; target?: 'self' | 'target' }
  /** 德鲁伊形态切换 */
  | { kind: 'shapeshift'; form: 'humanoid' | 'bear' | 'cat' }
  | { kind: 'enterStealth'; graceSeconds?: number }
  /** 3 秒内替友方承受下一次直接攻击（援护）*/
  | { kind: 'interveneGuard'; duration: number }
  /** 累计 N 次命中后触发（凛冬领域）*/
  | { kind: 'onNthHit'; count: number; effects: EffectDef[] }
  /** 触发已注册的自定义处理器，用于确实无法数据化的一次性机制 */
  | { kind: 'custom'; handler: string; params?: Record<string, unknown> };

// ════════════════════════════════════════════════════════════════
//  技能
// ════════════════════════════════════════════════════════════════

export interface CostDef {
  resource: Resource;
  amount: number;
}

/**
 * 技能前置条件（schema v1.1）。
 *
 * 这些是**校验**而不是**效果** —— 之前只能塞进 effects 里当 custom handler，
 * 语义错位且无法在 HUD 上提前变灰。放在 SkillDef.requires 里，
 * canCast() 就能统一检查并返回对应的 CastFailure。
 */
export type ConditionDef =
  /** 脱离战斗满 N 秒（潜行）*/
  | { kind: 'outOfCombat'; seconds: number }
  /** 持有至少 N 点连击点/圣能 */
  | { kind: 'minResource'; resource: Resource; amount: number }
  /** 处于指定形态之一（德鲁伊）*/
  | { kind: 'inForm'; forms: ('humanoid' | 'bear' | 'cat')[] }
  /** 不处于指定形态（读条法术在动物形态下不可用）*/
  | { kind: 'notInForm'; forms: ('humanoid' | 'bear' | 'cat')[] }
  /** 近期发生过招架（反击刺）*/
  | { kind: 'recentlyParried'; withinSeconds: number }
  /** 目标正在施法（用于把打断技能在非施法目标上变灰，仅提示，仍按 7.2 进冷却）*/
  | { kind: 'targetCasting' }
  /** 未携带旗帜 */
  | { kind: 'notCarryingFlag' };

export interface SkillDef {
  id: SkillId;
  name: string;
  classId: ClassId;
  /** 图标键，映射到客户端图标注册表（素材必须先过 docs/09-asset-license.md）*/
  icon?: string;

  // ── 附录A#3 强制字段 ──────────────────────────────────────────
  /** 目标类型（5.4 六类瞄准）*/
  targeting: Targeting;
  /** 允许作用的阵营 */
  targetFilter: TargetFilter;
  /** 距离，米。近战技能填武器触及距离 */
  range: { min: number; max: number };
  /** 形状（6.3）*/
  shape: ShapeDef;
  /** 施放方式 */
  cast: {
    kind: CastKind;
    /** 读条/准备时间，秒。瞬发为 0 */
    time: number;
    /** 引导总时长，秒。仅 channel */
    channelDuration?: number;
    /** 引导跳数 */
    ticks?: number;
    /** 是否可移动施放（7.3：主动移动停止「原地施放」）*/
    movable: boolean;
    /** 是否可被专用打断（7.1：不可打断技能带盾牌标记）*/
    interruptible: boolean;
  };
  /** 学派。物理学派被打断不产生学派锁定（7.2）*/
  school: School;
  /** 技能冷却，秒 */
  cooldown: number;
  /** 是否触发公共冷却（7.2：专用打断不触发 GCD）*/
  triggersGcd: boolean;
  cost?: CostDef;
  /** 是否要求目标处于前方（6.5）*/
  requiresFacing?: boolean;
  /** 是否要求视线（6.4）*/
  requiresLos?: boolean;
  /** 12.3 旗手不能使用 */
  forbiddenWhileCarryingFlag?: boolean;
  /** 8.4 使用时立即掉旗 */
  dropsFlagOnUse?: boolean;
  /** 可在昏迷中使用（树皮术）*/
  usableWhileStunned?: boolean;
  /** 需要消耗连击点 */
  requiresComboPoints?: boolean;
  /** 前置条件（schema v1.1）。canCast() 统一检查，不满足时技能在 HUD 上变灰 */
  requires?: ConditionDef[];
  /**
   * 技能距离跟随当前武器的 reach 而不是写死的 range.max。
   * 猎人自动射击换长弓后应为 35 米而非短弓的 28 米。
   */
  rangeFromWeapon?: boolean;
  /** 附录A#3：反制方式，必须写清楚，也直接用于 HUD tooltip */
  counters: string;
  /** 效果列表，按顺序结算 */
  effects: EffectDef[];
  /** 玩家可见说明 */
  description: string;
  /** ⚠️ 死数据，无消费方 —— 详见 AuraDef.vfx 的注释（P3 技能签名的落点）*/
  vfx?: string;
}

// ════════════════════════════════════════════════════════════════
//  武器与护甲（附录A#4）
// ════════════════════════════════════════════════════════════════

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** 所属职业。10.2：不允许跨职业使用 */
  classId: ClassId;
  /** 是否是该职业的默认武器（10.6：默认武器不可删除、永不掉落）*/
  isDefault: boolean;
  /** 单手/双手/双持/远程 */
  handedness: 'oneHand' | 'twoHand' | 'dualWield' | 'ranged' | 'staff';
  /** 攻击间隔，秒。双持填单手交替间隔 */
  swingInterval: number;
  /** 每次攻击的武器伤害百分比。双持填单手数值 */
  swingPercent: number;
  /** 触及距离，米 */
  reach: number;
  /** 是否为远程武器（决定普通攻击走射击规则，7.6）*/
  isRanged?: boolean;
  /** 数值修正 */
  modifiers?: AuraModifiers;
  /** 附录A#4：优势（一句话）*/
  advantage: string;
  /** 附录A#4：代价（一句话）。17.1：不能同时提高伤害/攻速/防御/移动/控制 */
  cost: string;
  /** 附录A#4：改变的技能。grants = 新增，removes = 禁用 */
  grantsSkills?: SkillId[];
  removesSkills?: SkillId[];
  /**
   * 对已有技能的数值改写，如「瞄准射击伤害 +15%」。
   * key 是 SkillId 的字符串形式；`data/index.ts` 的完整性测试会校验每个 key 都指向真实技能，
   * 弥补 TS 无法在 Record 的 key 上做存在性检查这一点。
   */
  skillModifiers?: Record<string, SkillModifier>;
  /**
   * 远程技能最大距离乘算（法师「法刃 + 元素焦点」的远程距离 -20%）。
   * 与 reach 不同：reach 是这把武器自己的触及距离，rangeMultiplier 作用于职业技能。
   */
  rangeMultiplier?: number;
  /** 7.6：能否在移动中进行普通射击。短弓 true，长弓/重弩 false */
  canMoveWhileShooting?: boolean;
  /** 7.6：每发前的装填时间，秒。重弩 1 秒，移动会中断 */
  reloadTime?: number;
  /**
   * 覆盖职业级 autoAttack。武器优先 ——
   * 圣骑士换权杖后普攻变远程神圣，法师换法刃后变近战物理，牧师换魔杖后变暗影。
   */
  autoAttack?: { ranged: boolean; school: School };
  /** 模型挂点键，供客户端装配（13.6）*/
  model?: string;
}

/** 武器对单个技能的数值改写。全部为乘算，1 = 不变 */
export interface SkillModifier {
  damageMultiplier?: number;
  healingMultiplier?: number;
  cooldownMultiplier?: number;
  castTimeMultiplier?: number;
  /** 圆/锥/环的半径或距离乘算 */
  radiusMultiplier?: number;
  /** 效果持续时间乘算 */
  durationMultiplier?: number;
  /** 技能最大距离乘算 */
  rangeMultiplier?: number;
  /** 背刺加成的**增量**（不是乘算）。双剑「背后加成降低」→ -0.2 */
  behindBonusDelta?: number;
}

/**
 * 消耗品（10.1 临时增益道具）。
 *
 * ★★ **这个类型此前根本不存在** —— `DropKind` 里有 `'consumable'`、
 *   `Loadout.consumables` 也在、`stats.recordItemBuff()` 也留好了入口，
 *   但**没有名字、没有效果、没有持续时间**，也从没有代码创建过一个消耗品掉落。
 *   于是 16.2 的「增益期间击杀」结构上恒为 0（已登记为已知偏差 #2）。
 *
 * ★ 与 `WeaponDef` / `ArmorDef` 的区别：那两者是**持续**的装备修正，
 *   消耗品是**一次性**触发一组效果 —— 所以它带 `effects` 而不是 `modifiers`。
 *   增益本身由效果里的 `applyAura` 表达，持续时间就是那个光环的时长。
 */
export interface ConsumableDef {
  id: ConsumableId;
  name: string;
  /** 10.2：职业归属。不匹配的玩家看得到但拿不走 */
  classId?: ClassId;
  /** 使用后触发的效果。增益走 applyAura */
  effects: EffectDef[];
  /**
   * 增益窗口时长，秒。★ 16.2 的「增益期间击杀」按它计窗口。
   * 与效果里光环的时长应当一致 —— 分开写是因为一个消耗品可以施加多个光环。
   */
  buffSeconds: number;
  /** 使用后进入的冷却，秒。0 表示不进冷却 */
  cooldown: number;
  description: string;
  vfx?: string;
}

export interface ArmorDef {
  id: ArmorId;
  name: string;
  classId: ClassId;
  isDefault: boolean;
  /** 10.8 横向方案原型 */
  archetype: ArmorArchetype;
  modifiers: AuraModifiers;
  advantage: string;
  cost: string;
  /** 客户端材质/外观键 */
  appearance?: string;
}

// ════════════════════════════════════════════════════════════════
//  职业
// ════════════════════════════════════════════════════════════════

export interface ResourcePoolDef {
  resource: Resource;
  max: number;
  /** 开局初始值 */
  start: number;
  /** 每秒自然回复（能量/集中值）。怒气靠造成与承受伤害获取，填 0 */
  regenPerSecond: number;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  /** 9.x 定位一句话 */
  role: string;
  baseHealth: number;
  resources: ResourcePoolDef[];
  /** 优势 */
  strengths: string;
  /** 弱点 */
  weaknesses: string;
  /** 默认武器方案 ID */
  defaultWeaponId: WeaponId;
  /** 默认护甲方案 ID */
  defaultArmorId: ArmorId;
  /** 该职业全部技能。8.x：每个职业必须有至少一个专用打断或等价沉默 */
  skills: SkillDef[];
  /** 可选武器方案（含默认）*/
  weapons: WeaponDef[];
  /** 可选护甲方案（含默认）*/
  armors: ArmorDef[];
  /**
   * 使用**默认武器**时的普通攻击类型。
   * ⚠ 当前装备的 `WeaponDef.autoAttack` 若存在则优先 —— 武器覆盖职业。
   * 圣骑士换权杖 → 远程神圣；法师换法刃 → 近战物理；牧师换魔杖 → 暗影。
   */
  autoAttack: {
    /** 是否是远程自动攻击（猎人）*/
    ranged: boolean;
    school: School;
  };
}
