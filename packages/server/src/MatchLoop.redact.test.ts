/**
 * A9：`Death` 事件的**抹而不丢**（与 `Damage` 同口径）。
 *
 * ★★ **为什么必须有这个文件：**
 *
 *   `redactFor` 此前把 `Death` 交给 default 分支的「引用了不可见实体就整条
 *   丢弃」。于是队友被一个**未被发现的潜行者**收掉时，全队一条 Death 都
 *   收不到 —— 客户端只能等下一帧快照的 `alive:false` 自己推断出「他没了」，
 *   击杀播报、死亡音效、镜头切观战全部无声失踪。这与偏差 #4（伤害数字
 *   被整条丢弃）是同一个家族，`Damage` 早就改成「发但抹 sourceId」，
 *   `Death` 一直没跟上。
 *
 * ★ 载体照 `verify-m10` 1c 的选法：**挂着 DoT 的潜行者**。主动攻击会当场
 *   现身（`breakStealthOf`），周期跳不破施加者的潜行 —— 所以「凶手至死
 *   不可见」这件事在真实规则下只有这一种形态，测试也就只能用它。
 */

import { describe, expect, it } from 'vitest';
import {
  ArenaPreset, GameMode, School, Slot,
  applyAura, arena2v2, asClassId, createMatch, createRoom, joinRoom,
  type AuraDef, type CombatEntity, type Match, type MapId, type ServerMessage,
} from '@wowpvp/shared';

import { MatchLoop } from './MatchLoop.js';
import { createReconnectRegistry } from './room/reconnect.js';
import type { Session } from './room/Session.js';

/**
 * 最小潜行/持续伤害光环。★ 不借职业技能数据 —— 这里验的是裁剪，
 * 数值跟着某个技能漂会让失败原因变得不可读（与 verify-m10 同一理由）。
 */
const STEALTH_AURA = {
  id: 'redact.stealth', name: '测试用潜行', duration: 999, kind: 'buff',
  flags: { stealthed: true },
} as unknown as AuraDef;

const DOT_AURA = {
  id: 'redact.dot', name: '测试用持续伤害', duration: 999, kind: 'debuff',
  periodic: { interval: 0.2, effects: [{ kind: 'damage', school: School.Shadow, amount: { flat: 400 } }] },
} as unknown as AuraDef;

/** 只造 MatchLoop 会读的那几个字段；`sendRaw` 是 dispatch 的真实出口 */
const fakeSession = (playerId: string, raw: string[]): Session =>
  ({
    playerId,
    isBot: false,
    takeInputs: () => [],
    send: () => { /* 私信不在本文件范围 */ },
    sendRaw: (s: string) => raw.push(s),
    reject: () => { /* 不看拒绝 */ },
  } as unknown as Session);

interface Rig {
  match: Match;
  loop: MatchLoop;
  /** 观察者（与死者同队、看不见凶手）收到的原始帧 */
  seerRaw: string[];
  /** 死者本人收到的原始帧 —— 他与凶手的可见性关系和观察者一致 */
  victimRaw: string[];
  /** 凶手队友收到的原始帧 —— 队友的潜行对己方可见，用来证明「丢弃」不是全丢 */
  allyRaw: string[];
}

const rig = (): Rig => {
  const room = createRoom('r', 'ghost', {
    mode: GameMode.Arena2v2,
    mapId: arena2v2.id as MapId,
    preset: ArenaPreset.Classic,
    roundsToWin: 1,
    allowUnbalanced: true,
    fillWithBots: false,
  });
  for (const [id, slot] of [
    ['ghost', Slot.Red], ['ally', Slot.Red],
    ['victim', Slot.Blue], ['seer', Slot.Blue],
  ] as const) {
    const p = joinRoom(room, id, id);
    p.slot = slot;
    p.classId = asClassId('mage');
    p.ready = true;
  }
  const match = createMatch(room, arena2v2);
  const seerRaw: string[] = [];
  const victimRaw: string[] = [];
  const allyRaw: string[] = [];
  const sessions = [
    fakeSession('ghost', []), fakeSession('ally', allyRaw),
    fakeSession('victim', victimRaw), fakeSession('seer', seerRaw),
  ];
  const loop = new MatchLoop(match, {
    sessions: () => sessions,
    reconnects: createReconnectRegistry(),
    onEliminate: () => { /* 本文件不关心 */ },
    onEnd: () => { /* 本文件不关心 */ },
  });
  return { match, loop, seerRaw, victimRaw, allyRaw };
};

const entityOf = (m: Match, playerId: string): CombatEntity =>
  m.world.entities.get(m.entityOf.get(playerId)!)!;

/**
 * 从原始帧里挑出 Death 消息（dispatch 走 sendRaw，到手的只有字符串）。
 * ★ 先按字符串筛再 parse：快照帧是模板拼接出来的，本文件的假会话没有
 *   `ackSeq`，那些帧不是合法 JSON —— 与本文件要验的东西无关，别去 parse 它。
 */
