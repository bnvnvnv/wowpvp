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
const g = globalThis as unknown as { window?: unknown; document?: unknown };

/**
 * X15：最小 document 靶子 —— 只实现 InputManager 用到的指针锁定四件事。
 * `requestPointerLock` 挂在**元素**上（规范如此），成功时由本靶子把
 * `pointerLockElement` 指过去并发一次 `pointerlockchange`，模拟浏览器。
 */
const makeDoc = (element: Target) => {
  const t = makeTarget();
  const doc = Object.assign(t, {
    pointerLockElement: null as unknown,
    exitPointerLock(): void {
      if (doc.pointerLockElement === null) return;
      doc.pointerLockElement = null;
      doc.emit('pointerlockchange', {});
    },
    /** 浏览器授予锁定（默认行为）*/
    grant(): void {
      doc.pointerLockElement = element;
      doc.emit('pointerlockchange', {});
    },
  });
  return doc;
};
type Doc = ReturnType<typeof makeDoc>;

/** 元素上的 requestPointerLock 记录：每次调用记下参数 */
type LockCall = { unadjusted: boolean };

let win: Target;
let el: Target;
let doc: Doc;
let im: InputManager;
let savedWindow: unknown;
let savedDocument: unknown;
let lockCalls: LockCall[];
/** 用例可改：返回 'grant' | 'reject' | 'throw' */
let lockOutcome: (call: LockCall) => 'grant' | 'reject' | 'throw';

beforeEach(() => {
  savedWindow = g.window;
  savedDocument = g.document;
  win = makeTarget();
  el = makeTarget();
  doc = makeDoc(el);
  lockCalls = [];
  lockOutcome = () => 'grant';
  (el as unknown as { requestPointerLock: (o?: { unadjustedMovement?: boolean }) => Promise<void> })
    .requestPointerLock = (o) => {
      const call = { unadjusted: o?.unadjustedMovement === true };
      lockCalls.push(call);
      const outcome = lockOutcome(call);
      if (outcome === 'throw') throw new Error('拒绝');
      if (outcome === 'reject') return Promise.reject(new Error('拒绝'));
      doc.grant();
      return Promise.resolve();
    };
  g.window = win;
  g.document = doc;
  im = new InputManager(el as unknown as HTMLElement);
});

afterEach(() => {
  im.dispose();
  g.window = savedWindow;
  g.document = savedDocument;
});

/** 让 requestPointerLock 的 Promise 回调跑完 */
const flush = (): Promise<void> => Promise.resolve().then(() => {}).then(() => {});

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

/**
 * X10 追加轮：双键跑的拖动路由（用户实测「左右按键只能跑，不能跟随鼠标
 * 方向跑」）。双键时同一段位移此前左右两个通道都吃 —— 镜头 2 倍速、
 * 角色 1 倍速，越拖越脱节。修后双键 = 右键语义（镜头带角色一起转）。
 */
describe('双键跑的拖动路由', () => {
  const mouse = (type: string, e: Record<string, unknown>): void => {
    // mousedown 挂在 element、mousemove/mouseup 挂在 window（与 attach 一致）
    (type === 'mousedown' ? el : win).emit(type, { preventDefault: () => {}, ...e });
  };

  it('★ 双键按住拖动：只进右键通道（角色跟着鼠标转），左键通道必须为空', () => {
    mouse('mousedown', { button: 0 });
    mouse('mousedown', { button: 2 });
    mouse('mousemove', { movementX: 40, movementY: 6 });
    const f = im.sample(1 / 60);
    expect(f.rightDrag).toEqual({ dx: 40, dy: 6 });
    expect(f.leftDrag, '双键位移漏进了左键通道 —— 镜头会转两遍').toBeNull();
  });

  it('单按左键拖动语义不变（4.2：只环绕观察）', () => {
    mouse('mousedown', { button: 0 });
    mouse('mousemove', { movementX: 25, movementY: -4 });
    const f = im.sample(1 / 60);
    expect(f.leftDrag).toEqual({ dx: 25, dy: -4 });
    expect(f.rightDrag).toBeNull();
  });

  it('松开左键回到单右键：拖动继续走右键通道', () => {
    mouse('mousedown', { button: 0 });
    mouse('mousedown', { button: 2 });
    mouse('mousemove', { movementX: 10, movementY: 0 });
    im.sample(1 / 60);
    mouse('mouseup', { button: 0 });
    mouse('mousemove', { movementX: 7, movementY: 2 });
    const f = im.sample(1 / 60);
    expect(f.rightDrag).toEqual({ dx: 7, dy: 2 });
    expect(f.leftDrag).toBeNull();
  });
});

