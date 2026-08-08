/**
 * 用**服务器快照**实现 HUD 的数据契约（`hud/CombatView.ts`）。
 *
 * ★★ 这是 docs/13「判断二」那句话的最终兑现：
 *   「如果表现层能同时吃本地模拟和远端快照，说明它确实没有偷偷依赖模拟内部状态。」
 *   M10 验出来的答案是「它依赖了」（HUD 直读 `dir.world` / `dir.player`）。
 *   把依赖收敛成 `CombatView` 之后，这个类就是那句话的另一半 ——
 *   **同一个 `CombatHud` 现在两边都能喂。**
 *
 * ★★ **施法状态由事件流补齐，不在快照里**（见下方 `casts` 注册表）。
 *   `EntitySnapshot` 没有任何 casting 字段 —— 协议用 `CastStarted` /
 *   `CastResolved` / `CastInterrupted` 三条事件表达一次施法的生命周期。
 *   所以这里维护一张**由消息驱动**的注册表，HUD 与特效层照常拿到所有可见单位的读条。
 *   ⚠️ 这不新增任何可见性面：`CastStarted` 在服务器侧本就按可见性裁剪
 *   （`MatchLoop` 的 `referencedEntities` 会把施法者不可见的整条丢掉），
 *   看得见人才收得到他的读条。
 *
 * ⚠️ 有一件事快照仍**给不了**，这里如实降级而不是编造：
 *   · **技能栏的可用性**：`blocker` 需要 `validateCast`，而那要 `World`。
 *     这里只按冷却与资源做一个**保守**判断，宁可显示「可用」也不误报不可用
 *     —— 真正的门禁在服务器，客户端猜错只会多一次被拒绝的请求。
 */

import {
  CastKind,
  GCD,
  GEOMETRY,
  TargetFilter,
  distance,
  getClass,
  getSkill,
  inRange,
  isFacing,
  isMagicSchool,
  isWeaponSkill,
  needsGroundPlacement,
  usesNoTarget,
  type CastState,
  type EntityId,
  type HydratedEntitySnapshot as EntitySnapshot,
  type School,
  type SkillDef,
  type SkillId,
  type HydratedSnapshot as Snapshot,
  CastFailure,
} from '@wowpvp/shared';

import type {
  CombatView, HudLogEntry, HudSkillSlot, HudUnit,
} from '../hud/CombatView.js';

/**
 * 一次公共冷却的总时长，供 HUD 画扫层的分母。
 *
 * ★ 与 sim 起手时写进 `gcdUntil` 的**同一个表达式**（`casting.ts` 的
 *   `world.time + Math.max(GCD.MIN, GCD.BASE)`）。
 * ⚠️ 一旦 sim 引入急速修正，这个分母就会与真实 GCD 长度分叉 —— 届时
 *   要么随 `gcdUntil` 一起下发总时长，要么下发起始时刻。现在不预留字段：
 *   sim 里还没有急速，预留就是编一个不存在的机制。
 */
const GCD_TOTAL = Math.max(GCD.MIN, GCD.BASE);

const toMap = (r: Readonly<Record<string, number>>): ReadonlyMap<string, number> =>
  new Map(Object.entries(r));

/** `EntitySnapshot` → `HudUnit`。★ 只做形状转换，不补充任何快照里没有的信息 */
export const toHudUnit = (e: EntitySnapshot): HudUnit => ({
  id: e.id,
  name: e.name,
  team: e.team,
  classId: e.classId,
  position: e.position,
  // ★ 验收 #10：碰撞体统一取常量，模型大小不改变它 —— 所以这里不必也不该从快照拿
  height: GEOMETRY.HITBOX_HEIGHT,
  alive: e.alive,
  health: e.health,
  maxHealth: e.maxHealth,
  resources: toMap(e.resources),
  maxResources: toMap(e.maxResources),
  weaponId: e.equipment?.currentWeaponId,
  flags: e.flags,
});

/** `CastStarted` 消息里客户端真正拿得到的那几样 */
export interface CastStartedLike {
  casterId: EntityId;
  skillId: SkillId;
  duration: number;
  interruptible: boolean;
  school: School;
  castKind: CastKind;
}

