/**
 * 编解码往返（偏差 #7 新增字段的传输完整性）。
 *
 * codec 本身是 `JSON.stringify` + 形状检查，看似不用测 —— 但 `crit`/`overkill`
 * 是**条件展开**的可选字段，最容易在「换二进制编码」时被漏掉的正是它们。
 * 这两条测试是给未来那次替换准备的回归网，不是给今天的 JSON 写的。
 */

import { describe, expect, it } from 'vitest';
import { asEntityId } from '../types/ids.js';
import { School } from '../types/enums.js';
import { decodeServerMessage, encodeServerMessage, parseClientMessage } from './codec.js';
import type { ServerMessage } from './protocol.js';

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
