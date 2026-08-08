/**
 * P11 快照瘦身的**解码边界**：把 wire 形态的 `EntitySnapshot` 还原成
 * 下游读的 `HydratedEntitySnapshot`。
 *
 * ★★ 还原的三样东西与服务器的三条瘦身规则一一对应（visibility.ts 的
 *   `EntitySnapshot` 文件头）：
 *     1. 位掩码 `f` → `displayFlagsOf()` 展开回 DisplayFlags + alive/teleported
 *     2. 静态块（name/team/classId/maxHealth/maxResources）→ 首见时随快照
 *        到达，存进 `statics`；后续快照从缓存合回
 *     3. 装备 → 从 `EntityLoadouts` 通道的缓存合回（服务器保证该消息先于
 *        含新实体的快照到达）
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
  type ClassId,
  type EnemyEquipmentSnapshot,
  type EntityId,
  type EntitySnapshot,
  type HydratedEntitySnapshot,
  type TeamId,
} from '@wowpvp/shared';

interface EntityStatics {
  name: string;
  team: TeamId;
  classId: ClassId;
  maxHealth: number;
  maxResources: Readonly<Record<string, number>>;
}

export class SnapshotHydrator {
  private readonly statics = new Map<EntityId, EntityStatics>();
  private readonly loadouts = new Map<
    EntityId, AllyEquipmentSnapshot | EnemyEquipmentSnapshot
  >();

  /** MatchStart（含重连）时清空 —— 见文件头 */
  reset(): void {
    this.statics.clear();
    this.loadouts.clear();
  }

  /** `EntityLoadouts` 消息的落点。每条覆盖该实体的当前装备视图 */
  setLoadouts(
    items: readonly {
      entityId: EntityId;
      equipment: AllyEquipmentSnapshot | EnemyEquipmentSnapshot;
    }[],
  ): void {
    for (const it of items) this.loadouts.set(it.entityId, it.equipment);
  }

  hydrate(entities: readonly EntitySnapshot[]): HydratedEntitySnapshot[] {
    const out: HydratedEntitySnapshot[] = [];
    for (const e of entities) {
      // 静态块：随包更新缓存（首见/重发都走这条），否则读缓存
      let st = this.statics.get(e.id);
      if (e.name !== undefined) {
        st = {
          name: e.name,
          team: e.team ?? st?.team ?? (0 as TeamId),
          classId: e.classId ?? st?.classId ?? ('' as ClassId),
          maxHealth: e.maxHealth ?? st?.maxHealth ?? 1,
          maxResources: e.maxResources ?? st?.maxResources ?? {},
        };
        this.statics.set(e.id, st);
      }
      if (!st) {
        /**
         * 缓存缺失又没随包携带 —— 服务器契约被破坏（首见必带静态块）。
         * 跳过这个实体并留痕，比造一个字段全空的实体污染下游更可诊断。
         */
        console.warn(`SnapshotHydrator：实体 ${e.id} 无静态块可用，本帧跳过`);
        continue;
      }

      const f = e.f ?? 0;
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
        ...(e.selfMovement ? { selfMovement: e.selfMovement } : {}),
        ...(e.cooldowns ? { cooldowns: e.cooldowns } : {}),
        ...(e.focusId !== undefined ? { focusId: e.focusId } : {}),
        ...(e.gcdUntil !== undefined ? { gcdUntil: e.gcdUntil } : {}),
        ...(() => {
          const eq = this.loadouts.get(e.id);
          return eq ? { equipment: eq } : {};
        })(),
      });
    }
    return out;
  }
}
