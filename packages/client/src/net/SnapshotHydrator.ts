/**
 * P11 快照瘦身的**解码边界**：把 wire 形态还原成下游读的完整形态。
 *
 * ★★ 还原的四样东西与服务器的拆分一一对应（visibility.ts / protocol.ts）：
 *     1. 位掩码 `f` → `displayFlagsOf()` 展开回 DisplayFlags + alive/teleported
 *     2. 静态块（name/team/classId/maxHealth/maxResources）→ 来自每会话的
 *        `EntityMeta` 通道（首见必发），按实体 id 缓存合回
 *     3. 装备 → 同一条 `EntityMeta` 通道（首见 + 变更时发）
 *     4. self 段（cooldowns/gcd/焦点/重放状态/可拾取列表）→ 合回
 *        `you` 那个实体与 drops 的 `pickable` —— 波3 把它们从共享的
 *        实体段搬了出去（同队共享同一份字节），下游契约不变
 *
 * ★ 全部还原都在这**一个**入口完成 —— 下游（Interpolator / HUD / 画面 /
 *   Predictor）拿到的是完整形状，与试验场共用的契约（DisplayFlags 等）
 *   一个都不用改。往下游塞半还原的实体在类型上就不成立。
 *
 * ★ 缓存按实体 id 记，必须在 `MatchStart` 时清（`reset()`）：
 *   「再来一局」会复用实体 id，旧局的静态块/装备套在新局身上是错的。
 *   重连也走 MatchStart（服务器重发），清了之后服务器那边的新 Session
 *   记账恰好也是空的 —— 两边同步全量重来。
 */

import {
  displayFlagsOf,
  ENTITY_FLAG_BITS,
  type AllyEquipmentSnapshot,
  type EnemyEquipmentSnapshot,
  type EntityId,
  type EntitySnapshot,
  type EntityStaticsSnapshot,
  type HydratedEntitySnapshot,
  type HydratedSnapshot,
  type SelfStateSnapshot,
  type SnapshotMessage,
} from '@wowpvp/shared';

export class SnapshotHydrator {
  private readonly statics = new Map<EntityId, EntityStaticsSnapshot>();
  private readonly loadouts = new Map<
    EntityId, AllyEquipmentSnapshot | EnemyEquipmentSnapshot
  >();

  /** MatchStart（含重连）时清空 —— 见文件头 */
  reset(): void {
    this.statics.clear();
    this.loadouts.clear();
  }

  /** `EntityMeta` 消息的落点。statics 首见到达一次；equipment 变更时覆盖 */
  setMeta(
    items: readonly {
      entityId: EntityId;
      statics?: EntityStaticsSnapshot;
      equipment?: AllyEquipmentSnapshot | EnemyEquipmentSnapshot;
    }[],
  ): void {
    for (const it of items) {
      if (it.statics) this.statics.set(it.entityId, it.statics);
      if (it.equipment) this.loadouts.set(it.entityId, it.equipment);
    }
  }

  /** 整份快照的还原（实体 + drops.pickable）。self 段合到 `you` 实体上 */
  hydrateSnapshot(msg: SnapshotMessage): HydratedSnapshot {
    const pickable = new Set(msg.self?.pickableDropIds ?? []);
    return {
      tick: msg.tick,
      you: msg.you,
      entities: this.hydrate(msg.entities, msg.you, msg.self),
      projectiles: msg.projectiles,
      grounds: msg.grounds,
      drops: msg.drops.map((d) => ({ ...d, pickable: pickable.has(d.id) })),
      armories: msg.armories,
      match: msg.match,
      ...(msg.self ? { self: msg.self } : {}),
    };
  }

  hydrate(
    entities: readonly EntitySnapshot[],
    you?: EntityId,
    self?: SelfStateSnapshot,
  ): HydratedEntitySnapshot[] {
    const out: HydratedEntitySnapshot[] = [];
    for (const e of entities) {
      const st = this.statics.get(e.id);
      if (!st) {
        /**
         * 缓存缺失 —— 服务器契约被破坏（EntityMeta 首见必先于快照到达）。
         * 跳过这个实体并留痕，比造一个字段全空的实体污染下游更可诊断。
         */
        console.warn(`SnapshotHydrator：实体 ${e.id} 无静态块可用，本帧跳过`);
        continue;
      }

      const f = e.f ?? 0;
      const isYou = you !== undefined && e.id === you;
      out.push({
        id: e.id,
        name: st.name,
        team: st.team,
        classId: st.classId,
        position: e.position,
        yaw: e.yaw,
        health: e.health,
        maxHealth: st.maxHealth,
        alive: (f & ENTITY_FLAG_BITS.dead) === 0,
        resources: e.resources,
        maxResources: st.maxResources,
        auras: e.auras,
        carryingFlag: (f & ENTITY_FLAG_BITS.carryingFlag) !== 0,
        flags: displayFlagsOf(f),
        teleported: (f & ENTITY_FLAG_BITS.teleported) !== 0,
        // ── self 段只合到 you 身上（观战跟随时 you = 被跟随者，语义原样）──
        ...(isYou && self ? { cooldowns: self.cooldowns } : {}),
        ...(isYou && self?.gcdUntil !== undefined ? { gcdUntil: self.gcdUntil } : {}),
        ...(isYou && self?.focusId !== undefined ? { focusId: self.focusId } : {}),
        ...(isYou && self?.hardTargetId !== undefined ? { hardTargetId: self.hardTargetId } : {}),
        ...(isYou && self?.selfMovement ? { selfMovement: self.selfMovement } : {}),
        ...(() => {
          const eq = this.loadouts.get(e.id);
          return eq ? { equipment: eq } : {};
        })(),
      });
    }
    return out;
  }
}
