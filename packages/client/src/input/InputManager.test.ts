/**
 * P10 输入层：一次 keydown 只触发一个动作 + 组合键「更具体优先」+ preventDefault 按绑定表算。
 *
 * ★ 本仓库没有 jsdom（同 keybindings/settingsPanel 测试的约束），所以这里自己搭一个
 *   最小事件靶子塞进 `globalThis.window`：InputManager 只用 add/removeEventListener，
 *   够了。⚠️ 换句话说这测的是**事件到 FrameInput 的翻译规则**，不是浏览器行为本身。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Action, InputManager, type FrameInput } from './InputManager.js';

type Listener = (e: unknown) => void;

/** 最小 EventTarget：只实现 InputManager 真正调用的三件事 */
const makeTarget = () => {
  const map = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener): void {
      let s = map.get(type);
      if (!s) {
        s = new Set();
        map.set(type, s);
      }
      s.add(fn);
    },
    removeEventListener(type: string, fn: Listener): void {
      map.get(type)?.delete(fn);
    },
    emit(type: string, e: unknown): void {
      for (const fn of [...(map.get(type) ?? [])]) fn(e);
    },
    listenerCount(type: string): number {
      return map.get(type)?.size ?? 0;
    },
  };
};

type Target = ReturnType<typeof makeTarget>;
const g = globalThis as unknown as { window?: unknown };

let win: Target;
let el: Target;
let im: InputManager;
let savedWindow: unknown;

beforeEach(() => {
  savedWindow = g.window;
  win = makeTarget();
  el = makeTarget();
  g.window = win;
  im = new InputManager(el as unknown as HTMLElement);
});

afterEach(() => {
  im.dispose();
  g.window = savedWindow;
});

/** 返回事件对象，`prevented` 记录 InputManager 有没有拦下默认行为 */
const keyDown = (code: string): { code: string; prevented: boolean } => {
  const e = {
    code,
    prevented: false,
    preventDefault(): void {
      e.prevented = true;
    },
  };
  win.emit('keydown', e);
  return e;
};

const keyUp = (code: string): void => win.emit('keyup', { code });

/** 采样一帧并把一次性动作取出来（dt 固定 1/60，转向数值不参与本文件的断言）*/
const frame = (): FrameInput => im.sample(1 / 60);
const pressed = (): Action[] => [...frame().pressed].sort();

describe('★ P10-1 幽灵重触发：一次 keydown 只触发它自己那一个动作', () => {
  it('★★ 按住 Tab 再按 Q → 本帧只有侧移，不会再换一次目标', () => {
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetNext]); // 第一帧正常换目标

    // Tab 还按着（没有 keyup），此时按 Q
    keyDown('KeyQ');
    expect(pressed()).toEqual([Action.StrafeLeft]);
  });

  it('★★ 按住技能键再按无关键 → 不会重复提交施法', () => {
    keyDown('Digit1');
    expect(pressed()).toEqual([Action.Skill1]);

    keyDown('KeyY'); // KeyY 没有绑定任何动作
    expect(pressed()).toEqual([]);

    keyDown('KeyW');
    expect(pressed()).toEqual([Action.MoveForward]);
  });

  it('★★ 按住 K 再按 W → 实战模式不会被反复开关', () => {
    keyDown('KeyK');
    expect(pressed()).toEqual([Action.ToggleCombatMode]);

    keyDown('KeyW');
    expect(pressed()).toEqual([Action.MoveForward]);
    keyDown('KeyS');
    expect(pressed()).toEqual([Action.MoveBackward]);
  });

  it('同一帧内按下的两颗键各触发一次（去重只针对「按住」，不是针对同帧多键）', () => {
    keyDown('KeyG');
    keyDown('KeyB');
    expect(pressed()).toEqual([Action.CycleWeapon, Action.FlagInteract].sort());
  });

  it('系统的按键重复事件不再触发一次', () => {
    keyDown('Digit1');
    keyDown('Digit1'); // 按住不放，OS 发来的 repeat
    expect(pressed()).toEqual([Action.Skill1]);
  });

  it('单独按修饰键不触发任何动作（Tab 按住时按 Shift 也不会补一次反选）', () => {
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetNext]);
    keyDown('ShiftLeft');
    expect(pressed()).toEqual([]);
  });
});

