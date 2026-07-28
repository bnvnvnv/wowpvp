/**
 * 世界状态容器。
 *
 * 刻意做得很薄：它只负责「存实体 + 查实体 + 推进时间」，
 * 所有战斗规则都在各自的模块里（targeting / casting / interrupt / ...），
 * 这样加系统时不需要动这个文件。
 */

import type { Aabb } from '../math/geometry.js';
import { asEntityId, type EntityId } from '../types/ids.js';
import type { CombatEntity } from './entity.js';

export interface World {
  /** 当前模拟时间，秒。所有冷却/锁定都存绝对时间，与它比较 */
  time: number;
  entities: Map<EntityId, CombatEntity>;
  /** 地图碰撞与视线几何 */
  obstacles: readonly Aabb[];
  /** 单调递增的实体 id 分配器 */
  nextId: number;
}

export const createWorld = (obstacles: readonly Aabb[] = []): World => ({
  time: 0,
  entities: new Map(),
  obstacles,
  nextId: 1,
});

export const allocEntityId = (w: World): EntityId => asEntityId(w.nextId++);

export const addEntity = (w: World, e: CombatEntity): CombatEntity => {
  w.entities.set(e.id, e);
  return e;
};

export const getEntity = (w: World, id: EntityId | undefined): CombatEntity | undefined =>
  id === undefined ? undefined : w.entities.get(id);

export const listEntities = (w: World): CombatEntity[] => [...w.entities.values()];

/** 存活的玩家（不含宠物 —— 2.1：宠物、图腾、召唤物不计入存活人数）*/
export const livingPlayers = (w: World): CombatEntity[] =>
  listEntities(w).filter((e) => e.alive && !e.isPet);
