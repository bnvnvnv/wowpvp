/**
 * 目标系统。规格书 5.1–5.3、5.6，验收 #4 / #5 / #6。
 *
 * 核心区分（5.1）：
 *   硬目标   —— 持续保留，直到切换、目标离场或玩家主动清除
 *   焦点目标 —— 独立于硬目标，用于监视施法
 *   鼠标指向 —— 仅当前帧有效，**不改变硬目标**
 *   软提示   —— 只高亮，**绝不自动成为攻击目标**（点击或 Tab 后才锁定）
 *   目标的目标 —— 派生只读，帮助判断集火与保护方向
 */

import { RANGE, TARGETING } from '../constants/combat.js';
import { angleDelta, DEG, dirToYaw, distance, normalize2D, sub } from '../math/vec3.js';
import { hasLineOfSight } from '../math/geometry.js';
import { TargetFilter } from '../types/enums.js';
import type { EntityId } from '../types/ids.js';
import {
  hitCircleOf,
  isFriendly,
  isHostile,
  isSelectableBy,
  type CombatEntity,
} from './entity.js';
import { getEntity, listEntities, type World } from './world.js';

// ── 槽位操作 ─────────────────────────────────────────────────────

/**
 * 设置硬目标。
 * 5.1：硬目标**持续保留**，超距或被墙遮挡都不会自动清除（验收 #6）——
 * 只有切换、目标离场、玩家主动清除才会变。这里只做「能不能选中」的校验。
 */
export const setHardTarget = (
  world: World,
  actor: CombatEntity,
  targetId: EntityId | undefined,
): boolean => {
  if (targetId === undefined) {
    delete actor.targets.hard;
    return true;
  }
  const t = getEntity(world, targetId);
  if (!t || !isSelectableBy(t, actor)) return false;
  actor.targets.hard = targetId;
  return true;
};

/** 5.1 焦点：再次对同一目标使用会清除 */
export const toggleFocus = (
  world: World,
  actor: CombatEntity,
  targetId: EntityId | undefined,
): void => {
  if (targetId === undefined || actor.targets.focus === targetId) {
    delete actor.targets.focus;
    return;
  }
  const t = getEntity(world, targetId);
  if (t && isSelectableBy(t, actor)) actor.targets.focus = targetId;
};

/**
 * 5.1「当前目标的目标」：派生值，帮助判断集火与保护方向。
 * 不存状态，每次现算 —— 存了就会有失效问题。
 */
export const targetOfTarget = (world: World, actor: CombatEntity): CombatEntity | undefined => {
  const hard = getEntity(world, actor.targets.hard);
  return getEntity(world, hard?.targets.hard);
};

/**
 * 目标离场时清理槽位。
 * 5.1 只说「目标离场」才清除 —— 死亡、退出、被移出可见集合属于离场，
 * 超距和被遮挡**不属于**（验收 #6）。
 */
export const pruneInvalidTargets = (world: World, actor: CombatEntity): void => {
  for (const slot of ['hard', 'focus', 'mouseover'] as const) {
    const id = actor.targets[slot];
    if (id === undefined) continue;
    const t = getEntity(world, id);
    if (!t || !t.alive || !isSelectableBy(t, actor)) delete actor.targets[slot];
  }
};

// ── 5.3 Tab 循环 ─────────────────────────────────────────────────

/**
 * 排序所需的**最小**信息。
 *
 * ★★ 刻意**不含实体本身** —— 5.3 的优先级规则只需要这几个量，
 *   而客户端只有**快照**（`EntitySnapshot`），没有 `CombatEntity`。
 *   把规则写成只依赖这个形状，客户端就能复用**同一个** `sortTabCandidates()`，
 *   而不必照着 5.3 再实现一遍排序 —— 那一遍必然会漂移。
 */
export interface TabRanking {
  id: EntityId;
  /** 与视线中心的夹角，弧度。越小越靠近屏幕中心 */
  angleFromCenter: number;
  distance: number;
  visible: boolean;
  casting: boolean;
  isFlagCarrier: boolean;
}

