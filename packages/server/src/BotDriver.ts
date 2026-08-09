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
 *   也是它。本文件负责**把它的产出翻成协议消息**，外加一件决策层做不到的事：
 *   **队伍层协同**。
 *
 * ★★ 为什么协同必须在这里而不在决策层：`decideBotAction` 是按人调用的纯函数，
 *   它看不见「谁和我是一队的人机」（world 里的队友既有真人也有人机，
 *   而人机名册只有本驱动器知道）。所以 B1 的分工是 ——
 *     · 这里：按队算一次**集火呼叫**（`callFocusTarget`）+ 收一份**队友名册**
 *     · 决策层：拿呼叫当选目标的偏置、拿名册去奶血最少的队友
 *   ⚠️ 协同**没有**给人机开任何新通道：呼叫只能给「本来就在我候选集里」的
 *   目标减分（A4 不透视），治疗仍然走 `validateCast`（P3 的 HPS 恒 0 教训）。
 */

import {
  createThreatStore,
  decayThreat,
  decideBotAction,
  distance2D,
  encodeClientMessage,
  getSkill,
  isFriendly,
  isVisibleTo,
  listEntities,
  needsGroundPlacement,
  pickByThreat,
  recordThreat,
  threatScoreBonus,
  usesNoTarget,
  SIM,
  type BotDifficulty,
  type CombatEntity,
  type CombatEvent,
  type EntityId,
  type Match,
  type TeamId,
  type ThreatStore,
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

  /**
   * 每队上一 tick 的集火呼叫。
   * ★ 驱动器的**局部**记忆，不是 world 的影子状态 —— `callFocusTarget` 每 tick
   *   都会重新拿它过一遍候选集，死了/隐身了当场失效（见该函数注释）。
   *   之所以敢记（对比 `self.targets.hard` 那条「不自记」的纪律）：world 里
   *   压根没有「队伍集火目标」这个字段，没有可分叉的第二份事实。
   */
  private readonly lastCalls = new Map<TeamId, EntityId>();

  /**
   * 仇恨表（X10 用户拍板）。与 `lastCalls` 同一条纪律：驱动器局部记忆，
   * world 里没有第二份事实；表里的 id 每次用都重新过 `isFoeCandidate`。
   * 数据从 `observe()` 喂进来（MatchLoop 每 tick 的事件流，与统计同源）。
   */
  private readonly threat: ThreatStore = createThreatStore();

  /**
   * 每 tick 由 MatchLoop（经 RoomServer 的 onPostTick）喂入本 tick 的事件流。
   * ★ 只读折叠 —— 不碰 world；顺带做半衰（调用节奏 = tick 节奏，dt 恒定）。
   */
  observe(events: readonly CombatEvent[]): void {
    decayThreat(this.threat, SIM.TICK_DT);
    recordThreat(this.threat, events);
  }

  /** 每 tick 调用一次。★ 它只发消息，不碰 world —— 红线在这里是结构性的 */
  tick(): void {
    const m = this.match();
    if (!m) return;

    /**
     * ★★ 队伍层的两样东西**每 tick 只算一次**，而不是每个人机各算一遍：
     *   · 集火呼叫（`calls`）—— 算法上就得是「一队一个」，人手一份就没有配合
     *   · 队友名册（`roster`）—— 喂给决策层的治疗步骤（奶血最少的队友）
     *   ⚠️ 都是只读遍历，不碰 world。12v12 满员时这是每 tick 两趟实体遍历，
     *      比「每个人机各遍历一趟」还省。
     */
    const calls = this.focusCalls(m);
    const roster = teamRoster(m);

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
       * ★ B1：多喂一个**本队集火呼叫**。它只是偏置 —— 候选集与可见性
       *   仍然由 `pickFoe` 里的 `isFoeCandidate` 说了算（A4 红线）。
       */
      const foe = pickFoe(
        m, self, seat.difficulty ?? 'normal', self.targets.hard, calls.get(self.team),
        this.threat,
      );
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
        // B1：队友名册（只读）—— 治疗职业改奶血最少的那个人，不再只奶自己
        allies: roster.get(self.team),
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
      /**
       * ⚠️⚠️ **目标取 `cast.targetId`，不是 `foe.id`。**
       *
       *   这里原本硬写着 `targetId: foe.id` —— 决策层辛辛苦苦挑好的目标
       *   在最后一行被丢掉了。后果**只在服务器上、只对队向技能成立**，
       *   所以两年都没人发现：
       *     · 自身增益（保命键、加速）是 `Targeting.Self` → 走上面那条
       *       `usesNoTarget` 分支，**没受影响**，看着一切正常
       *     · 而单体治疗、护心屏障、痛苦压制、净化术这类
       *       `Targeting.Direct` + `TargetFilter.Ally` 的技能，被当成
       *       「对敌人施放」发出去 → `validateCast` 判 `InvalidTarget` →
       *       **静默失败**（人机的失败提示是丢掉的，见 `BotSocket`）
       *   也就是说：**联网对局里的人机治疗职业从来没有奶中过一次**，
       *   HPS 恒 0 —— 与 P3 那次「拿 foe 去验治疗」是同一个病的第二次发作，
       *   只是这回病灶在协议翻译层而不是决策层。B1 的队友治疗如果不连它一起
       *   修，新写的整条协作链在真实对局里同样一发都落不下去。
       *
       * ★ `?? foe.id` 只是兜底：`decideBotAction` 每一条出招路径都带 targetId，
       *   但 `CastIntent.targetId` 是可选字段，不在类型上装作它一定有。
       */
      this.feed(playerId, encodeClientMessage(
        usesNoTarget(skill)
          ? { t: 'CastRequest', skillId: skill.id, facing: self.yaw }
          : { t: 'CastRequest', skillId: skill.id, targetId: cast.targetId ?? foe.id },
      ));
    }
  }

  /**
   * 按队算出这一 tick 的集火呼叫。
   *
   * ★ **谁参与**：本驱动器管着的、活着的、**非 easy** 的人机。
   *   · easy 不参与 —— 与它不打断/不躲圈同一条难度门（木桩不喊集火）
   *   · 真人队友不参与 —— 人机没有「读队友心思」的通道，真人的目标是他自己
   *     的事；把真人的硬目标当呼叫等于给人机开一条真人没有的信息通道
   * ★ 呼叫按**实体所在队伍**分组，不是按房间席位 —— 队伍才是集火的单位。
   */
  private focusCalls(m: Match): Map<TeamId, EntityId> {
    const byTeam = new Map<TeamId, CombatEntity[]>();
    for (const [playerId, seat] of this.seats) {
      if ((seat.difficulty ?? 'normal') === 'easy') continue;
      const entityId = m.entityOf.get(playerId);
      if (entityId === undefined) continue;
      const e = m.world.entities.get(entityId);
      if (!e || !e.alive) continue;
      const list = byTeam.get(e.team);
      if (list) list.push(e); else byTeam.set(e.team, [e]);
    }

    const out = new Map<TeamId, EntityId>();
    for (const [team, bots] of byTeam) {
      const call = callFocusTarget(m, bots, this.lastCalls.get(team));
      // ★ 一个候选都没有（全场只剩潜行者 / 敌人全死）→ 连记忆一起清掉，
      //   免得下一波复活时拿一个陈旧的 id 当「上一次呼叫」去续粘性
      if (call) { out.set(team, call.id); this.lastCalls.set(team, call.id); }
      else this.lastCalls.delete(team);
    }
    return out;
  }

  private readonly seqs = new Map<string, number>();
  private nextSeq(playerId: string): number {
    const next = (this.seqs.get(playerId) ?? 0) + 1;
    this.seqs.set(playerId, next);
    return next;
  }
}

