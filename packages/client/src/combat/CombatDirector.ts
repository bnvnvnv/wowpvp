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
  asSkillId,
  asTeamId,
  getEntity,
  listEntities,
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
const PLAYER_SKILL_IDS = [
  'mage.frostbolt',
  'mage.fire_blast',
  'mage.counterspell',
  'mage.polymorph',   // 15 秒冷却的控制，用来演示 8.2 递减（冰霜新星 18 秒太慢）
  'mage.frost_nova',
  'mage.blizzard',
  'mage.meteor',
  'mage.ice_block',
] as const;

export interface CombatLogEntry {
  time: number;
  text: string;
  kind: 'ok' | 'fail' | 'interrupt' | 'info';
}

export interface SkillSlotView {
  skill: SkillDef;
  /** 剩余冷却，秒 */
  cooldownRemaining: number;
  /** 当前不可用的原因。Ok 表示可用 */
  blocker: CastFailure;
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
  ) {
    this.world = createWorld(obstacles);

    this.player = addEntity(
      this.world,
      createEntity(allocEntityId(this.world), mage, RED, playerSpawn, { name: '你（法师）' }),
    );

    // 三个假人，各自演示反制链的一环：
    //   战士 —— 用拳击打断**你的**读条，让你体会被打断和假读条博弈
    //   牧师 —— 反复读条治疗，给你练打断和学派锁定
    //   法师 —— 读条法术，同时也是唯一会对你造成伤害的假人
    //
    // ★ 战士刻意放在出生点正前方 2.6 米：拳击是 3 米近战技能，
    //   放远了它永远够不到你，7.5 的假读条博弈就演示不出来。
    //   想避开它（例如验证控制递减）只需往后走几米。
    this.spawnDummy(warrior, { x: playerSpawn.x, y: playerSpawn.y, z: playerSpawn.z - 2.6 }, '假人·战士');
    this.spawnDummy(priest, { x: playerSpawn.x + 6, y: playerSpawn.y, z: playerSpawn.z - 18 }, '假人·牧师');
    this.spawnDummy(mage, { x: playerSpawn.x, y: playerSpawn.y, z: playerSpawn.z - 26 }, '假人·法师');

    this.skills = PLAYER_SKILL_IDS.map((id) => {
      const s = getSkill(asSkillId(id));
      if (!s) throw new Error(`技能不存在：${id}`);
      return s;
    });

    this.grantDemoLoadout();

    this.info('试验场：Tab 选目标，1–8 释放技能。地面技能会先进入落点预览，左键确认。');
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
    const spare = mage.weapons.find((w) => !w.isDefault);
    if (spare) addWeapon(loadout, spare.id);
    this.player.weaponId = loadout.defaultWeaponId;
    this.player.armorId = loadout.defaultArmorId;
    this.loadouts.set(this.player.id, loadout);
  }

  private spawnDummy(cls: typeof mage, pos: Vec3, name: string): CombatEntity {
    const e = addEntity(
      this.world,
      createEntity(allocEntityId(this.world), cls, BLUE, pos, { name }),
    );
    // 假人不动，但资源给满，好让它能持续施法
    for (const [r, max] of e.maxResources) e.resources.set(r, max);
    this.dummyNextCast.set(e.id as number, 2);
    return e;
  }

  // ── 日志 ────────────────────────────────────────────────────

  private push(text: string, kind: CombatLogEntry['kind']): void {
    this.log.unshift({ time: this.world.time, text, kind });
    if (this.log.length > 40) this.log.pop();
  }
  private info(t: string) { this.push(t, 'info'); }

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
              ? this.push(`${sk.name} 无法释放：${FAIL_TEXT[reason]}`, 'fail')
              : this.push(`${c.name} 的 ${sk.name} 失败：${FAIL_TEXT[reason]}`, 'fail');
          },
          onInterrupted: (c, st, src, lock) => {
            this.onCastActivity?.('interrupted', c, getSkill(st.skillId));
            const skillName = getSkill(st.skillId)?.name ?? st.skillId;
            const lockText = lock
              ? `，${SCHOOL_TEXT[lock.school]}学派锁定 ${(lock.until - this.world.time).toFixed(1)}s`
              : '';
            this.push(`${c.name} 的 ${skillName} 被${INTERRUPT_TEXT[src] ?? src}中断${lockText}`, 'interrupt');
          },
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
      },
    );
    // ★ 请求已被 tick 消费，清空。没被消费的（例如实体已死）也一并丢弃 ——
    //   一个 tick 之前的施法意图不该在下一个 tick 复活
    this.pendingCasts.clear();

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
      if (e.id === this.player.id) this.grantDemoLoadout();
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
  /** 换装结束（true=完成，false=中断）*/
  onSwapResult?: (completed: boolean) => void;

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
        this.push(`${name(ev.targetId as never)} 获得 ${ev.auraId} ${ev.duration.toFixed(1)}s${drNote}`, 'info');
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
        this.push(`${name(ev.sourceId as never)} 驱散了 ${name(ev.targetId as never)} 的 ${ev.auraId}`, 'ok');
        break;
      case 'death':
        this.push(`${name(ev.targetId as never)} 被击杀`, 'interrupt');
        break;
      case 'displaced':
        this.push(`${name(ev.targetId as never)} 被${DISPLACE_TEXT[ev.kind] ?? ev.kind}`, 'info');
        break;
      default:
        break;
    }
  }

  /** 假人行为：牧师和法师反复读条，战士见缝插针打断你 */
  private updateDummies(): void {
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
          ? `，${SCHOOL_TEXT[lock.school]}学派锁定 ${(lock.until - this.world.time).toFixed(1)}s`
          : '';
        this.push(`${warriorDummy.name} 用${pummel.name}打断了你的 ${n}${lockText}`, 'interrupt');
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

  selectById(id: number): void {
    setHardTarget(this.world, this.player, id as never);
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
  castSlot(index: number, groundPoint?: Vec3): void {
    const skill = this.skills[index];
    if (!skill) return;

    // 地面技能：先做落点合法性检查（5.5：非法位置不能确认）
    if (needsGroundPlacement(skill)) {
      if (!groundPoint) {
        this.push(`${skill.name}：需要先选择落点`, 'fail');
        return;
      }
      const placement = this.resolveGround(skill, groundPoint);
      if (!placement.legal) {
        this.push(`${skill.name} 落点非法：${FAIL_TEXT[placement.reason]}`, 'fail');
        return;
      }
      this.requestCast(this.player, skill, { groundPoint: placement.center });
      return;
    }

    // 5.6：自身、自身中心、方向技能都不需要选择目标，按角色位置/面向结算
    if (usesNoTarget(skill)) {
      this.requestCast(this.player, skill);
      return;
    }

    const resolved = resolveSkillTarget(this.world, this.player, skill.targetFilter);
    const target = resolved.ok ? resolved.target : undefined;

    // 打断类技能要特殊处理：它不是「对目标施法」，而是「结算一次打断」
    const interruptEffect = skill.effects.find((e) => e.kind === 'interrupt');
    if (interruptEffect) {
      this.castInterruptSkill(skill);
      return;
    }

    if (!resolved.ok && skill.targetFilter === TargetFilter.Enemy) {
      this.push(`${skill.name}：${resolved.reason === 'noTarget' ? '需要目标' : '目标无效'}`, 'fail');
      return;
    }

    this.requestCast(this.player, skill, { targetId: target?.id });
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
    opts: { targetId?: EntityId; groundPoint?: Vec3 } = {},
  ): void {
    this.pendingCasts.set(caster.id, {
      skillId: skill.id,
      ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}),
      ...(opts.groundPoint ? { groundPoint: opts.groundPoint } : {}),
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
      this.push(`${skill.name} 无法释放：${FAIL_TEXT[pre.reason]}`, 'fail');
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
            ? `，${SCHOOL_TEXT[lock.school]}学派锁定 ${(lock.until - this.world.time).toFixed(1)}s`
            : '（物理动作，不产生学派锁定）';
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

  /** 技能栏视图：冷却与当前不可用原因 */
  skillSlots(): SkillSlotView[] {
    return this.skills.map((skill) => {
      let blocker: CastFailure;
      if (needsGroundPlacement(skill)) {
        // 地面技能不需要硬目标，落点在瞄准时才产生。
        // 这里传一个必然合法的落点（脚下），让 HUD 只反映冷却/资源/沉默这类状态 ——
        // 否则技能栏会一直显示「需要目标」，那是错的（15.2 要求提示准确）。
        blocker = validateForHud(this.world, this.player, skill, undefined, this.player.position);
      } else if (usesNoTarget(skill)) {
        blocker = validateForHud(this.world, this.player, skill, undefined);
      } else {
        const resolved = resolveSkillTarget(this.world, this.player, skill.targetFilter);
        blocker = validateForHud(
          this.world,
          this.player,
          skill,
          resolved.ok ? resolved.target : undefined,
        );
      }
      return {
        skill,
        cooldownRemaining: Math.max(0, (this.player.cooldowns.get(skill.id) ?? 0) - this.world.time),
        blocker,
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
   * 取「剩余量最大」的那一个 —— 同时有多个护盾时，玩家关心的是
   * 「还能扛多少」，而不是某一个具体法术的剩余。
   */
  shieldOf(id: EntityId): { remaining: number; initial: number } | undefined {
    let best: { remaining: number; initial: number } | undefined;
    for (const a of aurasOf(this.auras, id)) {
      if (a.absorbRemaining <= 0) continue;
      if (!best || a.absorbRemaining > best.remaining) {
        best = { remaining: a.absorbRemaining, initial: a.absorbInitial };
      }
    }
    return best;
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
 * HUD 用的校验。
 * ★ 与实际释放走的是**同一个** `validateCast` —— 15.2 要求图标明确提示
 * 「超出距离/缺少视线/朝向错误」，如果 HUD 自己算一遍，迟早会出现
 * 「图标是亮的但按下去失败」这种最让人困惑的 bug。
 */
const validateForHud = (
  world: World,
  caster: CombatEntity,
  skill: SkillDef,
  target: CombatEntity | undefined,
  groundPoint?: Vec3,
): CastFailure => validateCast({ world, caster, skill, target, groundPoint, phase: 'start' });

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
  schoolLocked: '学派锁定',
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
