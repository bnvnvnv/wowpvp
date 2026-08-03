/**
 * 服务器侧人机：补位与掉线接管。docs/14 §16b，docs/10 已知偏差 #14。
 *
 * ★★ **红线是「人机走与真人**完全相同**的输入通道」，这里是字面兑现的。**
 *
 *   一个人机 = 一个**真的 `Session`** + 一个假 socket。它每 tick 发出的是
 *   真的 `Input` / `CastRequest` **JSON 字符串**，经过：
 *
 *       handleRaw → parseClientMessage（形状 + 范围校验）
 *                 → 阶段鉴权（战斗中才收 Input）
 *                 → 排队 → MatchLoop 按 tick 消费 → tickWorld
 *
 *   也就是说人机**不可能**发出 `FORBIDDEN_CLIENT_FIELDS` 里的任何字段 ——
 *   不是因为我们记得别发，而是因为 codec 会把它拒掉。docs/14 §16b 的判据
 *   「人机不发任何 FORBIDDEN_CLIENT_FIELDS（自动满足，因为走 codec）」
 *   只有走这条路才真的自动满足。
 *
 *   ⚠️ 更省事的写法是让人机直接往 `MatchLoop` 的 inputs Map 里塞 ——
 *   能work，但那等于开了第二条输入通道，回放与反作弊边界都从那里破掉。
 *   **多写一个假 socket，换掉一整类将来才会发现的问题。**
 *
 * ★ 决策层不在这里：`shared/src/ai/botController.ts` 的 `decideBotAction()`
 *   是全仓库唯一经过实证（168 场确定性对局）的 AI，试验场的实战模式用的
 *   也是它。本文件只负责**把它的产出翻成协议消息**。
 *   ★★ 那个模块连 world 的写权限都没拿到 —— 红线在那里是结构性成立的。
 */

import {
  decideBotAction,
  distance2D,
  encodeClientMessage,
  getSkill,
  isFriendly,
  listEntities,
  needsGroundPlacement,
  usesNoTarget,
  type CombatEntity,
  type Match,
} from '@wowpvp/shared';
import type { SessionSocket } from './room/Session.js';

/**
 * 人机的假 socket。
 *
 * ★ 发给人机的消息**全部丢弃** —— 它不需要看快照（它读的是服务器内存里的
 *   世界），也不需要看战斗事件。但**丢弃发生在 socket 层而不是更上层**：
 *   服务器照常给它建快照、照常裁剪、照常 `assertNoHiddenEntities` ——
 *   于是「人机能看到潜行者」这种事不会因为走了捷径而悄悄成立。
 *
 * ⚠️ 代价是 12v12 全人机时会白建一堆快照。真成为瓶颈时应该在
 *   `broadcastSnapshots` 里按 session 类型跳过，**而不是**让人机绕开裁剪。
 */
export class BotSocket implements SessionSocket {
  send(): void { /* 人机不看消息 */ }
  close(): void { this.isClosed = true; }
  private isClosed = false;
  get closed(): boolean { return this.isClosed; }
}

/** 一个被人机接管的席位 */
export interface BotSeat {
  playerId: string;
  /** 接管原因。★ 影响的是**交还**：掉线接管会在重连时交还，补位不会 */
  reason: 'fill' | 'disconnect';
}

/**
 * 每 tick 给所有人机产出一次意图。
 *
 * ★ 由 `MatchLoop` 的 pre-tick 钩子调用 —— 必须在 `collectInputs()` **之前**，
 *   否则这一 tick 的意图要等下一 tick 才被消费（人机会慢半拍且抖动）。
 */
export class BotDriver {
  /** playerId → 席位 */
  private readonly seats = new Map<string, BotSeat>();
  /**
   * 每个人机自己的随机流。
   * ★★ **不是全局单流**：`decideBotAction` 要一个 rng，而全局单流会让
   *   「谁先决策」决定所有后续结果 —— 加一个人机就会改变整局走向，
   *   回放与配平复现全部失效。与 sim 的按实体分流 PRNG 同一条理由。
   */
  private readonly rngs = new Map<string, () => number>();

  constructor(
    private readonly match: () => Match | undefined,
    /** 按 playerId 找那条（假）会话，用来投递消息 */
    private readonly feed: (playerId: string, raw: string) => void,
  ) {}