/**
 * ★★ X15 指针锁定。修的是「右键拖转身被窗口宽度封顶」——
 * 光标一顶到屏幕边缘 `movementX` 就归零（1366px 窗里拖满 1200px 只转出 149°）。
 *
 * ⚠️ 这里验的是**请求/释放/回落的时机规则**，不是浏览器真的锁没锁：
 *   靶子模拟浏览器的授予与 `pointerlockchange`。真机手感只能真机验。
 */
describe('★★ X15 指针锁定', () => {
  const mouse = (type: string, e: Record<string, unknown>): void => {
    (type === 'mousedown' ? el : win).emit(type, { preventDefault: () => {}, ...e });
  };

  it('★ 默认开启（真人档），右键按下即请求锁定，优先带 unadjustedMovement', () => {
    expect(im.pointerLockEnabled).toBe(true);
    expect(im.pointerLocked).toBe(false);

    mouse('mousedown', { button: 2 });
    expect(lockCalls).toEqual([{ unadjusted: true }]);
    expect(im.pointerLocked).toBe(true);
  });

  it('★ 左键单独按下**不**请求锁定（左键还兼着点选与确认落点，一点一锁不划算）', () => {
    mouse('mousedown', { button: 0 });
    expect(lockCalls).toEqual([]);
    expect(im.pointerLocked).toBe(false);
  });

  it('★★ 锁定期间位移照常累加进右键通道 —— 与未锁定是同一行代码', () => {
    mouse('mousedown', { button: 2 });
    // 锁定后 movementX 不再被屏幕边缘归零：一次拖动累出远超窗口宽度的位移
    for (let i = 0; i < 10; i++) mouse('mousemove', { movementX: 400, movementY: 0 });
    const f = im.sample(1 / 60);
    expect(f.rightDrag).toEqual({ dx: 4000, dy: 0 });
    expect(f.leftDrag).toBeNull();
  });

  it('★ 松开右键退出锁定', () => {
    mouse('mousedown', { button: 2 });
    expect(im.pointerLocked).toBe(true);
    mouse('mouseup', { button: 2 });
    expect(im.pointerLocked).toBe(false);
    expect(doc.pointerLockElement).toBeNull();
  });

  it('★★ 双键跑中途松开右键**不**解锁（光标不该突然蹦回来），两颗都松才解', () => {
    mouse('mousedown', { button: 2 });
    mouse('mousedown', { button: 0 });
    mouse('mouseup', { button: 2 });
    expect(im.pointerLocked).toBe(true);
    mouse('mouseup', { button: 0 });
    expect(im.pointerLocked).toBe(false);
  });

  it('★★ Esc 退锁（浏览器行为，拦不住）：右键仍按住时完整回落拖动路径，且不重发请求', () => {
    mouse('mousedown', { button: 2 });
    expect(lockCalls).toHaveLength(1);

    doc.exitPointerLock(); // 浏览器因 Esc 解锁
    expect(im.pointerLocked).toBe(false);

    // 右键还按着 —— 拖动照样进右键通道（旧路径一行没删）
    mouse('mousemove', { movementX: 33, movementY: -4 });
    expect(im.sample(1 / 60).rightDrag).toEqual({ dx: 33, dy: -4 });
    // 本次按住期间不再重发（Chrome 对 Esc 退锁后的请求有冷却）
    expect(lockCalls).toHaveLength(1);

    // 松开再按下 = 新的一次用户手势，才重新尝试
    mouse('mouseup', { button: 2 });
    mouse('mousedown', { button: 2 });
    expect(lockCalls).toHaveLength(2);
    expect(im.pointerLocked).toBe(true);
  });

  it('★★ 开关关掉：不再请求锁定，拖动仍然正常（旧路径）', () => {
    im.setPointerLockEnabled(false);
    expect(im.pointerLockEnabled).toBe(false);

    mouse('mousedown', { button: 2 });
    expect(lockCalls).toEqual([]);
    expect(im.pointerLocked).toBe(false);
    mouse('mousemove', { movementX: 18, movementY: 3 });
    expect(im.sample(1 / 60).rightDrag).toEqual({ dx: 18, dy: 3 });
  });

  it('★ 正锁着时关掉开关 → 立即释放（玩家来关它，多半正因为光标不见了）', () => {
    mouse('mousedown', { button: 2 });
    expect(im.pointerLocked).toBe(true);
    im.setPointerLockEnabled(false);
    expect(im.pointerLocked).toBe(false);
  });

  it('★ 关掉再打开，下一次右键按下重新请求', () => {
    im.setPointerLockEnabled(false);
    mouse('mousedown', { button: 2 });
    mouse('mouseup', { button: 2 });
    im.setPointerLockEnabled(true);
    mouse('mousedown', { button: 2 });
    expect(lockCalls).toHaveLength(1);
    expect(im.pointerLocked).toBe(true);
  });

  it('★★ 浏览器拒绝 unadjustedMovement → 退一步用无参形式重试**一次**', async () => {
    lockOutcome = (c) => (c.unadjusted ? 'reject' : 'grant');
    mouse('mousedown', { button: 2 });
    await flush();
    expect(lockCalls).toEqual([{ unadjusted: true }, { unadjusted: false }]);
    expect(im.pointerLocked).toBe(true);
  });

  it('★★ 两次都被拒 → 不成环，完整回落拖动路径', async () => {
    lockOutcome = () => 'reject';
    mouse('mousedown', { button: 2 });
    await flush();
    expect(lockCalls).toHaveLength(2);
    expect(im.pointerLocked).toBe(false);

    mouse('mousemove', { movementX: 21, movementY: 7 });
    expect(im.sample(1 / 60).rightDrag).toEqual({ dx: 21, dy: 7 });
  });

  it('★ 同步抛异常（老浏览器的旧签名）同样只退一步，不炸出去', () => {
    lockOutcome = (c) => (c.unadjusted ? 'throw' : 'grant');
    expect(() => mouse('mousedown', { button: 2 })).not.toThrow();
    expect(lockCalls).toHaveLength(2);
    expect(im.pointerLocked).toBe(true);
  });

  it('★★ 根本不支持 requestPointerLock → 一个字都不改，拖动照旧', () => {
    delete (el as unknown as { requestPointerLock?: unknown }).requestPointerLock;
    mouse('mousedown', { button: 2 });
    expect(im.pointerLocked).toBe(false);
    mouse('mousemove', { movementX: 60, movementY: 0 });
    expect(im.sample(1 / 60).rightDrag).toEqual({ dx: 60, dy: 0 });
  });

  it('★ pointerlockerror 也把状态摆回未锁定', () => {
    mouse('mousedown', { button: 2 });
    expect(im.pointerLocked).toBe(true);
    doc.emit('pointerlockerror', {});
    expect(im.pointerLocked).toBe(false);
  });

  it('★ 失焦（Alt+Tab）释放锁定，与清空按键同一处', () => {
    mouse('mousedown', { button: 2 });
    win.emit('blur', {});
    expect(im.pointerLocked).toBe(false);
    expect(doc.pointerLockElement).toBeNull();
  });

  it('★ dispose 先退锁再摘监听器（否则场景重建后悬停拾取永远不恢复）', () => {
    mouse('mousedown', { button: 2 });
    expect(doc.listenerCount('pointerlockchange')).toBe(1);
    im.dispose();
    expect(im.pointerLocked).toBe(false);
    expect(doc.pointerLockElement).toBeNull();
    expect(doc.listenerCount('pointerlockchange')).toBe(0);
    expect(doc.listenerCount('pointerlockerror')).toBe(0);
  });
});
