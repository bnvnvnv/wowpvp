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
  TEAM_RED,
  Targeting,
  createMovementState,
  getSkill,
  needsGroundPlacement,
  resolveGroundPlacement,
  usesNoTarget,
  type CombatEntity,
  type EntityId,
  type GroundAreaSnapshot,
  type MapDef,
  type EntitySnapshot,
  type MovementInput,
  type ProjectileSnapshot,
  type ServerMessage,
  type SkillDef,
  type TeamId,
} from '@wowpvp/shared';

import { CameraController } from '../camera/CameraController.js';
import { AnimationController } from '../entity/AnimationController.js';
import { CharacterView } from '../entity/CharacterView.js';
import { ModelLibrary } from '../entity/ModelLibrary.js';
import { Action, InputManager, type FrameInput } from '../input/InputManager.js';
import { DecorRenderer } from '../render/DecorRenderer.js';
import { GameLoop } from '../render/GameLoop.js';
import { MapRenderer } from '../render/MapRenderer.js';
import { QualityController } from '../render/QualityController.js';
import { QualityTier } from '../render/quality.js';
import { Environment } from '../render/Environment.js';
import { Connection, type NetLink } from '../net/Connection.js';
import { Interpolator } from '../net/Interpolator.js';
import { Predictor } from '../net/Predictor.js';
import { pickTabTargetFromSnapshot } from '../net/snapshotTargeting.js';
import { CombatHud } from '../hud/CombatHud.js';
import { SnapshotCombatView, castStateFromStarted } from '../net/SnapshotCombatView.js';
import { audio } from '../audio/AudioManager.js';
import { FAIL_TEXT } from '../combat/CombatDirector.js';
import { AimingController, type AimInput } from '../targeting/AimingController.js';
import { DirectionIndicator } from '../targeting/DirectionIndicator.js';
import { GroundIndicator, screenToGround } from '../targeting/GroundIndicator.js';
import { SpellVfx, type CastView, type SpellVfxStatus } from '../vfx/SpellVfx.js';
import { StatusMarkers } from '../vfx/StatusMarkers.js';
import { TargetRing } from '../vfx/TargetRing.js';
import { strongestShield, type ControlKind } from '../vfx/status.js';
import { visualForAuraId, visualForSchool } from '../vfx/schools.js';
import {
  DEFAULT_ACCESSIBILITY,
  loadAccessibility,
  paletteFor,
  saveAccessibility,
  type AccessibilitySettings,
} from '../settings/accessibility.js';
import { artEnabled } from '../settings/artMode.js';
import { HitStop } from '../render/HitStop.js';
import { HitFeedback } from '../feedback/HitFeedback.js';

/** 技能栏槽位数。快捷键只有 1–8，职业技能多于 8 个时其余仅在 HUD 里可见 */
const SKILL_SLOT_COUNT = 8;

/** 8.2「迷惑」链的光环 id（`control.${kind}`，见 shared/sim/effects/combat.ts）*/
const MORPH_AURA_ID = 'control.incapacitate';

