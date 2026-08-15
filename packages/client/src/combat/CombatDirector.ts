/**
 * 战斗调度器：把 shared 的战斗模拟接到客户端。
 *
 * ⚠️ M2/M3 阶段这是**本地模拟**，不是权威服务器。它存在的意义是让 7.x 的反制链
 * 能被亲手操作、亲眼验证。M5 接入服务器时，这个类的职责会缩减为
 * 「把输入发出去 + 把快照画出来」，战斗规则本身一行都不用改 ——
 * 因为规则全在 shared/sim 里，这里只是调用方。
 */

import {
  CastFailure,
  CastKind,
  School,
  TargetFilter,
  collectShapeTargets,
  needsGroundPlacement,
  usesNoTarget,
  resolveGroundPlacement,
  shapeOrigin,
  validateCast,
  describeCastBlockers,
  createCastQueueStore,
  withinSelectRange,
  GCD,
  RANGE,
  type CastContext,
  type GroundPlacement,
  applyInterrupt,
  beginCast,
  cancelCast,
  createCastingStore,
  createEntity,
  createWorld,
  getSkill,
  hitCircleOf,
  interruptLockSeconds,
  isCasting,
  isSelectableBy,
  getClass,
  mage,
  priest,
  resolveSkillTarget,
  setHardTarget,
  tabTarget,
  toggleFocus,
  warrior,
  type Aabb,
  type CastState,
  type CombatEntity,
  type SkillDef,
  type Vec3,
  type World,
  addEntity,
  allocEntityId,
  beginSwing,
  createSwingStore,
  swingIntervalOf,
  createThreatStore,
  decayThreat,
  pickByThreat,
  recordThreat,
  stopSwing,
  distance2D,
  asSkillId,
  asTeamId,
  getEntity,
  listEntities,
  createMovementState,
  decideBotAction,
  type ClassDef,
  dirToYaw,
  normalize2D,
  sub,
  aurasOf,
  createAuraStore,
  createLoadout,
  createLoadoutStore,
  createSwapStore,
  ownLoadoutView,
  createPickupStore,
  createArsenalStore,
  ArenaPreset,
  TRINKET_COOLDOWN_KEY,
  tickWorld,
  type CastIntent,
  type MovementInput,
  type MovementState,
  addWeapon,
  availableWeapons,
  beginSwap,
  SwapKind,
  type LoadoutView,
  createDrStore,
  createGroundStore,
  createProjectileStore,
  clearAuras,
  deriveStatusFlags,
  type CombatEvent,
  type EntityId,
} from '@wowpvp/shared';

import { auraNameById } from '../data/auraRegistry.js';
import { strongestShield } from '../vfx/status.js';
import { VERIFY_DUMMIES, type DummySpot } from './dummyLayouts.js';

/** 位移类型的中文名，供战斗日志显示 */
const DISPLACE_TEXT: Record<string, string> = {
  charge: '冲锋位移', chargeToAlly: '援护位移', pull: '拉拽',
  blink: '闪现', leapBackward: '后跃', shadowstep: '暗影步', knockback: '击退',
};

const RED = asTeamId(0);
const BLUE = asTeamId(1);

/**
 * 玩家技能栏。选法师是因为它一个职业就覆盖了 5.4 的多数瞄准类型 ——
 * 直接目标（寒冰箭、变形术）、自身中心（冰霜新星）、地面目标（暴风雪、陨石）、
 * 纯自身（寒冰屏障），外加读条/瞬发/引导三种施放方式。
 *
 * 缺的第六类「碰撞投射物」在法师技能里没有对应项（猎人的穿透重弩箭才是），
 * 由 projectile.test.ts 严格覆盖。闪现术（方向直线）为了给变形术腾位置移出了技能栏，
 * 它的规则由 effects.test.ts 与 aiming.test.ts 覆盖。
 */
export const PLAYER_SKILL_IDS = [
  'mage.frostbolt',
  'mage.fire_blast',
  'mage.counterspell',
  'mage.polymorph',   // 15 秒冷却的控制，用来演示 8.2 递减（冰霜新星 18 秒太慢）
  'mage.frost_nova',
  'mage.blizzard',
  'mage.meteor',
  'mage.ice_block',
  /**
   * ★ 第 9 格是**追加**的（8 → 9）。加它是为了补一个可达性缺口：
   *   此前 8 格里**没有任何吸收技能**，`shieldOf(player)` 恒为 null ——
   *   14.3 的护盾四态玩家只能在假人身上看到，永远看不见**自己的**盾。
   *   与「牧师假人给战士套盾」是同一个洞的另一半。
   * ★ 加在**末尾**：前 8 格的顺序与数字键完全不变，
   *   verify-m2/m3/m4 都按数字键打特定技能，这是唯一不动它们的改法。
   */
  'mage.ice_barrier',
] as const;

export interface CombatLogEntry {
  time: number;
  text: string;
  kind: 'ok' | 'fail' | 'interrupt' | 'info';
  /**
   * P10：这一行代表几次相同的失败（「… ×3」）。
   * ★ 只有合并过才有值 —— 恒带一个 1 会让「没合并」和「合并了一次」看起来一样。
   */
  repeat?: number;
  /** 合并前的原文，用来判断下一条能不能继续并进来（`text` 已经带了 ×N）*/
  repeatBase?: string;
}

export interface SkillSlotView {
  skill: SkillDef;
  /** 剩余冷却，秒 */
  cooldownRemaining: number;
  /** 当前不可用的原因。Ok 表示可用 */
  blocker: CastFailure;
  /**
   * 合同 C1：公共冷却剩余与总长，秒。
   *
   * ★ 与 `cooldownRemaining` 是**两件事**，不能合并显示：技能自己的冷却是
   *   「这一个技能要等」，GCD 是「所有技能一起等」—— 一格上同时画两圈，
   *   玩家才分得清「这技能还早」和「再等半秒全都能按」。
   * ★ 不吃 GCD 的技能（`triggersGcd === false`）恒为 0：给它画扫圈是在撒谎，
   *   而它恰恰是 GCD 期间唯一还能按的东西。
   */
  gcdRemaining: number;
  gcdTotal: number;
  /**
   * 合同 C1：**当前全部**阻碍项（`blocker` 只有第一个）。
   *
   * ★★ 这是 M11 的 `describeCastBlockers()` 头一次有生产消费方（A16 老债）。
   *   门禁顺序由 7.4 规定「资源在距离之前」，于是怒气 0 的战士站 30 米外
   *   被告知「资源不足」—— 正确，但玩家更需要知道的是「你还太远」。
   *   两个答案都对，所以两个都给：`blocker` 服务判定与统计归因，
   *   `blockers` 服务提示。
   */
  blockers: CastFailure[];
}

export class CombatDirector {
  readonly world: World;
  readonly store = createCastingStore();
  readonly player: CombatEntity;
  readonly skills: SkillDef[];
  readonly log: CombatLogEntry[] = [];

  /** M6/M8：战场装备栏（15.3）*/
  readonly loadouts = createLoadoutStore();
  readonly swaps = createSwapStore();
  /**
   * 拾取进度。试验场还没接军械箱，所以它始终是空的 ——
   * 但 M9 的死亡结算需要它（17.3：拾取进度不能跨越死亡活下来），
   * 而且军械箱接客户端时这里就是它的落点。
   */
  readonly pickups = createPickupStore();
  /**
   * 军械箱。试验场没有接它（M6 的军械箱只被 verify:m6 直接驱动 sim 验过），
   * 所以这里是个空的容器 —— 但 `tickWorld` 需要它，而军械箱接客户端时
   * 这里就是它的落点。用 Classic 预设：10.1 / 验收 #28 规定经典竞技场
   * 不生成任何临时武装，正好对应「试验场里没有军械箱」这个事实。
   */
  readonly arsenal = createArsenalStore(ArenaPreset.Classic);
  /**
   * 7.6 普通攻击的挥击计时。
   *
   * ★★ **只在实战模式下才喂给 `tickWorld`**（见 `tick()` 里的条件）。
   *   站桩模式必须没有它 —— 141 项验收依赖「假人不会白打玩家」。
   *
   * ⚠️ 它是「近战看起来不攻击」的根因（用户实测反馈）：此前试验场**完全
   *   没有这个 store**，于是近战假人贴到你脸上之后只会放技能，而近战技能
   *   冷却 4–10 秒 —— 大部分时间他就站在那儿一动不动。白字才是近战
   *   「一直在打」的视觉主体。
   */
  readonly swings = createSwingStore();
  /**
   * 假人仇恨表（X10 用户拍板）。与服务器 BotDriver.threat 同一个共享模块、
   * 同一条纪律：AI 层局部记忆，表里的 id 每次用都重新过候选判定。
   */
  private readonly threat = createThreatStore();

  /**
   * 交给 `tickWorld` 的移动状态与输入。
   *
   * ★ 试验场里**刻意为空**：玩家的移动由 `TestbedScene` 驱动（它要同时算镜头
   *   与渲染插值），假人不动。`tickWorld` 只推进有条目的实体，所以留空即跳过。
   *   服务器那边这两个 Map 会是满的 —— 同一个函数，不同的调用方。
   */
  private readonly movementStates = new Map<EntityId, MovementState>();
  private readonly frameInputs = new Map<EntityId, MovementInput>();
  /**
   * 本 tick 待处理的技能请求。
   * ★ 由 `tickWorld` 消费而不是这里直接调 `beginCast()` ——
   *   施法有**两个**完成出口（瞬发在 beginCast 内、读条在 tickCasting 里），
   *   只接一个是 M4 踩过的坑。交给 tick 之后这个坑在结构上不存在。
   */
  private readonly pendingCasts = new Map<EntityId, CastIntent>();
  /**
   * 合同 C5 的排队位。**必须由调用方持有** —— 排队位要跨 tick 存活，
   * tick 自己造一个等于每帧丢一次（与 casting/movement 同规矩，见 `TickDeps`）。
   * ⚠️ 不传这个 store，`queue: true` 是**静默无效**的 —— 施法排队会「实现了但没接上」。
   * ★ 它对不带 queue 的请求（假人的每一条）完全不参与，平衡零扰动。
   */
  private readonly castQueue = createCastQueueStore();
  /** 8.3 战斗意志请求（W8）。与技能请求同规矩：只排意图，结算在 tick 第 1c 步 */
  private readonly pendingTrinkets = new Set<EntityId>();

