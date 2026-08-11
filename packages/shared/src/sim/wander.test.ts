/**
 * 8.2 化形游走的 tick 级测试（用户口径 2026-08-11：「被变形宠物了也应该是在
 * 一个小范围内走来走去的」）。
 *
 * ★★ **行为断言一律从 `tickWorld` 驱动，不直接调 `driveWander`。**
 *   这个功能的全部风险不在散列数学，在**接线**：判据挂在哪个 tick 步骤、
 *   锁怎么绕、打断之后谁来拔锚 —— 直接调纯函数的话，`tick.ts` 里那几行
 *   全删掉这些断言照样绿（本仓库点过五次名的「规则写对了没人调」）。
 * ★ 只有两条**例外**：散列键的两个维度（实体 id / 中招点）走纯函数直接问 ——
 *   那是「同一个变量真的参与了」的独立性质，tick 级看不清（一条 tick 级
 *   轨迹里两个维度总是同时变）。
 */

import { describe, expect, it } from 'vitest';
import { getSkill, mage, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { vec3 } from '../math/vec3.js';
import { MOVE } from '../constants/combat.js';
import { ArenaPreset, DispelType, School } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type EntityId } from '../types/ids.js';
import { applyAura, createAuraStore, type AuraStore } from './aura.js';
import { createArsenalStore, createPickupStore, type ArsenalStore, type PickupStore } from './arsenal.js';
import { createCastingStore, type CastingStore } from './casting.js';
import { createDrStore, type DrStore } from './dr.js';
import { createEntity, type CombatEntity } from './entity.js';
import { createGroundStore, type GroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore, type LoadoutStore, type SwapStore } from './loadout.js';
import { createMovementState, cylinderOverlapsAabb, type MovementInput, type MovementState } from './movement.js';
import { createProjectileStore, type ProjectileStore } from './projectile.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import { resolveEffects } from './effects/index.js';
import { driveWander, WANDER } from './wander.js';
import type { Aabb } from '../math/geometry.js';
import type { EffectDef } from '../data/schema.js';

const DT = 0.05;
const ground: Aabb = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

/** 一整套 tick 依赖 + 两个人。★ 每条测试一份，互不串状态 */
interface Fixture {
  world: World;
  auras: AuraStore;
  movement: Map<EntityId, MovementState>;
  inputs: Map<EntityId, MovementInput>;
  caster: CombatEntity;
  victim: CombatEntity;
  deps: TickDeps;
  /** 推进 n 个 tick */
  run: (n: number, dt?: number) => void;
  /** 在 victim 身上结算一组效果（走生产路径，不手搓光环）*/
  cast: (effects: readonly EffectDef[]) => void;
}

/**
 * ★ 施法者摆在 20 米外：软推开（13.5）在 0.9 米内才发力，
 *   放近了游走轨迹里会混进一份别人的推力，那是另一条规则的账。
 */
const makeFixture = (
  obstacles: readonly Aabb[] = [ground],
  /** ★ 中招者的起点。默认原点 —— 不传的用例与加这个参数之前逐位相同 */
  start: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): Fixture => {
  const world = createWorld(obstacles);
  const auras = createAuraStore();
  const dr: DrStore = createDrStore();
  const groundStore: GroundStore = createGroundStore();
  const projectiles: ProjectileStore = createProjectileStore();
  const casting: CastingStore = createCastingStore();
  const loadouts: LoadoutStore = createLoadoutStore();
  const swaps: SwapStore = createSwapStore();
  const pickups: PickupStore = createPickupStore();
  // 经典竞技场 = 不刷临时武装（验收 #28）—— 地上凭空出现的箱子会挤进软推开
  const arsenal: ArsenalStore = createArsenalStore(ArenaPreset.Classic);
  const movement = new Map<EntityId, MovementState>();
  const inputs = new Map<EntityId, MovementInput>();

  const caster = addEntity(
    world, createEntity(allocEntityId(world), mage, TEAM_RED, vec3(start.x, start.y, start.z - 20)),
  );
  const victim = addEntity(
    world, createEntity(allocEntityId(world), warrior, TEAM_BLUE, vec3(start.x, start.y, start.z)),
  );
  loadouts.set(caster.id, createLoadout(caster.classId));
  loadouts.set(victim.id, createLoadout(victim.classId));
  movement.set(victim.id, createMovementState(vec3(start.x, start.y, start.z), 0));

  const deps: TickDeps = {
    world, auras, dr, ground: groundStore, projectiles, casting,
    loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
  };

  return {
    world, auras, movement, inputs, caster, victim, deps,
    run: (n, dt = DT) => { for (let i = 0; i < n; i++) tickWorld(deps, dt); },
    cast: (effects) => {
      resolveEffects(
        {
          world, auras, dr, projectiles, ground: groundStore, source: caster, skillId: 'test',
          // ★ 与 `tick.ts` 的 `resolve()` 同款：位移效果要写 MovementState
          movement,
        },
        effects, [victim],
      );
    },
  };
};