describe('★ P10-2 组合键「更具体优先」：Shift+Tab 反选', () => {
  it('★★ Shift+Tab → 只有 TargetPrev（此前 next/prev 同帧互相抵消，真机连按目标不动）', () => {
    keyDown('ShiftLeft');
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetPrev]);
  });

  it('★★ 右 Shift 同效', () => {
    keyDown('ShiftRight');
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetPrev]);
  });

  it('★ 裸 Tab → 只有 TargetNext', () => {
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetNext]);
  });

  it('松开 Shift 后 Tab 恢复正选', () => {
    keyDown('ShiftLeft');
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetPrev]);
    keyUp('Tab');
    keyUp('ShiftLeft');
    keyDown('Tab');
    expect(pressed()).toEqual([Action.TargetNext]);
  });

  it('★★ 互斥同样作用于「按住」语义：组合绑定生效时同键的无修饰绑定让位', () => {
    // 用一条重绑出来的组合键来验通用规则（默认表里只有 ShiftTab 一条组合键，
    // 而 TargetNext/Prev 都是一次性动作，看不到 isDown 的按住结果）
    im.rebind(Action.TargetPrev, 'ShiftSpace');

    keyDown('Space');
    expect(frame().jump).toBe(true); // 裸 Space 照常跳

    keyUp('Space');
    keyDown('ShiftLeft');
    keyDown('Space');
    const f = frame();
    expect(f.jump).toBe(false); // Shift+Space 是反选，不该同时跳
    expect([...f.pressed]).toEqual([Action.TargetPrev]);
  });

  it('无关的 Shift 组合不受影响：Shift+W 仍然前进', () => {
    keyDown('ShiftLeft');
    keyDown('KeyW');
    expect(pressed()).toEqual([Action.MoveForward]);
    expect(frame().forward).toBe(1);
  });
});

describe('★ P10-3 preventDefault 按绑定表算，不再是写死的白名单', () => {
  it('★★ F3/F4 现在会被拦（此前 F3 会同时拉出浏览器查找栏）', () => {
    expect(keyDown('F3').prevented).toBe(true);
    expect(keyDown('F4').prevented).toBe(true);
  });

  it('原白名单里的键一个不少', () => {
    for (const code of ['Tab', 'Space', 'F1', 'F2', 'F10']) {
      expect(keyDown(code).prevented).toBe(true);
    }
  });

  it('★ Escape 一并拦', () => {
    expect(keyDown('Escape').prevented).toBe(true);
  });

  it('没绑定的键不拦，浏览器快捷键照常可用', () => {
    expect(keyDown('KeyY').prevented).toBe(false);
    expect(keyDown('F5').prevented).toBe(false);
  });

  it('★★ 重绑后保护自动跟过去', () => {
    expect(keyDown('F7').prevented).toBe(false);
    im.rebind(Action.ToggleDebug, 'F7');
    expect(keyDown('F7').prevented).toBe(true);
  });

  it('⚠️ 按住不放时系统重复事件也要拦，否则焦点照样会跑给浏览器', () => {
    expect(keyDown('Tab').prevented).toBe(true);
    expect(keyDown('Tab').prevented).toBe(true); // repeat
  });

  it('组合键的基键也算已绑定：Shift+Tab 一样拦', () => {
    keyDown('ShiftLeft');
    expect(keyDown('Tab').prevented).toBe(true);
  });
});

describe('P10-4 现有公开 API 与「按住」语义没有被改动', () => {
  it('按住即持续为真，松开即停 —— sample 不消费按住状态', () => {
    keyDown('KeyW');
    expect(frame().forward).toBe(1);
    expect(frame().forward).toBe(1);
    keyUp('KeyW');
    expect(frame().forward).toBe(0);
  });

  it('W+S 相消、Q/E 侧移、Alt 自我施法按住语义', () => {
    keyDown('KeyW');
    keyDown('KeyS');
    expect(frame().forward).toBe(0);

    keyDown('KeyE');
    expect(frame().strafe).toBe(1);

    keyDown('AltLeft');
    expect(frame().selfCastHeld).toBe(true);
    keyUp('AltLeft');
    expect(frame().selfCastHeld).toBe(false);
  });

  it('失焦清空按住键（Alt+Tab 回来不会一直往前走）', () => {
    keyDown('KeyW');
    expect(frame().forward).toBe(1);
    win.emit('blur', {});
    expect(frame().forward).toBe(0);
  });

  it('cameraReset 仍走一次性通道', () => {
    keyDown('Home');
    expect(frame().cameraReset).toBe(true);
    expect(frame().cameraReset).toBe(false);
  });

  it('getBindings/rebind 结构不变', () => {
    expect(im.getBindings()[Action.TargetPrev]).toBe('ShiftTab');
    im.rebind(Action.Trinket, 'KeyT');
    expect(im.getBindings()[Action.Trinket]).toBe('KeyT');
    keyDown('KeyT');
    expect(pressed()).toEqual([Action.Trinket]);
  });

  it('dispose 摘干净监听器', () => {
    expect(win.listenerCount('keydown')).toBe(1);
    im.dispose();
    expect(win.listenerCount('keydown')).toBe(0);
    expect(el.listenerCount('wheel')).toBe(0);
  });
});
