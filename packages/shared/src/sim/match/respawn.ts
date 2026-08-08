/**
 * 波次复活与复活保护。规格书 12.6，验收 #43。
 *
 * 12.6 原文：
 *   「默认每 12 秒进行一次复活波次；加时赛调整为 16 秒。
 *     复活后获得 3 秒保护，主动攻击、治疗或使用技能会提前结束。
 *     **复活保护不能用于直接完成拔旗或交旗。**」
 *
 * ★ 最后一句最容易漏：如果只把复活保护做成「免伤」，玩家就能顶着无敌冲进旗帜房
 *   稳稳拔旗。`flag.beginFlagInteract()` 里对 `spawnProtection` 有一条显式拒绝，
 *   本文件负责的是保护本身的施加与提前结束。
 *
 * ★ 复活保护做成**光环**而不是直接写 `entity.flags.spawnProtection = true`。
 *   原因：`aura.deriveStatusFlags()` 每 tick 从光环重建整个 StatusFlags，
 *   手写的标志会在下一 tick 被抹掉。走光环还顺带白拿三件事 ——
 *   免伤（`immuneAll` 已被 effects/combat.ts 认得）、到期自动移除、HUD 增益条显示。
 *   `dispelType: None` 保证它不会被驱散掉。
 *
 * ★ 验收 #43 还要求「基地出口不会造成永久堵门」——
 *   那由地图的多出口保证（12.5：复活区至少两个出口）+ 出口轮转。
 *   这里只负责把人**轮流**放到不同出口上。
 */

import { CTF } from '../../constants/combat.js';
import type { AuraDef } from '../../data/schema.js';
import type { Vec3 } from '../../math/vec3.js';
import { DispelType } from '../../types/enums.js';
import type { EntityId, TeamId } from '../../types/ids.js';
import { applyAura, removeAuraById, type AuraStore } from '../aura.js';
import type { CombatEntity } from '../entity.js';
import { listEntities, type World } from '../world.js';

/**
 * 复活保护光环。系统光环，不属于任何职业，所以定义在这里而不是 data/classes。
 *
 * `immuneAll` 让 effects/combat.ts 现有的免疫判定直接生效；
 * `spawnProtection` 是给夺旗系统看的标记 —— 两者缺一不可：
 * 只有 immuneAll 会让人能顶着无敌拔旗，只有 spawnProtection 则不免伤。
 */
export const SPAWN_PROTECTION_AURA: AuraDef = {
  id: 'system.spawnProtection',
  name: '复活保护',
  kind: 'buff',
  duration: CTF.SPAWN_PROTECTION_SECONDS,
  dispelType: DispelType.None,
  flags: { immuneAll: true, spawnProtection: true },
  description: '复活后短暂免疫伤害。主动攻击、治疗或使用技能会提前结束，且不能用于拔旗或交旗。',
};

export interface RespawnEntry {
  entityId: EntityId;
  /** 死亡时刻，仅用于统计与日志 */
  diedAt: number;
}

export interface RespawnState {
  /** 等待下一次波次的死亡玩家 */
  pending: RespawnEntry[];
  /** 下一次复活波次的时刻 */
  nextWaveAt: number;
  /** 当前波次间隔。加时赛会改成 16 秒 */
  waveInterval: number;
  /**
   * 每队复活区出口。12.5：复活区至少两个出口。
   * 复活时轮流分配，避免整波人叠在同一个点上（验收 #43）。
   */
  exits: Map<number, readonly Vec3[]>;
  /** 出口轮转游标 */
  exitCursor: Map<number, number>;
}

export const createRespawn = (
  exitsByTeam: Record<number, readonly Vec3[]>,
  now = 0,
  overtime = false,
  /** P13：模式自定波次间隔（大乱斗 8 秒 —— 混战节奏死 12 秒太漫长）。不传走 12.6 默认 */
  intervalOverride?: number,
): RespawnState => {
  const waveInterval = intervalOverride ?? (overtime
    ? CTF.RESPAWN_WAVE_SECONDS_OVERTIME
    : CTF.RESPAWN_WAVE_SECONDS);
  return {
    pending: [],
    nextWaveAt: now + waveInterval,
    waveInterval,
    exits: new Map(Object.entries(exitsByTeam).map(([k, v]) => [Number(k), v])),
    exitCursor: new Map(),
  };
};

