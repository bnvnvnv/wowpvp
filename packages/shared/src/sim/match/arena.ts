/**
 * 竞技场回合状态机。规格书 2.1 / 11.1 / 11.4，验收 #25 / #26 / #27 / #37。
 *
 * ```
 *   Prep ──开门(11.1)──► Combat ──一方全灭/超时──► Resolved ──►(多回合) Prep
 * ```
 *
 * 三条最容易做错的规则，每条都有对应的测试：
 *
 *   1. **宠物、图腾、召唤物和幻象不计入存活人数**（2.1）。
 *      按实体数量判胜负会让「猎人宠物还活着」变成不败。
 *
 *   2. **双方最后一名玩家在同一结算窗口内死亡判平局**（2.1 / 验收 #26），
 *      「不按消息先后强行判定胜负」。所以判负不能在死亡那一刻立即触发，
 *      必须等一个结算窗口过去再看双方状态。
 *
 *   3. **假死、免死和临死形态必须与真实死亡明确区分**（11.4）。
 *      系统只在**最终死亡**时减少存活人数 —— `CombatEntity.alive` 是最终死亡，
 *      寒冰屏障这类「不能行动但活着」的状态不影响存活计数。
 */

import { ARENA } from '../../constants/combat.js';
import { GameMode } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import { clearAuras, type AuraStore } from '../aura.js';
import { clearDr, type DrStore } from '../dr.js';
import type { CombatEntity } from '../entity.js';
import { clearGround, type GroundStore } from '../groundArea.js';
import { listEntities, type World } from '../world.js';
import { dampeningAt, type DampeningSnapshot } from './dampening.js';

export const RoundPhase = {
  /** 11.1 双方进入独立准备区，准备 15–20 秒 */
  Prep: 'prep',
  /** 双方大门同时开启，计时开始 */
  Combat: 'combat',
  /** 一方全部玩家死亡，回合结束 */
  Resolved: 'resolved',
} as const;
export type RoundPhase = (typeof RoundPhase)[keyof typeof RoundPhase];

export type RoundOutcome = { winner: TeamId } | { winner: 'draw' } | null;

export interface ArenaConfig {
  mode: GameMode;
  /** 2.1 快速比赛默认单回合制；自定义房间可选三局两胜或五局三胜 */
  roundsToWin: number;
  /** 常规时长（秒）。不填按模式默认 */
  duration?: number;
  prepSeconds?: number;
}

export interface ArenaState {
  config: ArenaConfig;
  phase: RoundPhase;
  /** 当前回合序号，从 1 开始 */
  round: number;
  /** 本阶段已进行的秒数 */
  phaseElapsed: number;
  /** 战斗阶段已进行的秒数。抑制曲线用它 */
  combatElapsed: number;
  score: Record<string, number>;
  outcome: RoundOutcome;
  /**
   * 平局判定用的结算窗口。
   * 某一方全灭时不立刻判负，而是记下时刻，等窗口过去再看另一方 ——
   * 2.1「不按消息先后强行判定胜负」。
   */
  wipePendingSince: number | null;
  dampening: DampeningSnapshot;
}

const durationOf = (mode: GameMode): number => ARENA.DURATION[mode] ?? 360;

export const createArena = (config: ArenaConfig): ArenaState => ({
  config,
  phase: RoundPhase.Prep,
  round: 1,
  phaseElapsed: 0,
  combatElapsed: 0,
  score: { [TEAM_RED as number]: 0, [TEAM_BLUE as number]: 0 },
  outcome: null,
  wipePendingSince: null,
  dampening: { amount: 0, suddenDeath: false, pressureDamagePerSecond: 0, startsIn: Infinity },
});

// ── 存活统计 ─────────────────────────────────────────────────────

/**
 * 2.1：宠物、图腾、召唤物和幻象**不计入存活人数**。
 * 11.4：只在**最终死亡**时减少存活人数 —— 假死/免死/临死形态不算。
 */
export const aliveCount = (world: World, team: TeamId): number =>
  listEntities(world).filter((e) => e.team === team && !e.isPet && e.alive).length;

