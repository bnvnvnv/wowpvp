/**
 * 协议与入站校验测试。docs/08 §2 / §3 / §7。
 *
 * ★ 两条重点，都是**否定式**规则：
 *   1. 客户端发不出「结果」（docs/08 §2）—— 靠字段名黑名单 + 扫源码
 *   2. 越界输入不能进 sim —— dt=100 是瞬移外挂，forward=999 是速度外挂
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asClassId, asEntityId, asSkillId } from '../types/ids.js';
import { FfaOfferId } from '../sim/match/ffa.js';
import {
  ALL_CLIENT_MESSAGE_KINDS,
  ALL_SERVER_MESSAGE_KINDS,
  FORBIDDEN_CLIENT_FIELDS,
  INPUT_LIMITS,
  type ClientMessage,
  type ClientMessageKind,
  type ServerMessageKind,
} from './protocol.js';
import {
  decodeServerMessage,
  encodeClientMessage,
  normalizeAngle,
  parseClientMessage,
  takeInputsForTick,
} from './codec.js';

const parse = (obj: unknown) => parseClientMessage(JSON.stringify(obj));

const validInput = {
  t: 'Input', seq: 1, dt: 0.05, forward: 1, strafe: 0, characterYaw: 0.5, jump: false,
};

// ════════════════════════════════════════════════════════════════

describe('docs/08 §3 消息种类穷尽性', () => {
  /** ★ 与 ALL_EFFECT_KINDS 同一个手法：漏一项是编译错误，不是运行时静默失效 */
  it('★ ALL_CLIENT_MESSAGE_KINDS 与 ClientMessage 联合同步', () => {
    const exhaustive: Record<ClientMessageKind, true> = Object.fromEntries(
      ALL_CLIENT_MESSAGE_KINDS.map((k) => [k, true]),
    ) as Record<ClientMessageKind, true>;
    expect(Object.keys(exhaustive)).toHaveLength(ALL_CLIENT_MESSAGE_KINDS.length);
  });

  it('★ ALL_SERVER_MESSAGE_KINDS 与 ServerMessage 联合同步', () => {
    const exhaustive: Record<ServerMessageKind, true> = Object.fromEntries(
      ALL_SERVER_MESSAGE_KINDS.map((k) => [k, true]),
    ) as Record<ServerMessageKind, true>;
    expect(Object.keys(exhaustive)).toHaveLength(ALL_SERVER_MESSAGE_KINDS.length);
  });

  /**
   * ★ 每一个 kind 都必须有解析分支。
   *   漏一个的后果是那类消息永远被拒绝 —— 而「某个操作在联网时没反应」
   *   是最难查的一类 bug，因为本地模拟里它工作正常。
   */
  it('★★ 每个 kind 都有解析分支（不会有消息类型静默失效）', () => {
    const missing: string[] = [];
    for (const t of ALL_CLIENT_MESSAGE_KINDS) {
      const r = parse({ t });
      // 要么解析成功（无参数消息），要么因为**参数**无效被拒 ——
      // 但不能因为「缺少解析分支」被拒
      if (!r.ok && /缺少解析分支/.test(r.reason)) missing.push(t);
    }
    expect(missing).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════

describe('★★ docs/08 §2：客户端永远不发送「结果」', () => {
  /**
   * ★★ **这是本文件最重要的一条。**
   *
   *   「客户端只发意图，不发结果」是一条否定式规则。破坏它不会让任何东西报错，
   *   只会让某个玩家发现「改一行前端就能打出任意伤害」。
   *
   *   而它**很容易被顺手破坏** —— 「客户端已经算过一遍了，把结果带上来
   *   能省一次服务器计算」这个念头非常自然。所以扫源码，让这个念头在测试里撞墙。
   */
  it('★★ 客户端消息定义里不含任何结果字段', () => {
    const src = readFileSync(new URL('./protocol.ts', import.meta.url), 'utf8');

    /**
     * ⚠️ 扫描范围必须**从 `InputMessage` 开始**，不是从 `ClientMessage` 联合开始。
     *
     *   `InputMessage` 是 `ClientMessage` 的成员，但它单独定义在联合**上方** ——
     *   只扫联合的话，往 `InputMessage` 里加一个 `position` 字段这条测试抓不到。
     *   （写这条测试时真的漏了：往 InputMessage 注入 `position: {x,y,z}` 后
     *     测试照样是绿的。一个看起来在守规则、实际什么都没守的测试
     *     比没有测试更糟 —— 它会让人以为这条边界有人看着。）
     */
    const start = src.indexOf('export interface InputMessage');
    const end = src.indexOf('export type ClientMessageKind');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const clientSection = src.slice(start, end);

    const found: string[] = [];
    for (const field of FORBIDDEN_CLIENT_FIELDS) {
      // 匹配「字段名: 」形式的属性声明，避开注释里的自然语言
      if (new RegExp(`\\b${field}\\s*[?]?\\s*:`).test(clientSection)) found.push(field);
    }
    expect(found, `客户端消息里出现了结果字段：${found.join(', ')}`).toEqual([]);
  });

  /**
   * ★★ 上面那条测试的**窗口边界**自检：服务器消息段确实不在扫描范围里。
   *
   *   偏差 #7 之后服务器会下发 `crit` —— 如果窗口失手把服务器段扫进来，
   *   上面那条会因为服务器的 `crit?: boolean` 变红，第一反应多半是
   *   「把 crit 从黑名单删掉」—— 那恰好打开了客户端上报暴击的口子。
   *   这里把窗口钉死，让那个错误修法先撞上这条。
   */
  it('★★ 扫描窗口只覆盖客户端段（服务器的 Damage/Snapshot 不在窗口里）', () => {
    const src = readFileSync(new URL('./protocol.ts', import.meta.url), 'utf8');
    const clientSection = src.slice(
      src.indexOf('export interface InputMessage'),
      src.indexOf('export type ClientMessageKind'),
    );
    expect(clientSection).not.toContain("t: 'Damage'");
    expect(clientSection).not.toContain("t: 'Snapshot'");
  });

  it("★ 'crit' 仍在客户端字段黑名单里（服务器下发它不等于客户端可以上报它）", () => {
    expect(FORBIDDEN_CLIENT_FIELDS).toContain('crit');
  });

  /** ★ InputMessage 只有意图（轴向 + 朝向 + 跳跃），没有位置 —— 位置由服务器算 */
  it('★ 移动输入里没有位置字段（位置是服务器算的，不是客户端报的）', () => {
    const r = parse({ ...validInput, position: { x: 999, y: 0, z: 999 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 多余字段被丢弃，不会带进 sim
    expect(Object.keys(r.msg).sort()).toEqual(
      ['characterYaw', 'dt', 'forward', 'jump', 'seq', 'strafe', 't'],
    );
  });
});

// ════════════════════════════════════════════════════════════════

describe('★★ 入站校验是反作弊边界', () => {
  it('合法输入通过', () => {
    const r = parse(validInput);
    expect(r.ok).toBe(true);
  });

  /**
   * ★★ dt=100 是**瞬移外挂**：一次输入推进 100 秒，7 米/秒就是 700 米，
   *   足够穿过整张地图。必须拒绝而不是钳制 —— 一个发 dt=100 的客户端
   *   不是卡顿，是在攻击。
   */
  it('★★ dt=100 被拒绝（瞬移外挂）', () => {
    const r = parse({ ...validInput, dt: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/dt/);
  });

  it('dt=0 与负 dt 被拒绝（会让移动系统除零或倒退）', () => {
    expect(parse({ ...validInput, dt: 0 }).ok).toBe(false);
    expect(parse({ ...validInput, dt: -0.05 }).ok).toBe(false);
  });

  it('dt 恰好在上限内通过、超出即拒', () => {
    expect(parse({ ...validInput, dt: INPUT_LIMITS.DT_MAX }).ok).toBe(true);
    expect(parse({ ...validInput, dt: INPUT_LIMITS.DT_MAX + 0.001 }).ok).toBe(false);
  });

  /**
   * ★★ forward=999 是**速度外挂**。这里选择**钳制**而不是拒绝：
   *   手柄漂移会给出 1.0000001，因此丢一帧输入不划算。
   *   钳制的效果与拒绝一样安全 —— 越界值进不了 sim。
   */
  it('★★ forward=999 被钳制到 1（速度外挂）', () => {
    const r = parse({ ...validInput, forward: 999, strafe: -999 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.msg.t !== 'Input') return;
    expect(r.msg.forward).toBe(1);
    expect(r.msg.strafe).toBe(-1);
  });

  it('NaN / Infinity 被拒绝（会污染整个移动状态）', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      // JSON 不能表达 NaN/Infinity，所以直接调 parseClientMessage 传手写字符串
      const raw = `{"t":"Input","seq":1,"dt":0.05,"forward":${v},"strafe":0,"characterYaw":0,"jump":false}`;
      expect(parseClientMessage(raw).ok, `forward=${v}`).toBe(false);
    }
  });

  it('characterYaw 被归一化到 [-π, π]（避免累积出巨大数值）', () => {
    const r = parse({ ...validInput, characterYaw: Math.PI * 100.5 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.msg.t !== 'Input') return;
    expect(Math.abs(r.msg.characterYaw)).toBeLessThanOrEqual(Math.PI + 1e-9);
  });

  it('seq 必须是非负整数', () => {
    expect(parse({ ...validInput, seq: -1 }).ok).toBe(false);
    expect(parse({ ...validInput, seq: 1.5 }).ok).toBe(false);
  });

  describe('形状校验', () => {
    it('★ 不是合法 JSON → 返回错误，不抛异常（畸形包不该拖垮房间）', () => {
      const r = parseClientMessage('{这不是 json');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/JSON/);
    });

    it('★ 未知消息类型 → 被拒绝', () => {
      const r = parse({ t: 'GiveMeAllTheDamage', amount: 99999 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toMatch(/未知消息类型/);
    });

    it('数组、null、字符串都不是合法消息', () => {
      expect(parseClientMessage('[]').ok).toBe(false);
      expect(parseClientMessage('null').ok).toBe(false);
      expect(parseClientMessage('"hi"').ok).toBe(false);
    });

    it('缺少 t 被拒绝', () => {
      expect(parse({ seq: 1 }).ok).toBe(false);
    });
  });

  describe('各消息的参数校验', () => {
    it('JoinRoom 的 name 长度受限（防超长字符串占内存）', () => {
      expect(parse({ t: 'JoinRoom', roomId: 'r', name: 'x' }).ok).toBe(true);
      expect(parse({ t: 'JoinRoom', roomId: 'r', name: '' }).ok).toBe(false);
      expect(parse({ t: 'JoinRoom', roomId: 'r', name: 'x'.repeat(25) }).ok).toBe(false);
    });

    it('SelectTeam 只接受三个合法值', () => {
      for (const team of ['red', 'blue', 'spectator']) {
        expect(parse({ t: 'SelectTeam', team }).ok, team).toBe(true);
      }
      expect(parse({ t: 'SelectTeam', team: 'green' }).ok).toBe(false);
    });

    it('★ entityId 必须是 ≥1 的整数（实体 id 从 1 开始分配）', () => {
      expect(parse({ t: 'SetTarget', slot: 'hard', entityId: 1 }).ok).toBe(true);
      expect(parse({ t: 'SetTarget', slot: 'hard', entityId: 0 }).ok).toBe(false);
      expect(parse({ t: 'SetTarget', slot: 'hard', entityId: -5 }).ok).toBe(false);
      expect(parse({ t: 'SetTarget', slot: 'hard', entityId: 1.5 }).ok).toBe(false);
    });

    it('SetTarget 允许 entityId=null（清除目标）', () => {
      const r = parse({ t: 'SetTarget', slot: 'focus', entityId: null });
      expect(r.ok).toBe(true);
      if (!r.ok || r.msg.t !== 'SetTarget') return;
      expect(r.msg.entityId).toBeNull();
    });

    it('CastRequest 的可选字段缺失时不出现在结果里', () => {
      const r = parse({ t: 'CastRequest', skillId: 'mage.frostbolt' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.msg.t !== 'CastRequest') return;
      expect('targetId' in r.msg).toBe(false);
      expect('groundPoint' in r.msg).toBe(false);
    });

    it('CastRequest 的 groundPoint 必须是完整 Vec3', () => {
      expect(parse({
        t: 'CastRequest', skillId: 'mage.blizzard', groundPoint: { x: 1, y: 0, z: 2 },
      }).ok).toBe(true);
      expect(parse({
        t: 'CastRequest', skillId: 'mage.blizzard', groundPoint: { x: 1, z: 2 },
      }).ok).toBe(false);
    });

    it('★ 装备槽位受 10.6 的上限约束（默认 + 2 备用）', () => {
      expect(parse({ t: 'SwapWeapon', slot: 0 }).ok).toBe(true);
      expect(parse({ t: 'SwapWeapon', slot: 2 }).ok).toBe(true);
      expect(parse({ t: 'SwapWeapon', slot: 3 }).ok).toBe(false);
      expect(parse({ t: 'SwapWeapon', slot: -1 }).ok).toBe(false);
    });

    it('无参数消息不需要额外字段', () => {
      for (const t of ['LeaveMatch', 'CancelCast', 'UseTrinket', 'InteractCancel']) {
        expect(parse({ t }).ok, t).toBe(true);
      }
    });

    /**
     * P13 积分商店。★ 只验**形状与长度** —— 「有没有这件商品」查不了：
     * 货架按职业生成，codec 没有 world（与 SetTarget 的可见性同属调用方的活）。
     */
    it('★ FfaBuy 的 offerId 是受限字符串（不受信任输入的门在这里）', () => {
      expect(parse({ t: 'FfaBuy', offerId: FfaOfferId.Weapon }).ok).toBe(true);
      expect(parse({ t: 'FfaBuy', offerId: '' }).ok).toBe(false);
      expect(parse({ t: 'FfaBuy', offerId: 'x'.repeat(65) }).ok).toBe(false);
      expect(parse({ t: 'FfaBuy', offerId: 7 }).ok).toBe(false);
      expect(parse({ t: 'FfaBuy' }).ok).toBe(false);
    });

    /**
     * ★★ 客户端**发不出价格**：`FfaBuy` 只有 offerId，多带的字段一律被丢掉。
     *   带得进去的话，改一行前端就是一件 0 分的武器 —— docs/08 §2 的
     *   「只发意图不发结果」在这条消息上就是这个意思。
     */
    it('★★ FfaBuy 只保留 offerId（伪造的 cost/balance 进不了 sim）', () => {
      const r = parse({ t: 'FfaBuy', offerId: FfaOfferId.Weapon, cost: 0, balance: 999999 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Object.keys(r.msg).sort()).toEqual(['offerId', 't']);
    });
  });
});

// ════════════════════════════════════════════════════════════════

describe('★★ 攒输入不能换来加速', () => {
  /**
   * ★★ 客户端故意不发 1 秒，然后一次发 20 条 dt=0.05 的输入 ——
   *   每条单独看都合法，但服务器若全部消费，这个玩家就在一个 tick 内
   *   走了 1 秒的距离。这是**通过合法消息实现的**外挂，形状校验挡不住。
   */
  it('★★ 一个 tick 最多消费 INPUTS_PER_TICK_MAX 条输入', () => {
    const queue = Array.from({ length: 20 }, (_, i) => i);
    const taken = takeInputsForTick(queue);
    expect(taken).toHaveLength(INPUT_LIMITS.INPUTS_PER_TICK_MAX);
    expect(queue).toHaveLength(0);
  });

  /**
   * ★ 丢**最旧的**而不是最新的。
   *   玩家的意图是「我现在要往哪走」，保留最新的更接近真实意图；
   *   丢新的还会给他一个延迟优势（他的操作总是慢一拍地生效）。
   */
  it('★ 超量时丢最旧的，保留最新的', () => {
    const queue = [1, 2, 3, 4, 5, 6, 7, 8];
    const taken = takeInputsForTick(queue);
    expect(taken[taken.length - 1]).toBe(8);
    expect(taken).not.toContain(1);
  });

  it('未超量时全部消费', () => {
    const queue = [1, 2];
    expect(takeInputsForTick(queue)).toEqual([1, 2]);
    expect(queue).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════

describe('编解码往返（docs/08 §7：语义与编码分离）', () => {
  it('客户端消息编码后能原样解回', () => {
    const messages: ClientMessage[] = [
      { t: 'JoinRoom', roomId: 'room-1', name: '玩家' },
      { t: 'SelectClass', classId: asClassId('mage') },
      { t: 'SetReady', ready: true },
      { t: 'Input', seq: 42, dt: 0.05, forward: 1, strafe: -1, characterYaw: 1.2, jump: true },
      { t: 'SetTarget', slot: 'hard', entityId: asEntityId(3) },
      { t: 'CastRequest', skillId: asSkillId('mage.frostbolt'), targetId: asEntityId(3) },
      { t: 'CancelCast' },
      { t: 'SwapWeapon', slot: 1 },
      { t: 'FfaBuy', offerId: FfaOfferId.Heal },
      { t: 'BattleBuy', offerId: 'battle.weapon' },
    ];
    for (const msg of messages) {
      const r = parseClientMessage(encodeClientMessage(msg));
      expect(r.ok, `${msg.t} 往返失败`).toBe(true);
      if (r.ok) expect(r.msg).toEqual(msg);
    }
  });

  it('服务器消息解码：形状不对返回 undefined 而不抛', () => {
    expect(decodeServerMessage('{不是 json')).toBeUndefined();
    expect(decodeServerMessage('[]')).toBeUndefined();
    expect(decodeServerMessage('{"noType":1}')).toBeUndefined();
    expect(decodeServerMessage('{"t":"Welcome","playerId":"p1","tickRate":20,"interpDelay":0.1}'))
      .toMatchObject({ t: 'Welcome', playerId: 'p1' });
  });
});

describe('normalizeAngle', () => {
  it('把角度收进 [-π, π]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 9);
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 9);
    expect(Math.abs(normalizeAngle(1234.5))).toBeLessThanOrEqual(Math.PI + 1e-9);
  });
});
