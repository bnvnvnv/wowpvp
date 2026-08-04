/**
 * `referencedEntities` 的登记正确性（技术债总账 A7）。
 *
 * ★ **穷尽性由类型层保证**（switch 的 `satisfies never`，与 codec.ts 同款）：
 *   协议加新消息不在函数里归类就编译不过 —— 那才是 A7 要堵的洞
 *   （此前 `default: return []` 是 fail-open，新消息静默放行实体 id）。
 *
 *   本文件测的是**已登记事件消息**每一类引用的 id 齐不齐：
 *   漏一个 id = 漏一次可见性检查（泄露）；多一个 id = 无关消息被整条误杀
 *   （已知偏差 #4 那类「莫名少了反馈」）。
 */

import { describe, expect, it } from 'vitest';

import type { EntityId, ServerMessage } from '@wowpvp/shared';

import { referencedEntities } from './MatchLoop.js';

const id = (n: number): EntityId => n as EntityId;
/** 只造 referencedEntities 会读的字段 —— 其余字段与本函数无关 */
const msg = (x: unknown): ServerMessage => x as ServerMessage;

describe('A7：referencedEntities 逐类登记', () => {
  it('AuraApplied / AuraRemoved 引用光环目标', () => {
    expect(referencedEntities(msg({ t: 'AuraApplied', targetId: id(3) }))).toEqual([id(3)]);
    expect(referencedEntities(msg({ t: 'AuraRemoved', targetId: id(4) }))).toEqual([id(4)]);
  });

  it('Death 引用死者与凶手；凶手缺席（弃权/来源已抹）时只引用死者', () => {
    expect(referencedEntities(msg({ t: 'Death', entityId: id(1), killerId: id(2) })))
      .toEqual([id(1), id(2)]);
    expect(referencedEntities(msg({ t: 'Death', entityId: id(1) }))).toEqual([id(1)]);
  });

  it('CastStarted / CastInterrupted 引用施法者', () => {
    expect(referencedEntities(msg({ t: 'CastStarted', casterId: id(5) }))).toEqual([id(5)]);
    expect(referencedEntities(msg({ t: 'CastInterrupted', casterId: id(6) }))).toEqual([id(6)]);
  });

  it('FlagEvent 引用旗手；无旗手（旗在地上/座上）时为空', () => {
    expect(referencedEntities(msg({ t: 'FlagEvent', flagTeam: 0, carrierId: id(7) })))
      .toEqual([id(7)]);
    expect(referencedEntities(msg({ t: 'FlagEvent', flagTeam: 0 }))).toEqual([]);
  });

  it('抹而不丢的消息（Damage/Heal/CastResolved）不做整条丢弃判定', () => {
    // 它们在 redactFor 有专门分支，这里必须返回空 —— 否则会被整条误杀
    expect(referencedEntities(msg({ t: 'Damage', targetId: id(1), sourceId: id(2) }))).toEqual([]);
    expect(referencedEntities(msg({ t: 'Heal', targetId: id(1), sourceId: id(2) }))).toEqual([]);
    expect(referencedEntities(msg({ t: 'CastResolved', casterId: id(2), targetIds: [id(1)] })))
      .toEqual([]);
  });
});
