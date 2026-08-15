/**
 * A5：**转身令牌桶**（技术债总账 A5 —— spinbot）。
 *
 * ★★ **这个文件钉的是一条信任边界，不是一条模拟规则。**
 *
 *   规则本身（怎么钳、为什么是令牌桶而不是每 tick 硬上限）在
 *   `shared/net/turnBudget.ts`，服务器这一侧的接线理由在 `turnRate.ts`；
 *   这里只问服务器**有没有在采信客户端朝向的那一刻真的钳**，以及那条
 *   **人机豁免**有没有反向踩到配平红线（人机的瞬间转身必须逐位照旧 ——
 *   它一慢，朝向门禁/背刺判定/自动攻击正面弧全跟着变，balance 当场漂移）。
 *
 * ★★ **令牌桶有两条线，两条都要钉：**
 *     · **瞬时**（桶容量）：桶满时一次 180° 甩镜头必须原样过 —— 钳到真人
 *       就是 `combat.ts` 说的那种「我明明面向他，技能却说我没面向」。
 *     · **持续**（注入率）：桶抽干之后每 tick 只剩一份 36° —— 这才是挡
 *       spinbot 的那条线。所以下面凡是验「钳」的用例都先 `drain()`。
 *   另有第三条同等重要的：**预算的时钟是 tick 不是消息到达**（低帧客户端
 *   成对投递的那条回归用例）。
 *
 * ★ 「移动 yaw」与「CastRequest.facing」是两条**不同的**采信路径
 *   （前者在 `collectInputs`，后者在 `requestCast`），所以两条各测一遍：
 *   同族只修一处、另一处原样翻车，本仓库已经栽过 9 次。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, Slot,
  arena2v2, asClassId, asSkillId, createMatch, createRoom, joinRoom, wrapAngle,
  type InputMessage, type Match, type MapId, type ServerMessage,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { MAX_YAW_STEP_PER_TICK, TURN_BURST_SERVER_RAD } from './turnRate.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

const ICE_LANCE = asSkillId('mage.ice_lance');

/** 一条移动输入。★ `dt` 服务器根本不读（用 `SIM.TICK_DT`），这里只为形状完整 */
const input = (yaw: number, opts: { dt?: number; forward?: number } = {}): InputMessage => ({
  t: 'Input',
  seq: 1,
  dt: opts.dt ?? 0.05,
  forward: opts.forward ?? 0,
  strafe: 0,
  characterYaw: yaw,
  jump: false,
});

/**
 * 只造 MatchLoop 会读的那几个字段。
 * ★ `isBot` 做成**可写**的：人机把席位交还给真人（重连/中途顶替）在真实路径上
 *   是换一条会话，而这里翻一个布尔就够 —— 被测的是 `MatchLoop` 每 tick
 *   重新问一次 `s.isBot` 这个事实。
 */
interface Fake { session: Session; queue: InputMessage[]; isBot: boolean }
const fakeSession = (playerId: string, isBot: boolean): Fake => {
  const queue: InputMessage[] = [];
  const fake = {
    playerId,
    isBot,
    queue,
    takeInputs: () => queue.splice(0, queue.length),
    send: (_m: ServerMessage) => { /* 本文件不看消息 */ },
    sendRaw: () => { /* 本文件不看消息 */ },
    reject: () => { /* 本文件不看消息 */ },
  };
  return fake as unknown as Fake & { session: Session };
};

interface Rig { match: Match; loop: MatchLoop; human: Fake; bot: Fake }

/** 一局 2v2：human 是真人席位，botty 是人机席位 */
const rig = (): Rig => {
  const room = createRoom('r', 'human', {
    mode: GameMode.Arena2v2,
    mapId: arena2v2.id as MapId,
    preset: ArenaPreset.Classic,
    roundsToWin: 1,
    allowUnbalanced: true,
    fillWithBots: false,
  });
  for (const [id, slot] of [['human', Slot.Red], ['botty', Slot.Blue]] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    p.classId = asClassId('mage');
    p.ready = true;
  }
  const match = createMatch(room, arena2v2);
  const human = fakeSession('human', false);
  const bot = fakeSession('botty', true);
  const loop = new MatchLoop(match, {
    sessions: () => [human, bot] as unknown as Session[],
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 本文件不关心 */ },
    onEnd: () => { /* 本文件不关心 */ },
  });
  return { match, loop, human, bot };
};