export interface TabCandidate extends TabRanking {
  entity: CombatEntity;
}

export interface TabOptions {
  /** ★ 5.3 用的是**镜头**前方 140°，不是角色朝向 */
  viewYaw: number;
  /** 是否把宠物纳入循环。5.3：默认不纳入，玩家可在设置中开启 */
  includePets?: boolean;
  /** 某个实体是否正在施法。由 casting 模块注入，避免这里反向依赖 */
  isCasting?: (e: CombatEntity) => boolean;
}

/**
 * 收集 Tab 候选。
 *
 * 过滤规则（5.3）：
 *   - 45 米内
 *   - 位于**镜头**前方 140° 内 —— 完全在身后的不进首轮列表
 *   - 敌对、存活、可被选中
 *   - **排除未被发现的潜行目标**（验收 #5）
 *   - 宠物默认排除
 */
export const collectTabCandidates = (
  world: World,
  actor: CombatEntity,
  opts: TabOptions,
): TabCandidate[] => {
  const halfArc = (TARGETING.TAB_FRONT_ARC_DEG / 2) * DEG;
  const out: TabCandidate[] = [];

  for (const e of listEntities(world)) {
    if (e.id === actor.id) continue;
    if (!isHostile(actor, e)) continue;
    if (!isSelectableBy(e, actor)) continue;
    if (e.isPet && !opts.includePets) continue;

    const d = distance(actor.position, e.position);
    if (d > TARGETING.TAB_MAX_RANGE) continue;

    const toTarget = normalize2D(sub(e.position, actor.position));
    const angleFromCenter = angleDelta(opts.viewYaw, dirToYaw(toTarget));
    if (angleFromCenter > halfArc) continue;

    out.push({
      entity: e,
      id: e.id,
      angleFromCenter,
      distance: d,
      // 5.3：被完整墙体遮挡的目标可以保持已选中，但不优先进入新的 Tab 候选
      visible: hasLineOfSight(hitCircleOf(actor), hitCircleOf(e), world.obstacles),
      casting: opts.isCasting?.(e) ?? false,
      isFlagCarrier: e.flags.carryingFlag,
    });
  }
  return out;
};

/**
 * 5.3 优先级排序：屏幕中心附近 → 距离较近 → 当前可见 → 正在施法 → 敌方旗手。
 *
 * 「屏幕中心附近」和「距离较近」都是连续量，直接按字典序比会让后面的条件永远
 * 用不上。因此把连续量分档：中心夹角每 20° 一档、距离每 8 米一档，
 * 同档内再看可见/施法/旗手这些离散条件。
 */
const CENTER_BUCKET = 20 * DEG;
const DISTANCE_BUCKET = 8;

export const sortTabCandidates = <T extends TabRanking>(candidates: readonly T[]): T[] =>
  [...candidates].sort((a, b) => {
    const ca = Math.floor(a.angleFromCenter / CENTER_BUCKET);
    const cb = Math.floor(b.angleFromCenter / CENTER_BUCKET);
    if (ca !== cb) return ca - cb;

    const da = Math.floor(a.distance / DISTANCE_BUCKET);
    const db = Math.floor(b.distance / DISTANCE_BUCKET);
    if (da !== db) return da - db;

    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    if (a.casting !== b.casting) return a.casting ? -1 : 1;
    if (a.isFlagCarrier !== b.isFlagCarrier) return a.isFlagCarrier ? -1 : 1;

    // 同档内用精确值收敛，保证排序稳定且确定
    if (a.angleFromCenter !== b.angleFromCenter) return a.angleFromCenter - b.angleFromCenter;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return (a.id as number) - (b.id as number);
  });

/**
 * 执行一次 Tab 切换。返回新的硬目标；没有候选时返回 undefined 且**保持原目标不变**。
 * `reverse` 对应 Shift+Tab。
 */
