/**
 * 瞄准状态机测试。对应规格书 5.5。
 *
 * 主线：**三种确认方式只改变输入，不改变范围和合法性**。
 * 最后一组测试直接断言这件事 —— 四种模式下最终释放的是同一个技能定义。
 */

import { describe, expect, it } from 'vitest';
import { getSkill } from '@wowpvp/shared';
import { asSkillId } from '@wowpvp/shared';
import { AimingController, GroundConfirmMode, type AimInput } from './AimingController.js';

const blizzard = getSkill(asSkillId('mage.blizzard'))!;
const frostbolt = getSkill(asSkillId('mage.frostbolt'))!;
const resolve = (slot: number) => (slot === 0 ? blizzard : slot === 1 ? frostbolt : undefined);

const input = (o: Partial<AimInput> = {}): AimInput => ({
  pressedSlot: null,
  releasedSlot: null,
  leftClick: false,
  rightClick: false,
  escape: false,
  ...o,
});

describe('5.5 默认方式：按下进入预览，左键确认', () => {
  it('按下地面技能进入预览而不是立刻释放', () => {
    const c = new AimingController();
    const ev = c.update(input({ pressedSlot: 0 }), resolve);
    expect(ev.type).toBe('previewStart');
    expect(c.isAiming).toBe(true);
  });

  it('左键确认后释放', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    const ev = c.update(input({ leftClick: true }), resolve);
    expect(ev.type).toBe('confirm');
    expect(c.isAiming).toBe(false);
  });

  it('预览期间不按确认键就一直保持预览', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    for (let i = 0; i < 10; i++) {
      expect(c.update(input(), resolve).type).toBe('none');
    }
    expect(c.isAiming).toBe(true);
  });
});

describe('5.5 取消：右键或 Esc', () => {
  it('右键取消', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    expect(c.update(input({ rightClick: true }), resolve).type).toBe('cancel');
    expect(c.isAiming).toBe(false);
  });

  it('Esc 取消', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    expect(c.update(input({ escape: true }), resolve).type).toBe('cancel');
  });

  it('取消优先于确认 —— 同一帧既点左键又按 Esc 时不释放', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    expect(c.update(input({ leftClick: true, escape: true }), resolve).type).toBe('cancel');
  });
});

describe('5.5 可选确认方式', () => {
  it('按键松开确认', () => {
    const c = new AimingController(GroundConfirmMode.ReleaseToConfirm);
    expect(c.update(input({ pressedSlot: 0 }), resolve).type).toBe('previewStart');
    // 松开别的键不算
    expect(c.update(input({ releasedSlot: 1 }), resolve).type).toBe('none');
    expect(c.update(input({ releasedSlot: 0 }), resolve).type).toBe('confirm');
  });

  it('再次按键确认', () => {
    const c = new AimingController(GroundConfirmMode.PressAgainToConfirm);
    expect(c.update(input({ pressedSlot: 0 }), resolve).type).toBe('previewStart');
    expect(c.update(input({ pressedSlot: 0 }), resolve).type).toBe('confirm');
  });

  it('鼠标位置立即施放：不进入预览', () => {
    const c = new AimingController(GroundConfirmMode.InstantAtCursor);
    expect(c.update(input({ pressedSlot: 0 }), resolve).type).toBe('confirm');
    expect(c.isAiming).toBe(false);
  });
});

describe('非地面技能不进入预览', () => {
  it('直接目标技能按下即释放', () => {
    const c = new AimingController();
    const ev = c.update(input({ pressedSlot: 1 }), resolve);
    expect(ev.type).toBe('confirm');
    expect(c.isAiming).toBe(false);
  });
});

describe('预览中按另一个技能', () => {
  it('切换到新技能的预览', () => {
    const c = new AimingController();
    c.update(input({ pressedSlot: 0 }), resolve);
    // 按下另一个地面技能槽（这里 1 是直接目标技能，会直接释放）
    const ev = c.update(input({ pressedSlot: 1 }), resolve);
    expect(ev.type).toBe('confirm');
    expect(ev.type === 'confirm' && ev.skill.id).toBe(frostbolt.id);
    expect(c.isAiming).toBe(false);
  });
});

describe('★ 5.5 —— 不同确认方式不改变技能本身', () => {
  it('四种模式最终释放的是同一个技能定义（范围与合法性不受影响）', () => {
    const modes = [
      GroundConfirmMode.ClickToConfirm,
      GroundConfirmMode.ReleaseToConfirm,
      GroundConfirmMode.PressAgainToConfirm,
      GroundConfirmMode.InstantAtCursor,
    ];
    /** 每种模式各自的正确操作序列，返回最终 confirm 出来的技能 */
    const released = modes.map((mode) => {
      const c = new AimingController(mode);
      let ev = c.update(input({ pressedSlot: 0 }), resolve);
      if (ev.type === 'confirm') return ev.skill; // InstantAtCursor：一步到位

      // 其余三种进入预览后再各按各的确认方式
      const confirmInput =
        mode === GroundConfirmMode.ClickToConfirm ? input({ leftClick: true })
        : mode === GroundConfirmMode.ReleaseToConfirm ? input({ releasedSlot: 0 })
        : input({ pressedSlot: 0 });
      ev = c.update(confirmInput, resolve);
      return ev.type === 'confirm' ? ev.skill : null;
    });

    // 每种模式都能释放
    expect(released.every((s) => s !== null)).toBe(true);
    // 且释放的是同一个技能对象 —— 形状、距离、合法性规则完全一致
    expect(new Set(released.map((s) => s!.id)).size).toBe(1);
    expect(released[0]!.shape).toEqual(released[3]!.shape);
    expect(released[0]!.range).toEqual(released[3]!.range);
  });
});
