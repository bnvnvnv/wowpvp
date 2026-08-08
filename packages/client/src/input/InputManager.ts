/**
 * 输入层。规格书 4.2 按键表，17.2「全部按键可重绑」。
 *
 * ★ 所有输入处理只认 ActionId，代码里不允许出现硬编码的 'KeyW'。
 *   这是可重绑能真正落地的前提 —— 一旦某处直接读了键码，那个功能就永远绑死了。
 */

export const Action = {
  MoveForward: 'moveForward',
  MoveBackward: 'moveBackward',
  TurnLeft: 'turnLeft',
  TurnRight: 'turnRight',
  StrafeLeft: 'strafeLeft',
  StrafeRight: 'strafeRight',
  Jump: 'jump',
  CameraReset: 'cameraReset',
  /** 5.3 Tab 循环目标 */
  TargetNext: 'targetNext',
  TargetPrev: 'targetPrev',
  /** 5.1 焦点目标 */
  SetFocus: 'setFocus',
  /** 5.6 自我施法修饰键 */
  SelfCast: 'selfCast',
  /** 8.3 通用解控「战斗意志」 */
  Trinket: 'trinket',
  /** 7.5 主动取消读条（假读条博弈）*/
  CancelCast: 'cancelCast',
  /** 技能栏 1–6 */
  Skill1: 'skill1',
  Skill2: 'skill2',
  Skill3: 'skill3',
  Skill4: 'skill4',
  Skill5: 'skill5',
  Skill6: 'skill6',
  Skill7: 'skill7',
  Skill8: 'skill8',
  /** ★ 第 9 格是**追加**的：1–8 的绑定与含义完全不变，
   *   verify-m2/m3/m4 全部按数字键打特定技能，加在末尾是唯一不动它们的改法 */
  Skill9: 'skill9',
  /** 调试：切换碰撞体与判定可视化 */
  ToggleDebug: 'toggleDebug',
  /** 17.1 三档画质循环。★ 验收 #48 要逐档人工检查，需要一个能随时切的键 */
  CycleQuality: 'cycleQuality',
  /**
   * 通用**交互键**：12.1 拔旗/归还/交旗 + 10.5 拾取掉落物 + 10.4 打开军械箱。
   *
   * ★ 三者共用一个键是有意的（MMO 惯例，也是 10.5「按交互键」的字面读法）——
   *   由客户端按 2.2 米内最近的可交互物消歧，再把**明确的**目标发给服务器
   *   （协议的 `InteractTarget` 可辨识联合）。
   * ★ id 仍叫 `flagInteract`：它已经被写进玩家本地的自定义键位存档，
   *   改 id 会让改过键位的人这个键静默失效。**改注释不改 id。**
   */
  FlagInteract: 'flagInteract',
  /** 10.7 切换备用武器（15.3 战场装备栏）*/
  CycleWeapon: 'cycleWeapon',
  /** 10.1 / 10.6：使用战场道具栏的两个增益道具 */
  UseConsumable1: 'useConsumable1',
  UseConsumable2: 'useConsumable2',
  /** 17.2 循环色盲模式。★ 与画质同理：验收要逐项人工比对，需要一个能随时切的键 */
  CycleColorblind: 'cycleColorblind',
  /** 17.2 循环界面缩放 */
  CycleUiScale: 'cycleUiScale',
  /** 11.4 观战：切换到下一个己方存活队友 */
  SpectateNext: 'spectateNext',
  /**
   * 试验场「实战模式」开关：假人从站桩切成会追会走位的人机。
   * ★ 默认关 —— 141 项验收依赖假人站在固定位置，见 `CombatDirector.combatMode`
   */
  ToggleCombatMode: 'toggleCombatMode',
  /** M12：静音总开关 */
  ToggleMute: 'toggleMute',
  /** 速赢清单：对局中记分板（Tab 已被 5.3 选目标占用，用 O）*/
  ToggleScoreboard: 'toggleScoreboard',
  /** W9（技术债总账）：设置面板。音量/画质/无障碍此前只有快捷键盲切 */
  OpenSettings: 'openSettings',
  /**
   * P13 大乱斗积分商店的展开/收起。
   * ★ 展开时数字键 1–9 改为买货（`FfaShopHud.buySlot` 会吃掉那一下按键）——
   *   所以**必须**有一个显式的开关键，不能让商店常驻抢 4.2 的技能键位。
   */
  ToggleShop: 'toggleShop',
} as const;
export type Action = (typeof Action)[keyof typeof Action];