/**
 * `CastStarted` 消息 → `CastState`。
 *
 * ★★ **`duration` 只覆盖读条段**：服务器发的是 `endsAt - startedAt`，
 *   而引导技能的 `channelEndsAt` 协议里**根本没有**（暴风雪 = 0.8 秒读条 +
 *   4 秒引导，消息里的 duration 是 0.8）。引导段长度由 `getSkill()` 从共享
 *   数据本地补回来 —— 技能定义两端同源，不需要为它加协议字段。
 *
 * ⚠️ `startedAt` 取的是**消息到达时刻**，比服务器真正的开始晚一个单程延迟。
 *   HUD 的施法条本来就是这个口径（M10 起如此），这里保持一致，不是 bug。
 *
 * ★ `facing` / `startPosition` / `requiresStationary` 填保守默认：
 *   它们是 sim 内部判「主动移动打断」用的，客户端只读不判，
 *   HUD 与特效层读的是 skillId/school/kind/startedAt/endsAt/interruptible。
 */
export const castStateFromStarted = (msg: CastStartedLike, now: number): CastState => {
  const endsAt = now + msg.duration;
  const channel = msg.castKind === CastKind.Channel
    ? getSkill(msg.skillId)?.cast.channelDuration
    : undefined;
  return {
    skillId: msg.skillId,
    kind: msg.castKind,
    startedAt: now,
    endsAt,
    ...(channel !== undefined ? { channelEndsAt: endsAt + channel } : {}),
    facing: 0,
    startPosition: { x: 0, y: 0, z: 0 },
    school: msg.school,
    interruptible: msg.interruptible,
    requiresStationary: false,
  };
};

/**
 * 一次施法在注册表里活多久之后被强制清除。
 *
 * ★★ 兜底不是保险起见，是**必需**：`CastResolved.casterId` 可空 ——
 *   施法者中途走进视野盲区时，结束消息里没有 id，`endCast` 收不到通知。
 *   没有这条兜底，那个人的读条条与蓄力法阵会一直亮到天荒地老。
 */
const CAST_GRACE = 0.5;

export class SnapshotCombatView implements CombatView {
  now = 0;
  private snapshot?: Snapshot;
  private units = new Map<number, HudUnit>();
  private selfId?: EntityId;

  /**
   * 正在施法的单位。★ 唯一维护者是 NetworkScene 的消息处理器 ——
   * 快照里没有施法字段，这张表就是协议事件流的折叠结果。
   *
   * ⚠️ 此前这里是一个叫 `playerCast` 的**公开字段，声明了却全仓库没有一处赋值**：
   *   自己的施法条、姓名板施法条、目标框施法条、`setCasting` 施法姿态
   *   四条通道从 M10 起一直是死的（本轮修复）。
   */
  private readonly casts = new Map<number, CastState>();

  readonly log: HudLogEntry[] = [];
  skills: readonly SkillDef[] = [];

  targetId?: EntityId;
  focusId?: EntityId;

  /** 点击姓名板时把选中意图发出去。★ 由 NetworkScene 注入，这里不认识连接 */
  onSelect?: (id: EntityId) => void;

  /**
   * 自己**本地预测**的角色朝向，供 6.5 的朝向提示。由 NetworkScene 注入。
   * ★ 与 `onSelect` / `skillBarFor` 同一条边界：视图层不认识场景，
   *   场景把它手上有而快照给不了的那一个数喂进来。不注入则回落到快照 yaw。
   */
  selfYaw?: () => number;

  /**
   * P3c 技能栏自定义：由 NetworkScene 注入「职业 → 该显示哪 9 格」。
   * 不注入 → 回落到全部技能（旧行为）。★ 这里不读 localStorage ——
   * 视图层不认识存储，与 `onSelect` 由外部注入是同一条边界。
   */
  skillBarFor?: (classId: string) => readonly SkillDef[];

