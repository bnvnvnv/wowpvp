/**
 * M1 试验场。把镜头、输入、移动物理、动作状态机接在一起，
 * 让规格书 4.x / 13.x 的每一条规则都能被**肉眼验证**。
 *
 * 这是 M1 的验收载体：验收 #1 / #2 / #3 / #44 / #45 / #47 都在这里人工确认。
 */

import * as THREE from 'three';
import {
  GEOMETRY,
  MOVE,
  createMovementState,
  stepMovement,
  testbed,
  TESTBED_SPAWN,
  type Aabb,
  type MovementState,
} from '@wowpvp/shared';

import { CameraController } from '../camera/CameraController.js';
import { AnimationController } from '../entity/AnimationController.js';
import { CharacterView } from '../entity/CharacterView.js';
import { Action, InputManager, type FrameInput } from '../input/InputManager.js';
import { GameLoop } from '../render/GameLoop.js';
import { MapRenderer } from '../render/MapRenderer.js';

export interface DebugInfo {
  fps: number;
  position: { x: number; y: number; z: number };
  speed: number;
  grounded: boolean;
  animState: string;
  cameraYaw: number;
  characterYaw: number;
  cameraDistance: number;
  firstPerson: boolean;
}

export class TestbedScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cam: CameraController;
  private readonly input: InputManager;
  private readonly loop: GameLoop;
  private readonly mapRenderer: MapRenderer;
  private readonly view = new CharacterView();
  private readonly anim = new AnimationController();
  private readonly obstacles: readonly Aabb[];

  private move: MovementState;
  private characterYaw = TESTBED_SPAWN.yaw;
  /** 上一帧与本帧的模拟位置，用于渲染插值 */
  private prevPosition = { ...TESTBED_SPAWN.position };
  private pendingInput: FrameInput | null = null;
  private lastLandingHeight: number | undefined;
  private debugVisible = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onDebug: (info: DebugInfo) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x232a35);
    // 雾要推到地图边界之外：70×70 的场地对角线约 99 米，太近的雾会让远端墙体糊掉，
    // 而「看清远处几何」正是这个试验场存在的意义
    this.scene.fog = new THREE.Fog(0x232a35, 90, 160);

    this.obstacles = testbed.geometry;
    this.mapRenderer = new MapRenderer(testbed);
    this.scene.add(this.mapRenderer.group);
    this.scene.add(this.view.group);
    this.addGrid();
    this.addLights();

    this.cam = new CameraController(canvas.clientWidth / canvas.clientHeight);
    this.input = new InputManager(canvas);
    this.move = createMovementState(TESTBED_SPAWN.position, TESTBED_SPAWN.yaw);

    this.loop = new GameLoop(
      (dt) => this.simulate(dt),
      (alpha, dt) => this.draw(alpha, dt),
      (dt) => this.readInput(dt),
    );

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }

  private onResize = (): void => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
  };

  /**
   * 地面参考网格。1 米一格、5 米一条粗线 ——
   * 没有它就没法用肉眼判断「跨越了多高」「滑了多远」，而这些正是 13.5 要验的东西。
   */
  private addGrid(): void {
    const grid = new THREE.GridHelper(70, 70, 0x4a5568, 0x333c4a);
    grid.position.y = 0.01; // 抬一点避免与地面 z-fighting
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    const coarse = new THREE.GridHelper(70, 14, 0x5f6f88, 0x5f6f88);
    coarse.position.y = 0.02;
    (coarse.material as THREE.Material).transparent = true;
    (coarse.material as THREE.Material).opacity = 0.4;
    this.scene.add(coarse);
  }

  private addLights(): void {
    // three r155+ 默认使用物理光照单位，强度不要照搬旧版数值 —— 容易直接过曝成白板
    this.scene.add(new THREE.HemisphereLight(0xa8bcd8, 0x3a4250, 0.85));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.1);
    sun.position.set(24, 40, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -45;
    c.right = 45;
    c.top = 45;
    c.bottom = -45;
    c.far = 120;
    this.scene.add(sun);
  }

  /**
   * 每帧一次的输入采样与镜头处理。
   * 必须在固定步之前、且每帧只做一次 —— 见 GameLoop.BeforeFrame 的注释。
   */
  private readInput(dt: number): void {
    const input = this.input.sample(dt);
    this.pendingInput = input;

    // 4.2：A/D 未按右键时转动角色
    this.characterYaw += input.turn;

    // 镜头输入。★ 只有右键拖动会返回非零的角色 yaw 增量（4.2 / 验收 #2）
    const yawDelta = this.cam.applyInput({
      wheel: input.wheel,
      leftDrag: input.leftDrag,
      rightDrag: input.rightDrag,
      reset: input.cameraReset,
    });
    this.characterYaw += yawDelta;

    if (input.cameraReset) this.cam.resetBehind(this.characterYaw);
    if (input.pressed.has(Action.ToggleDebug)) {
      this.debugVisible = !this.debugVisible;
      this.view.setHitboxVisible(this.debugVisible);
      this.mapRenderer.setDebugVisible(this.debugVisible);
    }
  }

  /** 固定步长的模拟推进 */
  private simulate(dt: number): void {
    const input = this.pendingInput;
    if (!input) return;

    this.prevPosition = { ...this.move.position };
    const result = stepMovement(
      this.move,
      {
        forward: input.forward,
        strafe: input.strafe,
        jump: input.jump,
        // ★ 传的是**角色** yaw，不是镜头 yaw（6.5）
        yaw: this.characterYaw,
      },
      dt,
      this.obstacles,
    );
    this.move = result.state;
    this.lastLandingHeight = result.landing?.fallHeight;

    this.anim.update({
      horizontalDistance: this.move.lastHorizontalDistance,
      dt,
      grounded: this.move.grounded,
      verticalVelocity: this.move.velocity.y,
      teleported: this.move.teleported,
      forward: input.forward,
      strafe: input.strafe,
      landedFrom: this.lastLandingHeight,
    });
  }

  private draw(alpha: number, dt: number): void {
    // 渲染插值：模拟是固定步长，画面按帧率插值
    const p = this.prevPosition;
    const c = this.move.position;
    const rendered = {
      x: p.x + (c.x - p.x) * alpha,
      y: p.y + (c.y - p.y) * alpha,
      z: p.z + (c.z - p.z) * alpha,
    };

    this.view.setTransform(rendered, this.characterYaw);
    this.view.setAnimState(this.anim.state);

    const moving = this.anim.smoothedSpeed > 0.5;
    this.cam.update(
      dt,
      { position: rendered, yaw: this.characterYaw, grounded: this.move.grounded },
      this.obstacles,
      moving,
    );
    this.view.setFirstPerson(this.cam.isFirstPerson);

    this.renderer.render(this.scene, this.cam.camera);

    this.onDebug({
      fps: this.loop.fps,
      position: rendered,
      speed: this.anim.smoothedSpeed,
      grounded: this.move.grounded,
      animState: this.anim.state,
      cameraYaw: this.cam.yaw,
      characterYaw: this.characterYaw,
      cameraDistance: this.cam.distance,
      firstPerson: this.cam.isFirstPerson,
    });
  }

  /** 供 HUD 显示的常量，避免 UI 层重复硬编码 */
  static readonly INFO = {
    baseSpeed: MOVE.BASE_SPEED,
    hitboxRadius: GEOMETRY.HITBOX_RADIUS,
    stepHeight: GEOMETRY.STEP_HEIGHT,
  };
}
