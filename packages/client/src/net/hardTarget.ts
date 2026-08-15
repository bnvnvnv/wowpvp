/**
 * W20：硬目标的**快照回读对账**。
 *
 * ★★ 此前硬目标是纯客户端乐观记账：点击立刻写 `view.targetId`，而服务器
 *   拒绝（超距/不可选）或目标静默失效后没有任何回滚 —— HUD 一直显示旧选中，
 *   与服务器分叉。焦点（focusId）P10 起就走「只从快照来」的口径，硬目标没跟。
 *
 * 现在服务器在 self 段回发权威硬目标（`visibility.buildSelfState`），客户端
 * 每份快照用本函数对账。与焦点的差别只有一个：点击选人要**立刻**看到目标框
 * （等快照要 200ms+，手感不能等），所以保留乐观显示，但给它一个确认窗口 ——
 * 窗口内快照没跟上不回跳（那只是还没轮到），窗口外一律以快照为准。
 *
 * ★ 纯函数：NetworkScene 拿结果写回自己的字段。Rejected('SetTarget') 的
 *   即时回滚不走这里 —— 拒绝已经明说了「没设上」，不用等窗口。
 */

import type { EntityId } from '@wowpvp/shared';

/** 点击后待服务器确认的乐观选中 */
export interface PendingHardTarget {
  id: number;
  /** 登记时刻（服务器时间，秒）*/
  at: number;
}

/**
 * 确认窗口：SetTarget 指令帧 50ms + 快照 10Hz（100ms）+ 插值延迟 150ms，
 * 再留一次快照的重传余量。窗口只影响「乐观值多久没被确认就放弃」，
 * 不影响确认成功的路径（快照一旦等于乐观值立即转常规回读）。
 */
export const HARD_TARGET_CONFIRM_GRACE_S = 1;

export interface HardTargetReconcile {
  targetId: number | undefined;
  pending: PendingHardTarget | undefined;
}

export const reconcileHardTarget = (
  pending: PendingHardTarget | undefined,
  authoritative: EntityId | undefined,
  now: number,
  graceSeconds = HARD_TARGET_CONFIRM_GRACE_S,
): HardTargetReconcile => {
  const auth = authoritative as number | undefined;
  if (pending !== undefined) {
    // 服务器已采纳 —— 确认完成，转常规回读
    if (auth === pending.id) return { targetId: auth, pending: undefined };
    // 窗口内快照还没跟上乐观值：保持，防「点了 → 闪没 → 又出现」
    if (now - pending.at <= graceSeconds) return { targetId: pending.id, pending };
    // 窗口外仍未采纳（静默非法/不可见）：放弃乐观值，以快照为准
    return { targetId: auth, pending: undefined };
  }
  return { targetId: auth, pending: undefined };
};
