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
  isVisibleTo,
  listEntities,
  needsGroundPlacement,
  usesNoTarget,
  type BotDifficulty,
  type CombatEntity,
  type EntityId,
  type Match,
  type VisibilityContext,
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
  /**
   * ★ P2（技术债总账）：让 `broadcastSnapshots` 认得出人机会话并跳过
   *   快照的构建与序列化 —— 此前 send() 在这里丢弃字符串，但完整裁剪 +
   *   `JSON.stringify` 已经白付过了，满人机房开销 = 满人房。
   *   ⚠️ 跳的是**浪费**不是可见性语义（M16b 红线原样）：人机决策层读的
   *   是 world，从来不消费快照。
   */
  readonly isBot = true;
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
  /**
   * 难度档。不传 = normal。
   * ★ 掉线接管刻意用 normal 不用房间设置的档 —— 接管顶替的是一个真人，
   *   「普通操作水平」是对被顶替者最中性的假设；补位人机（P1c）才读房间配置。
   */
  difficulty?: BotDifficulty;
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

    for (const [playerId, seat] of this.seats) {
      const entityId = m.entityOf.get(playerId);
      if (entityId === undefined) continue;
      const self = m.world.entities.get(entityId);
      if (!self || !self.alive) continue;

      /**
       * ★ 把**当前硬目标**喂回去 —— 粘性判定要它。读 `self.targets.hard`
       *   而不是驱动器自己记一份：那是服务器 world 里真正生效的目标
       *   （`SetTarget` 可能被服务器拒掉，比如目标已经隐身），自记的
       *   影子状态会和它悄悄分叉。
       */
      const foe = pickFoe(m, self, seat.difficulty ?? 'normal', self.targets.hard);
      if (!foe) continue;

      const action = decideBotAction({
        world: m.world,
        casting: m.casting,
        self,
        foe,
        rng: this.rngs.get(playerId) ?? Math.random,
        difficulty: seat.difficulty ?? 'normal',
        // P1b 走位感知：脚下的敌方区域与待落的陨星（只读）
        ground: m.ground,
        projectiles: m.projectiles,
        // P3b：让它看得见对手身上已经在跳的 DoT，别每个 GCD 重挂（只读）
        auras: m.auras,
        // P4：控制递减仓（只读）—— 出控制前看递减层数，免疫不空放
        dr: m.dr,
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

      // P5：bot 会交战斗意志（被硬控且要命时）—— 走与真人相同的协议消息
      if (action.trinket) {
        this.feed(playerId, encodeClientMessage({ t: 'UseTrinket' }));
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
 * 最近的**可见**敌人。
 *
 * ★★ A4（技术债总账）：此前不过可见性 —— 人机能感知未被发现的潜行者的
 *   精确坐标并据此走位/选目标，「故意断线换 AI 代打」附带信息优势。
 *   现在按 `isVisibleTo`（与快照裁剪、SetTarget 校验**同一个**判定）过滤：
 *   人机看得见的 = 真人看得见的。全场只剩潜行者时人机会原地待机 ——
 *   那正是真人面对隐身对手的处境，不是「接管人机变瞎子」（可见的敌人
 *   照常感知；潜行者被发现的瞬间照常进入候选）。
 *
 * ⚠️ `decideBotAction` 本版**只支持单目标**。这里的「最近敌人」是调用方能
 *   给出的最合理的单目标，不是像样的选敌策略 —— 3v3 要用得先补决策层。
 *
 * ★ B1 起它不再是唯一的选目标逻辑：调用方走 `pickFoe`，本函数是 easy/normal
 *   的实现（hard 走血量优先的集火评分）。保留独立导出是因为它有自己的
 *   A4 回归测试，而且「最近敌人」是 hard 评分退化后的语义基准。
 */
export const nearestFoe = (m: Match, self: CombatEntity): CombatEntity | undefined => {
  const ctx = m.ctf ? { ctf: m.ctf.state } : undefined;
  let best: CombatEntity | undefined;
  let bestD = Infinity;
  for (const e of listEntities(m.world)) {
    if (!isFoeCandidate(e, self, ctx)) continue;
    const d = distance2D(self.position, e.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
};

/**
 * 「谁能当人机的目标」**唯一**的判据。
 *
 * ★★ 提成函数而不是让 `pickFoe` 照抄一份 `nearestFoe` 的条件 —— 抄的那份
 *   将来漏掉 `isVisibleTo` 就是 A4 红线（人机透视潜行者）无声复活，而且
 *   只在 hard 档复活、只在有潜行者的局里复活，测试之外根本发现不了。
 *   条件只有一处，两条选目标路径就不可能分叉。
 */
const isFoeCandidate = (
  e: CombatEntity,
  self: CombatEntity,
  ctx: VisibilityContext | undefined,
): boolean => {
  if (!e.alive || e.isPet || isFriendly(e, self)) return false;
  return isVisibleTo(e, self, ctx);
};

/**
 * 换目标的**迟滞阈值**（分数）。占位值 20。
 *
 * ★ 取值理由：评分里 1 分 ≈ 1% 血 ≈ 0.5 米。20 分 = 「新目标至少要比当前
 *   目标残 20% 血（或近 10 米）才值得转火」。转火不是免费的：要重新贴身、
 *   丢掉当前目标身上已经铺好的 DoT/减益、近战还要吃一段跑路时间 ——
 *   没有迟滞时两个血量相近的敌人会让整队每 tick 反复横跳，净收益为负。
 * ⚠️ 没有实测数据支撑这个数，配平实测（战斗时长 / 集火成功率）后再定。
 */
const SWITCH_HYSTERESIS = 20;

/**
 * 选目标。easy/normal = 最近敌人（原样）；hard = 按血量优先的集火评分。
 *
 * ★★ 集火是**涌现**的，不是调度出来的：全队 hard 人机各自跑同一个确定性
 *   评分函数、看同一份 world，于是自然会评出同一个残血目标 —— 不需要任何
 *   队内通信，也就不需要一条「AI 才有、真人没有」的信息通道。
 *
 * ★ 评分 = 血量百分比 * 100 + 平面距离 * 2，**取最小**。
 *   两项的量纲被有意拉到同一个数量级：50% 血 = 50 分 = 25 米。
 *   也就是「残血但在半场外」不如「满血但在脸上」—— 够不着的残血是幻觉。
 *   ⚠️ 系数 100 / 2 都是占位值（凭手感定的，未经配平实测）。
 *
 * ★ 候选集与 `nearestFoe` 共用 `isFoeCandidate` —— 尤其是 `isVisibleTo`：
 *   hard 档也**不许**看见未被发现的潜行者（A4 红线）。
 */
export const pickFoe = (
  m: Match,
  self: CombatEntity,
  difficulty: BotDifficulty,
  currentTargetId?: EntityId,
): CombatEntity | undefined => {
  // ★ 只有 hard 改行为：easy/normal 走原路径，既有回归网一寸不动
  if (difficulty !== 'hard') return nearestFoe(m, self);

  const ctx = m.ctf ? { ctf: m.ctf.state } : undefined;
  let best: CombatEntity | undefined;
  let bestScore = Infinity;
  let current: CombatEntity | undefined;
  let currentScore = Infinity;

  for (const e of listEntities(m.world)) {
    if (!isFoeCandidate(e, self, ctx)) continue;
    const score = foeScore(self, e);
    if (score < bestScore) { bestScore = score; best = e; }
    // ★ 当前目标的分数**在同一次遍历里**算 —— 它必须同样过候选集：
    //   目标死了/隐身了/被治满了都该正常脱粘，而不是粘在一个非法目标上
    if (e.id === currentTargetId) { current = e; currentScore = score; }
  }

  // 粘性：新目标没好出一个身位就不换（见 SWITCH_HYSTERESIS）
  if (current && bestScore >= currentScore - SWITCH_HYSTERESIS) return current;
  return best;
};

const foeScore = (self: CombatEntity, e: CombatEntity): number => {
  // ⚠️ maxHealth 兜底：真实体不会是 0，但除零会产出 NaN，而 NaN 参与比较
  //   永远为 false —— 那会让这个敌人**静默地**永远选不中，极难查
  const hpPct = e.maxHealth > 0 ? e.health / e.maxHealth : 0;
  return hpPct * 100 + distance2D(self.position, e.position) * 2;
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