/** 默认键位。规格书 4.2 的按键表 */
export const DEFAULT_BINDINGS: Readonly<Record<Action, string>> = {
  [Action.MoveForward]: 'KeyW',
  [Action.MoveBackward]: 'KeyS',
  [Action.TurnLeft]: 'KeyA',
  [Action.TurnRight]: 'KeyD',
  [Action.StrafeLeft]: 'KeyQ',
  [Action.StrafeRight]: 'KeyE',
  [Action.Jump]: 'Space',
  [Action.CameraReset]: 'Home',
  [Action.TargetNext]: 'Tab',
  [Action.TargetPrev]: 'ShiftTab',
  [Action.SetFocus]: 'KeyF',
  [Action.SelfCast]: 'AltLeft',
  [Action.Trinket]: 'KeyR',
  [Action.CancelCast]: 'Escape',
  [Action.Skill1]: 'Digit1',
  [Action.Skill2]: 'Digit2',
  [Action.Skill3]: 'Digit3',
  [Action.Skill4]: 'Digit4',
  [Action.Skill5]: 'Digit5',
  [Action.Skill6]: 'Digit6',
  [Action.Skill7]: 'Digit7',
  [Action.Skill8]: 'Digit8',
  [Action.Skill9]: 'Digit9',
  [Action.ToggleDebug]: 'F1',
  [Action.CycleQuality]: 'F2',
  [Action.FlagInteract]: 'KeyG',
  [Action.CycleWeapon]: 'KeyB',
  // ★ Z/X 挑的是「不与 4.2 按键表冲突」的两个键：技能占 1–9，
  //   Q/E 侧移、R 饰品、B 换武器、G 交互、V 观战、K 实战、M 静音、F 焦点
  [Action.UseConsumable1]: 'KeyZ',
  [Action.UseConsumable2]: 'KeyX',
  [Action.CycleColorblind]: 'F3',
  [Action.CycleUiScale]: 'F4',
  [Action.SpectateNext]: 'KeyV',
  [Action.ToggleCombatMode]: 'KeyK',
  [Action.ToggleMute]: 'KeyM',
  [Action.ToggleScoreboard]: 'KeyO',
  [Action.OpenSettings]: 'F10',
  // ★ N：4.2 按键表里没占的字母键之一（Q/E/R/B/G/Z/X/V/K/M/O/F 都已有主）
  [Action.ToggleShop]: 'KeyN',
};

/** 角色转向速度，弧度/秒。A/D 未按右键时用它转身 */
export const TURN_SPEED = 3.2;

export interface FrameInput {
  /** -1..1 */
  forward: number;
  /** -1..1，Q/E 侧移；按住右键时 A/D 也算侧移 */
  strafe: number;
  /** 本帧的转向增量，弧度 */
  turn: number;
  jump: boolean;
  wheel: number;
  leftDrag: { dx: number; dy: number } | null;
  rightDrag: { dx: number; dy: number } | null;
  cameraReset: boolean;
  /** 5.6 / W8：Alt 自我施法是**按住**语义，不是按下触发 */
  selfCastHeld: boolean;
  /** 按下即触发一次的动作 */
  pressed: ReadonlySet<Action>;
}

/**
 * 绑定串里可用的修饰键前缀。
 * ★ 目前只有 Shift（默认表里唯一的组合键是 `ShiftTab`）。列成数组而不是写死
 *   `'Shift'`，是为了让将来加 Ctrl/Alt 前缀只改这一行 —— 解析、互斥、
 *   preventDefault 三处都从它推导。
 * ⚠️ `ShiftLeft` / `ShiftRight` 是**物理键本身**（可以被直接绑），不是组合前缀。
 */
