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
  pruneInvalidTargets,
  resolveSkillTarget,
  setHardTarget,
  tabTarget,
  tickCasting,
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
  tickSwaps,
  createPickupStore,
  settleDeaths,
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
  resolveEffects,
  tickAuras,
  tickGround,
  tickProjectiles,
  type CombatEvent,
  type EffectDef,
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
   * 本 tick 产生的全部战斗事件。
   *
   * ★ M9 起需要它：死亡结算（`settleDeaths`）和战后统计都是这个事件流的
   *   **消费者**，而 `resolve()` 每次调用只拿到自己那一批。
   *   在 tick 开头清空、在 tick 末尾统一消费。
   */
  private tickEvents: CombatEvent[] = [];

  /** M4：效果系统的状态容器 */
  readonly auras = createAuraStore();
  readonly dr = createDrStore();
  readonly projectiles = createProjectileStore();
  readonly ground = createGroundStore();

  /** 假人下一次开始施法的时间 */
  private dummyNextCast = new Map<number, number>();
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

    this.world.time += dt;
    // 本 tick 的事件流从空开始。死亡结算在 tick 末尾消费它
    this.tickEvents = [];

    // ★ casting 必须在 movement 之后 —— 7.3「主动移动停止原地施放的读条」，
    //   先算完移动才知道这一 tick 有没有位移（docs/02 §3 的 tick 顺序）
    tickCasting(this.world, this.store, {
      getSkill,
      events: {
        // ★ 统一的完成入口。读条/引导技能只会走到这里，
        //   传给 beginCast 的回调对它们**不生效**（见 casting.ts 的 CastEvents 注释）
        onCompleted: (c, s, st) => this.onCastCompleted(c, s, st),
        onFailed: (c, s, reason) => this.push(`${c.name} 的 ${s.name} 失败：${FAIL_TEXT[reason]}`, 'fail'),
        onInterrupted: (c, st, src, lock) => {
          const skillName = getSkill(st.skillId)?.name ?? st.skillId;
          const lockText = lock
            ? `，${SCHOOL_TEXT[lock.school]}学派锁定 ${(lock.until - this.world.time).toFixed(1)}s`
            : '';
          this.push(`${c.name} 的 ${skillName} 被${INTERRUPT_TEXT[src] ?? src}中断${lockText}`, 'interrupt');
        },
      },
    });

    // ── M4：效果系统的每 tick 推进 ──────────────────────────
    // 顺序有讲究（docs/02 §3）：光环跳 → 投射物 → 地面区域 → 派生状态标志。
    // 状态标志必须**最后**派生，否则本 tick 新加的控制要等下一 tick 才生效。
    for (const t of tickAuras(this.auras, this.world.time).ticks) {
      const src = getEntity(this.world, t.sourceId);
      const tgt = getEntity(this.world, t.targetId);
      if (src && tgt) this.resolve(src, t.aura.def.id, t.effects, [tgt]);
    }
    for (const hit of tickProjectiles(this.world, this.projectiles, dt)) {
      const src = getEntity(this.world, hit.projectile.sourceId);
      if (src) this.resolve(src, String(hit.projectile.skillId), hit.effects, hit.targets);
    }
    for (const g of tickGround(this.world, this.ground)) {
      const src = getEntity(this.world, g.sourceId);
      if (src) this.resolve(src, g.skillId, g.effects, g.targets);
    }
    for (const e of listEntities(this.world)) {
      e.flags = deriveStatusFlags(this.auras, e);
    }

    // 15.3：换装有时间与中断窗口（10.7）。事件用于 HUD 的中断原因提示
    for (const ev of tickSwaps(this.world.entities, this.swaps, this.world.time)) {
      const who = getEntity(this.world, ev.entityId);
      if (ev.result === 'completed') this.push(`${who?.name ?? ''} 完成换装`, 'ok');
      else this.push(`${who?.name ?? ''} 换装中断：${ev.result}`, 'fail');
    }

    /**
     * ★ M9：死亡结算。**必须排在 `tickSwaps()` 之后** ——
     *   上面那个循环靠「实体已死」发出 `result: 'death'` 的换装中断事件
     *   （17.3 的「换装瞬间死亡」），而 `settleDeaths()` 会清掉进行中的换装。
     *   放前面会把那条事件吃掉，于是 HUD 的中断提示静默消失。
     *
     *   这次接线补的是 10.10：临时装备随死亡失效。规则从 M6 起就写好了
     *   （`loadout.onDeath()`），但**在此之前从来没有人调用它**。
     */
    for (const settled of settleDeaths(
      { world: this.world, loadouts: this.loadouts, swaps: this.swaps, pickups: this.pickups },
      this.tickEvents,
    )) {
      const who = getEntity(this.world, settled.entityId);
      this.push(`${who?.name ?? ''} 的临时装备已失效（10.10）`, 'info');
    }

    this.updateDummies();
    this.reviveInTestbed();
    pruneInvalidTargets(this.world, this.player);
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
   * ★ 技能完成的**唯一**入口。7.4 步骤 5「成功释放才消耗资源、结算效果」。
   *
   * 无论瞬发还是读条，最终都汇到这里 —— 之前只接了 beginCast 的回调，
   * 结果所有读条技能都「完成」了却不产生任何效果，日志上还看不出异常。
   */
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

  private onCastCompleted(caster: CombatEntity, skill: SkillDef, state: CastState): void {
    // ★ 必须在效果结算前 —— 先掉旗，再播放技能表现（12.3）
    if (skill.dropsFlagOnUse) this.onBeforeSkillEffects?.(caster, skill);

    const groundPoint = state.groundPoint;
    let targets: CombatEntity[];

    if (needsGroundPlacement(skill)) {
      targets = groundPoint
        ? collectShapeTargets(this.world, caster, {
            origin: groundPoint, yaw: caster.yaw, shape: skill.shape, filter: skill.targetFilter,
          })
        : [];
      this.push(`${skill.name} 落地，范围内 ${targets.length} 个目标`, 'ok');
    } else if (usesNoTarget(skill)) {
      targets = collectShapeTargets(this.world, caster, {
        origin: shapeOrigin(caster, skill), yaw: caster.yaw,
        shape: skill.shape, filter: skill.targetFilter,
      });
      this.push(`${skill.name} 命中 ${targets.length} 个目标`, 'ok');
    } else {
      // ★ 必须用 **CastState 里记下的目标**，不能回头去读 targets.hard。
      //   施法开始时锁定的是谁，完成时就结算给谁 —— 这也符合 7.4 的语义。
      //   之前从 targets.hard 重新取，导致没有硬目标的假人把技能打到了自己身上。
      const locked = getEntity(this.world, state.targetId);
      targets = locked ? [locked] : [];
      if (targets.length === 0) return; // 目标已离场，7.4 步骤 6：不产生效果
      this.push(`${caster.name} 完成 ${skill.name} → ${targets[0]!.name}`, 'ok');
    }
    this.resolve(caster, skill.id, skill.effects, targets, groundPoint);
  }

  /**
   * 结算一组效果并把事件转成战斗日志。
   * 所有效果结算的唯一入口 —— 日志格式因此只有一处需要维护。
   */
  private resolve(
    source: CombatEntity,
    skillId: string,
    effects: readonly EffectDef[],
    targets: readonly CombatEntity[],
    groundPoint?: Vec3,
  ): void {
    const events = resolveEffects(
      {
        world: this.world, auras: this.auras, dr: this.dr,
        projectiles: this.projectiles, ground: this.ground,
        castingStore: this.store,
        source, skillId, groundPoint,
      },
      effects, targets,
    );
    for (const ev of events) this.logEvent(ev);
    this.tickEvents.push(...events);
  }

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
      beginCast(this.world, this.store, e, s, {
        target: (e.classId as string) === 'priest' ? e : this.player,
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
    const out = applyInterrupt(this.world, this.store, this.player, interruptLockSeconds(pummel) ?? 3, {
      onInterrupted: (_c, st, _src, lock) => {
        const n = getSkill(st.skillId)?.name ?? st.skillId;
        const lockText = lock
          ? `，${SCHOOL_TEXT[lock.school]}学派锁定 ${(lock.until - this.world.time).toFixed(1)}s`
          : '';
        this.push(`${warriorDummy.name} 用拳击打断了你的 ${n}${lockText}`, 'interrupt');
      },
    });

    // ★ 7.2：落空也进冷却。这一句刻意放在 if 外面，无法被分支绕过
    warriorDummy.cooldowns.set(pummel.id, this.world.time + pummel.cooldown);
    if (!out.interrupted) {
      this.push(
        `${warriorDummy.name} 的拳击落空（你骗到了！），仍进入 ${pummel.cooldown}s 冷却`,
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
      const affected = this.previewShapeTargets(skill, placement.center);
      const r = beginCast(this.world, this.store, this.player, skill, {
        groundPoint: placement.center,
        events: {
          onStarted: () => this.push(`开始施放 ${skill.name}（落点已锁定）`, 'info'),
          onCompleted: (c, s, st) => this.onCastCompleted(c, s, st),
          // 注意：不在 onFailed 里记日志。beginCast 失败时会**同时**触发回调并返回
          // !ok，两处都记会让玩家看到重复的红字。统一在返回值处记录。
        },
      });
      if (!r.ok) this.push(`${skill.name} 无法释放：${FAIL_TEXT[r.reason]}`, 'fail');
      return;
    }

    // 5.6：自身、自身中心、方向技能都不需要选择目标，按角色位置/面向结算
    if (usesNoTarget(skill)) {
      const affected = this.previewShapeTargets(skill);
      const r = beginCast(this.world, this.store, this.player, skill, {
        events: {
          onCompleted: (c, s, st) => this.onCastCompleted(c, s, st),
        },
      });
      if (!r.ok) this.push(`${skill.name} 无法释放：${FAIL_TEXT[r.reason]}`, 'fail');
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

    const r = beginCast(this.world, this.store, this.player, skill, {
      target,
      events: {
        onStarted: (_c, st) => {
          const kindText = st.kind === CastKind.Channel ? '引导' : '读条';
          this.push(`开始${kindText} ${skill.name}（${skill.cast.time.toFixed(1)}s）`, 'info');
        },
        onCompleted: (c, s, st) => this.onCastCompleted(c, s, st),
      },
    });
    if (!r.ok) this.push(`${skill.name} 无法释放：${FAIL_TEXT[r.reason]}`, 'fail');
  }

  /**
   * 专用打断的释放流程。
   * ★ 7.2：无论是否命中，技能都进入冷却 —— 所以冷却写在结算之外。
   */
  private castInterruptSkill(skill: SkillDef): void {
    const target = getEntity(this.world, this.player.targets.hard);

    // 先走一遍常规校验（距离、视线、学派锁定、沉默…）
    const pre = beginCast(this.world, this.store, this.player, { ...skill, effects: [] }, { target });
    if (!pre.ok) {
      this.push(`${skill.name} 无法释放：${FAIL_TEXT[pre.reason]}`, 'fail');
      return;
    }

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
  carryingFlag: '持旗时禁用',
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
