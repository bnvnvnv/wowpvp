/**
 * 20Hz 权威定步长循环。docs/08 §1。
 *
 * ★★ **两处路线图点名容易写错的地方，都在本文件里：**
 *
 *   1. **用累加器补帧，不用 `setInterval` 直接跑。**
 *      `setInterval(fn, 50)` 的实际间隔受事件循环抖动影响，可能是 48ms 也可能
 *      是 63ms。如果每次回调就推进一个 `TICK_DT`，模拟时间就会**相对真实时间
 *      漂移** —— 而 8.2 的递减窗口、12.6 的复活波次、2.1 的回合时长
 *      全都是**绝对时间**。漂移的表现是「同样的比赛，在负载高的机器上更长」。
 *      所以这里按真实经过时间累加，够一个 `TICK_DT` 才推进一步。
 *
 *   2. **每个客户端单独建快照。** 12v12 是 24 份，不要为了省一次遍历
 *      先建一份全量再裁 —— `visibility.ts` 刻意没有提供那个入口，
 *      理由写在那个文件头部：「全量快照一旦存在，就迟早会有人为了省一次遍历
 *      而把它直接广播出去」。
 *
 * ★ 时钟用 `world.time`（模拟时间），不用 `Date.now()`。
 *   重连宽限、光环到期、复活波次全都读同一个钟，测试里也就能靠推进 tick
 *   而不是靠真的等 90 秒来验超时。
 */

import {
  BOSS_CLASS_ID,
  HIDDEN_AURA_ID,
  INTERACT_RANGE,
  SIM,
  SwapKind,
  asSkillId,
  encodeServerMessage,
  assertNoHiddenEntities,
  beginFlagInteract,
  beginPickup,
  beginSwap,
  beginSwing,
  buildSnapshot,
  buildSelfState,
  buyFfaOffer,
  cancelCast,
  cancelFlagInteract,
  chooseFromArmory,
  ffaShopFor,
  distance2D,
  equipmentViewFor,
  isLegalFollow,
  isLegalSpectateFollow,
  spectatableForSpectator,
  respecCombatant,
  staticsOf,
  getClass,
  getEntity,
  isVisibleTo,
  isVisibleToAudience,
  listEntities,
  NO_ENTITY,
  SPECTATOR,
  openArmory,
  pickAwards,
  setHardTarget,
  settleFfaKill,
  statsRows,
  stopSwing,
  swingIntervalOf,
  tabTarget,
  tickDepsOf,
  tickWorld,
  toggleFocus,
  withinSelectRange,
  type ArsenalChoice,
  type CastIntent,
  type ClassId,
  type CombatEntity,
  type CombatEvent,
  type EffectDef,
  type EntityId,
  type InteractTarget,
  type Match,
  type Snapshot,
  type SnapshotAudience,
  type MovementInput,
  type ServerMessage,
  type TeamId,
  type TickResult,
} from '@wowpvp/shared';

/**
 * 战斗期的非施法指令。
 *
 * ★ 与 `ClientMessage` **刻意不同构**：协议是「客户端说了什么」，
 *   这里是「服务器要做什么」。中间隔着一层校验（可见性、槽位存在与否），
 *   所以 `SwapWeapon{slot}` 到这里已经变成了「换哪一件」的意图，
 *   而不可见目标的 `SetTarget` 根本走不到这里。
 */
export type MatchCommand =
  | { t: 'SetTarget'; slot: 'hard' | 'focus'; entityId: EntityId | null }
  | { t: 'TabTarget'; reverse: boolean }
  | { t: 'CancelCast' }
  | { t: 'Swap'; kind: SwapKind; slot: number }
  | { t: 'InteractStart'; target: InteractTarget }
  | { t: 'InteractCancel' }
  | { t: 'OpenArmory'; armoryId: number }
  | { t: 'ChooseArsenal'; armoryId: number; choice: ArsenalChoice }
  /** P13 大乱斗积分商店的兑换。★ 与开箱/领取同规矩：排队，不是收到就改世界 */
  | { t: 'FfaBuy'; offerId: string };