/** 化形术那一发（8.2 迷惑 + 受伤打破），走 `applyControl` 的生产路径 */
const POLYMORPH = (duration = 30, breakDamage = 100): EffectDef[] =>
  [{ kind: 'incapacitate', duration, breakDamage }];

const posOf = (e: CombatEntity): { x: number; z: number } => ({ x: e.position.x, z: e.position.z });
const distXZ = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

/** 满油门输入：向 +X 直冲并按住跳 */
const FULL_THROTTLE: MovementInput = { forward: 1, strafe: 0, jump: true, yaw: -Math.PI / 2 };

// ════════════════════════════════════════════════════════════════

describe('8.2 化形游走：走起来', () => {
  it('★ 被化形之后真的在走（位置变了，不是模型在原地晃）', () => {
    const f = makeFixture();
    const anchor = posOf(f.victim);
    f.cast(POLYMORPH());
    f.run(120); // 6 秒 —— 跨过好几段，抵消掉「这一段刚好在发呆」

    expect(
      distXZ(posOf(f.victim), anchor),
      '被化形的目标一步都没挪 —— 游走可能没接进 tickWorld 第 2 步',
    ).toBeGreaterThan(0.5);
  });

  it('★ 走的是低档速度（约 40% 基速），不是满速逃跑', () => {
    const f = makeFixture();
    f.cast(POLYMORPH());

    let peak = 0;
    for (let i = 0; i < 120; i++) {
      tickWorld(f.deps, DT);
      peak = Math.max(peak, f.movement.get(f.victim.id)!.lastHorizontalDistance);
    }

    const cap = MOVE.BASE_SPEED * WANDER.SPEED_FACTOR * DT;
    expect(peak, '单 tick 位移超过 40% 基速 —— SPEED_FACTOR 没进积分').toBeLessThanOrEqual(cap * 1.001);
    expect(peak, '全程没有一 tick 真的在走').toBeGreaterThan(cap * 0.5);
  });

  it('★★ 确定性：同一份输入跑两遍，逐位相同的轨迹（无 Math.random / 不碰实体随机流）', () => {
    const trace = (): number[] => {
      const f = makeFixture();
      f.cast(POLYMORPH());
      const out: number[] = [];
      for (let i = 0; i < 200; i++) {
        tickWorld(f.deps, DT);
        out.push(f.victim.position.x, f.victim.position.z);
      }
      return out;
    };

    const a = trace();
    const b = trace();
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]); // 逐位，不是 toBeCloseTo
  });

  /**
   * 散列的键是**实体 id + 中招点**（`keyOf`）。这条走纯函数直接问 id 那一维 ——
   * 下面那条 tick 级的用例里两个人的锚点也不同，光靠它证不到「id 真的参与了」。
   */
  it('散列吃 entityId：同一个点上中招的两个人，转向也不同', () => {
    const at = vec3(3, 0, -4);
    const yawsOf = (id: number): number[] => {
      const out: number[] = [];
      let w = driveWander(undefined, id as EntityId, at, 0, 0);
      for (let t = 0.05; t < 6; t += 0.05) {
        w = driveWander(w.wander, id as EntityId, at, w.input.yaw, t);
        out.push(w.input.yaw);
      }
      return out;
    };
    expect(yawsOf(7)).not.toEqual(yawsOf(8));
  });

  it('散列吃中招点：同一个人在不同地方被变形，不会走出同一条相对轨迹', () => {
    const relYaws = (anchor: ReturnType<typeof vec3>): number[] => {
      const out: number[] = [];
      let w = driveWander(undefined, 7 as EntityId, anchor, 0, 0);
      for (let t = 0.05; t < 6; t += 0.05) {
        w = driveWander(w.wander, 7 as EntityId, anchor, w.input.yaw, t);
        out.push(w.input.yaw);
      }
      return out;
    };
    // 同一个人、同样的时间线，只换中招点 —— 轨迹必须变
    // （否则「被变形就往那个方向拐」会变成能背下来的定式）
    expect(relYaws(vec3(0, 0, 0))).not.toEqual(relYaws(vec3(12, 0, 5)));
  });

  it('两个同时中招的人不会走出同一条轨迹（tick 级）', () => {
    const f = makeFixture();
    const second = addEntity(
      f.world, createEntity(allocEntityId(f.world), warrior, TEAM_BLUE, vec3(10, 0, 0)),
    );
    f.deps.loadouts.set(second.id, createLoadout(second.classId));
    f.movement.set(second.id, createMovementState(vec3(10, 0, 0), 0));

    resolveEffects(
      {
        world: f.world, auras: f.auras, dr: f.deps.dr, projectiles: f.deps.projectiles,
        ground: f.deps.ground, source: f.caster, skillId: 'test',
      },
      POLYMORPH(), [f.victim, second],
    );
    f.run(120);

    // 两人各自相对自己锚点的位移向量不应当一样
    const d1 = { x: f.victim.position.x - 0, z: f.victim.position.z - 0 };
    const d2 = { x: second.position.x - 10, z: second.position.z - 0 };
    expect(Math.hypot(d1.x - d2.x, d1.z - d2.z)).toBeGreaterThan(0.2);
  });
});