const entityOf = (m: Match, playerId: string) =>
  m.world.entities.get(m.entityOf.get(playerId)!)!;

/**
 * 让这个实体**退出移动积分**（`tick.ts` 第 2 步只推进 `movement` 里有条目的）。
 *
 * ★ 为什么测 `facing` 要用它：`CastRequest.facing` 在第 1 步写进 `caster.yaw`，
 *   而第 2 步的移动积分马上又用移动 yaw 把它覆盖回去 —— 这正是 spinbot 那条
 *   路径「对手一帧都看不到」的原因，也让被采信的 facing 在正常路径上无法直接
 *   读出来。拔掉移动条目，第 1 步写的值就留在 `e.yaw` 上可断言。
 */
const freezeMovement = (m: Match, playerId: string): void => {
  m.movement.delete(m.entityOf.get(playerId)!);
};

/**
 * 把这个席位的桶**抽干**，并留下基准。
 *
 * ★★ 令牌桶下「钳」只在桶空之后才是每 tick 36°；桶满时一次 180° 是**该**
 *   原样过的（真人转身看背后）。所以凡是验持续速率那条线的用例都要先抽干,
 *   否则钉住的是「桶初值」这个与规则无关的东西。
 * ★ 抽干的办法就是 spinbot 本人的行为：连续几个 tick 每次都要求转满 180°。
 *   到第 4 个 tick 令牌必然见底，之后每 tick 只花得动注入的那一份。
 */
const drain = (r: Rig, playerId = 'human'): void => {
  const fake = playerId === 'human' ? r.human : r.bot;
  for (let i = 0; i < 8; i++) {
    fake.queue.push(input(wrapAngle(entityOf(r.match, playerId).yaw + Math.PI)));
    r.loop.advance();
  }
};