/**
 * 从已排序的候选里挑「下一个」。
 *
 * ★ 抽出来是为了让客户端复用同一套循环语义（含「当前目标不在候选里就从头开始」
 *   这条边界）—— 客户端只有快照，但循环规则应当一模一样。
 */
export const nextTabPick = <T extends TabRanking>(
  sorted: readonly T[],
  currentId: EntityId | undefined,
  reverse = false,
): T | undefined => {
  if (sorted.length === 0) return undefined;
  const currentIndex = sorted.findIndex((c) => c.id === currentId);
  const next = currentIndex === -1
    // 当前目标不在候选里（可能被墙挡住或已超距）→ 从头开始
    ? (reverse ? sorted.length - 1 : 0)
    : (currentIndex + (reverse ? -1 : 1) + sorted.length) % sorted.length;
  return sorted[next];
};

export const tabTarget = (
  world: World,
  actor: CombatEntity,
  opts: TabOptions,
  reverse = false,
): CombatEntity | undefined => {
  const sorted = sortTabCandidates(collectTabCandidates(world, actor, opts));
  const picked = nextTabPick(sorted, actor.targets.hard, reverse);
  if (!picked) return undefined;

  actor.targets.hard = picked.entity.id;
  return picked.entity;
};

// ── 5.6 技能取目标 ───────────────────────────────────────────────

export interface ResolveTargetOptions {
  /** 玩家是否按住了自我施法键 */
  selfCastHeld?: boolean;
  /** 技能是否支持鼠标指向施法（治疗、驱散、保护）*/
  allowMouseover?: boolean;
}

export type ResolvedTarget =
  | { ok: true; target: CombatEntity }
  | { ok: false; reason: 'noTarget' | 'invalidTarget' };

/**
 * 按 5.6 决定技能作用于谁。
 *
 * 优先级：鼠标指向（若技能支持且合法）→ 硬目标 → 自我（若允许）。
 *
 * ★ 5.6：攻击型直接目标技能在没有目标时**不自动攻击随机敌人**，只提示「需要目标」。
 *   「无目标时选择最近正面敌人」的辅助选项标准竞技规则下默认关闭，因此这里不实现。
 */
export const resolveSkillTarget = (
  world: World,
  actor: CombatEntity,
  filter: TargetFilter,
  opts: ResolveTargetOptions = {},
): ResolvedTarget => {
  if (filter === TargetFilter.Self) return { ok: true, target: actor };

  const matches = (t: CombatEntity): boolean => {
    if (!isSelectableBy(t, actor)) return false;
    switch (filter) {
      case TargetFilter.Enemy:
        return isHostile(actor, t);
      case TargetFilter.Ally:
        return isFriendly(actor, t);
      case TargetFilter.Any:
        return true;
      default:
        return false;
    }
  };

  if (opts.allowMouseover) {
    const mo = getEntity(world, actor.targets.mouseover);
    if (mo && matches(mo)) return { ok: true, target: mo };
  }

  // 5.6：治疗技能在没有**合法友方目标**时，按住自我施法键可对自己使用。
  // 注意是「按住键」才落到自己 —— 默认不自动自疗，否则治疗者会在想救队友时误奶自己。
  const fallbackToSelf = filter === TargetFilter.Ally && opts.selfCastHeld === true;

  const hard = getEntity(world, actor.targets.hard);
  if (hard) {
    if (matches(hard)) return { ok: true, target: hard };
    if (fallbackToSelf) return { ok: true, target: actor };
    return { ok: false, reason: 'invalidTarget' };
  }

  if (fallbackToSelf) return { ok: true, target: actor };

  // ★ 5.6：攻击型技能在没有目标时不自动攻击随机敌人，只提示「需要目标」
  return { ok: false, reason: 'noTarget' };
};

/** 最大选中距离常量的再导出，客户端画姓名板时要用 */
export const MAX_SELECT_RANGE = RANGE.MAX_SELECT;
