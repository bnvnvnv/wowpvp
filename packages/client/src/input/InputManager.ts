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
  /** 调试：切换碰撞体与判定可视化 */
  ToggleDebug: 'toggleDebug',
  /** 17.1 三档画质循环。★ 验收 #48 要逐档人工检查，需要一个能随时切的键 */
  CycleQuality: 'cycleQuality',
  /** 12.1 与旗帜交互（拔旗/归还/交旗）*/
  FlagInteract: 'flagInteract',
  /** 10.7 切换备用武器（15.3 战场装备栏）*/
  CycleWeapon: 'cycleWeapon',
  /** 17.2 循环色盲模式。★ 与画质同理：验收要逐项人工比对，需要一个能随时切的键 */
  CycleColorblind: 'cycleColorblind',
  /** 17.2 循环界面缩放 */
  CycleUiScale: 'cycleUiScale',
  /** 11.4 观战：切换到下一个己方存活队友 */
  SpectateNext: 'spectateNext',
  /** M12：静音总开关 */
  ToggleMute: 'toggleMute',
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
  [Action.ToggleDebug]: 'F1',
  [Action.CycleQuality]: 'F2',
  [Action.FlagInteract]: 'KeyG',
  [Action.CycleWeapon]: 'KeyB',
  [Action.CycleColorblind]: 'F3',
  [Action.CycleUiScale]: 'F4',
  [Action.SpectateNext]: 'KeyV',
  [Action.ToggleMute]: 'KeyM',
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
  /** 按下即触发一次的动作 */
  pressed: ReadonlySet<Action>;
}

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

  private isDown(action: Action): boolean {
    const code = this.codeOf(action);
    // ShiftTab 这类组合键
    if (code.startsWith('Shift') && code !== 'ShiftLeft' && code !== 'ShiftRight') {
      return this.down.has('ShiftLeft') && this.down.has(code.slice(5));
    }
    return this.down.has(code);
  }

  private attach(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      // Tab 默认会切换焦点，必须阻止
      if (['Tab', 'Space', 'F1', 'F2'].includes(e.code)) e.preventDefault();
      if (this.down.has(e.code)) return; // 忽略系统的按键重复
      this.down.add(e.code);
      for (const a of Object.values(Action)) {
        if (this.isDown(a)) this.pressedThisFrame.add(a);
      }
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

    const forward =
      (this.isDown(Action.MoveForward) ? 1 : 0) - (this.isDown(Action.MoveBackward) ? 1 : 0);

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