const deathsIn = (raw: readonly string[]): Extract<ServerMessage, { t: 'Death' }>[] =>
  raw
    .filter((s) => s.startsWith('{"t":"Death"'))
    .map((s) => JSON.parse(s) as Extract<ServerMessage, { t: 'Death' }>);

/**
 * 让 `killer` 用一条 DoT 把 `victim` 磨死，返回观察者与死者收到的帧。
 * ★ 血量压到 1 是为了少推几个 tick，不是玩法数值。
 */
const dotToDeath = (r: Rig, killer: CombatEntity, victim: CombatEntity): void => {
  victim.health = 1;
  applyAura(r.match.auras, victim, DOT_AURA, killer.id, r.match.world.time);
  for (let i = 0; i < 20 && victim.alive; i++) r.loop.advance();
};

describe('A9：Death 抹凶手而不丢死讯', () => {
  it('★★ 凶手对接收者不可见 → 仍然收到 Death，但 killerId 被抹掉', () => {
    const r = rig();
    const ghost = entityOf(r.match, 'ghost');
    const victim = entityOf(r.match, 'victim');

    applyAura(r.match.auras, ghost, STEALTH_AURA, ghost.id, r.match.world.time);
    r.loop.advance();                 // 让潜行光环派生进 flags
    expect(ghost.flags.stealthed, '潜行没派生进 flags —— 后面的断言会平凡成立').toBe(true);
    r.seerRaw.length = 0;
    r.victimRaw.length = 0;

    dotToDeath(r, ghost, victim);
    expect(victim.alive, 'DoT 没把人磨死 —— 这条测试什么都没验到').toBe(false);

    const seen = deathsIn(r.seerRaw);
    expect(seen.length, '队友被看不见的人杀死 → 一条死讯都没收到（A9 原症状）')
      .toBeGreaterThan(0);
    for (const d of seen) {
      expect(d.entityId).toBe(victim.id);
      // ★ 死讯照发，凶手不点名 —— 验收 #5 的红线不因 A9 放宽一寸
      expect(d.killerId, '把潜行者的 id 顺着 Death 泄露出去了').toBeUndefined();
    }
    // 字节级：整条帧里不该出现凶手的 id
    expect(
      r.seerRaw.some((f) => f.startsWith('{"t":"Death"') && f.includes(`"killerId":${ghost.id as number}`)),
      '原始帧里带着潜行者 killerId',
    ).toBe(false);

    // 死者本人同样要收到（死亡遮罩/观战切换读的就是它）
    expect(deathsIn(r.victimRaw).length).toBeGreaterThan(0);
  });

  it('★ 凶手看得见 → Death 原样下发，带 killerId', () => {
    const r = rig();
    const ghost = entityOf(r.match, 'ghost');
    const victim = entityOf(r.match, 'victim');

    r.loop.advance();
    r.seerRaw.length = 0;
    dotToDeath(r, ghost, victim);
    expect(victim.alive).toBe(false);

    const seen = deathsIn(r.seerRaw);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d.killerId === ghost.id), '凶手站在场上却不报名字').toBe(true);
  });

  /**
   * ★ 死者仍然不可见的唯一现实载体是**弃权判死**（11.5：掉线宽限过期）——
   *   伤害致死走不到这里，因为 `dealDamage` 会先解除**受害者**的潜行
   *   （combat.ts「挨了一下就是挨了一下」），死的那一刻他已经现身了。
   *   弃权不经过伤害，潜行原样挂着 —— 于是「一个从未进过敌方视野的人
   *   悄悄出局」这件事必须对敌方完全静默，否则等于用 Death 点名。
   */
  it('★ 死者本人对接收者不可见 → 整条丢弃（entityId 没有可抹的余地）', () => {
    const r = rig();
    const ally = entityOf(r.match, 'ally');

    applyAura(r.match.auras, ally, STEALTH_AURA, ally.id, r.match.world.time);
    r.loop.advance();
    expect(ally.flags.stealthed).toBe(true);
    r.seerRaw.length = 0;
    r.allyRaw.length = 0;

    r.loop.forfeit('ally');            // 11.5 弃权判死：不经伤害，潜行不破
    r.loop.advance();
    expect(ally.alive).toBe(false);
    expect(ally.flags.stealthed, '弃权把潜行也解了 —— 这条测试就白验了').toBe(true);

    expect(
      deathsIn(r.seerRaw).some((d) => d.entityId === ally.id),
      '一个从未出现在蓝方视野里的实体，靠 Death 暴露了自己的 id',
    ).toBe(false);
    // ★ 反证「不是一条都没发」：队友的潜行对己方可见，红队照收死讯
    expect(
      deathsIn(r.allyRaw).some((d) => d.entityId === ally.id),
      '连他自己都没收到死讯 —— 上一条断言平凡成立',
    ).toBe(true);
  });
});
