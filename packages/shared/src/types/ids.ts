/**
 * 带标签的 ID 类型。用编译期标签避免把 SkillId 误传成 EntityId 这类错误，
 * 运行时它们就是普通字符串/数字，没有额外开销。
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 场上实体（玩家、宠物、图腾、投射物、地面区域、旗帜、军械箱……）*/
export type EntityId = Brand<number, 'EntityId'>;
/** 队伍：0 = 红方，1 = 蓝方 */
export type TeamId = Brand<number, 'TeamId'>;
/** 技能定义 ID，如 'warrior.charge' */
export type SkillId = Brand<string, 'SkillId'>;
/** 光环（增益/减益）定义 ID，如 'warrior.hamstring.slow' */
export type AuraId = Brand<string, 'AuraId'>;
/** 职业 ID，如 'warrior' */
export type ClassId = Brand<string, 'ClassId'>;
/** 武器方案 ID，如 'warrior.sword_shield' */
export type WeaponId = Brand<string, 'WeaponId'>;
/** 护甲方案 ID，如 'warrior.guardian' */
export type ArmorId = Brand<string, 'ArmorId'>;
/** 主动增益道具 ID */
export type ConsumableId = Brand<string, 'ConsumableId'>;
/** 地图 ID */
export type MapId = Brand<string, 'MapId'>;
/** 房间 ID */
export type RoomId = Brand<string, 'RoomId'>;

export const asEntityId = (n: number): EntityId => n as EntityId;
export const asTeamId = (n: number): TeamId => n as TeamId;
export const asSkillId = (s: string): SkillId => s as SkillId;
export const asAuraId = (s: string): AuraId => s as AuraId;
export const asClassId = (s: string): ClassId => s as ClassId;
export const asWeaponId = (s: string): WeaponId => s as WeaponId;
export const asArmorId = (s: string): ArmorId => s as ArmorId;
export const asConsumableId = (s: string): ConsumableId => s as ConsumableId;
export const asMapId = (s: string): MapId => s as MapId;

export const TEAM_RED = asTeamId(0);
export const TEAM_BLUE = asTeamId(1);
/** 中立（军械箱、场景物件）*/
export const TEAM_NEUTRAL = asTeamId(-1);

export const opposingTeam = (t: TeamId): TeamId =>
  t === TEAM_RED ? TEAM_BLUE : TEAM_RED;
