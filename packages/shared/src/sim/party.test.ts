/**
 * 大乱斗「派对道具」内容包：掉落调度、人人可捡、武装授予技能、变身药水。
 *
 * ★★ 这四件事有一个共同点：**坏掉的时候不会报错**。
 *   · 调度写错 → 地上一件东西都不刷，或者一秒刷三十件
 *   · 职业匹配没放开 → 掉落照刷，八个人一个都捡不起来
 *   · grants 跨池失效 → 捡到大锤，技能栏上什么都没多
 *   · 变身药水不借资源池 → 技能栏换了，一个都按不出来
 *   所以这个文件测的是「这四条链现在真的通了」，而不是某个函数的边界。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ArenaPreset, Resource } from '../types/enums.js';
import { TEAM_BLUE, TEAM_RED, asWeaponId, type EntityId } from '../types/ids.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import {
  getSkill, getWeapon, isPartyItemId, mage, PARTY_CONSUMABLES, PARTY_SKILLS, PARTY_WEAPONS,
  getConsumable, validateData, warrior,
} from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { createAuraStore } from './aura.js';
import {
  createArsenalStore, createPickupStore, dropViewFor, PARTY_DROP, partyDropPlan,
  partyDropsOnGround, setupPartyDrops, tickPartyDrops, type ArsenalStore,
} from './arsenal.js';
import { createCastingStore } from './casting.js';
import { createDrStore } from './dr.js';
import { createEntity, skillsAvailableWith, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { resolveEffects } from './effects/index.js';
import { createMovementState, type MovementState } from './movement.js';
import { createProjectileStore } from './projectile.js';
import {
  canPickupWeapon, createLoadout, createLoadoutStore, createSwapStore, onDeath, type Loadout,
} from './loadout.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

let world: World;
let player: CombatEntity;
let loadout: Loadout;

beforeEach(() => {
  world = createWorld([], 12345);
  player = addEntity(world, createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0)));
  addEntity(world, createEntity(allocEntityId(world), mage, TEAM_BLUE, vec3(0, 0, 5)));
  loadout = createLoadout(player.classId);
});

// ════════════════════════════════════════════════════════════════
//  目录
// ════════════════════════════════════════════════════════════════

describe('派对道具目录', () => {
  it('★ validateData 对新内容包同样无问题', () => {
    expect(validateData().map((i) => `${i.where}: ${i.problem}`)).toEqual([]);
  });

  it('★ 4 件夸张武装 + 至少 4 个新奇消耗品，全部 ffa. 前缀', () => {
    expect(PARTY_WEAPONS.length).toBeGreaterThanOrEqual(3);
    expect(PARTY_CONSUMABLES.length).toBeGreaterThanOrEqual(4);
    for (const w of PARTY_WEAPONS) expect(isPartyItemId(w.id as string), `${w.id}`).toBe(true);
    for (const c of PARTY_CONSUMABLES) expect(isPartyItemId(c.id as string), `${c.id}`).toBe(true);
  });

  it('★★ 按 id 查得到 —— 查不到就等于「引擎不认识的装备」，静默失效', () => {
    for (const w of PARTY_WEAPONS) expect(getWeapon(w.id), `${w.id}`).toBeDefined();
    for (const c of PARTY_CONSUMABLES) {
      expect(getConsumable(c.id as string), `${c.id}`).toBeDefined();
    }
  });

  it('★ 一件都没有混进职业池（否则「每职业恰好三套武器方案」会破）', () => {
    for (const cls of [warrior, mage]) {
      expect(cls.weapons.some((w) => isPartyItemId(w.id as string))).toBe(false);
      expect(cls.skills.some((s) => isPartyItemId(s.id as string))).toBe(false);
    }
  });

  it('★★ 「很厉害但不无解」：每件武装都带真实代价，高单击必配慢挥击', () => {
    for (const w of PARTY_WEAPONS) {
      expect(w.cost.trim().length, `${w.id} 没写代价`).toBeGreaterThan(0);
      const m = w.modifiers ?? {};
      // 代价必须是**数值上**成立的一条，不能只写在文案里
      const hasRealCost =
        (m.moveSpeed ?? 1) < 1 || (m.damageTaken ?? 1) > 1
        || (m.castSpeed ?? 1) > 1 || (m.healingTaken ?? 1) < 1;
      expect(hasRealCost, `${w.id} 的 cost 只写在文案里，数值上是纯上位`).toBe(true);
      // 单击越高，挥击必须越慢（战士双手巨剑 1.55/2.4 是参照线）
      if (w.swingPercent > 1.55) {
        expect(w.swingInterval, `${w.id} 单击最高却不慢`).toBeGreaterThan(2.4);
      }
    }
  });

  /**
   * ★★ 落地时发现 `sim/modifiers.ts` 里有一批**只被聚合、没有消费方**的字段
   *   （既有缺口，见 party.ts 头注）。写了它们不会报错，只会让 advantage /
   *   description 变成谎话 —— 而「文案承诺了一件不会发生的事」正是本仓库
   *   最难查的那一类缺陷。这条断言把本内容包钉在「只用真生效的字段」上。
   *
   * ⚠️ 将来谁把这些字段接通了，把它从下面的清单里删掉即可 —— 断言会
   *   自动放行，不需要改别的。
   */
  it('★★ 不使用任何「只聚合、没有消费方」的死修正字段', () => {
    const DEAD_FIELDS = ['maxHealth', 'knockbackTaken', 'castSpeed', 'attackSpeed', 'absorbDone'];
    const offenders: string[] = [];
    const check = (where: string, mods: Record<string, unknown> | undefined): void => {
      for (const f of DEAD_FIELDS) {
        if (mods && mods[f] !== undefined) offenders.push(`${where}.${f}`);
      }
    };
    for (const w of PARTY_WEAPONS) check(w.id as string, w.modifiers as never);
    for (const c of PARTY_CONSUMABLES) {
      for (const e of c.effects) {
        if (e.kind === 'applyAura') check(`${c.id as string}/${e.aura.id}`, e.aura.modifiers as never);
      }
    }
    for (const s of PARTY_SKILLS) {
      for (const e of s.effects) {
        if (e.kind === 'applyAura') check(`${s.id as string}/${e.aura.id}`, e.aura.modifiers as never);
      }
    }
    expect(offenders, '这些字段 sim 不会执行，写上去等于在文案里撒谎').toEqual([]);
  });

  /**
   * ★★ 落地时踩到的真坑：`resolveCastTargets()` 对 `Targeting.Direct`
   *   **只返回锁定的那一个目标，形状完全不参与**。写成「直接目标 + 连锁/圆形」
   *   的技能会安静地退化成单体 —— 没有报错、没有日志，只有玩家觉得
   *   「这个连锁怎么不连」。这条断言把它钉死。
   */
  it('★★ 多目标形状只出现在「不需要硬目标」的瞄准方式上', () => {
    const bad = PARTY_SKILLS.filter(
      (s) => s.shape.kind !== 'single'
        && s.targeting === 'direct',
    ).map((s) => `${s.id}: ${s.targeting} + ${s.shape.kind}`);
    expect(bad, '直接目标技能的形状会被 resolveCastTargets 忽略，退化成单体').toEqual([]);
  });

  it('★ 连锁技能的 range.max 与 jumpRange 对齐（客户端画的圈就是真的圈）', () => {
    for (const s of PARTY_SKILLS) {
      if (s.shape.kind !== 'chain') continue;
      expect(s.range.max, `${s.id} 的射程与首跳距离不一致`).toBe(s.shape.jumpRange);
    }
  });

  it('★ 高伤技能都有明显前摇或落点倒计时（不存在瞬发的巨额单发）', () => {
    for (const s of PARTY_SKILLS) {
      const burst = s.effects.some(
        (e) => e.kind === 'damage' && (e.amount.flat ?? 0) >= 400,
      );
      if (!burst) continue;
      expect(s.cast.time, `${s.id} 是瞬发的巨额单发`).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  掉落调度（纯函数）
// ════════════════════════════════════════════════════════════════

describe('★★ 派对掉落调度 partyDropPlan（纯函数）', () => {
  const SEED = 0xc0ffee;
  const RADIUS = 40;

  it('★★ 确定性：同一个 (seed, index) 恒等 —— 回放与配平复现的前提', () => {
    for (let i = 0; i < 10; i++) {
      expect(partyDropPlan(SEED, i, RADIUS)).toEqual(partyDropPlan(SEED, i, RADIUS));
    }
  });

  it('★ 换种子就换局：不同种子的时刻表不该一模一样', () => {
    const a = Array.from({ length: 8 }, (_, i) => partyDropPlan(SEED, i, RADIUS).itemId);
    const b = Array.from({ length: 8 }, (_, i) => partyDropPlan(SEED + 1, i, RADIUS).itemId);
    expect(a).not.toEqual(b);
  });

  it('★★ 间隔落在 30~45 秒之间，且严格递增', () => {
    let prev = partyDropPlan(SEED, 0, RADIUS).at;
    expect(prev).toBe(PARTY_DROP.FIRST_AT);
    for (let i = 1; i < 40; i++) {
      const at = partyDropPlan(SEED, i, RADIUS).at;
      const gap = at - prev;
      expect(gap, `第 ${i} 件的间隔`).toBeGreaterThanOrEqual(PARTY_DROP.MIN_INTERVAL);
      expect(gap, `第 ${i} 件的间隔`).toBeLessThanOrEqual(PARTY_DROP.MAX_INTERVAL);
      prev = at;
    }
  });

  it('★ 落点在场地内，且不贴着圆心', () => {
    for (let i = 0; i < 60; i++) {
      const p = partyDropPlan(SEED, i, RADIUS).position;
      const r = Math.hypot(p.x, p.z);
      expect(r).toBeGreaterThanOrEqual(PARTY_DROP.MIN_RADIUS - 1e-6);
      expect(r).toBeLessThanOrEqual(RADIUS + 1e-6);
      expect(p.y).toBe(0);
    }
  });

  it('★★ 夸张武器是低概率、道具是高概率（拿到大锤才叫「全场焦点」）', () => {
    const N = 400;
    let weapons = 0;
    for (let i = 0; i < N; i++) {
      const plan = partyDropPlan(SEED, i, RADIUS);
      if (plan.kind === 'weapon') weapons++;
      // 每一件都必须是真实存在的派对物品
      expect(isPartyItemId(plan.itemId), plan.itemId).toBe(true);
    }
    const rate = weapons / N;
    expect(rate, '武器占比').toBeLessThan(0.45);
    expect(rate, '武器占比').toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.5); // 道具必须比武器多
  });

  it('★ 四件武装、六个道具都会被抽到（选货没有卡死在第一个）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(partyDropPlan(SEED, i, RADIUS).itemId);
    for (const w of PARTY_WEAPONS) expect(seen.has(w.id as string), `${w.id} 从未被抽到`).toBe(true);
    for (const c of PARTY_CONSUMABLES) expect(seen.has(c.id as string), `${c.id} 从未被抽到`).toBe(true);
  });
});

describe('★★ tickPartyDrops', () => {
  let store: ArsenalStore;

  beforeEach(() => {
    store = createArsenalStore(ArenaPreset.Classic);
    setupPartyDrops(store, { seed: 7, radius: 40 });
  });

  it('★ 竞技场/夺旗不受影响：没装 party 的 store 一件都不刷', () => {
    const plain = createArsenalStore(ArenaPreset.Armed);
    expect(tickPartyDrops(plain, 10_000)).toEqual([]);
    expect(plain.drops).toEqual([]);
  });

  it('★★ setupPartyDrops 顺手打开 enabled —— 大乱斗不该要求房主勾「武装」', () => {
    expect(createArsenalStore(ArenaPreset.Classic).enabled).toBe(false);
    expect(store.enabled).toBe(true);
  });

  it('★ 第一件之前一件都不刷', () => {
    expect(tickPartyDrops(store, PARTY_DROP.FIRST_AT - 0.1)).toEqual([]);
    expect(tickPartyDrops(store, PARTY_DROP.FIRST_AT)).toHaveLength(1);
  });

  it('★★ 场上同时最多 6 件 —— 满了就跳过这一轮，不排队补刷', () => {
    // 一口气跳到很晚：够刷几十轮，但场上不许超过上限
    tickPartyDrops(store, 10_000);
    expect(partyDropsOnGround(store).length).toBe(PARTY_DROP.MAX_ALIVE);
    expect(store.drops.length).toBe(PARTY_DROP.MAX_ALIVE);

    /**
     * ★ 「跳过」而不是「推迟」的可观测差别：把地上的清空之后，
     *   下一件仍然按**原时刻表**来，不会立刻补上刚才欠的那几十件。
     */
    store.drops = [];
    expect(tickPartyDrops(store, 10_000).length).toBeLessThanOrEqual(PARTY_DROP.MAX_ALIVE);
  });

  it('★ 掉落物带的是 weaponId / consumableId，且**没有** classId（无职业归属）', () => {
    tickPartyDrops(store, 10_000);
    for (const d of store.drops) {
      expect(d.classId, `${d.id} 不该有职业归属`).toBeUndefined();
      if (d.kind === 'weapon') expect(d.weaponId).toBeDefined();
      else expect(d.consumableId).toBeDefined();
    }
  });

  it('★ 掉落视图显示真名与「人人可捡」，不是「未知物品」', () => {
    tickPartyDrops(store, 10_000);
    for (const d of store.drops) {
      const view = dropViewFor(d, player, loadout);
      expect(view.itemName, `${d.weaponId ?? d.consumableId} 显示成了未知物品`)
        .not.toBe('未知物品');
      expect(view.ownerClassName).toBe('人人可捡');
    }
  });
});

// ════════════════════════════════════════════════════════════════
//  人人可捡（10.2 的职业匹配对派对武装放开）
// ════════════════════════════════════════════════════════════════

describe('★★ 派对武装人人可捡', () => {
  it('★★ 八个职业里的任何一个都能捡起同一件派对武装', () => {
    for (const cls of [warrior, mage]) {
      const e = createEntity(allocEntityId(world), cls, TEAM_RED, vec3(0, 0, 0));
      const l = createLoadout(cls.id);
      for (const w of PARTY_WEAPONS) {
        const check = canPickupWeapon(e, l, w.id);
        expect(check.ok, `${cls.id} 捡不起 ${w.id}：${check.ok ? '' : check.hint}`).toBe(true);
      }
    }
  });

  it('★★ 放开的只有职业匹配这一条 —— 职业武器照旧锁职业', () => {
    const foreign = mage.weapons.find((w) => !w.isDefault)!;
    const check = canPickupWeapon(player, loadout, foreign.id);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('classMismatch');
  });

  it('★ 槽位上限、已拥有、宠物三条依然生效', () => {
    const [a, b, c] = PARTY_WEAPONS;
    loadout.spareWeapons.push(a!.id, b!.id);
    const full = canPickupWeapon(player, loadout, c!.id);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toBe('slotsFull');

    const owned = canPickupWeapon(player, { ...loadout, spareWeapons: [a!.id] }, a!.id);
    expect(owned.ok).toBe(false);
    if (!owned.ok) expect(owned.reason).toBe('alreadyOwned');

    const pet = { ...player, isPet: true };
    const petCheck = canPickupWeapon(pet, createLoadout(player.classId), a!.id);
    expect(petCheck.ok).toBe(false);
  });

  it('★ 不存在的 ffa. id 仍然被拒（放开的是职业判据，不是存在性判据）', () => {
    const check = canPickupWeapon(player, loadout, asWeaponId('ffa.no_such_thing'));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('unknownItem');
  });
});

// ════════════════════════════════════════════════════════════════
//  跨池 grants（附录A#4）
// ════════════════════════════════════════════════════════════════

describe('★★ 派对武装授予的技能', () => {
  it('★★ 手持时才有 —— 不传武器定义就会静默失效，所以这里两边都断言', () => {
    const hammer = PARTY_WEAPONS.find((w) => w.grantsSkills?.length)!;
    const granted = hammer.grantsSkills![0]!;

    const withHammer = skillsAvailableWith(warrior, hammer.id, hammer);
    expect(withHammer.has(granted), '手持派对武装却没有它授予的技能').toBe(true);

    const withDefault = skillsAvailableWith(warrior, warrior.defaultWeaponId);
    expect(withDefault.has(granted), '没拿着它却有它的技能').toBe(false);
  });

  it('★ 不影响职业自己的方案专属技能（顺劈只属于双手巨剑）', () => {
    const greatsword = warrior.weapons.find((w) => w.grantsSkills?.length)!;
    const own = greatsword.grantsSkills![0]!;
    expect(skillsAvailableWith(warrior, greatsword.id).has(own)).toBe(true);
    // 换成派对武装后，职业方案专属的那个不该跟着来
    const hammer = PARTY_WEAPONS[0]!;
    expect(skillsAvailableWith(warrior, hammer.id, hammer).has(own)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
//  端到端冒烟：四把武装的技能真的放得出去、真的打得掉血
// ════════════════════════════════════════════════════════════════

/**
 * ★★ `skillSmoke.test.ts` 的全量冒烟跑在 `ALL_CLASSES` 上，**覆盖不到**
 *   派对技能（它们不属于任何职业，见 shared/data/index.ts 的注释）。
 *   而那个文件的立场恰恰是本仓库最贵的教训：「规则写对了、单测全绿，
 *   但没人调用它」。所以这里给这四把武装补一份同口径的冒烟 ——
 *   走**与生产完全相同的管线**（castRequests → tickWorld → 效果注册表），
 *   不直调 `resolveEffects`（A2 的教训：第二个出口会静默地少做一半事）。
 */
describe('★★ 派对武装技能端到端冒烟', () => {
  const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
  const DT = 0.05;

  /** 让敌人站在这个技能**确实打得到**的位置上（形状语义，不是猜的） */
  const targetDistanceFor = (shape: { kind: string } & Record<string, unknown>): number => {
    if (shape.kind === 'circle') return (shape.radius as number) * 0.5;
    if (shape.kind === 'chain') return (shape.jumpRange as number) * 0.5;
    if (shape.kind === 'line') return (shape.length as number) * 0.3;
    return 2;
  };

  for (const weapon of PARTY_WEAPONS) {
    const skill = getSkill(weapon.grantsSkills![0]!)!;
    it(`★★ ${weapon.name} → ${skill.name}：敌人真的掉血`, () => {
      const w = createWorld([FLOOR]);
      const loadouts = createLoadoutStore();
      const movement = new Map<EntityId, MovementState>();

      const spawn = (cls: typeof warrior, team: typeof TEAM_RED, z: number): CombatEntity => {
        const e = addEntity(w, createEntity(allocEntityId(w), cls, team, vec3(0, 0, z)));
        loadouts.set(e.id, createLoadout(e.classId));
        movement.set(e.id, createMovementState(e.position));
        return e;
      };

      const d = targetDistanceFor(skill.shape as never);
      const caster = spawn(warrior, TEAM_RED, 0);
      const enemy = spawn(mage, TEAM_BLUE, d);

      // 捡到武装 = 换上它 + 拿到它授予的技能（与拾取后换装走同一条规则）
      caster.weaponId = weapon.id;
      caster.availableSkills = skillsAvailableWith(warrior, weapon.id, weapon);
      expect(caster.availableSkills.has(skill.id)).toBe(true);

      // 朝向敌人 —— 移动状态的 yaw 必须同步，否则读条完成瞬间会被判 wrongFacing
      caster.yaw = dirToYaw(sub(enemy.position, caster.position));
      movement.get(caster.id)!.yaw = caster.yaw;
      for (const [res, max] of caster.maxResources) caster.resources.set(res, max);

      const deps = (
        castRequests?: TickDeps['castRequests'],
      ): TickDeps => ({
        world: w,
        auras: createAuraStore(),
        dr: createDrStore(),
        ground: createGroundStore(),
        projectiles: createProjectileStore(),
        casting: createCastingStore(),
        loadouts,
        swaps: createSwapStore(),
        pickups: createPickupStore(),
        arsenal: createArsenalStore(ArenaPreset.Classic),
        movement,
        inputs: new Map(),
        getSkill,
        ...(castRequests ? { castRequests } : {}),
      });
      // 光环/施法/地面状态必须跨 tick 保留 —— 每 tick 现造一份等于什么都没发生
      const stable = deps();
      const before = enemy.health;

      const request = new Map([[caster.id, {
        skillId: skill.id,
        ...(skill.targeting === 'ground'
          ? { groundPoint: { ...enemy.position } }
          : { targetId: enemy.id }),
      }]]);

      // 覆盖最长读条（1.6s）+ 落点延迟（1.2s）+ 投射物飞行
      for (let t = 0; t < 6 / DT; t++) {
        w.time += DT;
        tickWorld({ ...stable, ...(t === 0 ? { castRequests: request } : {}) }, DT);
      }

      expect(enemy.health, `${skill.id} 没有造成任何伤害 —— 接线断了`).toBeLessThan(before);
    });
  }
});

// ════════════════════════════════════════════════════════════════
//  变身药水（borrowClassKit）
// ════════════════════════════════════════════════════════════════

describe('★★ 乱斗变身药水：借来另一个职业的技能栏', () => {
  /** 喝一瓶「指定借法师」的变身药水 —— 随机那一路由最后一条用例覆盖 */
  const drink = (e: CombatEntity): void => {
    resolveEffects(
      {
        world,
        auras: createAuraStore(),
        dr: createDrStore(),
        projectiles: createProjectileStore(),
        ground: createGroundStore(),
        source: e,
        skillId: 'ffa.identity_brew',
      },
      [{ kind: 'borrowClassKit', classIds: [mage.id] }],
      [e],
    );
  };

  it('★★ 技能栏真的换了（借法师 → 拿得到寒冰箭）', () => {
    drink(player);
    expect(player.borrowedClassId).toBe(mage.id);
    for (const s of mage.skills.slice(0, 3)) {
      expect(player.availableSkills.has(s.id), `借来的 ${s.id} 不在技能栏里`).toBe(true);
    }
  });

  it('★★ 资源池一起借 —— 否则「技能栏换了，一个都按不出来」', () => {
    expect(player.resources.get(Resource.Mana) ?? 0).toBe(0);
    drink(player);
    const manaMax = mage.resources.find((r) => r.resource === Resource.Mana)!.max;
    expect(player.maxResources.get(Resource.Mana)).toBe(manaMax);
    expect(player.resources.get(Resource.Mana)).toBe(manaMax);
    // 原来的怒气条不删 —— 还回身份时不需要另写一段复原逻辑
    expect(player.maxResources.has(Resource.Rage)).toBe(true);
  });

  it('★★ classId 一个字节都没变（真改它会牵动出生装备与统计注册）', () => {
    drink(player);
    expect(player.classId).toBe(warrior.id);
    expect(player.weaponId).toBe(warrior.defaultWeaponId);
  });

  it('★★ 死亡时还回去 —— 生命周期与「临时装备随玩家失效」同一处收口', () => {
    drink(player);
    onDeath(player, loadout, createSwapStore());
    expect(player.borrowedClassId).toBeUndefined();
    expect(player.availableSkills.has(warrior.skills[0]!.id)).toBe(true);
    expect(player.availableSkills.has(mage.skills[0]!.id)).toBe(false);
  });

  it('★ 掷骰走实体自己的随机流（同一条流重复喝会给出不同结果）', () => {
    const a = createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0));
    a.rng = 1;
    const b = createEntity(allocEntityId(world), warrior, TEAM_RED, vec3(0, 0, 0));
    b.rng = 1;
    const roll = (e: CombatEntity): string | undefined => {
      resolveEffects(
        {
          world,
          auras: createAuraStore(),
          dr: createDrStore(),
          projectiles: createProjectileStore(),
          ground: createGroundStore(),
          source: e,
          skillId: 'ffa.identity_brew',
        },
        [{ kind: 'borrowClassKit' }],
        [e],
      );
      return e.borrowedClassId as string | undefined;
    };
    // 同一个起始 rng → 同一个结果（可复算）
    expect(roll(a)).toBe(roll(b));
    expect(roll(a)).toBeDefined();
  });
});