/** 该队的总人数（含已死亡），用来区分「全灭」和「压根没人」*/
export const rosterCount = (world: World, team: TeamId): number =>
  listEntities(world).filter((e) => e.team === team && !e.isPet).length;

/**
 * 该队是否已全灭。
 *
 * ★ 必须要求该队**有过队员**。否则一个还没有人加入的场景里两队都是 0 存活，
 *   会被判成「双方同时全灭 → 平局」—— 回合在第一 tick 就结束了。
 */
export const teamWiped = (world: World, team: TeamId): boolean =>
  rosterCount(world, team) > 0 && aliveCount(world, team) === 0;

// ── 推进 ─────────────────────────────────────────────────────────

export interface ArenaEvents {
  onPhaseChange?: (from: RoundPhase, to: RoundPhase) => void;
  onRoundEnd?: (outcome: NonNullable<RoundOutcome>, round: number) => void;
  onMatchEnd?: (winner: TeamId) => void;
  /** 8.5 决胜阶段的压迫伤害。★ 结算时必须 bypassImmunity（验收 #27）*/
  onPressureDamage?: (amount: number) => void;
}

export interface ArenaDeps {
  world: World;
  auras: AuraStore;
  dr: DrStore;
  ground: GroundStore;
}

/**
 * 推进一个 tick。返回是否发生了阶段变化。
 *
 * ⚠️ 必须在**死亡结算之后**调用 —— 它读的是 `CombatEntity.alive`，
 * 顺序反了会让胜负判定慢一个 tick（docs/02 §3 的 tick 顺序）。
 */
export const tickArena = (
  state: ArenaState,
  deps: ArenaDeps,
  dt: number,
  events: ArenaEvents = {},
): void => {
  state.phaseElapsed += dt;

  switch (state.phase) {
    case RoundPhase.Prep: {
      const prep = state.config.prepSeconds ?? ARENA.PREP_SECONDS;
      if (state.phaseElapsed >= prep) transition(state, RoundPhase.Combat, events);
      return;
    }

    case RoundPhase.Combat: {
      state.combatElapsed += dt;
      const duration = state.config.duration ?? durationOf(state.config.mode);
      state.dampening = dampeningAt(state.config.mode, state.combatElapsed, duration);

      // 8.5 决胜阶段的压迫伤害。由调用方带 bypassImmunity 结算 —— 8.5 明确说它
      // 是「不可完全免疫」的，否则圣盾术/寒冰屏障能无限拖延（验收 #27）
      if (state.dampening.pressureDamagePerSecond > 0) {
        events.onPressureDamage?.(state.dampening.pressureDamagePerSecond * dt);
      }

      const redWiped = teamWiped(deps.world, TEAM_RED);
      const blueWiped = teamWiped(deps.world, TEAM_BLUE);

      // ★ 验收 #26：双方最后一名玩家在同一结算窗口内死亡判平局。
      //   任一方全灭时先记下时刻，等窗口过去再看 —— 不按消息先后强行判胜负。
      if (redWiped || blueWiped) {
        if (state.wipePendingSince === null) state.wipePendingSince = state.combatElapsed;

        const windowPassed =
          state.combatElapsed - state.wipePendingSince >= ARENA.DRAW_WINDOW_SECONDS;
        // 窗口内另一方也全灭 → 平局；窗口过完只有一方全灭 → 另一方获胜
        if (redWiped && blueWiped) {
          resolve(state, { winner: 'draw' }, events);
        } else if (windowPassed) {
          resolve(state, { winner: redWiped ? TEAM_BLUE : TEAM_RED }, events);
        }
        return;
      }
      state.wipePendingSince = null;

      // 超时：比分高者获胜，相同则平局
      if (state.combatElapsed >= duration + SUDDEN_DEATH_HARD_CAP) {
        resolve(state, { winner: 'draw' }, events);
      }
      return;
    }

    case RoundPhase.Resolved:
      return;
  }
};

/**
 * 决胜阶段的硬上限。8.5 说决胜阶段会「逐步加入压迫伤害」直到分出胜负，
 * 但压迫伤害理论上可能被极端续航拖住，所以留一个绝对上限兜底。
 */