import { takeExpired, type ReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';
import { LIMITS } from './limits.js';
import { log } from './log.js';
import {
  TURN_BURST_SERVER_RAD, admitYaw, clampYaw, createTurnBudget, refillTurnBudget,
  type TurnBudget,
} from './turnRate.js';

/**
 * 一次 `pump()` 最多补几个 tick。
 *
 * ★ 防「死亡螺旋」：如果某一帧卡了 2 秒，不补帧就会漂移，补 40 个 tick 又会
 *   让这一帧更卡，于是下一帧要补更多 —— 最终服务器再也追不上。
 *   超出的部分**丢弃**（模拟时间就此落后于真实时间），这是定步长循环的
 *   标准取舍：宁可慢，不可雪崩。
 */
const MAX_CATCHUP_TICKS = 5;

/**
 * P11 波2：每几个 tick 发一份快照。必须整除（20/10=2）——
 * 不整除的配置在这里立刻炸，而不是让快照节奏悄悄抖动。
 */
const SNAPSHOT_DIVISOR = SIM.TICK_RATE / SIM.SNAPSHOT_RATE;
if (!Number.isInteger(SNAPSHOT_DIVISOR)) {
  throw new Error(`SNAPSHOT_RATE(${SIM.SNAPSHOT_RATE}) 必须整除 TICK_RATE(${SIM.TICK_RATE})`);
}

export interface MatchLoopDeps {
  /** 当前**连着**的会话。断线的人不在这里，但他的实体还在世界里（11.5）*/
  sessions: () => Iterable<Session>;
  reconnects: ReconnectRegistry;
  /** 所属房间 id，只进日志（S5/S6）—— 循环本身不需要知道自己在哪个房间 */
  roomId?: string;
  /**
   * 淘汰一个玩家。
   * ★ 后果留在调用方 —— `takeExpired()` 只给名单，这是 M9 刻意留的设计
   *   （reconnect.ts 的 ★：「把后果留在调用点上，它就没法被一个
   *   『再宽限一下』的分支悄悄绕过」）。
   */
  onEliminate: (playerId: string, reason: 'timeout' | 'left') => void;
  onEnd: (winner: TeamId | 'draw') => void;
  /**
   * 每 tick 开始前的钩子。人机（`BotDriver`）在这里产出这一 tick 的意图。
   *
   * ★★ **必须在 `collectInputs()` 之前**：人机发的是真的 `Input` 消息，
   *   要进入本 tick 的队列就得赶在消费之前。放到 tick 之后的话，
   *   每条意图都要等下一 tick 才生效 —— 人机会慢半拍，而且是抖动的半拍。
   * ★ 它**只允许发消息**，不该碰 world。红线（人机走与真人相同的通道）
   *   靠 `BotDriver` 那一侧的结构保证，见那个文件的文件头。
   */
  onPreTick?: () => void;
  /**
   * 每 tick 结束后把本 tick 的事件流递出去。BotDriver 的仇恨表靠它记账 ——
   * 与战后统计同一种消费方式（事件流的只读折叠），不碰 world。
   */
  onPostTick?: (events: readonly CombatEvent[]) => void;
  /**
   * 一只大 BOSS 进场了 / 离场了。
   *
   * ★★ **循环自己不会让 BOSS 动起来。** 它的行为与人机走同一条路：
   *   一个 `BotSocket` 席位 + 一条真会话（见 `BotDriver` 的文件头）。
   *   而「建会话」是 `RoomServer` 的职责（它才持有 sessions / botSessions），
   *   所以这里只报告事实，后果留在调用点 —— 与 `onEliminate` 同一个手法。
   * ⚠️ 不接这两个钩子的调用方（测试夹具）会得到一只**站着不动的**BOSS：
   *   规则、掉落、赏金全都照常，只是它不出手。这是有意的 —— 白盒测试
   *   要的正是一个不会自己乱跑的靶子。
   */
  onBossSpawned?: (entityId: EntityId) => void;
  onBossDespawned?: (entityId: EntityId) => void;
  /**
   * W24：某个席位的职业**真的换过来了**（中途加入者顶替人机时选的那个，
   * 在他下一次复活/回合重置那一刻生效 —— 见 `applyPendingRespecs`）。
   *
   * ★ 与 `onEliminate` / `onBossSpawned` 同一个手法：循环只报告事实，
   *   后果（改房间名单里的 classId、广播一条 RoomState）留在持有房间的
   *   调用点上 —— MatchLoop 手里没有 Room，也就编不出「顺手改一下名单」。
   */
  onClassChanged?: (playerId: string, classId: ClassId) => void;
}

export class MatchLoop {
  private timer?: ReturnType<typeof setInterval>;
  private accumulator = 0;
  private lastRealMs = 0;
  private ended = false;
  tick = 0;

  /**
   * S6 可观测：tick 计数与耗时。此前**追帧丢弃是静默的** ——
   * 服务器已经在丢模拟时间（比赛悄悄变慢）而没有任何一行输出。
   * `/healthz` 聚合它，压测判据（他房 tick 节奏不受影响）直接读它。
   */
  readonly stats = {
    ticks: 0,
    /** 单 tick 实际耗时超过 TICK_DT 的次数（追不上节奏的先兆） */
    slowTicks: 0,
    /** 有史以来最慢的一个 tick，毫秒 */
    maxTickMs: 0,
    /** 因超过 MAX_CATCHUP_TICKS 被丢弃的模拟时间，折算成 tick 数 */
    droppedTicks: 0,
    /** S1 第二道防线丢弃的战斗指令数 */
    droppedCommands: 0,
  };
  /** 过载日志节流：droppedTicks 的告警最多每 5 秒一条，防止过载时日志自己成为负载 */
  private lastOverloadLogMs = 0;

  /** 本 tick 收到的技能请求。每 tick 消费后清空 */
  private readonly pendingCasts = new Map<EntityId, CastIntent>();

  /**
   * A5：每个席位的**转身账本**（上次被采信的朝向 + 桶里还剩多少令牌）。
   * 规则与取值理由全在 `shared/net/turnBudget.ts`，接线理由在 `turnRate.ts`。
   *
   * ★★ **它记的是「客户端上次说了什么」，不是 `entity.yaw`。** 两者会分开，
   *   而分开的时候按前者才对：死亡之握把人拽过来、影袭把人挪到背后
   *   （`effects/displacement.ts` 会直接写 `source.yaw`）、化形游走替他走路 ——
   *   这些都是 **sim 自己**在改朝向，不是客户端的主张。拿 `entity.yaw` 当基准
   *   的话，玩家下一 tick 的正常输入会被判成「转太快」，于是他要花 250ms
   *   转回自己本来就朝着的方向 —— 白白为服务器自己的位移道歉。
   *
   * ★ 账本里的 `yaw` 为 `undefined` = 还没采信过任何朝向（开局第一条 /
   *   中途加入 / 重连后的第一条 / 人机把席位交还给真人），此时**原样采信**。
   * ★ 不需要清理：键是 `EntityId`，一局之内单调分配且上限就是花名册人数，
   *   而这张表随 `MatchLoop` 一起随比赛结束被丢掉。
   */
  private readonly turnBudgets = new Map<EntityId, TurnBudget>();

  /** 取（或开）一个席位的转身账本。★ 服务器口径的桶容量，见 `turnRate.ts` 的 ★★ */
  private budgetOf(entityId: EntityId): TurnBudget {
    let b = this.turnBudgets.get(entityId);
    if (b === undefined) {
      b = createTurnBudget(TURN_BURST_SERVER_RAD);
      this.turnBudgets.set(entityId, b);
    }
    return b;
  }
  /** S1：每玩家本 tick 已入队的指令数（enqueue 的上限判据），applyCommands 清零 */
  private readonly pendingCommandCounts = new Map<string, number>();

  /**
   * 本 tick 收到的其他战斗指令（选目标、换装、交互…）。
   *
   * ★★ **和技能请求一样排队，不是收到就立刻改世界。**
   *   这些指令确实不结算效果（所以不像 A2 那样有「两个完成出口」的风险），
   *   立刻执行也能跑。但排队有两个实打实的好处：
   *
   *   · **确定性** —— 一个 tick 的结果只取决于「上一 tick 的世界 + 本 tick 的
   *     指令集」，不取决于网络包在两个 tick 之间的到达时刻。回放和复现都靠这个。
   *   · **一致的语义** —— 施法是「意图 → 下一 tick 生效」，选目标却是「立刻生效」
   *     的话，客户端预测要为两类操作写两套时序假设，而 A5 要复现的正是这套时序。
   *
   *   代价同样是延后一帧（~16–50ms），与施法一致。
   */
  private pendingCommands: { playerId: string; cmd: MatchCommand }[] = [];
  /** 本 tick 的消耗品使用请求（10.1）。与技能请求同样由 tickWorld 结算 */
  private readonly pendingConsumables = new Map<EntityId, number>();
  /**
   * 本 tick 要弃权判死的实体（11.5）。RoomServer 的 eliminate() 排进来，
   * 死亡与清理由 tickWorld 第 0 步的死亡漏斗统一结算（技术债总账 A1）。
   */
  private readonly pendingForfeits = new Set<EntityId>();
  /** 本 tick 的战斗意志请求（8.3，W8）。与技能/消耗品同规矩：只排意图 */
  private readonly pendingTrinkets = new Set<EntityId>();
  /**
   * P13：本 tick 兑换出来的即时效果（「立即满血」）。
   * ★ 账已经在 `applyCommands` 里扣了（`buyFfaOffer`），但**效果**要等
   *   `tickWorld` 的 itemGrants 那一步 —— 结算只有那一个出口（A1/A2）。
   */
  private readonly pendingItemGrants = new Map<EntityId, readonly EffectDef[]>();
  /**
   * P13：余额变过、需要重发一份 `FfaShop` 的人。
   *
   * ★ 攒到 tick 末尾一起发，而不是在扣账/入账的那一行立刻发：一个 tick 里
   *   「杀了人 + 买了东西」会连发两条，后一条才是真账 —— 攒起来天然只发最终值。
   */
  private readonly shopDirty = new Set<EntityId>();

  /**
   * P11 快照瘦身的每会话记账：
   *   · `seen` —— 该会话见过哪些实体（静态块首见即发，见 SnapshotDeps.seen）
   *   · `equipFp` —— 每实体上次发出的装备视图指纹（变了才发 EntityLoadouts）
   *   · `hpFp` —— 每实体上次发出的生命上限（W26：熊形态会改它，见下）
   *
   * ★ 键是 **Session 对象身份**：重连建的是新 Session（RoomServer.connect），
   *   自动拿到空记账 → 静态块与装备全量重发，恰好配合客户端在 MatchStart
   *   分支清缓存（重连也走 MatchStart）。MatchLoop 又是每对局一个 ——
   *   「再来一局」的实体 id 复用也不会撞上旧记账。
   */
  private readonly snapAccounts = new WeakMap<
    Session,
    { seen: Set<EntityId>; equipFp: Map<EntityId, string>; staticsFp: Map<EntityId, string> }
  >();

  /**
   * W24：等着换职业的席位（中途加入顶替人机时选的那个）。
   *
   * ★★ **不是「收到就换」** —— 活着换职业等于满血 + 满资源 + 冷却清空 +
   *   光环全清，那是一个可以反复触发的免费复活（docs/08 §8.7 的拍板理由）。
   *   所以这里只登记意图，由 `applyPendingRespecs` 在**「死 → 活」的跳变**
   *   那一刻兑现：夺旗/大乱斗是复活波次，竞技场是回合重置，两条都是干净的换类点。
   * ★ `armed` = 「已经观察到他死了」。登记时若人已经躺着就直接 armed ——
   *   否则要等他再死一次，而他可能正好是那种一整局不死的人。
   */
  private readonly pendingRespec = new Map<EntityId, { classId: ClassId; armed: boolean }>();

  /**
   * P11 波2：自上一份快照以来瞬移过的实体（见 SnapshotDeps.teleportedSince）。
   * 每 tick 累积、随快照广播消费后清空 —— 快照 10Hz 后，落在非快照 tick 的
   * 闪现/击退/复活不能丢（13.4 / 验收 #47）。
   */
  private readonly teleportedSince = new Set<EntityId>();

  constructor(
    readonly match: Match,
    private readonly deps: MatchLoopDeps,
  ) {}

  // ── 驱动 ──────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.lastRealMs = Date.now();
    // ★ 采样频率高于 tick 频率：累加器决定何时推进，采样只决定「多快发现该推进了」
    this.timer = setInterval(() => this.pump(), (1000 / SIM.TICK_RATE) / 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 按真实经过时间补帧。见文件头第 1 条 */
  private pump(): void {
    if (this.ended) return;
    const now = Date.now();
    this.accumulator += (now - this.lastRealMs) / 1000;
    this.lastRealMs = now;

    const maxAccum = MAX_CATCHUP_TICKS * SIM.TICK_DT;
    if (this.accumulator > maxAccum) {
      // S6：追帧丢弃不再静默 —— 折算成 tick 数计入，并节流地喊一声
      this.stats.droppedTicks += Math.floor((this.accumulator - maxAccum) / SIM.TICK_DT);
      this.accumulator = maxAccum;
      if (now - this.lastOverloadLogMs > 5000) {
        this.lastOverloadLogMs = now;
        log('warn', 'ticks_dropped', {
          roomId: this.deps.roomId, totalDropped: this.stats.droppedTicks,
        });
      }
    }

    /**
     * S5：**爆炸半径 = 单房间。** 此前 tick 里任何一个异常都是未捕获异常，
     * 带走整个进程 —— 而 `assertNoHiddenEntities` **设计上就会抛**
     * （宁可断也不透视）。现在一个房间的 bug 只结束这一个房间：
     * 判平局收场（服务器故障，不该有人白赢白输），玩家回到房间页，
     * 其他房间照常 tick。
     * ★ `advance()` 刻意留在 catch 外面不包 —— 它是测试/验收的白盒入口，
     *   那边**要**异常冒出来才能定位；这里是生产入口，才需要收容。
     */
    try {
      while (this.accumulator >= SIM.TICK_DT && !this.ended) {
        this.accumulator -= SIM.TICK_DT;
        const t0 = performance.now();
        this.advance();
        const ms = performance.now() - t0;
        this.stats.ticks++;
        if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms;
        if (ms > SIM.TICK_DT * 1000) this.stats.slowTicks++;
      }
    } catch (err) {
      log('error', 'tick_error', {
        roomId: this.deps.roomId,
        tick: this.tick,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      this.ended = true;
      this.stop();
      try {
        this.deps.onEnd('draw');
      } catch (endErr) {
        // 收场自己也炸了：只能记下来。房间留在 started 态，等下一次全服重启
        log('error', 'tick_error_onend_failed', {
          roomId: this.deps.roomId,
          error: endErr instanceof Error ? (endErr.stack ?? endErr.message) : String(endErr),
        });
      }
    }
  }

  /** 推进恰好一个 tick。★ 测试直接调它，不必真的等墙上时间 */
  advance(): void {
    if (this.ended) return;
    this.tick++;
    const outbound: ServerMessage[] = [];

    /**
     * P13：开局第一 tick 把货架发给每个参战者（余额 0）。
     * ★ 挂在 tick 而不是 `beginMatch`：MatchLoop 是「一局一个」的对象，
     *   第一 tick 是它唯一不需要外部谁记得调用的开局钩子 ——
     *   而「商店只在开局发一次」这种事，靠调用方记得就迟早会漏
     *   （本仓库「规则写对了、没有人调用它」那一家的预防）。
     */
    if (this.tick === 1 && this.match.ffa) {
      for (const entityId of this.match.playerOf.keys()) this.shopDirty.add(entityId);
    }

    // ★ 人机在这里发出本 tick 的 Input/CastRequest（走完整协议栈，见 BotDriver）
    this.deps.onPreTick?.();
    this.applyCommands();
    this.syncSwings();
    const inputs = this.collectInputs();
    const result = tickWorld(
      {
        ...tickDepsOf(this.match, inputs, this.pendingCasts),
        consumableRequests: this.pendingConsumables,
        forfeits: this.pendingForfeits,
        trinketRequests: this.pendingTrinkets,
        itemGrants: this.pendingItemGrants,
      },
      SIM.TICK_DT,
      {
        cast: {
          onStarted: (c, st) => outbound.push({
            t: 'CastStarted',
            casterId: c.id,
            skillId: st.skillId,
            duration: st.endsAt - st.startedAt,
            interruptible: st.interruptible,
            school: st.school,
            castKind: st.kind,
          }),
          onInterrupted: (c, _st, source, schoolLock) => outbound.push({
            t: 'CastInterrupted',
            casterId: c.id,
            source,
            ...(schoolLock ? { schoolLock } : {}),
          }),
          /**
           * ★ 施法失败是**私信**，不是广播 —— 「你的法术被沉默了」只有你需要
           *   知道，广播出去等于告诉对手他的沉默生效了。
           */
          onFailed: (c, skill, reason) => {
            this.sessionOfEntity(c.id)?.send({ t: 'CastFailed', skillId: skill.id, reason });
          },
          /**
           * ★ X21：排队窗过期同样是**私信** —— 「你刚才那一下没赶上」只有
           *   按键的人需要知道。与 `CastFailed` 分开的理由见协议里那条消息
           *   的注释（迟到的 `onGlobalCooldown` 比沉默更误导）。
           * ★ 只有真人会进排队窗（合同 C5 的三道保险：协议无 `queue` 字段、
           *   服务器只给非 bot 会话补、balance-report 连 store 都不建），
           *   所以这条私信天然只发给真人 —— 人机的 BotSocket 收不到它。
           */
          onQueueExpired: (c, skill, info) => {
            this.sessionOfEntity(c.id)?.send({
              t: 'CastQueueExpired', skillId: skill.id, waited: info.waited,
            });
          },
        },
        /**
         * 14.1「释放」/ 14.2 弹体的驱动信号。★ `targets` 是结算前的目标集合
         * （与试验场 CombatDirector 的同名钩子一字不差的语义）——
         * 客户端的表现用弹体要知道「这一发飞向谁」。裁剪在 `redactFor()`。
         */
        onCastResolved: (caster, skill, targets) => outbound.push({
          t: 'CastResolved',
          casterId: caster.id,
          skillId: skill.id,
          targetIds: targets.map((t) => t.id),
        }),
        onEffects: (events) => {
          for (const ev of events) {
            this.pushEvent(outbound, ev);
            /**
             * P13 大乱斗击杀结算：积分/连杀记账在 sim（settleFfaKill），
             * 这里只把返回的事实翻成一条 FfaKill 播报（只带名字,零 id）。
             * 环境死/自杀返回 null —— 清连杀但没有可播的主语,不发。
             */
            if (ev.t === 'death' && this.match.ffa) {
              const fact = settleFfaKill(this.match.ffa, ev.killerId, ev.targetId);
              const killer = ev.killerId !== undefined
                ? this.match.world.entities.get(ev.killerId) : undefined;
              const victim = this.match.world.entities.get(ev.targetId);
              if (fact && killer && victim) {
                outbound.push({
                  t: 'FfaKill',
                  killerName: killer.name,
                  victimName: victim.name,
                  streak: fact.streak,
                  bounty: fact.bounty,
                  killerScore: fact.killerScore,
                });
                // 赏金入账了 —— 他的商店面板要看到新余额（tick 末尾统一重发）
                if (ev.killerId !== undefined) this.shopDirty.add(ev.killerId);
              }
            }
          }
        },
        /**
         * 10.5「多人同时拾取只允许第一个完成者成功；其他人收到**明确失败反馈**」。
         *
         * ★ 私信而不是广播：谁捡到了什么属于 10.6 里「敌人看不到备用装备」
         *   的同一类信息。★ 这个 sink 此前**没有任何服务器消费者** ——
         *   `tickPickups` 一直在产出中断/完成事件，全部落地即消失。
         */
        onPickup: (ev) => {
          this.sessionOfEntity(ev.entityId)?.send({
            t: 'PickupResult',
            dropId: ev.dropId,
            ok: ev.result === 'completed',
            ...(ev.result === 'completed' ? {} : { reason: pickupFailText(ev.result) }),
          });
        },
      },
    );
    this.pendingCasts.clear();
    this.pendingConsumables.clear();
    this.pendingForfeits.clear();
    this.pendingTrinkets.clear();
    this.pendingItemGrants.clear();

    // ★ AI 层的观察窗口（BotDriver 仇恨表）：事件流原样递出，只读折叠
    this.deps.onPostTick?.(result.events);

    /**
     * ★ W24：在 tickWorld **之后**兑现待换的职业 —— 复活（波次）与回合重置
     *   都发生在 tickWorld 里面，所以这一拍看到的 `alive` 已经是本 tick 的结论，
     *   换类与复活落在同一 tick，玩家不会先以旧职业站起来一帧。
     */
    this.applyPendingRespecs(result.events);

    for (const ev of result.flags) {
      const flag = this.match.ctf?.state.flags[ev.flagTeam as number];
      if (!flag) continue;
      outbound.push({
        t: 'FlagEvent',
        flagTeam: ev.flagTeam,
        state: flag.state,
        ...(flag.carrierId !== undefined ? { carrierId: flag.carrierId } : {}),
        ...(flag.position ? { position: flag.position } : {}),
      });
    }

    if (result.boss) this.applyBoss(result.boss, outbound);

    this.settleExpiredReconnects();
    this.dispatch(outbound);
    this.flushShop();

    /**
     * ★ P11 波2：快照按 `SIM.SNAPSHOT_RATE` 分频（20Hz tick / 10Hz 快照）。
     *   事件（上面的 dispatch）仍逐 tick 即时发 —— 打击反馈不吃这 50ms。
     *   瞬移是每 tick 的脉冲，非快照 tick 的要攒到下一份快照（13.4）。
     */
    for (const [id, ms] of this.match.movement) {
      if (ms.teleported) this.teleportedSince.add(id);
    }
    if (this.tick % SNAPSHOT_DIVISOR === 0) {
      this.broadcastSnapshots();
      this.teleportedSince.clear();
    }
    this.checkEnd();
  }

  /**
   * 把 sim 报告的 BOSS 事实翻成「一条播报 + 一次席位增删」。
   *
   * ★★ **本方法不做任何判断。** 什么时候刷、掉什么、赏金多少全在
   *   `sim/boss.ts` —— 这里只有 switch 与 push，与 `pushEvent()` 同一种角色。
   *   往这里加一句 `if (血量 < …)` 就是在服务器里长出第二份规则。
   */
  private applyBoss(boss: NonNullable<TickResult['boss']>, out: ServerMessage[]): void {
    const name = getClass(BOSS_CLASS_ID)?.name ?? '大 BOSS';

    if (boss.spawned) {
      // ★ 先接席位再播报：下一 tick 的 onPreTick 就能驱动它，不空转一帧
      this.deps.onBossSpawned?.(boss.spawned.entityId);
      out.push({
        t: 'BossEvent', kind: 'spawned', entityId: boss.spawned.entityId,
        name, position: boss.spawned.position,
      });
    }

    if (boss.enraged !== undefined) {
      out.push({ t: 'BossEvent', kind: 'enraged', entityId: boss.enraged, name });
    }

    if (boss.slain) {
      const slain = boss.slain;
      this.deps.onBossDespawned?.(slain.bossId);
      out.push({
        t: 'BossEvent', kind: 'slain', entityId: slain.bossId, name,
        position: slain.position,
        ...(slain.killerId !== undefined ? { killerId: slain.killerId } : {}),
        ...(slain.bounty > 0 ? { bounty: slain.bounty } : {}),
      });
      /**
       * ★ P13 对接：大乱斗里 BOSS 赏金折进积分账（sim/match/ffa.ts 的
       *   points —— 商店的同一本账），并标记商店余额需要重发。
       *   `BossState.bounties` 只做播报口径，账目在这里只入一次。
       */
      if (this.match.ffa && slain.killerId !== undefined && slain.bounty > 0) {
        const balance = (this.match.ffa.points.get(slain.killerId) ?? 0) + slain.bounty;
        this.match.ffa.points.set(slain.killerId, balance);
        this.shopDirty.add(slain.killerId);
      }
    }
  }

  // ── 输入 ──────────────────────────────────────────────────────

  /**
   * 攒出本 tick 每个实体的移动意图。
   *
   * ★ 断线的人**没有**输入条目 = 站着不动（`tick.ts`：「没有条目 = 站着不动」）,
   *   但他的实体仍在世界里、仍会被打 —— 这正是 11.5「断线不获得无敌」
   *   的实现方式：**什么都不做**。
   */
  private collectInputs(): Map<EntityId, MovementInput> {
    const inputs = new Map<EntityId, MovementInput>();
    for (const s of this.deps.sessions()) {
      const entityId = this.match.entityOf.get(s.playerId);
      if (entityId === undefined) continue;
      const taken = s.takeInputs();
      const latest = taken[taken.length - 1];

      /**
       * ★★ **A5 人机豁免（S1 限流「人机会话跳过」的同款先例）。**
       *
       *   人机的 `Input` 是服务器自产自销的（`BotDriver` → `BotSocket` →
       *   同一条协议栈），**不在威胁模型里**：没有一个不受信任的对端能伪造它。
       *   而不豁免的代价是实打实的 —— `BotDriver` 每 tick 直接把 yaw 设成
       *   「朝向当前目标」，追人时的瞬间转身会被钳成 5 个 tick 的缓转，
       *   于是朝向门禁（`requiresFacing`）、背刺判定、自动攻击的正面弧
       *   全部改口径，**配平基线当场漂移**。这是本批次的红线。
       *
       * ★ 豁免是**双向**的：人机既不过闸，也**不留下基准**。于是一个从头到尾
       *   由人机开的席位在 `turnBudgets` 里根本没有条目 —— W24 中途加入的人
       *   顶替它时，他的第一条朝向按「原样采信」进来（账本里的 `yaw` 还是
       *   `undefined`），不会被人机转出来的角度拖着慢慢转回去。
       * ⚠️ 如实：**真人 → 掉线托管 → 重连**这条路上基准是留着的（他断线前
       *   自己那次主张）。回来时镜头若在反方向，服务器最多用 250ms 追齐 ——
       *   没为它开豁免，因为那是他自己的旧主张，不是人机的。
       */
      const fromClient = !s.isBot;

      /**
       * ★★ **A5：令牌注入在这里，在「有没有输入」之前。**
       *
       *   预算的时钟是**服务器 tick**，不是消息到达。放在 `if (!latest)` 之后
       *   （旧版的写法）就变成「按收到 Input 的 tick 数发预算」：客户端一帧补
       *   两个固定步会把两条 `Input` 挤进同一个 tick、留下一个空 tick，于是
       *   有效上限被腰斩 —— 实测 600°/s 的成对投递每秒拉开 270° 且永远追不齐。
       *   `turnRate.ts` 的 ★★ 记着这条实测。
       */
      const budget = fromClient ? this.budgetOf(entityId) : undefined;
      /** 本 tick 被采信的移动 yaw。人机不过闸 ⇒ 原样 */
      let yaw = latest?.characterYaw ?? 0;
      if (budget) {
        if (latest) {
          yaw = admitYaw(budget, latest.characterYaw);
        } else {
          /**
           * 这一 tick 没有 `Input`，但可能有一条带 `facing` 的 `CastRequest`
           * （它在 `requestCast` 里已经按**同一个基准、同一个桶**钳过了）。
           * 基准与扣费要跟着它走 —— 否则「停发 Input、只发 facing」就变成了
           * 一条免费的转身通道：基准冻在原地，而他每 tick 都能再要一份令牌。
           */
          const facing = this.pendingCasts.get(entityId)?.facing;
          if (facing !== undefined) admitYaw(budget, facing);
        }
        /**
         * ★★ **注入放在采信之后 = 「下一 tick 的令牌在消息到达之前就已经在桶里」。**
         *   `CastRequest` 是在两次 `advance()` 之间到达的，`requestCast` 当场
         *   就要拿桶里的令牌钳它一次（那条路不能等到 tick 里再钳：`pendingCasts`
         *   只留最后一条，钳晚了就等于没钳）。注入若放在采信之前，这条请求读到的
         *   就是**上一 tick 用剩的**令牌 —— 持续转身的玩家永远是 0，一条合法的
         *   方向技能会被钳成「原地不动」。放在之后，两条路读到的是同一桶。
         * ★ 无论这一 tick 有没有输入都注入恰好一次 —— 时钟是 tick，不是消息。
         */
        refillTurnBudget(budget);
      }
      if (!latest) continue;
      /**
       * 按契约每 tick 恰好一条（见 `Session.inputQueue`）。客户端偶尔跑快
       * 发了两条时取**最新**那条 —— 保留最新更接近他此刻的真实意图，
       * 也不给「攒一堆输入换取位移」留口子。
       *
       * ★★ **注意这里没有用 `latest.dt`，用的是 `SIM.TICK_DT`（见 advance）。**
       *   这不是疏忽，是 docs/08 那条作弊向量的**结构性**答案：
       *   「客户端发 dt=100 就能瞬移」在这里**写不出来** —— 服务器的步长
       *   根本不来自客户端。codec 里对 dt 的范围校验是第二道防线，
       *   不是唯一一道。`verify:m10` 第 5 条验的就是这件事。
       *
       * ★★ **A5：朝向也不是照单全收的** —— 转身令牌桶在这里落地，
       *   `turnRate.ts` 写了为什么是「钳到令牌用尽为止」而不是拒绝整条输入。
       *   移动 yaw 与 `CastRequest.facing` 那把尺**共用同一个账本**（同一个
       *   基准、同一个桶）：一 tick 之内两条路加起来也只花得动一桶令牌。
       *   采信本身发生在上面那段（注入与采信的先后有讲究，见那里的 ★★）。
       */
      inputs.set(entityId, {
        forward: latest.forward,
        strafe: latest.strafe,
        jump: latest.jump,
        yaw,
      });
    }
    return inputs;
  }

  /** 战斗阶段的技能请求。由 RoomServer 在收到 `CastRequest` 时调用 */
  requestCast(playerId: string, intent: CastIntent): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    /**
     * ★★ 施法排队窗（P10 / 合同 C5）：**只给真人补 `queue: true`。**
     *
     *   协议里没有这个字段（客户端点不出来，也就伪造不出来），是服务器
     *   单方面替真人开的。之所以不能无条件开 —— `BotDriver` 发的是**真的**
     *   `CastRequest` 消息，走的正是这条 `requestCast`；无条件开等于让 normal
     *   档人机也吃上按键排队，配平基线当场漂移。这是本批次的红线。
     *
     * ⚠️ 断线的真人 `sessionOf` 会返回 undefined —— 按真人算（他本来也发不出
     *   请求），宁可这样也不要「查不到就当人机」那种会把红线判反的兜底。
     */
    const isBot = this.sessionOf(playerId)?.isBot === true;
    /**
     * ★★ **A5：`facing` 与移动 yaw 是同一把尺。**
     *
     *   方向技能（`shape` 为锥/线）在 `tickWorld` 第 1 步会拿 `intent.facing`
     *   直接写 `caster.yaw`，**赶在 `validateCast` 的朝向门禁之前** ——
     *   不钳的话，「一条 CastRequest 就能瞬间瞄向任意方向」是比移动 yaw
     *   更短的一条路：第 2 步的移动积分马上把 `caster.yaw` 覆盖回去，
     *   于是**对手的屏幕上他一帧都没转过身**，而那一发已经打在脸上了。
     *
     * ★ 这里用 `clampYaw`：只**读**账本不动它（基准与扣费都写在
     *   `collectInputs`，每 tick 恰好一次）。于是同一 tick 内连发 20 条
     *   `CastRequest` 也没用：每条都拿同一个起始基准、同一桶令牌钳一遍，
     *   谁也累加不了谁 —— 而 `pendingCasts` 本来就只留最后那一条。
     * ★ 人机豁免的理由与红线同 `collectInputs` 的 ★★（`BotDriver` 每 tick
     *   发的 `facing: self.yaw` 是服务器自己算出来的，不在威胁模型里）。
     *
     * ⚠️ **如实登记一处残余**：两条路各拿本 tick 起始的账本钳一次，于是同一
     *   tick 里「身体往左转满、瞄准往右转满」能让**瞄准与身体差出两桶令牌**。
     *   没有再往下收（改成拿本 tick 采信过的移动 yaw 当基准）的理由：那要把
     *   这道闸挪进 `collectInputs`，而挪进去之后「发完 CastRequest 就断开」
     *   的那一瞬（会话已不在 `sessions()` 里）就没人钳它了 —— 用一个结构性的
     *   缺口换这点收紧，不划算。
     * ⚠️ 另一处如实：桶满时一条 `CastRequest` 能瞄向任意方向（180° 就是
     *   「任意」的上限）。这是令牌桶的取舍本身，`turnBudget.ts` 的 ⚠️ 写了
     *   为什么不能靠收紧它来挡 aimbot。
     * ⚠️ 第三处如实（外部审计问过）：会话**首条**消息就是带 facing 的
     *   `CastRequest` 时预算条目还不存在（`.get()` 落空），这一条原样采信 ——
     *   与账本 `yaw: undefined` 的「第一条原样采信」（开局/中途加入/重连，
     *   `collectInputs` 的 ★）是同一个语义：即便这里改用 `budgetOf()`，
     *   新账本照样原样放行第一条。且 `collectInputs` 每 tick 无条件为真人
     *   建账并把 `pendingCasts` 的 facing 记入基准，所以这份免费额度一个
     *   席位终生恰好一次，之后逐条受钳（turnRate.test 的「零 Input 开局」钉住）。
     */
    const budget = isBot ? undefined : this.turnBudgets.get(entityId);
    const admitted: CastIntent = intent.facing !== undefined && budget !== undefined
      ? { ...intent, facing: clampYaw(budget.yaw, budget.tokens, intent.facing) }
      : intent;
    // ★ 一个实体一 tick 只有一个请求（后一个覆盖前一个）——
    //   与客户端 CombatDirector.requestCast 同语义
    this.pendingCasts.set(entityId, isBot ? admitted : { ...admitted, queue: true });
  }

  /**
   * 其他战斗指令排队。合法性由 RoomServer 在收到时校验（要能回 Rejected）。
   *
   * ★ S1 第二道防线：每玩家每 tick 最多 `COMMANDS_PER_TICK_MAX` 条 ——
   *   令牌桶按秒算、这里按 tick 算：即便某类消息将来绕过了桶，
   *   一 tick 也做不出 1000 次 TabTarget 全实体排序。超出**丢弃计数**，
   *   不回话（能触到这条上限的只有脚本；合法玩家 50ms 里点不出 16 条）。
   */
  enqueue(playerId: string, cmd: MatchCommand): void {
    const n = (this.pendingCommandCounts.get(playerId) ?? 0) + 1;
    this.pendingCommandCounts.set(playerId, n);
    if (n > LIMITS.COMMANDS_PER_TICK_MAX) {
      this.stats.droppedCommands++;
      return;
    }
    this.pendingCommands.push({ playerId, cmd });
  }

  /** 10.1：使用消耗品。★ 与施法同样只排意图，结算在 tickWorld 里 */
  requestConsumable(playerId: string, slot: number): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    this.pendingConsumables.set(entityId, slot);
  }

  /** 8.3 战斗意志（W8）。★ 只排意图，冷却与解除都在 tickWorld 第 1c 步结算 */
  requestTrinket(playerId: string): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    this.pendingTrinkets.add(entityId);
  }

  /**
   * W24：中途加入者顶替人机席位时选的职业 —— **登记，不是立刻换**。
   * 兑现时机与理由见 `pendingRespec` 的 ★★。由 `RoomServer.onJoinOngoing` 调。
   *
   * ★ 幂等：同一个席位再选一次覆盖上一次（还没兑现的那个），`armed` 沿用 ——
   *   否则「趁死着改主意」会把已经攒好的那次兑现推迟到下一次死亡。
   */
  requestRespec(playerId: string, classId: ClassId): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    const e = this.match.world.entities.get(entityId);
    const armed = this.pendingRespec.get(entityId)?.armed ?? (e !== undefined && !e.alive);
    this.pendingRespec.set(entityId, { classId, armed });
  }

  /**
   * W24 收口：把这条会话的 P11 快照记账**整个作废**，下一份快照全量重发
   * EntityMeta（静态块 + 装备视图）。由 `RoomServer.finishSeating` 在
   * **席位变更**那一刻调。
   *
   * ★★ 存在的理由是一个真的错型泄露：`snapAccounts` 以 **Session 对象**为键，
   *   而中途加入是**同一个 Session** 从观战席坐到战斗席（只改 `phase`/
   *   `playerId`）。不作废的话 `seen` / `equipFp` / `staticsFp` 原样命中，
   *   EntityMeta 一条都不重发 —— 观战期按 `SPECTATOR` 定下的**敌人视图**
   *   被永久冻结：他的新队友整局拿不到 ally 视图（换装/消耗品面板空着），
   *   而如果这条记账是别的口径定下的，反向就是整局透视对面的备用装备。
   * ★ 重连不需要这一步：那走的是**新** Session 对象，天然拿到空记账
   *   （见 `snapAccounts` 的注释）。
   */
  resetSnapshotAccount(session: Session): void {
    this.snapAccounts.delete(session);
  }

  /**
   * 把攒着的换职业请求在**「死 → 活」的那一刻**兑现。每 tick 跑一次。
   *
   * ★★ 判据是**状态跳变**而不是「监听复活事件」：复活有两个出口
   *   （夺旗/大乱斗的 `tickRespawn`、竞技场的 `resetRound`），监听事件就得
   *   监听两处，而漏一处的表现是「换了职业的人永远换不过来」——
   *   静默、且只在某一个模式里发生。跳变对两条出口一视同仁。
   * ⚠️ **竞技场默认单回合制**（`roundsToWin: 1`，服务器不调 `resetRound`），
   *   于是「下一次复活」在一局竞技场里**不会到来** —— 顶替人机的玩家整局
   *   用被顶替者的职业。这是如实的后果，不是漏做：客户端的文案要照实说
   *   （见 docs/15 W24 行与 api 清单）。
   */
  private applyPendingRespecs(events: readonly CombatEvent[]): void {
    if (this.pendingRespec.size === 0) return;
    /**
     * ★ 本 tick 的死讯也算「见过他死」—— 光看 `alive` 会漏掉**同一 tick 内
     *   死亡又复活**的情况（死亡漏斗与复活波次都在 tickWorld 里面，波次恰好
     *   在死亡入队之后到点时就是这一幕）。漏了不会报错，只会让他的换职业
     *   一直等到**下一次**死亡 —— 又一个静默的迟到。
     */
    for (const ev of events) {
      if (ev.t !== 'death') continue;
      const entry = this.pendingRespec.get(ev.targetId);
      if (entry) entry.armed = true;
    }
    for (const [entityId, entry] of this.pendingRespec) {
      const e = this.match.world.entities.get(entityId);
      if (!e) { this.pendingRespec.delete(entityId); continue; }
      if (!e.alive) { entry.armed = true; continue; }
      if (!entry.armed) continue;

      const cls = getClass(entry.classId);
      this.pendingRespec.delete(entityId);
      // 职业合法性在 `JoinOngoing` 那一层已经验过（isPlayableClass）；
      // 查不到只可能是数据包在两次之间变了 —— 什么都不做比换成一个空职业好
      if (!cls) continue;
      respecCombatant(this.match, e, cls);
      const playerId = this.match.playerOf.get(entityId);
      if (playerId !== undefined) this.deps.onClassChanged?.(playerId, entry.classId);
    }
  }

  /**
   * 11.5：弃权判死（主动退出 / 重连超时）。
   * ★ 与施法、消耗品同规矩 —— 这里只排意图，死亡结算只有 tickWorld 一个出口。
   *   直改 `alive/health` 的旧写法绕过了统计、10.10 装备清理与 Death 广播
   *   （技术债总账 A1）。
   */
  forfeit(playerId: string): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    this.pendingForfeits.add(entityId);
  }

  /**
   * 在 tick 开头按到达顺序执行本 tick 的指令。
   *
   * ⚠️ 这些函数都只**设置状态或启动进度**（选目标、开始换装、开始交互），
   *    没有一个会结算效果 —— 效果结算只有 `tickWorld` 一个出口（A2 的教训）。
   *    往这里加分支前先确认这一点还成立。
   */
  private applyCommands(): void {
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    this.pendingCommandCounts.clear();

    for (const { playerId, cmd } of commands) {
      const e = this.viewerOf(playerId);
      if (!e) continue;

      switch (cmd.t) {
        case 'SetTarget':
          if (cmd.slot === 'focus') toggleFocus(this.match.world, e, cmd.entityId ?? undefined);
          /**
           * ★★ 合同 C6：5.1 的 45 米选中上限在此之前**从未被强制过** ——
           *   `SetTarget` 只校验可见性，于是半张地图外的人照样能选中。
           *
           * ⚠️ **只对真人强制。** `BotDriver` 发的同样是真的 `SetTarget` 消息
           *   （见那个文件「目标：让服务器知道它在打谁」那一段），它**不是**
           *   直接赋值 `targets.hard`。无条件传 true 会改掉人机在开局/复活后
           *   远距离锁人的行为 —— 那是配平基线的一部分。
           *
           * ★ 超距拒绝**必须回话**（P10 收口）：能走到这里的 id 都已在
           *   `RoomServer.onSetTarget` 过了可见性筛（不可见的在那里就被
           *   `Rejected('目标无效')` 掉了），所以「超出选中距离」这条更具体的
           *   理由**不构成探测通道** —— 探测者根本到不了这个分支。入队到执行
           *   之间目标死亡/消失的竞态窗口，回落到与接收侧同一句笼统的
           *   「目标无效」。姓名板只画到 45 米，常规点选撞不到这条 ——
           *   它服务的是 3D 拾取点到远人与脚本这两类入口：本仓库不接受
           *   「发了没反应」的静默失败（RoomServer.test 有正反两半盯着）。
           */
          else {
            const human = this.sessionOf(playerId)?.isBot !== true;
            const ok = setHardTarget(this.match.world, e, cmd.entityId ?? undefined, {
              enforceRange: human,
            });
            if (!ok && human) {
              const t = getEntity(this.match.world, cmd.entityId ?? undefined);
              this.sessionOf(playerId)?.reject(
                'SetTarget',
                t && isVisibleTo(t, e) && !withinSelectRange(e, t) ? '超出选中距离' : '目标无效',
              );
            }
          }
          break;

        case 'TabTarget':
          tabTarget(
            this.match.world, e,
            {
              /**
               * ⚠️ **这里用的是角色朝向，而 5.3 要的是镜头前方 140°。**
               *   协议里根本没有镜头朝向 —— `InputMessage.characterYaw` 特意
               *   注明了「**角色**朝向，不是镜头朝向（6.5）」。所以服务器端的
               *   Tab **做不到**符合 5.3，这是一个已知偏差，不是疏忽。
               *
               * ★ 正确的架构多半是让**客户端**算 Tab（它有镜头），
               *   再发一条 `SetTarget` —— 而 `SetTarget` 服务器是校验可见集合的，
               *   所以既符合 5.3 又不给作弊留口子。本分支是没有客户端时的兜底。
               */
              viewYaw: e.yaw,
              isCasting: (x) => this.match.casting.has(x.id),
            },
            cmd.reverse,
          );
          break;

        case 'CancelCast':
          cancelCast(this.match.world, this.match.casting, e);
          break;

        case 'Swap': {
          const loadout = this.match.loadouts.get(e.id);
          if (!loadout) break;
          const itemId = cmd.kind === SwapKind.Weapon
            ? loadout.spareWeapons[cmd.slot]
            : loadout.spareArmors[cmd.slot];
          if (itemId === undefined) break;
          beginSwap(e, loadout, this.match.swaps, cmd.kind, itemId, this.match.world.time);
          break;
        }

        case 'InteractStart':
          this.beginInteract(playerId, e, cmd.target);
          break;

        case 'OpenArmory': {
          const r = openArmory(e, this.match.arsenal, cmd.armoryId, this.match.world.time);
          if (r.ok) {
            /**
             * ★ 10.4「**只向打开者**显示其职业的三个横向选择」——
             *   所以是 `sessionOf` 私信，不是 `outbound` 广播。
             */
            this.sessionOfEntity(e.id)?.send({
              t: 'ArsenalOffer', armoryId: r.armoryId, options: r.options,
            });
          } else {
            this.sessionOfEntity(e.id)?.send({ t: 'Rejected', what: 'OpenArmory', reason: r.reason });
          }
          break;
        }

        case 'ChooseArsenal': {
          const loadout = this.match.loadouts.get(e.id);
          if (!loadout) break;
          const r = chooseFromArmory(e, loadout, this.match.arsenal, cmd.armoryId, cmd.choice);
          if (!r.ok) {
            this.sessionOfEntity(e.id)?.send({
              t: 'Rejected', what: 'ChooseArsenal', reason: r.reason,
            });
          }
          // ★ 成功不用回消息：装备栏是**快照**里的 `AllyEquipmentSnapshot`，
          //   下一份快照自然带上新装备。再发一条「你拿到了」就是第二个真相源
          break;
        }

        /**
         * P13 大乱斗积分商店。
         *
         * ★ 规则全在 sim 的 `buyFfaOffer()`：扣分只走 `spendPoints`、
         *   给东西只走 loadout 的既有出口。这里只做三件事 ——
         *   翻译（offerId → 结果）、转达拒绝、把「满血」的效果排给 tickWorld。
         * ★ 与 ChooseArsenal 一样，**成功不回执**：新装备在下一份快照的
         *   装备段里，新余额由 `flushShop()` 的 `FfaShop` 带 ——
         *   再发一条「你买到了」就是第三个真相源。
         */
        case 'FfaBuy': {
          const ffa = this.match.ffa;
          if (!ffa) {
            this.sessionOfEntity(e.id)?.reject('FfaBuy', '本模式没有积分商店');
            break;
          }
          const loadout = this.match.loadouts.get(e.id);
          if (!loadout) break;
          const r = buyFfaOffer(ffa, e, loadout, cmd.offerId);
          if (!r.ok) {
            this.sessionOfEntity(e.id)?.reject('FfaBuy', r.reason);
            break;
          }
          // ★ 满血不在这里结算 —— 排进 itemGrants，由 tickWorld 出 heal 事件
          if (r.effects) this.pendingItemGrants.set(e.id, r.effects);
          this.shopDirty.add(e.id);
          break;
        }

        case 'InteractCancel': {
          this.match.pickups.delete(e.id);
          for (const flag of Object.values(this.match.ctf?.state.flags ?? {})) {
            if (flag.interactorId === e.id) cancelFlagInteract(flag);
          }
          break;
        }
      }
    }
  }

  /**
   * 7.6 / 4.x 普通攻击的开火判据（M14 接线）。
   *
   * ★★ 在此之前 `SwingStore` 只在测试与 balance-report 里被登记过 ——
   *   真实对局里普攻**不存在**，战士因此没有任何怒气来源（技术债 §2b
   *   说「7.6 已实现」，实现了规则、没接谁开火。老教训第五次应验）。
   *
   * v1 判据：**敌方硬目标存活 = 开火**；失去目标/换成友方/自己死了 = 收手。
   * 4.x 原文是「右键点击敌方目标：开始或停止普通攻击」的手动开关 ——
   * 简化为目标驱动登记为 docs/10 已知偏差 #9：目标制战斗里「选中敌人却
   * 不想打他」的场景（如仅为观察目标框）极少，而漏开火的代价（零怒气、
   * 零白字）是结构性的。
   *
   * ★ beginSwing 幂等 —— 换目标**不刷新**挥击计时（7.6：计时不被重置），
   *   所以每 tick 同步是安全的；stopSwing 后再交战则从整个间隔重新起算。
   * ★ 放在 applyCommands 之后：本 tick 的 SetTarget 立即参与判定。
   * ★ 试验场的实战模式有一份同判据的镜像（`CombatDirector.syncBotSwings`，
   *   X10 真机轮补上 —— 此前只建了 store 没人登记，白字整条是死的）；
   *   站桩模式（141 项验收的载体）不传 swings store，假人不会白打玩家。
   */
  private syncSwings(): void {
    const now = this.match.world.time;
    for (const e of listEntities(this.match.world)) {
      const target = e.targets.hard !== undefined
        ? this.match.world.entities.get(e.targets.hard)
        : undefined;
      const engaged =
        e.alive && target !== undefined && target.alive && target.team !== e.team;
      if (engaged) {
        // ★ W26：第一刀的时刻也要吃 attackSpeed（守护甲 1.08 慢 8%）——
        //   与 tickSwings 共用 swingIntervalOf，两处各写一遍迟早漂移
        beginSwing(this.match.swings, e.id, now, swingIntervalOf(this.match.auras, e, now));
      } else {
        stopSwing(this.match.swings, e.id);
      }
    }
  }

  /**
   * 交互。
   *
   * ✅ **协议此前那个坑已经填了**：`InteractStart` 现在带一个可辨识联合
   *   （`{kind:'flag'} | {kind:'drop', dropId}`），所以服务器不再需要
   *   「先试旗帜、失败了再当成掉落 id」地猜玩家想干什么 ——
   *   那种猜法在「站在旗边想捡脚下的装备」时会猜错，而且错得很安静。
   *
   * ★ 失败**一定要回话**：10.2 要求交互不匹配时提示、10.5 要求没抢到的人
   *   收到明确失败反馈。此前 `beginPickup()` 的返回值在这里被直接丢弃，
   *   于是联网局里「捡不起来」和「服务器没收到」在客户端看起来一模一样。
   */
  private beginInteract(playerId: string, e: CombatEntity, target: InteractTarget): void {
    const now = this.match.world.time;

    if (target.kind === 'flag') {
      if (!this.match.ctf) return;
      const { state, deps } = this.match.ctf;
      for (const flag of Object.values(state.flags)) {
        if (distance2D(e.position, flag.position) > INTERACT_RANGE) continue;
        const r = beginFlagInteract(state, e, flag, now,
          (p) => deps.captureZoneContains(e.team, p));
        if (r.ok) return;
      }
      this.sessionOf(playerId)?.send({ t: 'Rejected', what: 'InteractStart', reason: '附近没有可交互的旗帜' });
      return;
    }

    const loadout = this.match.loadouts.get(e.id);
    if (!loadout) return;
    const r = beginPickup(e, loadout, this.match.arsenal, this.match.pickups, target.dropId, now);
    if (!r.ok) {
      // ★ 10.2：**物品不会消失** —— `beginPickup` 的失败路径里没有删除语句，
      //   这里也只是转达理由，不碰地面状态
      this.sessionOf(playerId)?.send({
        t: 'PickupResult', dropId: target.dropId, ok: false, reason: r.reason,
      });
    }
  }

  // ── P13 积分商店 ──────────────────────────────────────────────

  /**
   * 把这一 tick 里余额变过的人的货架重发一遍。
   *
   * ★★ **客户端永远只显示服务器发来的余额，不自己减。** 本地先减一份的话，
   *   被拒绝的那次购买会让面板与真账长期错开 —— 而玩家只会觉得「分数算错了」，
   *   查起来要一路查到协议。所以扣账的唯一出口（`spendPoints`）与显示的
   *   唯一来源（这条消息）之间没有第二条路。
   */
  private flushShop(): void {
    if (this.shopDirty.size === 0) return;
    for (const entityId of this.shopDirty) this.sendShop(entityId);
    this.shopDirty.clear();
  }

  /** 给一个人私信他的货架与余额。★ 人机跳过 —— BotSocket 反正把它丢掉 */
  private sendShop(entityId: EntityId): void {
    const ffa = this.match.ffa;
    if (!ffa) return;
    const session = this.sessionOfEntity(entityId);
    if (!session || session.isBot) return;
    const e = this.match.world.entities.get(entityId);
    if (!e) return;
    session.send({
      t: 'FfaShop',
      balance: ffa.points.get(entityId) ?? 0,
      // ★ 按**他的**职业生成（与 ArsenalOffer 同则）——货架不是全职业目录
      offers: ffaShopFor(e.classId),
    });
  }

  /**
   * 重连后补一份货架。由 `RoomServer.onReconnect` 调。
   *
   * ★ 与快照「不单独补发、下一 tick 自然会到」的做法不同：`FfaShop` 是
   *   **事件式**的（余额变了才发），重连的人可能几分钟内都等不到下一次变动，
   *   那期间他的面板是空的。这条补发是它必须存在的理由。
   */
  sendShopTo(playerId: string): void {
    if (!this.match.ffa) return;
    const entityId = this.match.entityOf.get(playerId);
    if (entityId !== undefined) this.sendShop(entityId);
  }

  // ── 断线超时 ──────────────────────────────────────────────────

  /**
   * 超时的**后果**在这里执行。
   *
   * ★ `takeExpired()` 只返回名单 —— reconnect.ts 刻意不自己淘汰，
   *   因为淘汰要写死亡统计、要触发死亡结算，那些都在调用方。
   */
  private settleExpiredReconnects(): void {
    for (const playerId of takeExpired(this.deps.reconnects, this.match.world.time)) {
      this.deps.onEliminate(playerId, 'timeout');
    }
  }

  // ── 广播 ──────────────────────────────────────────────────────

  /** 把一条战斗事件转成协议消息。★ 未映射的事件类型**静默丢弃**是有意的 */
  private pushEvent(out: ServerMessage[], ev: CombatEvent): void {
    switch (ev.t) {
      case 'damage':
        out.push({
          t: 'Damage', sourceId: ev.sourceId, targetId: ev.targetId,
          amount: ev.amount, school: ev.school, absorbed: ev.absorbed, immune: ev.immune,
          overkill: ev.overkill,
          // W17/X3 条件展开：普通命中不付未用字段的带宽（与事件层同一约定）
          ...(ev.avoided ? { avoided: ev.avoided } : {}),
          ...(ev.skillId ? { skillId: asSkillId(ev.skillId) } : {}),
          ...(ev.crit ? { crit: true } : {}),
        });
        break;
      case 'heal':
        out.push({
          t: 'Heal', sourceId: ev.sourceId, targetId: ev.targetId,
          amount: ev.amount, overheal: ev.overheal,
          ...(ev.crit ? { crit: true } : {}),
        });
        break;
      case 'auraApplied':
        out.push({
          // ★ S7：带上 sourceId —— redactFor 据它决定是否掩掉 auraId（施加者
          //   不可见时，`rogue.rupture` 会连同 sourceId 一起被抹）
          t: 'AuraApplied', targetId: ev.targetId, sourceId: ev.sourceId, auraId: ev.auraId,
          duration: ev.duration, stacks: 1,
        });
        break;
      case 'auraRemoved':
        out.push({
          t: 'AuraRemoved', targetId: ev.targetId, auraId: ev.auraId,
          reason: removalReason(ev.reason),
        });
        break;
      case 'shieldBroken':
        out.push({
          t: 'AuraRemoved', targetId: ev.targetId, auraId: ev.auraId, reason: 'shieldBroken',
        });
        break;
      case 'death':
        out.push({
          t: 'Death', entityId: ev.targetId,
          ...(ev.killerId !== undefined ? { killerId: ev.killerId } : {}),
        });
        break;
      default:
        // resource / displaced / immune / dispelled / interrupt / custom：
        // 协议里还没有对应消息。★ 不编一个出来 —— 加消息要先改 protocol.ts，
        // 那里有一条测试在盯着字段名（客户端发不出「结果」）。
        break;
    }
  }

  /**
   * 事件按接收者投递。
   *
   * ★★ **事件也会泄露实体的存在。** docs/08 §4 只写了快照裁剪，但一条
   *   `Heal{targetId: 潜行者}` 同样会让那个 id 出现在传输字节里 ——
   *   而 `verify:m10` 第 1 条验的是「不出现在**传输字节**里」，不是「不在快照里」。
   *   所以这里对事件做同一套可见性判断。
   *
   * ⚠️ **本版本是保守实现**：只要事件引用了对该接收者不可见的实体，整条不发。
   *   代价是「被看不见的人打了一下，你看不到伤害数字」—— 而 14.1 要求有命中反馈。
   *   正确的做法多半是「发伤害但把 sourceId 抹掉」，那需要给协议加一个
   *   可空的 sourceId，属于 A4 的范围。**在这里记下来，不假装已经解决。**
   */
  private dispatch(messages: readonly ServerMessage[]): void {
    if (messages.length === 0) return;
    /**
     * ★ P11：事件消息的编码按**对象身份**共享。`redactFor` 仍然逐接收者跑
     *   （红线：裁剪一寸不让），但它对无需裁剪的接收者**原样返回同一个对象**
     *   （下面三个分支的 `return msg`）—— 于是全体这样的接收者天然命中同
     *   一条编码缓存；发生了裁剪的接收者拿到新对象、自己占一格。
     *   键是对象身份而不是内容，**结构上不可能**把两个不同的裁剪结果并成
     *   一条编码。与 `broadcastStats` 的 sendRaw 共享编码（P5）同一手法。
     */
    const encoded = new Map<ServerMessage, string>();
    for (const s of this.deps.sessions()) {
      /**
       * ★ P11：人机会话跳过整段（与 `broadcastSnapshots` 的 P2 同源同理由）：
       *   BotSocket.send 把字符串直接丢掉，但此前每条事件仍对每个人机白付
       *   一次 redactFor + 编码。人机决策层（BotDriver）读的是 world，
       *   从不消费事件消息 —— 跳的是浪费，不是语义。
       */
      if (s.isBot) continue;
      /**
       * ★ W24：观战席也要收事件流 —— 没有它，观战画面上没有伤害数字、
       *   没有死亡反馈、没有施法表现（14.1 那一整套对观战者全丢）。
       *   裁剪走**同一个** `redactFor`，只是受众换成 `SPECTATOR`：
       *   观战段的判据比任何一队都窄，所以这不是放宽，是接线。
       */
      const audience = this.audienceOf(s);
      if (!audience) continue;
      for (const msg of messages) {
        const safe = this.redactFor(msg, audience);
        if (!safe) continue;
        let raw = encoded.get(safe);
        if (raw === undefined) {
          raw = encodeServerMessage(safe);
          encoded.set(safe, raw);
        }
        s.sendRaw(raw);
      }
    }
  }

  /**
   * 把一条消息裁成对这个接收者安全的形式。
   *
   * ★★ **优先「抹掉来源」，其次才是「整条不发」。**
   *   `Damage` / `Heal` 的 `sourceId` 是可空的，正是为了这一刻：
   *   被未被发现的潜行者打了一下，玩家**应该**看到伤害数字（14.1 命中反馈），
   *   但**不应该**知道是谁打的（验收 #5）。整条丢弃会让他莫名掉血。
   *
   * ⚠️ 只有当**目标**本身不可见时才整条丢弃 —— 那时这条事件与他无关，
   *   而且 targetId 没有可抹的余地（抹掉就没有内容了）。
   *
   * @returns 可发送的消息；返回 undefined 表示这条对他必须完全隐藏
   */
  private redactFor(msg: ServerMessage, viewer: SnapshotAudience): ServerMessage | undefined {
    const ctx = this.match.ctf ? { ctf: this.match.ctf.state } : undefined;
    const visible = (id: EntityId | undefined): boolean => {
      if (id === undefined) return true;
      const e = this.match.world.entities.get(id);
      if (!e) return true; // 已离场的实体不构成泄露
      return isVisibleToAudience(e, viewer, ctx);
    };

    switch (msg.t) {
      case 'Damage':
      case 'Heal': {
        // 目标看不见 → 这条与他无关，整条不发
        if (!visible(msg.targetId)) return undefined;
        // 来源看不见 → 抹掉来源，数字照发（14.1）
        if (!visible(msg.sourceId)) {
          // ★ X3/S7：`skillId`（`rogue.rupture`）与 sourceId 同样泄露职业，
          //   一起抹。`avoided`/`crit`/`school` 不泄露来源，留着（14.1 反馈）
          const { sourceId: _s, ...rest } = msg as Extract<ServerMessage, { t: 'Damage' | 'Heal' }>;
          if ('skillId' in rest) delete (rest as { skillId?: unknown }).skillId;
          return rest as ServerMessage;
        }
        return msg;
      }
      /**
       * ★ S7：光环 id 泄露施加者职业。施加者不可见 → 抹 sourceId + 把 auraId
       *   掩成中性 token（目标身上「有个 debuff」照常显示，不说是谁的什么）。
       *   施加者可见（或已离场 = `visible` 判 true）→ 原样。
       */
      case 'AuraApplied': {
        if (!visible(msg.targetId)) return undefined;
        if (!visible(msg.sourceId)) {
          const { sourceId: _s, ...rest } = msg;
          return { ...rest, auraId: HIDDEN_AURA_ID };
        }
        return msg;
      }
      /**
       * ★★ A9：`Death` 与 `Damage` 同口径 —— **抹凶手，不丢死讯**。
       *
       *   此前走 default 的「有一个看不见就整条丢」：队友被一个未被发现的
       *   潜行者收掉，全队一条 Death 都收不到，只能等下一帧快照的
       *   `alive:false` 自己推断出「他没了」—— 14.1 命中/死亡反馈缺失的
       *   同一个家族。死者本人可见（快照里就躺在那儿），死这件事对他的
       *   队友是**公共事实**；需要瞒的只有「是谁下的手」。
       *
       * ⚠️ 死者不可见才整条丢：那时这条事件与接收者无关，而 `entityId`
       *   没有可抹的余地（抹掉就没有内容了）—— 与 Damage 的 targetId 同理。
       */
      case 'Death': {
        if (!visible(msg.entityId)) return undefined;
        if (visible(msg.killerId)) return msg;
        const { killerId: _k, ...rest } = msg;
        return rest;
      }
      /**
       * ★ 同样是「抹而不丢」：BOSS 死了是**全场公共事实**（战利品就摆在
       *   地上，谁都看得见），但最后一击者可能是一个尚未被发现的潜行者 ——
       *   整条丢弃会让其他人永远不知道 BOSS 没了，带上 killerId 又等于
       *   给潜行者点名（验收 #5）。抹掉凶手，事实照发。
       */
      case 'BossEvent': {
        if (visible(msg.killerId)) return msg;
        const { killerId: _k, bounty: _b, ...rest } = msg;
        return rest as ServerMessage;
      }
      /**
       * 与 Damage 同一套「抹而不丢」：施法者不可见就去掉 casterId（没有弹体起点），
       * 目标列表按可见性过滤（不可见目标不该在他屏幕上炸开一朵花）。
       * 两者都空 → 这条对他没有任何可画的内容，整条不发。
       */
      case 'CastResolved': {
        const targetIds = msg.targetIds.filter((id) => visible(id));
        const casterVisible = visible(msg.casterId);
        if (!casterVisible && targetIds.length === 0) return undefined;
        return {
          t: 'CastResolved',
          ...(casterVisible && msg.casterId !== undefined ? { casterId: msg.casterId } : {}),
          skillId: msg.skillId,
          targetIds,
        };
      }
      default: {
        for (const id of referencedEntities(msg)) {
          if (!visible(id)) return undefined;
        }
        return msg;
      }
    }
  }

  /**
   * 每个客户端一份快照。见文件头第 2 条。
   *
   * ★ 发送前过 `assertNoHiddenEntities()` —— 这是 A4 的安全边界兜底，
   *   在生产环境也开着：验收 #5 宁可掉线也不能透视。
   */
  private broadcastSnapshots(): void {
    const m = this.match;
    const snapDeps = {
      world: m.world,
      auras: m.auras,
      swaps: m.swaps,
      loadouts: m.loadouts,
      tick: this.tick,
      dampening: m.arena?.dampening.amount ?? 0,
      suddenDeath: m.arena?.dampening.suddenDeath ?? false,
      // 13.4：把「这一 tick 是瞬移过来的」带进快照，插值器据此瞬移而非滑行
      movement: m.movement,
      // 14.4 投射物主体 + 14.3 地面边界（traps 结构上不进快照，见 visibility.ts）
      projectiles: m.projectiles,
      ground: m.ground,
      // 10.2 掉落物 + 10.4 军械点。★ 经典竞技场里这两个数组恒空（验收 #28）
      arsenal: m.arsenal,
      ...(m.ctf ? { ctf: m.ctf.state } : {}),
      // 12.6 复活波次倒计时（W12：夺旗 HUD 与死亡遮罩都读它）
      ...(m.respawn ? { respawn: m.respawn } : {}),
      // P11 波2：非快照 tick 攒下的瞬移（advance 里累积，广播后清空）
      teleportedSince: this.teleportedSince,
    };

    /**
     * ★ P11：装备的**原始状态指纹**每实体每 tick 只算一次 —— 它读的是
     *   weaponId/armorId/loadout/swap 的底层状态，与观察者无关（视图才
     *   分敌我，而敌我关系对每个 (会话,实体) 对是常量）。第一版按
     *   (会话 × 实体) 算并顺手构建了完整视图，2.9 万次/秒的数组拷贝把
     *   省下的又吃回去了 —— 40 房 3v3 实测反而涨了 0.13 核。
     */
    const fpOf = new Map<EntityId, string>();
    for (const e of listEntities(m.world)) {
      fpOf.set(e.id, equipFingerprint(e, m.loadouts.get(e.id), m.swaps.get(e.id)));
    }

    /**
     * ★★ P11 波3：**共享段按队伍构建+序列化一次，全队复用。**
     *
     *   快照的实体段是 (世界, 接收者队伍) 的函数 —— 潜行裁剪
     *   （isHiddenFromViewer 只读 isHostile）、光环掩码（auraSourceVisible
     *   走 isVisibleTo）、装备视图全部只依赖队伍，对抗性验证连同
     *   「潜行旗手/死亡观察者/宠物」的边角都实证过：同队任意两人的
     *   实体段逐字节相同。此前 24 个观察者各建各序列化 = O(N²)，
     *   现在每队一次 + 每人一小段 self —— O(N)。
     *
     *   逐人的量恰好是：ackSeq / you / SelfStateSnapshot（cooldowns、gcd、
     *   焦点、重放状态、可拾取列表）—— 全在 `buildSelfState`，见其 ★★。
     *
     * ★ 序列化共享：把共享对象 stringify 一次、掐掉外层花括号得到
     *   `"tick":…,"entities":[…]` 片段，每人的消息 = 模板拼接片段 + 私有段。
     *   拼接的正确性由「片段来自 JSON.stringify、私有段各自 JSON.stringify、
     *   模板只补语法字符」保证 —— 没有手写转义。
     *
     * ★ 兜底断言每队跑一次（可见性是队伍级的，代表视角与全队等价）；
     *   `sharedByTeam` 以 TeamId 为键 —— 「把红队的帧发给蓝队」要先把
     *   错误的队伍号递进 Map，而队伍号直接取自接收者实体，写不出来。
     */
    /**
     * ★★ W24：观战席是**第三个共享段**（键 `SPECTATOR`）。
     *
     *   它的可见集是「两队可见集的交集」（判据与裁决理由见
     *   `isVisibleToSpectator`），所以既不能拿红队那份糊弄他（那会把红队自己
     *   的潜行者送出去），也不能给他一份全量（那是透视）。
     * ★ **有观战者才建**：`sharedFor` 是惰性的，零观战者的房间里
     *   `SPECTATOR` 这个键从来不会被创建 —— 观战功能对既有对局零成本。
     */
    const time = Math.round(m.world.time * 1000) / 1000;
    const sharedByTeam = new Map<
      TeamId | typeof SPECTATOR,
      { fragment: string; entities: Snapshot['entities'] }
    >();
    const sharedFor = (
      rep: SnapshotAudience,
    ): { fragment: string; entities: Snapshot['entities'] } => {
      const key = rep === SPECTATOR ? SPECTATOR : rep.team;
      let shared = sharedByTeam.get(key);
      if (!shared) {
        const snap = buildSnapshot(snapDeps, rep);
        assertNoHiddenEntities(snap, m.world, rep, m.ctf ? { ctf: m.ctf.state } : undefined);
        const fragment = JSON.stringify({
          tick: snap.tick,
          time,
          entities: snap.entities,
          projectiles: snap.projectiles,
          grounds: snap.grounds,
          drops: snap.drops,
          armories: snap.armories,
          match: snap.match,
        }).slice(1, -1);
        shared = { fragment, entities: snap.entities };
        sharedByTeam.set(key, shared);
      }
      return shared;
    };

    for (const s of this.deps.sessions()) {
      /**
       * ★ P2（技术债总账）：人机会话跳过快照的构建与序列化 ——
       *   BotSocket 反正把字符串丢掉；人机决策层（BotDriver）读的是 world，
       *   从来不消费快照。跳的是浪费，不是可见性语义（M16b 红线原样）。
       */
      if (s.isBot) continue;
      const viewer = this.viewerOf(s.playerId);
      // ★ W24：观战席没有实体 —— 「查不到实体」不再等于「跳过这条会话」
      if (!viewer && !s.isSpectator) continue;

      // P11 每会话记账（seen/装备指纹），生命周期见 snapAccounts 的注释
      let account = this.snapAccounts.get(s);
      if (!account) {
        account = { seen: new Set(), equipFp: new Map(), staticsFp: new Map() };
        this.snapAccounts.set(s, account);
      }

      /**
       * ★ 11.4：**死了**才走观战视角，活着的人跟随别人就是透视。
       *   跟随目标必须是己方存活玩家（spectatableFor 的规则），不合法就
       *   退回自己的视角，而不是降级成自由镜头（11.4 明确不允许）。
       *   跟随只能是队友 ⇒ 共享段同一份；you 与 self 段换成被跟随者 ——
       *   与此前 buildSpectatorSnapshot 复用队友视角的语义逐字相同。
       *
       * ★★ W24 观战席走**另一条**判据（`isLegalSpectateFollow`：没有「己方」，
       *   换成「进得了观战段」），而且跟随对象只决定 `you`（镜头看谁），
       *   **不决定共享段** —— 观战段永远是那一份交集，跟到谁身上都不会
       *   因此多看见一个人。跟随目标不合法/没选时退到列表里的第一个
       *   （`spectatableForSpectator` 按 id 序，确定性）；一个可跟的都没有时
       *   `you` 落在 `NO_ENTITY`（0）哨兵上。
       */
      const followed = s.following !== undefined ? m.world.entities.get(s.following) : undefined;
      const ctx = m.ctf ? { ctf: m.ctf.state } : undefined;

      let audience: SnapshotAudience;
      /** 快照里的 `you` / EntityMeta 的装备视角所用的那个「人」。观战席可能没有 */
      let effectiveViewer: CombatEntity | undefined;
      if (s.isSpectator) {
        audience = SPECTATOR;
        effectiveViewer = followed && isLegalSpectateFollow(followed, ctx)
          ? followed
          : spectatableForSpectator(m.world, ctx)[0];
      } else {
        const me = viewer!;
        audience = me;
        const following = !me.alive && followed ? followed : undefined;
        effectiveViewer = following && isLegalFollow(following, me) ? following : me;
      }

      const shared = sharedFor(audience);

      /**
       * ★ P11 EntityMeta 通道：首见带静态块 + 装备，之后只在装备指纹变了时
       *   带装备。指纹法而不是 sim 挂钩 —— 挂钩会有「新增一条改装备的路径
       *   忘了通知」的静默失效，指纹漏不掉。**必须发在快照之前**：客户端
       *   hydrate 从缓存合回实体，首见的实体要在快照到达前拿到元数据。
       */
      let metaItems:
        {
          entityId: EntityId;
          statics?: ReturnType<typeof staticsOf>;
          equipment?: ReturnType<typeof equipmentViewFor>;
        }[] | undefined;
      for (const se of shared.entities) {
        const e = m.world.entities.get(se.id);
        if (!e) continue;
        const fp = fpOf.get(se.id);
        const firstSeen = !account.seen.has(se.id);
        const equipChanged = fp !== undefined && account.equipFp.get(se.id) !== fp;
        /**
         * ★★ W26：生命上限**不再是一局不变的**（德鲁伊熊形态 `maxHealth: 1.2`
         *   接线之后，变身进出会改 `entity.maxHealth`）。不补发的后果很具体：
         *   客户端血条按首见那份 1050 画 1260 的血，熊满血显示成 120% ——
         *   而快照里的 `health` 是对的，所以没有任何一层会报错。
         * ★ 用与装备完全同一套指纹法，理由也同一条：挂钩「谁改了上限」会有
         *   「新增一条改上限的路径忘了通知」的静默失效，比一个数字的比较贵得多。
         * ★ 补发的是整块 statics（name/team/classId/maxResources 顺带重发）——
         *   一局里这条路径只在变身时走几次，为省几十字节把静态块拆成两条通道
         *   反而给客户端多一个「合了一半」的状态。
         */
        /**
         * ★★ W24 把这条从「只盯 maxHealth」扩成**整块静态块的指纹**。
         *   多出来的两个变化源都是本批带来的，而且都不是数字：
         *     · `name` —— 中途加入者顶替人机席位后，姓名板要从「人机3」
         *       变成他的名字（`takeOverSeat`）；
         *     · `classId` / `maxResources` —— 下一次复活换职业时整块都变
         *       （`respecCombatant`）。
         *   只比 maxHealth 的话，换成同样血量的职业就**一个字节都不会重发**，
         *   客户端会顶着旧职业的图标和旧名字画一个新职业的人 —— 而快照里的
         *   血量/资源是对的，所以没有任何一层会报错（与 W26 那次同一种静默）。
         * ★ 指纹法而不是 sim 挂钩，理由与装备那条逐字相同：挂钩会有
         *   「新增一条改静态块的路径忘了通知」的静默失效。
         */
        const staticsFp = staticsFingerprint(e);
        const staticsChanged = !firstSeen && account.staticsFp.get(se.id) !== staticsFp;
        if (!firstSeen && !equipChanged && !staticsChanged) continue;
        account.seen.add(se.id);
        if (fp !== undefined) account.equipFp.set(se.id, fp);
        account.staticsFp.set(se.id, staticsFp);
        (metaItems ??= []).push({
          entityId: se.id,
          ...(firstSeen || staticsChanged ? { statics: staticsOf(e) } : {}),
          // ★ 只有首见/指纹变了才构建视图（含数组拷贝）—— 稀有路径
          /**
           * ★★ 传的是 `audience` 而**不是** `effectiveViewer`（W24 收口修正）。
           *   两者对参战者是同一个答案（死亡观战跟的是**队友**，而装备视图
           *   只按阵营分岔），对观战席却天差地别：`effectiveViewer` 是他
           *   正在看的那个**真实实体**，`isFriendly` 对那一队判真 → 被跟随者
           *   全队都发 `allyEquipment`（备用武器/护甲/消耗品/精确护甲 id）。
           *   按 V 换一遍视角就能把双方的备用装备栏收齐 —— 正是「给敌队
           *   第二双眼睛」。`audience` 对观战席是 `SPECTATOR`：他不是任何人
           *   的队友，一律敌人视图（10.6 / 验收 #36，`CULLING_RULES` 4.4-spectator）。
           * ★ 顺带让 `equipFingerprint` 那句「敌我关系对每个 (会话,实体) 对
           *   是常量」重新成立 —— 视图不再随跟随对象变，缓存才不会顶着
           *   上一次的错型视图。
           */
          equipment: equipmentViewFor(e, audience, m),
        });
      }
      if (metaItems) s.send({ t: 'EntityMeta', items: metaItems });

      /**
       * ★★ W24：**观战席不发 `self` 段。**
       *
       *   `SelfStateSnapshot` 装的是冷却、GCD、焦点、重放状态 —— 而
       *   docs/08 §4.3 明明白白写着「敌方技能冷却与公共冷却不发」
       *   （`CULLING_RULES` 的 4.3-cooldown）。观战席对场上双方都不是队友，
       *   把跟随对象的冷却发给他，就是用一条产品功能把那条裁剪规则挖穿
       *   （而且是任何人开第二个窗口就能用的那种）。
       *   观战者没有身体、按不出任何技能，也就不需要冷却条 —— 少发这一段
       *   既是安全的那一侧，也不少任何东西。
       * ★ `you` 对观战席是「现在在看谁」；一个可看的都没有时是 `NO_ENTITY`（0）。
       *   客户端凭 `MatchStart.spectating` 知道这不是自己的角色（不预测、不发输入）。
       */
      const you = effectiveViewer?.id ?? NO_ENTITY;
      const self = s.isSpectator || !effectiveViewer
        ? undefined
        : buildSelfState(snapDeps, effectiveViewer);
      s.sendRaw(
        `{"t":"Snapshot","ackSeq":${s.ackSeq},"you":${you},` +
        (self ? `"self":${JSON.stringify(self)},` : '') +
        `${shared.fragment}}`,
      );
    }
  }

  // ── 结束 ──────────────────────────────────────────────────────

  private checkEnd(): void {
    /**
     * 两种模式各自的胜负源，都在 sim：竞技场读 `arena.outcome`（tickArena
     * 维护），夺旗问 `ctfWinner()`（12.1 先到目标分者胜）。
     *
     * ★★ 夺旗那半句是 W12 接线时抓到的真 bug：`ctfWinner` 自 M7 起在
     *   服务器侧**零调用** —— 旗照抢、分照记、快照照发，但联网夺旗一局
     *   **永远打不完**（没有 MatchEnd、没有统计、房间回不到「再来一局」）。
     *   试验场没事是因为 CtfDemo 自己调它 —— 规则只有一份，消费方漏了一个。
     *
     * ★★ A17 起夺旗读的是 `ctf.state.outcome`（`flag.ts` 的 `resolveCtfOutcome`
     *   维护），与竞技场读 `arena.outcome` 完全同构 —— 时限、加时、平局
     *   三件事全部在 sim 里判完，服务器只是把结果转成 `MatchEnd`。
     *   `ctfWinner()` 仍在（12.1 的目标分判据只有一份实现，`resolveCtfOutcome`
     *   自己就调它），但服务器不再直接问它：那样会绕过时限与加时。
     */
    /**
     * P12 大乱斗：先到 killTarget 杀获胜。读的是 sim 统计（击杀归因在
     * stats.ts，这里不重算）；「胜者」用他的独立 TeamId 表达 —— MatchEnd
     * 的形状不变，客户端按 MatchStats 的名单反查名字显示。
     */
    const ffaWinner = (): TeamId | null => {
      if (!this.match.ffa) return null;
      for (const [entityId, row] of this.match.stats.players) {
        if (row.general.kills >= this.match.ffa.killTarget) {
          return this.match.world.entities.get(entityId)?.team ?? null;
        }
      }
      return null;
    };

    const winner: TeamId | 'draw' | null = this.match.arena
      ? (this.match.arena.outcome ? this.match.arena.outcome.winner ?? 'draw' : null)
      : this.match.ctf
        ? (this.match.ctf.state.outcome ? this.match.ctf.state.outcome.winner : null)
      : this.match.ffa ? ffaWinner()
      : null;
    if (winner === null) return;
    this.ended = true;
    this.stop();
    this.broadcastStats();
    this.deps.onEnd(winner);
  }

  /**
   * 16.x 战后统计 + 16.4 七项最佳玩家。
   *
   * ★★ **在此之前 `sim/stats.ts` 算好的东西没有任何出口。** 统计跑了整整
   *   一局，`pickAwards()` 在网络层零调用方，然后随房间一起被丢掉 ——
   *   联网玩家看到的只有一行「红方获胜」。
   *
   * ★ 在 `onEnd` **之前**发：`onEnd` 会把房间放回 Room 阶段并广播 RoomState，
   *   客户端那时已经切走了战斗场景。顺序反了统计就会发给一个不再看它的页面。
   * ★ 对局已经结束，所以不做任何裁剪 —— 这时没有什么还需要瞒着谁
   *   （潜行者也已经不在场上了）。这是它能带完整名单的唯一依据。
   */
  private broadcastStats(): void {
    const roster = [...this.match.stats.players.values()];
    if (roster.length === 0) return;

    const nameOf = (id: EntityId | undefined): string | undefined =>
      id === undefined ? undefined : this.match.stats.players.get(id)?.name;

    const msg: ServerMessage = {
      t: 'MatchStats',
      // ★ 投影走 sim 的 `statsRows()` —— 服务器不自己挑字段（见那个函数的注释）
      rows: statsRows(this.match.stats),
      awards: pickAwards(roster).map((a) => ({
        award: a.award,
        name: a.name,
        ...(a.winner ? { winnerId: a.winner.entityId, winnerName: nameOf(a.winner.entityId) } : {}),
        ...(a.parts
          ? { parts: a.parts.map((p) => ({ dimension: p.dimension, share: p.normalized * p.weight })) }
          : {}),
      })),
    };
    /** ★ P5（技术债总账）：本局最大的一条消息，全员共享一次编码 */
    const raw = encodeServerMessage(msg);
    for (const s of this.deps.sessions()) s.sendRaw(raw);
  }

  // ── 小工具 ────────────────────────────────────────────────────

  private viewerOf(playerId: string): CombatEntity | undefined {
    const id = this.match.entityOf.get(playerId);
    return id === undefined ? undefined : this.match.world.entities.get(id);
  }

  /**
   * 这条会话的**受众**：他自己的实体，或（W24）观战席。
   * `undefined` = 他既没有实体也不是观战席（还没入场 / 已离场）—— 不发。
   */
  private audienceOf(s: Session): SnapshotAudience | undefined {
    if (s.isSpectator) return SPECTATOR;
    return this.viewerOf(s.playerId);
  }

  private sessionOf(playerId: string): Session | undefined {
    for (const s of this.deps.sessions()) if (s.playerId === playerId) return s;
    return undefined;
  }

  private sessionOfEntity(entityId: EntityId): Session | undefined {
    const playerId = this.match.playerOf.get(entityId);
    return playerId === undefined ? undefined : this.sessionOf(playerId);
  }
}

