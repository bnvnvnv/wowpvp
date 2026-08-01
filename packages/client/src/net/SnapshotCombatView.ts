/**
 * 用**服务器快照**实现 HUD 的数据契约（`hud/CombatView.ts`）。
 *
 * ★★ 这是 docs/13「判断二」那句话的最终兑现：
 *   「如果表现层能同时吃本地模拟和远端快照，说明它确实没有偷偷依赖模拟内部状态。」
 *   M10 验出来的答案是「它依赖了」（HUD 直读 `dir.world` / `dir.player`）。
 *   把依赖收敛成 `CombatView` 之后，这个类就是那句话的另一半 ——
 *   **同一个 `CombatHud` 现在两边都能喂。**
 *
 * ⚠️ 有几件事快照**给不了**，这里如实降级而不是编造：
 *   · **其他单位的施法状态**：协议用 `CastStarted` / `CastInterrupted` 事件表达，
 *     不在快照里。所以姓名板上的施法条暂时只有自己有 —— 见 `castOf()`。
 *   · **技能栏的可用性**：`blocker` 需要 `validateCast`，而那要 `World`。
 *     这里只按冷却与资源做一个**保守**判断，宁可显示「可用」也不误报不可用
 *     —— 真正的门禁在服务器，客户端猜错只会多一次被拒绝的请求。
 */

import {
  GEOMETRY,
  distance,
  getClass,
  type CastState,
  type EntityId,
  type EntitySnapshot,
  type SkillDef,
  type Snapshot,
  CastFailure,
} from '@wowpvp/shared';

import type {
  CombatView, HudLogEntry, HudSkillSlot, HudUnit,
} from '../hud/CombatView.js';

const toMap = (r: Readonly<Record<string, number>>): ReadonlyMap<string, number> =>
  new Map(Object.entries(r));

/** `EntitySnapshot` → `HudUnit`。★ 只做形状转换，不补充任何快照里没有的信息 */
export const toHudUnit = (e: EntitySnapshot): HudUnit => ({
  id: e.id,
  name: e.name,
  team: e.team,
  classId: e.classId,
  position: e.position,
  // ★ 验收 #10：碰撞体统一取常量，模型大小不改变它 —— 所以这里不必也不该从快照拿
  height: GEOMETRY.HITBOX_HEIGHT,
  alive: e.alive,
  health: e.health,
  maxHealth: e.maxHealth,
  resources: toMap(e.resources),
  maxResources: toMap(e.maxResources),
  weaponId: e.equipment.currentWeaponId,
  flags: e.flags,
});

export class SnapshotCombatView implements CombatView {
  now = 0;
  private snapshot?: Snapshot;
  private units = new Map<number, HudUnit>();
  private selfId?: EntityId;

  /** 自己的施法状态由 `CastStarted` / `CastInterrupted` 事件维护 */
  playerCast: CastState | undefined;
  readonly log: HudLogEntry[] = [];
  skills: readonly SkillDef[] = [];

  targetId?: EntityId;
  focusId?: EntityId;

  /** 点击姓名板时把选中意图发出去。★ 由 NetworkScene 注入，这里不认识连接 */
  onSelect?: (id: EntityId) => void;

  ingest(snapshot: Snapshot, serverTime: number): void {
    this.snapshot = snapshot;
    this.now = serverTime;
    this.selfId = snapshot.you;
    this.units = new Map(snapshot.entities.map((e) => [e.id as number, toHudUnit(e)]));

    // 自己的职业决定技能栏
    const me = snapshot.entities.find((e) => e.id === snapshot.you);
    if (me && this.skills.length === 0) this.skills = getClass(me.classId)?.skills ?? [];
  }

  push(text: string, kind: HudLogEntry['kind']): void {
    this.log.unshift({ time: this.now, text, kind });
    if (this.log.length > 40) this.log.pop();
  }

  get player(): HudUnit {
    const u = this.selfId !== undefined ? this.units.get(this.selfId as number) : undefined;
    // 还没收到第一份快照时给一个空壳，避免 HUD 在开局前崩
    return u ?? EMPTY_UNIT;
  }

  get target(): HudUnit | undefined {
    return this.targetId === undefined ? undefined : this.units.get(this.targetId as number);
  }

  get focus(): HudUnit | undefined {
    return this.focusId === undefined ? undefined : this.units.get(this.focusId as number);
  }

  visibleUnits(): HudUnit[] {
    return [...this.units.values()].filter((u) => u.id !== this.selfId);
  }

  /**
   * ⚠️ 快照里**没有**其他人的施法状态（协议用事件表达），所以这里只回自己的。
   *   如实返回 undefined，而不是编一个假的进度条 —— 假进度条会让玩家
   *   按着一个不存在的读条去打断。
   */
  castOf(unit: HudUnit): CastState | undefined {
    return unit.id === this.selfId ? this.playerCast : undefined;
  }

  distanceTo(unit: HudUnit): number {
    return distance(this.player.position, unit.position);
  }

  /**
   * ⚠️ **保守**判断：只看冷却与资源。真正的门禁（距离/视线/朝向/学派锁定）
   *   要 `World`，客户端没有。宁可显示「可用」也不误报不可用 ——
   *   猜错的代价只是多一次被服务器拒绝的请求，而反过来会让玩家
   *   以为技能坏了。
   */
  skillSlots(): HudSkillSlot[] {
    const cds = this.snapshot?.entities.find((e) => e.id === this.selfId)?.cooldowns ?? {};
    const me = this.player;
    return this.skills.map((skill) => {
      const readyAt = cds[skill.id as string] ?? 0;
      const remaining = Math.max(0, readyAt - this.now);
      const cost = skill.cost;
      const enough = !cost || (me.resources.get(cost.resource) ?? 0) >= cost.amount;
      return {
        skill,
        cooldownRemaining: remaining,
        blocker: remaining > 0
          ? CastFailure.OnCooldown
          : enough ? CastFailure.Ok : CastFailure.NotEnoughResource,
      };
    });
  }

  selectById(id: number): void {
    this.onSelect?.(id as EntityId);
  }
}

/** 开局前的占位。★ 全零而不是 undefined，让 HUD 的渲染路径不必到处判空 */
const EMPTY_UNIT: HudUnit = {
  id: 0 as EntityId,
  name: '',
  team: 0 as HudUnit['team'],
  classId: '' as HudUnit['classId'],
  position: { x: 0, y: 0, z: 0 },
  height: GEOMETRY.HITBOX_HEIGHT,
  alive: true,
  health: 0,
  maxHealth: 1,
  resources: new Map(),
  maxResources: new Map(),
  weaponId: undefined,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
};
