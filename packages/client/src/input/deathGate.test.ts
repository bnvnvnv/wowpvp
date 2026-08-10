/**
 * A11：死后输入闸门。
 *
 * ★ 这一支钉的是**默认路径不变** + **死后只剩观察类按键**两件事。
 *   前者比后者更重要：活着时闸门必须等价于不存在，否则 141 项验收的
 *   载体（无参默认路径）就被这个文件改掉了。
 */

import { describe, expect, it } from 'vitest';

import { Action, type FrameInput } from './InputManager.js';
import { DEAD_ALLOWED_ACTIONS, gateInputWhenDead } from './deathGate.js';

const frame = (over: Partial<FrameInput> = {}): FrameInput => ({
  forward: 1,
  strafe: -1,
  turn: 0.3,
  jump: true,
  wheel: 2,
  leftDrag: { dx: 3, dy: 4 },
  rightDrag: { dx: 5, dy: 6 },
  cameraReset: true,
  selfCastHeld: true,
  pressed: new Set<Action>([
    Action.Skill1, Action.TargetNext, Action.SetFocus, Action.Trinket,
    Action.FlagInteract, Action.CycleWeapon, Action.SpectateNext,
    Action.ToggleScoreboard, Action.OpenSettings,
  ]),
  ...over,
});

describe('gateInputWhenDead', () => {
  it('★★ 活着 → 返回**同一个对象**（默认路径逐字节不变）', () => {
    const f = frame();
    expect(gateInputWhenDead(f, true)).toBe(f);
  });

  it('死了 → 移动量全部归零，尸体不会因为还压着 W 而原地推', () => {
    const g = gateInputWhenDead(frame(), false);
    expect(g.forward).toBe(0);
    expect(g.strafe).toBe(0);
    expect(g.turn).toBe(0);
    expect(g.jump).toBe(false);
    expect(g.selfCastHeld).toBe(false);
  });

  it('★ 镜头三件事原样保留 —— 它们不进网络，只动本地相机（11.4 要能看队友）', () => {
    const g = gateInputWhenDead(frame(), false);
    expect(g.wheel).toBe(2);
    expect(g.leftDrag).toEqual({ dx: 3, dy: 4 });
    expect(g.rightDrag).toEqual({ dx: 5, dy: 6 });
    expect(g.cameraReset).toBe(true);
  });

  it('★★ 战斗性按键被挡掉：技能、切目标、焦点、解控、交互、换武器', () => {
    const g = gateInputWhenDead(frame(), false);
    for (const a of [
      Action.Skill1, Action.TargetNext, Action.SetFocus,
      Action.Trinket, Action.FlagInteract, Action.CycleWeapon,
    ]) {
      expect(g.pressed.has(a), `${a} 不该在死后通过`).toBe(false);
    }
  });

  it('观战与面板类按键照常通过（V / 记分板 / 设置）', () => {
    const g = gateInputWhenDead(frame(), false);
    expect(g.pressed.has(Action.SpectateNext)).toBe(true);
    expect(g.pressed.has(Action.ToggleScoreboard)).toBe(true);
    expect(g.pressed.has(Action.OpenSettings)).toBe(true);
  });

  it('★ 复活立刻恢复 —— 闸门无状态，同一份输入换个 alive 就是原样', () => {
    const f = frame();
    expect(gateInputWhenDead(f, false).pressed.has(Action.Skill1)).toBe(false);
    // 下一帧快照说活了：不需要任何「解除」调用
    expect(gateInputWhenDead(f, true).pressed.has(Action.Skill1)).toBe(true);
  });

  it('★★ 允许清单是**清单本身**，不是禁止清单的补集 —— 技能键不在里面', () => {
    expect(DEAD_ALLOWED_ACTIONS.has(Action.Skill1)).toBe(false);
    expect(DEAD_ALLOWED_ACTIONS.has(Action.MoveForward)).toBe(false);
    expect(DEAD_ALLOWED_ACTIONS.has(Action.SpectateNext)).toBe(true);
  });

  it('原输入的 pressed 不被改写（闸门只产出新集合）', () => {
    const f = frame();
    gateInputWhenDead(f, false);
    expect(f.pressed.has(Action.Skill1)).toBe(true);
  });
});
