/**
 * 快照视野裁剪测试。docs/08 §4，验收 #5 / #36。
 *
 * ★ 验收 #5 是**安全边界**，不是显示细节。所以这里的关键断言不是
 *   「客户端没画出潜行者」，而是「潜行者根本不在快照里」——
 *   前者改前端就能绕过，后者改前端也拿不到数据。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mage, priest, rogue, warrior } from '../data/index.js';
import { DispelType, GameMode, TargetFilter } from '../types/enums.js';
import { createArena } from '../sim/match/arena.js';
import { vec3 } from '../math/vec3.js';
import { asEntityId, asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { applyAura, createAuraStore, type AuraStore } from '../sim/aura.js';
import { createEntity, isSelectableBy, type CombatEntity } from '../sim/entity.js';
import {
  addWeapon, createLoadout, createSwapStore, type Loadout, type SwapStore,
} from '../sim/loadout.js';
import { createCtf, type CtfState } from '../sim/match/flag.js';
import { addEntity, allocEntityId, createWorld, type World } from '../sim/world.js';
import {
  CULLING_RULES,
  ENTITY_FLAG_BITS,
  HIDDEN_AURA_ID,
  SUDDEN_DEATH_BLIP_GRID,
  assertNoHiddenEntities,
  buildSnapshot,
  buildSpectatorSnapshot,
  isLegalSpectateFollow,
  spectatableForSpectator,
  NO_ENTITY,
  SPECTATOR,
  displayFlagsOf,
  buildSelfState,
  equipmentViewFor,
  isVisibleTo,
  packEntityFlags,
  spectatableFor,
  staticsOf,
  type AllyEquipmentSnapshot,
  type EnemyEquipmentSnapshot,
  type SnapshotDeps,
} from './visibility.js';

let world: World;
let auras: AuraStore;
let swaps: SwapStore;
let loadouts: Map<ReturnType<typeof asEntityId>, Loadout>;

let me: CombatEntity;        // 红队法师（接收者）
let mate: CombatEntity;      // 红队牧师（队友）
let foe: CombatEntity;       // 蓝队战士（敌人）
let sneak: CombatEntity;     // 蓝队盗贼（潜行）

const spawn = (cls: typeof mage, team: typeof TEAM_RED, x = 0, z = 0): CombatEntity =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld();
  auras = createAuraStore();
  swaps = createSwapStore();
  loadouts = new Map();

  me = spawn(mage, TEAM_RED, 0, 0);
  mate = spawn(priest, TEAM_RED, 2, 0);
  foe = spawn(warrior, TEAM_BLUE, 0, 10);
  sneak = spawn(rogue, TEAM_BLUE, 0, 5);

  for (const e of [me, mate, foe, sneak]) loadouts.set(e.id, createLoadout(e.classId));
});

const deps = (over: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
  world, auras, swaps, loadouts, tick: 1, dampening: 0, suddenDeath: false, ...over,
});

const idsIn = (viewer: CombatEntity, over: Partial<SnapshotDeps> = {}): number[] =>
  buildSnapshot(deps(over), viewer).entities.map((e) => e.id as number);

// ════════════════════════════════════════════════════════════════

describe('docs/08 §4.1 潜行裁剪（验收 #5）', () => {
  it('reports the real arena alive count without revealing a hidden enemy', () => {
    sneak.flags.stealthed = true;
    const arena = createArena({ mode: GameMode.Arena2v2, roundsToWin: 1 });
    const snap = buildSnapshot(deps({ arena }), me);
    expect(snap.match.arena).toMatchObject({ aliveRed: 2, aliveBlue: 2 });
    expect(snap.entities.some(e => e.id === sneak.id)).toBe(false);
    expect(JSON.stringify(snap.match)).not.toContain(sneak.name);
  });
  it('未潜行的敌人正常进快照', () => {
    expect(idsIn(me)).toContain(foe.id as number);
  });

  /**
   * ★★ **这是验收 #5 的核心断言。**
   *   不是「快照里标了 stealthed 让客户端别画」，而是**整个实体不在快照里**。
   */
  it('★★ 未被发现的潜行敌人完全不进快照，而不是带个隐藏标记', () => {
    sneak.flags.stealthed = true;
    const snap = buildSnapshot(deps(), me);
    const ids = snap.entities.map((e) => e.id as number);

    expect(ids).not.toContain(sneak.id as number);
    // 也不能以任何形式泄露它的存在
    expect(JSON.stringify(snap)).not.toContain(sneak.name);
  });

  it('已被发现的潜行敌人进快照（3 米内 / 照明弹 / 主动攻击后）', () => {
    sneak.flags.stealthed = true;
    sneak.flags.stealthRevealed = true;
    expect(idsIn(me)).toContain(sneak.id as number);
  });

  it('★ 队友的潜行对己方可见（docs/08 §4.1 第二条）', () => {
    mate.flags.stealthed = true;
    expect(idsIn(me)).toContain(mate.id as number);
  });

  it('潜行者自己当然看得见自己', () => {
    sneak.flags.stealthed = true;
    expect(idsIn(sneak)).toContain(sneak.id as number);
  });

  /**
   * ★ 死人和「不可选中」都要进快照 —— 它们不是可见性问题。
   *   死人要画尸体、要在队伍框里显示「已阵亡」；
   *   剑刃风暴（untargetable）不能被选中，但当然看得见。
   *   把这两者当成可见性裁掉，会让客户端凭空少画东西。
   */
  it('★ 死人进快照（要画尸体、要在队伍框显示已阵亡）', () => {
    foe.alive = false;
    expect(idsIn(me)).toContain(foe.id as number);
  });

  it('★ untargetable（剑刃风暴）进快照 —— 不能选中 ≠ 看不见', () => {
    foe.flags.untargetable = true;
    expect(idsIn(me)).toContain(foe.id as number);
    // 选中规则仍然拒绝它，那是 isSelectableBy 的职责
    expect(isSelectableBy(foe, me)).toBe(false);
  });

  /**
   * ★ 「能否进快照」与「能否选中」共用同一条潜行判据（isHiddenFromViewer）。
   *   两处各写一遍迟早漂移，而漂移方向一定是快照更宽松 —— 那就是透视。
   */
  it('★ 快照可见性与选中规则对潜行的判断始终一致', () => {
    for (const [stealthed, revealed] of [[false, false], [true, false], [true, true]] as const) {
      sneak.flags.stealthed = stealthed;
      sneak.flags.stealthRevealed = revealed;
      const visible = isVisibleTo(sneak, me);
      const selectable = isSelectableBy(sneak, me);
      // 不可见 ⇒ 必然不可选中（反之不成立：死人可见但不可选中）
      if (!visible) expect(selectable).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════

describe('12.2 旗手位置对双方持续可见', () => {
  let ctf: CtfState;

  beforeEach(() => {
    ctf = createCtf(vec3(0, 0, 100), vec3(0, 0, -100));
  });

  /**
   * ★ 12.3 规定旗手不能潜行、8.4 规定使用潜行时先掉旗，所以正常流程下
   *   这个场景不会出现。但那是**别的模块**维护的不变量 ——
   *   M8 就真的断过一次（客户端从没调用 dropFlagBeforeSkill()）。
   *   这里显式放行，保证「旗手隐身」不会同时变成「旗手消失」。
   */
  it('★ 即使旗手处于未被发现的潜行状态，也仍然进快照（12.2 优先）', () => {
    const flag = ctf.flags[String(TEAM_RED as number)]!;
    flag.carrierId = sneak.id;
    sneak.flags.carryingFlag = true;
    sneak.flags.stealthed = true;

    expect(idsIn(me, { ctf })).toContain(sneak.id as number);
  });

  it('非旗手的潜行者仍然被裁掉', () => {
    sneak.flags.stealthed = true;
    expect(idsIn(me, { ctf })).not.toContain(sneak.id as number);
  });

  it('旗帜状态与旗手身份对双方可见', () => {
    const flag = ctf.flags[String(TEAM_RED as number)]!;
    flag.carrierId = foe.id;
    const snap = buildSnapshot(deps({ ctf }), me);
    expect(snap.match.flags?.some((f) => f.carrierId === foe.id)).toBe(true);
  });

  /** ★ 与 15.4 让两种模式 HUD 视图不相交同源：竞技场快照里没有旗帜字段 */
  it('★ 竞技场（不传 ctf）快照里没有旗帜字段', () => {
    const snap = buildSnapshot(deps(), me);
    expect(snap.match.flags).toBeUndefined();
    expect(snap.match.score).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════

describe('docs/08 §4.2 敌方装备裁剪（验收 #36）—— P11 后语义住在 equipmentViewFor', () => {
  beforeEach(() => {
    // 给敌人塞一件备用武器 —— 它绝对不能出现在发给我的字节里
    const l = loadouts.get(foe.id)!;
    addWeapon(l, warrior.weapons.find((w) => !w.isDefault)!.id);
  });

  it('★★ P11：装备完全不在快照实体里 —— 通道换了，快照侧结构性归零', () => {
    const snap = buildSnapshot(deps(), me);
    const foeSnap = snap.entities.find((e) => e.id === foe.id)!;
    // wire 形态没有 equipment 字段（EntityLoadouts 消息才有）
    expect('equipment' in foeSnap).toBe(false);
    // 备用武器的 id 不能以任何形式出现在整份快照里
    const spareId = String(loadouts.get(foe.id)!.spareWeapons[0]);
    expect(JSON.stringify(snap)).not.toContain(spareId);
  });

  it('★★ 敌人的备用装备不出现在装备视图里（10.6 / 验收 #36）', () => {
    const eq = equipmentViewFor(foe, me, { loadouts, swaps }) as EnemyEquipmentSnapshot;
    expect(eq.currentWeaponId).toBe(warrior.defaultWeaponId);
    expect(eq.armorArchetype).toBeDefined();
    // 结构上就没有这些字段
    expect(Object.keys(eq).sort()).toEqual(['armorArchetype', 'currentWeaponId', 'swapping']);
    const spareId = String(loadouts.get(foe.id)!.spareWeapons[0]);
    expect(JSON.stringify(eq)).not.toContain(spareId);
  });

  it('队友的完整装备栏可见（含备用）', () => {
    const l = loadouts.get(mate.id)!;
    addWeapon(l, priest.weapons.find((w) => !w.isDefault)!.id);
    const eq = equipmentViewFor(mate, me, { loadouts, swaps }) as AllyEquipmentSnapshot;
    expect(eq.spareWeaponIds).toHaveLength(1);
  });

  it('敌人的换装动作可见，但看不出在换什么', () => {
    const eq = equipmentViewFor(foe, me, { loadouts, swaps }) as EnemyEquipmentSnapshot;
    expect(eq.swapping).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════

describe('P11 快照瘦身 —— 位掩码 / 静态块 / 量化', () => {
  it('位掩码往返：pack → displayFlagsOf 逐位还原', () => {
    const flags = {
      stunned: true, feared: false, rooted: true, silenced: false, disarmed: true,
      carryingFlag: true, immuneAll: false, immunePhysical: true, immuneMagic: false,
    };
    const mask = packEntityFlags(false, true, flags);
    expect((mask & ENTITY_FLAG_BITS.dead) !== 0).toBe(true);
    expect((mask & ENTITY_FLAG_BITS.teleported) !== 0).toBe(true);
    expect(displayFlagsOf(mask)).toEqual({ ...flags });
  });

  it('常态（活着、无瞬移、无状态）掩码为 0，字段整个省略', () => {
    const snap = buildSnapshot(deps(), me);
    const meSnap = snap.entities.find((e) => e.id === me.id)!;
    expect('f' in meSnap).toBe(false);
  });

  it('★ 波3：静态块整体离开快照（EntityMeta 通道），staticsOf 是它的唯一投影', () => {
    const snap = buildSnapshot(deps(), me);
    // 共享实体段结构上没有任何静态字段 —— 字节级验证
    const json = JSON.stringify(snap.entities);
    for (const key of ['"name"', '"classId"', '"maxHealth"', '"maxResources"', '"team"']) {
      expect(json).not.toContain(key);
    }
    // 静态块的投影完整（MatchLoop 首见时随 EntityMeta 发）
    const st = staticsOf(foe);
    expect(st.name).toBe(foe.name);
    expect(st.team).toBe(foe.team);
    expect(st.classId).toBe(foe.classId);
    expect(st.maxHealth).toBe(foe.maxHealth);
  });

  it('★★ 波3 的支点：同队任意两个观察者的快照逐字节相同（共享段可行性）', () => {
    // 造点逐人差异的诱因：潜行敌人、各自的焦点/冷却 —— 都不该进共享段
    sneak.flags.stealthed = true;
    me.targets.focus = foe.id;
    me.cooldowns.set(asSkillId('mage.blink'), 5);
    mate.cooldowns.set(asSkillId('priest.smite'), 3);

    // `you` 不在共享段里（MatchLoop 拼接时逐人注入）—— 比较时归一掉
    const shared = (viewer: CombatEntity): string =>
      JSON.stringify({ ...buildSnapshot(deps(), viewer), you: 0 });
    const a = shared(me);
    expect(shared(mate)).toBe(a);
    // 敌方视角则不同（潜行者进不进快照按队伍分）
    expect(shared(foe)).not.toBe(a);
  });

  it('★ 位置量化到 2 位小数（Predictor.IGNORE_BELOW=0.02m 的硬下界之内）', () => {
    me.position = { x: 1.23456789012345, y: 0.111111111, z: -9.87654321 };
    const snap = buildSnapshot(deps(), me);
    const meSnap = snap.entities.find((e) => e.id === me.id)!;
    expect(meSnap.position).toEqual({ x: 1.23, y: 0.11, z: -9.88 });
    // 量化步长 0.01 的最大表观偏差 √3·s/2 ≈ 0.0087 < 0.02
    expect((Math.sqrt(3) * 0.01) / 2).toBeLessThan(0.02);
  });
});

// ════════════════════════════════════════════════════════════════

describe('docs/08 §4.3 冷却与资源', () => {
  it('★ 冷却只住在 self 段（P11 波3）：共享实体段结构上没有冷却字段', () => {
    foe.cooldowns.set(asSkillId('warrior.charge'), 99);
    me.cooldowns.set(asSkillId('mage.blink'), 5);

    // 实体段：谁的冷却都不带 —— 字节级验证（敌方冷却不发，§4.3）
    const snap = buildSnapshot(deps(), me);
    expect(JSON.stringify(snap)).not.toContain('cooldowns');
    expect(JSON.stringify(snap)).not.toContain('warrior.charge');
    // self 段：只有自己的（每人的 self 段只发给自己 —— MatchLoop 拼接）
    const self = buildSelfState(deps(), me);
    expect(self.cooldowns['mage.blink']).toBe(5);
    expect(JSON.stringify(self)).not.toContain('warrior.charge');
  });

  it('敌方资源值要发 —— 15.2 的目标框需要显示', () => {
    const snap = buildSnapshot(deps(), me);
    const foeSnap = snap.entities.find((e) => e.id === foe.id)!;
    expect(Object.keys(foeSnap.resources).length).toBeGreaterThan(0);
  });

  /**
   * P10：GCD 与焦点是本轮新增的两个**只发给自己**的字段。
   * 断言按 `cooldowns` 那条的同一形状写 —— 三个人各查一次，
   * 「顺手也发给了别人」会在这里变红。
   */
  it('★ P10：公共冷却只发给自己，且走完就不发（没有字段 = 不在 GCD 中）', () => {
    me.gcdUntil = 3;
    foe.gcdUntil = 3;
    world.time = 1;

    // P11 波3：GCD 住在 self 段；共享实体段结构上没有它
    expect(JSON.stringify(buildSnapshot(deps(), me))).not.toContain('gcdUntil');
    expect(buildSelfState(deps(), me).gcdUntil).toBe(3);

    // GCD 已走完 → 字段整个不出现，客户端不必再判「过期了没」
    world.time = 5;
    expect(buildSelfState(deps(), me).gcdUntil).toBeUndefined();
  });

  it('★ P10：焦点目标回读给自己（5.1 的切换语义在服务器，客户端不记账）', () => {
    me.targets.focus = foe.id;
    // P11 波3：焦点住在 self 段（每人只收自己的）；共享实体段没有它
    expect(buildSelfState(deps(), me).focusId).toBe(foe.id);
    // 别人的焦点一律不进共享段 —— 焦点是战术意图，敌人知道了就是白送信息
    mate.targets.focus = foe.id;
    expect(JSON.stringify(buildSnapshot(deps(), me))).not.toContain('focusId');
  });

  /**
   * ★★ 这条是验收 #5 在焦点通道上的复述：焦点设定之后目标潜行遁走，
   *   回读会把一个**不在快照里**的 id 发出去 —— 那等于确认了他还在场上。
   */
  it('★★ P10：焦点潜行后不再回读（看不见的焦点等于没有焦点）', () => {
    me.targets.focus = sneak.id;
    expect(buildSelfState(deps(), me).focusId).toBe(sneak.id);

    sneak.flags.stealthed = true;
    const self = buildSelfState(deps(), me);
    expect(self.focusId).toBeUndefined();
    // 与潜行裁剪同一条标准：id 连字节都不出现
    expect(JSON.stringify(self)).not.toContain(`"focusId"`);
  });

  it('★ W20：硬目标回读给自己（服务器成为选中显示的唯一权威）', () => {
    me.targets.hard = foe.id;
    expect(buildSelfState(deps(), me).hardTargetId).toBe(foe.id);
    // 别人的硬目标不进共享段 —— 集火意图泄露，与焦点同理
    mate.targets.hard = foe.id;
    expect(JSON.stringify(buildSnapshot(deps(), me))).not.toContain('hardTargetId');
  });

  /** ★★ 验收 #5 在硬目标通道上的复述（与焦点同一条纪律） */
  it('★★ W20：硬目标潜行后不再回读（看不见的目标等于没有目标）', () => {
    me.targets.hard = sneak.id;
    expect(buildSelfState(deps(), me).hardTargetId).toBe(sneak.id);

    sneak.flags.stealthed = true;
    const self = buildSelfState(deps(), me);
    expect(self.hardTargetId).toBeUndefined();
    expect(JSON.stringify(self)).not.toContain(`"hardTargetId"`);
  });
});

// ════════════════════════════════════════════════════════════════

describe('8.5 决胜阶段的粗略位置', () => {
  it('非决胜阶段没有位置标记', () => {
    expect(buildSnapshot(deps(), me).match.suddenDeathBlips).toBeUndefined();
  });

  /**
   * ★★ 8.5 要求「决胜阶段所有玩家大致位置可见」，验收 #5 要求「未被发现的
   *   潜行目标不能被点击、Tab 或小地图**选中**」。两条同时成立的方式是：
   *   位置走一个**没有实体 id** 的独立通道 —— 选中链路全都要 id，
   *   所以「决胜阶段能选中潜行者」在结构上不可能发生。
   */
  it('★★ 决胜阶段发出位置标记，但标记没有实体 id（8.5 与 #5 同时成立）', () => {
    sneak.flags.stealthed = true;
    const snap = buildSnapshot(deps({ suddenDeath: true }), me);

    // 潜行者仍然不在实体列表里 —— #5 没有被放宽
    expect(snap.entities.map((e) => e.id as number)).not.toContain(sneak.id as number);

    // 但他的大致位置有了 —— 8.5 成立
    expect(snap.match.suddenDeathBlips).toHaveLength(4);
    for (const b of snap.match.suddenDeathBlips!) {
      expect(b).not.toHaveProperty('id');
      expect(Object.keys(b).sort()).toEqual(['position', 'team']);
    }
  });

  it('★ 位置被量化 —— 「大致位置」不能给成精确坐标', () => {
    foe.position = vec3(7.3, 0, 13.9);
    const snap = buildSnapshot(deps({ suddenDeath: true }), me);
    for (const b of snap.match.suddenDeathBlips!) {
      expect(b.position.x % SUDDEN_DEATH_BLIP_GRID).toBeCloseTo(0, 6);
      expect(b.position.z % SUDDEN_DEATH_BLIP_GRID).toBeCloseTo(0, 6);
    }
    // 精确坐标不能泄露
    expect(JSON.stringify(snap.match.suddenDeathBlips)).not.toContain('7.3');
  });

  it('死人和宠物不产生位置标记', () => {
    foe.alive = false;
    const snap = buildSnapshot(deps({ suddenDeath: true }), me);
    expect(snap.match.suddenDeathBlips).toHaveLength(3);
  });
});

// ════════════════════════════════════════════════════════════════

describe('11.4 观战只能跟随己方存活玩家', () => {
  it('可观战列表只含己方存活队友，不含自己、敌人、宠物', () => {
    const pet = addEntity(
      world,
      createEntity(allocEntityId(world), priest, TEAM_RED, vec3(3, 0, 0), { isPet: true }),
    );
    const list = spectatableFor(world, me).map((e) => e.id as number);
    expect(list).toEqual([mate.id as number]);
    expect(list).not.toContain(pet.id as number);
    expect(list).not.toContain(foe.id as number);
  });

  it('队友死了就不在可观战列表里', () => {
    mate.alive = false;
    expect(spectatableFor(world, me)).toHaveLength(0);
  });

  /**
   * ★ 不合法的跟随目标返回 undefined，而**不是**退化成自由镜头 ——
   *   自由镜头正好是 11.4 禁止的那种情况（能穿墙找潜行目标）。
   */
  it('★★ 不能跟随敌人（返回 undefined，不是退化成自由镜头）', () => {
    expect(buildSpectatorSnapshot(deps(), me, foe)).toBeUndefined();
  });

  it('不能跟随死掉的队友', () => {
    mate.alive = false;
    expect(buildSpectatorSnapshot(deps(), me, mate)).toBeUndefined();
  });

  /**
   * ★★ 观战视角走的是**被跟随队友**的裁剪结果 ——
   *   死了不会因此看到更多东西。否则「死一次换透视」就成了最优打法。
   */
  it('★★ 观战时看到的仍是队友的可见集合，潜行者依然不可见', () => {
    sneak.flags.stealthed = true;
    me.alive = false;
    const snap = buildSpectatorSnapshot(deps(), me, mate)!;
    expect(snap.entities.map((e) => e.id as number)).not.toContain(sneak.id as number);
  });

  it('观战快照的视角归属是被跟随的队友', () => {
    me.alive = false;
    const snap = buildSpectatorSnapshot(deps(), me, mate)!;
    expect(snap.you).toBe(mate.id);
  });
});

// ════════════════════════════════════════════════════════════════

describe('发送前自检', () => {
  it('正常构建的快照通过自检', () => {
    sneak.flags.stealthed = true;
    const snap = buildSnapshot(deps(), me);
    expect(() => assertNoHiddenEntities(snap, world, me)).not.toThrow();
  });

  /**
   * ★ 兜底自检确实会拦下泄露。
   *   上面那些结构性保证是「让错误写法难写」，这一条是「万一还是写出来了，
   *   在发出去之前崩掉」—— 验收 #5 是安全边界，宁可掉线也不能透视。
   */
  it('★ 手工塞进一个隐形实体会被自检拦下', () => {
    const snap = buildSnapshot(deps(), me);
    sneak.flags.stealthed = true;
    const leaked = {
      ...snap,
      entities: [...snap.entities, { ...snap.entities[0]!, id: sneak.id, name: sneak.name }],
    };
    expect(() => assertNoHiddenEntities(leaked, world, me)).toThrow(/快照泄露/);
  });
});

describe('14.3 / 14.4 投射物与地面区域进快照', () => {
  it('不传存储时是空数组（老调用方与纯规则测试不受影响）', () => {
    const snap = buildSnapshot(deps(), me);
    expect(snap.projectiles).toEqual([]);
    expect(snap.grounds).toEqual([]);
  });

  it('homing/colliding 带当前位置；delayedImpact 带落点/半径/倒计时时刻（14.3）', () => {
    const snap = buildSnapshot(deps({
      projectiles: {
        nextId: 3,
        items: [
          {
            kind: 'homing', id: 1, skillId: asSkillId('mage.frostbolt'),
            sourceId: me.id, targetId: foe.id,
            position: vec3(1, 1.2, 2), speed: 30, impactAt: 5, onHit: [],
            // W25 收口：释放瞬间的朝向/可行动快照（快照面不发它，见 ProjectileSnapshot）
            hitSnapshot: { fromBehind: false, canAvoid: true },
          },
          {
            kind: 'delayedImpact', id: 2, skillId: asSkillId('mage.meteor'),
            sourceId: me.id, center: vec3(3, 0, 4), radius: 5,
            createdAt: 1, impactAt: 3, targetFilter: TargetFilter.Enemy, onImpact: [],
          },
        ],
      },
    }), me);

    expect(snap.projectiles).toHaveLength(2);
    const [bolt, meteor] = snap.projectiles;
    expect(bolt).toMatchObject({ kind: 'homing', position: { x: 1, y: 1.2, z: 2 } });
    expect(meteor).toMatchObject({
      kind: 'delayedImpact', position: { x: 3, y: 0, z: 4 }, radius: 5, impactAt: 3, createdAt: 1,
    });
  });

  it('★★ 投射物快照不带任何实体引用（sourceId/targetId 结构性缺席）', () => {
    const snap = buildSnapshot(deps({
      projectiles: {
        nextId: 2,
        items: [{
          kind: 'homing', id: 1, skillId: asSkillId('mage.frostbolt'),
          sourceId: sneak.id, targetId: me.id, // 来源甚至是个潜行者
          position: vec3(0, 1, 0), speed: 30, impactAt: 5, onHit: [],
          hitSnapshot: { fromBehind: false, canAvoid: true },
        }],
      },
    }), me);
    // 潜行者的 id 不出现在序列化字节里 —— verify:m10 第 1 条的同一标准
    const bytes = JSON.stringify(snap.projectiles);
    expect(bytes.includes('sourceId')).toBe(false);
    expect(bytes.includes('targetId')).toBe(false);
  });

  it('★★ 地面区域只发 areas，陷阱（9.5）永不进快照', () => {
    const snap = buildSnapshot(deps({
      ground: {
        areas: [{
          id: 1, areaId: 'blizzard', skillId: 'mage.blizzard', sourceId: me.id,
          center: vec3(5, 0, 5), radius: 6, createdAt: 0, expiresAt: 8,
          tickInterval: 1, nextTickAt: 1, onTick: [],
          blocksTargetingFromOutside: false, revealsStealth: false,
        }],
        traps: [{
          id: 9, skillId: 'hunter.frost_trap', sourceId: foe.id,
          center: vec3(7, 0, 7), triggerRadius: 2, armedAt: 1, expiresAt: 30,
          onTrigger: [], singleTrigger: true,
        }],
      },
    }), me);

    expect(snap.grounds).toHaveLength(1);
    expect(snap.grounds[0]).toMatchObject({ skillId: 'mage.blizzard', radius: 6, expiresAt: 8 });
    // 陷阱的任何痕迹都不在快照字节里 —— 「看不见、踩上才触发」是它的玩法本体
    expect(JSON.stringify(snap)).not.toContain('frost_trap');
  });
});

/**
 * M16d 协议债之一：护盾吸收量。
 *
 * ★★ 14.3 要求护盾有「激活/承伤/衰减/破裂」四种反馈，而联网侧此前
 *   **一份数据都没有** —— `AuraSnapshot` 只有 auraId/stacks/remaining（时长），
 *   客户端连「这人有没有盾」都判不出来，只能如实不画。
 */
describe('14.3 护盾吸收量进快照（M16d）', () => {
  const shieldDef = {
    id: 'mage.ice_barrier',
    name: '霜甲护盾',
    kind: 'buff' as const,
    duration: 8,
    dispelType: DispelType.None,
    absorb: 400,
    description: '',
  };
  const plainDef = {
    id: 'mage.frostbolt.chill',
    name: '寒冰',
    kind: 'debuff' as const,
    duration: 3,
    dispelType: DispelType.Magic,
    description: '',
  };

  it('吸收类光环带上剩余/初始吸收量', () => {
    applyAura(auras, foe, shieldDef, foe.id, 0);
    const snap = buildSnapshot(deps(), me);
    const aura = snap.entities.find((e) => e.id === foe.id)?.auras
      .find((a) => a.auraId === 'mage.ice_barrier');
    expect(aura?.absorbRemaining).toBe(400);
    expect(aura?.absorbInitial).toBe(400);
  });

  it('★ 非吸收光环一个字节都不带（八职业 90 技能里只有 4 个盾）', () => {
    applyAura(auras, foe, plainDef, me.id, 0);
    const snap = buildSnapshot(deps(), me);
    const aura = snap.entities.find((e) => e.id === foe.id)?.auras
      .find((a) => a.auraId === 'mage.frostbolt.chill');
    expect(aura).toBeDefined();
    expect(aura).not.toHaveProperty('absorbRemaining');
    expect(aura).not.toHaveProperty('absorbInitial');
  });

  it('★ 打空的盾不再投影 —— 「衰减到 0」与「没有盾」在表现上是两回事', () => {
    const inst = applyAura(auras, foe, shieldDef, foe.id, 0);
    inst.absorbRemaining = 0;
    const snap = buildSnapshot(deps(), me);
    const aura = snap.entities.find((e) => e.id === foe.id)?.auras
      .find((a) => a.auraId === 'mage.ice_barrier');
    expect(aura).not.toHaveProperty('absorbRemaining');
  });

  it('★★ 不改变可见性面：潜行者身上的盾照样整个不进快照（验收 #5）', () => {
    sneak.flags.stealthed = true;
    applyAura(auras, sneak, shieldDef, sneak.id, 0);
    const snap = buildSnapshot(deps(), me);
    expect(snap.entities.map((e) => e.id as number)).not.toContain(sneak.id as number);
    expect(JSON.stringify(snap)).not.toContain('ice_barrier');
  });
});

/**
 * S7：光环 id 泄露施加者职业（`rogue.rupture`）。施加者对接收者不可见时，
 * 目标身上那条光环的 id 要被掩成中性 token —— 「有个 debuff」照常，
 * 但不说是谁的什么。
 */
describe('S7：隐身施加者的光环 id 掩码', () => {
  /** 一条会泄露职业的 DoT，id 直接带职业前缀 */
  const dotDef = {
    id: 'rogue.rupture', name: '割裂', kind: 'debuff', duration: 12,
    dispelType: DispelType.Poison, drCategory: 'bleed', school: 0,
    flags: {},
  } as never;

  it('★★ 潜行盗贼给可见目标挂 DoT → 敌方接收者看到的 auraId 被掩成中性 token', () => {
    sneak.flags.stealthed = true;                 // 盗贼对红队不可见
    applyAura(auras, foe, dotDef, sneak.id, 0);    // 挂在可见的战士身上
    const snap = buildSnapshot(deps(), me);        // 红队法师视角

    const foeSnap = snap.entities.find((e) => e.id === (foe.id as number))!;
    const aura = foeSnap.auras[0]!;
    expect(aura.auraId, '泄露了施加者职业').toBe(HIDDEN_AURA_ID);
    // 整份快照的字节里不该出现 rogue.rupture
    expect(JSON.stringify(snap)).not.toContain('rupture');
  });

  it('★ 施加者可见（未潜行）→ auraId 原样，不误掩', () => {
    applyAura(auras, foe, dotDef, sneak.id, 0);    // sneak 未潜行 = 可见
    const snap = buildSnapshot(deps(), me);
    const foeSnap = snap.entities.find((e) => e.id === (foe.id as number))!;
    expect(foeSnap.auras[0]!.auraId).toBe('rogue.rupture');
  });

  it('★ 自己/队友身上的光环不掩（来源友方，本就可见）', () => {
    applyAura(auras, mate, dotDef, me.id, 0);      // 法师给队友挂（演示：来源=自己）
    const snap = buildSnapshot(deps(), me);
    const mateSnap = snap.entities.find((e) => e.id === (mate.id as number))!;
    expect(mateSnap.auras[0]!.auraId).toBe('rogue.rupture');
  });
});

// ════════════════════════════════════════════════════════════════
//  W24 观战段（运行中房间可观战）
// ════════════════════════════════════════════════════════════════

describe('W24 观战席的可见集', () => {
  const specIds = (over: Partial<SnapshotDeps> = {}): number[] =>
    buildSnapshot(deps(over), SPECTATOR).entities.map((e) => e.id as number);

  it('没人潜行时观战段就是全场', () => {
    expect(specIds().sort()).toEqual([me, mate, foe, sneak].map((e) => e.id as number).sort());
  });

  /**
   * ★★ **判据三条的第一条**：两队都没发现 → 观战者也看不见。
   *   这一条同时否掉了「观战 = 全量快照」那种最省事的实现。
   */
  it('★★ 未被任何敌人发现的潜行者不进观战段，且名字也不出现在字节里', () => {
    sneak.flags.stealthed = true;
    const snap = buildSnapshot(deps(), SPECTATOR);
    expect(snap.entities.map((e) => e.id as number)).not.toContain(sneak.id as number);
    expect(JSON.stringify(snap)).not.toContain(sneak.name);
  });

  it('★★ 被敌方发现之后进观战段（单队发现即可）', () => {
    sneak.flags.stealthed = true;
    sneak.flags.stealthRevealed = true;
    expect(specIds()).toContain(sneak.id as number);
  });

  /**
   * ★★ **判据三条的第三条，也是本批的设计裁决**：
   *   字面的「两队可见集**并集**」会把潜行者自己那一队的可见性算进来
   *   （红队永远看得见自己的盗贼），于是任何人开第二个窗口坐观战席就能
   *   给全场潜行者点名。实装口径取的是**交集**。
   */
  it('★★ 潜行的红队队友对红队可见，但同样不进观战段（并集口径会漏这条）', () => {
    const mine = spawn(rogue, TEAM_RED, 3, 3);
    loadouts.set(mine.id, createLoadout(mine.classId));
    mine.flags.stealthed = true;

    // 红队自己看得见他（isFriendly 直接放行）
    expect(idsIn(me)).toContain(mine.id as number);
    // 观战席看不见
    expect(specIds()).not.toContain(mine.id as number);
  });

  /**
   * 对抗性等价验证：观战段 = 红队可见集 ∩ 蓝队可见集。
   * ★ 逐实体比对而不是只看那个潜行者 —— 这条钉的是**口径本身**，
   *   将来有人给 `isVisibleToSpectator` 加一条特例就会红。
   */
  it('★★ 观战段恰好是两队可见集的交集（逐实体比对，含双方各一个潜行者）', () => {
    const mine = spawn(rogue, TEAM_RED, 3, 3);
    loadouts.set(mine.id, createLoadout(mine.classId));
    mine.flags.stealthed = true;
    sneak.flags.stealthed = true;
    sneak.flags.stealthRevealed = true; // 蓝队盗贼已暴露，红队盗贼没有

    const red = new Set(idsIn(me));
    const blue = new Set(idsIn(foe));
    const expected = [...red].filter((id) => blue.has(id)).sort();
    expect(specIds().sort()).toEqual(expected);
  });

  it('12.2 旗手对观战席也持续可见（与两队同口径）', () => {
    const ctf = createCtf(vec3(0, 0, -20), vec3(0, 0, 20), 3);
    ctf.flags[TEAM_RED as number]!.carrierId = sneak.id;
    sneak.flags.stealthed = true;
    expect(specIds({ ctf })).toContain(sneak.id as number);
  });

  /**
   * ★★ 10.6 / 验收 #36 对观战席没有豁免：他不是任何人的队友。
   *   给全场发完整装备栏等于把「开第二个窗口」做成一条侦察通道。
   */
  it('★★ 观战席拿到的装备一律是敌人视图（没有备用槽位）', () => {
    const l = loadouts.get(mate.id)!;
    addWeapon(l, priest.weapons.find((w) => !w.isDefault)!.id);
    const view = equipmentViewFor(mate, SPECTATOR, { loadouts, swaps });
    expect('spareWeaponIds' in view).toBe(false);
    // 同一个人对队友仍然是完整视图 —— 观战席拿到的是**更少**的那一份
    expect('spareWeaponIds' in equipmentViewFor(mate, me, { loadouts, swaps })).toBe(true);
  });

  it('观战段的 you 落在 NO_ENTITY 哨兵上（观战席没有实体）', () => {
    expect(buildSnapshot(deps(), SPECTATOR).you).toBe(NO_ENTITY);
    expect(NO_ENTITY as number).toBe(0);
  });

  it('★★ 兜底断言认识观战口径：合法观战段不报警，塞一个未发现的潜行者就抛', () => {
    sneak.flags.stealthed = true;
    const snap = buildSnapshot(deps(), SPECTATOR);
    expect(() => assertNoHiddenEntities(snap, world, SPECTATOR)).not.toThrow();

    const leaked = {
      ...snap,
      entities: [...snap.entities, { ...snap.entities[0]!, id: sneak.id }],
    };
    expect(() => assertNoHiddenEntities(leaked, world, SPECTATOR)).toThrow(/快照泄露/);
  });

  it('观战席能跟随的对象 = 观战段里活着的非宠物；未被发现的潜行者跟不了', () => {
    sneak.flags.stealthed = true;
    foe.alive = false;
    const targets = spectatableForSpectator(world).map((e) => e.id as number);
    expect(targets).toContain(me.id as number);
    expect(targets).toContain(mate.id as number);   // ★ 没有「己方」之分
    expect(targets).not.toContain(foe.id as number);   // 死的不跟
    expect(targets).not.toContain(sneak.id as number); // 进不了观战段就跟不了
    expect(isLegalSpectateFollow(sneak)).toBe(false);
  });
});

describe('裁剪规则清单', () => {
  it('八条按接收者裁剪的规则都有登记（供文档与 review 对照）', () => {
    expect(CULLING_RULES.map((r) => r.id)).toEqual([
      '4.1', '4.2', '4.3-cooldown', '4.3-focus', '4.3-spectate',
      // W24 观战席：口径与理由见 `isVisibleToSpectator`
      '4.4-spectator',
      '8.5', '12.2',
    ]);
  });
});