describe('8.2 化形游走：边界', () => {
  it('★ 半径不越界：20 秒里一步都没走出中招点 2.5 米', () => {
    const f = makeFixture();
    const anchor = posOf(f.victim);
    f.cast(POLYMORPH());

    let far = 0;
    for (let i = 0; i < 400; i++) {
      tickWorld(f.deps, DT);
      far = Math.max(far, distXZ(posOf(f.victim), anchor));
    }
    expect(far, '游走走出了小范围 —— 目标点选取或锚点维护有问题').toBeLessThanOrEqual(WANDER.RADIUS);
    expect(far, '压根没动，这条测试就没在测边界').toBeGreaterThan(0.3);
  });

  it('★ 撞墙不穿：游走走的是同一条积分路径（滑墙、体积照旧）', () => {
    // 锚点右侧 0.6 米起一堵长墙（`box` 收的是**中心**）：游走每次朝 +X 都会顶上去
    const wall = box('w', 'wall', { x: 2.1, y: 0, z: 0 }, { w: 3, h: 3, d: 12 });
    const f = makeFixture([ground, wall]);
    f.cast(POLYMORPH());

    let maxX = -Infinity;
    for (let i = 0; i < 400; i++) {
      tickWorld(f.deps, DT);
      const p = f.victim.position;
      expect(
        cylinderOverlapsAabb(p, f.victim.radius, f.victim.height, wall),
        `第 ${i} tick 走进墙里了`,
      ).toBe(false);
      maxX = Math.max(maxX, p.x);
    }
    /**
     * 真的顶到墙上过：目标点最远能取到 +2.125 米（`TARGET_MAX × RADIUS`），
     * 而全程 x 的上确界卡在 0.1426 —— 贴着墙面（0.6 − 体积半径 0.45 = 0.15）
     * 差一步没跨过去，那一步正是 `moveAndSlide` 拒掉的。
     * 两条一起才有意义：只断言「没穿墙」的话，一个「压根没往那边走」的
     * bug 同样能让它绿。
     */
    expect(maxX).toBeGreaterThan(0.1);
    expect(maxX).toBeLessThan(0.15);
  });

  it('★★ 不走下台面：脚下地面断了的那一段站着（X29 修）', () => {
    /**
     * ★★ 这条盯的是「sim 替玩家做了一次玩家无法阻止的位移决策」。
     *   目标点的选取只看「离锚点多远」，`moveAndSlide` 只拒绝**水平**碰撞 ——
     *   走出台沿之后接管的是重力。**修之前实测**：这张图上 30 秒掉 12 米，
     *   落点 `{x:1.22, y:-11.5, z:-1.14}`，而 `FALL_DAMAGE_HEIGHT` 是 8：
     *   被控期间被游戏本身挪下台，还附赠一份坠落伤害。
     * ⚠️ 这一族此前**整族没有覆盖**：其余用例全跑在 400×400 的无限平地上
     *   （`ground`），那张地板把「脚下没有地」这件事从头到尾遮住了。
     */
    // 台面 x ∈ [-3, 0.6]、z ∈ [-3, 3]，顶面 y=0：锚点（原点）离台沿 0.6 米
    const platform = box('p', 'floor', { x: -1.2, y: -1, z: 0 }, { w: 3.6, h: 1, d: 6 });
    // 台下 12 米才是地 —— 掉下去看得见（不是「下沉了几厘米」）
    const abyss = box('deep', 'floor', { x: 0, y: -13, z: 0 }, { w: 400, h: 1, d: 400 });
    const f = makeFixture([platform, abyss]);
    const anchor = posOf(f.victim);
    f.cast(POLYMORPH());

    let minY = 0;
    let far = 0;
    for (let i = 0; i < 600; i++) {
      tickWorld(f.deps, DT);
      minY = Math.min(minY, f.victim.position.y);
      far = Math.max(far, distXZ(posOf(f.victim), anchor));
    }
    expect(minY, '游走把被控者走下台面了 —— 目标点没查脚下有没有地').toBeGreaterThan(-0.5);
    // ★ 第二条不能省：一个「在台面上压根不走」的 bug 同样能让上一条绿
    expect(far, '在台面上完全没走 —— 这条测试没在测闸，在测「没游走」').toBeGreaterThan(0.3);
  });

  it('★★ L 形台面：拐角处不抄近路切出去（第二道闸）', () => {
    /**
     * ★★ 只查目标点是不够的：站得住的区域**不一定是凸的**。这张 L 形走道上
     *   起点（拐角）与终点（另一条臂上）都站得住，中间那条直线却在拐角
     *   外侧切出去 —— 全地图网格体检里真的抓到过一例（熔岩裂谷两堵边界墙
     *   的拐角，实测掉 8 米）。第二道闸探的是**这一步踩下去的地方**。
     */
    // 与实测那一例同形：两条 1 米宽的走道在**外**拐角相交，中招点就在拐角上
    const armX = box('a', 'floor', { x: -6, y: -1, z: -0.5 }, { w: 12, h: 1, d: 1 });
    const armZ = box('b', 'floor', { x: -0.5, y: -1, z: -6 }, { w: 1, h: 1, d: 12 });
    const abyss = box('deep', 'floor', { x: 0, y: -10, z: 0 }, { w: 400, h: 1, d: 400 });
    // ★ 起点刻意取在拐角里侧（−0.2, −0.4）：25 个起点扫下来，只有第一道闸时
    //   正是这个位置会切角掉下去 9 米（起点在走道上，脚下实打实有地）
    const f = makeFixture([armX, armZ, abyss], { x: -0.2, y: 0, z: -0.4 });
    const anchor = posOf(f.victim);
    f.cast(POLYMORPH());

    let minY = 0;
    let far = 0;
    for (let i = 0; i < 600; i++) {
      tickWorld(f.deps, DT);
      minY = Math.min(minY, f.victim.position.y);
      far = Math.max(far, distXZ(posOf(f.victim), anchor));
    }
    expect(minY, '在 L 形拐角抄近路走出去了').toBeGreaterThan(-0.5);
    expect(far, '在走道上完全没走 —— 这条测试没在测闸').toBeGreaterThan(0.3);
  });

  it('★ 受伤打断化形：当场停住，不回锚点也不滑行（8.2 breakDamage）', () => {
    const f = makeFixture();
    f.cast(POLYMORPH(30, 20));

    // ★ 挑一个**正在迈步**的 tick 下刀 —— 打在「发呆」那一段上的话，
    //   「停住」是白捡的，抹不抹动量都绿（这条测试就测不到东西了）
    let ticks = 0;
    while (
      ticks < 400
      && !(f.movement.get(f.victim.id)!.lastHorizontalDistance > 0.1
        && distXZ(posOf(f.victim), { x: 0, z: 0 }) > 0.5) // 也要真的离开锚点了
    ) {
      tickWorld(f.deps, DT);
      ticks++;
    }
    const before = f.movement.get(f.victim.id)!;
    expect(Math.hypot(before.velocity.x, before.velocity.z), '没抓到迈步中的 tick').toBeGreaterThan(1);

    f.cast([{ kind: 'damage', school: School.Fire, amount: { flat: 200 } }]);
    expect(f.victim.alive, '这一刀不该打死人，否则测的是尸体不动').toBe(true);

    tickWorld(f.deps, DT); // 打断后的第一个 tick：拔锚 + 抹动量
    const after = f.movement.get(f.victim.id)!;
    const stopped = posOf(f.victim);
    expect(after.wander, '锚没拔 —— 下次被变形会沿用旧锚').toBeUndefined();
    expect(after.velocity.x, '残余动量没抹 —— 被打醒的人还会自己滑出去一截').toBe(0);
    expect(after.velocity.z).toBe(0);

    f.run(20); // 没有输入条目 = 全零输入，一微米都不该再挪
    expect(distXZ(posOf(f.victim), stopped)).toBeLessThan(1e-9);
    // 停在**当前位置**，不是被弹回中招点
    expect(distXZ(stopped, { x: 0, z: 0 })).toBeGreaterThan(0.2);
  });

  /**
   * ★★ 位移之后**锚要跟着人走**（`teleportTo` 拔锚）。
   *   不拔的话：被死亡之握拉过去 20 米的小鸡会掉头往中招点走 —— 而
   *   `driveWander` 的「被挤出圈外就往回走」分支根本就不是为这个量级写的，
   *   于是玩家看到一只穿过半张地图匀速回家的鸡。
   */
  it('★ 被击退/拉拽之后就地重新下锚，不往老中招点走回去', () => {
    const f = makeFixture();
    f.cast(POLYMORPH());
    f.run(60);

    // 施法者在 −Z 方向 20 米外 → 击退把人推向 +Z
    f.cast([{ kind: 'knockback', distance: 10 }]);
    const landed = posOf(f.victim);
    expect(distXZ(landed, { x: 0, z: 0 }), '这一发没把人推走，后面的断言就没意义').toBeGreaterThan(5);
    expect(f.movement.get(f.victim.id)!.wander, '传送没拔锚').toBeUndefined();

    f.run(200); // 10 秒：够走回去好几趟了
    expect(
      distXZ(posOf(f.victim), landed),
      '被推走之后还在往老锚点走 —— teleportTo 没拔锚',
    ).toBeLessThanOrEqual(WANDER.RADIUS);
  });

  /**
   * ★★ 上一条在 20Hz（服务器步长）下**测不到抹动量那一步**：
   *   `GROUND_ACCEL × 0.05 = 3.0 > 游走速度 2.8`，地面减速一 tick 就把速度
   *   夹到 0 了 —— 抹不抹都一样绿。而试验场按渲染步长推 tick（1/60），
   *   那里 `60 × 1/60 = 1.0`，残余动量要三帧才衰完，被打醒的人会顺着
   *   小鸡最后的方向自己滑出去一截。所以这条**换个步长**再问一次。
   */
  it('★ 打断即停不依赖步长（1/60 下同样当场停住，而不是滑三帧）', () => {
    const SMALL = 1 / 60;
    const f = makeFixture();
    f.cast(POLYMORPH(30, 20));

    let ticks = 0;
    while (ticks < 1200 && f.movement.get(f.victim.id)!.lastHorizontalDistance < 0.04) {
      tickWorld(f.deps, SMALL);
      ticks++;
    }
    expect(Math.hypot(
      f.movement.get(f.victim.id)!.velocity.x, f.movement.get(f.victim.id)!.velocity.z,
    ), '没抓到迈步中的 tick').toBeGreaterThan(1);

    f.cast([{ kind: 'damage', school: School.Fire, amount: { flat: 200 } }]);
    tickWorld(f.deps, SMALL);

    const after = f.movement.get(f.victim.id)!;
    expect(after.velocity.x).toBe(0);
    expect(after.velocity.z).toBe(0);
    const stopped = posOf(f.victim);
    f.run(10, SMALL);
    expect(distXZ(posOf(f.victim), stopped)).toBeLessThan(1e-9);
  });
});

