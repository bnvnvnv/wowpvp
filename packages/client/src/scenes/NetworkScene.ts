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
  FlagState,
  GEOMETRY,
  MAP_BY_ID,
  NO_ENTITY,
  RANGE,
  TEAM_RED,
  Targeting,
  admitYaw,
  createMovementState,
  createTurnBudget,
  refillTurnBudget,
  getArmor,
  getClass,
  getSkill,
  getWeapon,
  SPAWN_PROTECTION_AURA,
  TRINKET_COOLDOWN_KEY,
  TargetFilter,
  loadoutViewFromSnapshot,
  needsGroundPlacement,
  resolveGroundPlacement,
  usesNoTarget,
  wrapAngle,
  type AllyEquipmentSnapshot,
  type ArmorDef,
  type FlagView,
  type ArmorySnapshot,
  type AwardView,
  type CombatEntity,
  type HydratedDropSnapshot as DropSnapshot,
  type MatchStatsRow,
  type EntityId,
  type GroundAreaSnapshot,
  type MapDef,
  type HydratedEntitySnapshot,
  type MovementInput,
  type ProjectileSnapshot,
  type ServerMessage,
  type Snapshot,
  TEAM_BLUE,
  type SkillDef,
  type TeamId,
  type WeaponDef,
} from '@wowpvp/shared';

import { ArsenalView, type Interactable } from '../arsenal/ArsenalView.js';
import { ArsenalHud, type InteractPrompt } from '../hud/ArsenalHud.js';
import { FfaShopHud } from '../hud/FfaShopHud.js';
import { KillFeed } from '../hud/KillFeed.js';
import { CameraController } from '../camera/CameraController.js';
import { AnimationController } from '../entity/AnimationController.js';
import { CharacterView } from '../entity/CharacterView.js';
import { Action, InputManager, type FrameInput } from '../input/InputManager.js';
import { gateInputWhenDead } from '../input/deathGate.js';
import { DecorRenderer } from '../render/DecorRenderer.js';
import { EntityLod } from '../render/entityLod.js';
import { canvasSize } from '../render/canvasSize.js';
import { GameLoop } from '../render/GameLoop.js';
import { MapRenderer } from '../render/MapRenderer.js';
import { QualityController } from '../render/QualityController.js';
import { SceneShell } from './SceneShell.js';
import {
  ctfHudViewFromMatch, factionRingViewsOf, queueExpiredFlash,
} from './sceneViews.js';
import { Environment } from '../render/Environment.js';
import { Connection, type NetLink } from '../net/Connection.js';
import { Interpolator } from '../net/Interpolator.js';
import { SnapshotHydrator } from '../net/SnapshotHydrator.js';
import { Predictor } from '../net/Predictor.js';
import { pickTabTargetFromSnapshot } from '../net/snapshotTargeting.js';
import { CombatHud } from '../hud/CombatHud.js';
import { partyViewFromSnapshot } from '../hud/PartyFrame.js';
import type { MinimapBlip } from '../hud/ModeHud.js';
import { nextSpectateSeatTarget, nextSpectateTarget } from '../spectate/SpectateController.js';
import {
  SPECTATE_HINT_TEXT, midJoinClassNotice, spectateBannerText,
} from '../spectate/spectateView.js';
import { SettingsPanel, rebindableActions, prettyKey } from '../settings/SettingsPanel.js';
import { makeRebindController } from '../settings/keybindings.js';
import {
  SKILL_BAR_SLOTS, assignSlot, loadSkillBar, saveSkillBar,
} from '../settings/skillLoadout.js';
import { MusicDirector, ambientTrackFor } from '../audio/MusicDirector.js';
import { groundOf, presetOf } from '../render/Environment.js';
import { SnapshotCombatView, castStateFromStarted } from '../net/SnapshotCombatView.js';
import { audio } from '../audio/AudioManager.js';
import { FAIL_TEXT } from '../combat/CombatDirector.js';
import { AimingController, type AimInput } from '../targeting/AimingController.js';
import { DirectionIndicator } from '../targeting/DirectionIndicator.js';
import { GroundIndicator, screenToGround } from '../targeting/GroundIndicator.js';
import { SpellVfx, type CastView, type SpellVfxStatus } from '../vfx/SpellVfx.js';
import { FlagMarkers } from '../vfx/FlagMarkers.js';
import { StatusMarkers } from '../vfx/StatusMarkers.js';
import { TargetRing } from '../vfx/TargetRing.js';
import { FactionRings } from '../vfx/FactionRing.js';
import { strongestShield, type ControlKind } from '../vfx/status.js';
import { visualForAuraId, visualForSchool } from '../vfx/schools.js';
import { debuffShellOf } from '../vfx/debuffAura.js';
import { stunWobbleActive } from '../entity/stunWobble.js';
import { isMorphedByAuraIds } from '../entity/morphForm.js';
import {
  DEFAULT_ACCESSIBILITY,
  loadAccessibility,
  paletteFor,
  saveAccessibility,
  type AccessibilitySettings,
} from '../settings/accessibility.js';
import { HitStop } from '../render/HitStop.js';
import { HitFeedback } from '../feedback/HitFeedback.js';

/**
 * 底部一行键位提示（合同 C7 的内容）。
 * ★ 只列**主路径上真的会用到**的键，不抄一份完整键位表 —— 完整表在 F10。
 */
const NET_HINT_TEXT =
  'Tab 选目标 · 点模型选中 · F 焦点 · 1–9 技能 · Esc 取消读条 · G 交互 · R 解控 · O 记分板 · F10 设置与键位重绑';

/**
 * 8.2「迷惑」= 换小动物模型的判据**不在这里**：见 `entity/morphForm.ts`。
 * ⚠️ 这里曾经是一行 `const MORPH_AURA_ID = 'control.incapacitate'` ——
 *   按**单一光环 id** 比对，于是自带 id 的气旋囚笼（`druid.cyclone`，
 *   同为 Incapacitate + stunned）在联网局里不换模型，人形边走边晃头，
 *   而试验场同一发是小鸡（X29 复盘）。判据统一到递减类别 + 旗标之后，
 *   两个场景与 sim 的游走判据同源。
 */

/**
 * 大乱斗「巨人化药水」的光环 id（shared/data/party.ts）。
 * ★ 1.6 倍是**视觉**倍数 —— 碰撞体不变（验收 #10，见 `CharacterView.setBodyScale`）。
 *   占位值：再大就会挡住队友的屏幕，再小就看不出「我变成巨人了」。
 */
