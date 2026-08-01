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
  /**
   * 比赛种子。**只用于派生各实体的随机流**，本身不变。
   *
   * ★★ **为什么必须种子化（而不是 `Math.random()`）：**
   *   `packages/shared` 在此之前一处 `Math.random()` 都没有，整个 sim
   *   在给定输入下完全确定。三样东西建立在这一点上：
   *     · docs/08 §5 的客户端预测**重放**
   *     · `scripts/balance-report.ts` 的**可复现**对局数据（M11 配平的判据）
   *     · 将来的回放/复盘
   *   闪避需要随机，但用 `Math.random()` 会一次性废掉这三样。
   *
   * ⚠️ **不进快照。** 它是服务器内部状态，发出去等于让人预测下一次闪避。
   */
  readonly seed: number;
}

export const createWorld = (obstacles: readonly Aabb[] = [], seed = 1): World => ({
  time: 0,
  entities: new Map(),
  obstacles,
  nextId: 1,
  seed: seed >>> 0,
});

export const allocEntityId = (w: World): EntityId => asEntityId(w.nextId++);

/**
 * 取一个 [0, 1) 的随机数，推进**该实体自己的**随机流（mulberry32）。
 *
 * ★★ **为什么是「按实体」而不是「按世界」一条全局流：**
 *
 *   全局单流的问题不是空间（那只是一个 32 位整数），是**顺序耦合**：
 *   每次掷骰都推进同一份共享状态，于是「谁先掷」决定了所有后续结果。
 *   后果很实际 ——
 *     · 给某个技能加一次新的随机判定，**整局比赛的走向都会变**
 *     · 调换两处结算顺序（哪怕是等价重构），回放和配平复现全部失效
 *     · 将来想并行处理不同实体也做不到
 *
 *   按实体分流之后，A 的掷骰不影响 B 的序列。代价是每个实体多存一个数字
 *   （12v12 共 24 个 = 192 字节），换来的是「加一处随机不会扰动别处」。
 *
 * ★ 每个实体的流在 `createEntity` 时由 `world.seed` + `id` 派生，
 *   所以整局仍然由**一个**种子完全决定。
 *
 * ⚠️ 只在**服务器权威结算**里调。客户端预测不碰随机判定
 *   （docs/08 §5：「技能效果一律等服务器确认」），两端不需要对齐序列。
 */
export const nextRandom = (e: { rng: number }): number => {
  e.rng = (e.rng + 0x6d2b79f5) >>> 0;
  let t = Math.imul(e.rng ^ (e.rng >>> 15), 1 | e.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 由比赛种子与实体 id 派生该实体的初始随机流。★ 纯函数，可复算 */
export const deriveRngSeed = (worldSeed: number, id: number): number => {
  let h = (worldSeed ^ Math.imul(id, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
};

export const addEntity = (w: World, e: CombatEntity): CombatEntity => {
  // ★ 随机流在入世界时才派生 —— createEntity 拿不到 world.seed
  e.rng = deriveRngSeed(w.seed, e.id as number);
  w.entities.set(e.id, e);
  return e;
};

export const getEntity = (w: World, id: EntityId | undefined): CombatEntity | undefined =>
  id === undefined ? undefined : w.entities.get(id);

export const listEntities = (w: World): CombatEntity[] => [...w.entities.values()];

/** 存活的玩家（不含宠物 —— 2.1：宠物、图腾、召唤物不计入存活人数）*/
export const livingPlayers = (w: World): CombatEntity[] =>
  listEntities(w).filter((e) => e.alive && !e.isPet);
