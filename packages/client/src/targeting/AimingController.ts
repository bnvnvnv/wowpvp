/**
 * 瞄准输入状态机。规格书 5.4 / 5.5。
 *
 * ★ 5.5 的核心约束：三种确认方式**只改变输入，不改变范围和合法性**。
 *   所以本文件只管「什么时候算确认了」，边界与合法性一律来自
 *   shared 的 `resolveGroundPlacement` —— 换确认方式不会让技能变强或变弱。
 */

import type { SkillDef } from '@wowpvp/shared';

/** 5.5 三种地面技能确认方式 */
export const GroundConfirmMode = {
  /** 默认：按下技能进入范围预览，左键确认，右键或 Esc 取消 */
  ClickToConfirm: 'clickToConfirm',
  /** 按键松开即确认 */
  ReleaseToConfirm: 'releaseToConfirm',
  /** 再次按下同一技能键确认 */
  PressAgainToConfirm: 'pressAgainToConfirm',
  /** 在鼠标位置立即施放，不进预览 */
  InstantAtCursor: 'instantAtCursor',
} as const;
export type GroundConfirmMode = (typeof GroundConfirmMode)[keyof typeof GroundConfirmMode];

export type AimEvent =
  | { type: 'none' }
  /** 进入了地面预览状态 */
  | { type: 'previewStart'; skill: SkillDef }
  /** 玩家确认了落点，应当释放 */
  | { type: 'confirm'; skill: SkillDef }
  /** 玩家取消了瞄准 */
  | { type: 'cancel'; skill: SkillDef };

export interface AimInput {
  /** 本帧按下的技能槽索引，没有则为 null */
  pressedSlot: number | null;
  /** 本帧松开的技能槽索引 */
  releasedSlot: number | null;
  leftClick: boolean;
  rightClick: boolean;
  escape: boolean;
}

export class AimingController {
  /** 当前正在预览的技能。null 表示没有在瞄准 */
  private pending: { skill: SkillDef; slot: number } | null = null;

  constructor(public mode: GroundConfirmMode = GroundConfirmMode.ClickToConfirm) {}

  get pendingSkill(): SkillDef | null {
    return this.pending?.skill ?? null;
  }

  get isAiming(): boolean {
    return this.pending !== null;
  }

  /** 强制退出瞄准（例如角色死亡、被控制）*/
  reset(): void {
    this.pending = null;
  }

  /**
   * 推进一帧。返回本帧产生的瞄准事件。
   *
   * @param resolveSkill 由槽位索引取技能定义
   */
  update(input: AimInput, resolveSkill: (slot: number) => SkillDef | undefined): AimEvent {
    // ── 取消优先级最高：Esc 和右键随时可以退出预览（5.5）──
    if (this.pending && (input.escape || input.rightClick)) {
      const skill = this.pending.skill;
      this.pending = null;
      return { type: 'cancel', skill };
    }

    // ── 已在预览中：看是否满足确认条件 ──
    if (this.pending) {
      const { skill, slot } = this.pending;
      const confirmed =
        (this.mode === GroundConfirmMode.ClickToConfirm && input.leftClick) ||
        (this.mode === GroundConfirmMode.ReleaseToConfirm && input.releasedSlot === slot) ||
        (this.mode === GroundConfirmMode.PressAgainToConfirm && input.pressedSlot === slot);

      if (confirmed) {
        this.pending = null;
        return { type: 'confirm', skill };
      }

      // 预览中按了**另一个**技能：切换到新技能的预览或直接释放
      if (input.pressedSlot !== null && input.pressedSlot !== slot) {
        this.pending = null;
        return this.begin(input.pressedSlot, resolveSkill);
      }
      return { type: 'none' };
    }

    // ── 未在瞄准：按下技能键 ──
    if (input.pressedSlot !== null) {
      return this.begin(input.pressedSlot, resolveSkill);
    }
    return { type: 'none' };
  }

  private begin(slot: number, resolveSkill: (slot: number) => SkillDef | undefined): AimEvent {
    const skill = resolveSkill(slot);
    if (!skill) return { type: 'none' };

    // 非地面技能不进入预览，直接释放
    if (skill.targeting !== 'ground') return { type: 'confirm', skill };

    // 「鼠标位置立即施放」也不进预览 —— 但**合法性检查一模一样**（5.5）
    if (this.mode === GroundConfirmMode.InstantAtCursor) {
      return { type: 'confirm', skill };
    }

    this.pending = { skill, slot };
    return { type: 'previewStart', skill };
  }
}