export interface NetworkSceneOptions {
  url: string;
  roomId: string;
  name: string;
  team: 'red' | 'blue';
  classId: string;
  /**
   * M13：大厅注入的既有连接（`lobby/LobbyShell`）。给了它就意味着：
   *   · 场景**不**自建 Connection、不 connect、不 close —— 连接生命周期归大厅
   *   · 不自动 joinRoom —— 房间流程（建房/选边/选职业/准备）大厅已经走完
   *   · 服务器消息由大厅路由进来（`deliver()`），场景只消费战斗阶段那部分
   * 不给则是 `?net=` 老路：自建连接 + 四连发进房，行为与 M10 起完全一致。
   */
  link?: NetLink;
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
  /** 14.2 特效自检（`?art=off` 时 undefined）*/
  vfx: SpellVfxStatus | undefined;
  /**
   * 最近的存活敌人的水平距离，米；看不见任何敌人时 undefined。
   * M13：verify:m13 靠它判断「走到射程内了没」—— 只读快照里本来就有的数据
   */
  nearestEnemy: number | undefined;
  /**
   * 施法注册表自检。★ 存在的理由很具体：`playerCast` 曾经是一个
   * **声明了但全仓库无人赋值**的字段，四条施法条一起死了却没有任何断言发现 ——
   * 现在 `verify:m13` 盯着 `casting.self`。
   */
  casting: { self: boolean; total: number };
  /**
   * 14.3 护盾四态自检。★ 联网侧此前**一份数据都没有**（协议不带吸收量），
   * 现在 M16d 补上了 —— 这两个数就是「补上了没有」的可执行证据。
   */
  shields: { visible: number; absorbs: number; breaks: number };
  /**
   * 最近 0.5 秒的平均帧率。
   *
   * ★★ 联网路径此前**完全没有任何帧率读数** —— 而 12v12 恰恰是最坏情况所在，
   *   `#stats` 面板只在试验场渲染。零新增计算（`GameLoop` 本来就在算）。
   * ★ 不作为验收判据，理由同 `TestbedScene.artStatus.fps`。
   */
  fps: number;
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
  /** 收发用的连接（自建或大厅注入的，见 NetworkSceneOptions.link）*/
  private readonly conn: NetLink;
  /** 只有自建连接才由场景负责 connect/close；注入的归大厅管 */
  private readonly ownConn: Connection | undefined;
  /** ★ 与试验场**同一个** HUD 类，喂的是快照视图而不是 CombatDirector */
  private readonly hud: CombatHud;
  private readonly view = new SnapshotCombatView();
  /** 打击感：顿帧 + 反馈编排 + 可访问性（此前联网侧从不加载设置）*/
  private readonly hitStop = new HitStop();
  private feedback!: HitFeedback;
  private access: AccessibilitySettings = DEFAULT_ACCESSIBILITY;

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

  /** 14.2：八属性技能特效。★ 只在 `?art=on` 时构造，与试验场同一门禁 */
  private readonly spellVfx: SpellVfx | undefined;
  /** 14.3：控制状态标记，按实体 id（含自己）。数据来自快照的 DisplayFlags */
  private readonly statusMarkers = new Map<number, StatusMarkers>();
  /** 最近一份快照里的投射物与地面区域（14.4/14.3 关键元素）*/
  private lastProjectiles: readonly ProjectileSnapshot[] = [];
  private lastGrounds: readonly GroundAreaSnapshot[] = [];
  /** 场景经过的总时间，驱动标记动画 */
  private elapsed = 0;

  /** M3 瞄准流程（5.4 / 5.5），与试验场同一套控件 */
  private readonly aim = new AimingController();
  private readonly groundIndicator = new GroundIndicator();
  private readonly directionIndicator = new DirectionIndicator();
  private readonly ndc = new THREE.Vector2();
  private clickFlags = { left: false, right: false };

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
    // 5.5 瞄准指示器（关键 UI，不受 art 门禁）
    this.scene.add(this.groundIndicator.group, this.directionIndicator.group);
    // 14.2 特效层：与试验场同一门禁、同一实现
    if (this.art) {
      this.spellVfx = new SpellVfx();
      this.scene.add(this.spellVfx.group);
    }
    canvas.addEventListener('mousemove', this.onCanvasMouseMove);
    canvas.addEventListener('mousedown', this.onCanvasMouseDown);
    this.addLights();
    // M12：环境光与天空。★ 纯加法，见 Environment.ts 文件头
    this.env = new Environment(this.renderer, this.scene);
    if (this.art) this.env.apply(this.quality.current, { preset: 'day' });

    this.cam = new CameraController(canvas.clientWidth / canvas.clientHeight);
    this.input = new InputManager(canvas);
    this.hud = new CombatHud(canvas.parentElement ?? document.body);
    /**
     * 17.2：联网场景此前**从不加载**持久化的可访问性设置（只有试验场加载）——
     * 色盲模式/关伤害数字在联网对局里每次都回到默认。打击感改造顺手补上：
     * 震动/顿帧的开关要在联网侧生效，这一步是前提。
     */
    this.setAccessibility(loadAccessibility(globalThis.localStorage));

    // 打击感：命中反馈统一编排（与试验场同一个类、同一份分档判据）
    this.feedback = new HitFeedback({
      selfId: () => this.selfId ?? undefined,
      headOf: (id) => this.headOf(id),
      audioAt: (id) => this.audioDistance(id),
      viewOf: (id) => this.viewOfEntity(id),
      floaters: {
        push: (text, kind, at, opts) => this.hud.floaters.push(text, kind, at, opts),
      },
      flashScreen: () => this.hud.flashScreen(),
      vfxDamage: (e) =>
        this.spellVfx?.onCombatEvent({ t: 'damage', ...e }, (id) => this.bodyOf(id)),
      // 14.3 护盾承伤/破裂（与试验场同一编排入口）
      shieldMarkerOf: (id) => this.statusMarkers.get(id as number),
      addTrauma: (t) => this.cam.addTrauma(t),
      hitStop: this.hitStop,
      audio,
      access: () => this.access,
    });
    // 点姓名板选人 → 发 SetTarget（服务器仍会校验可见集合）
    this.view.onSelect = (id) => {
      this.currentTargetId = id;
      this.view.targetId = id;
      this.conn.send({ t: 'SetTarget', slot: 'hard', entityId: id });
    };

