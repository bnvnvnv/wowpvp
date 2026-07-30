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
  SIM,
  assertNoHiddenEntities,
  buildSnapshot,
  isVisibleTo,
  tickDepsOf,
  tickWorld,
  type CastIntent,
  type CombatEntity,
  type CombatEvent,
  type EntityId,
  type Match,
  type MovementInput,
  type ServerMessage,
  type TeamId,
} from '@wowpvp/shared';

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
}

export class MatchLoop {
  private timer?: ReturnType<typeof setInterval>;
  private accumulator = 0;
  private lastRealMs = 0;
  private ended = false;
  tick = 0;

  /** 本 tick 收到的技能请求。每 tick 消费后清空 */
  private readonly pendingCasts = new Map<EntityId, CastIntent>();

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

    const inputs = this.collectInputs();
    const result = tickWorld(
      tickDepsOf(this.match, inputs, this.pendingCasts),
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
        onEffects: (events) => { for (const ev of events) this.pushEvent(outbound, ev); },
      },
    );
    this.pendingCasts.clear();

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
      // ⚠️ 只用最新一条的方向 —— 原因与代价见 Session.inputQueue 的注释
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
        });
        break;
      case 'heal':
        out.push({
          t: 'Heal', sourceId: ev.sourceId, targetId: ev.targetId,
          amount: ev.amount, overheal: ev.overheal,
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
        if (this.leaksTo(msg, viewer)) continue;
        s.send(msg);
      }
    }
  }

  private leaksTo(msg: ServerMessage, viewer: CombatEntity): boolean {
    for (const id of referencedEntities(msg)) {
      const e = this.match.world.entities.get(id);
      if (!e) continue;
      if (!isVisibleTo(e, viewer, this.match.ctf ? { ctf: this.match.ctf.state } : undefined)) {
        return true;
      }
    }
    return false;
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
      ...(m.ctf ? { ctf: m.ctf.state } : {}),
    };

    for (const s of this.deps.sessions()) {
      const viewer = this.viewerOf(s.playerId);
      if (!viewer) continue;
      const snapshot = buildSnapshot(snapDeps, viewer);
      assertNoHiddenEntities(
        snapshot, m.world, viewer,
        m.ctf ? { ctf: m.ctf.state } : undefined,
      );
      s.send({
        t: 'Snapshot',
        tick: snapshot.tick,
        time: m.world.time,
        ackSeq: s.ackSeq,
        you: snapshot.you,
        entities: snapshot.entities,
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
    const winner = outcome.winner ?? 'draw';
    this.deps.onEnd(winner);
  }

  // ── 小工具 ────────────────────────────────────────────────────

  private viewerOf(playerId: string): CombatEntity | undefined {
    const id = this.match.entityOf.get(playerId);
    return id === undefined ? undefined : this.match.world.entities.get(id);
  }

  private sessionOfEntity(entityId: EntityId): Session | undefined {
    const playerId = this.match.playerOf.get(entityId);
    if (playerId === undefined) return undefined;
    for (const s of this.deps.sessions()) if (s.playerId === playerId) return s;
    return undefined;
  }
}

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

/** 一条消息里提到的全部实体 id。可见性判断用 */
const referencedEntities = (msg: ServerMessage): EntityId[] => {
  switch (msg.t) {
    case 'Damage': case 'Heal': return [msg.sourceId, msg.targetId];
    case 'AuraApplied': case 'AuraRemoved': return [msg.targetId];
    case 'Death': return msg.killerId !== undefined ? [msg.entityId, msg.killerId] : [msg.entityId];
    case 'CastStarted': return [msg.casterId];
    case 'CastInterrupted': return [msg.casterId];
    case 'FlagEvent': return msg.carrierId !== undefined ? [msg.carrierId] : [];
    default: return [];
  }
};
