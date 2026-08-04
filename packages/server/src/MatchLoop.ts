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
  INTERACT_RANGE,
  SIM,
  SwapKind,
  assertNoHiddenEntities,
  beginFlagInteract,
  beginPickup,
  beginSwap,
  beginSwing,
  buildSnapshot,
  buildSpectatorSnapshot,
  cancelCast,
  cancelFlagInteract,
  chooseFromArmory,
  distance2D,
  getWeapon,
  isVisibleTo,
  listEntities,
  openArmory,
  pickAwards,
  setHardTarget,
  statsRows,
  stopSwing,
  tabTarget,
  tickDepsOf,
  tickWorld,
  toggleFocus,
  type ArsenalChoice,
  type CastIntent,
  type CombatEntity,
  type CombatEvent,
  type EntityId,
  type InteractTarget,
  type Match,
  type MovementInput,
  type ServerMessage,
  type TeamId,
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
  | { t: 'ChooseArsenal'; armoryId: number; choice: ArsenalChoice };

import { takeExpired, type ReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

/**
 * 一次 `pump()` 最多补几个 tick。
 *
 * ★ 防「死亡螺旋」：如果某一帧卡了 2 秒，不补帧就会漂移，补 40 个 tick 又会
 *   让这一帧更卡，于是下一帧要补更多 —— 最终服务器再也追不上。
 *   超出的部分**丢弃**（模拟时间就此落后于真实时间），这是定步长循环的
 *   标准取舍：宁可慢，不可雪崩。
 */
const MAX_CATCHUP_TICKS = 5;

export interface MatchLoopDeps {
  /** 当前**连着**的会话。断线的人不在这里，但他的实体还在世界里（11.5）*/
  sessions: () => Iterable<Session>;
  reconnects: ReconnectRegistry;
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
}

export class MatchLoop {
  private timer?: ReturnType<typeof setInterval>;
  private accumulator = 0;
  private lastRealMs = 0;
  private ended = false;
  tick = 0;

  /** 本 tick 收到的技能请求。每 tick 消费后清空 */
  private readonly pendingCasts = new Map<EntityId, CastIntent>();

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
    if (this.accumulator > maxAccum) this.accumulator = maxAccum;

    while (this.accumulator >= SIM.TICK_DT && !this.ended) {
      this.accumulator -= SIM.TICK_DT;
      this.advance();
    }
  }

  /** 推进恰好一个 tick。★ 测试直接调它，不必真的等墙上时间 */
  advance(): void {
    if (this.ended) return;
    this.tick++;
    const outbound: ServerMessage[] = [];

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
        onEffects: (events) => { for (const ev of events) this.pushEvent(outbound, ev); },
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

    this.settleExpiredReconnects();
    this.dispatch(outbound);
    this.broadcastSnapshots();
    this.checkEnd();
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
       */
      inputs.set(entityId, {
        forward: latest.forward,
        strafe: latest.strafe,
        jump: latest.jump,
        yaw: latest.characterYaw,
      });
    }
    return inputs;
  }

  /** 战斗阶段的技能请求。由 RoomServer 在收到 `CastRequest` 时调用 */
  requestCast(playerId: string, intent: CastIntent): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    // ★ 一个实体一 tick 只有一个请求（后一个覆盖前一个）——
    //   与客户端 CombatDirector.requestCast 同语义
    this.pendingCasts.set(entityId, intent);
  }

  /** 其他战斗指令排队。合法性由 RoomServer 在收到时校验（要能回 Rejected）*/
  enqueue(playerId: string, cmd: MatchCommand): void {
    this.pendingCommands.push({ playerId, cmd });
  }

  /** 10.1：使用消耗品。★ 与施法同样只排意图，结算在 tickWorld 里 */
  requestConsumable(playerId: string, slot: number): void {
    const entityId = this.match.entityOf.get(playerId);
    if (entityId === undefined) return;
    this.pendingConsumables.set(entityId, slot);
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

    for (const { playerId, cmd } of commands) {
      const e = this.viewerOf(playerId);
      if (!e) continue;

      switch (cmd.t) {
        case 'SetTarget':
          if (cmd.slot === 'focus') toggleFocus(this.match.world, e, cmd.entityId ?? undefined);
          else setHardTarget(this.match.world, e, cmd.entityId ?? undefined);
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
   * ★ 试验场没有这条路径（CombatDirector 不建 SwingStore）—— 141 项验收
   *   的假人不会突然开始白打玩家。
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
        beginSwing(this.match.swings, e.id, now, getWeapon(e.weaponId)?.swingInterval ?? 2);
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
          // crit 条件展开：普通命中不付这个字段的带宽（与事件层同一约定）
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
          t: 'AuraApplied', targetId: ev.targetId, auraId: ev.auraId,
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
    for (const s of this.deps.sessions()) {
      const viewer = this.viewerOf(s.playerId);
      if (!viewer) continue;
      for (const msg of messages) {
        const safe = this.redactFor(msg, viewer);
        if (safe) s.send(safe);
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
  private redactFor(msg: ServerMessage, viewer: CombatEntity): ServerMessage | undefined {
    const ctx = this.match.ctf ? { ctf: this.match.ctf.state } : undefined;
    const visible = (id: EntityId | undefined): boolean => {
      if (id === undefined) return true;
      const e = this.match.world.entities.get(id);
      if (!e) return true; // 已离场的实体不构成泄露
      return isVisibleTo(e, viewer, ctx);
    };

    switch (msg.t) {
      case 'Damage':
      case 'Heal': {
        // 目标看不见 → 这条与他无关，整条不发
        if (!visible(msg.targetId)) return undefined;
        // 来源看不见 → 抹掉来源，数字照发（14.1）
        if (!visible(msg.sourceId)) {
          const { sourceId: _drop, ...rest } = msg;
          return rest as ServerMessage;
        }
        return msg;
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
    };

    for (const s of this.deps.sessions()) {
      const viewer = this.viewerOf(s.playerId);
      if (!viewer) continue;

      /**
       * ★ 11.4：**死了**才走观战视角，活着的人跟随别人就是透视。
       *   `buildSpectatorSnapshot` 复用被跟随者的裁剪结果，所以观战者
       *   看到的不会比那个队友更多；跟随目标不合法时它返回 undefined,
       *   那就退回自己的视角，而不是降级成自由镜头（11.4 明确不允许）。
       */
      const following = !viewer.alive && s.following !== undefined
        ? m.world.entities.get(s.following)
        : undefined;
      const snapshot = (following && buildSpectatorSnapshot(snapDeps, viewer, following))
        ?? buildSnapshot(snapDeps, viewer);

      assertNoHiddenEntities(
        snapshot, m.world, following ?? viewer,
        m.ctf ? { ctf: m.ctf.state } : undefined,
      );
      s.send({
        t: 'Snapshot',
        tick: snapshot.tick,
        time: m.world.time,
        ackSeq: s.ackSeq,
        you: snapshot.you,
        entities: snapshot.entities,
        projectiles: snapshot.projectiles,
        grounds: snapshot.grounds,
        drops: snapshot.drops,
        armories: snapshot.armories,
        match: snapshot.match,
      });
    }
  }

  // ── 结束 ──────────────────────────────────────────────────────

  private checkEnd(): void {
    const outcome = this.match.arena?.outcome;
    if (!outcome) return;
    this.ended = true;
    this.stop();
    this.broadcastStats();
    const winner = outcome.winner ?? 'draw';
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
    for (const s of this.deps.sessions()) s.send(msg);
  }

  // ── 小工具 ────────────────────────────────────────────────────

  private viewerOf(playerId: string): CombatEntity | undefined {
    const id = this.match.entityOf.get(playerId);
    return id === undefined ? undefined : this.match.world.entities.get(id);
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
): 'expired' | 'dispelled' | 'broken' | 'cancelled' | 'shieldBroken' => {
  switch (reason) {
    case 'dispelled': case 'broken': case 'cancelled': case 'shieldBroken':
      return reason;
    default:
      return 'expired';
  }
};

/**
 * 一条消息里提到的全部实体 id。可见性判断用。
 * ★ `Damage` / `Heal` 不在这里 —— 它们走 `redactFor()` 的抹来源分支，
 *   而不是「有一个看不见就整条丢」。
 */
const referencedEntities = (msg: ServerMessage): EntityId[] => {
  switch (msg.t) {
    case 'AuraApplied': case 'AuraRemoved': return [msg.targetId];
    case 'Death': return msg.killerId !== undefined ? [msg.entityId, msg.killerId] : [msg.entityId];
    case 'CastStarted': return [msg.casterId];
    case 'CastInterrupted': return [msg.casterId];
    case 'FlagEvent': return msg.carrierId !== undefined ? [msg.carrierId] : [];
    default: return [];
  }
};
