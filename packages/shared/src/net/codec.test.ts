/**
 * 编解码往返（偏差 #7 新增字段的传输完整性）。
 *
 * codec 本身是 `JSON.stringify` + 形状检查，看似不用测 —— 但 `crit`/`overkill`
 * 是**条件展开**的可选字段，最容易在「换二进制编码」时被漏掉的正是它们。
 * 这两条测试是给未来那次替换准备的回归网，不是给今天的 JSON 写的。
 */

import { describe, expect, it } from 'vitest';
import { asEntityId, asMapId, asSkillId } from '../types/ids.js';
import { School } from '../types/enums.js';
import {
  decodeServerMessage, encodeClientMessage, encodeServerMessage, parseClientMessage,
} from './codec.js';
import type { ServerMessage } from './protocol.js';
import type { EntitySnapshot } from './visibility.js';

/**
 * 一份最小实体快照（P11 波3 wire 形态：共享段，静态块/装备/self 字段
 * 都走别的通道）。★ 只为往返测试拼形状，不代表任何真实局面
 */
const selfEntity: EntitySnapshot = {
  id: asEntityId(1),
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  health: 100,
  resources: { mana: 50 },
  auras: [],
};

describe('★ 服务器消息编解码往返', () => {
  it('★ Damage 带 crit/overkill 时字段无损', () => {
    const msg: ServerMessage = {
      t: 'Damage', sourceId: asEntityId(1), targetId: asEntityId(2),
      amount: 150, school: School.Fire, absorbed: 30, immune: false,
      overkill: 42, crit: true,
    };
    const back = decodeServerMessage(encodeServerMessage(msg));
    expect(back).toEqual(msg);
  });

  it('★ 普通命中不带 crit 字段，往返后也不会凭空出现', () => {
    const msg: ServerMessage = {
      t: 'Damage', targetId: asEntityId(2),
      amount: 100, school: School.Physical, absorbed: 0, immune: false, overkill: 0,
    };
    const back = decodeServerMessage(encodeServerMessage(msg));
    expect(back).toEqual(msg);
    expect(back && 'crit' in back).toBe(false);
  });

  it('★ W17/X3：Damage 带 avoided/skillId 往返无损', () => {
    const msg: ServerMessage = {
      t: 'Damage', sourceId: asEntityId(1), targetId: asEntityId(2),
      amount: 0, school: School.Physical, absorbed: 0, immune: false, overkill: 0,
      avoided: 'parry', skillId: asSkillId('warrior.mortal_strike'),
    };
    expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('★ S7：AuraApplied 带 sourceId 往返无损（redactFor 据它决定掩不掩）', () => {
    const msg: ServerMessage = {
      t: 'AuraApplied', targetId: asEntityId(2), sourceId: asEntityId(1),
      auraId: 'rogue.rupture', duration: 12, stacks: 1,
    };
    expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  /**
   * P10：`focusId` / `gcdUntil` 是新的**条件展开**可选字段（只发给自己、
   * 且只在成立时发）—— 与 crit/overkill 属于同一类，所以进同一张回归网：
   * 换二进制编码时最容易被漏掉的正是「不总是出现」的那几个。
   */
  it('★ P10/波3：self 段的 focusId/gcdUntil 往返无损', () => {
    const msg: ServerMessage = {
      t: 'Snapshot', tick: 3, time: 0.15, ackSeq: 7, you: asEntityId(1),
      // P11 波3：这两个字段住在每人的 self 段（实体段是全队共享的）
      self: { cooldowns: { 'mage.blink': 5 }, focusId: asEntityId(2), gcdUntil: 1.25 },
      entities: [selfEntity],
      projectiles: [], grounds: [], drops: [], armories: [],
      match: { dampening: 0, suddenDeath: false },
    };
    expect(decodeServerMessage(encodeServerMessage(msg))).toEqual(msg);
  });

  it('★ P10：没有焦点 / 不在 GCD 时两个字段不会凭空出现', () => {
    const msg: ServerMessage = {
      t: 'Snapshot', tick: 3, time: 0.15, ackSeq: 7, you: asEntityId(1),
      entities: [selfEntity],
      projectiles: [], grounds: [], drops: [], armories: [],
      match: { dampening: 0, suddenDeath: false },
    };
    const back = decodeServerMessage(encodeServerMessage(msg));
    expect(back).toEqual(msg);
    expect(JSON.stringify(back)).not.toContain('focusId');
    expect(JSON.stringify(back)).not.toContain('gcdUntil');
  });

  it("★ 入站校验不受影响：客户端消息里塞 'crit' 仍被丢弃", () => {
    const r = parseClientMessage(JSON.stringify({
      t: 'Input', seq: 1, dt: 0.05, forward: 1, strafe: 0,
      characterYaw: 0, jump: false, crit: true,
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 多余字段被丢弃，不进 sim —— 与 protocol.test 的 position 注入同一道防线
    expect(Object.keys(r.msg).sort()).toEqual(
      ['characterYaw', 'dt', 'forward', 'jump', 'seq', 'strafe', 't'],
    );
  });
});

describe('W12 SetRoomMode 入站校验', () => {
  it('★ 六个合法模式全部放行（从枚举派生的白名单）', () => {
    for (const mode of ['arena2v2', 'arena3v3', 'arena5v5', 'ctf6v6', 'ctf8v8', 'ctf12v12']) {
      const r = parseClientMessage(JSON.stringify({ t: 'SetRoomMode', mode }));
      expect(r.ok, `模式 ${mode} 被误拒`).toBe(true);
    }
  });

  it('★ 编造的模式被拒绝 —— 不放任意字符串进 sim', () => {
    for (const mode of ['ctf99v99', '', 42, null, undefined]) {
      const r = parseClientMessage(JSON.stringify({ t: 'SetRoomMode', mode }));
      expect(r.ok, `非法 mode ${String(mode)} 被放行了`).toBe(false);
    }
  });
});

describe('P5 SetRoomMap 入站校验与往返', () => {
  it('★ 合法 id 原样带过（含四张主题图与试炼环）', () => {
    for (const mapId of [
      'arena_3v3', 'arena_frost_outpost', 'arena_grove_altar',
      'arena_lava_rift', 'arena_ruins_colosseum',
    ]) {
      const r = parseClientMessage(encodeClientMessage({ t: 'SetRoomMap', mapId: asMapId(mapId) }));
      expect(r.ok, `地图 ${mapId} 被误拒`).toBe(true);
      if (r.ok) expect(r.msg).toEqual({ t: 'SetRoomMap', mapId });
    }
  });

  /**
   * ★★ 与 JoinRoom 的 roomId **同族约束**（S2）：不受信任的字符串必须有长度上限。
   *   没有上限就等于允许一条消息塞进来一个 10MB 的字符串走一遍查表。
   */
  it('★★ 空串 / 超长 / 非字符串一律拒绝（roomId 同族的长度约束）', () => {
    for (const mapId of ['', 'x'.repeat(33), 42, null, { id: 'a' }, ['arena_3v3']]) {
      const r = parseClientMessage(JSON.stringify({ t: 'SetRoomMap', mapId }));
      expect(r.ok, `非法 mapId ${JSON.stringify(mapId)} 被放行了`).toBe(false);
    }
    // 边界：32 字符仍然放行（合法 id 最长 21 字符，留了余量）
    expect(parseClientMessage(JSON.stringify({ t: 'SetRoomMap', mapId: 'y'.repeat(32) })).ok)
      .toBe(true);
  });

  /**
   * ★ codec **不查地图存不存在** —— 它没有地图注册表，也不知道房间当前是什么模式。
   *   这两条都是调用方（sim 的 `setMap`）的活，与 SelectClass 只验「非空字符串」、
   *   职业合法性留给 `isPlayableClass` 是同一条分工。这里把分工钉住：
   *   一个语法合法但不存在的 id 在 codec 这一层**应当通过**。
   */
  it('★ 存在性不在 codec 这一层判（分工钉子）', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'SetRoomMap', mapId: 'no_such_map' })).ok)
      .toBe(true);
  });

  it('★ 不受信任的多余字段被丢弃，不进 sim', () => {
    const r = parseClientMessage(JSON.stringify({
      t: 'SetRoomMap', mapId: 'arena_lava_rift', teamSize: 99, spawns: [],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.msg).sort()).toEqual(['mapId', 't']);
  });
});
