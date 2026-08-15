/**
 * W20：硬目标快照对账的纯函数测试。
 *
 * 场景语义（NetworkScene）：点击 → 乐观显示 + 登记 pending；每份快照
 * 调 `reconcileHardTarget` 决定「显示什么、pending 还留不留」。
 * Rejected('SetTarget') 的即时回滚不走这里（拒绝已明说「没设上」）。
 */

import { describe, expect, it } from 'vitest';
import { asEntityId } from '@wowpvp/shared';

import { reconcileHardTarget } from './hardTarget.js';

const E7 = asEntityId(7);
const E9 = asEntityId(9);

describe('W20 硬目标快照对账', () => {
  it('无乐观值：一律采纳权威值 —— 含「清空」（目标失效/潜行遁走）', () => {
    expect(reconcileHardTarget(undefined, E7, 10)).toEqual({ targetId: 7, pending: undefined });
    expect(reconcileHardTarget(undefined, undefined, 10))
      .toEqual({ targetId: undefined, pending: undefined });
  });

  it('★ 确认窗口内快照还没跟上：保持乐观值（防「点了→闪没→又出现」）', () => {
    const pending = { id: 9, at: 10 };
    // 快照还带着旧目标，或还什么都没带 —— 都不回跳
    expect(reconcileHardTarget(pending, E7, 10.3)).toEqual({ targetId: 9, pending });
    expect(reconcileHardTarget(pending, undefined, 10.3)).toEqual({ targetId: 9, pending });
  });

  it('★ 快照等于乐观值 → 确认完成，转常规回读', () => {
    expect(reconcileHardTarget({ id: 9, at: 10 }, E9, 10.2))
      .toEqual({ targetId: 9, pending: undefined });
  });

  it('★★ 服务器始终没采纳（静默非法/不可见）：窗口过后以快照为准', () => {
    expect(reconcileHardTarget({ id: 9, at: 10 }, E7, 11.5))
      .toEqual({ targetId: 7, pending: undefined });
    expect(reconcileHardTarget({ id: 9, at: 10 }, undefined, 11.5))
      .toEqual({ targetId: undefined, pending: undefined });
  });

  it('连点换目标：pending 是最后一次点击，先前的确认不算数', () => {
    // 玩家 A→B 连点，快照先确认了 A —— 显示应保持 B（pending 仍在窗口内）
    const pending = { id: 9, at: 10.2 };
    expect(reconcileHardTarget(pending, E7, 10.4)).toEqual({ targetId: 9, pending });
    // 随后快照确认 B
    expect(reconcileHardTarget(pending, E9, 10.5)).toEqual({ targetId: 9, pending: undefined });
  });
});