  /** M4：效果系统的状态容器 */
  readonly auras = createAuraStore();
  readonly dr = createDrStore();
  readonly projectiles = createProjectileStore();
  readonly ground = createGroundStore();

  /** 假人下一次开始施法的时间 */
  private dummyNextCast = new Map<number, number>();
  /**
   * M15：按职业暂停假人的自驱脚本（含战士的打断反应）。
   * ★ 只有新手教学在用 —— 各环有各自的舞台布置：基础环静音法师炮台
   *   （M14 之后它一发 200+，新手边学走路边被轰死不是教学）、走位环三个
   *   全停、由 TutorialDirector 亲自驱动陨石（走 requestCast 同一入口）。
   *   默认空集，试验场的 141 项验收行为不变。
   */
  readonly pausedDummyClasses = new Set<string>();

  /**
   * **实战模式**：假人不再站桩，改由 `decideBotAction()` 驱动 —— 会追、会走位、
   * 会按自己的站位偏好拉距离。按 K 或 `?combat` 开启。
   *
   * ★★ **默认必须是 false。** 试验场是 M1–M9 共 141 项验收的载体，
   *   其中大量脚本依赖假人**站在固定位置**（verify-m2 按 26 米外的法师算距离、
   *   verify-m3 靠固定位置算视线）。让假人默认会走，等于用「更好玩」
   *   换掉整张回归网 —— 那是本项目反复强调的「改回归网比改游戏风险高」。
   *
   * ★ 开启后假人**仍然**走与真人完全相同的输入通道（`inputs` + `castRequests`
   *   → `tickWorld`），不直接改 world。这条与 docs/14 §M16b 的红线一致，
   *   也是这套控制器日后能接到服务器侧当人机的前提。
   */
  combatMode = false;

  /**
   * 合同 C8 练习场缓冲：开局这么多秒内假人不锁定玩家、也不出招。
   *
   * ★★ **缺省 0 = 现行为逐帧不变。** `world.time < 0` 恒为假，下面每一处
   *   宽限判断都直接落空，连那句「战斗开始」都被 `graceSeconds > 0` 挡住 ——
   *   二十多支 verify 脚本不带 `&grace`，它们的初始条件一个字节都不能动。
   * ★ 只有大厅「开始练习」拼出来的 `&grace` 会把它设成 5 秒（B1 配置）。
   */
  graceSeconds = 0;
  /** 「战斗开始」只播一次的闩。★ 不用 world.time 反推：那样每帧都会重播 */
  private graceAnnounced = false;
  private get inGrace(): boolean { return this.world.time < this.graceSeconds; }

  /**
   * 假人的移动状态。★ 只在实战模式下按需建立 —— `tickWorld` 只推进
   * `movement` 里有条目的实体，没有条目就是站着不动，不需要额外开关。
   */
  private readonly dummyMovement = new Map<EntityId, MovementState>();
  /** 决策用的随机源。★ 注入而不是直接 Math.random：与 sim 的确定性口径一致 */
  private botRng: () => number = Math.random;
  /**
   * 战士假人已经「决定」打断、将在这个时刻按下拳击。
   *
   * ★ 这个延迟不是拟真装饰，是让 7.5 的假读条博弈**能够存在**的前提。
   * 反应时间为 0 的 AI 会在读条开始的同一 tick 打断，人类玩家永远读不完任何条，
   * 也就永远没有「骗打断」这回事 —— 规则实现对了，玩法却没了。
   */
  private warriorPummelAt: number | null = null;
  /** 战士假人的反应时间，秒 */
  private static readonly PUMMEL_REACTION = 0.45;

  constructor(
    obstacles: readonly Aabb[],
    playerSpawn: Vec3,
    /** 地图外边界。5.5：地面技能落点不能超出地图 */
    private readonly mapBounds?: Aabb,
    /**
     * 假人布置。**默认是验收那一套** —— 两百多项验收的初始条件靠它，
     * 所以默认路径的行为与参数化之前逐字相同。
     * 教学传自己的那一套（见 `dummyLayouts.ts` 的文件头：两边的约束天生冲突）。
     */
    layout: readonly DummySpot[] = VERIFY_DUMMIES,
    /**
     * P3c 技能栏自定义：玩家存过的 9 格。**默认 = `PLAYER_SKILL_IDS`** ——
     * verify-m1..m4 跑在无 localStorage 的全新上下文里，走的就是默认，
     * 与参数化之前逐字节相同（同上面 layout 参数的纪律）。
     */
    skillBarIds: readonly string[] = PLAYER_SKILL_IDS,
    /**
     * P5：`?class=` 选的玩家职业。缺省 = 法师（两百多项验收的初始条件，
     * 默认路径逐字节不变 —— 与 layout/skillBarIds 同一条纪律）。
     */
    playerClass: ClassDef = mage,
    /** P5：`?bot=` 实战模式假人难度。缺省 normal（P1a 起的现状） */
    private readonly botDifficulty: 'easy' | 'normal' | 'hard' = 'normal',
  ) {
    this.world = createWorld(obstacles);

    this.player = addEntity(
      this.world,
      createEntity(allocEntityId(this.world), playerClass, RED, playerSpawn, {
        name: `你（${playerClass.name}）`,
      }),
    );

    /**
     * 三个假人，各自演示反制链的一环（**行为**在下面的自驱脚本里，
     * **位置**来自传进来的布置 —— 见 `dummyLayouts.ts` 为什么要分开）：
     *   战士 —— 用拳击打断**你的**读条，让你体会被打断和假读条博弈
     *   牧师 —— 反复读条治疗，给你练打断和学派锁定
     *   法师 —— 读条法术，同时也是唯一会对你造成伤害的假人
     */
    const CLASS_OF = { warrior, priest, mage } as const;
    for (const spot of layout) {
      this.spawnDummy(
        CLASS_OF[spot.classId],
        {
          x: playerSpawn.x + spot.offset.x,
          y: playerSpawn.y + spot.offset.y,
          z: playerSpawn.z + spot.offset.z,
        },
        spot.name,
        spot.ally ?? false,
      );
    }

    this.skills = skillBarIds.map((id) => {
      const s = getSkill(asSkillId(id));
      if (!s) throw new Error(`技能不存在：${id}`);
      return s;
    });

    this.grantDemoLoadout();

    this.info('试验场：Tab 选目标，1–9 释放技能。地面技能会先进入落点预览，左键确认。');
    this.info('M8：F2 切画质，G 与旗帜交互，B 切换备用武器。');
  }

  /**
   * M8：给玩家一份真实的装备栏（15.3）。默认武器 + 一把本职业备用武器，
   * 这样换装进度条与「新旧对比」在试验场里有东西可看。
   *
   * ★ 抽成方法是因为它有**两个**调用点：开局一次，试验场假复活后一次
   *   （10.10 会在死亡时正确地清掉临时装备，见 `reviveInTestbed()`）。
   */
  private grantDemoLoadout(): void {
    const loadout = createLoadout(this.player.classId);
    // P5：备用武器取**玩家职业**的（此前写死法师 —— `?class=` 之后会给战士塞法刃）
    const cls = getClass(this.player.classId);
    const spare = cls?.weapons.find((w) => !w.isDefault);
    if (spare) addWeapon(loadout, spare.id);
    this.player.weaponId = loadout.defaultWeaponId;
    this.player.armorId = loadout.defaultArmorId;
    this.loadouts.set(this.player.id, loadout);
  }

  private spawnDummy(cls: typeof mage, pos: Vec3, name: string, ally = false): CombatEntity {
    // ★ 压测台要摆真正的 12v12（一半队友）—— 默认仍是敌方（验收与教学的靶子）
    const e = addEntity(
      this.world,
      createEntity(allocEntityId(this.world), cls, ally ? RED : BLUE, pos, { name }),
    );
    // 假人不动，但资源给满，好让它能持续施法
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    this.dummyNextCast.set(e.id as number, 2);
    return e;
  }

  // ── 日志 ────────────────────────────────────────────────────

  /**
   * 往战斗日志里写一行。
   *
   * ★★ **连续相同的失败会合并成「… ×N」。**
   *   资源不足时连按 8 次，此前是 8 条一模一样的红字 —— HUD 只有 14 行可见区，
   *   一次手滑就把「你被打断了」「谁在打你」全顶出屏幕。刷屏本身没有信息量：
   *   第 2 条到第 8 条只告诉你「还是那个原因」，一个计数就说完了。
   *
   * ★ **只合并 `fail`，且只合并紧挨着的上一条。**
   *   ·「只合并 fail」：伤害/治疗行是流水账，合并会把真实的输出节奏抹平。
   *   ·「只合并上一条」：中间插了别的事就说明世界变了，此时再往回并会让
   *     两件事的时间顺序错乱 —— 日志唯一的承诺就是顺序。
   */
  private push(text: string, kind: CombatLogEntry['kind']): void {
    const head = this.log[0];
    if (kind === 'fail' && head?.kind === 'fail' && (head.repeatBase ?? head.text) === text) {
      const n = (head.repeat ?? 1) + 1;
      head.repeat = n;
      head.repeatBase = text;
      head.text = `${text} ×${n}`;
      // ★ 时间跟到最后一次：合并行代表的是「到刚才为止」，不是第一次按下的那一刻
      head.time = this.world.time;
      return;
    }
    this.log.unshift({ time: this.world.time, text, kind });
    if (this.log.length > 40) this.log.pop();
  }
  info(t: string) { this.push(t, 'info'); }

