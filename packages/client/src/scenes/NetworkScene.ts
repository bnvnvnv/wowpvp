/**
 * 联网场景：世界状态来自**服务器快照**，而不是本地模拟。
 *
 * ★★ **为什么另加一个场景，而不是把试验场改造成联网的**（docs/13 判断二）：
 *   `TestbedScene` 是 M1–M8 共 106 项端到端验收的载体，而它们目前全绿。
 *   把它改成「从服务器收快照」会同时打掉那 106 项。所以两者并存：
 *
 *   | 场景 | 数据来源 | 用途 |
 *   |---|---|---|
 *   | TestbedScene | 本地 tickWorld | M1–M9 验收载体，保持可用 |
 *   | NetworkScene | 服务器快照 | M10 的验收载体 |
 *
 * ★ 两者共用 render / camera / vfx / settings 的表现层代码，
 *   差别只在「世界状态从哪来」。这本身就是一次验证：如果表现层能同时
 *   吃本地模拟和远端快照，说明它确实没有偷偷依赖模拟内部状态。
 *
 * ★★ **HUD 已共用（M11）。** M10 接这个场景时验出「表现层确实偷偷依赖了
 *    模拟内部状态」—— `CombatHud.update()` 收 `CombatDirector` 并直读
 *    `dir.world` / `dir.player`。M11 把那些依赖收敛成 `hud/CombatView.ts`
 *    的窄接口，`CombatDirector` 与 `net/SnapshotCombatView` 各实现一份，
 *    于是**同一个 CombatHud 两边都能喂**。判断二的那句话到此才真正兑现。
 */

import * as THREE from 'three';
import {
  GEOMETRY,
  MAP_BY_ID,
  SIM,
  createMovementState,
  type EntityId,
  type MapDef,
  type EntitySnapshot,
  type MovementInput,
  type ServerMessage,
  type TeamId,
} from '@wowpvp/shared';

import { CameraController } from '../camera/CameraController.js';
import { AnimationController } from '../entity/AnimationController.js';
import { CharacterView } from '../entity/CharacterView.js';
import { ModelLibrary } from '../entity/ModelLibrary.js';
import { Action, InputManager, type FrameInput } from '../input/InputManager.js';
import { GameLoop } from '../render/GameLoop.js';
import { MapRenderer } from '../render/MapRenderer.js';
import { QualityController } from '../render/QualityController.js';
import { QualityTier } from '../render/quality.js';
import { Environment } from '../render/Environment.js';
import { Connection } from '../net/Connection.js';
import { Interpolator } from '../net/Interpolator.js';
import { Predictor } from '../net/Predictor.js';
import { pickTabTargetFromSnapshot } from '../net/snapshotTargeting.js';
import { CombatHud } from '../hud/CombatHud.js';
import { SnapshotCombatView } from '../net/SnapshotCombatView.js';
import { audio } from '../audio/AudioManager.js';
import { TargetRing } from '../vfx/TargetRing.js';
import { paletteFor } from '../settings/accessibility.js';
import { artEnabled } from '../settings/artMode.js';

export interface NetworkSceneOptions {
  url: string;
  roomId: string;
  name: string;
  team: 'red' | 'blue';
  classId: string;
}

/** 供验收脚本读取的联网状态 */
export interface NetStatus {
  connected: boolean;
  started: boolean;
  /** 自己的实体 id */
  you: number | null;
  /** 收到的快照数 */
  snapshots: number;
  /** 最近一次快照的服务器时间 */
  serverTime: number;
  /** 场上可见实体数（含自己）*/
  entities: number;
  /** 自己的渲染位置 */
  position: { x: number; y: number; z: number };
  /** 最近一次纠正的幅度，米 */
  lastCorrection: number;
}