/**
 * 按队分组的**活人名册**（含真人队友，排除宠物与尸体）。喂给决策层的治疗步骤。
 *
 * ★ 真人队友**要**进来 —— 人机奶真人正是「团队配合」里玩家最想看到的一幕，
 *   而且它没有信息优势问题：队友的位置与血量对同队一切人本来就可见
 *   （`isVisibleTo` 对队友恒为真，docs/08 §4.1），真队伍框里也是这么显示的。
 * ★ 尸体排除掉是省一次 `validateCast`：死人本来就验不过（`isSelectableBy`）。
 */
const teamRoster = (m: Match): Map<TeamId, CombatEntity[]> => {
  const out = new Map<TeamId, CombatEntity[]>();
  for (const e of listEntities(m.world)) {
    if (!e.alive || e.isPet) continue;
    const list = out.get(e.team);
    if (list) list.push(e); else out.set(e.team, [e]);
  }
  return out;
};

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
 * 集火呼叫的**分数减免**。占位值 25。
 *
 * ★★ 取值理由只有一条，但它是硬的：**必须严格大于 `SWITCH_HYSTERESIS`(20)。**
 *   不然呼叫在「两个敌人分数相当」时永远推不动粘性 —— 而那恰恰是集火唯一
 *   有用的场合（分差本来就大的时候，不用呼叫大家也会评到同一个人）。
 *   25 > 20 意味着「队友喊的目标」自带约 25% 血的优势：足以打破平手，
 *   又不足以把人从一个快死的目标身上拽走（呼叫差 30 分以上就拽不动了）。
 * ⚠️ 与 SWITCH_HYSTERESIS 一样没有配平实测支撑，配平后再定。
 */