/**
 * 装备的**原始状态**指纹（P11）。读的是视图的全部上游输入 —— 当前武器/
 * 护甲、备用槽全量、消耗品、换装条目；任何一个变了，敌我两种视图里
 * **可能**变的都变了（宁可多发一条同内容的视图，不可漏发）。
 * 字段全列 —— 漏一个上游就等于那个字段的变化永远不下发。
 * `|`/`,` 分隔即可：id 都是 `warrior.sword_shield` 这类不含分隔符的词法。
 */
const equipFingerprint = (
  e: CombatEntity,
  l: { spareWeapons: readonly unknown[]; spareArmors: readonly unknown[];
       consumables: readonly unknown[] } | undefined,
  swap: { kind: SwapKind; endsAt: number } | undefined,
): string =>
  `${e.weaponId}|${e.armorId}` +
  `|${l ? l.spareWeapons.join(',') : ''}|${l ? l.spareArmors.join(',') : ''}` +
  `|${l ? l.consumables.join(',') : ''}` +
  `|${swap ? `${swap.kind},${swap.endsAt}` : ''}`;

/**
 * 实体**静态块**的指纹（W24，扩自 W26 那条只盯 maxHealth 的判据）。
 *
 * 覆盖 `staticsOf()` 投影出去的每一项 —— 名字（顶替人机后要改）、队伍、
 * 职业与资源上限（下一次复活换职业时整块变）、生命上限（熊形态）。
 * ★ 字段全列：漏一个就等于那一项的变化**永远不下发**，而快照里的
 *   动态量仍然是对的，所以不会有任何一层报错（W26 的教训）。
 * ★ `|` 分隔即可：名字来自 `JoinRoom`（codec 限 1–24 字符），撞不出歧义 ——
 *   就算撞了，最坏是少发一次同内容的静态块，不是发错。
 */