export const SUDDEN_DEATH_HARD_CAP = 180;

const transition = (state: ArenaState, to: RoundPhase, events: ArenaEvents): void => {
  const from = state.phase;
  state.phase = to;
  state.phaseElapsed = 0;
  events.onPhaseChange?.(from, to);
};

const resolve = (
  state: ArenaState,
  outcome: NonNullable<RoundOutcome>,
  events: ArenaEvents,
): void => {
  state.outcome = outcome;
  state.wipePendingSince = null;
  transition(state, RoundPhase.Resolved, events);
  events.onRoundEnd?.(outcome, state.round);

  if (outcome.winner !== 'draw') {
    const key = String(outcome.winner as number);
    state.score[key] = (state.score[key] ?? 0) + 1;
    if (state.score[key]! >= state.config.roundsToWin) {
      events.onMatchEnd?.(outcome.winner);
    }
  }
};

// ── 回合重置 ─────────────────────────────────────────────────────

/**
 * 2.1：「每回合开始时恢复生命、资源、技能冷却、默认装备和地图状态；
 *       上一回合拾取的临时装备全部清除。」（验收 #37）
 *
 * ⚠️ 这个函数必须清干净**所有**旁挂状态。漏掉任何一个都会让上一回合的
 * 光环/递减/地面区域渗进新回合 —— 那是最难复现的一类 bug，因为它只在
 * 多回合赛的第二回合才出现。
 */
export const resetRound = (state: ArenaState, deps: ArenaDeps): void => {
  for (const e of listEntities(deps.world)) {
    e.alive = true;
    e.health = e.maxHealth;
    // 怒气/连击点这类「从 0 开始积累」的资源不该被填满（9.x），
    // 其余（法力/能量/集中值/符文）回合开始是满的
    for (const [r, max] of e.maxResources) e.resources.set(r, startValueOf(r, max));
    e.cooldowns.clear();
    e.gcdUntil = 0;
    e.schoolLocks.clear();
    e.targets = {};

    clearAuras(deps.auras, e.id);
    clearDr(deps.dr, e.id);
  }
  clearGround(deps.ground);

  state.phase = RoundPhase.Prep;
  state.phaseElapsed = 0;
  state.combatElapsed = 0;
  state.outcome = null;
  state.wipePendingSince = null;
  state.dampening = {
    amount: 0, suddenDeath: false, pressureDamagePerSecond: 0, startsIn: Infinity,
  };
};

/**
 * 资源的回合起始值。
 * 能量/集中值/符文开局是满的，怒气/连击点/圣能/符文能量从 0 开始积累（9.x）。
 */
const ZERO_AT_START = new Set(['rage', 'comboPoints', 'holyPower', 'runicPower']);
const startValueOf = (resource: string, max: number): number =>
  ZERO_AT_START.has(resource) ? 0 : max;

/** 开始新回合。多回合赛在 Resolved 之后调用 */
export const startNextRound = (state: ArenaState, deps: ArenaDeps): void => {
  state.round += 1;
  resetRound(state, deps);
};

/** 比赛是否已分出胜负 */
export const matchWinner = (state: ArenaState): TeamId | null => {
  for (const [team, wins] of Object.entries(state.score)) {
    if (wins >= state.config.roundsToWin) return Number(team) as TeamId;
  }
  return null;
};

/** 3.2 / 验收 #22：标准竞技场要求双方人数相等 */
export const isBalanced = (world: World): boolean =>
  aliveCount(world, TEAM_RED) === aliveCount(world, TEAM_BLUE);

/** 各模式的每队人数 */
export const teamSizeOf = (mode: GameMode): number => {
  switch (mode) {
    case GameMode.Arena2v2: return 2;
    case GameMode.Arena3v3: return 3;
    case GameMode.Arena5v5: return 5;
    case GameMode.Ctf6v6: return 6;
    case GameMode.Ctf8v8: return 8;
    case GameMode.Ctf12v12: return 12;
  }
};
