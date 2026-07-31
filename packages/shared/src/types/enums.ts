/**
 * 战斗词汇表。每一项都直接对应设计文档中的规则条目，注释里标了章节号，
 * 改动前请先回到 docs/00-design-spec.md 对应章节确认。
 */

// ── 5.4 六类瞄准方式 ─────────────────────────────────────────────
export const Targeting = {
  /** 直接目标技能：需要硬目标或鼠标指向目标。开始与完成时都检查目标/距离/视线 */
  Direct: 'direct',
  /** 地面目标技能：鼠标放置圆形/环形指示器，确认后释放 */
  Ground: 'ground',
  /** 方向直线技能：沿角色面向发射，不依赖硬目标 */
  Line: 'line',
  /** 方向锥形技能：角色前方扇形 */
  Cone: 'cone',
  /** 自身中心技能：以自己为圆心，不需要选择目标 */
  SelfCenter: 'selfCenter',
  /** 碰撞型投射物：按真实轨迹飞行，命中第一个有效目标或地形 */
  Projectile: 'projectile',
  /** 纯自身技能：只作用于自己（防御姿态、圣盾术等）*/
  Self: 'self',
} as const;
export type Targeting = (typeof Targeting)[keyof typeof Targeting];

// ── 6.3 范围形状 ─────────────────────────────────────────────────
export const ShapeKind = {
  Single: 'single',
  Circle: 'circle',
  Cone: 'cone',
  Line: 'line',
  Ring: 'ring',
  Chain: 'chain',
} as const;
export type ShapeKind = (typeof ShapeKind)[keyof typeof ShapeKind];

// ── 7.1 动作类型 ────────────────────────────────────────────────
export const CastKind = {
  /** 瞬发：不能被普通打断，可被同时到达的硬控制阻止 */
  Instant: 'instant',
  /** 读条法术：可被专用打断、沉默、硬控制、强制位移、主动移动终止 */
  Cast: 'cast',
  /** 引导法术：持续产生多次效果，打断/控制会终止剩余引导 */
  Channel: 'channel',
  /** 瞄准射击/装填：物理准备条。可被打断/缴械/控制/位移终止，沉默无效 */
  AimedShot: 'aimedShot',
} as const;
export type CastKind = (typeof CastKind)[keyof typeof CastKind];

// ── 14.2 属性视觉语言 / 7.2 学派锁定 ─────────────────────────────
export const School = {
  Physical: 'physical',
  Holy: 'holy',
  Fire: 'fire',
  Frost: 'frost',
  Arcane: 'arcane',
  Shadow: 'shadow',
  Nature: 'nature',
} as const;
export type School = (typeof School)[keyof typeof School];

/** 物理学派不参与「学派锁定」（7.2：物理射击被打断只取消本次动作）*/
export const isMagicSchool = (s: School): boolean => s !== School.Physical;

// ── 9. 职业资源 ──────────────────────────────────────────────────
export const Resource = {
  Health: 'health',
  Rage: 'rage',
  Mana: 'mana',
  HolyPower: 'holyPower',
  Runes: 'runes',
  RunicPower: 'runicPower',
  Energy: 'energy',
  ComboPoints: 'comboPoints',
  Focus: 'focus',
} as const;
export type Resource = (typeof Resource)[keyof typeof Resource];

// ── 8.2 控制递减类别 ─────────────────────────────────────────────
export const DrCategory = {
  /** 昏迷 100→50→25→免疫 */
  Stun: 'stun',
  /** 恐惧/迷惑/变形 100→50→25→免疫，受伤可提前解除 */
  Incapacitate: 'incapacitate',
  /** 定身 100→50→25→免疫，与普通减速分开 */
  Root: 'root',
  /** 沉默 100→50→免疫 */
  Silence: 'silence',
  /** 击退/拉拽 短时间内递减 */
  Knockback: 'knockback',
} as const;
export type DrCategory = (typeof DrCategory)[keyof typeof DrCategory];

// ── 8.4 / 8.3 光环分类，决定能否被驱散和被「战斗意志」解除 ────────
export const AuraKind = {
  Buff: 'buff',
  Debuff: 'debuff',
} as const;
export type AuraKind = (typeof AuraKind)[keyof typeof AuraKind];

/** 驱散类型：只移除技能说明允许的类别（8.4）*/
export const DispelType = {
  Magic: 'magic',
  Curse: 'curse',
  Poison: 'poison',
  Disease: 'disease',
  /** 移动限制（自由祝福解除减速/定身）*/
  Movement: 'movement',
  /** 不可驱散 */
  None: 'none',
} as const;
export type DispelType = (typeof DispelType)[keyof typeof DispelType];

// ── 7.3 中断来源，用于统计与日志归因 ─────────────────────────────
export const InterruptSource = {
  /** 专用打断技能（脚踢/拳击/法术反制…）*/
  Kick: 'kick',
  Silence: 'silence',
  Disarm: 'disarm',
  HardControl: 'hardControl',
  /** 主动移动打断「原地施放」*/
  Movement: 'movement',
  /** 击退/拉拽/冲飞 */
  ForcedMove: 'forcedMove',
  /** 玩家主动取消（假读条，7.5）*/
  SelfCancel: 'selfCancel',
  /** 目标死亡/超距/失去视线 */
  Invalid: 'invalid',
  Death: 'death',
} as const;
export type InterruptSource = (typeof InterruptSource)[keyof typeof InterruptSource];