const staticsFingerprint = (e: CombatEntity): string =>
  `${e.name}|${e.team}|${e.classId}|${e.maxHealth}|` +
  [...e.maxResources].map(([r, v]) => `${r}:${v}`).join(',');

/**
 * 10.5 的中断原因转成给玩家看的话。
 * ★ `taken` 与其余四条要分得开 —— 「被别人抢走了」是玩法信息（下次要抢快点），
 *   「你动了」是操作信息（下次站住别动）。混成一句「拾取失败」两条都丢了。
 */
const pickupFailText = (reason: string): string => {
  switch (reason) {
    case 'taken': return '被别人抢先拿走了';
    case 'moved': return '移动中断了拾取';
    case 'stunned': return '被控制打断了拾取';
    case 'forcedMove': return '被强制位移打断了拾取';
    case 'death': return '死亡中断了拾取';
    default: return '拾取被取消';
  }
};

/** `CombatEvent.auraRemoved.reason` 是自由字符串，协议那边是闭集 */
const removalReason = (
  reason: string,
): 'expired' | 'dispelled' | 'broken' | 'cancelled' | 'shieldBroken' | 'trinket' => {
  switch (reason) {
    case 'dispelled': case 'broken': case 'cancelled': case 'shieldBroken': case 'trinket':
      return reason;
    default:
      return 'expired';
  }
};