  ingest(snapshot: Snapshot, serverTime: number): void {
    this.snapshot = snapshot;
    this.now = serverTime;
    this.selfId = snapshot.you;
    this.units = new Map(snapshot.entities.map((e) => [e.id as number, toHudUnit(e)]));

    // 自己的职业决定技能栏
    const me = snapshot.entities.find((e) => e.id === snapshot.you);
    if (me && this.skills.length === 0) {
      this.skills = this.skillBarFor?.(me.classId as string)
        ?? getClass(me.classId)?.skills ?? [];
    }
  }

  /** P3c：设置面板改完技能栏立即生效（下一帧 HUD 重渲染自然拿到新栏）*/
  setSkillBar(defs: readonly SkillDef[]): void {
    this.skills = defs;
  }

  push(text: string, kind: HudLogEntry['kind']): void {
    this.log.unshift({ time: this.now, text, kind });
    if (this.log.length > 40) this.log.pop();
  }

  get player(): HudUnit {
    const u = this.selfId !== undefined ? this.units.get(this.selfId as number) : undefined;
    // 还没收到第一份快照时给一个空壳，避免 HUD 在开局前崩
    return u ?? EMPTY_UNIT;
  }

  get target(): HudUnit | undefined {
    return this.targetId === undefined ? undefined : this.units.get(this.targetId as number);
  }

  get focus(): HudUnit | undefined {
    return this.focusId === undefined ? undefined : this.units.get(this.focusId as number);
  }

  visibleUnits(): HudUnit[] {
    return [...this.units.values()].filter((u) => u.id !== this.selfId);
  }

  // ── 施法注册表（由 NetworkScene 的消息处理器驱动）─────────────

  /** 自己的施法状态。★ 现在是注册表的一个视图，不再是一个没人写的字段 */
  get playerCast(): CastState | undefined {
    return this.selfId === undefined ? undefined : this.casts.get(this.selfId as number);
  }

  castOf(unit: HudUnit): CastState | undefined {
    return this.casts.get(unit.id as number);
  }

  /** 按 id 取（特效层与打断处理要用，它们手上没有 HudUnit）*/
  castOfId(id: EntityId): CastState | undefined {
    return this.casts.get(id as number);
  }

  beginCast(casterId: EntityId, state: CastState): void {
    this.casts.set(casterId as number, state);
  }

  endCast(casterId: EntityId): void {
    this.casts.delete(casterId as number);
  }

  /**
   * 每帧兜底清理：**超时**与**实体离场**。
   * ★ 两条都不是理论风险 —— 前者是 `CastResolved.casterId` 被抹掉
   *   （见 `CAST_GRACE`），后者是施法者死亡/离线时快照里直接没了这个人。
   */
  pruneCasts(now: number, present: (id: number) => boolean): void {
    for (const [id, st] of this.casts) {
      const until = (st.channelEndsAt ?? st.endsAt) + CAST_GRACE;
      if (now > until || !present(id)) this.casts.delete(id);
    }
  }

  /** 供表现层遍历。★ 只读，调用方不该改注册表 */
  activeCasts(): readonly (readonly [EntityId, CastState])[] {
    return [...this.casts].map(([id, st]) => [id as EntityId, st] as const);
  }

  distanceTo(unit: HudUnit): number {
    return distance(this.player.position, unit.position);
  }