describe('A5 移动 yaw —— 采信时的转身速率上限', () => {
  it('正常转速原样过（逐位不变，一个浮点尾数都不动）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    // 每 tick 转 20°（0.349 rad），远在 36° 的预算之内
    const step = 20 * (Math.PI / 180);
    let want = 0;
    for (let i = 0; i < 6; i++) {
      human.queue.push(input(want));
      loop.advance();
      expect(me.yaw, `第 ${i} tick 的合法转身被钳了`).toBe(want);
      want = wrapAngle(want + step);
    }
  });

  it('★★ 桶满时一次 180° 甩镜头原样过（真人转身看背后不能被误伤）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    // 先立一个基准：朝 0
    human.queue.push(input(0));
    loop.advance();
    expect(me.yaw).toBe(0);

    /**
     * ★★ 指针锁定（X15）之后这一下是 100-200ms 里一口气拖完的，瞬时角速度
     *   上千度每秒 —— 任何一个固定角速度上限都会钳到它。桶容量存在的理由
     *   就是这条用例。
     */
    human.queue.push(input(Math.PI));
    loop.advance();
    expect(me.yaw, '桶满时的一次 180° 甩镜头被钳了 —— 误伤真人').toBe(Math.PI);
  });

  it('★★ 桶抽干之后 180° 被钳成多 tick 推进（spinbot 那一下转不动）', () => {
    const r = rig();
    const { match, loop, human } = r;
    const me = entityOf(match, 'human');
    drain(r);

    const from = me.yaw;
    // 桶已空：这一 tick 只花得动注入的那一份
    human.queue.push(input(wrapAngle(from + Math.PI)));
    loop.advance();
    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      '持续满速旋转时单 tick 仍然转过了一份以上的令牌 —— 注入率那条线没接上',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);

    // 但意图没被丢掉：继续按注入率推进，几个 tick 之内到位（钳制 ≠ 拒绝）
    const want = wrapAngle(from + Math.PI);
    let ticks = 1;
    let prev = me.yaw;
    while (Math.abs(wrapAngle(me.yaw - want)) > 1e-9 && ticks < 10) {
      human.queue.push(input(want));
      loop.advance();
      expect(
        Math.abs(wrapAngle(me.yaw - prev)),
        '某一 tick 转过了注入量 —— 持续速率被绕过',
      ).toBeLessThanOrEqual(MAX_YAW_STEP_PER_TICK + 1e-9);
      prev = me.yaw;
      ticks++;
    }
    expect(me.yaw).toBeCloseTo(want, 9);
    // 720°/s ⇒ 180° 要 5 个 tick（250ms）。多一个都说明注入量算错了
    expect(ticks).toBe(5);
  });

  it('★★ 人机豁免：同样的单 tick 180° 原样生效（配平红线）', () => {
    const { match, loop, bot } = rig();
    const botty = entityOf(match, 'botty');

    bot.queue.push(input(0));
    loop.advance();
    expect(botty.yaw).toBe(0);

    bot.queue.push(input(Math.PI));
    loop.advance();
    expect(botty.yaw, '人机的瞬间转身被钳了 —— 朝向门禁与背刺判定会跟着变，balance 漂移').toBe(Math.PI);
  });

  it('第一条朝向原样采信（开局 / 中途加入 / 重连后没有可比的基准）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    // 出生朝向与他此刻想朝的方向无关，第一条不该被「从出生朝向慢慢转过去」
    human.queue.push(input(-2.9));
    loop.advance();
    expect(me.yaw).toBe(-2.9);
  });

  it('★★ 人机席位不留基准：W24 中途加入顶替它时，第一条原样采信', () => {
    const { match, loop, bot } = rig();
    const botty = entityOf(match, 'botty');

    // 人机在这个席位上转了几圈（豁免 ⇒ 一次都没往 trustedYaw 里写）
    for (const yaw of [0, Math.PI, -1.2, 2.7]) {
      bot.queue.push(input(yaw));
      loop.advance();
    }
    expect(botty.yaw).toBe(2.7);

    // 真人坐进来 —— 他的镜头与人机刚才转到哪毫无关系，第一条不该被钳
    bot.isBot = false;
    bot.queue.push(input(-2.7));
    loop.advance();
    expect(botty.yaw, '顶替人机席位的真人被人机转出来的陈旧基准钳住了').toBe(-2.7);
  });

  it('跨 ±π 边界按最短弧算（172° → -172° 只是 16°，不是 344°）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    human.queue.push(input(3.0));
    loop.advance();
    human.queue.push(input(-3.0));
    loop.advance();
    expect(me.yaw, '跨边界的小幅转身被当成绕远路钳掉了').toBe(-3.0);
  });

  it('★★ 攒一堆输入一次性发也只给一份令牌（按条数给预算 = 5×36° 的瞬转）', () => {
    const r = rig();
    const { match, loop, human } = r;
    const me = entityOf(match, 'human');
    drain(r);
    const from = me.yaw;

    // 一个 tick 里塞 5 条，每条各转 36°：合起来正好 180°
    for (let i = 1; i <= 5; i++) human.queue.push(input(wrapAngle(from + i * MAX_YAW_STEP_PER_TICK)));
    loop.advance();
    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      '预算跟着输入条数走了 —— 攒 5 条发一次就是瞬转 180°',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);
  });

  it('★★ 低帧客户端的成对投递不被腰斩（预算的时钟是 tick，不是消息到达）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    /**
     * ★★ 这条钉的是修复前的实测翻车：`GameLoop` 一帧补两个固定步、每步发一条
     *   `Input`，帧率低于 20fps 时两条背靠背落进同一个服务器 tick，下一个
     *   tick 是空的。旧写法「这一 tick 没有 Input 就 continue」既不注入也不
     *   推进基准，于是有效上限被腰斩成 360°/s ——
     *   **同样 600°/s 的转身，客户端转了 570°、服务器只转了 330°**，
     *   而且持续转身期间永远追不齐（`turnRate.ts` 的 ★★ 记着这条实测）。
     * ★ 600°/s 低于 720°/s 的注入率，所以正确的答案是**一度都不落后**。
     */
    const perStep = 600 * (Math.PI / 180) * 0.05; // 每个固定步转 30°
    let want = 0;
    let last = 0;
    let turned = 0;
    let prev = 0;
    for (let tick = 0; tick < 20; tick++) {
      if (tick % 2 === 0) {
        for (let k = 0; k < 2; k++) {
          want += perStep;
          human.queue.push(input(wrapAngle(want)));
        }
        last = want;
      }
      loop.advance();
      turned += Math.abs(wrapAngle(me.yaw - prev));
      prev = me.yaw;
    }
    expect(turned, '成对投递被当成「只有一半的 tick 有预算」——低帧玩家被单方面限速').toBeCloseTo(last, 6);
    expect(me.yaw, '服务器的朝向落后于客户端最后一次主张').toBeCloseTo(wrapAngle(last), 9);
  });

  it('★★ 停发一秒攒不出一秒的预算（空 tick 的令牌封顶在桶容量）', () => {
    const r = rig();
    const { match, loop, human } = r;
    const me = entityOf(match, 'human');
    drain(r);

    // 停发 20 个 tick（1 秒）。不封顶的话就是 720° 的预算一次性到账
    for (let i = 0; i < 20; i++) loop.advance();

    /**
     * ★ 单条 `Input` 转不出超过 180°（最短弧的上限就是 π），所以封顶只能从
     *   **连续几个 tick 的总转角**上看出来：封顶后是「桶容量 + 这几 tick 的
     *   注入量」，不封顶则是每 tick 都能转满 180°。
     */
    let turned = 0;
    let prev = me.yaw;
    const TICKS = 3;
    for (let i = 0; i < TICKS; i++) {
      human.queue.push(input(wrapAngle(prev + Math.PI)));
      loop.advance();
      turned += Math.abs(wrapAngle(me.yaw - prev));
      prev = me.yaw;
    }
    expect(turned, '停发换来了超过桶容量的转身 —— 封顶没生效').toBeLessThanOrEqual(
      TURN_BURST_SERVER_RAD + TICKS * MAX_YAW_STEP_PER_TICK + 1e-9,
    );
    // 桶确实攒到了满（不是「空 tick 什么都不给」那种另一个方向的错）
    expect(turned, '空 tick 一点令牌都没攒').toBeGreaterThan(TURN_BURST_SERVER_RAD);
  });

  it('★ 高延迟补发（一条 Input 带 dt=0.25）不误伤：预算内原样采信，输入照常消费', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    human.queue.push(input(0, { forward: 1 }));
    loop.advance();

    // 卡了 5 个 tick 之后补上来的那一条：dt 顶格 0.25，转角在预算内
    const want = 0.5;
    human.queue.push(input(want, { dt: 0.25, forward: 1 }));
    loop.advance();

    expect(me.yaw, 'dt 大的那条被当成可疑输入钳/丢了').toBe(want);
    // 「不误伤」不只是朝向：这条输入本身照常驱动移动，不橡皮筋
    for (let i = 0; i < 4; i++) {
      human.queue.push(input(want, { forward: 1 }));
      loop.advance();
    }
    expect(match.movement.get(me.id)!.lastHorizontalDistance).toBeGreaterThan(0);
  });
});