/**
 * 一条消息里提到的全部实体 id。可见性判断用。
 * ★ `Damage` / `Heal` / `CastResolved` 不走这里 —— 它们在 `redactFor()`
 *   有专门的**抹而不丢**分支；这里登记的是「有一个看不见就整条丢」的消息。
 *
 * ★★ **switch 必须穷尽**（`satisfies never`，与 codec.ts 同款）——
 *   此前是 `default: return []` 的 fail-open：新增一条带 EntityId 的
 *   服务器消息而忘了登记，`redactFor` 会**原样放行**，静默泄露实体 id，
 *   而且没有任何测试站在这个断点上（技术债总账 A7）。
 *   现在新增消息类型不在这里表态就**编译不过** —— 归类是强制的、显眼的。
 */
export const referencedEntities = (msg: ServerMessage): EntityId[] => {
  switch (msg.t) {
    // ── 走 dispatch() 广播的事件消息：引用的实体逐字段登记 ──────
    // ★ S7：AuraApplied 现在有可空 sourceId。redactFor 有它的专门分支（抹 id +
    //   掩 auraId），这里登记 sourceId 是**兜底**：万一那个分支被删，这里会因
    //   sourceId 不可见而整条丢（过严但安全），不会漏出 `rogue.rupture`
    case 'AuraApplied':
      return msg.sourceId !== undefined ? [msg.targetId, msg.sourceId] : [msg.targetId];
    case 'AuraRemoved': return [msg.targetId];
    /**
     * ★ A9 起 `Death` 也有自己的**抹而不丢**分支（见 `redactFor`），正常
     *   走不到这里。killerId 的登记因此降级为**兜底**，与 AuraApplied /
     *   BossEvent 同一个理由：万一那个分支被删，最坏是过严（少一条死讯），
     *   不会漏出一个潜行者的 id —— fail-closed 不放宽。
     */
    case 'Death': return msg.killerId !== undefined ? [msg.entityId, msg.killerId] : [msg.entityId];
    case 'CastStarted': return [msg.casterId];
    case 'CastInterrupted': return [msg.casterId];
    case 'FlagEvent': return msg.carrierId !== undefined ? [msg.carrierId] : [];
    // P13：击杀播报只有名字没有 id —— 全场公告,零实体引用（类型注释的 ★★）
    case 'FfaKill': return [];
    /**
     * ★ BOSS 播报有自己的**抹而不丢**分支（见 `redactFor`），正常走不到这里。
     *   登记 `entityId` 是兜底：BOSS 从不潜行、被击杀时已离场，所以这条
     *   兜底永远为真 —— 万一那个分支被删，最坏结果是过严（少一条播报），
     *   不会漏出一个潜行者的 id。与 `AuraApplied` 的兜底同一个理由。
     */
    case 'BossEvent': return [msg.entityId];
    // ── 抹而不丢（redactFor 的专门分支，永远到不了这里）────────
    case 'Damage': case 'Heal': case 'CastResolved': return [];
    // ── 不走 dispatch() 的消息：私信（CastFailed/ArsenalOffer/PickupResult/
    //    FfaShop/Rejected/Welcome/MatchStart）、按接收者构建（Snapshot/
    //    EntityLoadouts —— 它们若出现在 dispatch 里本身就是接线错误，
    //    可见性由 buildSnapshot 与 broadcastSnapshots 的同一张可见实体表保证）、
    //    赛后/房间广播（RoomState/RoundEnd/MatchEnd/MatchStats/Peer*，
    //    对局结束或房间阶段没有需要瞒的实体）──────────────────
    //    ★ P13 FfaShop 归在私信一列：sendShop 直发 session，形状里也没有实体 id
    //    ★ X21 CastQueueExpired 同样归私信：直发按键者的 session，
    //      形状里只有 skillId 与 waited，零实体引用
    case 'Welcome': case 'QueueStatus': case 'RoomState': case 'RoomList':
    case 'MatchStart': case 'Snapshot':
    case 'EntityMeta': case 'FfaShop':
    case 'CastFailed': case 'CastQueueExpired': case 'ArsenalOffer': case 'PickupResult':
    case 'RoundEnd': case 'MatchEnd': case 'MatchStats': case 'Rejected':
    case 'PeerDisconnected': case 'PeerReconnected': case 'PeerEliminated':
      return [];
    default:
      // ★ 走到这里说明协议加了新消息却没在上面归类 —— 编译期就该红
      return [msg satisfies never];
  }
};