  /**
   * 技能栏一格的可用性。
   *
   * ★★ P10 之前这里**只看冷却与资源** —— 而「超出距离」是联网对局里最常见的
   *   不可用原因，玩家看到一个亮着的图标按下去却被服务器拒绝。距离其实一直算得出来
   *   （目标位置就在快照里，`distanceTo` 就在上面几行），缺的只是这一段判定。
   *
   * ★ 判据全部走 **shared 的同一批函数**（`inRange` / `isFacing` /
   *   `isMagicSchool` / `isWeaponSkill`），不在客户端另写一遍 6.1/6.5 的几何 ——
   *   另写一遍必然漂移，而漂移的方向不可控（要么误报不可用，要么放行到被拒）。
   *
   * ⚠️ 仍然**判不了**三件事，如实不判而不是猜：
   *   · **视线**（7.4）：要地图障碍物几何 + 双方碰撞体，客户端手里的地图是
   *     渲染用的 `MapDef`，与服务器 world.obstacles 同源，但快照里没有目标的
   *     碰撞体半径口径，且潜行/掩体判定仍在服务器 —— 留给服务器。
   *   · **学派锁定**（7.2）：`schoolLocks` 不在快照里（协议没这个字段）。
   *   · **武器方案**（附录A#4 `availableSkills`）：同样不在快照里。
   *   这三条继续沿用「宁可显示可用」的保守口径：猜错只多一次被拒的请求，
   *   反过来会让玩家以为技能坏了。
   *
   * ★ `blocker`（单值）按 **7.4 门禁顺序**给 —— 与试验场的 `validateForHud`
   *   逐条同序，同一个 HUD 在两个场景里对同一处境给出同一句话。
   *   `blockers`（合同 C1，全量）按 `describeCastBlockers` 的**显示顺序**给
   *   （位置 → 资源 → 冷却 → 状态）：那个顺序服务的是「我现在最该先解决什么」。
   */
  skillSlots(): HudSkillSlot[] {
    const meSnap = this.snapshot?.entities.find((e) => e.id === this.selfId);
    const cds = meSnap?.cooldowns ?? {};
    // 合同 C1：GCD 现在在快照里（visibility.ts 的 `gcdUntil`，只发给自己）
    const gcdRemaining = Math.max(0, (meSnap?.gcdUntil ?? 0) - this.now);
    return this.skills.map((skill) => {
      const remaining = Math.max(0, (cds[skill.id as string] ?? 0) - this.now);
      const onGcd = skill.triggersGcd && gcdRemaining > 0;
      const blockers = this.displayBlockers(skill, remaining, onGcd);
      return {
        skill,
        cooldownRemaining: remaining,
        blocker: this.gateBlocker(skill, remaining, onGcd),
        // ★ 空数组不填：可选字段的含义是「有没有话要说」，填个空的等于说了句废话
        ...(blockers.length > 0 ? { blockers } : {}),
        // ★ 不触发 GCD 的技能不填：填了 HUD 会给它画一圈它其实不受的限制
        ...(onGcd ? { gcdRemaining, gcdTotal: GCD_TOTAL } : {}),
      };
    });
  }

  /**
   * 7.4 门禁顺序的第一个阻碍项（与 `validateCast(phase:'start')` 同序）。
   * ★ 判不了的三项（视线/学派锁定/武器方案）在这条链上直接缺席 —— 见 `skillSlots`。
   */
  private gateBlocker(skill: SkillDef, cdRemaining: number, onGcd: boolean): CastFailure {
    const me = this.player;
    if (!me.alive) return CastFailure.Dead;
    if (me.flags.stunned && !skill.usableWhileStunned) return CastFailure.Controlled;
    if (me.flags.silenced && isMagicSchool(skill.school)) return CastFailure.Silenced;
    if (me.flags.disarmed && isWeaponSkill(skill)) return CastFailure.Disarmed;
    if (skill.forbiddenWhileCarryingFlag && me.flags.carryingFlag) return CastFailure.CarryingFlag;
    if (cdRemaining > 0) return CastFailure.OnCooldown;
    if (onGcd) return CastFailure.OnGlobalCooldown;
    if (!this.hasResourceFor(skill)) return CastFailure.NotEnoughResource;
    return this.positionBlocker(skill) ?? CastFailure.Ok;
  }

  /** 合同 C1 的 `blockers`：全部**能判**的阻碍项，按显示顺序（位置最靠前）*/
  private displayBlockers(skill: SkillDef, cdRemaining: number, onGcd: boolean): CastFailure[] {
    const me = this.player;
    if (!me.alive) return [CastFailure.Dead];
    const out: CastFailure[] = [];
    const pos = this.positionBlocker(skill);
    if (pos !== undefined) out.push(pos);
    if (!this.hasResourceFor(skill)) out.push(CastFailure.NotEnoughResource);
    if (cdRemaining > 0) out.push(CastFailure.OnCooldown);
    if (onGcd) out.push(CastFailure.OnGlobalCooldown);
    if (me.flags.stunned && !skill.usableWhileStunned) out.push(CastFailure.Controlled);
    if (me.flags.silenced && isMagicSchool(skill.school)) out.push(CastFailure.Silenced);
    if (me.flags.disarmed && isWeaponSkill(skill)) out.push(CastFailure.Disarmed);
    if (skill.forbiddenWhileCarryingFlag && me.flags.carryingFlag) out.push(CastFailure.CarryingFlag);
    return out;
  }