    if (opts.link) {
      // M13 大厅流程：借用大厅的连接，消息经 deliver() 进来
      this.conn = opts.link;
      this.ownConn = undefined;
    } else {
      const own = new Connection(opts.url, {
        onMessage: (m) => this.onMessage(m),
        onOpen: (resumed) => { if (!resumed) this.joinRoom(); },
        onClose: () => { /* Connection 自己退避重连 */ },
      });
      this.conn = own;
      this.ownConn = own;
    }

    /**
     * ★ 固定步长默认就是 `SIM.TICK_DT` —— 也就是**指令帧**。
     *   `simulate()` 因此每 50ms 跑一次：采样、预测、发一条 Input。
     *   这正是 A3 收尾定下的契约，两端同一步长，预测才可能精确收敛。
     */
    this.loop = new GameLoop(
      (dt) => this.simulate(dt),
      (alpha, dt, realDt) => this.draw(alpha, dt, realDt),
      (dt) => this.readInput(dt),
      undefined,
      // 顿帧：只缩放渲染 dt（模拟步/输入/插值时钟不受影响，docs/08 §5）
      (realDt) => this.hitStop.scale(realDt),
    );

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  start(): void {
    audio.install();
    this.ownConn?.connect();
    this.loop.start();
  }

  /** 17.2：应用并持久化可访问性设置（与试验场同形的唯一入口）*/
  setAccessibility(next: AccessibilitySettings): void {
    this.access = next;
    this.hud.applyAccessibility(next);
    this.cam.setAccessibility(next);
    this.hitStop.enabled = next.hitStop;
    saveAccessibility(globalThis.localStorage, next);
  }

  get accessibility(): AccessibilitySettings {
    return this.access;
  }

  dispose(): void {
    this.loop.stop();
    this.ownConn?.close();
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('mousemove', this.onCanvasMouseMove);
    this.canvas.removeEventListener('mousedown', this.onCanvasMouseDown);
    this.env.dispose();
    this.spellVfx?.dispose();
    this.renderer.dispose();
  }

  private onCanvasMouseMove = (ev: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
  };