/**
 * 加时赛把波次间隔从 12 秒调整为 16 秒（12.6）。
 * 已经在倒计时的那一波按新间隔重排，不让切换瞬间白送一次复活。
 */
export const setOvertime = (state: RespawnState, overtime: boolean, now: number): void => {
  const next = overtime ? CTF.RESPAWN_WAVE_SECONDS_OVERTIME : CTF.RESPAWN_WAVE_SECONDS;
  if (next === state.waveInterval) return;
  state.waveInterval = next;
  state.nextWaveAt = now + next;
};

/** 死亡时入队。重复入队无效（一个人不该在一波里复活两次）*/
export const enqueueRespawn = (state: RespawnState, entityId: EntityId, now: number): boolean => {
  if (state.pending.some((p) => p.entityId === entityId)) return false;
  state.pending.push({ entityId, diedAt: now });
  return true;
};

export interface RespawnEvent {
  entityId: EntityId;
  position: Vec3;
  protectedUntil: number;
}

/**
 * 推进复活一个 tick。
 *
 * 12.6 是**波次**复活而不是各自倒计时：到点时把队列里的人一起放出来。
 * 这是有意的 —— 波次让防守方有可预测的进攻窗口，各自倒计时会退化成添油战术。
 *
 * 光环的到期由 `tickAuras()` 统一处理，这里不需要管。
 */
export const tickRespawn = (
  state: RespawnState,
  world: World,
  auras: AuraStore,
  now: number,
): RespawnEvent[] => {
  if (now < state.nextWaveAt) return [];
  state.nextWaveAt = now + state.waveInterval;

  const wave = state.pending;
  state.pending = [];

  const events: RespawnEvent[] = [];
  for (const entry of wave) {
    const e = world.entities.get(entry.entityId);
    if (!e) continue;

    const position = nextExitFor(state, e.team);
    e.alive = true;
    e.health = e.maxHealth;
    e.position = { ...position };
    // 12.6：复活后获得 3 秒保护。sourceId 用自己 —— 系统光环没有施法者
    applyAura(auras, e, SPAWN_PROTECTION_AURA, e.id, now);

    events.push({
      entityId: e.id,
      position,
      protectedUntil: now + CTF.SPAWN_PROTECTION_SECONDS,
    });
  }
  return events;
};

/**
 * 12.5 / 验收 #43：复活区至少两个出口，轮流分配。
 * 整波人挤在同一个点，会把基地出口变成人肉堵门。
 */
const nextExitFor = (state: RespawnState, team: TeamId): Vec3 => {
  const exits = state.exits.get(team as number) ?? [];
  if (exits.length === 0) return { x: 0, y: 0, z: 0 };
  const cursor = state.exitCursor.get(team as number) ?? 0;
  state.exitCursor.set(team as number, (cursor + 1) % exits.length);
  return exits[cursor % exits.length]!;
};

/**
 * ★ 12.6：「主动攻击、治疗或使用技能会提前结束」复活保护。
 *
 * 由施法与普通攻击的入口调用（见 casting.beginCast / 普攻结算）。
 * 返回是否真的结束了保护，供日志与统计使用。
 */
export const breakSpawnProtection = (auras: AuraStore, entity: CombatEntity): boolean => {
  const removed = removeAuraById(auras, entity.id, SPAWN_PROTECTION_AURA.id, 'cancelled');
  if (removed.length === 0) return false;
  entity.flags.spawnProtection = false;
  entity.flags.immuneAll = false;
  return true;
};

/** 距离下一次复活波次还有多久，供 HUD 倒计时显示 */
export const secondsToNextWave = (state: RespawnState, now: number): number =>
  Math.max(0, state.nextWaveAt - now);

/** 是否正在等待复活（死亡但还没到波次）*/
export const isAwaitingRespawn = (state: RespawnState, id: EntityId): boolean =>
  state.pending.some((p) => p.entityId === id);

/** 重置（新的一局）*/
export const resetRespawn = (state: RespawnState, world: World, now: number): void => {
  state.pending = [];
  state.nextWaveAt = now + state.waveInterval;
  state.exitCursor.clear();
  for (const e of listEntities(world)) {
    e.flags.spawnProtection = false;
  }
};