const MODIFIERS = ['Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** `'ShiftTab'` → `{ mod: 'Shift', base: 'Tab' }`；`'Tab'` / `'ShiftLeft'` → `{ mod: null, base: 原串 }` */
const parseBinding = (code: string): { mod: Modifier | null; base: string } => {
  for (const mod of MODIFIERS) {
    if (!code.startsWith(mod) || code === `${mod}Left` || code === `${mod}Right`) continue;
    const base = code.slice(mod.length);
    if (base.length > 0) return { mod, base };
  }
  return { mod: null, base: code };
};

export class InputManager {
  private bindings: Record<Action, string>;
  private down = new Set<string>();
  private pressedThisFrame = new Set<Action>();
  private wheelAccum = 0;
  private leftDragAccum: { dx: number; dy: number } | null = null;
  private rightDragAccum: { dx: number; dy: number } | null = null;
  private leftDown = false;
  private rightDown = false;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly element: HTMLElement,
    bindings: Record<Action, string> = { ...DEFAULT_BINDINGS },
  ) {
    this.bindings = bindings;
    this.attach();
  }

  /** 17.2：运行时重绑，不需要重启 */
  rebind(action: Action, code: string): void {
    this.bindings[action] = code;
  }

  getBindings(): Readonly<Record<Action, string>> {
    return this.bindings;
  }

  private codeOf(action: Action): string {
    return this.bindings[action];
  }

  /** 修饰键是否按住。⚠️ 左右两颗都算 —— 只认 ShiftLeft 会让惯用右手小指的人按不出 Shift+Tab */
  private modHeld(mod: Modifier | null): boolean {
    if (mod === null) return true;
    return this.down.has(`${mod}Left`) || this.down.has(`${mod}Right`);
  }

  /**
   * 同一颗物理键上是否存在「修饰键已按住」的更具体绑定。
   *
   * ★★ 这是 Shift+Tab 反选能生效的关键：`ShiftTab` 与 `Tab` 是两条**互斥**的
   *   绑定，不是可以同时命中的两条。此前两者同帧都为真，于是 targetNext 与
   *   targetPrev 在同一帧互相抵消 —— 真机连按 4 次 Shift+Tab 目标纹丝不动。
   * ★ 规则用「更具体优先」表述而不是给 Tab 特判：任何重绑出来的组合键
   *   （玩家把某动作绑到 Shift+某键）都自动获得同样的让位关系。
   */
  private hasActiveComboOn(base: string): boolean {
    for (const a of Object.values(Action)) {
      const p = parseBinding(this.codeOf(a));
      if (p.mod !== null && p.base === base && this.modHeld(p.mod)) return true;
    }
    return false;
  }

  private isDown(action: Action): boolean {
    const { mod, base } = parseBinding(this.codeOf(action));
    if (!this.down.has(base)) return false;
    if (mod !== null) return this.modHeld(mod);
    // 无修饰绑定：同键上有生效的组合绑定时让位（见 hasActiveComboOn）
    return !this.hasActiveComboOn(base);
  }

  /**
   * 一次 keydown 该触发**哪一个**动作（至多一个）。
   *
   * ★★ 此前这里是「遍历所有动作，凡是 isDown() 为真的全塞进 pressedThisFrame」，
   *   而 isDown() 表达的是「按住」而非「刚按下」—— 于是任何一次新按键都会把
   *   **当前所有按住的动作**重新触发一遍：按住 Tab 再按 Q 会再换一次目标、
   *   按住技能键再按无关键会重复提交施法、按住 K 再按 W 会反复开关实战模式。
   *   触发源必须只有本次事件的那颗键。
   */
  private resolvePress(code: string): Action | null {
    let plain: Action | null = null;
    for (const a of Object.values(Action)) {
      const p = parseBinding(this.codeOf(a));
      if (p.base !== code) continue;
      // 组合键更具体，命中即胜出，压过同物理键的无修饰绑定
      if (p.mod !== null) {
        if (this.modHeld(p.mod)) return a;
      } else if (plain === null) {
        // ⚠️ 重绑允许两个动作撞同一颗键（rebindWithSwap 之外的路径），取枚举序第一个，
        //    保证「至多一个」且结果稳定，不随遍历顺序漂移
        plain = a;
      }
    }
    return plain;
  }

  /** 这颗物理键上挂着任何绑定吗（含组合键的基键）*/
  private isBoundCode(code: string): boolean {
    for (const a of Object.values(Action)) {
      if (parseBinding(this.codeOf(a)).base === code) return true;
    }
    return false;
  }

  private attach(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      /**
       * ★ 白名单换成「凡命中已绑定动作的键就拦」：此前写死 Tab/Space/F1/F2/F10，
       *   于是 F3（循环色盲模式）会同时拉出浏览器查找栏、F4 也漏在外面；更要命的是
       *   玩家一旦重绑到别的功能键，保护就跟不过去。按绑定表算 ⇒ 重绑后自动受保护。
       * ★ Escape 单列：它默认就绑着 CancelCast，但即使被重绑走也要拦
       *   （游戏里 Esc 是「取消读条」，不该顺带触发浏览器行为）。
       *   ⚠️ 浏览器全屏的 Esc 退出是拦不住的（UA 保留），这条只管普通场景。
       * ⚠️ preventDefault 必须在「忽略按键重复」之前：按住 Tab 时系统仍会发重复事件，
       *   放过去照样会把焦点交给浏览器。
       */
      if (e.code === 'Escape' || this.isBoundCode(e.code)) e.preventDefault();
      if (this.down.has(e.code)) return; // 忽略系统的按键重复
      this.down.add(e.code);
      const pressed = this.resolvePress(e.code);
      if (pressed !== null) this.pressedThisFrame.add(pressed);
    };
    const onKeyUp = (e: KeyboardEvent) => this.down.delete(e.code);
    /** 失焦时清空按键，否则 Alt+Tab 回来会一直往前走 */
    const onBlur = () => {
      this.down.clear();
      this.leftDown = false;
      this.rightDown = false;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) this.leftDown = true;
      if (e.button === 2) {
        this.rightDown = true;
        e.preventDefault();
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (this.leftDown) {
        this.leftDragAccum ??= { dx: 0, dy: 0 };
        this.leftDragAccum.dx += e.movementX;
        this.leftDragAccum.dy += e.movementY;
      }
      if (this.rightDown) {
        this.rightDragAccum ??= { dx: 0, dy: 0 };
        this.rightDragAccum.dx += e.movementX;
        this.rightDragAccum.dy += e.movementY;
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.wheelAccum += e.deltaY;
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.element.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    this.element.addEventListener('wheel', onWheel, { passive: false });
    this.element.addEventListener('contextmenu', onContextMenu);

    this.disposers = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => this.element.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => this.element.removeEventListener('wheel', onWheel),
      () => this.element.removeEventListener('contextmenu', onContextMenu),
    ];
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  /** 采样并清空本帧的一次性输入 */
  sample(dt: number): FrameInput {
    const rightHeld = this.rightDown;

    /**
     * ★★ **双键跑**（同时按住左右键 = 一直向前，MMO 的经典操作）。
     *   右键本来就联动朝向（4.2），所以「双键 = 跟着镜头方向跑」是自然结果 ——
     *   不需要单独一套「朝鼠标方向跑」的逻辑，右键那条已经在做这件事。
     * ★ 与 W 键是**或**关系：双键跑期间按 S 仍然能后退（两者相加后钳制），
     *   这与所有 MMO 的手感一致。
     */
    const bothButtons = this.leftDown && this.rightDown;
    const forward = clampUnit(
      (this.isDown(Action.MoveForward) ? 1 : 0)
      - (this.isDown(Action.MoveBackward) ? 1 : 0)
      + (bothButtons ? 1 : 0),
    );

    // 4.2：A/D 默认是转向；按住右键时作为侧移
    const ad = (this.isDown(Action.TurnRight) ? 1 : 0) - (this.isDown(Action.TurnLeft) ? 1 : 0);
    const qe =
      (this.isDown(Action.StrafeRight) ? 1 : 0) - (this.isDown(Action.StrafeLeft) ? 1 : 0);

    const strafe = clampUnit(qe + (rightHeld ? ad : 0));
    // yaw 增大 = 向左转（与 yawToDir 的约定一致）
    const turn = rightHeld ? 0 : -ad * TURN_SPEED * dt;

    const result: FrameInput = {
      forward,
      strafe,
      turn,
      jump: this.isDown(Action.Jump),
      wheel: this.wheelAccum,
      leftDrag: this.leftDragAccum,
      rightDrag: this.rightDragAccum,
      cameraReset: this.pressedThisFrame.has(Action.CameraReset),
      selfCastHeld: this.isDown(Action.SelfCast),
      pressed: new Set(this.pressedThisFrame),
    };

    this.wheelAccum = 0;
    this.leftDragAccum = null;
    this.rightDragAccum = null;
    this.pressedThisFrame.clear();
    return result;
  }
}

const clampUnit = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