export class NetworkScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cam: CameraController;
  private readonly input: InputManager;
  private readonly loop: GameLoop;
  private readonly quality: QualityController;
  /** M12：HDR 环境光与天空 */
  private readonly env: Environment;
  /** M12：是否加载外部美术素材（`?art=off` 关闭）。见 settings/artMode.ts */
  private readonly art = artEnabled();
  private readonly conn: Connection;
  /** ★ 与试验场**同一个** HUD 类，喂的是快照视图而不是 CombatDirector */
  private readonly hud: CombatHud;
  private readonly view = new SnapshotCombatView();

  private mapRenderer?: MapRenderer;
  private map?: MapDef;

  /** 自己：预测；其他人：插值。★ 两条完全不同的路径，见 docs/08 §5 */
  private predictor?: Predictor;
  private readonly interp = new Interpolator();

  private readonly selfView = new CharacterView();
  private readonly selfAnim = new AnimationController();
  /** M12：当前目标的脚下指示环 */
  private readonly targetRing = new TargetRing();
  /** 远端角色的可视化与动作状态机，按实体 id */
  private readonly views = new Map<number, CharacterView>();
  private readonly anims = new Map<number, AnimationController>();
  /** 上一帧远端角色的位置，用来算位移喂给动作状态机 */
  private readonly lastRemotePos = new Map<number, { x: number; y: number; z: number }>();

  private selfId: EntityId | null = null;
  /** 自己的队伍与当前硬目标 —— Tab 循环要用 */
  private selfTeam: TeamId | null = null;
  private currentTargetId: EntityId | undefined;
  /** 最近一份快照的实体列表，Tab 从它里面挑 */
  private lastEntities: readonly EntitySnapshot[] = [];
  private started = false;
  private characterYaw = 0;
  private pendingInput: FrameInput | null = null;
  /** 客户端估计的服务器时间。收到快照时校准，其余时间自己走 */
  private serverTime = 0;
  private snapshotCount = 0;
  private lastCorrection = 0;
  private sun!: THREE.DirectionalLight;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: NetworkSceneOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // M12：HDR 环境是线性高动态的，不做色调映射会大面积过曝。
    // ★ 与素材同开同关，理由同试验场
    if (this.art) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.0;
    }
    this.quality = new QualityController(this.renderer, QualityTier.High);
    // M12：模型库（素材缺失或 ?art=off 时保留程序化胶囊体）
    if (this.art) ModelLibrary.init(this.renderer);
    this.selfView.setClass(opts.classId);

    this.scene.background = new THREE.Color(0x232a35);
    this.scene.fog = new THREE.Fog(0x232a35, 90, 160);
    this.scene.add(this.selfView.group);
    this.scene.add(this.targetRing.group);
    this.addLights();
    // M12：环境光与天空。★ 纯加法，见 Environment.ts 文件头
    this.env = new Environment(this.renderer, this.scene);
    if (this.art) this.env.apply(this.quality.current, { preset: 'day' });

    this.cam = new CameraController(canvas.clientWidth / canvas.clientHeight);
    this.input = new InputManager(canvas);
    this.hud = new CombatHud(canvas.parentElement ?? document.body);
    // 点姓名板选人 → 发 SetTarget（服务器仍会校验可见集合）
    this.view.onSelect = (id) => {
      this.currentTargetId = id;
      this.view.targetId = id;
      this.conn.send({ t: 'SetTarget', slot: 'hard', entityId: id });
    };

    this.conn = new Connection(opts.url, {
      onMessage: (m) => this.onMessage(m),
      onOpen: (resumed) => { if (!resumed) this.joinRoom(); },
      onClose: () => { /* Connection 自己退避重连 */ },
    });

    /**
     * ★ 固定步长默认就是 `SIM.TICK_DT` —— 也就是**指令帧**。
     *   `simulate()` 因此每 50ms 跑一次：采样、预测、发一条 Input。
     *   这正是 A3 收尾定下的契约，两端同一步长，预测才可能精确收敛。
     */
    this.loop = new GameLoop(
      (dt) => this.simulate(dt),
      (alpha, dt) => this.draw(alpha, dt),
      (dt) => this.readInput(dt),
    );

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  start(): void {
    audio.install();
    this.conn.connect();
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.conn.close();
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.env.dispose();
    this.renderer.dispose();
  }

  get status(): NetStatus {
    const p = this.predictor?.position ?? { x: 0, y: 0, z: 0 };
    return {
      connected: this.conn.connected,
      started: this.started,
      you: this.selfId === null ? null : (this.selfId as number),
      snapshots: this.snapshotCount,
      serverTime: this.serverTime,
      entities: this.views.size + (this.predictor ? 1 : 0),
      position: { ...p },
      lastCorrection: this.lastCorrection,
    };
  }

  // ── 协议 ──────────────────────────────────────────────────────

  private joinRoom(): void {
    this.conn.send({ t: 'JoinRoom', roomId: this.opts.roomId, name: this.opts.name });
    this.conn.send({ t: 'SelectTeam', team: this.opts.team });
    this.conn.send({ t: 'SelectClass', classId: this.opts.classId as never });
    this.conn.send({ t: 'SetReady', ready: true });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'MatchStart': {
        this.selfId = msg.you;
        this.started = true;
        this.loadMap(msg.mapId as string);
        /**
         * ★ 预测器在这里才建得出来 —— 它需要地图几何做碰撞。
         *   起点先用 (0,0,0)，第一份快照会把它纠正到权威位置；
         *   纠正幅度会很大，但那一次**本来就该是瞬移**（刚出生）。
         */
        this.predictor = new Predictor(
          createMovementState({ x: 0, y: 0, z: 0 }, 0),
          { obstacles: this.map?.geometry ?? [] },
        );
        /**
         * ★ 重连也走这条分支（服务器重连成功后会再发一次 MatchStart）。
         *   docs/08 §6：「客户端丢弃所有本地状态」—— 插值缓冲一并清空，
         *   否则会拿 90 秒前的帧去插值。
         */
        this.interp.reset();
        break;
      }

      case 'Snapshot': {
        this.snapshotCount++;
        this.serverTime = msg.time;
        this.interp.push(msg.time, msg.entities);
        this.lastEntities = msg.entities;
        this.selfTeam = msg.entities.find((e) => e.id === msg.you)?.team ?? this.selfTeam;
        this.view.ingest(
          { tick: msg.tick, you: msg.you, entities: msg.entities, match: msg.match },
          msg.time,
        );

        const me = msg.entities.find((e) => e.id === msg.you);
        if (me && this.predictor) {
          const before = { ...this.predictor.position };
          this.predictor.reconcile(
            {
              position: me.position,
              yaw: me.yaw,
              ...(me.selfMovement ? { movement: me.selfMovement } : {}),
            },
            msg.ackSeq,
            me.teleported,
          );
          const p = this.predictor.position;
          this.lastCorrection = Math.hypot(p.x - before.x, p.y - before.y, p.z - before.z);
        }
        break;
      }

      case 'Rejected':
        // ★ 拒绝要让玩家看得见，否则「按了没反应」是最难查的一类问题
        this.view.push(`${msg.what} 被拒绝：${msg.reason}`, 'fail');
        break;

      // 战斗事件 → 战斗日志。★ 与试验场同一套文案由 HUD 渲染
      //
      // ★ M12 音效在这里接**协议消息**，而不是 CombatEvent —— 联网客户端
      //   没有本地 sim，它知道的只有服务器发来的这几条。信息比试验场少
      //   （例如没有 avoided/immune 的区分），所以声音也如实地少一层，
      //   ⚠️ 不编一个「大概是格挡」的音效：那会让玩家按不存在的反馈做判断
      case 'Damage': {
        if (msg.immune) audio.play('buff_apply', { ...this.audioDistance(msg.targetId), rate: 0.8 });
        else audio.playImpact(msg.school, this.audioDistance(msg.targetId));
        if (msg.targetId === this.selfId) {
          audio.playVariant('hurt', { volume: 0.85 });
          if (msg.amount > 0) this.hud.flashScreen();
        }
        const at = this.headOf(msg.targetId);
        if (at) {
          if (msg.immune) this.hud.floaters.push('免疫', 'immune', at);
          else if (msg.amount > 0) this.hud.floaters.push(String(msg.amount), 'damage', at);
          else if (msg.absorbed > 0) this.hud.floaters.push(`吸收 ${msg.absorbed}`, 'absorb', at);
        }
        this.view.push(`${this.nameOf(msg.sourceId)} → ${this.nameOf(msg.targetId)} ${msg.amount} 点伤害`, 'ok');
        break;
      }
      case 'Heal': {
        audio.play('heal_impact', this.audioDistance(msg.targetId));
        const at = this.headOf(msg.targetId);
        if (at && msg.amount > 0) this.hud.floaters.push(`+${msg.amount}`, 'heal', at);
        this.view.push(`${this.nameOf(msg.sourceId)} 治疗 ${this.nameOf(msg.targetId)} ${msg.amount} 点`, 'ok');
        break;
      }
      case 'Death':
        audio.playVariant('death', this.audioDistance(msg.entityId));
        this.view.push(`${this.nameOf(msg.entityId)} 被击杀`, 'interrupt');
        break;
      case 'CastFailed':
        audio.play('ui_error', { group: 'ui', volume: 0.5 });
        this.view.push(`施法失败：${msg.reason}`, 'fail');
        break;
      case 'CastStarted':
        audio.playCast(msg.school, { ...this.audioDistance(msg.casterId), volume: 0.7 });
        break;
      case 'CastInterrupted':
        audio.play('ui_error', {
          group: 'ui',
          volume: msg.casterId === this.selfId ? 0.9 : 0.5,
        });
        break;
      case 'AuraApplied':
        audio.play('buff_apply', { ...this.audioDistance(msg.targetId), volume: 0.5 });
        break;

      default:
        // 其余消息（战斗事件、房间状态）要等 HUD 共用之后才有消费者。
        // ★ 不静默：先留一条日志，免得「消息发了但没人处理」变成静默失败
        break;
    }
  }

  private loadMap(mapId: string): void {
    if (this.mapRenderer) return;
    const map = MAP_BY_ID.get(mapId);
    if (!map) { console.error(`地图不存在：${mapId}`); return; }
    this.map = map;
    this.mapRenderer = new MapRenderer(map, this.art);
    this.scene.add(this.mapRenderer.group);
    if (this.art) void this.mapRenderer.applyGroundTexture('stone');
  }

  // ── 每帧 ──────────────────────────────────────────────────────

  private readInput(dt: number): void {
    const input = this.input.sample(dt);
    this.pendingInput = input;
    this.characterYaw += input.turn;

    const yawDelta = this.cam.applyInput({
      wheel: input.wheel,
      leftDrag: input.leftDrag,
      rightDrag: input.rightDrag,
      reset: input.cameraReset,
    });
    this.characterYaw += yawDelta;
    if (input.cameraReset) this.cam.resetBehind(this.characterYaw);
    if (input.pressed.has(Action.CycleQuality)) {
      const tier = this.quality.cycle();
      this.quality.applyToLight(this.sun);
      if (this.art) this.env.apply(tier);
    }
    if (input.pressed.has(Action.ToggleMute)) {
      console.info(`[音频] ${audio.toggleMute() ? '已静音' : '已取消静音'}`);
    }
    if (this.started) audio.playMusic('combat_1');
    // 5.3：Tab 正序、Shift+Tab 反序
    if (input.pressed.has(Action.TargetNext)) this.tabTarget(false);
    if (input.pressed.has(Action.TargetPrev)) this.tabTarget(true);
  }

  /**
   * 5.3 Tab 选目标 —— **在客户端算，发一条 `SetTarget` 给服务器**。
   *
   * ★★ 理由见 `net/snapshotTargeting.ts` 的文件头：5.3 要的是**镜头**前方 140°，
   *   而协议里没有镜头朝向，服务器做不出符合规格的 Tab。放在客户端不放宽
   *   安全边界 —— 服务器对 `SetTarget` 是校验可见集合的。
   */
  /** 实体名，供战斗日志。★ 来源不可见时服务器会抹掉 sourceId（已知偏差 #4）*/
  private nameOf(id: EntityId | undefined): string {
    if (id === undefined) return '某个看不见的敌人';
    return this.lastEntities.find((e) => e.id === id)?.name ?? '?';
  }

  /**
   * M12：事件发生地到自己的距离，供音效衰减。
   * ★ 实体不在快照里（潜行、超出视野）就不给 distance —— 不是「给个大数字」，
   *   那会把「看不见的人」的动静按远处播出去，等于泄露了他的存在（验收 #5）。
   */
  /**
   * 实体头顶的世界坐标，供浮动数字。
   * ★ 与 `audioDistance` 同理：不在快照里就返回 undefined —— 不给
   *   看不见的人飘数字，那等于泄露他的位置（验收 #5）。
   */
  private headOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    if (id === this.selfId && this.predictor) {
      const p = this.predictor.position;
      return { x: p.x, y: p.y + GEOMETRY.HITBOX_HEIGHT * 0.9, z: p.z };
    }
    const e = this.lastEntities.find((x) => x.id === id);
    if (!e) return undefined;
    return { x: e.position.x, y: e.position.y + GEOMETRY.HITBOX_HEIGHT * 0.9, z: e.position.z };
  }

  private audioDistance(id: EntityId | undefined): { distance?: number } {
    if (id === undefined) return {};
    if (id === this.selfId) return { distance: 0 };
    const at = this.lastEntities.find((e) => e.id === id)?.position;
    const me = this.predictor?.position;
    if (!at || !me) return {};
    return { distance: Math.hypot(at.x - me.x, at.z - me.z) };
  }

  private tabTarget(reverse: boolean): void {
    if (this.selfId === null || this.selfTeam === null || !this.predictor) return;
    const picked = pickTabTargetFromSnapshot({
      selfId: this.selfId,
      selfPosition: this.predictor.position,
      selfTeam: this.selfTeam,
      // ★ 镜头 yaw，不是角色 yaw（5.3）
      viewYaw: this.cam.yaw,
      entities: this.lastEntities,
      ...(this.currentTargetId !== undefined ? { currentTargetId: this.currentTargetId } : {}),
    }, reverse);
    if (picked === undefined) return; // 5.3：没有候选时保持原目标不变
    this.currentTargetId = picked;
    this.view.targetId = picked;
    this.conn.send({ t: 'SetTarget', slot: 'hard', entityId: picked });
  }

  /**
   * 一个**指令帧**（50ms）：采样 → 本地预测 → 发出去。
   *
   * ★ 这里**不推进世界** —— 世界由服务器推进，客户端只推进「自己的位置」。
   *   技能效果一律等服务器确认（docs/08 §5 开头）。
   */
  private simulate(_dt: number): void {
    const input = this.pendingInput;
    if (!input || !this.predictor || !this.started) return;

    const move: MovementInput = {
      forward: input.forward,
      strafe: input.strafe,
      jump: input.jump,
      // ★ 角色 yaw，不是镜头 yaw（6.5）
      yaw: this.characterYaw,
    };
    this.conn.send(this.predictor.sample(move));
  }

  private draw(_alpha: number, dt: number): void {
    // 服务器时间自己走，收到快照时校准 —— 插值要按它取样
    this.serverTime += dt;

    this.drawSelf(dt);
    this.drawRemotes(dt);
    this.updateTargetRing();

    this.renderer.render(this.scene, this.cam.camera);
    // ★ 与试验场同一个调用 —— 只是喂的 CombatView 实现不同
    this.hud.update(this.view, this.cam.camera, this.canvas, dt);
  }

  private drawSelf(dt: number): void {
    if (!this.predictor) return;
    /**
     * ★ 渲染位置 = 预测位置 + 尚未消化完的纠正量。
     *   `renderPosition` 每帧衰减那个纠正量，所以中等偏差是「滑过去」的，
     *   而瞬移档在 `reconcile` 里就已经把它清零了（13.4）。
     */
    const pos = this.predictor.renderPosition(dt);
    const s = this.predictor.state;

    this.selfAnim.update({
      horizontalDistance: s.lastHorizontalDistance,
      dt,
      grounded: s.grounded,
      verticalVelocity: s.velocity.y,
      teleported: s.teleported,
      forward: this.pendingInput?.forward ?? 0,
      strafe: this.pendingInput?.strafe ?? 0,
    });

    this.selfView.setTransform(pos, this.characterYaw);
    this.selfView.setAnimState(this.selfAnim.state);
    // M12：动画节奏、施法姿态、手上武器、模型动画推进
    this.selfView.setLocomotionTimeScale(this.selfAnim.timeScale);
    this.selfView.setCasting(this.view.playerCast !== undefined);
    const meSnap = this.lastEntities.find((e) => e.id === this.selfId);
    if (meSnap) {
      this.syncWeapon(meSnap.id as number, this.selfView, meSnap.equipment.currentWeaponId as string | undefined);
    }
    this.selfView.update(dt);

    this.cam.update(
      dt,
      { position: pos, yaw: this.characterYaw, grounded: s.grounded },
      this.map?.geometry ?? [],
      this.selfAnim.smoothedSpeed > 0.5,
    );
    this.selfView.setFirstPerson(this.cam.isFirstPerson);
  }

  private drawRemotes(dt: number): void {
    const sampled = this.interp.sample(this.serverTime, this.selfId ?? undefined);
    const seen = new Set<number>();

    for (const e of sampled) {
      const id = e.snapshot.id as number;
      seen.add(id);

      let view = this.views.get(id);
      if (!view) {
        view = new CharacterView(e.snapshot.classId as string);
        this.views.set(id, view);
        this.scene.add(view.group);
        this.anims.set(id, new AnimationController());
      }

      const prev = this.lastRemotePos.get(id);
      const moved = prev
        ? Math.hypot(e.position.x - prev.x, e.position.z - prev.z)
        : 0;
      this.lastRemotePos.set(id, { ...e.position });

      const anim = this.anims.get(id)!;
      anim.update({
        /**
         * ★★ 13.4：瞬移那一帧位移**必须报 0**，否则动作状态机会按
         *   「一帧走了 20 米」算出几十米每秒的速度并播出冲刺 ——
         *   而 `teleported` 正是为这件事存在的（见 Interpolator）。
         */
        horizontalDistance: e.teleported ? 0 : moved,
        dt,
        grounded: true,
        verticalVelocity: 0,
        teleported: e.teleported,
        forward: 0,
        strafe: 0,
      });

      view.setTransform(e.position, e.yaw);
      view.setAnimState(anim.state);
      view.setLocomotionTimeScale(anim.timeScale);
      this.syncWeapon(id, view, e.snapshot.equipment.currentWeaponId as string | undefined);
      view.update(dt);
    }

    // 离开视野的（潜行、死亡移除、断线淘汰）→ 收掉
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      view.dispose(); // 取消在途的模型/武器异步挂载
      this.scene.remove(view.group);
      this.views.delete(id);
      this.anims.delete(id);
      this.lastRemotePos.delete(id);
      this.shownWeapons.delete(id);
    }
  }

  /**
   * M12：当前目标的脚下指示环（5.2）。
   * ★ 用**插值后**的位置而不是快照原始位置 —— 否则环会以 20Hz 跳，
   *   而角色是平滑的，看上去像环没跟上人。
   */
  private updateTargetRing(): void {
    const id = this.currentTargetId;
    if (id === undefined) {
      this.targetRing.update(undefined, 'hostile', this.serverTime, '#fff');
      return;
    }
    const snap = this.lastEntities.find((e) => e.id === id);
    const rendered = this.views.get(id as number)?.group.position;
    const at = rendered ?? snap?.position;
    const p = paletteFor(this.hud.accessibility.colorblind);
    const friendly = snap !== undefined && snap.team === this.selfTeam;
    this.targetRing.update(
      at,
      friendly ? 'friendly' : 'hostile',
      this.serverTime,
      friendly ? p.friendly : p.hostile,
    );
  }

  /** M12：武器变化才触发挂载（setWeapon 是异步的，不能每帧调） */
  private readonly shownWeapons = new Map<number, string | undefined>();
  private syncWeapon(id: number, view: CharacterView, weaponId: string | undefined): void {
    if (this.shownWeapons.get(id) === weaponId) return;
    this.shownWeapons.set(id, weaponId);
    view.setWeapon(weaponId);
  }

  // ── 杂项 ──────────────────────────────────────────────────────

  private onResize = (): void => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
  };

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x2b3140, 0.8));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.1);
    this.sun.position.set(20, 40, 15);
    this.sun.castShadow = true;
    this.quality.applyToLight(this.sun);
    this.scene.add(this.sun);
  }
}