describe('A5 CastRequest.facing —— 与移动 yaw 同一把尺', () => {
  it('★★ 超限的 facing 被钳（否则一条 CastRequest 就能瞬间瞄向任意方向）', () => {
    const r = rig();
    const { match, loop } = r;
    const me = entityOf(match, 'human');
    drain(r); // ★ 桶空之后才谈得上「超限」，见文件头 ★★
    const from = me.yaw;

    // 之后拔掉移动条目 —— 让第 1 步写进 e.yaw 的 facing 不被第 2 步覆盖
    freezeMovement(match, 'human');
    loop.requestCast('human', { skillId: ICE_LANCE, facing: wrapAngle(from + Math.PI) });
    loop.advance();

    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      'facing 被无条件采信 —— A5 只修了移动那一半',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);
  });

  it('★★ 同一 tick 连发多条 CastRequest 不累加（每条都拿同一个起始账本钳）', () => {
    const r = rig();
    const { match, loop } = r;
    const me = entityOf(match, 'human');
    drain(r);
    const from = me.yaw;
    freezeMovement(match, 'human');

    for (let i = 0; i < 20; i++) {
      loop.requestCast('human', { skillId: ICE_LANCE, facing: wrapAngle(from + Math.PI) });
    }
    loop.advance();
    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      '20 条 CastRequest 累加出了 20 份令牌',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);
  });

  it('★ 只发 facing 不发 Input 也推不快：账本跟着被采信的 facing 走', () => {
    const r = rig();
    const { match, loop } = r;
    const me = entityOf(match, 'human');
    drain(r);
    const from = me.yaw;
    freezeMovement(match, 'human');
    const want = wrapAngle(from + Math.PI);

    // 第一 tick：没有 Input，只有一条 facing → 基准推进到 1 份令牌处、桶被扣掉
    loop.requestCast('human', { skillId: ICE_LANCE, facing: want });
    loop.advance();
    expect(Math.abs(wrapAngle(me.yaw - from))).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);

    // 第二 tick：再来一条 → 只能再走一份。★ 注入的那一份是本来就该有的
    //   （时钟是 tick），要挡的是「基准冻住 ⇒ 每 tick 都从原点再要一份」
    loop.requestCast('human', { skillId: ICE_LANCE, facing: want });
    loop.advance();
    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      '停发 Input 换来了额外的转身预算（基准没跟着 facing 走）',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK * 2, 9);
  });

  it('★★ 人机豁免同样覆盖 facing（BotDriver 每 tick 发的是 facing: self.yaw）', () => {
    const { match, loop, bot } = rig();
    const botty = entityOf(match, 'botty');

    bot.queue.push(input(0));
    loop.advance();
    freezeMovement(match, 'botty');

    loop.requestCast('botty', { skillId: ICE_LANCE, facing: Math.PI });
    loop.advance();
    expect(botty.yaw, '人机的 facing 被钳了 —— 方向技能的落点会变，balance 漂移').toBe(Math.PI);
  });

  it('预算内的 facing 原样过（正常客户端发的就是自己当前的 characterYaw）', () => {
    const { match, loop, human } = rig();
    const me = entityOf(match, 'human');

    human.queue.push(input(0.3));
    loop.advance();
    freezeMovement(match, 'human');

    // 客户端的 CastRequest.facing 与 Input.characterYaw 同源（NetworkScene）
    loop.requestCast('human', { skillId: ICE_LANCE, facing: 0.3 });
    loop.advance();
    expect(me.yaw).toBe(0.3);
  });

  /**
   * ★★ 外部审计问过的边界：会话**首条**消息就是带 facing 的 `CastRequest`
   *   （此前一条 Input 都没发，预算条目还不存在）。
   *
   *   钉两件事：① 这一条按「第一条原样采信」的既定语义过（与上面 Input 路径
   *   的同名用例同一条规则 —— 开局/中途加入/重连没有可比的基准）；
   *   ② 免费额度**终生恰好一次**：`collectInputs` 每 tick 无条件为真人建账
   *   并把 `pendingCasts` 的 facing 记入基准，所以从第二条起就在同一把尺下 ——
   *   「永不发 Input、只发 CastRequest」不构成免费瞄准通道。
   */
  it('★★ 零 Input 开局：首条 CastRequest 按「第一条原样采信」播种，此后逐条受钳', () => {
    const r = rig();
    const { match, loop } = r;
    const me = entityOf(match, 'human');
    freezeMovement(match, 'human');

    // 开局第一条消息（还没有任何 advance 之外的输入）：原样采信 = 播种基准
    loop.requestCast('human', { skillId: ICE_LANCE, facing: 2.5 });
    loop.advance();
    expect(me.yaw, '第一条 facing 不该被「从出生朝向慢慢转过去」').toBe(2.5);

    // 继续只发 CastRequest 把桶抽干（一条 Input 都不发）
    for (let i = 0; i < 8; i++) {
      loop.requestCast('human', { skillId: ICE_LANCE, facing: wrapAngle(me.yaw + Math.PI) });
      loop.advance();
    }

    // 桶空之后：每 tick 只走得动注入的那一份 —— 免费通道不存在
    const from = me.yaw;
    loop.requestCast('human', { skillId: ICE_LANCE, facing: wrapAngle(from + Math.PI) });
    loop.advance();
    expect(
      Math.abs(wrapAngle(me.yaw - from)),
      '零 Input 的会话在首条之后仍未入账 —— CastRequest 成了免费转身通道',
    ).toBeCloseTo(MAX_YAW_STEP_PER_TICK, 9);
  });
});