  /**
   * 玩家自己「按了没放出来」。
   *
   * ★ 日志与屏幕中部提示（合同 C3）走**同一个出口**：此前每个失败分支各 push
   *   各的，一共散在六处 —— 再加一个提示通道就得记得改六个地方，而漏掉一个
   *   不会报错，只会有一条失败悄悄没提示。
   * ★ 传给回调的是**合并前**的原文（不带 ×N）：中部提示本来就是一闪而过的
   *   单条提示，带个计数只会让人以为按了 N 次才弹一次。
   */
  private selfFail(text: string): void {
    this.push(text, 'fail');
    this.onSelfCastFailed?.(text);
  }

  /**
   * 清掉玩家身上的全部光环。**只给验收脚本用**（8.1 要量的是「基础速度」，
   * 而法师假人的霜矢会挂一层 30% 减速 —— 减速接进 tickWorld 之后它是真的会生效的）。
   * ★ 不是游戏规则，玩家没有任何途径触发它。
   */
  clearPlayerAuras(): void {
    clearAuras(this.auras, this.player.id);
    this.player.flags = deriveStatusFlags(this.auras, this.player);
  }

  /**
   * W19：场景把「此刻悬停在谁身上」喂进来 —— 5.6 鼠标指向施法的数据源。
   * `targets.mouseover`「仅当前帧有效」的语义由场景维护：每次 mousemove
   * 重算（含悬空 = undefined），瞄准/指针锁定分支清空。
   */
  setMouseover(id: number | undefined): void {
    this.player.targets.mouseover = id as EntityId | undefined;
  }

  // ── 每 tick ─────────────────────────────────────────────────

  update(dt: number, playerPosition: Vec3, playerYaw: number): void {
    // 玩家的位置与朝向由移动系统驱动（M1），战斗系统只读它
    this.player.position = { ...playerPosition };
    this.player.yaw = playerYaw;

    /**
     * ★★ M10：整个 tick 走 shared 的 `tickWorld()`。
     *
     *   在此之前，docs/02 §3 的九步顺序**只隐式存在于这个方法的书写次序里**。
     *   服务器要跑同一套规则，如果在那边再写一遍就有了两个实现 ——
     *   而两份顺序漂移的后果是最难查的一种：两边都能跑，但结算次序差一步，
     *   于是同一发技能在客户端预测里命中、在服务器判定里落空。
     *
     *   现在顺序只有一处定义（`shared/src/sim/tick.ts` 的文件头列了全部
     *   11 条约束及其出处），这个方法退化成「装配依赖 + 接事件转日志」。
     *
     * ★ `movement` / `inputs` 刻意留空：试验场里玩家的移动由 `TestbedScene`
     *   驱动（它要同时算镜头与渲染插值），假人不动。`tickWorld` 只推进
     *   `movement` 里有条目的实体，所以这里天然跳过 —— 不需要额外开关。
     */
    // ★ 返回值这里用不上：试验场要的每一件事都由下面的 sink 即时转成日志。
    //   服务器那边会**用**它 —— 快照广播与统计折叠都消费 `TickResult`。
    tickWorld(
      {
        world: this.world, auras: this.auras, dr: this.dr,
        ground: this.ground, projectiles: this.projectiles, casting: this.store,
        loadouts: this.loadouts, swaps: this.swaps, pickups: this.pickups,
        arsenal: this.arsenal,
        movement: this.movementStates,
        inputs: this.frameInputs,
        castRequests: this.pendingCasts,
        castQueue: this.castQueue,
        trinketRequests: this.pendingTrinkets,
        // ★ 7.6 白字只在实战模式给 —— 站桩模式必须没有（见 swings 的注释）
        ...(this.combatMode ? { swings: this.swings } : {}),
        getSkill,
      },
      dt,
      {
        cast: {
          /**
           * ★ 只有**读条/引导**会走到这里 —— 瞬发技能在 `beginCast` 内部就
           *   完成了，压根不进 store（`casting.ts` 的 Instant 分支提前返回）。
           *   所以这里不必判「是不是瞬发」，瞬发技能天然没有「开始读条」这行。
           */
          onStarted: (c, st) => {
            const skill = getSkill(st.skillId);
            if (!skill) return;
            this.onCastActivity?.('started', c, skill);
            if (needsGroundPlacement(skill)) {
              this.push(`开始施放 ${skill.name}（落点已锁定）`, 'info');
            } else {
              const kindText = st.kind === CastKind.Channel ? '引导' : '读条';
              this.push(`开始${kindText} ${skill.name}（${skill.cast.time.toFixed(1)}s）`, 'info');
            }
          },
          /**
           * ★ 玩家自己的失败与别人的失败**读法不同**：前者是「我按下去没放出来」，
           *   要像 UI 提示；后者是战斗日志里的旁观记录。
           */
          onFailed: (c, sk, reason) => {
            this.onCastActivity?.('failed', c, sk);
            return c.id === this.player.id
              ? this.selfFail(`${sk.name} 无法释放：${FAIL_TEXT[reason]}`)
              : this.push(`${c.name} 的 ${sk.name} 失败：${FAIL_TEXT[reason]}`, 'fail');
          },
          /**
           * ★ 与上面的 onFailed 是**同一条纪律**，但此前只有 onFailed 做到了：
           *   自己的事用第二人称。「你（法师） 的 寒冰箭 被移动中断」是旁观口吻，
           *   读起来像在说别人 —— 而这恰恰是玩家最需要一眼看懂的一行
           *   （它解释了「我按了为什么什么都没发生」）。
           */
          onInterrupted: (c, st, src, lock) => {
            this.onCastActivity?.('interrupted', c, getSkill(st.skillId));
            const skillName = getSkill(st.skillId)?.name ?? st.skillId;
            const lockText = lock
              ? `，${SCHOOL_TEXT[lock.school]}系技能被封锁 ${(lock.until - this.world.time).toFixed(1)}s`
              : '';
            const by = INTERRUPT_TEXT[src] ?? src;
            if (c.id === this.player.id) {
              const text = `${by}打断了你的${skillName}${lockText}`;
              this.push(text, 'interrupt');
              this.onSelfInterrupted?.(text);
              return;
            }
            this.push(`${c.name} 的 ${skillName} 被${by}中断${lockText}`, 'interrupt');
          },
          /**
           * X21：排队窗过期。★ 这里**只转发**，一个字都不往日志里写 ——
           *   理由见 `onQueueExpired` 的声明处。
           */
          onQueueExpired: (c, sk, info) => this.onQueueExpired?.(c, sk, info.waited),
        },
        // ★ 12.3 / 验收 #40：带旗使用无敌/潜行技能时**先掉旗**，再播技能表现
        onBeforeSkillEffects: (caster, skill) => this.onBeforeSkillEffects?.(caster, skill),
        /**
         * 施法完成的日志。三种瞄准类别读法不同（5.4）：
         * 地面技能报「落地 + 范围内几个」，自身中心报「命中几个」，
         * 直接目标报「→ 谁」。★ `targets` 是 tick 传进来的**结算前**的目标集合，
         * 不在这里重算 —— 重算会在效果结算之后少数几个已经倒下的人。
         */
        onCastResolved: (caster, skill, targets) => {
          this.onCastActivity?.('resolved', caster, skill, targets);
          if (needsGroundPlacement(skill)) {
            this.push(`${skill.name} 落地，范围内 ${targets.length} 个目标`, 'ok');
          } else if (usesNoTarget(skill)) {
            this.push(`${skill.name} 命中 ${targets.length} 个目标`, 'ok');
          } else {
            this.push(`${caster.name} 完成 ${skill.name} → ${targets[0]?.name ?? '?'}`, 'ok');
          }
        },
        onEffects: (events) => {
          for (const ev of events) {
            this.logEvent(ev);
            this.onCombatEvent?.(ev);
          }
          /**
           * 仇恨表记账（X10 用户拍板「谁的仇恨值高就打谁」）。只在实战模式：
           * 站桩假人不选敌，表也就没有读者 —— 不白记账。
           * 半衰放 tick 手里（本回调每 tick 恰好一次，dt 恒定）。
           */
          if (this.combatMode) {
            decayThreat(this.threat, dt);
            recordThreat(this.threat, events);
          }
        },
        onSwap: (ev) => {
          this.onSwapResult?.(ev.result === 'completed');
          const who = getEntity(this.world, ev.entityId);
          if (ev.result === 'completed') this.push(`${who?.name ?? ''} 完成换装`, 'ok');
          else this.push(`${who?.name ?? ''} 换装中断：${ev.result}`, 'fail');
        },
        onDeathSettled: (settled) => {
          const who = getEntity(this.world, settled.entityId);
          this.push(`${who?.name ?? ''} 的临时装备已失效（10.10）`, 'info');
        },
        /**
         * 7.6 白字命中 → **挥砍动画 + 破空声**。
         * ★ 这是「近战看起来在打」的视觉主体：技能之间隔着 4–10 秒冷却，
         *   中间填满节奏的是普攻。与技能挥砍走同一个 `playMeleeSwing()`。
         */
        onSwing: (sw) => {
          if (sw.miss !== undefined) return;
          this.onSwingHit?.(sw.attackerId);
        },
      },
    );
    // ★ 请求已被 tick 消费，清空。没被消费的（例如实体已死）也一并丢弃 ——
    //   一个 tick 之前的施法意图不该在下一个 tick 复活
    this.pendingCasts.clear();
    this.pendingTrinkets.clear();
    /**
     * ★ 移动意图同理，**每 tick 重新表达**。此前只 set 不 clear：
     *   实战模式关掉（再按 K）或假人中途被静音后，最后一帧的输入会永远留在
     *   表里，tickWorld 按它把假人一直往一个方向推 —— 「关掉实战模式，
     *   假人还在走」就是这个漏洞的样子。
     */
    this.frameInputs.clear();

    this.updateDummies();
    this.reviveInTestbed();
  }