  private onCanvasMouseDown = (ev: MouseEvent): void => {
    // 5.5：左键确认落点、右键取消 —— 只喂给瞄准状态机
    if (ev.button === 0) this.clickFlags.left = true;
    if (ev.button === 2) this.clickFlags.right = true;
  };

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
      vfx: this.spellVfx?.status(),
      nearestEnemy: this.nearestEnemyDistance(),
      casting: {
        self: this.view.playerCast !== undefined,
        total: this.view.activeCasts().length,
      },
      shields: {
        visible: [...this.statusMarkers.values()].filter((m) => m.shieldVisible).length,
        absorbs: this.feedback.shieldAbsorbsSeen,
        breaks: this.feedback.shieldBreaksSeen,
      },
      fps: this.loop.fps,
    };
  }

  /** 最近存活敌人的水平距离。只读快照数据 —— 看不见的人本来就不在快照里 */
  private nearestEnemyDistance(): number | undefined {
    if (!this.predictor || this.selfTeam === null) return undefined;
    const me = this.predictor.position;
    let best: number | undefined;
    for (const e of this.lastEntities) {
      if (e.id === this.selfId || e.team === this.selfTeam || !e.alive) continue;
      const d = Math.hypot(e.position.x - me.x, e.position.z - me.z);
      if (best === undefined || d < best) best = d;
    }
    return best;
  }

  /**
   * M13：大厅路由过来的服务器消息入口（只在注入 link 的场景上使用）。
   * 与自建连接的 onMessage 是同一个消费函数 —— 两条流程不允许有两套解读。
   */
  deliver(msg: ServerMessage): void {
    this.onMessage(msg);
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
        // 14.4 投射物 / 14.3 地面区域：留给 draw 里的 spellVfx.frame 消费
        this.lastProjectiles = msg.projectiles;
        this.lastGrounds = msg.grounds;
        this.selfTeam = msg.entities.find((e) => e.id === msg.you)?.team ?? this.selfTeam;
        this.view.ingest(
          {
            tick: msg.tick, you: msg.you, entities: msg.entities,
            projectiles: msg.projectiles, grounds: msg.grounds, match: msg.match,
          },
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
        /**
         * 打击感改造：整段交给 HitFeedback（与试验场同一编排、同一分档判据）。
         * ★ 顺手修掉旧不一致：flashHit 此前只给自己（:386），现在所有可见
         *   目标都闪 —— 与试验场一致。
         * 联网侧的 crit/overkill 来自协议（PR-B），maxHealth 从快照查。
         */
        this.feedback.onHit({
          targetId: msg.targetId, sourceId: msg.sourceId,
          amount: msg.amount, absorbed: msg.absorbed, immune: msg.immune,
          crit: msg.crit === true, overkill: msg.overkill, school: msg.school,
          targetMaxHealth: this.lastEntities.find((e) => e.id === msg.targetId)?.maxHealth,
        });
        this.view.push(`${this.nameOf(msg.sourceId)} → ${this.nameOf(msg.targetId)} ${msg.amount} 点伤害`, 'ok');
        break;
      }
      case 'Heal': {
        audio.play('heal_impact', this.audioDistance(msg.targetId));
        this.feedback.onHeal({
          targetId: msg.targetId, amount: msg.amount, crit: msg.crit === true,
        });
        this.spellVfx?.onCombatEvent(
          { t: 'heal', targetId: msg.targetId, amount: msg.amount },
          (id) => this.bodyOf(id),
        );
        this.view.push(`${this.nameOf(msg.sourceId)} 治疗 ${this.nameOf(msg.targetId)} ${msg.amount} 点`, 'ok');
        break;
      }
      case 'Death': {
        audio.playVariant('death', this.audioDistance(msg.entityId));
        // 7.3：死亡终止一切施法。服务器不会为此再发一条 CastInterrupted
        this.view.endCast(msg.entityId);
        this.spellVfx?.onCombatEvent(
          { t: 'death', targetId: msg.entityId },
          (id) => this.bodyOf(id),
        );
        // 打击感：自己死 = 大创伤 + 顿帧；附近死亡按距离微量创伤
        this.feedback.onDeath({
          entityId: msg.entityId, killerId: msg.killerId,
          distance: this.audioDistance(msg.entityId).distance,
        });
        this.view.push(`${this.nameOf(msg.entityId)} 被击杀`, 'interrupt');
        break;
      }
      case 'CastFailed':
        audio.play('ui_error', { group: 'ui', volume: 0.5 });
        this.view.push(`施法失败：${FAIL_TEXT[msg.reason] ?? msg.reason}`, 'fail');
        break;
      case 'CastStarted': {
        audio.playCast(msg.school, { ...this.audioDistance(msg.casterId), volume: 0.7 });
        // ★ 施法注册表：HUD 的四条施法条与 14.1「预备」阶段的蓄力法阵同吃这一份
        this.view.beginCast(msg.casterId, castStateFromStarted(msg, this.serverTime));
        // 14.1 预备：读条起手 pop（持续蓄力由 frame() 的 casts 驱动）
        const caster = this.casterLike(msg.casterId);
        if (caster) this.spellVfx?.onCast('started', caster, getSkill(msg.skillId));
        break;
      }
      /**
       * 14.1「释放」/ 14.2 弹体 / 13.3 挥砍 —— 与试验场的 onCastActivity('resolved')
       * 完全同一套消费逻辑，只是数据来自协议消息。
       * ★ `casterId` 可能被服务器抹掉（施法者对我不可见）：没有起点就没有
       *   释放 pop 和弹体，目标身上的到位表现仍由 Damage/AuraApplied 驱动。
       */
      case 'CastResolved': {
        /**
         * ★ 无条件出注册表：引导技能的 `CastResolved` 是在**引导结束**才发的
         *   （`casting.ts` 的 channel 分支只在 `world.time >= channelEndsAt` 才
         *   调 onCompleted），所以这里不需要「引导例外」分支。
         * ⚠️ `casterId` 可空（施法者不可见），那条路径靠 `pruneCasts` 超时兜底。
         */
        if (msg.casterId !== undefined) this.view.endCast(msg.casterId);
        const skill = getSkill(msg.skillId);
        if (!skill) break;
        const caster = this.casterLike(msg.casterId);
        if (caster) {
          // ★ track 闭包按 id 查**渲染中**的位置 —— 弹体追着插值后的角色飞
          const targets = msg.targetIds
            .map((id) => {
              const base = this.bodyBaseOf(id);
              return base ? { ...base, track: () => this.bodyOf(id) } : undefined;
            })
            .filter((t): t is NonNullable<typeof t> => t !== undefined);
          this.spellVfx?.onCast('resolved', caster, skill, targets);
          // 近战挥砍（与试验场同一判据：直接目标 + 6.1 近战档射程）
          if (skill.targeting === Targeting.Direct && skill.range.max < 8 && msg.casterId !== undefined) {
            this.viewOfEntity(msg.casterId)?.playMeleeSwing();
            // 挥砍破空声（与试验场同款）
            audio.playVariant('swing', { volume: 0.55, ...this.audioDistance(msg.casterId) });
          }
        }
        break;
      }
      case 'CastInterrupted': {
        audio.play('ui_error', {
          group: 'ui',
          volume: msg.casterId === this.selfId ? 0.9 : 0.5,
        });
        /**
         * ★ `CastInterrupted` **不带 skillId** —— 想知道被打断的是什么法术，
         *   只能从注册表回捞。这也是注册表除了施法条之外的第二个用处。
         */
        const st = this.view.castOfId(msg.casterId);
        const caster = this.casterLike(msg.casterId);
        if (st && caster) this.spellVfx?.onCast('interrupted', caster, getSkill(st.skillId));
        this.view.endCast(msg.casterId);
        break;
      }
      case 'AuraApplied':
        audio.play('buff_apply', { ...this.audioDistance(msg.targetId), volume: 0.5 });
        // 纯光环技能的到位反馈（化形术等）。control.* 在 SpellVfx 内部安静跳过
        this.spellVfx?.onCombatEvent(
          { t: 'auraApplied', targetId: msg.targetId, auraId: msg.auraId },
          (id) => this.bodyOf(id),
        );
        break;
      case 'AuraRemoved':
        if (msg.reason === 'shieldBroken') {
          this.spellVfx?.onCombatEvent(
            { t: 'shieldBroken', targetId: msg.targetId, auraId: msg.auraId },
            (id) => this.bodyOf(id),
          );
          // 14.3 护盾破裂（四态之一）—— 与试验场的 sim 事件走同一个编排入口
          this.feedback.onShieldBroken({ targetId: msg.targetId });
        }
        break;

      case 'MatchEnd': {
        /**
         * M13：对局结束就停手 —— 服务器紧接着会把 session 放回 Room 阶段，
         * 再发 Input/CastRequest 只会换来一串「当前阶段不接受」的拒绝刷屏
         * （此前这条消息落在 default，客户端每 50ms 发一条 Input 被拒一条）。
         * 画面何时切走由上层决定：大厅流程回房间页，`?net=` 老路停在结算日志。
         */
        this.started = false;
        this.view.push(
          msg.winner === 'draw'
            ? '对局结束：平局'
            : `对局结束：${msg.winner === TEAM_RED ? '红方' : '蓝方'}获胜`,
          'interrupt',
        );
        break;
      }

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
    if (this.art) {
      void this.mapRenderer.applyGroundTexture('stone');
      // 地图装饰摆设（纯表现，sim 不读 —— 见 DecorRenderer 文件头）
      if (map.decor) {
        this.decorRenderer = new DecorRenderer(map.decor);
        this.decorRenderer.applyQuality(this.quality.current);
        this.scene.add(this.decorRenderer.group);
      }
    }
  }
  private decorRenderer: DecorRenderer | undefined;

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
      this.decorRenderer?.applyQuality(tier);
    }
    if (input.pressed.has(Action.ToggleMute)) {
      console.info(`[音频] ${audio.toggleMute() ? '已静音' : '已取消静音'}`);
    }
    if (this.started) audio.playMusic('combat_1');
    // 5.3：Tab 正序、Shift+Tab 反序
    if (input.pressed.has(Action.TargetNext)) this.tabTarget(false);
    if (input.pressed.has(Action.TargetPrev)) this.tabTarget(true);

    // ── 施法（1–8 键 + 5.5 瞄准流程）。★ 只发**意图**，结算全在服务器 ──
    let pressedSlot: number | null = null;
    for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
      if (input.pressed.has(`skill${i + 1}` as Action)) pressedSlot = i;
    }
    if (pressedSlot !== null) {
      this.hud.pulseSlot(pressedSlot);
      audio.play('ui_click', { group: 'ui', volume: 0.35 });
    }
    const aimInput: AimInput = {
      pressedSlot,
      releasedSlot: null,
      leftClick: this.clickFlags.left,
      rightClick: this.clickFlags.right,
      escape: input.pressed.has(Action.CancelCast),
    };
    this.clickFlags.left = false;
    this.clickFlags.right = false;

    const ev = this.aim.update(aimInput, (slot) => this.view.skills[slot]);
    if (ev.type === 'confirm') this.sendCast(ev.skill);

    // 7.5 假读条：Esc 在没有瞄准时用于取消读条（服务器结算取消）
    if (input.pressed.has(Action.CancelCast) && ev.type !== 'cancel') {
      this.conn.send({ t: 'CancelCast' });
    }
  }

  /**
   * 把一次确认的施法意图发给服务器。
   * ★ 与试验场 `castSlot` 同构：地面技能带落点（先做与指示器同源的合法性
   *   预检，5.5 / 验收 #8），方向技能带 facing，其余带当前目标。
   *   服务器仍会用同一个 `validateCast` 再验一遍 —— 这里的预检只是 UI 判据。
   */
  private sendCast(skill: SkillDef): void {
    if (needsGroundPlacement(skill)) {
      const ground = screenToGround(this.cam.camera, this.ndc, this.predictor?.position ?? { x: 0, y: 0, z: 0 });
      if (!ground) return;
      const placement = this.resolveGround(skill, { x: ground.x, y: 0, z: ground.z });
      if (!placement.legal) {
        this.view.push(`${skill.name} 落点非法：${FAIL_TEXT[placement.reason]}`, 'fail');
        return;
      }
      this.conn.send({ t: 'CastRequest', skillId: skill.id, groundPoint: placement.center });
      return;
    }
    if (usesNoTarget(skill)) {
      // 方向技能沿**角色**朝向（6.5），协议里就是为它留的 facing 字段
      this.conn.send({ t: 'CastRequest', skillId: skill.id, facing: this.characterYaw });
      return;
    }
    this.conn.send({
      t: 'CastRequest',
      skillId: skill.id,
      ...(this.currentTargetId !== undefined ? { targetId: this.currentTargetId } : {}),
    });
  }

  /**
   * 5.5 落点解算 —— 与指示器同一个函数（shared 的 `resolveGroundPlacement`），
   * 「指示器显示合法 → 按下去却失败」因此不可能发生（验收 #8）。
   * ★ 传给它的 caster 只读 `position`，用预测位置拼一个最小形状即可。
   */
  private resolveGround(skill: SkillDef, requested: { x: number; y: number; z: number }) {
    const caster = { position: this.predictor?.position ?? { x: 0, y: 0, z: 0 } } as CombatEntity;
    return resolveGroundPlacement(caster, requested, skill, this.map?.geometry ?? [], this.map?.bounds);
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

  /** 某实体的 3D 视图（自己或远端）*/
  private viewOfEntity(id: EntityId): CharacterView | undefined {
    return id === this.selfId ? this.selfView : this.views.get(id as number);
  }

  /**
   * 某实体**渲染中**的脚底位置（自己=预测位置，远端=插值后的视图位置）。
   * ★ 用渲染位置而不是快照原始位置 —— 快照 20Hz 一跳，角色是平滑的，
   *   爆发落在快照坐标会看起来「炸偏了半步」。不在场（不可见）返回 undefined。
   */
  private baseOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    if (id === this.selfId && this.predictor) return { ...this.predictor.position };
    const v = this.views.get(id as number);
    if (v) return { x: v.group.position.x, y: v.group.position.y, z: v.group.position.z };
    const e = this.lastEntities.find((x) => x.id === id);
    return e ? { ...e.position } : undefined;
  }

  /** 躯干中部：命中粒子爆发的锚点（14.2）*/
  private bodyOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    const p = this.baseOf(id);
    return p ? { x: p.x, y: p.y + GEOMETRY.HITBOX_HEIGHT * 0.5, z: p.z } : undefined;
  }

  /** 弹体目标视图：位置 + 身高（SpellVfx.onCast 的 targets 形状）*/
  private bodyBaseOf(id: EntityId): { position: { x: number; y: number; z: number }; height: number } | undefined {
    const p = this.baseOf(id);
    return p ? { position: p, height: GEOMETRY.HITBOX_HEIGHT } : undefined;
  }

  /** 施法者视图：位置 + 身高 + 朝向（释放点要沿朝向前移，见 SpellVfx.onCast）*/
  private casterLike(
    id: EntityId | undefined,
  ): {
    position: { x: number; y: number; z: number }; height: number; yaw: number; id: number;
  } | undefined {
    if (id === undefined) return undefined;
    const p = this.baseOf(id);
    if (!p) return undefined;
    const yaw = id === this.selfId
      ? this.characterYaw
      : this.lastEntities.find((e) => e.id === id)?.yaw ?? 0;
    // ★ 带上 id：打断/释放时 SpellVfx 据此立刻摘掉这个人的蓄力法阵
    return { position: p, height: GEOMETRY.HITBOX_HEIGHT, yaw, id: id as number };
  }

  /**
   * 施法注册表 → `CastView`（14.1「预备」的数据源）。
   * ★ 位置走 `baseOf`：自己用预测位置、别人用插值后的渲染位置 ——
   *   法阵贴在**看得见的那个人**脚下，而不是快照里那个还没插值到的位置。
   */
  private castViews(): CastView[] {
    const out: CastView[] = [];
    for (const [id, st] of this.view.activeCasts()) {
      const p = this.baseOf(id);
      if (!p) continue; // 看不见的人（潜行/离场）不画 —— 与协议的裁剪同向
      const yaw = id === this.selfId
        ? this.characterYaw
        : this.lastEntities.find((e) => e.id === id)?.yaw ?? 0;
      out.push({
        id: id as number,
        skillId: String(st.skillId),
        position: p,
        height: GEOMETRY.HITBOX_HEIGHT,
        yaw,
        startedAt: st.startedAt,
        endsAt: st.endsAt,
        ...(st.channelEndsAt !== undefined ? { channelEndsAt: st.channelEndsAt } : {}),
      });
    }
    return out;
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

  /**
   * `dt` 是渲染时钟（顿帧时被缩放），`realDt` 是真实时钟。
   * ★★ serverTime **必须**走 realDt —— 它是插值取样的钟，被顿帧拖慢会让
   *   取样落后于缓冲，解冻时全场角色猛跳一步。AnimationController 同理
   *   （distance/dt 的表观速度会暴涨，见 GameLoop 的注释）。
   */
  private draw(_alpha: number, dt: number, realDt: number): void {
    // 服务器时间自己走，收到快照时校准 —— 插值要按它取样
    this.serverTime += realDt;
    this.elapsed += realDt;
    this.feedback.update(realDt);

    this.drawSelf(dt, realDt);
    this.drawRemotes(dt, realDt);
    this.updateTargetRing();
    this.updateIndicators();

    // 施法注册表兜底清理（超时 / 施法者离场），必须在读它之前
    this.view.pruneCasts(
      this.serverTime,
      (id) => this.lastEntities.some((e) => (e.id as number) === id),
    );

    // 14.2/14.3/14.4：投射物主体、地面边界、粒子池 —— 数据来自最近的快照。
    // ★ 快照类型与 SpellVfx 的表现视图字段兼容，直接喂，不做拷贝
    this.spellVfx?.frame(dt, {
      quality: this.quality.current,
      cameraDistance: this.cam.distance,
      pointScale:
        this.canvas.clientHeight /
        (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360)),
      // 快照的 impactAt 是服务器时钟 —— now 用同一个钟（收快照时校准）
      now: this.serverTime,
      cameraPosition: this.cam.camera.position,
      // 14.1「预备」：数据来自施法注册表（快照里没有施法字段，协议用事件表达）
      casts: this.castViews(),
      projectiles: this.lastProjectiles,
      grounds: this.lastGrounds,
    });

    this.renderer.render(this.scene, this.cam.camera);
    // ★ 与试验场同一个调用 —— 只是喂的 CombatView 实现不同
    this.hud.update(this.view, this.cam.camera, this.canvas, dt);
  }

  /**
   * 5.5 瞄准指示器 —— 与试验场同一套控件与文案。
   * 边界与合法性来自 shared 的 `resolveGroundPlacement`（验收 #8 的同源保证）。
   */
  private updateIndicators(): void {
    const skill = this.aim.pendingSkill;
    if (!skill) {
      this.groundIndicator.hide();
      this.directionIndicator.hide();
      this.hud.setAimHint(null, false);
      return;
    }
    const selfPos = this.predictor?.position ?? { x: 0, y: 0, z: 0 };
    if (skill.targeting === 'ground') {
      const ground = screenToGround(this.cam.camera, this.ndc, selfPos);
      if (!ground) {
        this.groundIndicator.hide();
        this.hud.setAimHint(`${skill.name}：把鼠标移到地面上选择落点`, true);
        return;
      }
      const placement = this.resolveGround(skill, { x: ground.x, y: 0, z: ground.z });
      this.groundIndicator.show(placement, selfPos);
      this.directionIndicator.hide();
      this.hud.setAimHint(
        placement.legal
          ? `${skill.name}：左键确认${placement.clamped ? `（已钳制到 ${placement.maxRange} 米边缘）` : ''}`
          : `${skill.name}：${FAIL_TEXT[placement.reason]}`,
        !placement.legal,
      );
    } else {
      this.groundIndicator.hide();
      // ★ 角色 yaw，不是镜头 yaw（5.4）
      this.directionIndicator.show(skill.shape, selfPos, this.characterYaw);
      this.hud.setAimHint(`${skill.name}：沿角色面向释放`, false);
    }
  }

  private drawSelf(dt: number, realDt: number): void {
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
      dt: realDt, // ★ 状态机时钟（见 draw 头注）
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
      // 8.2「迷惑」= 被变形（快照 auras 是权威，重连也不丢）
      this.selfView.setMorphed(meSnap.auras.some((a) => a.auraId === MORPH_AURA_ID));
      this.updateMarkersFor(meSnap, this.selfView);
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

  private drawRemotes(dt: number, realDt: number): void {
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
        dt: realDt, // ★ 状态机时钟（见 draw 头注）
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
      // 8.2「迷惑」= 被变形；14.3 控制标记 —— 都从快照读，与试验场同一套表现
      view.setMorphed(e.snapshot.auras.some((a) => a.auraId === MORPH_AURA_ID));
      this.updateMarkersFor(e.snapshot, view);
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
      this.statusMarkers.delete(id); // 标记挂在 view.group 里，随组一起移除
    }
  }

  /**
   * 14.3：控制状态标记（定身/昏迷/沉默/恐惧/缴械）+ 护盾四态。
   * ★ 与试验场同一个 StatusMarkers 类、同一套「恐惧优先于昏迷」的区分逻辑，
   *   护盾也走同一个 `strongestShield()` 判据 —— 两条路不会各写一遍。
   * ★ 护盾数据来自快照新增的 `absorbRemaining/absorbInitial`（M16d 协议债，
   *   此前这里只能如实不画）。
   */
  private updateMarkersFor(snap: EntitySnapshot, view: CharacterView): void {
    let m = this.statusMarkers.get(snap.id as number);
    if (!m) {
      m = new StatusMarkers();
      view.group.add(m.group);
      this.statusMarkers.set(snap.id as number, m);
    }
    /**
     * 控制标记 + **施加者的学派色**。
     * ★ 与试验场同一条判据：学派从快照的 `AuraSnapshot.school` 读
     *   （控制光环的 id 是 `control.<kind>`，反查不回技能，所以协议带了这一个字段）。
     *   两条路都退回 `CONTROL_VISUALS` 的中性常量 —— 不会出现
     *   「单机是冰蓝的、联机是灰的」这种漂移。
     */
    const schoolOf = (kind: string): number | undefined => {
      const a = snap.auras.find((x) => x.auraId === `control.${kind}`);
      return a?.school ? visualForSchool(a.school).primary : undefined;
    };
    const active = new Map<ControlKind, number | undefined>();
    if (snap.flags.feared) active.set('feared', schoolOf('fear'));
    else if (snap.flags.stunned) active.set('stunned', schoolOf('stun'));
    if (snap.flags.rooted) active.set('rooted', schoolOf('root'));
    if (snap.flags.silenced) active.set('silenced', schoolOf('silence'));
    if (snap.flags.disarmed) active.set('disarmed', schoolOf('disarm'));
    m.update(active, this.quality.current, this.cam.distance, SIM.TICK_DT, this.elapsed);

    const shield = strongestShield(snap.auras);
    m.setShield(
      shield?.remaining, shield?.initial ?? 1, this.cam.distance,
      shield ? visualForAuraId(shield.auraId)?.primary : undefined,
    );
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