const GIANT_AURA_ID = 'ffa.giant_growth';
const GIANT_BODY_SCALE = 1.6;

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
  /**
   * W24：这一场是**观战席**入场（`MatchStart.spectating`）。
   *
   * ★★ 为什么在构造参数里也要有一份，而不是只等 `MatchStart` 到达时再判：
   *   构造函数会把自己的角色模型加进场景并请求挂载（`setClass` 是幂等首调
   *   生效的）。观战席没有身体，那具模型会以一个**站在原点不动的胶囊**
   *   出现在场上。大厅在 `MatchStart` 到手之后才建场景，这个值它拿得到。
   * ★ 消息仍然是权威：`MatchStart` 那一支会再确认一次（两者不一致时以消息为准）。
   */
  spectating?: boolean;
  /**
   * W24 中途加入：玩家在席位面板上**选的**职业。
   *
   * ★ 与 `classId` 刻意分成两个字段：顶替人机时 `classId` 是**当场生效的**
   *   那个（被顶替者的），这个才是他选的。两者不同 = 「还没生效」，
   *   文案由 `midJoinClassNotice` 说（竞技场那句尤其不能抄错）。
   */
  requestedClassId?: string;
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
  /** W16：场上可见的复活保护标记数 */
  spawnProtections: number;
  /**
   * X14：脚下阵营标记数与轮廓开关。
   * ★★ 存在的理由与 `casting` 那条一模一样：`FactionRings` 刻意**不读画质**
   *   （与 TargetRing/StatusMarkers 同一把锁），而「低画质下它没被裁掉」
   *   这件事只有端到端才验得出来 —— `count` 就是那条断言的读数。
   */
  factionRings: { count: number; rim: boolean };
  /**
   * W12：夺旗自检（verify:w12 的判据入口）。竞技场对局恒为 null ——
   * 顺手也是 15.4 否定式的可执行断言（竞技场里读到非 null 就是接错了）。
   */
  ctf: {
    scoreRed: number;
    scoreBlue: number;
    scoreToWin: number;
    flags: { team: number; state: string; carried: boolean }[];
    /** 场上 3D 旗帜 mesh 数（FlagMarkers 真的画了才计入）*/
    markers: number;
    respawnIn: number | null;
  } | null;
  /** W5：死亡遮罩当前是否可见 */
  deathOverlay: boolean;
  /** W5：正在观战的实体 id；未观战为 null。★ W24 起观战席也用它记「在看谁」 */
  spectating: number | null;
  /**
   * W24：本会话是**观战席**（在局、无自身实体）。
   * ★ 与 `spectating` 是两件事：那是「在看谁」，这是「我有没有身体」——
   *   死亡观战两者都有值，观战席则 `you` 为 0 时只有这一个为真。
   */
  spectatorSeat: boolean;
  /** W6：断线横幅当前是否可见（= started 且连接断开）*/
  reconnecting: boolean;
  /** W6：指令往返延迟（毫秒，EMA 平滑；未测得为 null）*/
  rttMs: number | null;
  /** W9：设置面板当前是否打开 */
  settingsOpen: boolean;
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
  /** G4：renderer/画质/环境/镜头/输入/resize 都在壳里，场景只经 getter 转发 */
  private readonly shell: SceneShell;
  private get renderer(): THREE.WebGLRenderer { return this.shell.renderer; }
  private get scene(): THREE.Scene { return this.shell.scene; }
  private get cam(): CameraController { return this.shell.cam; }
  private get input(): InputManager { return this.shell.input; }
  private readonly loop: GameLoop;
  private get quality(): QualityController { return this.shell.quality; }
  /** M12：HDR 环境光与天空 */
  private get env(): Environment { return this.shell.env; }
  /** M12：是否加载外部美术素材（`?art=off` 关闭）。见 settings/artMode.ts */
  private get art(): boolean { return this.shell.art; }
  /** 收发用的连接（自建或大厅注入的，见 NetworkSceneOptions.link）*/
  private readonly conn: NetLink;
  /** 只有自建连接才由场景负责 connect/close；注入的归大厅管 */
  private readonly ownConn: Connection | undefined;
  /** ★ 与试验场**同一个** HUD 类，喂的是快照视图而不是 CombatDirector */
  private readonly hud: CombatHud;
  private readonly view = new SnapshotCombatView();
  /** P3c：自己的职业 id（第一份快照时由 `skillBarFor` 记下，供设置面板用）*/
  private myClassId?: string;
  /** 打击感：顿帧 + 反馈编排 + 可访问性（此前联网侧从不加载设置）*/
  private readonly hitStop = new HitStop();
  private feedback!: HitFeedback;
  private access: AccessibilitySettings = DEFAULT_ACCESSIBILITY;

  private mapRenderer?: MapRenderer;
  private map?: MapDef;

  /** 自己：预测；其他人：插值。★ 两条完全不同的路径，见 docs/08 §5 */
  private predictor?: Predictor;
  private readonly interp = new Interpolator();
  /** P11 解码边界（位掩码/静态块/装备的还原，见 SnapshotHydrator）*/
  private readonly hydrator = new SnapshotHydrator();

  private readonly selfView = new CharacterView();
  private readonly selfAnim = new AnimationController();
  /** M12：当前目标的脚下指示环 */
  private readonly targetRing = new TargetRing();
  /** 5.1 焦点目标的脚下指示环。★ 与试验场同一个类、同一套语义色 */
  private readonly focusRing = new TargetRing();
  /**
   * X14 §777 第三/四通道：**全体**脚下阵营标记 + 便宜路轮廓。
   * ★ 与 `targetRing` 是分层的两件事（「他是哪一边」vs「我选的是他」），
   *   两个环半径不重叠，叠在同一个人脚下也读得开（见 FactionRing 文件头）。
   */
  private readonly factionRings = new FactionRings();
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
  /** 速赢清单记分板：最近一份 match 快照（CTF 比分/旗帜在这里）*/
  private lastMatch: Snapshot['match'] | undefined;
  /** P12 大乱斗：MatchEnd 报胜者名字用（winner 是独立队号,按名单反查）*/
  private lastStatsRows: readonly MatchStatsRow[] | undefined;
  /** 竞技场回合比分。快照不带（只有 RoundEnd 事件），本地累计 */
  private readonly roundWins = { red: 0, blue: 0 };
  /**
   * W12：旗帜的 3D 表现 —— 与试验场同一个类。竞技场对局它一帧数据都收不到
   * （`match.flags` 是 undefined），meshes 恒空 —— 15.4 的否定式免费成立。
   */
  private readonly flagMarkers = new FlagMarkers();
  /**
   * W5（技术债总账）：死亡遮罩与观战。
   * `spectatingId` 是**本地意图** —— 合法性由服务器复核（`spectatableFor`
   * 只有一个实现处），猜错的代价只是一次被拒的请求。
   */
  private readonly deathOverlay: HTMLElement;
  private readonly deathOverlaySub: HTMLElement;
  private spectatingId: number | null = null;
  /**
   * W24：本会话是观战席（无自身实体）。
   *
   * ★★ 它与 `spectatingId` 分工非常清楚，混用会立刻出错：
   *   · `spectatingId` = **在看谁**（死亡观战与观战席共用，镜头只认它）
   *   · `spectating`   = **我有没有身体**（决定预测/发不发 Input/HUD 画哪一面）
   *   死亡观战的人是有身体的，所以那条路径上 `spectating` 恒为 false。
   */
  private spectating: boolean;
  /** W24：观战席顶部提示条（「观战中 · 正在看 X · 按 V 切换视角」）*/
  private readonly spectateBanner: HTMLElement;
  /**
   * 上一帧镜头看的位置。★ 只为观战席的一个真实边界：`you === NO_ENTITY`
   * （全场阵亡/全部潜行）时**保持上一帧镜头**，而不是掉回原点。
   */
  private lastCameraTarget = { x: 0, y: 0, z: 0 };
  /** W24：顶替人机后的「职业还没生效」提示只说一次（说两遍等于噪音）*/
  private midJoinNoticeSaid = false;
  /**
   * W6（技术债总账）：断线横幅与延迟指示。
   * 横幅纯轮询 `conn.connected` —— NetLink 窄接口本来就带它，
   * 大厅路径与 `?net=` 老路零 API 改动、同一份逻辑。
   */
  private readonly connBanner: HTMLElement;
  private readonly rttLabel: HTMLElement;
  /** W9：设置面板（音量/画质/无障碍第一次在联网对局可达）*/
  private readonly settings: SettingsPanel;
  /** W13：BGM 随战斗状态切换。懒建 —— 氛围曲要等 MatchStart 的 mapId */
  private musicDir?: MusicDirector;
  /** 指令往返延迟的平滑值（EMA）。★ 含服务器 50ms tick 批处理，如实不减 */
  private rttMs: number | null = null;
  /** Input seq → 发出时刻。快照的 ackSeq 回来时配对算 RTT */
  private readonly seqSentAt = new Map<number, number>();
  /**
   * 10.2 掉落物 / 10.4 军械点的表现与 HUD。
   * ★★ 在此之前联网客户端**看不到也碰不到**任何临时武装 —— 整个 M6 在
   *   真实对局里是空的（规则全对、单测全绿、没有任何路径能触发）。
   */
  private readonly arsenalView = new ArsenalView();
  private arsenalHud!: ArsenalHud;
  /**
   * P13 大乱斗积分商店。★ 自己判断显不显示（收到过 `FfaShop` 才显示）——
   *   「哪些模式有商店」这条规则只有服务器一份，客户端不复述。
   */
  private ffaShopHud!: FfaShopHud;
  /** 16a 击杀播报 + 死亡回顾 */
  private killFeed!: KillFeed;
  private lastDrops: readonly DropSnapshot[] = [];
  private lastArmories: readonly ArmorySnapshot[] = [];
  /** 正在拾取（收到 PickupResult 或自己移动时结束）*/
  private pickingUp = false;
  /** 场景经过的总时间，驱动标记动画 */
  private elapsed = 0;

  /** M3 瞄准流程（5.4 / 5.5），与试验场同一套控件 */
  private readonly aim = new AimingController();
  private readonly groundIndicator = new GroundIndicator();
  private readonly directionIndicator = new DirectionIndicator();
  private readonly ndc = new THREE.Vector2();
  private clickFlags = { left: false, right: false };
  /** 鼠标点过的技能格，下一帧被 readInput 消费（与数字键同一条流程）*/
  private clickedSlot: number | null = null;

  private selfId: EntityId | null = null;
  /** 自己的队伍与当前硬目标 —— Tab 循环要用 */
  private selfTeam: TeamId | null = null;
  private currentTargetId: EntityId | undefined;
  /** 最近一份快照的实体列表，Tab 从它里面挑 */
  private lastEntities: readonly HydratedEntitySnapshot[] = [];
  /**
   * P10：`lastEntities` 的 id 索引。**每份快照重建一次（10Hz），不是每帧。**
   *
   * ★★ 为什么值得建：按 id 找人是这个文件里最密的一个动作 —— 每帧的
   *   `draw`/`drawRemotes`/小地图/队伍框/旗帜/观战/死亡遮罩各要找几次，
   *   `bodyOf`/`bodyBaseOf`/`yawOf` 更是**每个飞行物每帧**都要找一次
   *   （弹体的 track 闭包）。24 人 × 一把线性扫描，一帧下来是几百次比较，
   *   换成 Map 之后是几十次哈希。这不是热点，是「有 Map 不用」的白花钱
   *   （P10 原话「每帧小额浪费」）。
   * ★ 唯一的写入点是 `setEntities()` —— 索引与列表不可能不同步。
   */
  private entityById = new Map<number, HydratedEntitySnapshot>();
  /**
   * P4：骨骼动画分级取样器。★ 与试验场**同一个类** —— 两条路的分级口径
   * 不会分叉（G4 那批「网络侧做对了、试验场没跟」的反面）。
   */
  private readonly entityLod = new EntityLod();
  private started = false;
  private characterYaw = 0;
  /**
   * A5：**客户端这一侧的转身令牌桶**（和服务器同一个函数、同一份规则）。
   *
   * ★★ 它在这里不是为了防作弊 —— 自己钳自己毫无意义。它在这里是为了让
   *   `Predictor` 的立身前提继续成立：**重放用的规则必须和服务器完全相同**。
   *   服务器采信朝向时会钳（`turnRate.ts`），客户端预测若拿未钳的 yaw 积分，
   *   `stepMovement` 的移动方向当场分叉 —— 实测 1440°/s 转 0.5 秒差 0.164 m,
   *   正好落在 `CORRECTION` 的**平滑**档，于是快速转身的每一个 tick 都在被
   *   往回拽（橡皮筋）。自钳之后两边逐位一致，这条纠正根本不会被触发。
   * ★ 桶容量用客户端口径（比服务器少 5 个 tick 的余量），所以**诚实客户端
   *   永远碰不到服务器那道闸** —— 见 `TURN_BURST_SERVER_RAD` 的 ★★。
   * ★ 只有联网路径有它：试验场是本地 sim，没有信任边界（铁律③ —— `?testbed`
   *   与无参默认路径的载体行为一个字不变）。
   */
  private readonly turnBudget = createTurnBudget();
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
    // G4：renderer/画质/环境/镜头/输入/resize 全在壳里（SceneShell 文件头）
    this.shell = new SceneShell(canvas);
    this.spectating = opts.spectating === true;
    /**
     * W24：观战席**不建自己的角色模型**（见 `NetworkSceneOptions.spectating`）。
     * ★ 只是不进场，不是不构造 —— `selfView` 仍然是 `readonly` 字段，
     *   中途加入是**换一个新场景**而不是给这个场景补一具身体。
     */
    if (!this.spectating) {
      this.selfView.setClass(opts.classId);
      this.scene.add(this.selfView.group);
    }
    this.scene.add(this.targetRing.group, this.focusRing.group);
    /**
     * X14 阵营标记。★ **不受 `art` 门禁** —— 与目标环同一条理由：
     * 「谁是敌人」是可读性信息不是美术层（14.4 essential），
     * 纯程序化零贴图，`?art=off` 的回归路径照常构造。
     */
    this.scene.add(this.factionRings.group);
    // 5.5 瞄准指示器（关键 UI，不受 art 门禁）
    this.scene.add(this.groundIndicator.group, this.directionIndicator.group);
    /**
     * 10.2 / 10.4 军械表现。★ **不受 `art` 门禁** —— 掉落物与军械箱的
     * 光柱是玩法信息（10.4 要求它们出现），不是美术层。`?art=off` 下的
     * 回归路径同样要能抢装备，否则 M6 的验收在那条路径上无从谈起。
     */
    this.scene.add(this.arsenalView.group);
    /**
     * W12 旗帜。★ 与军械表现同一条理由**不受 `art` 门禁**：12.2 要求旗帜
     * 信息对双方持续可见，它是玩法信息不是美术层 —— `?art=off` 的验收
     * 路径同样要能看旗抢旗。
     */
    this.scene.add(this.flagMarkers.group);
    // 14.2 特效层：与试验场同一门禁、同一实现
    if (this.art) {
      this.spellVfx = new SpellVfx();
      this.scene.add(this.spellVfx.group);
    }
    // ⚠️ mousemove 挂 window（见处理器注释：挂 canvas 会让 NDC 冻在 UI 边缘）
    window.addEventListener('mousemove', this.onWindowMouseMove);
    canvas.addEventListener('mousedown', this.onCanvasMouseDown);
    this.addLights();
    if (this.art) this.env.apply(this.quality.current, { preset: 'day' });

    this.hud = new CombatHud(canvas.parentElement ?? document.body);
    // 10.4 / 10.5 的交互 HUD。★ 与 CombatHud 同一个容器，继承 17.2 的界面缩放
    this.arsenalHud = new ArsenalHud(canvas.parentElement ?? document.body);
    this.arsenalHud.onChoose = (armoryId, choice) =>
      this.conn.send({ t: 'ChooseArsenal', armoryId, choice });
    /**
     * P13 大乱斗积分商店。★ 客户端**只发意图**（商品编号）——
     *   价格、余额、能不能买全在服务器（`buyFfaOffer`），这边一个判据都不复述。
     */
    this.ffaShopHud = new FfaShopHud(canvas.parentElement ?? document.body);
    this.ffaShopHud.onBuy = (offerId) => this.conn.send({ t: 'FfaBuy', offerId });
    // 16a 击杀播报与死亡回顾。★ 名字从快照查 —— 本类不持有任何战斗状态
    this.killFeed = new KillFeed(canvas.parentElement ?? document.body);
    this.killFeed.nameOf = (id) =>
      this.entityOf(id)?.name;

    /**
     * W5：死亡遮罩。此前玩家死后对着一具尸体和一个还能拖的镜头，没有任何
     * 「接下来会发生什么」的信息 —— SpectateController 那句「返回 undefined
     * 表示应显示死亡界面」指着一个不存在的界面。
     * ★ 样式内联、文案走 textContent（玩家名是不受信任输入，不进 innerHTML）。
     */
    this.deathOverlay = document.createElement('div');
    this.deathOverlay.id = 'death-overlay';
    Object.assign(this.deathOverlay.style, {
      position: 'absolute', left: '50%', top: '34%', transform: 'translate(-50%,-50%)',
      padding: '14px 26px', borderRadius: '10px',
      background: 'rgba(12,10,14,.82)', border: '1px solid rgba(255,122,111,.4)',
      color: '#f3e9e7', font: '600 15px system-ui, sans-serif', textAlign: 'center',
      pointerEvents: 'none', display: 'none', zIndex: '30', lineHeight: '1.9',
    } as Partial<CSSStyleDeclaration>);
    const dTitle = document.createElement('div');
    Object.assign(dTitle.style, { fontSize: '20px', letterSpacing: '.2em' });
    dTitle.textContent = '你已阵亡';
    this.deathOverlaySub = document.createElement('div');
    Object.assign(this.deathOverlaySub.style, { opacity: '.75', fontWeight: '400' });
    this.deathOverlay.append(dTitle, this.deathOverlaySub);
    (canvas.parentElement ?? document.body).appendChild(this.deathOverlay);

    /**
     * W6：断线横幅。此前 `?net=` 老路的 onClose 是空实现、大厅只在放弃
     * 重试后 toast 一次 —— 约 7.75 秒的退避重连全程零提示，玩家分不清
     * 「我卡了」「被控了」「服务器炸了」。
     */
    this.connBanner = document.createElement('div');
    this.connBanner.id = 'conn-banner';
    Object.assign(this.connBanner.style, {
      position: 'absolute', left: '50%', top: '12%', transform: 'translate(-50%,0)',
      padding: '10px 22px', borderRadius: '8px',
      background: 'rgba(64,20,16,.88)', border: '1px solid rgba(255,122,111,.55)',
      color: '#ffd9d4', font: '600 14px system-ui, sans-serif', textAlign: 'center',
      pointerEvents: 'none', display: 'none', zIndex: '40', lineHeight: '1.8',
    } as Partial<CSSStyleDeclaration>);
    // ★「尝试」二字是措辞的诚实：NetLink 看不到退避次数，放弃重试后由
    //   大厅的 toast 补终态提示 —— 本横幅只陈述「断了、在试」这个事实
    this.connBanner.textContent = '连接已断开 · 正在尝试重连（角色留在原地，不获得无敌）';
    (canvas.parentElement ?? document.body).appendChild(this.connBanner);

    /**
     * W10：一行键位提示。新玩家的主路径（大厅 → 开局）此前**恰好是唯一
     * 没有任何键位提示的路径** —— 第一局不知道 G 是交互、Esc 能假读条。
     * 完整键位表在 F10 设置面板里，这一行只解决「知道去哪看」。
     *
     * ★ 合同 C7：本场景原本自己建一个 `#net-hint`，试验场则完全没有提示条。
     *   现在两场景共用 `SceneShell.showHintBar()` 那一条 —— 本地那份删掉，
     *   否则屏幕底部会同时出现两条（双条比没有更糟）。
     *   F 键与「点模型」是本轮才接通的两条（此前写进提示就是在撒谎）。
     */
    this.shell.showHintBar(this.spectating ? SPECTATE_HINT_TEXT : NET_HINT_TEXT);

    /**
     * W24：观战席的顶部提示条。★ 与死亡遮罩**刻意不是同一个控件**：
     *   遮罩说的是「你死了、接下来会发生什么」，这一条说的是「你没有身体，
     *   现在在看谁」。共用一个控件就必须往里塞两套语义，而观战席永远
     *   不该看到「你已阵亡」四个字。
     * ★ 文案走 textContent（玩家名是不受信任输入），与遮罩同一条纪律。
     */
    this.spectateBanner = document.createElement('div');
    this.spectateBanner.id = 'spectate-banner';
    Object.assign(this.spectateBanner.style, {
      position: 'absolute', left: '50%', top: '5%', transform: 'translate(-50%,0)',
      padding: '8px 20px', borderRadius: '8px',
      background: 'rgba(14,16,22,.78)', border: '1px solid rgba(154,212,143,.42)',
      color: '#e7f1e4', font: '600 14px system-ui, sans-serif', textAlign: 'center',
      pointerEvents: 'none', display: 'none', zIndex: '32', letterSpacing: '.04em',
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(this.spectateBanner);

    // W6：延迟指示。小、常驻、不抢注意力 —— 有异常时颜色先说话
    this.rttLabel = document.createElement('div');
    this.rttLabel.id = 'rtt-label';
    Object.assign(this.rttLabel.style, {
      position: 'absolute', right: '10px', bottom: '8px',
      color: '#9ad48f', font: '500 11px ui-monospace, monospace',
      pointerEvents: 'none', zIndex: '20', opacity: '.8',
    } as Partial<CSSStyleDeclaration>);
    (canvas.parentElement ?? document.body).appendChild(this.rttLabel);

    /**
     * W9（技术债总账）：设置面板 —— F10。此前 F3/F4 只在试验场响应，
     * 九项无障碍里六项在联网对局**完全无法触达**；音量只有 M 全静音。
     * ★ 面板不持状态：无障碍走本场景的 `setAccessibility()` 唯一入口，
     *   画质与 F2 走**同一条**应用链（漏一环就是「面板改了没生效」）。
     */
    // W7：重绑控制器（应用到 InputManager + 落 localStorage），两场景共用
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
       * P3c 技能栏自定义。职业在第一份快照到达前未知 —— pool 返回空数组，
       * 面板对空池不渲染该区块（打开早了就是暂时看不到，不炸）。
       */
      skillBar: {
        current: () => this.view.skills,
        pool: () => (this.myClassId ? (getClass(this.myClassId as never)?.skills ?? []) : []),
        assign: (slot, skillId) => {
          if (!this.myClassId) return;
          const next = assignSlot(this.view.skills.map((sk) => sk.id as string), slot, skillId);
          saveSkillBar(globalThis.localStorage, this.myClassId, next);
          this.view.setSkillBar(this.skillBarDefsFor(this.myClassId));
        },
        reset: () => {
          if (!this.myClassId) return;
          const cls = getClass(this.myClassId as never);
          if (!cls) return;
          saveSkillBar(
            globalThis.localStorage, this.myClassId,
            cls.skills.slice(0, SKILL_BAR_SLOTS).map((sk) => sk.id as string),
          );
          this.view.setSkillBar(this.skillBarDefsFor(this.myClassId));
        },
      },
      /**
       * X10 追加轮：对局里的退出路径（此前只能关标签页）。
       * ★ 语义如实：LeaveMatch = 主动弃权，按淘汰结算（11.5）—— 提示里
       *   写明白，不让人以为是「暂离」。发完消息直接回大厅页。
       */
      leaveMatch: {
        label: '离开对局并返回大厅',
        hint: '主动退出按弃权淘汰结算（11.5），本局不可重新加入',
        run: () => {
          this.conn.send({ t: 'LeaveMatch' });
          location.href = `${location.pathname}?lobby`;
        },
      },
    });
    /**
     * P3c：联网技能栏 = 玩家自定义的 9 格；无存档 → 本职业前 9 个技能，
     * 即改动前数字键能按到的那 9 个（键位含义不变，w12 按 fire_blast 的
     * 槽位照旧）。10 格之后原本只能鼠标点的技能进了自定义池。
     */
    this.view.skillBarFor = (classId) => {
      /**
       * W24：观战席的 `you` 是**他正在看的人** —— 把那个人的职业记成
       * `myClassId` 会让 F10 设置面板列出一份「他的技能栏」并允许改存档
       * （改的还是别人职业的那一份）。如实返回空栏：技能栏本来就不画。
       */
      if (this.spectating) return [];
      this.myClassId = classId;
      return this.skillBarDefsFor(classId);
    };
    // W7：技能栏 <kbd> 读**实时**绑定 —— 换了技能键就跟着变，不再写死 1–9
    this.hud.skillKeyLabel = (i) =>
      prettyKey(this.input.getBindings()[`skill${i + 1}` as never] ?? String(i + 1));
    /**
     * 连杀升调：同一个音效按连杀数提速 —— 「升调」用 `rate` 而不是换音效，
     * 因为素材里**没有**一组连杀音（盘里只有 ui_arena_loss，连 win 都没有）。
     * ★ 不编一个不存在的资源 id：那会变成一次静默的加载失败。
     */
    this.killFeed.onStreak = (_name, streak) =>
      audio.play('ui_masterwork', {
        group: 'ui',
        volume: Math.min(1, 0.45 + streak * 0.1),
        rate: Math.min(1.6, 1 + (streak - 2) * 0.12),
      });
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
    // 鼠标点技能格 → 记下槽位，下一帧走与数字键完全相同的瞄准流程
    this.hud.onSkillClick = (slot) => { this.clickedSlot = slot; };
    // 点姓名板选人 → 发 SetTarget（服务器仍会校验可见集合）
    this.view.onSelect = (id) => {
      /**
       * W24：观战席**一条 `SetTarget` 都不发**。服务器的阶段白名单会拒
       * （`SetTarget` 是验收 #5 的探测通道，观战席拿不到它），发上去只换来
       * 一串拒绝刷屏 —— 而「按了没反应」正是本仓库最难查的一类。
       */
      if (this.spectating) return;
      this.currentTargetId = id;
      this.view.targetId = id;
      this.conn.send({ t: 'SetTarget', slot: 'hard', entityId: id });
    };
    // 6.5 朝向提示用**本地预测**的角色 yaw（快照的 yaw 晚一个单程延迟）
    this.view.selfYaw = () => this.characterYaw;
    this.wireHudInteractions();

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

  }

  /**
   * 合同 C2 / C4 的接线：瞄准期间点姓名板 = 确认落点；点队伍框成员 = 选中他。
   *
   * ★★ 为什么要 C2：姓名板与队伍框是**盖在画面上的 DOM**，瞄准时想把落点
   *   放在某个人身上，鼠标必然经过他的姓名板 —— 那一下此前被当成「换目标」，
   *   于是瞄准被打断、落点丢失。现在瞄准期间那一下改为**确认落点**且不改目标。
   * ★ 判定与动作分离：HUD 只问「现在在瞄准吗」，怎么算瞄准、确认之后干什么
   *   全在场景这边 —— HUD 因此不需要认识 `AimingController`。
   */
  private wireHudInteractions(): void {
    this.hud.aimActiveProbe = () => this.aim.isAiming;
    // ★ 与 canvas 左键走**同一个**标志位：瞄准状态机只认识 clickFlags
    this.hud.onAimConfirm = () => { this.clickFlags.left = true; };
    // C4：点队伍框成员 → 与点姓名板同一条路径（发 SetTarget，服务器仍复核）
    this.hud.party.onSelectMember = (entityId) => this.view.selectById(entityId);
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
    // X15 指针锁定：与顿帧同形 —— 设置对象是唯一入口，输入层只被告知
    this.input.setPointerLockEnabled(next.pointerLock);
    saveAccessibility(globalThis.localStorage, next);
  }

  get accessibility(): AccessibilitySettings {
    return this.access;
  }

  dispose(): void {
    this.loop.stop();
    this.ownConn?.close();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    this.canvas.removeEventListener('mousedown', this.onCanvasMouseDown);
    this.spellVfx?.dispose();
    this.flagMarkers.dispose();
    this.factionRings.dispose();
    this.shell.dispose();
  }

  /**
   * ⚠️⚠️ **挂在 window 上，不是 canvas 上**（与试验场同根的一个坑）。
   *
   *   HUD 覆盖层里有可点的部分（姓名板、技能格、面板）—— 它们 `pointer-events`
   *   是打开的，指针划过去时 canvas 就**收不到 mousemove 了**。挂 canvas 的
   *   后果是 NDC 停在「进入那块 UI 之前的最后一个点」：地面指示器冻在原地，
   *   玩家以为落点选好了，实际按下去落在别处。
   * ★ 换成 window 之后坐标换算不变 —— `ndcFromMouse` 本来就是按 canvas 的
   *   矩形算的，指针在 canvas 外时算出来的 NDC 超出 [-1,1]，射线自然打不中东西。
   */
  private onWindowMouseMove = (ev: MouseEvent): void => {
    /**
     * X15：指针锁定期间屏幕上没有光标，`clientX/Y` 被冻在上锁那一刻 ——
     * 悬停拾取整体暂停（与试验场同一条），退锁自动恢复。
     * ★ 12v12 下这还顺手省掉了转身全程每次 mousemove 的 23 次 raycast。
     */
    if (this.input.pointerLocked) {
      this.canvas.classList.remove('cursor-attack', 'cursor-friendly');
      return;
    }
    this.shell.ndcFromMouse(ev, this.ndc);
    this.updateHoverCursor();
  };

  /**
   * 5.2：左键点角色模型设为硬目标 + 5.5 瞄准的左右键。
   *
   * ★★ P10：射线选中此前**联网侧独缺** —— 试验场有（`TestbedScene`
   *   的同名方法），联网侧这个处理器只喂瞄准状态机。于是联网对局里
   *   点人只能点姓名板那一小块，点模型没有任何反应。
   * ⚠️ `ev.target` 守卫：这个处理器挂在 canvas 上，但（与 mousemove 同一个
   *   原因）冒泡上来的 UI 点击不该被当成「点空地/点人」—— 尤其不能把
   *   点技能格的那一下算成一次瞄准确认。
   */
  private onCanvasMouseDown = (ev: MouseEvent): void => {
    if (ev.target !== this.canvas) return;
    // 5.5：左键确认落点、右键取消 —— 只喂给瞄准状态机
    if (ev.button === 0) this.clickFlags.left = true;
    if (ev.button === 2) this.clickFlags.right = true;

    // 瞄准期间左键只用于确认落点，不改变目标（与试验场同一条守卫）
    if (ev.button !== 0 || this.aim.isAiming) return;
    const hit = this.pickEntityAt(this.shell.ndcFromMouse(ev, new THREE.Vector2()));
    // 5.1：点空地**不清除**硬目标 —— 硬目标持续保留
    if (hit !== undefined) this.view.selectById(hit);
  };

  /**
   * 屏幕坐标 → 命中的实体 id（最近的一个）。没打中人返回 undefined。
   *
   * ★ 只对**远端**角色组做射线：自己的模型挡在镜头前时不该把自己选中，
   *   而联网侧选自己走的是队伍框（15.1）与 Alt 自我施法两条路。
   * ⚠️ 与试验场是两份**平行**实现（那边遍历 `dummyViews`，这边遍历 `views`）——
   *   统一成一个「可拾取角色注册表」是 G4 那类共用地基的活，不在本轮范围内。
   */
  private pickEntityAt(ndc: THREE.Vector2): number | undefined {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.cam.camera);
    let best: { id: number; dist: number } | undefined;
    for (const [id, view] of this.views) {
      /**
       * ★ 尸体不参与拾取：服务器的 `setHardTarget` 会因 `isSelectableBy`
       *   为假而拒绝，这里放行只会造出「本地选中了、服务器没有」的分叉。
       *   ⚠️ 客户端只判得了「死没死」—— `untargetable`（剑刃风暴）不在
       *   `DisplayFlags` 里，那一条仍然只有服务器判得了。
       */
      if (!this.entityOf(id)?.alive) continue;
      const hits = ray.intersectObject(view.group, true);
      if (hits.length && (!best || hits[0]!.distance < best.dist)) {
        best = { id, dist: hits[0]!.distance };
      }
    }
    return best?.id;
  }

  /**
   * M12：光标随悬停对象变化（敌对=剑、友方=盾、其余=手）。
   * ★ 5.2「点击选中」的预告：按下之前就知道会点到谁。
   * ★ 只在鼠标移动时算一次射线，不进每帧循环 —— 12v12 下逐帧对 23 个
   *   角色组做 raycast 是白扔掉的帧（与试验场同一条理由）。
   */
  private updateHoverCursor(): void {
    const cls = this.canvas.classList;
    // 瞄准期间光标语义由地面指示器承担
    if (this.aim.isAiming || !this.started) {
      cls.remove('cursor-attack', 'cursor-friendly');
      return;
    }
    const id = this.pickEntityAt(this.ndc);
    const team = id === undefined
      ? undefined
      : this.entityOf(id)?.team;
    cls.toggle('cursor-attack', team !== undefined && team !== this.selfTeam);
    cls.toggle('cursor-friendly', team !== undefined && team === this.selfTeam);
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
      // W16：场上可见的复活保护标记数（verify 断言读它）
      spawnProtections: [...this.statusMarkers.values()]
        .filter((m) => m.spawnProtectionVisible).length,
      // X14：脚下阵营标记（低画质不裁的端到端读数）
      factionRings: { count: this.factionRings.count, rim: this.factionRings.rim },
      ctf: this.ctfStatus(),
      // W5：死亡遮罩与观战状态（verify:m13 的判据入口）
      deathOverlay: this.deathOverlay.style.display !== 'none',
      spectating: this.spectatingId,
      // W24：观战席（无自身实体）——「技能栏该不该在」的端到端读数
      spectatorSeat: this.spectating,
      // W6：断线横幅与指令往返延迟
      reconnecting: this.connBanner.style.display !== 'none',
      rttMs: this.rttMs === null ? null : Math.round(this.rttMs),
      // W9：设置面板
      settingsOpen: this.settings.visible,
      fps: this.loop.fps,
    };
  }

  /** W12：夺旗自检数据（NetStatus.ctf）。竞技场如实 null */
  private ctfStatus(): NetStatus['ctf'] {
    const m = this.lastMatch;
    if (!m || m.flags === undefined) return null;
    const score = m.score ?? {};
    return {
      scoreRed: score[String(TEAM_RED as number)] ?? 0,
      scoreBlue: score[String(TEAM_BLUE as number)] ?? 0,
      scoreToWin: m.scoreToWin ?? 0,
      flags: m.flags.map((f) => ({
        team: f.team as number,
        state: String(f.state),
        carried: f.carrierId !== undefined,
      })),
      markers: this.flagMarkers.count,
      respawnIn: m.respawnIn ?? null,
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
        this.started = true;
        this.loadMap(msg.mapId as string);
        /**
         * ★★ W24：`spectating` 是「`you` 不是我，是我在看的人」那面旗子
         *   （协议注释里的原话）。不读它的后果非常具体：观战者会对着**别人的
         *   角色**建预测器、每 50ms 发一条 `Input` —— 服务器按阶段丢弃，
         *   而画面上那个人会与快照打架（预测在推、权威在拉）。
         * ★ 重连也走这条分支：观战者凭同一个令牌回来仍是观战席，
         *   服务器重发的 MatchStart 照样带 `spectating`。
         */
        this.spectating = msg.spectating === true;
        if (this.spectating) {
          this.enterSpectatorSeat(msg.you);
          this.interp.reset();
          this.hydrator.reset();
          break;
        }
        this.selfId = msg.you;
        /**
         * ★ 预测器在这里才建得出来 —— 它需要地图几何做碰撞。
         *   起点先用 (0,0,0)，第一份快照会把它纠正到权威位置；
         *   纠正幅度会很大，但那一次**本来就该是瞬移**（刚出生）。
         */
        this.predictor = new Predictor(
          createMovementState({ x: 0, y: 0, z: 0 }, 0),
          {
            obstacles: this.map?.geometry ?? [],
            /**
             * ★ 13.5 软推开的预测输入：最新快照里其他存活实体的位置。
             *   与服务器的权威位置有一个快照间隔的偏差，但只在「与人重叠」的
             *   短暂窗口内起效 —— 比完全不预测（重叠期每份快照橡皮筋）小得多。
             */
            others: () =>
              this.lastEntities
                .filter((e) => e.alive && e.id !== this.selfId)
                .map((e) => e.position),
          },
        );
        /**
         * ★ 重连也走这条分支（服务器重连成功后会再发一次 MatchStart）。
         *   docs/08 §6：「客户端丢弃所有本地状态」—— 插值缓冲一并清空，
         *   否则会拿 90 秒前的帧去插值。
         * ★ P11：hydrator 的静态块/装备缓存同步清空 —— 服务器侧的
         *   per-Session 记账此刻也是空的（重连 = 新 Session），两边对齐。
         */
        this.interp.reset();
        this.hydrator.reset();
        break;
      }

      /** P11 元数据通道（静态块+装备）—— 必然先于含新实体的快照到达 */
      case 'EntityMeta':
        this.hydrator.setMeta(msg.items);
        break;

      case 'Snapshot': {
        this.snapshotCount++;
        this.serverTime = msg.time;
        /**
         * W6：指令往返延迟。ackSeq 在服务器 tick 边界确认，所以样本含
         * 最多 50ms 的批处理时延 —— 如实不减：玩家感受到的就是这个总和。
         */
        {
          const sentAt = this.seqSentAt.get(msg.ackSeq);
          if (sentAt !== undefined) {
            const sample = performance.now() - sentAt;
            this.rttMs = this.rttMs === null ? sample : this.rttMs * 0.8 + sample * 0.2;
            for (const k of this.seqSentAt.keys()) if (k <= msg.ackSeq) this.seqSentAt.delete(k);
          }
        }
        /**
         * ★ P11 解码边界：wire 形态在这里一次性还原成完整形态
         *   （位掩码展开、静态块/装备从 EntityMeta 缓存合并、self 段合到
         *   you 实体、drops 合回 pickable —— 见 SnapshotHydrator），
         *   下游全部读 `hydrated`，不再看 msg 的原始字段。
         */
        const hydrated = this.hydrator.hydrateSnapshot(msg);
        const entities = hydrated.entities;
        this.interp.push(msg.time, entities);
        this.setEntities(entities);
        // 14.4 投射物 / 14.3 地面区域：留给 draw 里的 spellVfx.frame 消费
        this.lastProjectiles = msg.projectiles;
        this.lastGrounds = msg.grounds;
        // 10.2 / 10.4：军械数据留给 draw 里的 arsenalView 消费
        // （drops 已在 hydrate 时合回按接收者的 pickable —— 波3）
        this.lastDrops = hydrated.drops;
        this.lastArmories = msg.armories;
        this.lastMatch = msg.match;
        /**
         * ★★ W24 观战席：`you` **每份快照都可能变** —— 被跟随者死了或遁形了，
         *   服务器会自动退回可跟随列表里的第一个（`spectatableForSpectator`，
         *   按 id 序，确定性），一个可跟的都没有时发 `NO_ENTITY`（0 哨兵）。
         *   所以客户端**不维护**一份自己的跟随记账：以快照为准 —— 与 A11
         *   「复活这件事只有服务器说了算」同一条哲学，也省掉一条「服务器
         *   已经换人了、客户端还盯着尸体」的窗口。
         */
        if (this.spectating) {
          this.spectatingId =
            (msg.you as number) === (NO_ENTITY as number) ? null : (msg.you as number);
        }
        /**
         * ★ 观战席这一行照旧成立且**有用**：`you` 是被跟随者，于是脚下阵营
         *   标记与小地图按「他那一队」上色 —— 转播视角本来就该是这样，
         *   而这不多给任何信息（观战段是两队的交集，跟到谁都一样）。
         */
        this.selfTeam = entities.find((e) => e.id === msg.you)?.team ?? this.selfTeam;
        /**
         * 5.1 焦点回读。★ 服务器是切换语义的唯一实现处，所以焦点**只从快照来**
         *   （波3 后住在 self 段、由 hydrate 合回 you 实体 —— 语义原样）。
         *   焦点离场/潜行遁走时字段自然消失，客户端不需要一条「清焦点」的逻辑。
         */
        this.view.focusId = entities.find((e) => e.id === msg.you)?.focusId;
        this.view.ingest(hydrated, msg.time);
        // W24：顶替人机之后那句「你选的职业还没生效」（判据要等自己那份快照）
        this.noteMidJoinClass();

        const me = entities.find((e) => e.id === msg.you);
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
        /**
         * 10.2「交互时提示『职业不匹配』」——**在人眼看的地方**提示。
         * 战斗日志在屏幕角落，而玩家此刻正盯着脚下那件装备。
         */
        if (msg.what === 'InteractStart' || msg.what === 'OpenArmory' || msg.what === 'ChooseArsenal') {
          this.arsenalHud.toast(msg.reason, this.serverTime);
          this.pickingUp = false;
        }
        /**
         * P13：买不成也要在人眼看的地方说 —— 玩家此刻正盯着商店面板，
         * 「积分不足（需要 200）」落在左下角战斗日志里等于没说。
         * ★ 复用军械 toast 通道，不为商店另造一个提示框（同一件事一份实现）。
         */
        if (msg.what === 'FfaBuy') this.arsenalHud.toast(msg.reason, this.serverTime);
        break;

      /**
       * P13 大乱斗积分商店：余额 + 这个职业的货架。
       * ★ 私信；进对局发一次、余额一变就重发 —— 面板从不自己算账（见 FfaShopHud）。
       */
      case 'FfaShop':
        this.ffaShopHud.update(msg.balance, msg.offers);
        break;

      /** 10.4：军械箱的三选一。★ 这是私信，只有打开者会收到 */
      case 'ArsenalOffer':
        this.arsenalHud.showOffer({ armoryId: msg.armoryId, options: msg.options });
        audio.play('ui_click', { group: 'ui', volume: 0.5 });
        break;

      /** 10.5：拾取的明确成败反馈（含「被别人抢先拿走了」）*/
      case 'PickupResult':
        this.pickingUp = false;
        this.arsenalHud.endPickup(msg.ok, msg.reason, this.serverTime);
        if (msg.ok) audio.play('ui_click', { group: 'ui', volume: 0.6 });
        break;

      // 战斗事件 → 战斗日志。★ 与试验场同一套文案由 HUD 渲染
      //
      // ★ M12 音效在这里接**协议消息**，而不是 CombatEvent —— 联网客户端
      //   没有本地 sim，它知道的只有服务器发来的这几条。W17/X3 之后信息与
      //   试验场对齐（avoided 区分、skillId 真名），这一层不再「如实地少一层」
      case 'Damage': {
        // W13：可见的战斗事件 = BGM 的战斗判定来源（联网口径）
        this.musicDir?.noteCombat(this.serverTime);
        /**
         * 打击感改造：整段交给 HitFeedback（与试验场同一编排、同一分档判据）。
         * ★ W17：`avoided`（闪避/招架/格挡）现在从协议来 —— HitFeedback 据它
         *   出「闪避/招架/格挡」浮字与对应音效（此前联网侧全缺，只能吃「0 伤害」）。
         * 联网侧的 crit/overkill 来自协议，maxHealth 从快照查。
         */
        this.feedback.onHit({
          targetId: msg.targetId, sourceId: msg.sourceId,
          amount: msg.amount, absorbed: msg.absorbed, immune: msg.immune,
          crit: msg.crit === true, overkill: msg.overkill, school: msg.school,
          // P3 签名命中音的钥匙；来源不可见时协议已抹（回落学派音是正确行为）
          skillId: msg.skillId,
          ...(msg.avoided ? { avoided: msg.avoided } : {}),
          targetMaxHealth: this.entityOf(msg.targetId)?.maxHealth,
        });
        /**
         * W21：白字挥砍动画 —— 协议没有 Swing 消息，从 autoAttack 伤害事件
         * **反推**（用户拍板的便宜路，X10 真机轮）。口径如实记：落空的挥击
         * 没有动作（协议里根本没有那一拍）；来源被抹（S7 不可见）时没有
         * view，自然不播。表现与试验场 onSwingHit 对称：挥砍 + 破空声。
         */
        if (msg.skillId === 'autoAttack' && msg.sourceId !== undefined) {
          this.viewOfEntity(msg.sourceId)?.playMeleeSwing();
          audio.playVariant('swing', { volume: 0.45, ...this.audioDistance(msg.sourceId) });
        }
        // 战斗日志：规避如实写「闪避/招架/格挡」而不是「0 点伤害」
        const line = msg.avoided
          ? `${this.nameOf(msg.targetId)} ${AVOIDED_TEXT[msg.avoided]}了 ${this.nameOf(msg.sourceId)}`
          : `${this.nameOf(msg.sourceId)} → ${this.nameOf(msg.targetId)} ${msg.amount} 点伤害`;
        this.view.push(line, 'ok');
        /**
         * 16a 死亡回顾的原料。★ 只记打到**自己**身上的 —— 12v12 里全场
         * 伤害流会把这个数组变成内存黑洞，而回顾要回答的只有「我怎么死的」。
         * ★ X3：协议现在带 skillId → 显示技能真名（`getSkill`），`autoAttack`
         *   映射「普通攻击」，查不到（来源不可见时被抹）才退回学派兜底。
         */
        if (msg.targetId === this.selfId) {
          this.killFeed.noteIncoming(this.serverTime, {
            sourceId: msg.sourceId,
            amount: msg.amount,
            crit: msg.crit === true,
            skillName: skillNameFor(msg.skillId, msg.school),
          });
        }
        break;
      }
      case 'Heal': {
        this.musicDir?.noteCombat(this.serverTime); // W13：治疗同样算战斗活动
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
        // 16a 击杀播报 + 连杀。★ killerId 可空是协议的事实（验收 #5），如实写「阵亡」
        this.killFeed.pushKill(
          this.serverTime, msg.killerId,
          msg.killerId === undefined ? undefined : this.nameOf(msg.killerId),
          msg.entityId, this.nameOf(msg.entityId),
        );
        // 16a 死亡回顾：只在**自己**死的时候摊开
        if (msg.entityId === this.selfId) this.killFeed.showRecap(this.serverTime);
        break;
      }
      case 'CastFailed': {
        audio.play('ui_error', { group: 'ui', volume: 0.5 });
        const text = `施法失败：${FAIL_TEXT[msg.reason] ?? msg.reason}`;
        this.view.push(text, 'fail');
        /**
         * 合同 C2：**同一句话**也送到屏幕中部。战斗日志在左下角，而玩家此刻
         * 正盯着准星 —— 「按了没反应」这类问题的根因就是失败原因只走了日志。
         * ★ 与试验场同一条纪律（`CombatDirector.selfFail`）：中部提示与日志
         *   说同一句，玩家不必在两处之间做翻译。
         */
        this.hud.showCenterNotice(text);
        break;
      }
      /**
       * X21：0.4 秒排队窗过期 —— 「刚才那一下没赶上」。
       *
       * ★★ 刻意**不进战斗日志、不发中部提示、不响 ui_error**：它是一张回执，
       *   不是一个要求玩家改变操作的提示。X21 拍板时把「迟到的失败提示比
       *   沉默更误导」写进了 sim（那里专门不发 `onFailed`），在表现层把它
       *   请回一条 fail 日志，等于把刚拍完的板再拆掉。
       * ★ 与 `CastFailed` 的分工因此非常清楚：那条说「不能放」，这条说
       *   「按早了」，两者可以同时为真，长相也刻意不同（见 CombatHud 的 `.sk-late`）。
       */
      case 'CastQueueExpired':
        queueExpiredFlash(msg, this.hud);
        break;
      case 'CastStarted': {
        /**
         * ★ P3 技能签名：`playCast(school)` → `playCastFor({id, school})`。
         *   `CastStarted` 消息里 `skillId` 是**必填**的（协议 :304），
         *   与 `school` 同源同帧，穿过来零代价 —— 此前只递 school，
         *   联网侧和试验场一样落在「七个学派音」上。
         */
        audio.playCastFor(
          { id: msg.skillId, school: msg.school },
          { ...this.audioDistance(msg.casterId), volume: 0.7 },
        );
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
         * ★ 引导例外（X10 追加轮起**需要**了）：引导的 `CastResolved` 现在在
         *   **引导开始**时发（结算提前到位 —— 暴风雪边引导边下雪），此刻
         *   引导条与施法姿态都还要活到 channelEndsAt：注册表条目保留，
         *   由 `pruneCasts` 到点回收；打断路径仍走 CastInterrupted 立即清。
         *   非引导照旧无条件出注册表。
         * ⚠️ `casterId` 可空（施法者不可见），那条路径靠 `pruneCasts` 超时兜底。
         */
        if (msg.casterId !== undefined) {
          const st = this.view.castOfId(msg.casterId);
          const channelRunning =
            st?.channelEndsAt !== undefined && st.channelEndsAt > this.serverTime;
          if (!channelRunning) this.view.endCast(msg.casterId);
        }
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
          } else if (msg.casterId !== undefined) {
            /**
             * W14：**法术甩出去的那一下**（`Spellcast_Shoot` 推掌）。
             *
             * ★★ **必须是 else**：挥砍与释放共用同一条一次性覆盖通道，
             *   后调的会把先调的取消掉 —— 近战技能已经有挥砍了，再补一记
             *   推掌就是抽搐（`CharacterView.playCastRelease` 的纪律）。
             * ★ 瞬发技能不走 `setCasting`，所以这一下是它们**唯一**的施法表现。
             */
            this.viewOfEntity(msg.casterId)?.playCastRelease();
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
        /**
         * 合同 C2：自己被打断要在**屏幕上**说话 —— 此前联网侧这条消息只播了
         * 一声 ui_error，日志里一个字都没有：读条没了而玩家不知道发生过什么。
         *
         * ⚠️ 刻意**不译 `msg.source`**（专用打断/沉默/移动…）：那张标签表是
         *   `CombatDirector` 的模块私有常量 `INTERRUPT_TEXT`，在这里照抄一份
         *   就是给两个场景的措辞留一条分叉缝。技能名 + 学派锁定都是消息里
         *   直接有的事实，先如实说这些；把那张表导出来是 B2 侧的一行后续。
         */
        if (msg.casterId === this.selfId) {
          const skillName = st ? getSkill(st.skillId)?.name ?? '施法' : '施法';
          const lock = msg.schoolLock
            ? `，${SCHOOL_NAMES[msg.schoolLock.school] ?? msg.schoolLock.school}系技能被封锁`
            : '';
          const text = `你的${skillName}被打断了${lock}`;
          this.view.push(text, 'interrupt');
          this.hud.showCenterNotice(text);
        }
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

      /**
       * W12：旗帜事件进战斗日志。旗帜的**状态**由快照持续驱动（HUD 与 3D
       * 旗都读快照），这条事件只负责「那一瞬间」的播报 —— 12.2 的
       * 「关键事件有明确反馈」。文案按新状态查表，carrierId 可查名就带名。
       */
      case 'FlagEvent': {
        const side = msg.flagTeam === TEAM_RED ? '红旗' : '蓝旗';
        // 只有「被夺走」把旗手名放进句子 —— 其余状态的 carrierId 要么没有、
        // 要么（交付中）说出来反而拗口，旗手是谁 HUD 的旗帜行一直在显示
        const text = msg.state === FlagState.Carried && msg.carrierId !== undefined
          ? `被 ${this.nameOf(msg.carrierId)} 夺走！`
          : FLAG_EVENT_TEXT[msg.state];
        if (text) this.view.push(`${side}${text}`, 'interrupt');
        break;
      }

      /**
       * 大 BOSS 的出场 / 狂暴 / 被击杀。
       *
       * ★ 走与旗帜播报同一条通道（战斗日志 + 中部提示）—— BOSS 的**位置与
       *   血量在快照里**（它就是一个普通实体，姓名板与目标框自然认得它），
       *   这条消息只负责「那一瞬间」的提醒：一只 15000 血的中立怪出现在
       *   地图中央，玩家需要知道它出现了，而不是撞上去才发现。
       * ★ `killerId` 可能被服务器抹掉（最后一击者是未被发现的潜行者）——
       *   那时如实说「被击杀了」，不编一个凶手（与击杀播报同则）。
       */
      case 'BossEvent': {
        const text =
          msg.kind === 'spawned'
            ? `${msg.name} 出现了！`
            : msg.kind === 'enraged'
              ? `${msg.name} 进入狂暴！`
              : msg.killerId !== undefined
                ? `${this.nameOf(msg.killerId)} 击杀了 ${msg.name}！` +
                  (msg.bounty !== undefined ? `（赏金 ${msg.bounty}）` : '')
                : `${msg.name} 被击杀了！`;
        this.view.push(text, 'interrupt');
        this.hud.showCenterNotice(text);
        break;
      }

      /** 16a 战后统计。★ 场景只负责转交给上层（大厅的结算页在渲染它）*/
      /**
       * P13 大乱斗击杀播报。文案在这里拼（服务器只发事实）：
       * 连杀分级取 MOBA 惯用口径,≥3 连用 interrupt 档（战斗日志里的高亮）。
       */
      case 'FfaKill': {
        const streakText =
          msg.streak >= 5 ? `超神（${msg.streak} 连杀）！`
          : msg.streak === 4 ? '大杀特杀！'
          : msg.streak === 3 ? '三连杀！'
          : msg.streak === 2 ? '双杀！'
          : '';
        this.view.push(
          `${msg.killerName} 击杀了 ${msg.victimName}${streakText ? ' —— ' + streakText : ''}` +
          `（+${msg.bounty} 分，共 ${msg.killerScore}）`,
          msg.streak >= 3 ? 'interrupt' : 'info',
        );
        break;
      }

      case 'MatchStats':
        // P12 大乱斗：MatchEnd 的 winner 是独立队号，报名字要靠这份名单反查
        this.lastStatsRows = msg.rows;
        this.onMatchStats?.(msg.rows, msg.awards);
        break;

      case 'RoundEnd': {
        // 速赢清单记分板：竞技场回合比分只在这条消息里，本地累计
        if (msg.winner === TEAM_RED) this.roundWins.red++;
        else if (msg.winner !== 'draw') this.roundWins.blue++;
        break;
      }

      case 'MatchEnd': {
        /**
         * M13：对局结束就停手 —— 服务器紧接着会把 session 放回 Room 阶段，
         * 再发 Input/CastRequest 只会换来一串「当前阶段不接受」的拒绝刷屏
         * （此前这条消息落在 default，客户端每 50ms 发一条 Input 被拒一条）。
         * 画面何时切走由上层决定：大厅流程回房间页，`?net=` 老路停在结算日志。
         */
        this.started = false;
        /**
         * P12 大乱斗：winner 是那名玩家的独立队号（不是红/蓝）——
         * 从刚收到的 MatchStats 名单反查名字。夺旗/竞技场照旧红蓝口径。
         */
        {
          const isFfa = this.map?.family === 'ffa';
          const ffaName = isFfa && msg.winner !== 'draw'
            ? this.lastStatsRows?.find((r) => r.team === msg.winner)?.name
            : undefined;
          this.view.push(
            msg.winner === 'draw'
              ? '对局结束：平局'
              : ffaName !== undefined
                ? `对局结束：${ffaName} 称霸乱斗场`
                : `对局结束：${msg.winner === TEAM_RED ? '红方' : '蓝方'}获胜`,
            'interrupt',
          );
        }
        this.celebrate(msg.winner);
        break;
      }

      default:
        // 其余消息（战斗事件、房间状态）要等 HUD 共用之后才有消费者。
        // ★ 不静默：先留一条日志，免得「消息发了但没人处理」变成静默失败
        break;
    }
  }

  /**
   * W24 中途加入：**我选的职业这局到底生不生效**，如实说一次。
   *
   * ★★ 判据是「我请求的 classId」与**快照里我这具身体的 classId**（服务器
   *   的 `EntityMeta.statics` 一路合过来的）之间的差 —— 不同 = 顶替了一个
   *   人机、还在沿用它的职业。服务器在协议里**没有**「待生效职业」这个字段
   *   （没有消费方之前不加字段），客户端知道自己请求了什么，所以够用。
   * ★ 只说一次：拿到自己那一份快照就有答案了，每帧重复说等于噪音。
   * ⚠️ 文案本体在 `midJoinClassNotice`（纯函数，可单测）—— 竞技场单回合制
   *   那句必须与夺旗分开写，理由见那个函数的 ★★。
   */
  private noteMidJoinClass(): void {
    if (this.midJoinNoticeSaid || this.spectating) return;
    const want = this.opts.requestedClassId;
    if (want === undefined || this.selfId === null) return;
    const me = this.entityOf(this.selfId ?? undefined);
    if (!me) return;
    this.midJoinNoticeSaid = true;
    const text = midJoinClassNotice(want, me.classId as string, this.map?.family);
    if (text === null) return;
    /**
     * ★ 两处一起说：中部提示（此刻眼睛在那儿）+ 战斗日志（1.6 秒之后
     *   还想再看一眼时唯一找得回来的地方）。与 `CastFailed` 同一条分工。
     */
    this.view.push(text, 'interrupt');
    this.hud.showCenterNotice(text);
  }

  /**
   * W24：切进**观战席**（无自身实体）的那一下。
   *
   * ★ 三件事，各自对应一条会出错的路径：
   *   · `selfId = null` —— 全场「谁是我」的判断（记分板高亮、死亡回顾、
   *     队伍框、最近敌人）从此一致地答「没有我」，而不是错答成被跟随者；
   *   · 自己的模型退场 —— 它此刻是一具站在原点不动的胶囊（大厅一般会把
   *     `spectating` 传进构造函数，这里是**消息为准**的第二道）；
   *   · HUD 换观战面 + 底部键位提示换成观战席按得动的那几个键。
   */
  private enterSpectatorSeat(you: EntityId): void {
    this.selfId = null;
    this.predictor = undefined;
    // ★ `you === NO_ENTITY`（0 哨兵）= 一个可跟的都没有 —— **不要**去查实体 0
    this.spectatingId = (you as number) === (NO_ENTITY as number) ? null : (you as number);
    this.scene.remove(this.selfView.group);
    this.hud.setSpectating(true);
    this.shell.showHintBar(SPECTATE_HINT_TEXT);
    this.spectateBanner.style.display = '';
  }

  private loadMap(mapId: string): void {
    if (this.mapRenderer) return;
    const map = MAP_BY_ID.get(mapId);
    if (!map) { console.error(`地图不存在：${mapId}`); return; }
    this.map = map;
    this.mapRenderer = new MapRenderer(map, this.art);
    this.scene.add(this.mapRenderer.group);
    if (this.art) {
      // W15：地图到手才知道该用哪个昼夜 —— 覆盖构造时的 day（A13 的
      // lastOpts 记忆让之后切画质保持这个 preset）
      this.env.apply(this.quality.current, { preset: presetOf(map.envPreset) });
      // P5：地面材质也归地图数据管（雪原是雪、密林是草）。不填回落 stone = 老行为
      void this.mapRenderer.applyGroundTexture(groundOf(map.groundTexture));
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
    const raw = this.input.sample(dt);
    // W24：观战席没有身体 —— 走一条**白名单**式的短分支（见该函数的 ★★）
    if (this.spectating) { this.readSpectateInput(raw); return; }
    /**
     * A11：**死后只留观察类按键**。
     *
     * ★★ 判据是**快照里的自己**（`selfAlive()`），不是任何本地记账 ——
     *   复活这件事只有服务器说了算，客户端记一份状态就一定会有「服务器
     *   已经让我活了、客户端还锁着」的窗口。以快照为准的另一半好处是
     *   **不需要任何解除逻辑**：下一份快照说活了，闸门自己就开了。
     * ★ 与 W5 的死亡遮罩/观战**不打架**：那边管「屏幕上显示什么」，
     *   这边管「往服务器发什么」。V 键在允许清单里，观战照常。
     */
    const alive = this.selfAlive();
    const input = gateInputWhenDead(raw, alive);
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
      this.shell.cycleQualityTier(this.sun, this.decorRenderer);
    }
    // W9：设置面板
    if (input.pressed.has(Action.OpenSettings)) this.settings.toggle();
    /**
     * W8：R 通用解控（8.3）。冷却预检读 **self 快照的 cooldowns**（trinket 键
     * 随快照下发，敌方看不到）—— 只为挡误按；权威判定在服务器 tick 第 1c 步。
     * 昏迷/恐惧中照发：8.3「默认允许在昏迷中使用」，解控就是为昏迷造的。
     */
    if (input.pressed.has(Action.Trinket)) {
      const me = this.entityOf(this.selfId ?? undefined);
      const ready = me?.cooldowns?.[TRINKET_COOLDOWN_KEY as string] ?? 0;
      if (this.serverTime < ready) {
        this.view.push(`战斗意志冷却中（还剩 ${Math.ceil(ready - this.serverTime)} 秒）`, 'fail');
      } else {
        this.conn.send({ t: 'UseTrinket' });
      }
    }
    if (input.pressed.has(Action.ToggleMute)) {
      console.info(`[音频] ${audio.toggleMute() ? '已静音' : '已取消静音'}`);
    }
    // 速赢清单：O 键记分板
    if (input.pressed.has(Action.ToggleScoreboard)) this.hud.scoreboard.toggle();
    if (this.started) {
      // W13：BGM 随战斗状态切换。联网口径 = 收到的 Damage/Heal（见 MusicDirector 头注）
      this.musicDir ??= new MusicDirector(ambientTrackFor(this.map?.id as string | undefined));
      this.musicDir.update(this.serverTime);
    }
    // 5.3：Tab 正序、Shift+Tab 反序
    if (input.pressed.has(Action.TargetNext)) this.tabTarget(false);
    if (input.pressed.has(Action.TargetPrev)) this.tabTarget(true);
    // 5.1 焦点目标（F）。★ 整条链路此前只差这一发，见 setFocusToCurrent()
    if (input.pressed.has(Action.SetFocus)) this.setFocusToCurrent();

    /**
     * ── 施法（技能键 + 5.5 瞄准流程）。★ 只发**意图**，结算全在服务器 ──
     *
     * ★★ P10：循环上界必须是 `SKILL_BAR_SLOTS`（技能栏真实格数），而不是
     *   本文件此前自己写的那个 8 —— 两个常量各写各的，结果是**第 9 格
     *   永远按不出来**：HUD 画着它、`skillBarDefsFor` 也确实取了 9 个、
     *   `Action.skill9` 也绑着键，只有这里的循环少转一圈。
     */
    /**
     * P13 大乱斗积分商店：N 开合。
     * ★ 放在技能键之前 —— 同一帧里「按 N 展开」不该顺带把这一帧的数字键
     *   也判成买货（也不会：pressed 是按帧采样的集合，但顺序仍写清楚）。
     */
    if (input.pressed.has(Action.ToggleShop)) this.ffaShopHud.toggle();

    /**
     * ★ 数字键读的是**未过闸**的原始输入：它们在商店展开时兼任「买货」，
     *   而等复活的这几秒正是花分的时候（P13）。死后不能施法这条约束在
     *   下面那一行统一收口 —— 放在这里会连商店一起挡掉。
     */
    let pressedSlot: number | null = null;
    for (let i = 0; i < SKILL_BAR_SLOTS; i++) {
      if (raw.pressed.has(`skill${i + 1}` as Action)) pressedSlot = i;
    }
    /**
     * ★★ 商店展开时数字键**改为买货并吃掉这一下**（`buySlot` 返回 true）。
     *   不吃掉的话，按 1 会同时买第一件商品和放第一个技能 —— 而那是
     *   「按了没反应」的反面：按了反应了两次，玩家更没法理解发生了什么。
     */
    if (pressedSlot !== null && this.ffaShopHud.buySlot(pressedSlot)) {
      pressedSlot = null;
    }
    // 鼠标点技能格：与数字键**走同一条**瞄准流程（地面技能同样要选落点）
    if (this.clickedSlot !== null) {
      pressedSlot = this.clickedSlot;
      this.clickedSlot = null;
    }
    /**
     * A11：死后技能键与技能格点击都不再进瞄准/施法流程，已经举起来的
     * 落点预览也一并收掉（`aim.reset()` 的注释里写的就是「例如角色死亡」）。
     * ★ 技能栏本身已经是灰的 —— `SnapshotCombatView.gateBlocker` 对 `!alive`
     *   返回 `CastFailure.Dead`，那条早就通了；缺的只是「按下去不发」。
     */
    if (!alive) {
      pressedSlot = null;
      this.aim.reset();
      /**
       * 10.5 / 17.3：死亡打断拾取（权威判定在服务器）。这里收掉**本地**那根
       * 进度条 —— 移动打断有 `applyArsenalInput` 里那条自发的取消，而移动量
       * 死后恒为 0，那条路径够不到；不收的话进度条会停在半路等一个不会来的结果。
       */
      if (this.pickingUp) {
        this.arsenalHud.endPickup(false, '死亡中断了拾取', this.serverTime);
        this.pickingUp = false;
      }
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

    /**
     * 7.5 假读条：Esc 在没有瞄准时用于取消读条（服务器结算取消）。
     * ★ A11：死后 Esc 仍然过闸（它还要关面板），但**不再发**这条消息 ——
     *   尸体没有读条可取消，发出去只是又一条被静默拒绝的指令。
     */
    if (alive && input.pressed.has(Action.CancelCast) && ev.type !== 'cancel') {
      this.conn.send({ t: 'CancelCast' });
    }

    /**
     * W5：死亡观战（11.4）。活着按 V **无效** —— 活人跟随别人就是透视；
     * 死后轮换己方存活队友并发 SpectateFollow（服务器用 `spectatableFor()`
     * 复核，规则只有一个实现处）。1v1 没有队友 → 无候选，遮罩如实说。
     */
    if (input.pressed.has(Action.SpectateNext)) {
      const meSnap = this.entityOf(this.selfId ?? undefined);
      if (meSnap && !meSnap.alive) {
        const next = nextSpectateTarget(
          this.lastEntities, meSnap.id as number, meSnap.team, this.spectatingId,
        );
        if (next) {
          this.spectatingId = next.id as number;
          this.conn.send({ t: 'SpectateFollow', entityId: next.id });
        }
      }
    }

    this.applyArsenalInput(input);
  }

  /**
   * W24 观战席这一帧能按什么。
   *
   * ★★ **白名单，不是「把几条 if 掉」** —— 与服务器 `Session` 那三张阶段
   *   白名单同一条理由（那里的注释：用布尔的话，每加一条新按键都要有人
   *   记得问一句「观战者能按吗」，而忘了问的后果是一条越权路径）。这里
   *   的后果具体到画面：任何一条需要身体的消息发上去都会被阶段拒收，
   *   而 `Rejected` 会进战斗日志 —— 20Hz 的拒绝刷屏。
   * ★ 允许的四类：转镜头（纯本地）、V 换视角（`SpectateFollow`，观战席
   *   与死亡观战共用的那一条）、看板（O 记分板 / F10 设置 / M 静音 /
   *   F2 画质）、以及设置面板里的「离开对局」（`LeaveMatch` 任何阶段都合法）。
   * ⚠️ **不发 `Input`** 也不建预测器 —— `simulate()` 那边还有第二道。
   */
  private readSpectateInput(input: FrameInput): void {
    /**
     * ★ 先把两个「留给瞄准流程消费」的标志位吃掉 —— 观战席根本没有瞄准流程，
     *   不清的话它们会一直挂着 true（今天无害，但那是一个等着被读到的陈旧状态）。
     */
    this.clickFlags.left = false;
    this.clickFlags.right = false;
    this.clickedSlot = null;
    // 镜头：拖动/滚轮/复位都是纯本地的，观战席照常可用
    this.characterYaw += this.cam.applyInput({
      wheel: input.wheel,
      leftDrag: input.leftDrag,
      rightDrag: input.rightDrag,
      reset: input.cameraReset,
    });
    if (input.cameraReset) this.cam.resetBehind(this.characterYaw);
    if (input.pressed.has(Action.CycleQuality)) {
      this.shell.cycleQualityTier(this.sun, this.decorRenderer);
    }
    if (input.pressed.has(Action.OpenSettings)) this.settings.toggle();
    if (input.pressed.has(Action.ToggleMute)) {
      console.info(`[音频] ${audio.toggleMute() ? '已静音' : '已取消静音'}`);
    }
    if (input.pressed.has(Action.ToggleScoreboard)) this.hud.scoreboard.toggle();
    // W13：BGM 照常跟着战况走 —— 观战也是在看一场比赛
    if (this.started) {
      this.musicDir ??= new MusicDirector(ambientTrackFor(this.map?.id as string | undefined));
      this.musicDir.update(this.serverTime);
    }
    /**
     * V 换视角。★ 本地只是猜「下一个是谁」（快照里没有 `isPet`，判不了），
     *   权威在服务器的 `isLegalSpectateFollow`；猜错就是一条被拒的请求，
     *   而**下一份快照的 `you` 会把真相带回来**（服务器自己会退回第一个）。
     */
    if (input.pressed.has(Action.SpectateNext)) {
      const next = nextSpectateSeatTarget(
        this.lastEntities.map((e) => ({ id: e.id as number, alive: e.alive })),
        this.spectatingId,
      );
      if (next) this.conn.send({ t: 'SpectateFollow', entityId: next.id as EntityId });
    }
  }

  /**
   * 10.4 / 10.5 / 10.7 的按键。
   *
   * ★★ **交互键只有一个**（`Action.FlagInteract`，默认 G）。12.1 的拔旗与
   *   10.5 的拾取/开箱共用它，由客户端按距离消歧后发出**明确的**目标
   *   （`InteractTarget` 可辨识联合）。此前协议只有一个 `entityId`，
   *   服务器只能「先试旗帜、失败了再当掉落」地猜 —— 站在旗边捡装备会猜错。
   *
   * ★ 夺旗图上没有军械点（12.x 首版关闭临时装备），竞技场上没有旗 ——
   *   所以两者事实上不会同时出现在 2.2 米内。即便如此仍然显式消歧，
   *   而不是依赖那个「碰巧不会撞车」的事实。
   */
  private applyArsenalInput(input: FrameInput): void {
    // 三选一面板开着时，Esc 关掉它（不消耗读条取消 —— 那条在上面已经处理过）
    if (this.arsenalHud.offerOpen && input.pressed.has(Action.CancelCast)) {
      this.arsenalHud.closeOffer();
    }
    // P13：商店同规矩 —— Esc 收起（数字键随即交还给技能栏）
    if (this.ffaShopHud.open && input.pressed.has(Action.CancelCast)) {
      this.ffaShopHud.close();
    }

    if (input.pressed.has(Action.FlagInteract)) {
      const me = this.predictor?.position;
      const near = me ? this.arsenalView.nearestInteractable(me) : undefined;
      if (near?.kind === 'armory') {
        this.conn.send({ t: 'OpenArmory', armoryId: near.armory.id });
      } else if (near?.kind === 'drop') {
        this.conn.send({ t: 'InteractStart', target: { kind: 'drop', dropId: near.drop.id } });
        this.arsenalHud.beginPickup(this.serverTime);
        this.pickingUp = true;
      } else {
        // 附近没有军械物 → 这一按是冲着旗帜去的（竞技场里服务器会回拒绝）
        this.conn.send({ t: 'InteractStart', target: { kind: 'flag' } });
      }
    }

    /**
     * 10.5：移动会中断拾取。客户端**主动**发一条取消，而不是等服务器自己发现 ——
     * 服务器当然也会判（`tickPickups` 的 moved 分支），但那要等下一 tick，
     * 而玩家已经在动了。两边都判是对的：客户端为了手感，服务器为了权威。
     */
    if (this.pickingUp && (input.forward !== 0 || input.strafe !== 0 || input.jump)) {
      this.conn.send({ t: 'InteractCancel' });
      this.arsenalHud.endPickup(false, '移动中断了拾取', this.serverTime);
      this.pickingUp = false;
    }

    // 10.7 换装：B 键在备用武器之间循环
    if (input.pressed.has(Action.CycleWeapon)) {
      const eq = this.selfEquipment();
      if (eq && eq.spareWeaponIds.length > 0) {
        const slot = this.nextWeaponSlot(eq);
        this.conn.send({ t: 'SwapWeapon', slot });
      }
    }

    // 10.1 使用增益道具
    if (input.pressed.has(Action.UseConsumable1)) this.conn.send({ t: 'UseConsumable', slot: 0 });
    if (input.pressed.has(Action.UseConsumable2)) this.conn.send({ t: 'UseConsumable', slot: 1 });
  }

  /**
   * 16a 胜利庆祝：赢方集体 Cheer + 胜负音。
   *
   * ★ 模型自带的 `Cheer` 片段**至今零调用方** —— 零素材成本的一项。
   * ★ 平局两边都不庆祝：那不是胜利。如实不播比「都播一下」诚实。
   */
  private celebrate(winner: TeamId | 'draw'): void {
    this.killFeed.hide();
    if (winner === 'draw') {
      audio.play('ui_arena_loss', { group: 'ui', volume: 0.6 });
      return;
    }
    /**
     * ★ 盘里**有** `ui_arena_loss`，**没有** `ui_arena_win` ——
     *   胜利用 `ui_achievement` 顶上，而不是写一个不存在的 `ui_arena_win`
     *   （那会是一次静默的加载失败：没有声音，也没有报错）。
     */
    const won = this.selfTeam === winner;
    audio.play(won ? 'ui_achievement' : 'ui_arena_loss', { group: 'ui', volume: 0.7 });

    for (const e of this.lastEntities) {
      if (e.team !== winner || !e.alive) continue;
      this.views.get(e.id as number)?.playCheer();
    }
  }

  /** 16a：战后统计转交给上层（大厅结算页）。由 LobbyShell 注入 */
  onMatchStats: ((rows: readonly MatchStatsRow[], awards: readonly AwardView[]) => void) | undefined;

  /** 自己的装备快照（10.6 完整视图 —— 只有自己和队友有） */
  private selfEquipment(): AllyEquipmentSnapshot | undefined {
    const me = this.entityOf(this.selfId ?? undefined);
    const eq = me?.equipment;
    // ★ 用「有没有备用装备字段」判别联合的哪一支 —— 敌人视图里根本没有它
    return eq && 'spareWeaponIds' in eq ? eq : undefined;
  }

  /**
   * B 键循环到的下一件备用武器的槽位。
   *
   * ★ 协议的 `SwapWeapon.slot` 索引的是 **`spareWeapons`**（见 `MatchLoop`
   *   的 Swap 分支），不是 `allWeapons` —— 两者差一个默认武器，
   *   传错的表现是「按 B 换成了另一件」而不是报错。
   */
  private nextWeaponSlot(eq: AllyEquipmentSnapshot): number {
    const current = eq.spareWeaponIds.indexOf(eq.currentWeaponId);
    return (current + 1) % eq.spareWeaponIds.length;
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
    /**
     * 5.6 / W8：按住 Alt 自我施法 —— 只对「可作用己方」的技能改写目标
     * （对敌技能不改，免得把火球按给自己吃一发拒绝）。服务器照常复核。
     */
    const selfCast = this.pendingInput?.selfCastHeld === true
      && this.selfId !== null
      && (skill.targetFilter === TargetFilter.Ally || skill.targetFilter === TargetFilter.Any);
    this.conn.send({
      t: 'CastRequest',
      skillId: skill.id,
      ...(selfCast
        ? { targetId: this.selfId as never }
        : this.currentTargetId !== undefined ? { targetId: this.currentTargetId } : {}),
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
  /**
   * P10：换一份快照实体列表 —— **列表与 id 索引的唯一写入点**。
   *
   * ★ 唯一性就是这个方法存在的全部理由：两个字段各自赋值的话，
   *   将来任何一处「只更新了列表」都会让 `entityOf()` 返回上一份快照的数据，
   *   而那种 bug 表现为「偶尔打到幽灵」，查起来极贵。
   */
  private setEntities(entities: readonly HydratedEntitySnapshot[]): void {
    this.lastEntities = entities;
    this.entityById.clear();
    for (const e of entities) this.entityById.set(e.id as number, e);
  }

  /**
   * P10：按 id 找实体。★ 语义与 `lastEntities.find(e => e.id === id)`
   * **逐字相同**（含 `undefined` 时返回 undefined），只是不再线性扫描。
   */
  private entityOf(id: EntityId | number | undefined): HydratedEntitySnapshot | undefined {
    return id === undefined ? undefined : this.entityById.get(id as number);
  }

  /** 实体名，供战斗日志。★ 来源不可见时服务器会抹掉 sourceId（已知偏差 #4）*/
  private nameOf(id: EntityId | undefined): string {
    if (id === undefined) return '某个看不见的敌人';
    return this.entityOf(id)?.name ?? '?';
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
  /**
   * P3c：某职业当前应显示的技能栏（玩家自定义 ∪ 默认前 9）。
   * ★ 默认 = 本职业**前 9 个**技能 —— 改动前数字键能按到的正是这 9 个，
   *   不自定义的玩家键位含义零变化。
   */
  private skillBarDefsFor(classId: string): SkillDef[] {
    const cls = getClass(classId as never);
    if (!cls) return [];
    const defaults = cls.skills.slice(0, SKILL_BAR_SLOTS).map((sk) => sk.id as string);
    const ids = loadSkillBar(
      globalThis.localStorage, classId, defaults,
      new Set(cls.skills.map((sk) => sk.id as string)),
    );
    return ids
      .map((id) => cls.skills.find((sk) => (sk.id as string) === id))
      .filter((sk): sk is SkillDef => sk !== undefined);
  }

  private headOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    if (id === this.selfId && this.predictor) {
      const p = this.predictor.position;
      return { x: p.x, y: p.y + GEOMETRY.HITBOX_HEIGHT * 0.9, z: p.z };
    }
    const e = this.entityOf(id);
    if (!e) return undefined;
    return { x: e.position.x, y: e.position.y + GEOMETRY.HITBOX_HEIGHT * 0.9, z: e.position.z };
  }

  private audioDistance(id: EntityId | undefined): { distance?: number } {
    if (id === undefined) return {};
    if (id === this.selfId) return { distance: 0 };
    const at = this.entityOf(id)?.position;
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
    const e = this.entityOf(id);
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
      : this.entityOf(id)?.yaw ?? 0;
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
        : this.entityOf(id)?.yaw ?? 0;
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

  /**
   * 5.1 焦点目标：把当前硬目标设为焦点（再按一次清除，切换语义在服务器）。
   *
   * ★★ P10：这条链路**协议与服务器早就齐了**（`SetTarget slot:'focus'` +
   *   `MatchLoop` 的 `toggleFocus`），只有客户端从来没发过这条消息 ——
   *   于是联网对局里 F 键、焦点框、焦点环三样一起是死的。
   * ★ 不在本地记账「焦点现在是谁」：切换的权威在服务器（目标不可选中时它会
   *   静默不设），本地猜一份迟早分叉。焦点从快照的 `focusId` 回读（见
   *   `visibility.ts` 的字段注释）。
   */
  private setFocusToCurrent(): void {
    if (!this.started) return;
    /**
     * 没有硬目标时发 null = 清除焦点。⚠️ 这与「没选人就按 F」的玩家意图一致：
     * 他要么想设、要么想清，而设不出来时清掉比什么都不做更可预期。
     */
    this.conn.send({
      t: 'SetTarget', slot: 'focus',
      entityId: this.currentTargetId ?? null,
    });
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
   * A11：**快照里的自己还活着吗。**
   *
   * ★ 还没收到自己那一份快照时按「活着」—— 默认路径（开局前几帧、
   *   `?net=` 的离线回归路径）必须与改造前逐字节相同，而那几帧里
   *   `lastEntities` 是空的。宁可多发几帧也不能把活人锁住。
   */
  private selfAlive(): boolean {
    const me = this.entityOf(this.selfId ?? undefined);
    return me === undefined || me.alive;
  }

  /**
   * 一个**指令帧**（50ms）：采样 → 本地预测 → 发出去。
   *
   * ★ 这里**不推进世界** —— 世界由服务器推进，客户端只推进「自己的位置」。
   *   技能效果一律等服务器确认（docs/08 §5 开头）。
   */
  private simulate(_dt: number): void {
    const input = this.pendingInput;
    /**
     * W24：观战席**一条 `Input` 都不发**（协议注释里的硬要求）。
     * ★ 显式判 `spectating` 而不是靠「没有预测器所以自然返回」——
     *   后者是「碰巧无害」，而本仓库对这类默契的容忍度是零（A8 的教训）。
     */
    if (this.spectating) {
      /**
       * A5：观战席**没有账本**，与服务器一致 —— 观战的玩家在
       * `MatchLoop.collectInputs` 里连 `entityId` 都查不到，那边根本不会给他
       * 开桶。清掉基准（不是清桶）：W24 中途加入坐进身体的那一刻，服务器给的
       * 是一个全新的、`yaw` 为 undefined 的账本，第一条朝向**原样采信**；
       * 客户端若还留着进观战之前的那个基准，就会在两边口径不同的情况下
       * 自己把玩家的朝向往回拖。桶照常注入 —— 时钟不因为在看别人而停。
       */
      this.turnBudget.yaw = undefined;
      refillTurnBudget(this.turnBudget);
      return;
    }
    /**
     * A5：**令牌注入 + 自钳，在所有早退之前。**
     *
     * ★★ 注入必须每个固定步恰好一次、与「这一步发不发得出 `Input`」无关 ——
     *   服务器那边也是每 tick 注入一次，与「这一 tick 收没收到 Input」无关
     *   （`collectInputs` 的 ★★）。放在死亡/未开局的早退之后，两个桶就会
     *   在死亡期间越差越远，复活那一下客户端反而比服务器更严。
     * ★ 钳的是 `this.characterYaw` 本身，不是发出去的那份拷贝：屏幕上的
     *   自己、`CastRequest.facing`、方向指示器全都跟着走同一个值 ——
     *   「客户端显示的朝向」与「服务器采信的朝向」不允许有第二种口径。
     * ⚠️ 代价如实：被钳的那一下镜头 yaw（`cam.yaw`）已经转过去了，于是镜头
     *   与角色会短暂分离，靠 4.3 的自动跟随收回来。只有超出令牌桶的转身才
     *   看得到 —— 桶装得下一次 180° 甩镜头，正常玩不出来。
     * ⚠️ 死亡期间客户端**不发** `Input`（下面 A11 那道闸），于是服务器的基准
     *   停在他倒下前那一次主张、桶一路注满；复活后第一条朝向最远也就 180°,
     *   服务器满桶接得住，不会被钳 —— 这条不需要额外处理，如实记在这里。
     */
    refillTurnBudget(this.turnBudget);
    this.characterYaw = admitYaw(this.turnBudget, wrapAngle(this.characterYaw));
    if (!input || !this.predictor || !this.started) return;
    /**
     * A11：**死后不再发指令帧**。
     *
     * ★★ 此前这里只判 `started`：死亡期间客户端照常 20Hz 发移动指令，
     *   服务器每一条都静默拒绝 —— 一整段死亡时间的上行全是白发的。
     * ★ 停发是安全的：`Predictor` 的对账不依赖「本帧发过指令」——
     *   pending 队列被 ackSeq 清空之后，每份快照都直接把预测态重置成
     *   权威态；复活那一下位置跳变超过 `CORRECTION.SNAP_ABOVE`，
     *   走的正是 13.4 的瞬移分支（不平滑、动画不判成冲刺）。
     * ⚠️ 代价如实记在这里：`seqSentAt` 期间没有新条目，死亡期间的
     *   延迟读数会停在最后一次测量值上（W6 的 rttMs）。为了让它继续跳动
     *   而每帧发一条空指令，就等于没修这条债。
     */
    if (!this.selfAlive()) return;

    const move: MovementInput = {
      forward: input.forward,
      strafe: input.strafe,
      jump: input.jump,
      // ★ 角色 yaw，不是镜头 yaw（6.5）
      yaw: this.characterYaw,
    };
    const inputMsg = this.predictor.sample(move);
    // W6：记下发出时刻，快照的 ackSeq 回来时配对算 RTT。断线期间会积压 —— 封顶清最旧
    this.seqSentAt.set(inputMsg.seq, performance.now());
    if (this.seqSentAt.size > 128) {
      const oldest = this.seqSentAt.keys().next().value;
      if (oldest !== undefined) this.seqSentAt.delete(oldest);
    }
    this.conn.send(inputMsg);
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
    // X14：紧挨目标环 —— 两者同源同帧（见 updateFactionRings 的注释）
    this.updateFactionRings();
    this.updateIndicators();

    // 施法注册表兜底清理（超时 / 施法者离场），必须在读它之前
    this.view.pruneCasts(
      this.serverTime,
      (id) => this.entityOf(id) !== undefined,
    );

    // 14.2/14.3/14.4：投射物主体、地面边界、粒子池 —— 数据来自最近的快照。
    // ★ 快照类型与 SpellVfx 的表现视图字段兼容，直接喂，不做拷贝
    this.spellVfx?.frame(dt, {
      quality: this.quality.current,
      cameraDistance: this.cam.distance,
      // ★ P4：画布高走缓存，直接读 `clientHeight` 会强制一次同步重排
      //   （理由与代价见 render/canvasSize.ts）
      pointScale:
        canvasSize(this.canvas).h /
        (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360)),
      // 快照的 impactAt 是服务器时钟 —— now 用同一个钟（收快照时校准）
      now: this.serverTime,
      cameraPosition: this.cam.camera.position,
      // 14.1「预备」：数据来自施法注册表（快照里没有施法字段，协议用事件表达）
      casts: this.castViews(),
      projectiles: this.lastProjectiles,
      grounds: this.lastGrounds,
    });

    this.updateArsenal();
    this.updateFlags();
    this.killFeed.render(this.serverTime);

    this.renderer.render(this.scene, this.cam.camera);
    // ★ 与试验场同一个调用 —— 只是喂的 CombatView 实现不同
    this.hud.update(this.view, this.cam.camera, this.canvas, dt);
    this.renderParty();
    this.renderModeHud();
    this.renderMinimap();
    this.renderDeathState();
    this.renderConnState();
    this.renderScoreboard();
  }

  /** W6：断线横幅 + 延迟指示。横幅纯轮询 `conn.connected`，两条入网路径同一份逻辑 */
  private renderConnState(): void {
    const offline = this.started && !this.conn.connected;
    const bannerShown = this.connBanner.style.display !== 'none';
    if (offline !== bannerShown) this.connBanner.style.display = offline ? '' : 'none';

    // W10：帧率一并显示 —— 三期就接进诊断出口的读数，第一次到玩家眼前
    const fps = Math.round(this.loop.fps);
    const txt = offline
      ? '延迟 —'
      : this.rttMs === null ? '' : `延迟 ${Math.round(this.rttMs)}ms · ${fps}fps`;
    if (this.rttLabel.textContent !== txt) this.rttLabel.textContent = txt;
    const color = offline || (this.rttMs !== null && this.rttMs >= 150)
      ? '#ff7a6f'
      : this.rttMs !== null && this.rttMs >= 80 ? '#ffd76a' : '#9ad48f';
    if (this.rttLabel.style.color !== color) this.rttLabel.style.color = color;
  }

  /**
   * W5：死亡遮罩。竞技场死亡不复活（11.4），如实告知去向；
   * 有存活队友则提示 V 观战；夺旗显示波次倒计时（12.6，W12 接入）。
   */
  private renderDeathState(): void {
    /**
     * ★★ W24：观战席**必须先返回**，不能落进下面那段。
     *   下面第一句就是「找不到自己 → 把 `spectatingId` 清零」（复活时的
     *   正确行为），而观战席永远找不到自己 —— 落进去的话跟随目标每帧被
     *   抹一次，镜头当场退回原点。观战席的顶部提示条走 `renderSpectateBanner`，
     *   死亡遮罩对他从头到尾不出现（他没有可以阵亡的身体）。
     */
    if (this.spectating) { this.renderSpectateBanner(); return; }
    const me = this.entityOf(this.selfId ?? undefined);
    if (!me || me.alive) {
      if (this.deathOverlay.style.display !== 'none') this.deathOverlay.style.display = 'none';
      /**
       * 复活/回合重置：本地观战意图清零。⚠️ 服务器侧 `session.following`
       * 不清（协议没有「取消跟随」，不为此加消息）—— 自己活着时服务器
       * 会忽略它（broadcastSnapshots 只对死者启用跟随视角），无害。
       */
      this.spectatingId = null;
      return;
    }

    // 被跟随者死了/离场 → 自动换下一个（与 SpectateController.resolve 同语义）
    if (this.spectatingId !== null) {
      // P10：按 id 找人走索引；「还活着、还是队友」两条判据一字未改
      const watched = this.entityOf(this.spectatingId);
      const still = watched !== undefined && watched.alive && watched.team === me.team;
      if (!still) {
        const next = nextSpectateTarget(this.lastEntities, me.id as number, me.team, this.spectatingId);
        this.spectatingId = next ? (next.id as number) : null;
        if (next) this.conn.send({ t: 'SpectateFollow', entityId: next.id });
      }
    }

    const mates = this.lastEntities.filter((e) => e.id !== me.id && e.team === me.team && e.alive);
    const watching = this.spectatingId !== null
      ? this.entityOf(this.spectatingId ?? undefined)?.name
      : undefined;
    /**
     * W12（W5 的余账）：两种模式的死亡去向不同，如实分开说 ——
     * 竞技场死了这回合就没了（11.4），夺旗按波次回来（12.6，倒计时来自
     * 快照的全局波次钟）。
     */
    const isCtf = this.lastMatch?.flags !== undefined;
    const respawnIn = this.lastMatch?.respawnIn;
    const fate = isCtf
      ? `复活波次 ${Math.ceil(respawnIn ?? 0)}s`
      : '本回合已淘汰';
    const hint = watching !== undefined
      ? `正在观战 ${watching} · 按 V 切换`
      : mates.length > 0 ? '按 V 观战队友' : isCtf ? '留在原地等待复活' : '等待本回合结束';
    const sub = `${fate} · ${hint}`;
    if (this.deathOverlaySub.textContent !== sub) this.deathOverlaySub.textContent = sub;
    if (this.deathOverlay.style.display !== '') this.deathOverlay.style.display = '';
  }

  /**
   * W24：观战席顶部那一条。文案由纯函数给（`spectateBannerText`）——
   * 「暂无可观战目标」那一态是协议里真实存在的一帧（`you === NO_ENTITY`），
   * 不是异常分支。
   */
  private renderSpectateBanner(): void {
    const name = this.spectatingId === null
      ? undefined
      : this.entityOf(this.spectatingId ?? undefined)?.name;
    const text = spectateBannerText(name);
    if (this.spectateBanner.textContent !== text) this.spectateBanner.textContent = text;
  }

  /**
   * W12：快照的旗帜数据 → 与试验场同构的 `FlagView[]`。
   * ★ `carrierName` 从快照实体反查 —— 12.3 禁止旗手潜行，所以旗手
   *   永远在快照里，查不到名字只可能是他刚离场（如实不带名）。
   */
  private flagViewsFromSnapshot(): FlagView[] {
    return (this.lastMatch?.flags ?? []).map((f) => {
      const carrierName = f.carrierId !== undefined
        ? this.entityOf(f.carrierId)?.name
        : undefined;
      return {
        team: f.team,
        state: f.state,
        position: f.position,
        ...(carrierName !== undefined ? { carrierName } : {}),
      };
    });
  }

  /** W12：3D 旗帜每帧跟快照（竞技场 flags 恒空，update 一次都不会建 mesh）*/
  private updateFlags(): void {
    this.flagMarkers.cameraDistance = this.cam.distance;
    this.flagMarkers.update(this.flagViewsFromSnapshot(), this.elapsed);
  }

  /**
   * 15.1 右上：小地图（技术债总账 W2）。
   *
   * ★★ 联网侧此前**零调用** —— 组件写好了（连潜行过滤的注释都写好了），
   *   没人喂：多人局里无法判断战场态势。名单 = 快照实体 —— 可见性裁剪
   *   在服务器（验收 #5），未被发现的潜行者**不在快照里**，小地图结构上
   *   画不出他 —— 与记分板同一条免费继承的规矩。
   * ★ 8.5 决胜阶段的 `suddenDeathBlips`（协议字段，此前零消费方）在这里
   *   落地：6 米网格的模糊位置、**无 id**（防选中是它的设计）。无 id 就
   *   无法与精确点对齐去重 —— 用「附近已有同阵营精确点就跳过」的距离
   *   启发式压掉一人两点的噪音（网格量化误差 ≤ ~4.3 米，阈值取 8）。
   */
  private renderMinimap(): void {
    /**
     * ★ W24：小地图的**锚**是「镜头在谁身上」，不是「我是谁」——
     *   观战席没有身体，锚落在被跟随者上（转播视角，与脚下阵营标记同源）。
     *   `you === NO_ENTITY` 那一帧锚取不到，整张图这一帧不画（如实空白，
     *   胜过按上一个人的位置继续画一张会撒谎的图）。
     */
    const anchorId = this.spectating ? this.spectatingId : (this.selfId as number | null);
    const me = anchorId === null
      ? undefined
      : this.entityOf(anchorId);
    if (!me) return;
    const pos = (this.spectating ? this.lastRemotePos.get(anchorId as number) : this.predictor?.position)
      ?? me.position;
    const yaw = this.spectating ? me.yaw : this.characterYaw;
    const blips: MinimapBlip[] = [
      { x: pos.x, z: pos.z, kind: 'self' },
      ...this.lastEntities
        .filter((e) => (e.id as number) !== anchorId)
        .map<MinimapBlip>((e) => ({
          x: e.position.x, z: e.position.z,
          kind: e.team === me.team ? 'ally' : 'enemy', team: e.team,
        })),
    ];
    for (const b of this.lastMatch?.suddenDeathBlips ?? []) {
      const nearPrecise = this.lastEntities.some(
        (e) => e.team === b.team
          && Math.hypot(e.position.x - b.position.x, e.position.z - b.position.z) < 8,
      );
      if (nearPrecise) continue;
      blips.push({
        x: b.position.x, z: b.position.z,
        kind: b.team === me.team ? 'ally' : 'enemy', team: b.team,
      });
    }
    /**
     * W12 / 15.4：小地图**永久**显示双方旗手与掉落旗帜 —— 与试验场同一个
     * 派生口径（携带中 → 旗手 blip 带名字；掉落 → 掉落旗 blip）。
     * 竞技场 `flags` 是 undefined，这段一个 blip 都不会产生（15.4 否定式）。
     * 旗手潜行也照画 —— 12.2「旗手位置不受潜行影响」，数据源（快照旗帜）
     * 本来就不经过实体裁剪。
     */
    for (const f of this.lastMatch?.flags ?? []) {
      if (f.state === FlagState.Carried) {
        const label = f.carrierId !== undefined
          ? this.entityOf(f.carrierId)?.name
          : undefined;
        blips.push({
          x: f.position.x, z: f.position.z, kind: 'flagCarrier', team: f.team,
          ...(label !== undefined ? { label } : {}),
        });
      } else if (f.state === FlagState.Dropped) {
        blips.push({ x: f.position.x, z: f.position.z, kind: 'droppedFlag', team: f.team });
      }
    }
    this.hud.minimap.draw(blips, pos.x, pos.z, yaw);
  }

  /**
   * 15.4 模式 HUD（技术债总账 W3/W4）。
   *
   * ★★ `renderArena()` 此前**全仓库零调用** —— 8.5 的战斗抑制百分比与
   *   「⚡决胜阶段」从未显示给任何玩家：抑制在实打实地修正伤害，玩家只
   *   觉得「后期怎么掉血变快」。数据（`match.dampening`/`suddenDeath`）
   *   从 M10 起就在每份快照里，缺的只是这一口。
   * ★ 存活人数按**可见口径**（与记分板同一条规矩）：潜行者不进快照也就
   *   不计入 —— 如实按我所见，不编一个全知计数（精确计数要加协议字段，
   *   独立的一笔账，不在这里顺手做）。
   * ★ W12：夺旗分支接上（`renderCtf` 在联网侧的第一个调用方）。
   *   两个视图仍是不相交的类型 —— 竞技场拿不到旗帜数据，夺旗拿不到
   *   存活计数，「顺手把旗手标记画进竞技场」在类型上写不出来。
   */
  private renderModeHud(): void {
    const m = this.lastMatch;
    if (!m) return;
    if (m.flags !== undefined) {
      /**
       * A17：**比赛时钟接上了**。
       *
       * ⚠️ 这里原本有一段「刻意不传 timeRemaining（sim 里没有夺旗时限）」的
       *   注释 —— 它在 Wave1-D 之后就不成立了（sim + 服务器 + 快照三层都通，
       *   数据现在就在 `m.timeRemaining` / `m.overtime` 上），连同判断一起删。
       *   ★ 留着一条过期的「刻意不做」注释比留一个 TODO 更糟：它会劝阻
       *     下一个来接线的人，而且看不出它已经过期。
       * ★ 不限时的一局服务器仍然不发这两个字段 → 整行不画（W12 口径没变）。
       */
      this.hud.modeHud.renderCtf(
        ctfHudViewFromMatch(m, this.flagViewsFromSnapshot(), {
          red: TEAM_RED as number,
          blue: TEAM_BLUE as number,
        }),
      );
      return;
    }
    const alive = (team: number): number =>
      this.lastEntities.filter((e) => (e.team as number) === team && e.alive).length;
    this.hud.modeHud.renderArena({
      aliveRed: alive(TEAM_RED as number),
      aliveBlue: alive(TEAM_BLUE as number),
      round: this.roundWins.red + this.roundWins.blue + 1,
      scoreRed: this.roundWins.red,
      scoreBlue: this.roundWins.blue,
      dampening: m.dampening,
      suddenDeath: m.suddenDeath,
    });
  }

  /**
   * 15.1 左侧队伍框（技术债总账 W1）。
   *
   * ★★ 联网侧此前**从不喂**它 —— 组件在 CombatHud 里构造好、试验场在喂，
   *   这边零调用：治疗职业在联网局里看不到任何队友血量，是「写完了没人
   *   接线」家族在 HUD 上的存量。名单 = 快照里与自己同队的实体（**含自己**，
   *   与试验场同口径）；潜行的队友本就进快照（可见性裁剪只瞒敌人），
   *   15.1 的六项自然齐全。
   * ★ 投影走 `PartyFrame.partyViewFromSnapshot` —— 与试验场共用同一份
   *   成员投影，只换资源容器的读法（分叉教训见该函数注释）。
   */
  private renderParty(): void {
    const self = this.entityOf(this.selfId ?? undefined);
    if (!self) {
      this.hud.party.hide();
      return;
    }
    const allies = this.lastEntities.filter((e) => e.team === self.team);
    this.hud.party.render(partyViewFromSnapshot(allies));
  }

  /**
   * 速赢清单：O 键记分板 —— 联网对局第一次能看比分。
   *
   * ★ 比分两源：CTF 走 `Snapshot.match.score`（一直在发、此前无人消费）；
   *   竞技场走本地累计的 `RoundEnd`（快照不带回合比分）。
   * ★ 名单 = 快照可见实体 —— 潜行者不在快照里（验收 #5 的裁剪在服务器），
   *   记分板结构上不可能偷看隐身者。
   */
  private renderScoreboard(): void {
    if (!this.hud.scoreboard.visible) return;
    const isCtf = this.lastMatch?.flags !== undefined;
    const score = this.lastMatch?.score;
    this.hud.scoreboard.render({
      modeLabel: isCtf ? '夺旗战场' : '竞技场',
      scoreRed: isCtf ? (score?.[String(TEAM_RED)] ?? 0) : this.roundWins.red,
      scoreBlue: isCtf ? (score?.[String(TEAM_BLUE)] ?? 0) : this.roundWins.blue,
      rows: this.lastEntities.map((e) => ({
        name: e.name,
        classId: e.classId,
        team: e.team,
        alive: e.alive,
        healthPct: e.maxHealth > 0 ? e.health / e.maxHealth : 0,
        isSelf: e.id === this.selfId,
      })),
    });
  }

  /**
   * 10.2 / 10.4 / 10.5 / 15.3 每帧刷新：3D 表现 + 交互提示 + 装备栏。
   *
   * ★ 装备栏走 `loadoutViewFromSnapshot()` → **与试验场同一个 `LoadoutPanel`**。
   *   照着快照另写一个装备栏，就会重演「同一件事两份实现」那类分叉
   *   （护盾判据曾经分叉过一次，代价是联网侧四态少画两态）。
   */
  private updateArsenal(): void {
    this.arsenalView.update(this.lastDrops, this.lastArmories, this.serverTime, this.elapsed);

    const me = this.predictor?.position;
    const near = me ? this.arsenalView.nearestInteractable(me) : undefined;
    this.arsenalHud.render(near ? promptFor(near) : undefined, this.serverTime);

    const eq = this.selfEquipment();
    if (eq) {
      /**
       * P8：站在武器/护甲掉落旁 → 15.3 第三条「拾取时新旧对比」。
       * 对比卡 UI 早就在 LoadoutPanel 里（pickupCandidate 参数），此前
       * **零调用方** —— 快照没带 itemId 想调也调不了。范围取交互距离的
       * 两倍：走近就能预览，不必贴到脚下才知道值不值得按 G。
       * ★ 职业不符（pickable=false）也传 —— 卡片显示「某职业专用」警示，
       *   不显示差异行（比不了就别硬比，LoadoutPanel 侧判）。
       */
      let candidate: { weapon?: WeaponDef; armor?: ArmorDef; foreignClass?: string } | undefined;
      if (me) {
        const COMPARE_RANGE = RANGE.INTERACT * 2;
        let bestD = COMPARE_RANGE;
        for (const d of this.lastDrops) {
          if (!d.itemId || (d.kind !== 'weapon' && d.kind !== 'armor')) continue;
          const dist = Math.hypot(d.position.x - me.x, d.position.z - me.z);
          if (dist >= bestD) continue;
          bestD = dist;
          const weapon = d.kind === 'weapon' ? getWeapon(d.itemId as never) : undefined;
          const armor = d.kind === 'armor' ? getArmor(d.itemId as never) : undefined;
          candidate = {
            ...(weapon ? { weapon } : {}),
            ...(armor ? { armor } : {}),
            ...(d.pickable ? {} : { foreignClass: d.ownerClassName }),
          };
        }
      }
      this.hud.loadout.render(loadoutViewFromSnapshot(eq, this.serverTime), this.serverTime, candidate);
    } else this.hud.loadout.hide();
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
    /**
     * W24 观战席：没有身体可画，只推镜头。
     * ★ 镜头目标由 `spectateCameraTarget()` 给 —— 与 11.4 死亡观战**同一个
     *   函数**（G4 教训：两条平行实现迟早分叉，而分叉的那一半会静默地
     *   多给一个自由度）。取不到目标（`you === NO_ENTITY`）时保持上一帧。
     */
    if (this.spectating) { this.updateCamera(dt, undefined, false); return; }
    if (!this.predictor) return;
    /**
     * ★ 渲染位置 = 预测位置 + 尚未消化完的纠正量。
     *   `renderPosition` 每帧衰减那个纠正量，所以中等偏差是「滑过去」的，
     *   而瞬移档在 `reconcile` 里就已经把它清零了（13.4）。
     */
    const pos = this.predictor.renderPosition(dt);
    const s = this.predictor.state;

    /**
     * ★ 快照要在动作状态机之前取：`dead` / `stunned` 是**覆盖状态**
     *   （`AnimationController` 的最高优先级两条），拿不到快照就喂不进去。
     */
    const meSnap = this.entityOf(this.selfId ?? undefined);
    this.selfAnim.update({
      horizontalDistance: s.lastHorizontalDistance,
      dt: realDt, // ★ 状态机时钟（见 draw 头注）
      grounded: s.grounded,
      verticalVelocity: s.velocity.y,
      teleported: s.teleported,
      forward: this.pendingInput?.forward ?? 0,
      strafe: this.pendingInput?.strafe ?? 0,
      /**
       * ★★ X29：这两条此前**根本没传** —— 于是联网侧永远进不了
       *   `AnimState.Death`/`Stunned`：自己的尸体站着不倒，被控时不踉跄，
       *   而 `CharacterView.applyStunWobble` 的「死亡一票否决」判的正是
       *   `AnimState.Death`，没有它那条否决在联网侧是**死代码**，
       *   尸体会一直摇头（`flags` 不随死亡清空，见 `deriveStatusFlags`）。
       *   口径与试验场假人循环逐字相同。
       */
      dead: meSnap ? !meSnap.alive : false,
      stunned: meSnap?.flags.stunned ?? false,
    });

    this.selfView.setTransform(pos, this.characterYaw);
    this.selfView.setAnimState(this.selfAnim.state);
    // M12：动画节奏、施法姿态、手上武器、模型动画推进
    this.selfView.setLocomotionTimeScale(this.selfAnim.timeScale);
    this.selfView.setCasting(this.view.playerCast !== undefined);
    if (meSnap) {
      /**
       * ★★ W24 收口：**职业是会在局内变的** —— 中途加入顶替人机的人在下一次
       *   复活换成他选的职业（服务器 `respecCombatant` + 静态块指纹补发）。
       *   不跟这一句的话，自己的模型整局停在被顶替者那个职业上。
       *   `setClass` 自己判「职业没变就一次都不多做」，所以这是每帧一次的比较。
       */
      this.selfView.setClass(meSnap.classId as string);
      this.syncWeapon(meSnap.id as number, this.selfView, meSnap.equipment?.currentWeaponId as string | undefined);
      // 8.2「迷惑」= 被变形（快照 auras 是权威，重连也不丢）
      // ★ 判据统一走 `isMorphedByAuraIds` —— 按单一 id 比会漏掉气旋囚笼（X29）
      this.selfView.setMorphed(isMorphedByAuraIds(meSnap.auras));
      // X30：自己被击晕时也晃 —— 第三人称下看得见自己的后脑勺
      this.selfView.setStunned(stunWobbleActive(meSnap.flags));
      this.selfView.setBodyScale(
        meSnap.auras.some((a) => a.auraId === GIANT_AURA_ID) ? GIANT_BODY_SCALE : 1,
      );
      this.updateMarkersFor(meSnap, this.selfView, realDt);
    }
    this.selfView.update(dt);

    this.updateCamera(
      dt,
      { position: pos, yaw: this.characterYaw, grounded: s.grounded },
      this.selfAnim.smoothedSpeed > 0.5,
    );
    this.selfView.setFirstPerson(this.cam.isFirstPerson);
  }

  /**
   * 观战镜头看向哪里 —— **11.4 死亡观战与 W24 观战席共用的唯一实现**。
   *
   * ★★ 不分叉是有理由的，而且理由就是 11.4 本身：这个函数返回的永远是
   *   「某个活人此刻在屏幕上的位置」，**签名里没有任何让调用方自选坐标的
   *   余地**（与 `SpectateController.cameraTargetOf` 同一条纪律）。写第二份
   *   的那一半迟早会先长出一个 `position` 参数，而那就是自由镜头 = 透视。
   * ★ 位置取 `lastRemotePos`（插值后、与他在屏幕上的模型同源），不是快照
   *   原始位置 —— 否则镜头以 10Hz 跳而人是平滑的。
   * ★ 两条路径的**准入判据不同**，差别只有这一句：死亡观战要求「我死了」
   *   （活人跟别人就是透视），观战席本来就没有身体。
   */
  private spectateCameraTarget(): { x: number; y: number; z: number } | undefined {
    if (this.spectatingId === null) return undefined;
    if (!this.spectating) {
      const meDead = this.entityOf(this.selfId ?? undefined)?.alive === false;
      if (!meDead) return undefined;
    }
    return this.lastRemotePos.get(this.spectatingId);
  }

  /**
   * 推镜头。`self` 为 undefined = 观战席（没有身体）。
   * ★ 观战目标优先于自身位置 —— 死亡观战的语义原样，只是搬进了这一处。
   * ★ 两者都取不到时**保持上一帧**：`you === NO_ENTITY`（全场阵亡/全部潜行）
   *   那一帧如果掉回原点，画面会从战场瞬移到地图中心再瞬移回来。
   */
  private updateCamera(
    dt: number,
    self: { position: { x: number; y: number; z: number }; yaw: number; grounded: boolean }
      | undefined,
    moving: boolean,
  ): void {
    const position = this.spectateCameraTarget() ?? self?.position ?? this.lastCameraTarget;
    this.lastCameraTarget = { x: position.x, y: position.y, z: position.z };
    this.cam.update(
      dt,
      {
        position,
        yaw: self?.yaw ?? this.characterYaw,
        grounded: self?.grounded ?? true,
      },
      this.map?.geometry ?? [],
      moving,
    );
  }

  private drawRemotes(dt: number, realDt: number): void {
    const sampled = this.interp.sample(this.serverTime, this.selfId ?? undefined);
    const seen = new Set<number>();
    /**
     * P4 骨骼分级取样：**在实体循环之前、镜头推完之后**（`drawSelf` 里的
     * `updateCamera` 已经跑过）。理由见 `render/entityLod.ts` 的 `beginFrame`。
     */
    this.entityLod.beginFrame(this.cam.camera);

    for (const e of sampled) {
      const id = e.snapshot.id as number;
      seen.add(id);

      let view = this.views.get(id);
      if (!view) {
        view = new CharacterView(e.snapshot.classId as string);
        this.views.set(id, view);
        this.scene.add(view.group);
        this.anims.set(id, new AnimationController());
      } else if (e.snapshot.classId) {
        /**
         * ★★ W24 收口：远端的**职业也会在局内变**（中途加入者下一次复活换职业，
         *   服务器按静态块指纹把整块 statics 补发过来）。不跟这一句的话，
         *   全场看到的仍然是被顶替人机那个职业的模型。
         *   `setClass` 自判「职业没变就一次都不多做」，所以这是一次字符串比较。
         */
        view.setClass(e.snapshot.classId as string);
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
        /**
         * ★★ X29：远端角色此前**没有**这两条 —— 死了不倒地、被控不踉跄，
         *   而且 `applyStunWobble` 的死亡否决（判 `AnimState.Death`）
         *   在联网侧因此从来没生效过：尸体一直在摇头，直到那枚控制光环
         *   自然到期（光环不随死亡清除）。与试验场假人循环同一份口径。
         */
        dead: !e.snapshot.alive,
        stunned: e.snapshot.flags.stunned,
      });

      view.setTransform(e.position, e.yaw);
      view.setAnimState(anim.state);
      view.setLocomotionTimeScale(anim.timeScale);
      /**
       * W14/X10：远端角色的施法姿态。此前只有自己（draw 里 :2194 一带）接了
       * `setCasting`，远端读条全程无动作 —— 与试验场 `TestbedScene` 假人循环
       * 不对称（G4 平行债，X10 真机轮点名）。施法注册表四个出口
       * （Resolved/Interrupted/Death/prune）都维护，读它就是权威判定。
       */
      view.setCasting(this.view.castOfId(e.snapshot.id) !== undefined);
      this.syncWeapon(id, view, e.snapshot.equipment?.currentWeaponId as string | undefined);
      // 8.2「迷惑」= 被变形；14.3 控制标记 —— 都从快照读，与试验场同一套表现
      view.setMorphed(isMorphedByAuraIds(e.snapshot.auras));
      // X30：被击晕的摇头晃脑（恐惧要排掉 —— 判据在 stunWobbleActive，两场景共用）
      view.setStunned(stunWobbleActive(e.snapshot.flags));
      view.setBodyScale(
        e.snapshot.auras.some((a) => a.auraId === GIANT_AURA_ID) ? GIANT_BODY_SCALE : 1,
      );
      this.updateMarkersFor(e.snapshot, view, realDt);
      // P4：远处/屏外的远端角色降频推进骨骼（攒帧不丢帧，判据在 entity/animLod.ts）
      view.update(dt, this.entityLod.strideFor(e.position));
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
   *
   * ⚠️★ **`realDt` 是 X30 顺手修的**：此前这里传的是 `SIM.TICK_DT`（0.05）——
   *   一个**固定**值，而它喂的是 `StatusMarkers` 里三条**秒**计时
   *   （护盾承伤 0.15 / 破裂 0.4 / X7 的 0.3 秒过期收束）。60fps 下每帧扣
   *   0.05 秒 = 时间流速 3 倍，那三段演出全都只有名义时长的三分之一，
   *   而画面上只是「碎得有点快」，没有人会报。试验场那边一直传的是
   *   `realDt`（「状态标记是倒计时，不在顿帧时钟上」），两条路本就该一致。
   *   X30 的壳层脉动同样吃这个 dt，不修的话火焰会闪成频闪灯。
   */
  private updateMarkersFor(
    snap: HydratedEntitySnapshot, view: CharacterView, realDt: number,
  ): void {
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

    /**
     * X30：**中招的那一层** —— debuff 学派色壳。
     * ★★ `snap.auras` **原样**喂进去：`AuraSnapshot` 结构上就是 `ShellAuraLike`
     *   （`debuffAura.ts` 的 id 字段收 `auraId` / `id` 两个名字正是为了这个），
     *   12v12 每帧 24 个实体因此省掉 24 次 `.map()` 和它产生的短命对象。
     * ★ S7 掩码（`HIDDEN_AURA_ID`）由 `debuffShellOf` 内部强制走中性灰 ——
     *   这里**不许**做任何补救式的学派回填，那正是把服务器刚掩掉的
     *   从旁边漏回去。
     */
    m.setDebuffShell(debuffShellOf(snap.auras));

    m.update(active, this.quality.current, this.cam.distance, realDt, this.elapsed);

    const shield = strongestShield(snap.auras);
    m.setShield(
      shield?.remaining, shield?.initial ?? 1, this.cam.distance,
      shield ? visualForAuraId(shield.auraId)?.primary : undefined,
    );
    // W16：复活保护按光环 id 检测（快照 auras 全公开，与化形检测同通道）
    m.setSpawnProtected(snap.auras.some((a) => a.auraId === SPAWN_PROTECTION_AURA.id));
  }

  /**
   * M12：当前目标的脚下指示环（5.2）。
   * ★ 用**插值后**的位置而不是快照原始位置 —— 否则环会以 20Hz 跳，
   *   而角色是平滑的，看上去像环没跟上人。
   */
  private updateTargetRing(): void {
    const p = paletteFor(this.hud.accessibility.colorblind);
    const id = this.currentTargetId;
    if (id === undefined) {
      this.targetRing.update(undefined, 'hostile', this.serverTime, '#fff');
    } else {
      const snap = this.entityOf(id);
      const friendly = snap !== undefined && snap.team === this.selfTeam;
      this.targetRing.update(
        this.renderedPositionOf(id) ?? snap?.position,
        friendly ? 'friendly' : 'hostile',
        this.serverTime,
        friendly ? p.friendly : p.hostile,
      );
    }
    /**
     * 5.1 焦点环。★ 与试验场同一套：中性色 + `focus` 环形，与硬目标一眼可分。
     * 焦点不在快照里（离场/遁形）时 `focusId` 本来就没了 —— 环自然消失。
     */
    const fid = this.view.focusId;
    const fSnap = fid === undefined
      ? undefined
      : this.entityOf(fid);
    this.focusRing.update(
      fid === undefined ? undefined : (this.renderedPositionOf(fid) ?? fSnap?.position),
      'focus', this.serverTime, p.neutral,
    );
  }

  /**
   * X14：**全体**脚下阵营标记 + 轮廓（§777 第三、四通道）。
   *
   * ★ 名单与位置口径**与目标环完全同源**（`lastEntities` + `renderedPositionOf`）——
   *   两者会同时出现在同一个人脚下，位置各算一份的话，插值期间会看出错位。
   * ★ 可见性不在这里判：不可见的实体压根不进快照（验收 #5）。
   *   这里只判「这一帧画不画」的两件本地事：死了、以及第一人称下的自己。
   */
  private updateFactionRings(): void {
    const p = paletteFor(this.hud.accessibility.colorblind);
    this.factionRings.cameraDistance = this.cam.distance;
    this.factionRings.update(
      factionRingViewsOf(
        this.lastEntities.map((e) => ({
          id: e.id as number,
          team: e.team as number,
          alive: e.alive,
          position: e.position,
          // 巨化的人得有一圈更大的轮廓，否则壳会缩在身体里（P13 大乱斗道具）
          ...(e.auras.some((a) => a.auraId === GIANT_AURA_ID)
            ? { height: GEOMETRY.HITBOX_HEIGHT * GIANT_BODY_SCALE }
            : {}),
        })),
        {
          ...(this.selfId !== null ? { selfId: this.selfId as number } : {}),
          ...(this.selfTeam !== null ? { selfTeam: this.selfTeam as number } : {}),
          firstPerson: this.cam.isFirstPerson,
          positionOf: (id) => this.renderedPositionOf(id as EntityId),
        },
      ),
      { friendly: p.friendly, hostile: p.hostile },
    );
  }

  /** 某实体**渲染中**的位置（远端走插值后的视图，自己走预测）。不在场返回 undefined */
  private renderedPositionOf(id: EntityId): { x: number; y: number; z: number } | undefined {
    if (id === this.selfId) return this.predictor?.position;
    return this.views.get(id as number)?.group.position;
  }

  /** M12：武器变化才触发挂载（setWeapon 是异步的，不能每帧调） */
  private readonly shownWeapons = new Map<number, string | undefined>();
  private syncWeapon(id: number, view: CharacterView, weaponId: string | undefined): void {
    if (this.shownWeapons.get(id) === weaponId) return;
    this.shownWeapons.set(id, weaponId);
    view.setWeapon(weaponId);
    // ★ 自己换武器时，技能栏要跟着变（派对武装授予的技能只在手持时存在）
    if (id === this.selfId) this.refreshSkillBarForWeapon(weaponId);
  }

  /**
   * 附录A#4：手持武器**授予**的技能要出现在技能栏上。
   *
   * ★★ 职业武器的 grants（顺劈、盾撞、连击风暴…）本来就在 `cls.skills` 里，
   *   所以 `skillBarDefsFor()` 的自定义池能选到它们；而大乱斗的派对武装
   *   授予的是 `ffa.*` —— 它们**不属于任何职业**，`cls.skills.find()` 永远
   *   找不到，于是「捡到山崩巨锤但技能栏上没有山崩一击」，而且**没有任何报错**。
   *
   * ★ 做法是**占用最后几格**而不是加长技能栏：`SKILL_BAR_SLOTS` 是 9，
   *   对应数字键 1–9，加长的话第 10 格按不出来（P10 那条「HUD 画着它、
   *   永远按不出来」的教训就在几十行之上）。
   * ★ 换回普通武器时原样还原 —— 数据来自 `skillBarDefsFor()`，
   *   它每次都从 localStorage 重算，不存在「被覆盖回不去」。
   */
  private refreshSkillBarForWeapon(weaponId: string | undefined): void {
    if (this.myClassId === undefined) return;
    const base = this.skillBarDefsFor(this.myClassId);
    const granted = (weaponId === undefined ? undefined : getWeapon(weaponId as never))
      ?.grantsSkills
      ?.map((id) => getSkill(id))
      .filter((s): s is SkillDef => s !== undefined)
      // 职业自己的 grants 已经在 base 里了，只补 base 没有的（即跨池的派对技能）
      .filter((s) => !base.some((b) => b.id === s.id)) ?? [];
    if (granted.length === 0) {
      this.view.setSkillBar(base);
      return;
    }
    this.view.setSkillBar([
      ...base.slice(0, Math.max(0, SKILL_BAR_SLOTS - granted.length)),
      ...granted.slice(0, SKILL_BAR_SLOTS),
    ]);
  }

  // ── 杂项 ──────────────────────────────────────────────────────

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x2b3140, 0.8));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.1);
    this.sun.position.set(20, 40, 15);
    this.sun.castShadow = true;
    this.quality.applyToLight(this.sun);
    this.scene.add(this.sun);
  }
}

/**
 * 把「脚下最近的可交互物」翻成一句人话。
 *
 * ★ 10.2 要求的提示是**两层**：这是什么（能不能拿）+ 为什么拿不了。
 *   合成一句「无法拾取」会把后者丢掉，而后者才是玩家下一步的依据
 *   （「职业不匹配」＝换个人来抢；「道具已满」＝先用掉一个）。
 * ★ 拿不走时提示**照常显示**，只是变暗 —— 10.2「看得到掉落物和所属职业」。
 */
const promptFor = (near: Interactable): InteractPrompt => {
  if (near.kind === 'armory') {
    return { text: '按 G 打开军械箱', enabled: true };
  }
  const d = near.drop;
  return {
    text: `按 G 拾取 ${d.itemName}`,
    ...(d.pickable ? {} : { hint: `${d.ownerClassName}专用 —— 你拿不走` }),
    enabled: d.pickable,
  };
};

/**
 * 学派的中文名。
 *
 * ★ 死亡回顾用它兜底：协议的 `Damage` 只带 `school`，**不带技能 id**，
 *   所以联网侧回顾不出「被寒冰箭打了」只能写「冰霜 240」。
 *   要显示真名得给协议加一个 skillId —— 那是一笔独立的债，
 *   这里如实用学派，不编一个技能名出来。
 */
const SCHOOL_NAMES: Readonly<Record<string, string>> = {
  physical: '物理',
  arcane: '奥术',
  fire: '火焰',
  frost: '冰霜',
  nature: '自然',
  shadow: '暗影',
  holy: '神圣',
};

/** W17：规避三态的战斗日志文案 */
const AVOIDED_TEXT: Readonly<Record<'dodge' | 'parry' | 'block', string>> = {
  dodge: '闪避', parry: '招架', block: '格挡',
};

/**
 * X3：死亡回顾里这一发的名字。
 * ★ 有 skillId → 技能真名（`autoAttack` 特判「普通攻击」，它不是数据里的技能）；
 *   没有 skillId（来源不可见时随 sourceId 一起被抹）→ 退回学派兜底，如实不编。
 */
const skillNameFor = (skillId: string | undefined, school: string): string => {
  if (skillId === undefined) return SCHOOL_NAMES[school] ?? '伤害';
  if (skillId === 'autoAttack') return '普通攻击';
  return getSkill(skillId as never)?.name ?? SCHOOL_NAMES[school] ?? '伤害';
};

/**
 * W12：旗帜事件的战斗日志文案，按**新状态**查表。
 * `carried` 不在表里 —— 那条要带旗手名，在 FlagEvent 分支里单独拼。
 * `resetting` 刻意缺席：重置是内部过渡态，一瞬后紧跟 atBase，播两条是噪音。
 */
const FLAG_EVENT_TEXT: Readonly<Record<string, string>> = {
  atBase: '已回到基地',
  beingTaken: '正在被拔取…',
  dropped: '掉落在地！',
  beingReturned: '正在被归还…',
  beingCaptured: '即将被交付！',
};
