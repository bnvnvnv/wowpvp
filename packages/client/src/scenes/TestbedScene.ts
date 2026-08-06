/**
 * M1 试验场。把镜头、输入、移动物理、动作状态机接在一起，
 * 让规格书 4.x / 13.x 的每一条规则都能被**肉眼验证**。
 *
 * 这是 M1 的验收载体：验收 #1 / #2 / #3 / #44 / #45 / #47 都在这里人工确认。
 */

import * as THREE from 'three';
import {
  DrCategory,
  GEOMETRY,
  MOVE,
  Targeting,
  aurasOf,
  createMovementState,
  distance2D,
  stepMovement,
  moveSpeedMultiplierOf,
  separationVelocity,
  SPAWN_PROTECTION_AURA,
  teleportTo,
  mage as mageClass,
  type Aabb,
  type ClassDef,
  type CombatEvent,
  type EntityId,
  type MovementState,
} from '@wowpvp/shared';

import { CameraController } from '../camera/CameraController.js';
import { CombatDirector, PLAYER_SKILL_IDS } from '../combat/CombatDirector.js';
import { SKILL_BAR_SLOTS, assignSlot, loadSkillBar, saveSkillBar } from '../settings/skillLoadout.js';
import { TESTBED_STAGE, type Stage } from './stages.js';
import { TutorialDirector } from '../tutorial/TutorialDirector.js';
import { TutorialHud } from '../tutorial/TutorialHud.js';
import { AnimationController } from '../entity/AnimationController.js';
import { CharacterView } from '../entity/CharacterView.js';
import { CombatHud } from '../hud/CombatHud.js';
import { partyViewOf } from '../hud/PartyFrame.js';
import { SettingsPanel, rebindableActions, prettyKey } from '../settings/SettingsPanel.js';
import { makeRebindController } from '../settings/keybindings.js';
import { MusicDirector, ambientTrackFor } from '../audio/MusicDirector.js';
import { presetOf } from '../render/Environment.js';
import { FAIL_TEXT } from '../combat/CombatDirector.js';
import { Action, InputManager, type FrameInput } from '../input/InputManager.js';
import { DecorRenderer } from '../render/DecorRenderer.js';
import { GameLoop } from '../render/GameLoop.js';
import { HitStop } from '../render/HitStop.js';
import { HitFeedback } from '../feedback/HitFeedback.js';
import { MapRenderer } from '../render/MapRenderer.js';
import { AimingController, type AimInput } from '../targeting/AimingController.js';
import { DirectionIndicator } from '../targeting/DirectionIndicator.js';
import { GroundIndicator, screenToGround } from '../targeting/GroundIndicator.js';
import { QualityController } from '../render/QualityController.js';
import { Environment } from '../render/Environment.js';
import { SceneShell } from './SceneShell.js';
import {
  ColorblindMode,
  DEFAULT_ACCESSIBILITY,
  loadAccessibility,
  paletteFor,
  saveAccessibility,
  type AccessibilitySettings,
} from '../settings/accessibility.js';
import { SpectateController } from '../spectate/SpectateController.js';
import { audio } from '../audio/AudioManager.js';
import { playCastActivity, playCombatEvent, type CombatAudioDeps } from '../audio/combatAudio.js';
import { StatusMarkers } from '../vfx/StatusMarkers.js';
import { SpellVfx, type CastView } from '../vfx/SpellVfx.js';
import { TargetRing } from '../vfx/TargetRing.js';
import { CtfDemo } from '../combat/CtfDemo.js';
import type { MinimapBlip } from '../hud/ModeHud.js';
import { FlagMarkers } from '../vfx/FlagMarkers.js';
import type { ControlKind } from '../vfx/status.js';
import { visualForAuraId, visualForSchool } from '../vfx/schools.js';

/** 技能栏槽位数，与 CombatDirector 的 PLAYER_SKILL_IDS 长度一致 */
/**
 * 技能栏槽位数，与 `CombatDirector` 的 `PLAYER_SKILL_IDS` 长度一致。
 * ★ 8 → 9：加了「霜甲护盾」让玩家能看见**自己的**护盾四态
 *   （此前 8 格里没有任何吸收技能，`shieldOf(player)` 恒为 null ——
 *   14.3 的四态玩家只能在假人身上看到，看不到自己的）。
 *   前 8 格的顺序与按键**完全没动**，所有按数字键的 verify 脚本不受影响。
 */
const SKILL_SLOT_COUNT = 9;

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
  /**
   * P2 压测读数（渲染负载）。★ 恒发不额外算 —— `renderer.info` 是 three
   * 每帧自己在统计的；压测面板显示它，普通试验场面板照旧不显示。
   */
  render?: {
    calls: number;
    triangles: number;
    entities: number;
    quality: string;
  };
}

export class TestbedScene {
  /** G4：renderer/画质/环境/镜头/输入/resize 都在壳里，场景只经 getter 转发 */
  private readonly shell: SceneShell;
  private get renderer(): THREE.WebGLRenderer { return this.shell.renderer; }
  private get scene(): THREE.Scene { return this.shell.scene; }
  private get cam(): CameraController { return this.shell.cam; }
  private get input(): InputManager { return this.shell.input; }
  private readonly loop: GameLoop;
  private readonly mapRenderer: MapRenderer;
  private readonly view = new CharacterView();
  private readonly anim = new AnimationController();
  private readonly obstacles: readonly Aabb[];
  /** M2：战斗模拟与 HUD */
  private readonly combat: CombatDirector;
  private readonly hud: CombatHud;
  /** W9：设置面板（F10）*/
  private readonly settings: SettingsPanel;
  /** W13：BGM 随战斗状态切换（氛围曲按地图配，见 MAP_AMBIENT_TRACK）*/
  private readonly musicDir: MusicDirector;
  /** 场上其他战斗实体的可视化 */
  private readonly dummyViews = new Map<number, CharacterView>();
  /** M12：假人的动作状态机（由位置差分驱动，与联网场景的远端角色同一思路）*/
  private readonly dummyAnims = new Map<number, AnimationController>();
  private readonly lastDummyPos = new Map<number, { x: number; z: number }>();
  /** M12：手上武器跟随换装（10.6 敌人可见当前武器）*/
  private readonly shownWeapons = new Map<number, string | undefined>();
  /** M8：控制状态与护盾标记，每个实体一份 */
  private readonly statusMarkers = new Map<number, StatusMarkers>();
  /** M8：三档画质（F2 循环）*/
  private get quality(): QualityController { return this.shell.quality; }
  /** M12：HDR 环境光与天空。★ 纯加法，见 Environment.ts 文件头 */
  private get env(): Environment { return this.shell.env; }
  /** M12：地图装饰摆设（`?art=off` 或数据缺失时为 undefined）*/
  private decorRenderer: DecorRenderer | undefined;
  /** M12：是否加载外部美术素材（`?art=off` 关闭）。见 settings/artMode.ts */
  private get art(): boolean { return this.shell.art; }
  /** M9 / 17.2：可访问性设置。从 localStorage 恢复，切换后立即持久化 */
  private access: AccessibilitySettings = { ...DEFAULT_ACCESSIBILITY };
  /** M9 / 11.4：观战。★ 只能跟随己方存活队友，没有自由镜头状态 */
  private readonly spectate = new SpectateController();
  private sun!: THREE.DirectionalLight;
  /** 场景经过的总时间，驱动标记的运动 */
  private elapsed = 0;
  /** M8：夺旗演示，用来把 M7 的规则接到真实操作与 15.4 HUD 上 */
  private readonly ctf: CtfDemo;
  private readonly flagMarkers: FlagMarkers;
  /**
   * M12 / 14.2：八属性技能粒子特效。★ 只在 `?art=on` 时构造 ——
   * 关掉即回到 M11 无特效画面（与音效/模型/环境每一层同一门禁）。
   */
  private readonly spellVfx: SpellVfx | undefined;
  /** 打击感：顿帧与反馈编排（构造函数里初始化，依赖 hud/cam/combat）*/
  private readonly hitStop = new HitStop();
  private feedback!: HitFeedback;
  /** M12：目标 / 焦点的脚下指示环（5.2 / 14.4 关键元素）*/
  private readonly targetRing = new TargetRing();
  private readonly focusRing = new TargetRing();
  /** M3：瞄准 */
  private readonly aim = new AimingController();
  private readonly groundIndicator = new GroundIndicator();
  private readonly directionIndicator = new DirectionIndicator();
  /** 鼠标在画布上的归一化坐标，地面技能瞄准用 */
  private readonly ndc = new THREE.Vector2();
  /** 本帧的一次性鼠标事件，供瞄准状态机消费 */
  private clickFlags = { left: false, right: false };