  add(seat: BotSeat): void {
    this.seats.set(seat.playerId, seat);
    if (!this.rngs.has(seat.playerId)) {
      this.rngs.set(seat.playerId, makeRng(hashString(seat.playerId)));
    }
  }

  remove(playerId: string): void {
    this.seats.delete(playerId);
    // ★ rng **不删**：同一个人（掉线 → 接管 → 重连 → 再掉线）应该拿回
    //   同一条流，否则同一场对局的回放会因为断线次数不同而分叉
  }

  has(playerId: string): boolean { return this.seats.has(playerId); }
  seatOf(playerId: string): BotSeat | undefined { return this.seats.get(playerId); }
  get size(): number { return this.seats.size; }

  /** 每 tick 调用一次。★ 它只发消息，不碰 world —— 红线在这里是结构性的 */
  tick(): void {
    const m = this.match();
    if (!m) return;

    for (const [playerId] of this.seats) {
      const entityId = m.entityOf.get(playerId);
      if (entityId === undefined) continue;
      const self = m.world.entities.get(entityId);
      if (!self || !self.alive) continue;

      const foe = nearestFoe(m, self);
      if (!foe) continue;

      const action = decideBotAction({
        world: m.world,
        casting: m.casting,
        self,
        foe,
        rng: this.rngs.get(playerId) ?? Math.random,
      });

      /**
       * ★ `dt` 用 `SIM.TICK_DT` 的名义值即可 —— 服务器**根本不读**客户端的 dt
       *   （`MatchLoop.collectInputs` 的 ★★：步长不来自客户端）。
       *   但它必须落在 `INPUT_LIMITS` 的合法区间里，否则 codec 会拒掉这条 ——
       *   人机会一动不动，而且不会有任何报错。
       */
      this.feed(playerId, encodeClientMessage({
        t: 'Input',
        seq: this.nextSeq(playerId),
        dt: 0.05,
        forward: action.move.forward,
        strafe: action.move.strafe,
        characterYaw: action.move.yaw,
        jump: action.move.jump,
      }));

      // 目标：让服务器知道它在打谁（7.6 普攻的开火判据是敌方硬目标，偏差 #9）
      if (self.targets.hard !== foe.id) {
        this.feed(playerId, encodeClientMessage({
          t: 'SetTarget', slot: 'hard', entityId: foe.id,
        }));
      }

      const cast = action.cast;
      if (!cast) continue;
      const skill = getSkill(cast.skillId);
      if (!skill) continue;
      /**
       * ★ 三类瞄准各按自己的方式表达 —— 与客户端 `sendCast()` 同构。
       *   ⚠️ 地面技能这里**直接不发**：`decideBotAction` 不产出落点
       *   （它的 `CastIntent` 没有 groundPoint），编一个落点等于让人机
       *   用一套真人没有的瞄准方式。如实少一类技能，不假装它会用。
       */
      if (needsGroundPlacement(skill)) continue;
      this.feed(playerId, encodeClientMessage(
        usesNoTarget(skill)
          ? { t: 'CastRequest', skillId: skill.id, facing: self.yaw }
          : { t: 'CastRequest', skillId: skill.id, targetId: foe.id },
      ));
    }
  }

  private readonly seqs = new Map<string, number>();
  private nextSeq(playerId: string): number {
    const next = (this.seqs.get(playerId) ?? 0) + 1;
    this.seqs.set(playerId, next);
    return next;
  }
}

/**
 * 最近的活着的敌人。
 *
 * ⚠️ `decideBotAction` 本版**只支持单目标**（它自己的注释写着：选敌 / 换目标 /
 *   保队友都还没做）。这里的「最近敌人」是调用方能给出的最合理的单目标，
 *   **不是**一个像样的选敌策略 —— 3v3 以上要用得先补决策层那一块。
 */
const nearestFoe = (m: Match, self: CombatEntity): CombatEntity | undefined => {
  let best: CombatEntity | undefined;
  let bestD = Infinity;
  for (const e of listEntities(m.world)) {
    if (!e.alive || e.isPet || isFriendly(e, self)) continue;
    const d = distance2D(self.position, e.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
};

/** 确定性 PRNG（mulberry32）。★ 与 sim 的按实体分流同一个理由，见 rngs 的注释 */
const makeRng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const hashString = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