const FOCUS_CALL_BONUS = 25;

/**
 * 选目标。easy = 最近敌人（原样）；normal = 最近敌人 + 跟队伍集火呼叫；
 * hard = 血量优先的集火评分 + 呼叫加成 + 粘性。
 *
 * ★★ B1 之前这里写着「集火是**涌现**的，不是调度出来的」—— 那句话对了一半。
 *   同一个确定性评分确实让全队评出同一个人，**但每个人是按自己的位置评的**：
 *   `foeScore` 里的距离项以 self 为原点，于是场地两头的两个队友算出来的
 *   最优解常常是两个不同的人。用户反馈的「BOT 都是单独行动」就是这一幕。
 *   B1 补的正是缺的那一半：调用方**按队算一次**呼叫（`callFocusTarget`），
 *   个体拿它当**偏置**而不是命令。
 *
 * ★★ 红线：呼叫**不能**扩大任何人的候选集。它只是给「本来就在我候选集里」
 *   的那个 id 减分 —— 队友喊了一个我看不见的潜行者，对我而言等于没喊
 *   （A4：人机不透视，`isFoeCandidate` 一寸不动）。
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
  /** 本队这一 tick 的集火呼叫（`callFocusTarget` 的产出）。不传 = 没有呼叫 */
  focusCallId?: EntityId,
  /**
   * 仇恨表（X10 用户拍板「谁的仇恨值高就打谁」）。不传 = 没有仇恨这回事，
   * 三档全走老路径 —— balance harness（1v1、不建表）因此逐位不变。
   */
  threat?: ThreatStore,
): CombatEntity | undefined => {
  /**
   * ★ easy 不参与协作、也**不记仇** —— 与它不打断/不躲圈/不开保命同一条
   *   难度门：木桩手感卖的就是「他不会配合」。
   * ★ normal 的选敌阶梯：**仇恨最高者 > 集火呼叫 > 最近敌人**。
   *   「谁打我打谁」是人最直觉的行为，放 normal 正合适；仇恨自带
   *   SWITCH_RATIO 迟滞（pickByThreat），normal 从此有了个体防抖。
   *   开局没挨过打（表空）时逐位走老路径 —— 既有回归网一寸不动。
   * ★ hard 不走仇恨短路 —— 它有评分体系，仇恨折成分数进评分（见下）：
   *   集火纪律（呼叫）与「切残血」的判断不该被个人恩怨整个顶掉。
   */
  if (difficulty !== 'hard') {
    const ctx0 = m.ctf ? { ctf: m.ctf.state } : undefined;
    if (difficulty === 'normal' && threat) {
      const picked = pickByThreat(threat, self.id, currentTargetId, (id) => {
        const e = m.world.entities.get(id);
        // A4 红线：仇恨不扩大候选集 —— 隐身的仇人对我等于不存在
        return e !== undefined && isFoeCandidate(e, self, ctx0);
      });
      if (picked !== undefined) return m.world.entities.get(picked);
    }
    if (difficulty === 'easy' || focusCallId === undefined) return nearestFoe(m, self);
    for (const e of listEntities(m.world)) {
      if (e.id === focusCallId && isFoeCandidate(e, self, ctx0)) return e;
    }
    return nearestFoe(m, self);
  }

  const ctx = m.ctf ? { ctf: m.ctf.state } : undefined;
  let best: CombatEntity | undefined;
  let bestScore = Infinity;
  let current: CombatEntity | undefined;
  let currentScore = Infinity;

  for (const e of listEntities(m.world)) {
    if (!isFoeCandidate(e, self, ctx)) continue;
    // ★ 呼叫与仇恨都只在这一行生效：减分，不是短路 —— 候选集与可见性没被碰过。
    //   仇恨折分有界（THREAT.SCORE_CAP=30）：打了我 600 血的人自带 ≈30% 血的
    //   优先度，压得过粘性(20)、压不过一个真正残血的目标
    const score = foeScore(self, e)
      - (e.id === focusCallId ? FOCUS_CALL_BONUS : 0)
      - (threat ? threatScoreBonus(threat, self.id, e.id) : 0);
    if (score < bestScore) { bestScore = score; best = e; }
    // ★ 当前目标的分数**在同一次遍历里**算 —— 它必须同样过候选集：
    //   目标死了/隐身了/被治满了都该正常脱粘，而不是粘在一个非法目标上
    //   ★ 减免同样适用于它：我已经在打被呼叫的那个人时，粘性只会更牢
    if (e.id === currentTargetId) { current = e; currentScore = score; }
  }

  // 粘性：新目标没好出一个身位就不换（见 SWITCH_HYSTERESIS）
  if (current && bestScore >= currentScore - SWITCH_HYSTERESIS) return current;
  return best;
};