  /**
   * 试验场专用：任何人死亡后立刻满血复活。
   *
   * ⚠️ 这是**试验场规则**，不是游戏规则。规格书 11.4 明确要求
   * 「当前回合死亡后不能普通复活」—— 那条规则属于 M5 的回合系统，
   * 会在 sim/match/arena.ts 里实现，与这里无关。
   *
   * 之所以需要它：假人法师每 3.5 秒对你打 120 点，900 血的法师 26 秒就会倒下，
   * 而移动物理、镜头这些验收项需要几分钟的连续操作。
   */
  private reviveInTestbed(): void {
    for (const e of listEntities(this.world)) {
      if (e.alive) continue;
      e.alive = true;
      e.health = e.maxHealth;
      clearAuras(this.auras, e.id);
      e.flags = deriveStatusFlags(this.auras, e);
      /**
       * ★ 连带补上演示装备。
       *
       *   M9 接上 10.10 之后，死亡会正确地清掉临时装备 —— 而这个假复活
       *   是**试验场规则**（见本方法头部）。真实对局里死了就是死了，
       *   装备该没就没；但试验场既然凭空把人救活，就得把它的演示素材
       *   一起恢复，否则被假人打死一次之后 15.3 的装备栏就再也没东西可看，
       *   而那是 M8 验收 #35 正在验的对象。
       */
      if (e.id === this.player.id) {
        this.grantDemoLoadout();
        // C3：假复活发生在死亡后的**下一帧**，玩家来不及读日志就已经站起来了 ——
        //   中部提示要收掉死亡那条，否则「你已阵亡」会一直挂在活人脸上
        this.onSelfRevive?.();
      }
      this.push(`${e.name} 已复活（试验场不结算死亡，见 11.4）`, 'info');
    }
  }

  /**
   * ★ 12.3 / 验收 #40：技能效果结算**之前**的钩子。
   *
   * 规格书说「使用完全无敌、消失或潜行时**先掉旗，再播放对应技能表现**」——
   * 顺序写反会出现一帧「旗帜跟着隐形角色消失」。
   * `flag.ts` 的 `dropFlagBeforeSkill()` 实现了这条规则，但客户端得**真的调它**：
   * M8 接线时就漏了这一步，结果带旗开寒冰屏障旗帜还在手上 ——
   * 单元测试全绿，是浏览器里带旗按了一次 8 键才发现的。
   */
  onBeforeSkillEffects?: (caster: CombatEntity, skill: SkillDef) => void;

  // ── M12：表现层钩子（音效 / 浮动数字 / 受击闪光）────────────────
  //
  // ★ 三个都是**只读旁路**：不改任何战斗状态，不订阅也不影响任何规则。
  //   与 onBeforeSkillEffects 不同 —— 那个承载验收 #40 的规则调用，这些只承载表现。

  /** 每条战斗事件（伤害/治疗/光环/驱散/死亡/位移…）的旁路，与日志同源 */
  onCombatEvent?: (ev: CombatEvent) => void;
  /**
   * 施法生命周期：开始读条 / 完成 / 被打断 / 失败。
   *
   * ★ `targets` 只在 `resolved` 时给出，是 tick 传来的**结算前**目标集合 ——
   *   表现层（14.2 的表现用弹体）要知道「这一发飞向谁」。刻意不在这里重算：
   *   重算会漏掉几个已经在本次结算中倒下的人，弹体就会少飞几发。
   */
  onCastActivity?: (
    kind: 'started' | 'resolved' | 'interrupted' | 'failed',
    caster: CombatEntity,
    skill: SkillDef | undefined,
    targets?: readonly CombatEntity[],
  ) => void;
  /**
   * X21：**0.4 秒排队窗过期**（合同 C5 的排队位到点还没轮到它）。
   *
   * ★★ 刻意与 `onCastActivity('failed')` **分开一路**：那一路会走
   *   `selfFail()` 写一条「无法释放：公共冷却中」的日志 —— 而 0.4 秒之后
   *   再弹那句话，说的是一个当下已经不成立的理由（X21 拍板的正是这一点，
   *   sim 侧因此专门不发 `onFailed`）。从这里请回失败提示等于把板拆掉。
   * ★ 所以本钩子**不写日志、不发中部提示**：它只是给表现层一个信号，
   *   由表现层决定要不要说、说成什么（试验场接的是技能栏上的短促红闪）。
   * ⚠️ `caster` 可能是**假人** —— 假人的请求永远不带 queue（三道保险钉着），
   *   所以实战里它只会是玩家；调用方仍然按 id 判一次，别闪错人的技能栏。
   */
  onQueueExpired?: (caster: CombatEntity, skill: SkillDef, waited: number) => void;
  /** 换装结束（true=完成，false=中断）*/
  onSwapResult?: (completed: boolean) => void;
  /** 7.6 白字命中 → 表现层播挥砍动画与破空声（实战模式才会触发）*/
  onSwingHit?: (attackerId: EntityId) => void;

  /**
   * 合同 C3：**只关于玩家自己**的四件大事，供屏幕中部短提示（B1 接线）。
   *
   * ★★ 为什么不让接线方自己去 `log` 里筛：日志是 40 条的环形缓冲，
   *   一帧里可能进好几条，接线方要么轮询（会漏、会重）、要么按文案匹配
   *   （文案一改就静默失效）。这里在事件发生的那一刻直接推给它。
   * ★ 四个都是**纯通知**：不改任何战斗状态，不订阅也不影响规则
   *   （与上面三个表现钩子同一条纪律）。
   * ★ 传的是**已经写进日志的那句话**，不是错误码 —— 中部提示与日志说同一句，
   *   玩家不必在两处之间做翻译。
   */
  onSelfInterrupted?: (text: string) => void;
  onSelfCastFailed?: (text: string) => void;
  /** 击杀者姓名。★ 可空：环境伤害、持续伤害结算时源已离场都拿不到名字 */
  onSelfDeath?: (killerName?: string) => void;
  onSelfRevive?: () => void;

  /**
   * 把一条战斗事件转成日志行。
   *
   * ★ 事件由 `tickWorld` 的 `onEffects` 送进来 —— 客户端**不再自己结算效果**，
   *   所以这里是纯粹的「事件 → 文案」，日志格式只有一处需要维护。
   */
  private logEvent(ev: CombatEvent): void {
    const name = (id: number | undefined) =>
      id === undefined ? '?' : (getEntity(this.world, id as never)?.name ?? '?');

    switch (ev.t) {
      case 'damage':
        if (ev.immune) { this.push(`${name(ev.targetId as never)} 免疫了伤害`, 'info'); break; }
        if (ev.amount === 0 && ev.absorbed === 0) break;
        this.push(
          `${name(ev.sourceId as never)} → ${name(ev.targetId as never)} ${ev.amount} 点${SCHOOL_TEXT[ev.school]}伤害` +
            (ev.absorbed > 0 ? `（吸收 ${ev.absorbed}）` : ''),
          'ok',
        );
        break;
      case 'heal':
        this.push(`${name(ev.sourceId as never)} 治疗 ${name(ev.targetId as never)} ${ev.amount} 点`, 'ok');
        break;
      case 'auraApplied': {
        const drNote = ev.drFactor !== undefined && ev.drFactor < 1 ? `（递减至 ${(ev.drFactor * 100).toFixed(0)}%）` : '';
        this.push(
          `${name(ev.targetId as never)} 获得 ${this.auraDisplayName(ev.targetId, ev.auraId)} ` +
            `${ev.duration.toFixed(1)}s${drNote}`,
          'info',
        );
        break;
      }
      case 'immune':
        this.push(
          `${name(ev.targetId as never)} 免疫${ev.why === 'dr' ? '（控制递减已满）' : '（完全免疫）'}`,
          'interrupt',
        );
        break;
      case 'shieldBroken':
        this.push(`${name(ev.targetId as never)} 的护盾破裂`, 'interrupt');
        break;
      case 'dispelled':
        // ★ 同上：驱散提示里也不该出现内部 id。⚠️ 这条走的是回落链第 2/3 级 ——
        //   光环已经被移走了，实例查不到。X26 之前只能靠 id 前缀反查**技能**名
        //   （「驱散了 霜矢」），现在注册表直接给得出**光环**名（「驱散了 寒冷」）
        this.push(
          `${name(ev.sourceId as never)} 驱散了 ${name(ev.targetId as never)} 的 ` +
            this.auraDisplayName(ev.targetId, ev.auraId),
          'ok',
        );
        break;
      case 'death': {
        this.push(`${name(ev.targetId as never)} 被击杀`, 'interrupt');
        // C3：自己倒下要有中部大提示 —— 14 行的日志区在团战里两秒就被顶完了
        if (ev.targetId === this.player.id) {
          const killer = ev.killerId === undefined
            ? undefined : getEntity(this.world, ev.killerId)?.name;
          this.onSelfDeath?.(killer);
        }
        break;
      }
      case 'displaced':
        this.push(`${name(ev.targetId as never)} 被${DISPLACE_TEXT[ev.kind] ?? ev.kind}`, 'info');
        break;
      default:
        break;
    }
  }