  private hasResourceFor(skill: SkillDef): boolean {
    const cost = skill.cost;
    return !cost || (this.player.resources.get(cost.resource) ?? 0) >= cost.amount;
  }

  /**
   * 目标与距离/朝向类的阻碍项。可释放返回 undefined。
   *
   * ★ 地面技能与无目标技能一律不判：落点要等瞄准时才产生，
   *   在技能栏上判会让它们长期显示「需要目标」（试验场同口径：
   *   `CombatDirector.skillSlots` 给地面技能传脚下这个必然合法的落点）。
   */
  private positionBlocker(skill: SkillDef): CastFailure | undefined {
    if (needsGroundPlacement(skill) || usesNoTarget(skill)) return undefined;
    const target = this.target;
    if (!target) return CastFailure.NoTarget;
    const me = this.player;
    const hostile = target.team !== me.team;
    const wrongSide =
      (skill.targetFilter === TargetFilter.Enemy && !hostile) ||
      (skill.targetFilter === TargetFilter.Ally && hostile);
    if (!target.alive || wrongSide) return CastFailure.InvalidTarget;

    // 6.1/6.2：近战走边缘、远程走胸口 —— 由 shared 的 inRange 内部按 maxRange 区分
    if (!inRange(circleOf(me), circleOf(target), skill.range.max, skill.range.min)) {
      // 冲锋这类有最小距离的技能贴脸时是 TooClose，不是 OutOfRange（与 sim 同一分支）
      const withinMin = skill.range.min > 0
        && inRange(circleOf(me), circleOf(target), skill.range.min, 0);
      return withinMin ? CastFailure.TooClose : CastFailure.OutOfRange;
    }
    /**
     * 6.5 朝向。★ 用**本地预测**的角色 yaw（由场景注入）而不是快照里的 yaw：
     *   快照的 yaw 晚一个单程延迟，转身瞬间技能栏会红一下再变回来。
     *   服务器判的是它自己那一份，所以这里只是提示、不是门禁。
     */
    if (skill.requiresFacing) {
      const yaw = this.selfYaw?.() ?? this.snapshotYaw();
      if (!isFacing(me.position, yaw, target.position)) return CastFailure.WrongFacing;
    }
    return undefined;
  }

  /** 快照里自己的朝向。没有注入本地预测 yaw 时的回落 */
  private snapshotYaw(): number {
    return this.snapshot?.entities.find((e) => e.id === this.selfId)?.yaw ?? 0;
  }

  selectById(id: number): void {
    this.onSelect?.(id as EntityId);
  }
}

/**
 * `HudUnit` → `HitCircle`（shared 的距离判定输入）。
 * ★ 半径与高度都取常量，理由同 `toHudUnit` 的 height：碰撞体统一取常量，
 *   模型大小不改变它（验收 #10），所以快照里本来就没有这两个数。
 */
const circleOf = (u: HudUnit): { position: HudUnit['position']; radius: number; height: number } => ({
  position: u.position,
  radius: GEOMETRY.HITBOX_RADIUS,
  height: u.height,
});

/** 开局前的占位。★ 全零而不是 undefined，让 HUD 的渲染路径不必到处判空 */
const EMPTY_UNIT: HudUnit = {
  id: 0 as EntityId,
  name: '',
  team: 0 as HudUnit['team'],
  classId: '' as HudUnit['classId'],
  position: { x: 0, y: 0, z: 0 },
  height: GEOMETRY.HITBOX_HEIGHT,
  alive: true,
  health: 0,
  maxHealth: 1,
  resources: new Map(),
  maxResources: new Map(),
  weaponId: undefined,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
};
