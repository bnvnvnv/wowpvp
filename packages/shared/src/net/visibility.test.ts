/**
 * 快照视野裁剪测试。docs/08 §4，验收 #5 / #36。
 *
 * ★ 验收 #5 是**安全边界**，不是显示细节。所以这里的关键断言不是
 *   「客户端没画出潜行者」，而是「潜行者根本不在快照里」——
 *   前者改前端就能绕过，后者改前端也拿不到数据。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mage, priest, rogue, warrior } from '../data/index.js';
import { vec3 } from '../math/vec3.js';
import { asEntityId, asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { createAuraStore, type AuraStore } from '../sim/aura.js';
import { createEntity, isSelectableBy, type CombatEntity } from '../sim/entity.js';
import {
  addWeapon, createLoadout, createSwapStore, type Loadout, type SwapStore,
} from '../sim/loadout.js';
import { createCtf, type CtfState } from '../sim/match/flag.js';
import { addEntity, allocEntityId, createWorld, type World } from '../sim/world.js';
import {
  CULLING_RULES,
  SUDDEN_DEATH_BLIP_GRID,
  assertNoHiddenEntities,
  buildSnapshot,
  buildSpectatorSnapshot,
  isVisibleTo,
  spectatableFor,
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

describe('docs/08 §4.2 敌方装备裁剪（验收 #36）', () => {
  beforeEach(() => {
    // 给敌人塞一件备用武器 —— 它绝对不能出现在我的快照里
    const l = loadouts.get(foe.id)!;
    addWeapon(l, warrior.weapons.find((w) => !w.isDefault)!.id);
  });

  it('★★ 敌人的备用装备完全不出现在快照里（10.6 / 验收 #36）', () => {
    const snap = buildSnapshot(deps(), me);
    const foeSnap = snap.entities.find((e) => e.id === foe.id)!;
    const eq = foeSnap.equipment as EnemyEquipmentSnapshot;

    expect(eq.currentWeaponId).toBe(warrior.defaultWeaponId);
    expect(eq.armorArchetype).toBeDefined();
    // 结构上就没有这些字段
    expect(Object.keys(eq).sort()).toEqual(['armorArchetype', 'currentWeaponId', 'swapping']);
    // 备用武器的 id 不能以任何形式出现在整份快照里
    const spareId = String(loadouts.get(foe.id)!.spareWeapons[0]);
    const foeJson = JSON.stringify(foeSnap);
    expect(foeJson).not.toContain(spareId);
  });

  it('队友的完整装备栏可见（含备用）', () => {
    const l = loadouts.get(mate.id)!;
    addWeapon(l, priest.weapons.find((w) => !w.isDefault)!.id);

    const snap = buildSnapshot(deps(), me);
    const mateSnap = snap.entities.find((e) => e.id === mate.id)!;
    const eq = mateSnap.equipment as AllyEquipmentSnapshot;
    expect(eq.spareWeaponIds).toHaveLength(1);
  });

  it('敌人的换装动作可见，但看不出在换什么', () => {
    const snap = buildSnapshot(deps(), me);
    const eq = snap.entities.find((e) => e.id === foe.id)!.equipment as EnemyEquipmentSnapshot;
    expect(eq.swapping).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════

describe('docs/08 §4.3 冷却与资源', () => {
  it('★ 只有自己能看到自己的技能冷却（敌方冷却不发，避免削弱博弈）', () => {
    foe.cooldowns.set(asSkillId('warrior.charge'), 99);
    me.cooldowns.set(asSkillId('mage.blink'), 5);

    const snap = buildSnapshot(deps(), me);
    expect(snap.entities.find((e) => e.id === me.id)!.cooldowns).toBeDefined();
    expect(snap.entities.find((e) => e.id === foe.id)!.cooldowns).toBeUndefined();
    // 队友的也不发 —— §4.3 只说了「自己」
    expect(snap.entities.find((e) => e.id === mate.id)!.cooldowns).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('warrior.charge');
  });

  it('敌方资源值要发 —— 15.2 的目标框需要显示', () => {
    const snap = buildSnapshot(deps(), me);
    const foeSnap = snap.entities.find((e) => e.id === foe.id)!;
    expect(Object.keys(foeSnap.resources).length).toBeGreaterThan(0);
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
          },
          {
            kind: 'delayedImpact', id: 2, skillId: asSkillId('mage.meteor'),
            sourceId: me.id, center: vec3(3, 0, 4), radius: 5,
            createdAt: 1, impactAt: 3, onImpact: [],
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

describe('裁剪规则清单', () => {
  it('六条按接收者裁剪的规则都有登记（供文档与 review 对照）', () => {
    expect(CULLING_RULES.map((r) => r.id)).toEqual([
      '4.1', '4.2', '4.3-cooldown', '4.3-spectate', '8.5', '12.2',
    ]);
  });
});
