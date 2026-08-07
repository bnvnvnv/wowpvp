/**
 * 编解码往返（偏差 #7 新增字段的传输完整性）。
 *
 * codec 本身是 `JSON.stringify` + 形状检查，看似不用测 —— 但 `crit`/`overkill`
 * 是**条件展开**的可选字段，最容易在「换二进制编码」时被漏掉的正是它们。
 * 这两条测试是给未来那次替换准备的回归网，不是给今天的 JSON 写的。
 */

import { describe, expect, it } from 'vitest';
import { asClassId, asEntityId, asSkillId, TEAM_RED } from '../types/ids.js';
import { School } from '../types/enums.js';
import { decodeServerMessage, encodeServerMessage, parseClientMessage } from './codec.js';
import type { ServerMessage } from './protocol.js';
import type { EntitySnapshot } from './visibility.js';

/** 自己的一份最小实体快照。★ 只为往返测试拼形状，不代表任何真实局面 */
const selfEntity: EntitySnapshot = {
  id: asEntityId(1),
  name: '我',
  team: TEAM_RED,
  classId: asClassId('mage'),
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  teleported: false,
  health: 100,
  maxHealth: 100,
  alive: true,
  resources: { mana: 50 },
  maxResources: { mana: 100 },
  auras: [],
  carryingFlag: false,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
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
  it('★ P10：快照的 focusId/gcdUntil 往返无损', () => {
    const msg: ServerMessage = {
      t: 'Snapshot', tick: 3, time: 0.15, ackSeq: 7, you: asEntityId(1),
      entities: [{ ...selfEntity, focusId: asEntityId(2), gcdUntil: 1.25 }],
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