  /**
   * 光环 id → 玩家看得懂的名字。
   *
   * ★★ 存在的理由：日志里曾经直接打内部 id ——「获得 mage.frostbolt.chill 3.0s」。
   *   那是给写代码的人看的，不是给玩家看的。
   *
   * ⚠️ **四级回落，可靠度逐级下降，如实写在这里：**
   *   1. **目标身上这条光环实例的 `def.name`** —— 光环定义自带的显示名，唯一
   *      权威的一级。事件是效果结算**之后**成批送来的，所以此刻它已经在
   *      `auras` 仓里了（`auraRemoved` / `dispelled` 是例外，见下）。
   *   2. **X26 注册表**（`data/auraRegistry.ts`）—— 同样是 `AuraDef.name`，
   *      只是从静态数据里查而不是从实例里读，所以**光环已经掉了也答得出**
   *      （`auraRemoved` / `dispelled` 走的正是这一级）。
   *      ★ 这一级把两条路对齐了：联网侧的 `toHudAura` 用的是同一张表，
   *      于是「被驱散了 X」在试验场与联网局说的是同一个词。
   *   3. 再查不到就把 auraId 的**前缀**当技能 id 反查**技能**名
   *      （`mage.frostbolt.chill` → `mage.frostbolt` → 「霜矢」）。
   *      ⚠️ 这一级依赖「光环 id 以所属技能 id 开头」这条**书写约定**，
   *      不是 schema 保证的 —— 数据里换个命名它就静默失效（回落到第 4 级）。
   *      ⚠️ 它给的是**技能**名而不是光环名，第 2 级能答时轮不到它。
   *      **不许删**：运行时拼出来的 id（`control.*`）注册表里没有。
   *   4. 都查不到才裸露 id。宁可露出 `control.stun`，也不编一个名字：
   *      编出来的名字玩家找不到对应技能，比看见 id 更糟。
   */
  private auraDisplayName(targetId: EntityId, auraId: string): string {
    for (const a of aurasOf(this.auras, targetId)) {
      if (a.def.id === auraId && a.def.name) return a.def.name;
    }
    const byRegistry = auraNameById(auraId);
    if (byRegistry) return byRegistry;
    const parts = auraId.split('.');
    // ★ 从长到短试前缀：技能 id 是 `<职业>.<技能>` 两段，但不写死段数 ——
    //   将来出现三段技能 id 时这里不需要跟着改
    for (let n = parts.length - 1; n >= 2; n--) {
      const s = getSkill(asSkillId(parts.slice(0, n).join('.')));
      if (s) return s.name;
    }
    return auraId;
  }

  /**
   * 实战模式下的假人：由 `decideBotAction()` 驱动，走**与真人相同**的
   * `inputs` + `castRequests` 通道。
   *
   * ★★ 与站桩模式的关键差别不只是「会动」，而是**它不作弊**：
   *   不清冷却、不补资源、不直接写 yaw —— 全部由 sim 按真人的同一套规则结算。
   *   站桩模式那三行豁免（`resources.set(max)` / `cooldowns.clear()` /
   *   `gcdUntil = 0`）是**演示靶子专用**的，日后接到服务器当人机时绝不能带过去。
   */
  private updateCombatBots(): void {
    /**
     * 合同 C8：宽限期内整段控制器让位。
     *
     * ★ 规格只要求「不锁定玩家、不出招」，这里**连移动意图也不下发** ——
     *   只停手不停脚的话，假人会在这 5 秒里稳稳贴到你脸上，缓冲就白给了
     *   （宽限期本来就是为「够读一遍提示条」设的）。
     * ⚠️ 缺省 graceSeconds=0 时 `inGrace` 恒假，这一行等于不存在。
     */
    if (this.inGrace) return;
    for (const e of listEntities(this.world)) {
      if (e.id === this.player.id || !e.alive) continue;
      if (this.pausedDummyClasses.has(e.classId as string)) continue;

      // 移动状态按需建立（没有条目 = tickWorld 不推进它 = 站着不动）
      if (!this.dummyMovement.has(e.id)) {
        const ms = createMovementState(e.position, e.yaw);
        this.dummyMovement.set(e.id, ms);
        this.movementStates.set(e.id, ms);
      }

      /**
       * ★★ 选敌：最近的**敌对**存活实体（玩家只是候选之一）。
       *
       *   此前这里写死 `foe = this.player`：每个假人 —— 包括与玩家同队的
       *   「队友」—— 都围着玩家转，X10 真机轮实测被当场戳穿（「为什么我的
       *   队友们也会攻击我」）。stressDummies 的阵营（spawnDummy 队友=RED）
       *   摆好了一年，驱动层从来没吃过。
       *   压测台的「12v12」自此才名副其实：敌人分散打全队，队友打敌人。
       *
       * ★ 全灭敌对时假人停手站定（练习场打空靶的边界）。
       * ★ 任务升级点：仇恨体系（threat 表）就换这一个函数。
       */
      const foe = this.pickBotFoe(e);
      if (!foe) {
        this.frameInputs.set(e.id, { forward: 0, strafe: 0, jump: false, yaw: e.yaw });
        continue;
      }
      /**
       * ★ 7.6 白字的开火判据是「敌方硬目标存活」（偏差 #9），所以实战模式下
       *   必须给假人设硬目标 —— 服务器那边由 `SetTarget` 消息设，试验场
       *   没有协议层，这里直接设。
       */
      if (e.targets.hard !== foe.id) e.targets.hard = foe.id;

      const action = decideBotAction({
        world: this.world,
        casting: this.store,
        self: e,
        foe,
        rng: this.botRng,
        // P1b：脚下的敌方区域与待落的陨星 —— 试验场假人也会躲圈了
        ground: this.ground,
        projectiles: this.projectiles,
        // P3b：看得见自己挂在玩家身上的 DoT，不再每个 GCD 重挂
        auras: this.auras,
        // P4：控制递减仓 —— 假人对玩家出控制也讲递减，不空放
        dr: this.dr,
        // P5：`?bot=` 的难度直通决策层（easy 不打断不躲圈，hard 留踢）
        difficulty: this.botDifficulty,
      });
      this.frameInputs.set(e.id, action.move);
      // P5：假人也会交战斗意志 —— 与玩家的 requestTrinket 走同一条 tick 通道
      if (action.trinket) this.pendingTrinkets.add(e.id);
      if (action.cast) {
        const s = getSkill(action.cast.skillId);
        // ★ 走同一个入口，不另开后门（见 requestCast 的注释）
        if (s) this.requestCast(e, s, { ...(action.cast.targetId !== undefined
          ? { targetId: action.cast.targetId } : {}) });
      }
    }
    this.syncBotSwings();
  }