describe('8.2 化形游走：谁不走', () => {
  /** 跑一段，返回相对出生点的位移 */
  const driftUnder = (effects: readonly EffectDef[], input?: MovementInput): number => {
    const f = makeFixture();
    f.cast(effects);
    if (input) f.inputs.set(f.victim.id, input);
    f.run(120);
    return distXZ(posOf(f.victim), { x: 0, z: 0 });
  };

  it('★ 玩家输入仍然锁死：化形期间满油门 + 跳，人还是在那一小圈里', () => {
    const f = makeFixture();
    f.cast(POLYMORPH());
    f.inputs.set(f.victim.id, FULL_THROTTLE);
    f.run(120);

    expect(
      distXZ(posOf(f.victim), { x: 0, z: 0 }),
      '按住 W 就跑掉了 —— 游走把操控还给玩家了（lock 被松开而不是被代驾）',
    ).toBeLessThanOrEqual(WANDER.RADIUS);
    expect(f.victim.position.y, '化形期间跳起来了').toBeCloseTo(0, 6);

    // 对照组：同样的输入、没有化形 —— 6 秒能跑出去一大截
    const free = makeFixture();
    free.inputs.set(free.victim.id, FULL_THROTTLE);
    free.run(120);
    expect(distXZ(posOf(free.victim), { x: 0, z: 0 })).toBeGreaterThan(10);
  });

  it('★ 昏迷不游走（Stun 链是「站着挨打」，不是「走来走去」）', () => {
    expect(driftUnder([{ kind: 'stun', duration: 30 }], FULL_THROTTLE)).toBeLessThan(0.05);
  });

  it('★ 恐惧不游走（同属 Incapacitate 递减链，但方向语义不同 —— 本批不做）', () => {
    expect(driftUnder([{ kind: 'fear', duration: 30 }], FULL_THROTTLE)).toBeLessThan(0.05);
  });

  it('★ 定身压过化形：被变形又被定住的人钉在原地', () => {
    expect(
      driftUnder([...POLYMORPH(), { kind: 'root', duration: 30 }], FULL_THROTTLE),
    ).toBeLessThan(0.05);
  });

  it('★ 另一个硬控在场（化形 + 昏迷）：由更强的那个说了算，不游走', () => {
    expect(
      driftUnder([...POLYMORPH(), { kind: 'stun', duration: 30 }], FULL_THROTTLE),
    ).toBeLessThan(0.05);
  });

  it('带 stunned 但不属于迷惑链的光环（冰封庇护那一档）不游走', () => {
    const f = makeFixture();
    applyAura(f.auras, f.victim, {
      id: 'test.ice_block', name: '测试冰封', kind: 'buff', duration: 30,
      dispelType: DispelType.Magic, flags: { immuneAll: true, stunned: true },
      description: '完全免疫但无法行动',
    }, f.victim.id, f.world.time);
    f.inputs.set(f.victim.id, FULL_THROTTLE);
    f.run(120);
    expect(distXZ(posOf(f.victim), { x: 0, z: 0 })).toBeLessThan(0.05);
  });

  it('★ 化形结束后操控立刻还回来（游走不是一张单程票）', () => {
    const f = makeFixture();
    f.cast(POLYMORPH(0.5));
    f.inputs.set(f.victim.id, { ...FULL_THROTTLE, jump: false });
    f.run(60); // 0.5s 化形 + 2.5s 自由
    expect(distXZ(posOf(f.victim), { x: 0, z: 0 })).toBeGreaterThan(10);
    expect(f.movement.get(f.victim.id)!.wander).toBeUndefined();
  });
});