// ── 5.1 目标层级 ─────────────────────────────────────────────────
export const TargetSlot = {
  Hard: 'hard',
  Focus: 'focus',
  Mouseover: 'mouseover',
} as const;
export type TargetSlot = (typeof TargetSlot)[keyof typeof TargetSlot];

/** 技能允许作用的阵营过滤 */
export const TargetFilter = {
  Enemy: 'enemy',
  Ally: 'ally',
  Self: 'self',
  /** 敌友皆可（少数驱散/位移技能）*/
  Any: 'any',
} as const;
export type TargetFilter = (typeof TargetFilter)[keyof typeof TargetFilter];

// ── 6.2 技能不可用原因，HUD 必须明确显示（15.2）─────────────────
export const CastFailure = {
  Ok: 'ok',
  NoTarget: 'noTarget',
  InvalidTarget: 'invalidTarget',
  OutOfRange: 'outOfRange',
  TooClose: 'tooClose',
  NoLineOfSight: 'noLineOfSight',
  WrongFacing: 'wrongFacing',
  OnCooldown: 'onCooldown',
  OnGlobalCooldown: 'onGlobalCooldown',
  NotEnoughResource: 'notEnoughResource',
  Silenced: 'silenced',
  Disarmed: 'disarmed',
  SchoolLocked: 'schoolLocked',
  Controlled: 'controlled',
  Dead: 'dead',
  /** 地面指示器落在非法位置（6.4）*/
  InvalidGroundPosition: 'invalidGroundPosition',
  /** 10.2 职业不匹配 */
  ClassMismatch: 'classMismatch',
  /** 12.3 旗手限制 */
  CarryingFlag: 'carryingFlag',
  AlreadyCasting: 'alreadyCasting',
  /** 7.6 / 9.x：要求脱离战斗（潜行、猎豹形态潜行）*/
  InCombat: 'inCombat',
  /** 9.x 反击刺：要求近期发生过招架 */
  NoRecentParry: 'noRecentParry',
} as const;
export type CastFailure = (typeof CastFailure)[keyof typeof CastFailure];

// ── 2. 游戏模式 ──────────────────────────────────────────────────
export const GameMode = {
  Arena2v2: 'arena2v2',
  Arena3v3: 'arena3v3',
  Arena5v5: 'arena5v5',
  Ctf6v6: 'ctf6v6',
  Ctf8v8: 'ctf8v8',
  Ctf12v12: 'ctf12v12',
} as const;
export type GameMode = (typeof GameMode)[keyof typeof GameMode];

export const ModeFamily = {
  Arena: 'arena',
  Ctf: 'ctf',
} as const;
export type ModeFamily = (typeof ModeFamily)[keyof typeof ModeFamily];

/** 10.1 竞技场规则预设 */
export const ArenaPreset = {
  /** 经典竞技场：不生成临时武装 */
  Classic: 'classic',
  /** 武装竞技场：开启职业武器、护甲和增益争夺 */
  Armed: 'armed',
} as const;
export type ArenaPreset = (typeof ArenaPreset)[keyof typeof ArenaPreset];

// ── 12.2 旗帜状态 ────────────────────────────────────────────────
export const FlagState = {
  AtBase: 'atBase',
  BeingTaken: 'beingTaken',
  Carried: 'carried',
  Dropped: 'dropped',
  BeingReturned: 'beingReturned',
  BeingCaptured: 'beingCaptured',
  Resetting: 'resetting',
} as const;
export type FlagState = (typeof FlagState)[keyof typeof FlagState];

// ── 10.8 护甲横向方案 ────────────────────────────────────────────
export const ArmorArchetype = {
  /**
   * 标准化基线：职业默认护甲，无任何倾向（10.6：不可删除、永不掉落）。
   *
   * ★ 它必须是独立一项，不能借用 Guardian。`enemyLoadoutView()` 会把 archetype
   *   暴露给对手（10.6 / 验收 #36）—— 标成「守护型」等于告诉对手你在减伤，
   *   而实际上你毫无倾向。给对手错误情报比不给情报更糟。
   */
  Baseline: 'baseline',
  /** 进攻型：攻击/法术/资源效率提高，防御或受到治疗降低 */
  Offense: 'offense',
  /** 守护型：物理防御和爆发承受提高，移动/攻速/施法速度降低 */
  Guardian: 'guardian',
  /** 机动型：移动和追击提高，基础防御、击退抵抗降低 */
  Mobility: 'mobility',
  /** 抗法型：法术伤害与魔法控制承受降低，物理防御降低 */
  SpellWard: 'spellWard',
  /** 抗控型：控制持续时间与击退距离降低，输出/治疗/资源效率降低 */
  Tenacity: 'tenacity',
} as const;
export type ArmorArchetype = (typeof ArmorArchetype)[keyof typeof ArmorArchetype];

/** 10.4 军械箱三选一 */
export const ArsenalChoice = {
  Offense: 'offense',
  Mobility: 'mobility',
  Defense: 'defense',
} as const;
export type ArsenalChoice = (typeof ArsenalChoice)[keyof typeof ArsenalChoice];
