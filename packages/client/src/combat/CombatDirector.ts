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
} from '@wowpvp/shared';

const RED = asTeamId(0);
const BLUE = asTeamId(1);

/**
 * 玩家技能栏。选法师是因为它一个职业就覆盖了 5.4 的多数瞄准类型 ——
 * 直接目标（寒冰箭）、自身中心（冰霜新星）、地面目标（暴风雪、陨石）、
 * 方向直线（闪现术）、纯自身（寒冰屏障），外加读条/瞬发/引导三种施放方式。
 *
 * 缺的第六类「碰撞投射物」在法师技能里没有对应项（猎人的穿透重弩箭才是），
 * 由 projectile.test.ts 严格覆盖，见 docs/PROGRESS.md 的 M3 说明。
 */
const PLAYER_SKILL_IDS = [
  'mage.frostbolt',
  'mage.fire_blast',
  'mage.counterspell',
  'mage.frost_nova',
  'mage.blizzard',
  'mage.meteor',
  'mage.blink',
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
    //   牧师 —— 反复读条治疗，给你练打断和学派锁定
    //   战士 —— 会用拳击打断**你的**读条，让你体会被打断和假读条博弈
    //   法师 —— 读条法术，可以被变形术控住
    this.spawnDummy(priest, { x: playerSpawn.x + 6, y: playerSpawn.y, z: playerSpawn.z - 18 }, '假人·牧师');
    this.spawnDummy(warrior, { x: playerSpawn.x - 6, y: playerSpawn.y, z: playerSpawn.z - 14 }, '假人·战士');
    this.spawnDummy(mage, { x: playerSpawn.x, y: playerSpawn.y, z: playerSpawn.z - 26 }, '假人·法师');

    this.skills = PLAYER_SKILL_IDS.map((id) => {
      const s = getSkill(asSkillId(id));
      if (!s) throw new Error(`技能不存在：${id}`);
      return s;
    });

    this.info('试验场：Tab 选目标，1–8 释放技能。地面技能会先进入落点预览，左键确认。');
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

    // ★ casting 必须在 movement 之后 —— 7.3「主动移动停止原地施放的读条」，
    //   先算完移动才知道这一 tick 有没有位移（docs/02 §3 的 tick 顺序）
    tickCasting(this.world, this.store, {
      getSkill,
      events: {
        onCompleted: (c, s) => this.push(`${c.name} 完成 ${s.name}`, 'ok'),
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

    this.updateDummies();
    pruneInvalidTargets(this.world, this.player);
  }

  /** 假人行为：牧师和法师反复读条，战士见缝插针打断你 */
  private updateDummies(): void {
    for (const e of listEntities(this.world)) {
      if (e.id === this.player.id || !e.alive) continue;
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
          onCompleted: () =>
            this.push(`${skill.name} 落地，范围内 ${affected.length} 个目标`, 'ok'),
          onFailed: (_c, s, reason) => this.push(`${s.name} 失败：${FAIL_TEXT[reason]}`, 'fail'),
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
          onCompleted: () => this.push(`${skill.name} 命中 ${affected.length} 个目标`, 'ok'),
          onFailed: (_c, s, reason) => this.push(`${s.name} 失败：${FAIL_TEXT[reason]}`, 'fail'),
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
        onCompleted: () => this.push(`${skill.name} 命中 ${target?.name ?? '自己'}`, 'ok'),
        onFailed: (_c, s, reason) => this.push(`${s.name} 失败：${FAIL_TEXT[reason]}`, 'fail'),
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