  /**
   * 假人选敌：**仇恨最高者 > 最近的敌对存活实体**（X10 用户拍板）。
   *
   * ★ 与服务器 `pickFoe` 的 normal 档同构：仇恨走共享的 `pickByThreat`
   *   （自带 SWITCH_RATIO 迟滞防横跳），表空（开局没挨过打）退最近敌对。
   * ★ easy 不记仇 —— 与服务器同一条难度门（木桩手感卖的就是「他不配合」）。
   * ★ O(n²) 在 24 实体下是 576 次距离比较/帧，不值得建索引。
   */
  private pickBotFoe(e: CombatEntity): CombatEntity | undefined {
    if (this.botDifficulty !== 'easy') {
      const picked = pickByThreat(this.threat, e.id, e.targets.hard, (id) => {
        const o = getEntity(this.world, id);
        return o !== undefined && o.alive && o.team !== e.team && o.id !== e.id;
      });
      if (picked !== undefined) return getEntity(this.world, picked);
    }
    let best: CombatEntity | undefined;
    let bestD = Infinity;
    for (const o of listEntities(this.world)) {
      if (o.id === e.id || !o.alive || o.team === e.team) continue;
      const d = distance2D(e.position, o.position);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /**
   * 7.6 白字的开火同步 —— 与服务器 `MatchLoop.syncSwings()` 同一个判据：
   * 「敌方硬目标存活」即开火，否则停手。此前试验场只传了 `swings` store
   * 从来没人登记，实战模式的普攻整条是死的（X10 真机轮实测：假人只放
   * 技能不抡武器）。玩家也在同步范围内 —— 与联网行为对齐（偏差 #9）。
   */
  private syncBotSwings(): void {
    const now = this.world.time;
    for (const e of listEntities(this.world)) {
      const target = e.targets.hard !== undefined
        ? getEntity(this.world, e.targets.hard)
        : undefined;
      const engaged =
        e.alive && target !== undefined && target.alive && target.team !== e.team;
      if (engaged) {
        // ★ W26：与服务器 syncSwings 同一个函数 —— 第一刀也吃 attackSpeed
        beginSwing(this.swings, e.id, now, swingIntervalOf(this.auras, e, now));
      } else {
        stopSwing(this.swings, e.id);
      }
    }
  }

  /** 假人行为：牧师和法师反复读条，战士见缝插针打断你 */
  private updateDummies(): void {
    /**
     * 合同 C8：宽限期结束时打一条「战斗开始」。
     * ★ 挂在 `graceSeconds > 0` 后面而不是只看 `graceAnnounced` —— 不带 `&grace`
     *   的场次（全部 verify 脚本）连这条判断的第二项都不会求值，日志逐字节不变。
     */
    if (this.graceSeconds > 0 && !this.graceAnnounced && !this.inGrace) {
      this.graceAnnounced = true;
      this.info('宽限期结束 —— 战斗开始');
    }
    // 实战模式：整段站桩脚本让位给控制器
    if (this.combatMode) {
      this.updateCombatBots();
      return;
    }
    // C8：站桩假人同理 —— 练习场也可能不开实战模式，两条路都得挡
    if (this.inGrace) return;
    for (const e of listEntities(this.world)) {
      if (e.id === this.player.id || !e.alive) continue;
      // M15：教学按环静音部分假人（见 pausedDummyClasses 注释）
      if (this.pausedDummyClasses.has(e.classId as string)) continue;

      // ★ 假人始终面向玩家。
      //   6.5 规定近战技能要求目标位于前方 180°，拳击也不例外 ——
      //   假人 yaw 恒为 0 时玩家站在它背后，validateCast 会判 WrongFacing，
      //   于是它永远打断不了你，7.5 的博弈就演示不出来。
      //   这不是给假人开后门：它和玩家受的是同一套朝向规则，只是会转身而已。
      e.yaw = dirToYaw(normalize2D(sub(this.player.position, e.position)));

      const next = this.dummyNextCast.get(e.id as number) ?? Infinity;
      if (this.world.time < next || isCasting(this.store, e.id)) continue;

      if ((e.classId as string) === 'warrior') {
        this.updateWarriorPummel(e);
        continue;
      }

      // 牧师/法师：反复读条，给你练打断
      const skillId = (e.classId as string) === 'priest' ? 'priest.flash_heal' : 'mage.frostbolt';
      const s = getSkill(asSkillId(skillId));
      if (!s) continue;
      for (const [r, max] of e.maxResources) e.resources.set(r, max);
      e.cooldowns.clear();
      e.gcdUntil = 0;
      // ★ 和玩家走**同一个**入口（见 requestCast 的注释）。
      //   这里曾经直接调 `beginCast()` 且不传 events —— 之所以没出事，
      //   只是因为这两个假人技能碰巧都是读条技能，完成时走的是
      //   `tickCasting` 而不是 `beginCast` 内部那条路。换成瞬发技能就会
      //   静默地不产生任何效果。不留这种「靠数据碰巧成立」的正确性。
      this.requestCast(e, s, {
        targetId: (e.classId as string) === 'priest' ? e.id : this.player.id,
      });
      this.dummyNextCast.set(e.id as number, this.world.time + s.cast.time + 2.5);
    }
  }

  /*
   * ⚠️ 这里曾经有一个 `tryPriestShield()`：牧师假人每 12 秒给战士套一层护心屏障。
   *
   * 加它是为了补「14.3 护盾四态在试验场根本不可达」这个洞 —— 当时玩家的 8 个
   * 技能槽里没有任何吸收技能，`setShield()` 永远收到 undefined，四态一态都没画过。
   *
   * **删掉它的原因（两条，第二条是教训）：**
   *   1. 玩家技能栏加了第 9 格「霜甲护盾」之后，玩家能在**自己身上**看到完整四态，
   *      这段就成了冗余。
   *   2. ★★ 它让试验场**最常用的那个打击目标永远带着盾**（12 秒周期里有 6 秒），
   *      直接打掉了 `verify:m4` 的 M4a「直接伤害技能扣减目标生命」——
   *      火焰冲击 225 全被吸收，血量一点没掉。
   *      而我当时的回归只跑了 m2/m8/m10/m12/m13/m15，**没跑 m3/m4**，
   *      所以这条回归是带着缺陷被推上 main 的。
   *
   * 教训：给「演示用的假人行为」加任何常驻效果之前，先想清楚它会不会污染
   * 141 项验收赖以成立的**初始条件**。假人是舞台道具，不是玩家。
   */

  /**
   * 战士假人的打断行为，演示 7.2 + 7.5 的完整博弈：
   *
   *   看到你读条 → 等 0.45 秒反应 → 按下拳击
   *     你还在读条 → 被打断 + 魔法学派锁定 3 秒
   *     你已经取消 → **落空，但仍进入 15 秒冷却**（7.2）→ 你获得一个自由施法窗口
   *
   * 这就是「假读条骗打断」的完整闭环。
   */
  private updateWarriorPummel(warriorDummy: CombatEntity): void {
    const pummel = getSkill(asSkillId('warrior.pummel'))!;
    const onCooldown = (warriorDummy.cooldowns.get(pummel.id) ?? 0) > this.world.time;
    if (onCooldown) {
      this.warriorPummelAt = null;
      return;
    }

    // ★ 拳击是 3 米近战技能。`applyInterrupt` 只负责结算打断本身，**不检查距离** ——
    //   距离/视线/朝向属于施法校验（validateCast）的职责。假人 AI 直接调
    //   applyInterrupt 就绕过了这层校验，会出现「14 米外隔空打断」。
    //   走 validateCast 而不是自己写距离判断，保证假人和玩家受同一套规则约束。
    const canReach = validateCast({
      world: this.world, caster: warriorDummy, skill: pummel,
      target: this.player, phase: 'start',
    });
    if (canReach !== CastFailure.Ok) {
      this.warriorPummelAt = null;
      return;
    }

    // 决定阶段：看到你在读条就起意
    if (this.warriorPummelAt === null) {
      if (isCasting(this.store, this.player.id)) {
        this.warriorPummelAt = this.world.time + CombatDirector.PUMMEL_REACTION;
      }
      return;
    }

    if (this.world.time < this.warriorPummelAt) return;

    // 执行阶段：按下去了就按下去了，此刻你还在不在读条决定命中与否
    this.warriorPummelAt = null;
    /**
     * ★ 表现通知：拳击**真的挥出去了**（无论命中与否）。
     *   专用打断不走 requestCast/tickWorld，所以 `onCastResolved` 不会替它发 ——
     *   没有这一句，战士出拳时身体纹丝不动、无声无光（用户实测反馈）。
     *   走 onCastActivity 而不是新钩子：它就是一次技能释放，
     *   音效/粒子/挥砍动画都该与玩家路径同源。
     */
    this.onCastActivity?.('resolved', warriorDummy, pummel, [this.player]);
    const out = applyInterrupt(this.world, this.store, this.player, interruptLockSeconds(pummel) ?? 3, {
      onInterrupted: (_c, st, _src, lock) => {
        const n = getSkill(st.skillId)?.name ?? st.skillId;
        const lockText = lock
          ? `，${SCHOOL_TEXT[lock.school]}系技能被封锁 ${(lock.until - this.world.time).toFixed(1)}s`
          : '';
        const text = `${warriorDummy.name} 用${pummel.name}打断了你的 ${n}${lockText}`;
        this.push(text, 'interrupt');
        // C3：这条路径不经过 tickWorld（专用打断直接调 applyInterrupt），
        // 所以中部提示得在这里再接一次 —— 漏掉它就会「被拳击打断没提示，
        // 被移动打断有提示」，而玩家分不清这两者有什么区别
        this.onSelfInterrupted?.(text);
      },
    });

    // ★ 7.2：落空也进冷却。这一句刻意放在 if 外面，无法被分支绕过
    warriorDummy.cooldowns.set(pummel.id, this.world.time + pummel.cooldown);
    if (!out.interrupted) {
      this.push(
        `${warriorDummy.name} 的${pummel.name}落空（你骗到了！），仍进入 ${pummel.cooldown}s 冷却`,
        'ok',
      );
    }
  }

  // ── 玩家操作 ────────────────────────────────────────────────

  /** 5.3 Tab 循环。★ 传的是**镜头** yaw */
  cycleTarget(viewYaw: number, reverse = false): void {
    const picked = tabTarget(this.world, this.player, {
      viewYaw,
      isCasting: (e) => isCasting(this.store, e.id),
    }, reverse);
    if (!picked) this.info('前方 140° / 45 米内没有可选目标');
  }

  /**
   * 玩家主动选中（点击姓名板 / HUD 队伍框）。
   *
   * ★ 合同 C6：这条路径传 `enforceRange: true` —— 45 米（`RANGE.MAX_SELECT`）
   *   之外点得到、选得上，但那个目标什么技能都放不出来，玩家会以为是技能坏了。
   *   ⚠️ 只有**玩家主动选中**这条路径拦；`tabTarget`（本来就只在 45 米内循环）
   *   与实战模式给假人设硬目标都不走这里，行为不变。
   * ★ 判「有没有选上」看的是 `targets.hard` 本身而不是返回值：拒绝的表达方式
   *   属于 shared 的接口设计，这里只关心**世界的状态**变没变。
   */
  selectById(id: number): void {
    setHardTarget(this.world, this.player, id as never, { enforceRange: true });
    if (this.player.targets.hard === (id as never)) return;
    const e = getEntity(this.world, id as never);
    // 超距是唯一需要解释的拒绝理由 —— 其余（目标不存在/不可选中）在 UI 上
    // 本来就点不到，多一条日志只是噪音。
    // ★ 判据用 shared 的 `withinSelectRange`，与 setHardTarget 内部**同一把尺子**：
    //   这里自己量一遍的话，边界上会出现「拒绝了但不说为什么」
    if (e && !withinSelectRange(this.player, e)) {
      this.selfFail(`${e.name}：超出选中距离（${RANGE.MAX_SELECT} 米）`);
    }
  }

  toggleFocusOnCurrent(): void {
    toggleFocus(this.world, this.player, this.player.targets.hard);
  }

  /** 7.5 主动取消读条（假读条）*/
  cancelPlayerCast(): void {
    if (cancelCast(this.world, this.store, this.player, {
      onInterrupted: (_c, st) => {
        const n = getSkill(st.skillId)?.name ?? st.skillId;
        this.push(`你主动取消了 ${n}（不消耗资源与冷却）`, 'info');
      },
    })) return;
  }

  /**
   * 5.5：解算地面技能落点。客户端画指示器和这里的合法性判断走的是**同一个函数**，
   * 所以「指示器显示合法 → 按下去却失败」不可能发生（验收 #8）。
   */
  resolveGround(skill: SkillDef, requested: Vec3): GroundPlacement {
    return resolveGroundPlacement(this.player, requested, skill, this.world.obstacles, this.mapBounds);
  }

  /** 6.3：按形状选出会被命中的目标，供指示器高亮 */
  previewShapeTargets(skill: SkillDef, groundPoint?: Vec3): CombatEntity[] {
    return collectShapeTargets(this.world, this.player, {
      origin: shapeOrigin(this.player, skill, groundPoint),
      // ★ 角色 yaw，不是镜头 yaw（5.4 / 6.5）
      yaw: this.player.yaw,
      shape: skill.shape,
      filter: skill.targetFilter,
    });
  }

  /**
   * 按下一个技能键。
   *
   * ★★ **这里只产生「意图」，不结算任何东西。**
   *
   *   在 M10 之前这个方法直接调 `beginCast()`，于是施法有了**两个**完成出口：
   *   瞬发技能在 `beginCast` 内部就完成并回调到客户端自己的结算，
   *   读条技能则由 `tickWorld` 里的 `tickCasting` 完成并走 sim 的结算。
   *   两条路径各有一套日志与效果结算，而只有后者是服务器将来要跑的那条 ——
   *   M4 的「陨石落地」日志就是这么掉的：它只写在客户端那条路径上。
   *   更隐蔽的是瞬发技能击杀不进 `settleDeaths`，10.10 静默失效。
   *
   *   现在只剩一条路径：意图进队列，`tickWorld` 第 1 步统一 `beginCast()`。
   *   ★ 代价是施法延后一帧（~16ms）—— 而这正是服务器的语义
   *   （意图 → 下一 tick 结算），A5 的客户端预测要复现的也是它。
   *
   * ★ 下面的**落点合法性预检留在客户端**：它必须和落点指示器用同一个函数，
   *   否则会出现「指示器显示合法 → 按下去却失败」（5.5 / 验收 #8）。
   *   它是 UI 判据，不是 sim 规则 —— sim 那边 `validateCast` 会再验一次。
   */
  /**
   * 8.3 战斗意志（W8）。冷却预检只为给提示 —— 权威判定在 tick 第 1c 步，
   * 且那一步刻意不查控制状态（8.3「昏迷中可用」，解控就是为昏迷造的）。
   */
  requestTrinket(): void {
    const ready = this.player.cooldowns.get(TRINKET_COOLDOWN_KEY) ?? 0;
    if (this.world.time < ready) {
      this.selfFail(`战斗意志冷却中（还剩 ${Math.ceil(ready - this.world.time)} 秒）`);
      return;
    }
    this.pendingTrinkets.add(this.player.id);
  }

  /**
   * P3c：运行时换技能栏（设置面板改完立即生效）。
   * ★ `skills` 是 readonly 字段但数组内容可换 —— 原地替换而不是换引用，
   *   持有这个数组引用的地方（HUD 快照、瞄准回调）自然看到新栏。
   * ★ 冷却不受影响：冷却记在 `player.cooldowns` 按技能 id 存，
   *   与栏位无关 —— 把正在冷却的技能挪个格子，剩余冷却原样跟着走。
   * ⚠️ 调用方负责取消进行中的瞄准（TestbedScene 持有 aim 状态）——
   *   否则「瞄准着 7 格的陨星，7 格被换成了冰枪」会按旧技能落点确认。
   */
  setSkillBar(ids: readonly string[]): void {
    const defs = ids.map((id) => {
      const s = getSkill(asSkillId(id));
      if (!s) throw new Error(`技能不存在：${id}`);
      return s;
    });
    this.skills.splice(0, this.skills.length, ...defs);
  }

  castSlot(index: number, groundPoint?: Vec3, opts?: { selfCast?: boolean }): void {
    const skill = this.skills[index];
    if (!skill) return;

    /**
     * ★ 合同 C5：**玩家**按下的每一发都带 `queue: true`。
     *   GCD 还剩 0.1 秒时按下去，此前是一条「公共冷却」红字 + 什么都没发生 ——
     *   人手压不进 16ms 的窗口，所以「连招打不出来」是必然而不是手残。
     *   带上 queue 之后它进 0.4 秒排队窗，GCD 一结束**重走完整 validateCast**
     *   再消费，二次失败照常报错。
     * ⚠️ 假人/教学驱动的 `requestCast` **一律不带** —— 这是 normal 难度 bot
     *   平衡基线逐位不变的红线：bot 永远不触发排队，行为零扰动。
     */
    // 地面技能：先做落点合法性检查（5.5：非法位置不能确认）
    if (needsGroundPlacement(skill)) {
      if (!groundPoint) {
        this.selfFail(`${skill.name}：需要先选择落点`);
        return;
      }
      const placement = this.resolveGround(skill, groundPoint);
      if (!placement.legal) {
        this.selfFail(`${skill.name} 落点非法：${FAIL_TEXT[placement.reason]}`);
        return;
      }
      this.requestCast(this.player, skill, { groundPoint: placement.center, queue: true });
      return;
    }

    // 5.6：自身、自身中心、方向技能都不需要选择目标，按角色位置/面向结算
    if (usesNoTarget(skill)) {
      this.requestCast(this.player, skill, { queue: true });
      return;
    }

    // 5.6 / W8：按住 Alt 自我施法 —— 只改写「可作用己方」技能的目标；
    // 对敌技能不改（免得把火球按给自己吃一发拒绝），服务器语义同款
    if (opts?.selfCast
        && (skill.targetFilter === TargetFilter.Ally || skill.targetFilter === TargetFilter.Any)) {
      this.requestCast(this.player, skill, { targetId: this.player.id, queue: true });
      return;
    }

    // W19：技能声明了 mouseover 支持时，悬停目标优先于硬目标（5.6 的顺位）
    const resolved = resolveSkillTarget(this.world, this.player, skill.targetFilter, {
      allowMouseover: skill.allowMouseover === true,
    });
    const target = resolved.ok ? resolved.target : undefined;

    // 打断类技能要特殊处理：它不是「对目标施法」，而是「结算一次打断」
    const interruptEffect = skill.effects.find((e) => e.kind === 'interrupt');
    if (interruptEffect) {
      this.castInterruptSkill(skill);
      return;
    }

    if (!resolved.ok && skill.targetFilter === TargetFilter.Enemy) {
      this.selfFail(`${skill.name}：${resolved.reason === 'noTarget' ? '需要目标' : '目标无效'}`);
      return;
    }

    /**
     * ★★ 友方技能选着敌人时，此前这里**不拦**，请求带着 `targetId: undefined`
     *   进 sim，回来一句「需要目标」—— 而玩家屏幕上明明选着一个人。
     *   提示说的是反话，玩家会去按 Tab 找目标，越找越错。
     *
     *   真正的情况有两种，分别给专门文案：
     *   · 有目标但不是友方 → 说清「不是友方」，并把出路（Alt 自我施放）一起给出。
     *   · 压根没目标 → 说清缺的是**友方**目标，别让人以为随便选个敌人就行。
     * ⚠️ 文案里的 Alt 是真的能用：上面的 selfCast 分支就只认 Ally/Any，
     *   两处的判据一字不差（技能描述不许对实现撒谎）。
     */
    if (!resolved.ok
        && (skill.targetFilter === TargetFilter.Ally || skill.targetFilter === TargetFilter.Any)) {
      this.selfFail(resolved.reason === 'noTarget'
        ? `${skill.name}：需要友方目标（按住 Alt 对自己施放）`
        : `${skill.name}：目标不是友方（按住 Alt 对自己施放）`);
      return;
    }

    this.requestCast(this.player, skill, { targetId: target?.id, queue: true });
  }

  /**
   * 把一次施法意图排进本 tick 的请求队列，由 `tickWorld` 消费。
   *
   * ★★ **这是本文件里唯一允许发起施法的地方。**
   *   玩家和假人都走它 —— 假人不是「简化路径」，它受同一套校验、
   *   同一个完成出口。绕过去直接调 `beginCast()` 而不传 `events`，
   *   瞬发技能会**静默地不产生任何效果**（资源照扣、冷却照进），
   *   而那正是 M4 踩过的坑的镜像。
   *
   * ★ 一个实体一 tick 只有一个请求（Map 覆盖），这与服务器的语义一致 ——
   *   同一 tick 内连按两个技能，后一个覆盖前一个，而不是两个都放出去。
   *
   * ★ M15 起为 public：新手教学的 TutorialDirector 是第三个合法调用方
   *   （它要在走位环替假人·法师往玩家脚下丢陨石）—— 教学驱动假人
   *   与假人自驱动走**同一个入口**，不另开后门。
   */
  requestCast(
    caster: CombatEntity,
    skill: SkillDef,
    /**
     * ★ 合同 C5 的 `queue` **不给默认值、由调用方显式传**。
     *   缺省即 undefined = 老行为，所以「忘了传」的后果是少一个便利功能，
     *   而不是给假人开出一条平衡外的通道 —— 这个默认方向是红线要求的：
     *   bot 永远不带 queue，normal 难度基线逐位不变。
     */
    opts: { targetId?: EntityId; groundPoint?: Vec3; queue?: boolean } = {},
  ): void {
    this.pendingCasts.set(caster.id, {
      skillId: skill.id,
      ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
      ...(opts.groundPoint ? { groundPoint: opts.groundPoint } : {}),
      ...(opts.queue ? { queue: true } : {}),
    });
  }

  /**
   * 专用打断的释放流程。
   * ★ 7.2：无论是否命中，技能都进入冷却 —— 所以冷却写在结算之外。
   */
  private castInterruptSkill(skill: SkillDef): void {
    const target = getEntity(this.world, this.player.targets.hard);

    /**
     * 先走一遍常规校验（距离、视线、学派锁定、沉默…）。
     *
     * ★ 这是本文件里**唯一**豁免「施法必须走 requestCast」的地方，理由是
     *   它根本不施法：`effects: []` 让这次调用退化成一次纯校验探针，
     *   打断的实际结算由下面的 `applyInterrupt` 负责（打断不是「对目标施法」，
     *   而是「结算一次打断」）。空效果表意味着它没有效果可漏结算。
     */
    const pre = beginCast(this.world, this.store, this.player, { ...skill, effects: [] }, { target });
    if (!pre.ok) {
      this.selfFail(`${skill.name} 无法释放：${FAIL_TEXT[pre.reason]}`);
      return;
    }

    // ★ 表现通知：断法确实放出去了（哪怕落空）。与战士拳击同理 ——
    //   这条路径不经过 tickWorld，此前它是全 91 技能里唯一零表现的（用户实测反馈）
    this.onCastActivity?.('resolved', this.player, skill, target ? [target] : []);

    const out = applyInterrupt(
      this.world,
      this.store,
      target,
      interruptLockSeconds(skill) ?? 3,
      {
        onInterrupted: (c, st, _src, lock) => {
          const n = getSkill(st.skillId)?.name ?? st.skillId;
          const lockText = lock
            ? `，${SCHOOL_TEXT[lock.school]}系技能被封锁 ${(lock.until - this.world.time).toFixed(1)}s`
            : '（物理动作，不会封锁技能）';
          this.push(`你打断了 ${c.name} 的 ${n}${lockText}`, 'interrupt');
        },
      },
    );

    // ★ 落空也进冷却（7.2）
    this.player.cooldowns.set(skill.id, this.world.time + skill.cooldown);
    if (!out.interrupted) {
      this.push(`${skill.name} 落空：${INTERRUPT_MISS_TEXT[out.reason ?? 'targetMissing']}，仍进入冷却`, 'fail');
    }
  }

  // ── 供 HUD 读取的视图 ───────────────────────────────────────

  get playerCast(): CastState | undefined {
    return this.store.get(this.player.id);
  }

  get target(): CombatEntity | undefined {
    return getEntity(this.world, this.player.targets.hard);
  }

  get focus(): CombatEntity | undefined {
    return getEntity(this.world, this.player.targets.focus);
  }

  castOf(e: CombatEntity): CastState | undefined {
    return this.store.get(e.id);
  }

  /** 技能栏视图：冷却、GCD、当前不可用原因与**全部**阻碍项（合同 C1）*/
  skillSlots(): SkillSlotView[] {
    /**
     * ★ GCD 全栏共用一份 —— 它是**角色**的状态，不是技能的。
     *   与 `beginCast` 里写 `gcdUntil` 用的是同一个表达式（`casting.ts`），
     *   两处漂了就会出现「扫圈转完了还按不动」。
     */
    const gcdTotal = Math.max(GCD.MIN, GCD.BASE);
    const gcdLeft = Math.max(0, this.player.gcdUntil - this.world.time);

    return this.skills.map((skill) => {
      let target: CombatEntity | undefined;
      let groundPoint: Vec3 | undefined;
      if (needsGroundPlacement(skill)) {
        // 地面技能不需要硬目标，落点在瞄准时才产生。
        // 这里传一个必然合法的落点（脚下），让 HUD 只反映冷却/资源/沉默这类状态 ——
        // 否则技能栏会一直显示「需要目标」，那是错的（15.2 要求提示准确）。
        groundPoint = this.player.position;
      } else if (!usesNoTarget(skill)) {
        // W19：技能栏的可用性判定与真实施法同一套目标解析（含 mouseover 顺位）
        const resolved = resolveSkillTarget(this.world, this.player, skill.targetFilter, {
          allowMouseover: skill.allowMouseover === true,
        });
        target = resolved.ok ? resolved.target : undefined;
      }
      const ctx = hudCastContext(this.world, this.player, skill, target, groundPoint);
      return {
        skill,
        cooldownRemaining: Math.max(0, (this.player.cooldowns.get(skill.id) ?? 0) - this.world.time),
        blocker: validateCast(ctx),
        blockers: describeCastBlockers(ctx),
        // ★ 不吃 GCD 的技能恒为 0：它恰恰是 GCD 期间唯一还能按的东西，
        //   给它画一圈扫光等于把唯一的出路也涂灰了
        gcdRemaining: skill.triggersGcd ? gcdLeft : 0,
        gcdTotal,
      };
    });
  }

  /**
   * ★ 实现 `CombatView`（HUD 的窄接口）所需的两个成员。
   *   `CombatEntity` 结构上已经满足 `HudUnit`，所以不需要任何适配层 ——
   *   这正是那个接口按「HUD 真的读什么」来定义、而不是照抄 CombatEntity 的收益。
   */
  get now(): number { return this.world.time; }
  visibleUnits(): CombatEntity[] { return this.visibleEntities(); }

  /** 场上所有可见实体，供姓名板绘制 */
  visibleEntities(): CombatEntity[] {
    return listEntities(this.world).filter(
      (e) => e.id !== this.player.id && isSelectableBy(e, this.player),
    );
  }

  /** 含玩家自己的全部实体。M8 的状态标记要挂在所有人身上，包括自己 */
  allEntities(): CombatEntity[] {
    return listEntities(this.world);
  }

  /**
   * 某个实体身上最强的吸收护盾。14.3 的护盾四态靠它驱动。
   *
   * ★ 判据走 `strongestShield()` —— 与联网侧（从 `AuraSnapshot` 读）
   *   **同一处实现**。两条路各写一遍「哪个盾算数」迟早会漂，
   *   而玩家只会发现「同一局里单机和联机的护盾表现不一样」。
   * ★ 返回 `auraId` 是为了让调用方查回学派色（冰盾冰蓝、护心屏障圣金）。
   */
  shieldOf(id: EntityId): { auraId: string; remaining: number; initial: number } | undefined {
    return strongestShield(
      aurasOf(this.auras, id).map((a) => ({
        auraId: a.def.id,
        absorbRemaining: a.absorbRemaining,
        absorbInitial: a.absorbInitial,
      })),
    );
  }

  /**
   * 某个控制光环是**什么学派**施加的（`control.root` / `control.stun` …）。
   *
   * ★ 为什么要有这个方法：控制光环的 id 被统一改写成 `control.<kind>`
   *   （`sim/effects/combat.ts`），所以表现层**无法**像护盾那样用
   *   `visualForAuraId()` 从 id 反查回技能。学派现在存在 `AuraDef.school` 上
   *   （施加时本来就算出来了，用于抗控系数），这里把它取出来。
   * ★ 查不到返回 undefined，调用方退回中性色 —— 编一个颜色比不画更糟。
   */
  controlSchoolOf(id: EntityId, kind: string): School | undefined {
    for (const a of aurasOf(this.auras, id)) {
      if (a.def.id === `control.${kind}`) return a.def.school;
    }
    return undefined;
  }

  /** 15.3：玩家自己的装备栏视图 */
  playerLoadoutView(): LoadoutView {
    const l = this.loadouts.get(this.player.id);
    if (!l) throw new Error('玩家没有装备栏');
    return ownLoadoutView(this.player, l, this.swaps, this.world.time);
  }

  /**
   * 15.3：切换到下一件备用武器。
   *
   * ★ 走的是 shared 的 `beginSwap()` —— 换装的时间、中断窗口和
   *   10.7 的五项禁止利用全在那边保证（验收 #34）。这里只挑目标物品。
   */
  cyclePlayerWeapon(): string | null {
    const l = this.loadouts.get(this.player.id);
    if (!l) return null;
    const all = availableWeapons(l);
    if (all.length < 2) return '没有备用武器';
    const i = all.indexOf(this.player.weaponId);
    const next = all[(i + 1) % all.length]!;
    const r = beginSwap(this.player, l, this.swaps, SwapKind.Weapon, next, this.world.time);
    return r.ok ? null : r.reason;
  }

  distanceTo(e: CombatEntity): number {
    const a = hitCircleOf(this.player);
    const b = hitCircleOf(e);
    return Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
  }
}

/**
 * HUD 用的校验上下文。
 *
 * ★ 与实际释放走的是**同一个** `validateCast` —— 15.2 要求图标明确提示
 *   「超出距离/缺少视线/朝向错误」，如果 HUD 自己算一遍，迟早会出现
 *   「图标是亮的但按下去失败」这种最让人困惑的 bug。
 * ★ M11 的 `describeCastBlockers()` 吃的也是这个 ctx：门禁（单一原因）与
 *   提示（全部原因）必须看**同一份输入**，否则会出现「图标写着资源不足、
 *   叠加提示写着超出距离」这种自相矛盾 —— 那比只有一条错原因更糟。
 */
const hudCastContext = (
  world: World,
  caster: CombatEntity,
  skill: SkillDef,
  target: CombatEntity | undefined,
  groundPoint?: Vec3,
): CastContext => ({ world, caster, skill, target, groundPoint, phase: 'start' });

// ── 文案 ───────────────────────────────────────────────────────

export const FAIL_TEXT: Record<CastFailure, string> = {
  ok: '可用',
  noTarget: '需要目标',
  invalidTarget: '目标无效',
  outOfRange: '超出距离',
  tooClose: '距离太近',
  noLineOfSight: '缺少视线',
  wrongFacing: '朝向错误',
  onCooldown: '冷却中',
  onGlobalCooldown: '公共冷却',
  notEnoughResource: '资源不足',
  silenced: '已被沉默',
  disarmed: '已被缴械',
  /**
   * ★ 玩家语言不说「学派」（P10 后用户拍板：看不懂）—— 对玩家统一说
   *   「系」（火系/冰霜系，日志里带具体是哪系）。「学派」只留在代码与
   *   规格书层。改这条前先想清楚：它同时出现在格子徽标 / 失败日志 /
   *   中部提示 / 联网 CastFailed 四个出口。
   */
  schoolLocked: '技能被封锁',
  controlled: '无法行动',
  dead: '已死亡',
  invalidGroundPosition: '超出地图边界',
  classMismatch: '职业不匹配',
  weaponMismatch: '当前武器方案不提供该技能',
  carryingFlag: '持旗时禁用',
  inCombat: '需要脱离战斗',
  noRecentParry: '需要近期招架过',
  alreadyCasting: '正在施法',
};

export const SCHOOL_TEXT: Record<School, string> = {
  physical: '物理',
  holy: '神圣',
  fire: '火焰',
  frost: '寒冰',
  arcane: '奥术',
  shadow: '暗影',
  nature: '自然',
};

const INTERRUPT_TEXT: Record<string, string> = {
  kick: '专用打断',
  silence: '沉默',
  disarm: '缴械',
  hardControl: '硬控制',
  movement: '移动',
  forcedMove: '强制位移',
  selfCancel: '主动取消',
  invalid: '目标失效',
  death: '死亡',
};

const INTERRUPT_MISS_TEXT: Record<string, string> = {
  notCasting: '目标没在施法',
  notInterruptible: '该技能不可打断（盾牌标记）',
  targetMissing: '没有目标',
};