  /**
   * 本场景演的是哪一套「舞台」：地图 + 出生点 + 假人布置。
   *
   * ★★ **只有数据分家，机制不分。** 渲染、HUD、输入、假人行为、
   *   `botController` 决策全部共享 —— 复制一份就是「同一件事两份实现」。
   *   分开的理由见 `combat/dummyLayouts.ts` 的文件头：验收要固定坐标、
   *   教学要为教学服务，这两个约束天生冲突，而且从任何一侧都看不见对方。
   */
  private readonly stage: Stage;
  private move: MovementState;
  private characterYaw: number;
  /** M15：新手教学（`?tutorial=on` 才有）。public —— verify:m15 经 `__scene.tutorial` 读状态 */
  readonly tutorial?: TutorialDirector;
  /** 上一帧与本帧的模拟位置，用于渲染插值 */
  private prevPosition: { x: number; y: number; z: number };
  private pendingInput: FrameInput | null = null;
  private lastLandingHeight: number | undefined;
  private debugVisible = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onDebug: (info: DebugInfo) => void,
    /** 舞台。★ 默认是**验收用的试验场** —— 默认路径的行为逐字不变 */
    stage: Stage = TESTBED_STAGE,
    /**
     * P5：`?class=` 选的职业。缺省 = 法师（验收基线）。
     * 非法师时技能栏默认 = 该职业前 9（与联网同口径），P3c 自定义照常生效。
     */
    private readonly playerClass?: ClassDef,
    /** P5：`?bot=` 实战模式假人难度。缺省 normal（现状） */
    botDifficulty?: 'easy' | 'hard',
  ) {
    this.stage = stage;
    this.musicDir = new MusicDirector(ambientTrackFor(stage.map.id as string));
    this.characterYaw = stage.spawn.yaw;
    this.prevPosition = { ...stage.spawn.position };
    // G4：renderer/画质/环境/镜头/输入/resize 全在壳里（SceneShell 文件头）。
    // 雾在 70×70 场地（对角线约 99 米）边界之外 —— 太近的雾会让远端墙体糊掉，
    // 而「看清远处几何」正是这个试验场存在的意义
    this.shell = new SceneShell(canvas);

    this.obstacles = stage.map.geometry;
    this.mapRenderer = new MapRenderer(stage.map, this.art);
    this.scene.add(this.mapRenderer.group);
    // M12：环境与地面材质。两者都是「加法」，失败即回落到 M11 的画面
    if (this.art) {
      // W15：昼夜按地图配（试验场=day 红线不动；教学场=dawn）
      this.env.apply(this.quality.current, { preset: presetOf(this.stage.map.envPreset) });
      void this.mapRenderer.applyGroundTexture('stone');
      // 地图装饰摆设（纯表现，sim 不读 —— 见 DecorRenderer 文件头）
      if (stage.map.decor) {
        this.decorRenderer = new DecorRenderer(stage.map.decor);
        this.decorRenderer.applyQuality(this.quality.current);
        this.scene.add(this.decorRenderer.group);
      }
    }
    this.scene.add(this.view.group);
    this.addGrid();
    this.addLights();

    this.move = createMovementState(stage.spawn.position, stage.spawn.yaw);

    // M2 战斗 + M3 瞄准。★ 假人布置由舞台决定（见 stage 字段的注释）
    // P3c：技能栏读玩家存过的自定义；无存档（verify 脚本的全新上下文）
    //   → loadSkillBar 原样返回默认，默认路径逐字节不变
    // P5：`?class=` 换职业 —— 技能栏默认 = 该职业前 9（与联网同口径），
    //   法师保持 PLAYER_SKILL_IDS（验收按数字键点名特定技能）
    const cls = this.playerClass ?? mageClass;
    const defaultBar: readonly string[] = this.playerClass
      ? cls.skills.slice(0, SKILL_BAR_SLOTS).map((sk) => sk.id as string)
      : PLAYER_SKILL_IDS;
    this.combat = new CombatDirector(
      this.obstacles, stage.spawn.position, stage.map.bounds, stage.dummies,
      loadSkillBar(
        globalThis.localStorage, cls.id as string, defaultBar,
        new Set(cls.skills.map((sk) => sk.id as string)),
      ),
      this.playerClass,
      botDifficulty,
    );
    // ★ 必须用玩家的**真实实体 id**。这里曾经写死 0，而实体 id 从 1 开始分配 ——
    //   结果玩家身上的控制标记永远不会更新（一直是构造时的 visible=false）。
    //   编译通过、测试全绿，只有截图比对才看得出来
    this.addStatusMarkers(this.combat.player.id as number, this.view);
    // M8：夺旗演示（12.x 的客户端接线）。规则全部走 shared 的 flag.ts
    this.ctf = new CtfDemo(this.combat.world);
    // ★ 12.3 / 验收 #40：带旗使用无敌/潜行技能时先掉旗，再播放技能表现
    this.combat.onBeforeSkillEffects = (caster, skill) => {
      void skill;
      this.ctf.onSkillThatDropsFlag(caster, this.combat.world.time);
    };
    // ── M12：音效。★ 三个钩子都是只读旁路，不改任何战斗状态 ──────
    const audioDeps: CombatAudioDeps = {
      listener: () => this.move.position,
      positionOf: (id) => this.combat.allEntities().find((e) => e.id === id)?.position,
      selfId: () => this.combat.player.id,
    };
    audio.install();

    // ── M12 / 14.2：八属性粒子特效。★ 与音效同为只读旁路，只在 art 开时构造 ──
    if (this.art) {
      this.spellVfx = new SpellVfx();
      this.scene.add(this.spellVfx.group);
    }

    // ── 打击感：命中反馈统一编排（浮字/粒子/闪白/音效分层/震动/顿帧）──
    this.feedback = new HitFeedback({
      selfId: () => this.combat.player.id,
      headOf: (id) => {
        const e = this.combat.allEntities().find((x) => x.id === id);
        return e
          ? { x: e.position.x, y: e.position.y + e.height * 0.9, z: e.position.z }
          : undefined;
      },
      audioAt: (id) => {
        const at = audioDeps.positionOf(id);
        return at ? { distance: distance2D(at, this.move.position) } : {};
      },
      viewOf: (id) =>
        id === this.combat.player.id ? this.view : this.dummyViews.get(id as number),
      // ★ 惰性转发：此刻 this.hud 还没构造（它在下面才 new），
      //   直接传 this.hud.floaters 会在这里就崩
      floaters: {
        push: (text, kind, at, opts) => this.hud.floaters.push(text, kind, at, opts),
      },
      flashScreen: () => this.hud.flashScreen(),
      vfxDamage: (e) =>
        this.spellVfx?.onCombatEvent(
          { t: 'damage', ...e },
          (id) => this.bodyPosOf(id),
        ),
      // 14.3 护盾承伤/破裂。★ 不受 art 门禁 —— StatusMarkers 在 ?art=off 下照常在
      shieldMarkerOf: (id) => this.statusMarkers.get(id as number),
      addTrauma: (t) => this.cam.addTrauma(t),
      hitStop: this.hitStop,
      audio,
      access: () => this.access,
    });

    this.combat.onCombatEvent = (ev) => {
      // 伤害走 HitFeedback（唯一编排者）；其余事件保持原有三条旁路
      if (ev.t === 'damage') {
        this.feedback.onHit({
          targetId: ev.targetId, sourceId: ev.sourceId,
          amount: ev.amount, absorbed: ev.absorbed, immune: ev.immune,
          avoided: ev.avoided, crit: ev.crit === true, overkill: ev.overkill,
          school: ev.school,
          targetMaxHealth: this.combat.allEntities().find((e) => e.id === ev.targetId)?.maxHealth,
        });
        return;
      }
      playCombatEvent(audio, audioDeps, ev);
      this.showCombatFeedback(ev);
      /**
       * ★★ 玩家被位移（击退/拉拽/冲锋落点）必须同步到 `this.move`。
       *   试验场里玩家的移动状态由场景驱动、**不在** tickWorld 的 movement 表里，
       *   所以 sim 侧的位移修复（effects/displacement.ts）覆盖不到它 ——
       *   sim 只能写 `entity.position`，而本场景每帧又用 `this.move` 把它覆盖回去。
       *   事件里的 `to` 就是 clamp 过的权威落点；`teleportTo` 负责贴地、清速度、
       *   置 teleported 标记（13.4：动画层据此不播高速跑步）。
       */
      if (ev.t === 'displaced' && ev.targetId === this.combat.player.id) {
        this.move = teleportTo(this.move, ev.to, this.obstacles);
        this.prevPosition = { ...this.move.position };
      }
      // ★ SpellVfx 只吃它声明的那几类（SpellVfxEvent）—— 收窄后网络场景也能喂同一个类
      if (
        ev.t === 'heal' || ev.t === 'auraApplied' ||
        ev.t === 'shieldBroken' || ev.t === 'death'
      ) {
        this.spellVfx?.onCombatEvent(ev, (id) => this.bodyPosOf(id));
      }
      // 14.3 护盾破裂（四态之一）。★ flashBroken 自定义以来第一次真的被调用
      if (ev.t === 'shieldBroken') this.feedback.onShieldBroken({ targetId: ev.targetId });
      if (ev.t === 'death') {
        const at = audioDeps.positionOf(ev.targetId);
        this.feedback.onDeath({
          entityId: ev.targetId, killerId: ev.killerId,
          distance: at ? distance2D(at, this.move.position) : undefined,
        });
      }
    };
    this.combat.onCastActivity = (kind, caster, skill, targets) => {
      playCastActivity(audio, audioDeps, kind, caster.id, skill);
      // ★ track 闭包捕获**活的** CombatEntity —— 弹体每帧读 t.position 追人，
      //   目标走位后爆发落在人身上而不是释放瞬间的旧坐标（sim 的 homing 同语义）
      this.spellVfx?.onCast(kind, caster, skill, targets?.map((t) => ({
        position: t.position,
        height: t.height,
        track: () => ({ x: t.position.x, y: t.position.y + t.height * 0.5, z: t.position.z }),
      })));
      /**
       * M12 / 13.3：近战技能的挥砍动作。
       * 近战的签名 = 直接目标 + 6.1 近战档射程（≤3.8 米，取 8 米为界）。
       * 素材缺片段时 playMeleeSwing 安静跳过。
       */
      if (kind === 'resolved' && skill && skill.targeting === Targeting.Direct && skill.range.max < 8) {
        this.viewFor(caster.id)?.playMeleeSwing();
        // 挥砍破空声（swing 变体组自 M12 定义以来第一次真的被调用）
        const at = audioDeps.positionOf(caster.id);
        audio.playVariant('swing', {
          volume: 0.55,
          ...(at && caster.id !== this.combat.player.id
            ? { distance: distance2D(at, this.move.position) }
            : {}),
        });
      }
    };
    this.combat.onSwapResult = (ok) =>
      audio.play(ok ? 'ui_weapon_unsheathe' : 'ui_error', { group: 'ui' });
    /**
     * 7.6 白字命中 → 挥砍动画 + 破空声（实战模式才有 —— 见 CombatDirector
     * 的 `swings` 注释）。★ 与技能挥砍走**同一个** `playMeleeSwing()`：
     * 近战「一直在打」的视觉主体是白字，技能之间那 4–10 秒的冷却全靠它填。
     */
    this.combat.onSwingHit = (attackerId) => {
      this.viewFor(attackerId)?.playMeleeSwing();
      audio.playVariant('swing', { volume: 0.45, ...audioDeps.positionOf(attackerId) });
    };

    this.flagMarkers = new FlagMarkers();
    this.scene.add(this.flagMarkers.group);
    this.scene.add(this.groundIndicator.group, this.directionIndicator.group);
    this.scene.add(this.targetRing.group, this.focusRing.group);
    canvas.addEventListener('mousemove', this.onCanvasMouseMove);
    this.hud = new CombatHud(canvas.parentElement ?? document.body);
    // 鼠标点技能格 → 记下槽位，下一帧走与数字键完全相同的瞄准流程
    this.hud.onSkillClick = (slot) => { this.clickedSlot = slot; };
    // 17.2：恢复上次的可访问性设置。★ 损坏的设置会被 normalize 回落到默认值
    this.setAccessibility(loadAccessibility(globalThis.localStorage));
    /**
     * W9（技术债总账）：设置面板 —— F10。面板不持状态：无障碍走本场景的
     * `setAccessibility()` 唯一入口，画质与 F2 走同一条应用链。
     */
    // W7：重绑控制器（应用到 InputManager + 落 localStorage），与联网场景共用
    const rebindCtl = makeRebindController(
      this.input, rebindableActions(), globalThis.localStorage,
    );
    this.settings = new SettingsPanel(canvas.parentElement ?? document.body, {
      getAccessibility: () => this.access,
      setAccessibility: (next) => this.setAccessibility(next),
      getQuality: () => this.quality.current,
      setQuality: (tier) => this.shell.setQualityTier(tier, this.sun, this.decorRenderer),
      bindings: () => this.input.getBindings(),
      rebind: (action, code) => rebindCtl.rebind(action, code),
      resetBindings: () => rebindCtl.reset(),
      /**
       * P3c 技能栏自定义（P5 起跟随 `?class=` 的职业）。assign/reset 三件事
       * 一步不能少：存 localStorage → 换 CombatDirector 的栏（立即生效）→
       * 取消进行中的瞄准（正瞄着的格子可能刚被换掉，按旧技能确认落点就是错的）。
       */
      skillBar: {
        current: () => this.combat.skills,
        pool: () => cls.skills,
        assign: (slot, skillId) => {
          const next = assignSlot(this.combat.skills.map((sk) => sk.id as string), slot, skillId);
          saveSkillBar(globalThis.localStorage, cls.id as string, next);
          this.combat.setSkillBar(next);
          this.aim.reset();
        },
        reset: () => {
          saveSkillBar(globalThis.localStorage, cls.id as string, defaultBar);
          this.combat.setSkillBar(defaultBar);
          this.aim.reset();
        },
      },
    });
    // W7：技能栏 <kbd> 读实时绑定（换了技能键跟着变）
    this.hud.skillKeyLabel = (i) =>
      prettyKey(this.input.getBindings()[`skill${i + 1}` as never] ?? String(i + 1));
    // M12：玩家模型（法师）。setClass 在 combat 建好后才调得了 —— 字段初始化时职业未知
    // ★ `?art=off` 时 ModelLibrary 没 init，setClass 会安静地无事发生
    this.view.setClass(this.combat.player.classId as string);
    for (const e of this.combat.visibleEntities()) {
      const v = new CharacterView(e.classId as string);
      v.setTransform(e.position, e.yaw);
      this.dummyViews.set(e.id as number, v);
      this.dummyAnims.set(e.id as number, new AnimationController());
      this.scene.add(v.group);
      this.addStatusMarkers(e.id as number, v);
    }
    canvas.addEventListener('mousedown', this.onCanvasMouseDown);

    /**
     * M15：新手教学（docs/14 §M15）。`?tutorial=on` 显式进入 ——
     * **不默认弹出**：155 项验收跑在无参与 `?art=off` 路径上，教学面板
     * 不该出现在它们的画面里；对玩家的入口在大厅标题页（「新手教学」按钮）。
     * ★ attach() 必须在上面全部旁路钩子接完之后 —— 它是包在最外层的旁听者。
     */
    if (new URLSearchParams(location.search).get('tutorial') === 'on') {
      this.tutorial = new TutorialDirector(this.combat);
      this.tutorial.attach();
      new TutorialHud(canvas.parentElement ?? document.body, this.tutorial);
    }

    this.loop = new GameLoop(
      (dt) => this.simulate(dt),
      (alpha, dt, realDt) => this.draw(alpha, dt, realDt),
      (dt) => this.readInput(dt),
      undefined,
      // 顿帧：只缩放渲染 dt。模拟步/输入采样在 GameLoop 里恒用真实 dt
      (realDt) => this.hitStop.scale(realDt),
    );
  }

  start(): void {
    this.loop.start();
  }

  /**
   * P2 压测台用：直接打开实战模式（等价于按 K）。
   * ★ 默认仍是关的 —— 141 项验收依赖假人站桩，见 K 键分支的注释。
   */
  set combatMode(on: boolean) {
    this.combat.combatMode = on;
  }

  /** 鼠标点过的技能格，下一帧被 readInput 消费（与数字键同一条流程）*/
  private clickedSlot: number | null = null;

  /**
   * 17.2：应用并持久化一份可访问性设置。
   *
   * ★ 只有这一个入口。HUD 的缩放/色板都从 `this.access` 读，
   *   所以不存在「改了设置但某处没跟上」的状态 —— 那是设置类功能最常见的 bug。
   */
  setAccessibility(next: AccessibilitySettings): void {
    this.access = next;
    this.hud.applyAccessibility(next);
    // 打击感开关：震动经 shakeAmplitude 归零（唯一入口）；顿帧直接停
    this.cam.setAccessibility(next);
    this.hitStop.enabled = next.hitStop;
    saveAccessibility(globalThis.localStorage, next);
  }

  /** 供验收脚本读取当前设置 */
  get accessibility(): AccessibilitySettings {
    return this.access;
  }

  /**
   * M12：美术层自检出口，供 `verify:m12`。
   *
   * ★ **只读**，且只报告「装上了什么」，不提供任何开关 ——
   *   验收脚本能观察，但改不了状态。与 `spectateState` 同一个性质。
   */
  get artStatus(): {
    art: boolean;
    quality: string;
    envLoaded: boolean;
    groundTextured: boolean;
    hitbox: { radius: number; height: number };
    /** 每个已挂模型角色的视觉身高。验收 #10 要求它们全部 === hitbox.height */
    modelHeights: number[];
    charactersWithModel: number;
    charactersTotal: number;
    /** 14.2 八属性特效自检：贴图加载数、覆盖属性数、当前活跃粒子/飞行体 */
    vfx: import('../vfx/SpellVfx.js').SpellVfxStatus | undefined;
    /** 地图装饰摆设自检：登记数/加载数/当前可见性 */
    decor: import('../render/DecorRenderer.js').DecorStatus | undefined;
    /** 打击感自检（诊断只读，diag-feel.mjs 消费）*/
    feel: {
      critsSeen: number; traumaPeak: number; trauma: number; hitStopFrozen: boolean;
      /** 14.3 护盾承伤/破裂各触发过几次 —— 这两条通道曾经定义了但零调用 */
      shieldAbsorbs: number; shieldBreaks: number;
    };
    /** 14.3 护盾四态自检：当前几个人有壳、分别处于哪一态 */
    shields: { visible: number; states: string[] };
    /**
     * 最近 0.5 秒的平均帧率。
     *
     * ★ **零新增计算** —— `GameLoop` 每帧本来就在算它（只是此前只喂给
     *   `#stats` 那个 DOM 面板）。挂在这里是为了让联网场景与诊断脚本也读得到。
     * ★★ **不作为任何验收判据**：0.5 秒窗口平均值掩盖长尾帧，
     *   而软件渲染下的绝对值更说明不了什么 —— `verify-m8.mjs` 的注释
     *   已经论证过这一点，那个判断是对的。这个数只给人看，
     *   用来回答「这一轮特效加下去，帧率有没有明显塌」。
     */
    fps: number;
  } {
    const views = [this.view, ...this.dummyViews.values()];
    const withModel = views.filter((v) => v.hasModel);
    return {
      art: this.art,
      quality: this.quality.current,
      envLoaded: this.scene.environment !== null,
      groundTextured: this.mapRenderer.groundTextured,
      hitbox: { radius: GEOMETRY.HITBOX_RADIUS, height: GEOMETRY.HITBOX_HEIGHT },
      modelHeights: withModel.map((v) => v.modelHeight ?? 0),
      charactersWithModel: withModel.length,
      charactersTotal: views.length,
      vfx: this.spellVfx?.status(),
      decor: this.decorRenderer?.status(),
      feel: {
        critsSeen: this.feedback.critsSeen,
        traumaPeak: this.feedback.traumaPeak,
        trauma: this.cam.trauma,
        hitStopFrozen: this.hitStop.frozen,
        shieldAbsorbs: this.feedback.shieldAbsorbsSeen,
        shieldBreaks: this.feedback.shieldBreaksSeen,
      },
      shields: {
        visible: [...this.statusMarkers.values()].filter((m) => m.shieldVisible).length,
        states: [...this.statusMarkers.values()]
          .map((m) => m.shieldState)
          .filter((s): s is NonNullable<typeof s> => s !== null),
      },
      fps: this.loop.fps,
    };
  }

  /** 供验收脚本检查观战状态（11.4）*/
  get spectateState(): { active: boolean; following: number | null; candidates: number } {
    return {
      active: this.spectate.active,
      following: this.spectate.following,
      candidates: this.spectate.available(this.combat.world, this.combat.player).length,
    };
  }

  dispose(): void {
    this.loop.stop();
    this.canvas.removeEventListener('mousedown', this.onCanvasMouseDown);
    this.canvas.removeEventListener('mousemove', this.onCanvasMouseMove);
    this.spellVfx?.dispose();
    this.shell.dispose();
  }

  private onCanvasMouseMove = (ev: MouseEvent): void => {
    this.shell.ndcFromMouse(ev, this.ndc);
    this.updateHoverCursor();
  };

  /**
   * M12：光标随悬停对象变化（敌对=剑、友方=盾、其余=手）。
   *
   * ★ 这是 5.2「点击选中」的**预告** —— 玩家在按下之前就知道
   *   这一下会点到谁，而不是点完看目标框才知道点错了。
   * ★ 只在鼠标移动时算一次射线，不进每帧循环：12v12 下逐帧对
   *   24 个角色组做 raycast 是白扔掉的帧。
   */
  private updateHoverCursor(): void {
    if (this.aim.isAiming) return; // 瞄准期间光标语义由地面指示器承担
    const ray = new THREE.Raycaster();
    ray.setFromCamera(this.ndc, this.cam.camera);
    let hoveredTeam: number | undefined;
    let best = Infinity;
    for (const [id, view] of this.dummyViews) {
      const hits = ray.intersectObject(view.group, true);
      if (hits.length && hits[0]!.distance < best) {
        best = hits[0]!.distance;
        hoveredTeam = this.combat.allEntities().find((e) => (e.id as number) === id)?.team as
          | number
          | undefined;
      }
    }
    const cls = this.canvas.classList;
    const mine = this.combat.player.team as number;
    cls.toggle('cursor-attack', hoveredTeam !== undefined && hoveredTeam !== mine);
    cls.toggle('cursor-friendly', hoveredTeam !== undefined && hoveredTeam === mine);
  }

  /**
   * 5.2：左键点击角色模型设为硬目标。
   * 用射线拾取角色组，命中即选中；点空地不清除目标（5.1：硬目标持续保留）。
   */
  private onCanvasMouseDown = (ev: MouseEvent): void => {
    // 记录给瞄准状态机（5.5：左键确认、右键取消）
    if (ev.button === 0) this.clickFlags.left = true;
    if (ev.button === 2) this.clickFlags.right = true;

    // 瞄准期间左键只用于确认落点，不改变目标
    if (ev.button !== 0 || this.aim.isAiming) return;
    const ndc = this.shell.ndcFromMouse(ev, new THREE.Vector2());
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.cam.camera);

    let best: { id: number; dist: number } | undefined;
    for (const [id, view] of this.dummyViews) {
      const hits = ray.intersectObject(view.group, true);
      if (hits.length && (!best || hits[0]!.distance < best.dist)) {
        best = { id, dist: hits[0]!.distance };
      }
    }
    if (best) this.combat.selectById(best.id);
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

  /** 每个角色挂一份控制状态与护盾标记（14.3）*/
  private addStatusMarkers(id: number, view: CharacterView): void {
    const m = new StatusMarkers();
    view.group.add(m.group);
    this.statusMarkers.set(id, m);
  }

  /** M12：武器变化才触发挂载（setWeapon 是异步的，不能每帧调） */
  private syncWeapon(id: number, view: CharacterView, weaponId: string | undefined): void {
    if (this.shownWeapons.get(id) === weaponId) return;
    this.shownWeapons.set(id, weaponId);
    view.setWeapon(weaponId);
  }

  /**
   * 场上所有正在施法的单位 → `CastView`（14.1「预备」阶段的数据源）。
   *
   * ★ 试验场这份是**免费**的：`castOf` 本来就每帧被调一次用来切施法姿态，
   *   这里只是把同一份状态多喂给一个消费者。联网场景的对应实现读的是
   *   `SnapshotCombatView` 的施法注册表 —— 两条路殊途同归到同一个视图类型。
   */
  private castViews(): CastView[] {
    const out: CastView[] = [];
    for (const e of this.combat.allEntities()) {
      const st = this.combat.castOf(e);
      if (!st) continue;
      out.push({
        id: e.id as number,
        skillId: String(st.skillId),
        position: e.position,
        height: e.height,
        yaw: e.yaw,
        startedAt: st.startedAt,
        endsAt: st.endsAt,
        ...(st.channelEndsAt !== undefined ? { channelEndsAt: st.channelEndsAt } : {}),
      });
    }
    return out;
  }

  /** 某实体躯干中部的世界坐标，供命中粒子爆发定位（14.2）*/
  private bodyPosOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    const e = this.combat.allEntities().find((x) => x.id === id);
    return e ? { x: e.position.x, y: e.position.y + e.height * 0.5, z: e.position.z } : undefined;
  }

  /** 某实体的 3D 视图（玩家或假人）*/
  private viewFor(id: EntityId): CharacterView | undefined {
    return id === this.combat.player.id ? this.view : this.dummyViews.get(id as number);
  }

  /**
   * M12 / 8.2「迷惑」：被化形术命中的实体换成小动物模型。
   * ★ 判据是**光环的递减类别**而不是光环名 —— 8.2 的「迷惑」链
   *   （incapacitate + stunned 标志）就是「被变成无害生物」这一类，
   *   恐惧同类别但置 feared，据此排除。素材缺失时 setMorphed 内部安静跳过。
   */
  private isMorphed(id: EntityId): boolean {
    return aurasOf(this.combat.auras, id).some(
      (a) => a.def.drCategory === DrCategory.Incapacitate && a.def.flags?.stunned === true,
    );
  }

  /**
   * M12：把一条战斗事件转成**看得见**的反馈（14.1）。
   *
   * ★ 与 `playCombatEvent` 是同一份事件的两条通道 —— 音效、浮动数字、
   *   模型闪白各自独立，关掉任意一条另外两条照常工作（17.2 第三句）。
   */
  private showCombatFeedback(ev: CombatEvent): void {
    const posOf = (id: EntityId): { x: number; y: number; z: number } | undefined => {
      const e = this.combat.allEntities().find((x) => x.id === id);
      // 数字从**头顶**冒出来，不是从脚下
      return e ? { x: e.position.x, y: e.position.y + e.height * 0.9, z: e.position.z } : undefined;
    };

    switch (ev.t) {
      // ★ damage 不再走这里 —— 打击感改造后由 HitFeedback.onHit 统一编排
      //  （浮字/闪白/屏闪/音效分层/震动/顿帧一处定序），见 onCombatEvent 的分流
      case 'heal': {
        // 暴击治疗放大浮字（HitFeedback.onHeal 统一处理）
        this.feedback.onHeal({ targetId: ev.targetId, amount: ev.amount, crit: ev.crit === true });
        break;
      }
      case 'shieldBroken': {
        const at = posOf(ev.targetId);
        if (at) this.hud.floaters.push('护盾破裂', 'absorb', at);
        break;
      }
      default:
        // 其余事件已经有日志与 3D 标记两条通道，不再叠一个飘字 ——
        // 满屏飘字会把真正要看的伤害数字淹掉
        break;
    }
  }

  /** 脚步的累计行程，每 STEP_DISTANCE 米响一次 */
  private stepAccum = 0;
  /** 一步的步幅（米）。★ 按行程而不是按时间 —— 走和跑的步频本就该不同 */
  private static readonly STEP_DISTANCE = 2.1;

  /**
   * M12：移动音效（脚步 / 起跳 / 落地）。
   *
   * ★ 脚步按**行程**触发而不是定时器：定时器在减速带、后退（65% 速度）
   *   和加速阶段都会与腿部动画对不上，而 13.4 恰恰要求节奏与速度一致。
   */
  private updateMovementAudio(wasGrounded: boolean, landed: boolean): void {
    if (landed) {
      audio.playVariant('land', { volume: 0.6 });
      this.stepAccum = 0;
    } else if (wasGrounded && !this.move.grounded && this.move.velocity.y > 0) {
      audio.playVariant('jump', { volume: 0.5 });
    }

    if (!this.move.grounded) return;
    this.stepAccum += this.move.lastHorizontalDistance;
    if (this.stepAccum >= TestbedScene.STEP_DISTANCE) {
      this.stepAccum = 0;
      audio.playVariant('step', { volume: 0.32 });
    }
  }

  /**
   * 每帧刷新控制状态与护盾标记。
   *
   * ★ 这个方法**不看画质** —— 控制状态和护盾都是 14.4 点名不能隐藏的关键信息。
   *   `quality` 只被传进去用来**放大**低画质下的标记（controlMarkerScale），
   *   没有任何一条路径能让它们消失。
   */
  private updateStatusMarkers(dt: number): void {
    this.elapsed += dt;
    const dist = this.cam.distance;

    for (const e of this.combat.allEntities()) {
      const m = this.statusMarkers.get(e.id as number);
      if (!m) continue;

      /**
       * 值是**施加这个控制的技能的学派色**（查不到则 undefined → 退回中性常量）。
       * ★ 冰系定身是冰蓝的冰棱、自然系是翠绿的藤蔓 —— 玩家能读出「被什么定住」。
       */
      const active = new Map<ControlKind, number | undefined>();
      const tint = (kind: string): number | undefined => {
        const school = this.combat.controlSchoolOf(e.id, kind);
        return school ? visualForSchool(school).primary : undefined;
      };
      // 7.3：昏迷/恐惧/变形都置 stunned，但恐惧还额外置 feared ——
      // 14.3 要求两者视觉不同，所以恐惧时只显示恐惧，不叠一个昏迷标记
      if (e.flags.feared) active.set('feared', tint('fear'));
      else if (e.flags.stunned) active.set('stunned', tint('stun'));
      if (e.flags.rooted) active.set('rooted', tint('root'));
      if (e.flags.silenced) active.set('silenced', tint('silence'));
      if (e.flags.disarmed) active.set('disarmed', tint('disarm'));

      m.update(active, this.quality.current, dist, dt, this.elapsed);

      const shield = this.combat.shieldOf(e.id);
      // 盾的学派色（冰盾冰蓝、护心屏障圣金）—— 此前壳体一律金色
      m.setShield(
        shield?.remaining, shield?.initial ?? 1, dist,
        shield ? visualForAuraId(shield.auraId)?.primary : undefined,
      );
      // W16：复活保护按光环 id 检测（与联网侧同一判据；试验场没有
      // 复活波次，organically 不触发 —— 联网夺旗侧已随 W12 真实触发）
      m.setSpawnProtected(
        aurasOf(this.combat.auras, e.id).some((a) => a.def.id === SPAWN_PROTECTION_AURA.id),
      );
    }
  }

  /**
   * 15.1 四区里的其余三块 + 15.3 装备栏 + 15.4 模式专属。
   *
   * ★ 这里给 `renderCtf()` 的是**真的** `CtfState` 派生出来的视图，
   *   不是写死的演示数据 —— 旗帜状态、旗手姓名、聚焦层数全部来自 flag.ts。
   *   附录A#7：不能用占位图冒充完成。
   */
  private updateHudPanels(): void {
    const player = this.combat.player;

    // 15.1 左侧：己方队友。试验场里只有玩家自己一个人在红队
    const allies = this.combat
      .allEntities()
      .filter((e) => (e.team as number) === (player.team as number));
    this.hud.party.render(partyViewOf(allies));

    // 15.4 夺旗 HUD
    this.hud.modeHud.renderCtf({
      scoreRed: this.ctf.scoreOf(player.team),
      scoreBlue: this.ctf.scoreOf(this.combat.visibleEntities()[0]?.team ?? player.team),
      scoreToWin: this.ctf.ctf.scoreToWin,
      timeRemaining: Math.max(0, 720 - this.combat.world.time),
      flags: this.ctf.views(),
      focusStacks: this.ctf.ctf.focusStacks,
      message: this.ctf.lastMessage,
    });

    // 速赢清单：O 键记分板。名单走可见实体 + 自己 —— 与小地图同一条
    // 可见性规矩（潜行者不在列表里，验收 #5）。不可见时 render 零开销。
    this.hud.scoreboard.render({
      modeLabel: '夺旗战场 · 试验场',
      scoreRed: this.ctf.scoreOf(player.team),
      scoreBlue: this.ctf.scoreOf(this.combat.visibleEntities()[0]?.team ?? player.team),
      rows: [player, ...this.combat.visibleEntities()].map((e) => ({
        name: e.name,
        classId: e.classId,
        team: e.team,
        alive: e.alive,
        healthPct: e.maxHealth > 0 ? e.health / e.maxHealth : 0,
        isSelf: e.id === player.id,
      })),
    });

    // 15.1 右上：小地图。★ 传进去的列表已经过可见性过滤 ——
    // Minimap 自己拿不到世界状态，所以不可能画出未被发现的潜行者（验收 #5）
    const blips: MinimapBlip[] = [
      { x: player.position.x, z: player.position.z, kind: 'self' },
      ...this.combat.visibleEntities().map<MinimapBlip>((e) => ({
        x: e.position.x,
        z: e.position.z,
        kind: (e.team as number) === (player.team as number) ? 'ally' : 'enemy',
        team: e.team,
      })),
      // 15.4：小地图**永久**显示双方旗手与掉落旗帜
      ...this.ctf.carriedFlags().map<MinimapBlip>((f) => ({
        x: f.position.x, z: f.position.z, kind: 'flagCarrier', team: f.team,
        ...(f.carrierName ? { label: f.carrierName } : {}),
      })),
      ...this.ctf.droppedFlags().map<MinimapBlip>((f) => ({
        x: f.position.x, z: f.position.z, kind: 'droppedFlag', team: f.team,
      })),
    ];
    this.hud.minimap.draw(blips, player.position.x, player.position.z, this.characterYaw);

    // 15.3 战场装备栏。★ 用的是 `ownLoadoutView()` —— 自己的视图。
    // 敌人的备用装备本项目**取不到**：`enemyLoadoutView()` 的返回类型里
    // 根本没有那个字段（M6 已在数据层钉死，验收 #36）
    this.hud.loadout.render(this.combat.playerLoadoutView(), this.combat.world.time);
  }

  private addLights(): void {
    // three r155+ 默认使用物理光照单位，强度不要照搬旧版数值 —— 容易直接过曝成白板
    this.scene.add(new THREE.HemisphereLight(0xa8bcd8, 0x3a4250, 0.85));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.1);
    this.sun = sun;
    sun.position.set(24, 40, 16);
    this.quality.applyToLight(sun);
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
      for (const v of this.dummyViews.values()) v.setHitboxVisible(this.debugVisible);
    }
    if (input.pressed.has(Action.CycleWeapon)) {
      const err = this.combat.cyclePlayerWeapon();
      if (err) this.hud.loadout.showInterrupt('cancelled', this.combat.world.time);
      void err;
    }
    if (input.pressed.has(Action.FlagInteract)) {
      this.ctf.interact(this.combat.player, this.combat.world.time);
    }
    /**
     * K：实战模式开关。假人从站桩切成会追、会走位的人机。
     * ★ 默认关，且**只影响试验场的假人行为** —— 141 项验收依赖它们站在
     *   固定位置（verify-m2 按 26 米外的法师算距离、verify-m3 靠固定位置算视线），
     *   所以这必须是一个显式的手动开关，而不是新的默认行为。
     */
    if (input.pressed.has(Action.ToggleCombatMode)) {
      this.combat.combatMode = !this.combat.combatMode;
      this.combat.info(this.combat.combatMode
        ? '实战模式：假人会追击与走位（再按 K 关闭）'
        : '实战模式已关闭：假人回到站桩');
    }
    if (input.pressed.has(Action.CycleQuality)) {
      // 14.4 的档位取舍与「不藏关键元素」纪律见 SceneShell.setQualityTier 注释
      const tier = this.shell.cycleQualityTier(this.sun, this.decorRenderer);
      console.info(`[画质] ${tier}`);
    }

    // ── M9 / 17.2 可访问性 ───────────────────────────────────
    // W9：设置面板
    if (input.pressed.has(Action.OpenSettings)) this.settings.toggle();
    // W8：R 通用解控（8.3）。冷却提示在 CombatDirector，权威在 tick 第 1c 步
    if (input.pressed.has(Action.Trinket)) this.combat.requestTrinket();
    if (input.pressed.has(Action.CycleColorblind)) {
      const modes = Object.values(ColorblindMode);
      const next = modes[(modes.indexOf(this.access.colorblind) + 1) % modes.length]!;
      this.setAccessibility({ ...this.access, colorblind: next });
      console.info(`[色盲模式] ${next}`);
    }
    if (input.pressed.has(Action.CycleUiScale)) {
      const steps = [1, 1.25, 1.5, 2];
      const next = steps[(steps.indexOf(this.access.uiScale) + 1) % steps.length]!;
      this.setAccessibility({ ...this.access, uiScale: next });
      console.info(`[界面缩放] ${next}`);
    }

    // ── M9 / 11.4 观战 ──────────────────────────────────────
    // ★ 只能跟随己方存活队友。试验场里三个假人都在蓝队，所以名单通常是空的 ——
    //   这是**正确**的结果：11.4 不允许观战敌人。规则由 SpectateController
    //   与 shared 的 spectatableFor() 保证，这里只负责按键与提示。
    if (input.pressed.has(Action.SpectateNext)) {
      const t = this.spectate.cycle(this.combat.world, this.combat.player);
      console.info(t ? `[观战] 跟随 ${t.name}` : '[观战] 没有可跟随的己方存活队友（11.4）');
    }

    // ── M12 音频 ────────────────────────────────────────────────
    if (input.pressed.has(Action.ToggleMute)) {
      console.info(`[音频] ${audio.toggleMute() ? '已静音' : '已取消静音'}`);
    }
    // 速赢清单：O 键记分板
    if (input.pressed.has(Action.ToggleScoreboard)) this.hud.scoreboard.toggle();
    // ★ 首次交互解锁之后才开 BGM。放在这里而不是构造函数：AudioContext
    //   在用户交互前是 suspended 的，构造时开会得到一段无声播放的音乐
    // W13：BGM 随战斗状态切换。战斗口径 = sim 权威的 `lastCombatAt`
    //（M11 双向打标：打人与被打都算），脱战 8 秒淡回本图氛围曲
    this.musicDir.noteCombat(this.combat.player.lastCombatAt);
    this.musicDir.update(this.combat.world.time);

    // ── M2 战斗操作 ─────────────────────────────────────────
    // ★ Tab 用的是**镜头** yaw（5.3「当前镜头前方约 140 度范围内循环」）
    if (input.pressed.has(Action.TargetNext)) this.combat.cycleTarget(this.cam.yaw, false);
    if (input.pressed.has(Action.TargetPrev)) this.combat.cycleTarget(this.cam.yaw, true);
    if (input.pressed.has(Action.SetFocus)) this.combat.toggleFocusOnCurrent();

    // ── M3 瞄准流程（5.4 / 5.5）─────────────────────────────
    let pressedSlot: number | null = null;
    for (let i = 0; i < SKILL_SLOT_COUNT; i++) {
      if (input.pressed.has(`skill${i + 1}` as Action)) pressedSlot = i;
    }
    // 鼠标点技能格：与数字键**走同一条**瞄准流程（点地面技能同样要选落点）
    if (this.clickedSlot !== null) {
      pressedSlot = this.clickedSlot;
      this.clickedSlot = null;
    }
    // M12：按下即回执，不等施法结果（见 CombatHud.pulseSlot）
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

    const ev = this.aim.update(aimInput, (slot) => this.combat.skills[slot]);
    if (ev.type === 'confirm') {
      const slot = this.combat.skills.indexOf(ev.skill);
      // 地面技能：把当前鼠标指向的地面点作为落点
      const ground = screenToGround(this.cam.camera, this.ndc, this.move.position);
      this.combat.castSlot(
        slot,
        ground ? { x: ground.x, y: 0, z: ground.z } : undefined,
        // 5.6 / W8：按住 Alt 自我施法
        { selfCast: input.selfCastHeld },
      );
    }

    // 7.5 假读条：Esc 在没有瞄准时用于取消读条
    if (input.pressed.has(Action.CancelCast) && ev.type !== 'cancel') {
      this.combat.cancelPlayerCast();
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
      {
        /**
         * ★★ 与服务器 `tickWorld` 用**同一个** `moveSpeedMultiplierOf()`。
         *   试验场自己驱动玩家移动（它要同时算镜头与渲染插值），
         *   所以这条路径必须自己把系数算出来 —— 漏了的话单机与联网会分叉：
         *   同一个减速在联机里生效、在试验场里不生效。
         * ★ 这里能拿到真 `AuraStore` 与真 `CombatEntity`，所以是完整口径
         *   （含装备与 12.3 旗手上限），不是近似。
         */
        speedMultiplier: moveSpeedMultiplierOf(
          this.combat.auras, this.combat.player, this.combat.now,
        ),
        /**
         * ★ 13.5 / 验收 #43 软推开，与 `tickWorld` 第 2 步同源：
         *   走到假人身上不再完全重叠成一个点，而是被轻轻挤开 —— 可以穿过
         *   （硬碰撞会堵门）。同样只进位移不进速度，见 stepMovement 的注释。
         */
        separation: separationVelocity(
          this.move.position,
          this.combat.allEntities()
            .filter((e) => e.alive && e.id !== this.combat.player.id)
            .map((e) => e.position),
          GEOMETRY.HITBOX_RADIUS,
        ),
      },
    );
    this.move = result.state;
    this.lastLandingHeight = result.landing?.fallHeight;

    const wasGrounded = this.move.grounded;
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
    this.updateMovementAudio(wasGrounded, result.landing !== undefined);

    // ★ 战斗在移动之后推进 —— 7.3「主动移动停止原地施放的读条」
    //   只有先算完移动才知道这一 tick 有没有位移（docs/02 §3 的 tick 顺序）
    this.combat.update(dt, this.move.position, this.characterYaw);

    // M15：教学每帧采样（战斗推进之后 —— 学派锁/地面区域都是本 tick 的新值）
    this.tutorial?.frame({
      cameraYaw: this.cam.yaw,
      playerYaw: this.characterYaw,
      cameraDistance: this.cam.distance,
      grounded: this.move.grounded,
    });
  }

  /**
   * `dt` 是渲染时钟（顿帧时被缩放到 0.06×），`realDt` 是真实时钟。
   * ★★ 分配表（打击感改造，验收 #47 与网络插值靠它不回归）：
   *   打击表现 = dt：mixer（CharacterView.update）、粒子（spellVfx.frame）、
   *     浮字（hud.update）、镜头（cam.update，震动跟着世界一起冻/爆）
   *   状态机与时钟 = realDt：AnimationController（:79 用 distance/dt 算表观
   *     速度，喂缩放 dt 会暴涨 16 倍冲破 Run/Walk 阈值）、状态标记倒计时
   */
  private draw(alpha: number, dt: number, realDt: number): void {
    this.feedback.update(realDt);
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
    // M12：动画节奏跟速度（13.4）、施法姿态、手上武器、受击闪光推进
    this.view.setLocomotionTimeScale(this.anim.timeScale);
    this.view.setCasting(this.combat.playerCast !== undefined);
    this.view.setMorphed(this.isMorphed(this.combat.player.id));
    this.syncWeapon(this.combat.player.id as number, this.view, this.combat.player.weaponId as string);
    this.view.update(dt);

    const moving = this.anim.smoothedSpeed > 0.5;
    this.cam.update(
      dt,
      { position: rendered, yaw: this.characterYaw, grounded: this.move.grounded },
      this.obstacles,
      moving,
    );
    this.view.setFirstPerson(this.cam.isFirstPerson);

    for (const e of this.combat.visibleEntities()) {
      const v = this.dummyViews.get(e.id as number);
      if (!v) continue;
      v.setTransform(e.position, e.yaw);

      /**
       * M12：假人的动作由**位置差分**驱动 —— 与联网场景的远端角色同一思路
       * （它们都拿不到 MovementState）。位移超过 2 米/帧按瞬移处理，
       * 否则一次击退会被算成几十米每秒的冲刺（13.4）。
       */
      const prev = this.lastDummyPos.get(e.id as number);
      const moved = prev ? Math.hypot(e.position.x - prev.x, e.position.z - prev.z) : 0;
      this.lastDummyPos.set(e.id as number, { x: e.position.x, z: e.position.z });
      const teleported = moved > 2;
      const anim = this.dummyAnims.get(e.id as number);
      if (anim) {
        anim.update({
          horizontalDistance: teleported ? 0 : moved,
          dt: realDt, // ★ 状态机时钟：缩放 dt 会让表观速度暴涨 16 倍（见 draw 头注）
          grounded: true,
          verticalVelocity: 0,
          teleported,
          forward: !teleported && moved > 0.005 ? 1 : 0,
          strafe: 0,
          stunned: e.flags.stunned,
          dead: !e.alive,
        });
        v.setAnimState(anim.state);
        v.setLocomotionTimeScale(anim.timeScale);
      }
      v.setCasting(this.combat.castOf(e) !== undefined);
      v.setMorphed(this.isMorphed(e.id));
      this.syncWeapon(e.id as number, v, e.weaponId as string);
      v.update(dt);
    }

    // M12 / 14.2：弹体、地面区域、粒子池一次推进（顺序封在 SpellVfx.frame 里）。
    // ★ 弹体主体/地面边界走 essential，任何画质都画；拖尾/内部粒子按画质裁。
    // ★ 适配成表现视图 —— SpellVfx 同时服务本地 sim（这里）与网络快照（NetworkScene）
    this.spellVfx?.frame(dt, {
      quality: this.quality.current,
      cameraDistance: this.cam.distance,
      // 点精灵的透视缩放：视口像素高 / (2·tan(fov/2))
      pointScale:
        this.canvas.clientHeight /
        (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360)),
      now: this.combat.world.time,
      cameraPosition: this.cam.camera.position,
      // 14.1「预备」：读条/引导期间的蓄力法阵与聚能粒子（自己 + 所有可见实体）
      casts: this.castViews(),
      projectiles: this.combat.projectiles.items.map((p) =>
        p.kind === 'delayedImpact'
          ? {
              id: p.id, kind: p.kind, skillId: String(p.skillId),
              position: p.center, radius: p.radius, impactAt: p.impactAt,
            }
          : { id: p.id, kind: p.kind, skillId: String(p.skillId), position: p.position },
      ),
      grounds: this.combat.ground.areas.map((a) => ({
        id: a.id, skillId: a.skillId, center: a.center, radius: a.radius,
      })),
    });

    this.updateIndicators();
    this.updateStatusMarkers(realDt); // 状态标记是倒计时，不在顿帧时钟上
    this.ctf.tick(this.combat.world.time);
    this.flagMarkers.cameraDistance = this.cam.distance;
    this.flagMarkers.update(this.ctf.views(), this.elapsed);
    this.updateTargetRings();
    this.updateHudPanels();
    this.renderer.render(this.scene, this.cam.camera);
    this.hud.update(this.combat, this.cam.camera, this.canvas, dt);

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
      // P2 压测读数：`renderer.info` 是 three 自己每帧统计的，零额外开销
      render: {
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        entities: this.combat.allEntities().length,
        quality: this.quality.current,
      },
    });
  }

  /**
   * M12：目标 / 焦点的脚下指示环（5.2）。
   *
   * ★ 颜色取自 `paletteFor()` 的语义色 —— 色盲模式切换时它跟着变，
   *   与 HUD 的目标框用同一份色板（17.2：玩家不必学两套颜色）。
   * ★ 这是 `ESSENTIAL_ROLES.target`，**不经过画质档位**（14.4 / #48）。
   */
  private updateTargetRings(): void {
    const p = paletteFor(this.access.colorblind);
    const me = this.combat.player;

    const t = this.combat.target;
    this.targetRing.update(
      t?.position,
      t === undefined ? 'hostile' : (t.team as number) === (me.team as number) ? 'friendly' : 'hostile',
      this.elapsed,
      t !== undefined && (t.team as number) === (me.team as number) ? p.friendly : p.hostile,
    );

    const f = this.combat.focus;
    this.focusRing.update(f?.position, 'focus', this.elapsed, p.neutral);
  }

  /**
   * 更新瞄准指示器。
   *
   * ★ 边界与合法性全部来自 `combat.resolveGround()`，也就是 shared 的
   *   `resolveGroundPlacement` —— 与服务器判定同一个函数（验收 #8）。
   *   本方法不做任何几何计算。
   */
  private updateIndicators(): void {
    const skill = this.aim.pendingSkill;
    if (!skill) {
      this.groundIndicator.hide();
      this.directionIndicator.hide();
      this.hud.setAimHint(null, false);
      return;
    }

    if (skill.targeting === 'ground') {
      const ground = screenToGround(this.cam.camera, this.ndc, this.move.position);
      if (!ground) {
        this.groundIndicator.hide();
        this.hud.setAimHint(`${skill.name}：把鼠标移到地面上选择落点`, true);
        return;
      }
      const placement = this.combat.resolveGround(skill, { x: ground.x, y: 0, z: ground.z });
      this.groundIndicator.show(placement, this.combat.player.position);
      this.directionIndicator.hide();

      // 5.5：文字提示与视觉提示同步。合法时也说明是否被钳制到最大距离
      this.hud.setAimHint(
        placement.legal
          ? `${skill.name}：左键确认${placement.clamped ? `（已钳制到 ${placement.maxRange} 米边缘）` : ''}`
          : `${skill.name}：${FAIL_TEXT[placement.reason]}`,
        !placement.legal,
      );
    } else {
      this.groundIndicator.hide();
      // ★ 传角色 yaw，不是镜头 yaw（5.4：镜头方向不能替代角色面向）
      this.directionIndicator.show(skill.shape, this.combat.player.position, this.characterYaw);
      this.hud.setAimHint(`${skill.name}：沿角色面向释放`, false);
    }
  }

  /** 供 HUD 显示的常量，避免 UI 层重复硬编码 */
  static readonly INFO = {
    baseSpeed: MOVE.BASE_SPEED,
    hitboxRadius: GEOMETRY.HITBOX_RADIUS,
    stepHeight: GEOMETRY.STEP_HEIGHT,
  };
}