/**
 * ★★ **集火呼叫：一队人机每 tick 商定的那一个目标。**
 *
 *   规则一句话：**全队（参与协作的）人机各自的候选集并起来，取 `foeScore`
 *   最优的那一个。** 于是呼叫天然满足两件事 ——
 *   · 它一定是**至少一个队友看得见**的敌人（候选集是逐人过 `isFoeCandidate`
 *     算出来的，A4 红线在这里也是结构性成立的：这个函数根本没有别的入口
 *     能碰到实体）
 *   · 它是全队视角下「最该死的那个」，而不是某一个人视角下的
 *
 *   ⚠️ **它不是命令。** 个体照样跑自己的 `pickFoe`：呼叫在我的候选集里才有
 *   分量，不在（比如队友看见的潜行者对我仍然隐身）就当没喊过。
 *   这条区分是「人机不透视」与「人机会配合」能同时成立的全部原因。
 *
 * ★ **粘性用的是同一个 `SWITCH_HYSTERESIS`**，只是抬到了队伍层：上一次的
 *   呼叫只要还在候选集里、且新的最优没好出 20 分，就继续喊它。
 *   ⚠️ 没有这一层，两个分数接近的敌人会让**整队**每 tick 一起横跳 ——
 *   个体粘性拦不住它（个体粘性只在 hard 有，而且此时呼叫每 tick 都在换边）。
 *
 * ★ `previousCallId` 由调用方（`BotDriver`）按队记着。它是驱动器的**局部**
 *   记忆，不是 world 的影子状态：每 tick 都要重新过一遍候选集才算数，
 *   死了/隐身了/换队了都会当场失效 —— 不存在「粘在一个非法目标上」。
 *
 * @param bots 同一队里**参与协作**的人机（easy 已由调用方剔除）
 */
export const callFocusTarget = (
  m: Match,
  bots: readonly CombatEntity[],
  previousCallId?: EntityId,
): CombatEntity | undefined => {
  const ctx = m.ctf ? { ctf: m.ctf.state } : undefined;
  let best: CombatEntity | undefined;
  let bestScore = Infinity;
  let prev: CombatEntity | undefined;
  let prevScore = Infinity;

  for (const self of bots) {
    if (!self.alive) continue;
    for (const e of listEntities(m.world)) {
      if (!isFoeCandidate(e, self, ctx)) continue;
      const score = foeScore(self, e);
      if (score < bestScore) { bestScore = score; best = e; }
      /**
       * ★ 老呼叫取**全队最好的那个视角**的分（同一个人，站得近的队友算出来
       *   的分更低）—— 与 best 用同一把尺子，两边才可比。
       */
      if (e.id === previousCallId && score < prevScore) { prevScore = score; prev = e; }
    }
  }

  if (prev && bestScore >= prevScore - SWITCH_HYSTERESIS) return prev;
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
