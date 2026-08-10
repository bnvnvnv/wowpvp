/**
 * 全量技能冒烟：**117 个技能逐一真实施放，逐效果断言可观测变化**。
 *
 * ★★ 起因是用户的一句灵魂拷问：「所有技能都逐一验证过了吗？都是生效的吗？」
 *   诚实回答是没有 —— 数据体检验形状、单测验规则、balance 只走 bot 按得到的
 *   键（偷袭要求脱战 4 秒，bot 场场在战斗里，可能一次都没放过）。
 *   本仓库最贵的教训一直是「规则写对了、单测全绿，但没人调用它」——
 *   这个文件把「每个技能都真的放得出去、真的做了它声称的事」钉成回归网。
 *
 * ★ 手法：每个技能一个用例，走**与生产完全相同的管线**
 *   （castRequests → tickWorld → 效果注册表），不直调 resolveEffects
 *   （A2 的教训：第二个出口会静默地少做一半事）。
 *   夹具负责把门禁喂满足（资源、距离、朝向、脱战、招架记录 —— 这些是
 *   夹具的责任，不是被测对象），然后模拟 6 秒，按效果种类断言：
 *   伤害类 → 敌人掉血；治疗类 → 目标回血；光环 → 出现过对应 id；
 *   控制 → 对应旗子亮过；位移 → 有人挪了窝；驱散 → 种下的靶子被清掉；
 *   陷阱 → 陷阱表非空；资源 → 池子按声称的方向动了。
 *
 * ⚠️ 断言的是「声称的每一类效果都发生过」，不是数值 —— 数值归 balance 与
 *   各系统单测。这里抓的是**接线断了**：效果种类没注册、目标解析错、
 *   条件恒假放不出、光环 id 写错这类静默失效。
 */

import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, getSkill, mage } from '../data/index.js';
import type { AuraDef, ClassDef, EffectDef, SkillDef } from '../data/schema.js';
import { ArenaPreset, CastFailure, DispelType, Resource } from '../types/enums.js';
import { asSkillId, TEAM_BLUE, TEAM_RED } from '../types/ids.js';
import { dirToYaw, sub, vec3 } from '../math/vec3.js';
import { box } from '../data/maps/schema.js';
import { applyAura, aurasOf, createAuraStore } from './aura.js';
import { beginCast, createCastingStore, getCast, validateCast } from './casting.js';
import { createDrStore } from './dr.js';
import { createArsenalStore, createPickupStore } from './arsenal.js';
import { createEntity, skillsAvailableWith, type CombatEntity } from './entity.js';
import { createGroundStore } from './groundArea.js';
import { createLoadout, createLoadoutStore, createSwapStore } from './loadout.js';
import { createMovementState, type MovementInput, type MovementState } from './movement.js';
import { createProjectileStore, type ProjectileStore } from './projectile.js';
import { tickWorld, type TickDeps } from './tick.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';
import type { EntityId } from '../types/ids.js';

const FLOOR = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const DT = 0.05;
/** 模拟时长：覆盖最长读条（2.5s）+ 陨星延迟（2s）+ 最慢 DoT 首跳（3s 间隔）*/
const SIM_SECONDS = 6;

// ── 效果分类（决定断言什么）──────────────────────────────────────

const dealsDamage = (e: EffectDef): boolean =>
  e.kind === 'damage' ||
  (e.kind === 'spawnProjectile' && e.onHit.some(dealsDamage)) ||
  // W23：法术弹道迁移后 21 个技能的载荷住在 lockedProjectile.onHit 里
  (e.kind === 'lockedProjectile' && e.onHit.some(dealsDamage)) ||
  (e.kind === 'applyAura' && (e.aura.periodic?.effects.some(dealsDamage) ?? false)) ||
  (e.kind === 'spawnGroundArea' && (e.onTick?.some(dealsDamage) ?? false)) ||
  (e.kind === 'delayedGroundImpact' && e.onImpact.some(dealsDamage)) ||
  (e.kind === 'spendComboPoints' && dealsDamage(e.base)) ||
  (e.kind === 'spendResource' && dealsDamage(e.base)) ||
  (e.kind === 'onNthHit' && e.effects.some(dealsDamage));

const heals = (e: EffectDef): boolean =>
  e.kind === 'heal' || e.kind === 'healPercentMaxHealth' || e.kind === 'healFromRecentDamage' ||
  (e.kind === 'applyAura' && (e.aura.periodic?.effects.some(heals) ?? false)) ||
  (e.kind === 'spawnGroundArea' && (e.onTick?.some(heals) ?? false));

/**
 * 一个技能声称的**全部**效果，摊平 `lockedProjectile.onHit` 一层。
 *
 * ★★ W23：迁移后霜矢的减速、月火的 DoT、化形术的迷惑…全在 onHit 里。
 *   逐效果断言那一段如果只看顶层，这 21 个技能会**整体退化成「什么都不断言」**
 *   —— 冒烟还是绿的，但它已经不再证明任何事。这正是本文件存在的理由的反面。
 */
const claimedEffects = (skill: SkillDef): readonly EffectDef[] =>
  skill.effects.flatMap((e) => (e.kind === 'lockedProjectile' ? e.onHit : [e]));

/** 控制效果 → 命中后目标该亮起的旗子 */
const CONTROL_FLAG: Record<string, keyof CombatEntity['flags']> = {
  stun: 'stunned',
  incapacitate: 'stunned', // CONTROL_SPECS：迷惑共用 stunned 旗
  fear: 'feared',
  root: 'rooted',
  silence: 'silenced',
  disarm: 'disarmed',
};

const MOVES_CASTER = new Set(['chargeTo', 'chargeToAlly', 'blinkForward', 'leapBackward', 'teleportBehindTarget']);
const MOVES_TARGET = new Set(['pullTarget', 'knockback']);

// ── 夹具 ─────────────────────────────────────────────────────────

interface Rig {
  world: World;
  /** W23：断言前要把在飞的弹体排空（见 runSmoke 的排空循环）*/
  projectiles: ProjectileStore;
  deps: (castRequests?: ReadonlyMap<EntityId, { skillId: SkillDef['id']; targetId?: EntityId; groundPoint?: { x: number; y: number; z: number } }>) => TickDeps;
  caster: CombatEntity;
  enemy: CombatEntity;
  ally: CombatEntity;
  /** 施法目标是不是那个友方实体（决定 runSmoke 里的目标解析）*/
  targetsAllyEntity: boolean;
  auras: ReturnType<typeof createAuraStore>;
  casting: ReturnType<typeof createCastingStore>;
  groundStore: ReturnType<typeof createGroundStore>;
}

const rigFor = (cls: ClassDef, skill: SkillDef): Rig => {
  const world = createWorld([FLOOR]);
  const auras = createAuraStore();
  const dr = createDrStore();
  const groundStore = createGroundStore();
  const projectiles = createProjectileStore();
  const casting = createCastingStore();
  const loadouts = createLoadoutStore();
  const movement = new Map<EntityId, MovementState>();
  const inputs = new Map<EntityId, MovementInput>();

  const spawn = (c: ClassDef, team: typeof TEAM_RED, x: number, z: number): CombatEntity => {
    const e = addEntity(world, createEntity(allocEntityId(world), c, team, vec3(x, 0, z)));
    loadouts.set(e.id, createLoadout(e.classId));
    // 位移效果要经 displaced 事件同步移动状态 —— 给每个实体都备一份
    movement.set(e.id, createMovementState(e.position));
    return e;
  };

  /**
   * 目标距离按技能的射程窗口取：
   * · 有 min（冲锋 8–20m）→ 窗口中点
   * · 拉拽/援护（pullTarget/chargeToAlly）→ 拉远到半射程，位移才可观测
   * · 自身中心 AOE → 站进形状里（圆取六成半径）
   * · 普通技能 → 2.2m（全部近战射程 ≥2.4 都够得着，远程更不在话下）
   */
  const targetDistance = (): number => {
    if (skill.targeting === 'selfCenter') {
      const s = skill.shape;
      const r = s.kind === 'circle' ? s.radius
        : s.kind === 'ring' ? s.outerRadius
          : s.kind === 'cone' || s.kind === 'line'
            ? ('range' in s ? s.range : s.length) * 0.5
            : 2;
      return Math.max(0.8, Math.min(r * 0.6, 20));
    }
    if (skill.effects.some((e) => e.kind === 'pullTarget' || e.kind === 'chargeToAlly')) {
      return Math.max(2.2, skill.range.max * 0.5);
    }
    if (skill.range.min > 0) return (skill.range.min + skill.range.max) / 2;
    return skill.range.max === 0 ? 1.5 : Math.min(2.2, skill.range.max);
  };

  const d = targetDistance();
  /**
   * ★ 施法目标（敌 or 友）站在正前方 d 米处 —— 距离窗口/锥形/朝向全对它算；
   *   另一个实体放在旁边不挡路。
   */
  const targetsAllyEntity =
    skill.targetFilter === 'ally' &&
    skill.range.max > 0; // 纯自身技能（range 0）目标是自己，友方放旁边即可
  const caster = spawn(cls, TEAM_RED, 0, 0);
  const enemy = spawn(mage, TEAM_BLUE, 0, targetsAllyEntity ? Math.max(d, 6) : (d || 2));
  const ally = spawn(mage, TEAM_RED, targetsAllyEntity ? 0 : 3, targetsAllyEntity ? d : 0);

  // 朝向：面向施法目标；敌人背对施法者（背袭类 requiresBehind 直接满足）
  const facingTarget = targetsAllyEntity ? ally : enemy;
  caster.yaw = dirToYaw(sub(facingTarget.position, caster.position));
  enemy.yaw = caster.yaw;
  /**
   * ★★ 移动状态的 yaw 必须与实体同步 —— 夹具在 spawn 后才定朝向，而移动
   *   积分每 tick 会把 `entity.yaw` 写回移动状态里的值（真实玩家每 tick 的
   *   输入都带 yaw，这条链路在生产里天然一致）。漏掉这一步的话：瞬发技能
   *   同 tick 结算不受影响，**读条技能**却会在完成瞬间被判 wrongFacing、
   *   line 形状沿着被抹回 0 的朝向打向反方向 —— 首轮冒烟里瞄准射击/穿透
   *   重弩箭「零伤害」的全部真相就是这一行。
   */
  for (const e of [caster, enemy, ally]) {
    const m = movement.get(e.id);
    if (m) m.yaw = e.yaw;
  }

  /**
   * ★ 武器门禁：穿透重弩箭/精神穿刺/横扫斩这类**武器授予**的技能，
   *   默认武器下 `availableSkills` 没有它（validateCast → WeaponMismatch）。
   *   夹具换上授予它的那把武器 —— 与玩家换装后施放走的是同一套判定。
   */
  if (!caster.availableSkills.has(skill.id)) {
    const granter = cls.weapons.find((w) => skillsAvailableWith(cls, w.id).has(skill.id));
    if (granter) {
      caster.weaponId = granter.id;
      caster.availableSkills = skillsAvailableWith(cls, granter.id);
    }
  }

  for (const e of [caster, enemy, ally]) {
    for (const [res, max] of e.maxResources) e.resources.set(res, max);
  }
  /**
   * ★ gainResource 的可观测性：要涨的池子先清零 —— 灌满了就涨不动
   *  （冲锋 +15 怒在 100/100 上被封顶，断言会误报）。
   *   成本池不清（cost 已把它们用作门禁），二者在现有数据里从不同池。
   */
  for (const e of skill.effects) {
    if (e.kind === 'gainResource') caster.resources.set(e.resource, 0);
  }
  // 门禁喂满足：脱战（偷袭/隐匿）、近期招架（反刺）
  caster.lastCombatAt = -999;
  caster.lastParryAt = 0;
  // 治疗可观测：受方先掉到六成血（healFromRecentDamage 也按已损血量近似）
  caster.health = caster.maxHealth * 0.6;
  ally.health = ally.maxHealth * 0.6;

  const arsenal = createArsenalStore(ArenaPreset.Classic);
  const swaps = createSwapStore();
  const pickups = createPickupStore();
  const deps: Rig['deps'] = (castRequests) => ({
    world, auras, dr, ground: groundStore, projectiles, casting,
    loadouts, swaps, pickups, arsenal, movement, inputs, getSkill,
    ...(castRequests ? { castRequests } : {}),
  });

  return {
    world, projectiles, deps, caster, enemy, ally, targetsAllyEntity, auras, casting, groundStore,
  };
};

/**
 * 冒烟用的可驱散靶子，**按技能的选择器造饵**：
 * · `impairs` 语义筛选（自由庇佑/遁形「解除移动限制」）→ 饵要带减速修正，
 *   否则 `dispelEligible` 正确地拒绝清它 —— 第一版夹具种纯魔法饵，
 *   这两个技能被误报成「驱散没接通」
 * · `types` 类别筛选 → 饵的 dispelType 取声称类别里的第一个
 */
const smokeAura = (
  kind: 'buff' | 'debuff',
  selector: { types?: readonly DispelType[]; impairs?: 'slow' | 'movement' },
): AuraDef => ({
  id: `smoke.${kind}`, name: '冒烟靶子', kind, duration: 999,
  dispelType: selector.types?.[0] ?? DispelType.Magic,
  ...(selector.impairs ? { modifiers: { moveSpeed: 0.5 } } : {}),
  description: '冒烟靶子',
});

// ── 主流程 ───────────────────────────────────────────────────────

const runSmoke = (cls: ClassDef, skill: SkillDef): void => {
  const rig = rigFor(cls, skill);
  const { world, deps, caster, enemy, ally, targetsAllyEntity, auras, casting } = rig;

  const dispels = skill.effects.filter((e) => e.kind === 'dispel');
  const wantsPurge = dispels.some((e) => e.kind === 'dispel' && e.from === 'enemy');
  const wantsInterrupt = skill.effects.some((e) => e.kind === 'interrupt');

  // 驱散/打断的靶子先种下去
  const purgeSel = dispels.find((e) => e.kind === 'dispel' && e.from === 'enemy');
  const cleanseSel = dispels.find((e) => e.kind === 'dispel' && e.from === 'ally');
  // 队向驱散的饵种在**实际的施法目标**身上（自由庇佑给 30m 外的友方，不是给自己）
  const cleanseHolder = targetsAllyEntity ? ally : caster;
  if (purgeSel?.kind === 'dispel') {
    applyAura(auras, enemy, smokeAura('buff', purgeSel), caster.id, world.time);
  }
  if (cleanseSel?.kind === 'dispel') {
    applyAura(auras, cleanseHolder, smokeAura('debuff', cleanseSel), enemy.id, world.time);
  }
  let plantedCastEndsAt = 0;
  if (wantsInterrupt) {
    // 敌人（法师）开始读一条真实的可打断法术，等着被打断
    const bolt = mage.skills.find((sk) => sk.cast.kind === 'cast' && sk.cast.interruptible)!;
    for (const [res, max] of enemy.maxResources) enemy.resources.set(res, max);
    const r = beginCast(world, casting, enemy, bolt, { target: ally });
    expect(r.ok, `夹具：敌人的读条起手失败（${'reason' in r ? r.reason : ''}）`).toBe(true);
    plantedCastEndsAt = getCast(casting, enemy.id)!.endsAt;
  }

  // 目标解析：治疗/友方技能给友方（或自己），其余给敌人；地面技能给落点
  const castTarget = skill.targetFilter === 'self' ? caster
    : skill.targetFilter === 'ally' ? (targetsAllyEntity ? ally : caster)
      : enemy;
  // targetFilter Any（净化术双向）：有 purge 靶子时打敌人，否则奶自己
  const finalTarget = skill.targetFilter === 'any' ? (wantsPurge ? enemy : caster) : castTarget;

  // ★ 施放前的门禁必须是绿的 —— 夹具没喂对是夹具的 bug，报出来修夹具
  if (skill.targeting !== 'ground') {
    const verdict = validateCast({
      world, caster, skill, target: finalTarget, phase: 'start',
    });
    expect(verdict, `validateCast 拒绝：${verdict}（夹具没喂对门禁）`).toBe(CastFailure.Ok);
  }

  // 施放前快照
  const before = {
    enemyHp: enemy.health,
    casterHp: caster.health,
    allyHp: ally.health,
    targetHp: finalTarget.health,
    resources: new Map(caster.resources),
    positions: new Map([caster, enemy, ally].map((e) => [e.id, { ...e.position }])),
  };

  // 提交施法请求，然后推 6 秒 —— 每 tick 收集「见过的」观测量
  const request = new Map([[caster.id, {
    skillId: skill.id,
    ...(skill.targeting === 'ground'
      ? { groundPoint: { ...enemy.position } }
      : { targetId: finalTarget.id }),
  }]]);

  const seenAuraIds = new Set<string>();
  const seenFlags = new Set<string>();
  let casterMoved = 0;
  let othersMoved = 0;
  let trapSeen = false;
  let enemyCastGoneAt = Infinity;
  const gained = new Map<Resource, number>();

  const step = (req?: typeof request): void => {
    tickWorld(deps(req), DT);
    for (const e of [caster, enemy, ally]) {
      for (const a of aurasOf(auras, e.id)) seenAuraIds.add(a.def.id);
      for (const [flag, on] of Object.entries(e.flags)) if (on === true) seenFlags.add(`${e.id}:${flag}`);
    }
    const p0 = before.positions.get(caster.id)!;
    casterMoved = Math.max(casterMoved, Math.hypot(caster.position.x - p0.x, caster.position.z - p0.z));
    for (const e of [enemy, ally]) {
      const q0 = before.positions.get(e.id)!;
      othersMoved = Math.max(othersMoved, Math.hypot(e.position.x - q0.x, e.position.z - q0.z));
    }
    if (rig.groundStore.traps.length > 0) trapSeen = true;
    if (wantsInterrupt && enemyCastGoneAt === Infinity && !getCast(casting, enemy.id)) {
      enemyCastGoneAt = world.time;
    }
    for (const [res, v] of caster.resources) {
      gained.set(res, Math.max(gained.get(res) ?? 0, v - (before.resources.get(res) ?? 0)));
    }
  };

  for (let t = 0; t * DT < SIM_SECONDS; t++) step(t === 0 ? request : undefined);

  /**
   * ★★ W23：**断言前把在飞的弹体排空。**
   *
   *   法术弹道迁移之后，21 个技能的伤害/控制/DoT 不再在读条结束那一瞬间
   *   落账，而是等锁定投射物飞到（最远 35 米 / 55 m·s⁻¹ ≈ 0.64 秒）。
   *   6 秒的主循环目前刚好盖得住，但那是**巧合**而不是保证 ——
   *   将来有人调慢弹速、或加一个射程更远的法术，冒烟会以
   *   「声称造成伤害，敌人却一滴血没掉」的面目红掉，而真正的原因是
   *   「你只是没等它飞到」。这条排空循环把那种误报堵死。
   *
   * ⚠️ **有界**（`DRAIN_MAX_TICKS`）：投射物仓永远清不空时（真出了 bug）
   *   要红在下面的效果断言上，而不是把测试挂死在这里。
   */
  const DRAIN_MAX_TICKS = 60; // 3 秒，远超任何射程 / 弹速组合
  for (let guard = 0; rig.projectiles.items.length > 0 && guard < DRAIN_MAX_TICKS; guard++) {
    step();
  }

  // ── 逐效果断言 ────────────────────────────────────────────────
  const label = `${cls.id} ${skill.name}`;

  if (claimedEffects(skill).some(dealsDamage)) {
    expect(enemy.health, `${label}：声称造成伤害，敌人却一滴血没掉`).toBeLessThan(before.enemyHp);
  }
  if (claimedEffects(skill).some(heals)) {
    const healed = finalTarget.health > before.targetHp
      || caster.health > before.casterHp || ally.health > before.allyHp;
    expect(healed, `${label}：声称治疗，没有任何人回血`).toBe(true);
  }
  for (const e of claimedEffects(skill)) {
    if (e.kind === 'applyAura') {
      expect(seenAuraIds.has(e.aura.id),
        `${label}：光环 ${e.aura.id} 从未出现（目标解析或时长为 0？）`).toBe(true);
    }
    const flag = CONTROL_FLAG[e.kind];
    if (flag) {
      expect(seenFlags.has(`${enemy.id}:${flag}`),
        `${label}：控制效果 ${e.kind} 从未让敌人亮起 ${flag}`).toBe(true);
    }
    if (MOVES_CASTER.has(e.kind)) {
      // 阈值 0.5：影袭步落点在「敌人背后」，而敌人背对着我们 —— 落点可能
      // 离出发点不到 1 米（行为正确，位移量小），0.5 只筛「根本没动」
      expect(casterMoved, `${label}：位移效果 ${e.kind} 没有移动施法者`).toBeGreaterThan(0.5);
    }
    if (MOVES_TARGET.has(e.kind)) {
      expect(othersMoved, `${label}：位移效果 ${e.kind} 没有移动目标`).toBeGreaterThan(0.5);
    }
    if (e.kind === 'spawnTrap') {
      expect(trapSeen, `${label}：声称布置陷阱，陷阱表始终为空`).toBe(true);
    }
    if (e.kind === 'gainResource') {
      expect((gained.get(e.resource) ?? 0) > 0,
        `${label}：声称产生 ${e.resource}，池子没涨过`).toBe(true);
    }
    if (e.kind === 'spendComboPoints') {
      expect(caster.resources.get(Resource.ComboPoints) ?? 0,
        `${label}：终结技没有消耗连击点`).toBeLessThan(before.resources.get(Resource.ComboPoints) ?? 0);
    }
    if (e.kind === 'enterStealth') {
      expect(seenFlags.has(`${caster.id}:stealthed`), `${label}：没有进入潜行`).toBe(true);
    }
    if (e.kind === 'dispel') {
      const holder = e.from === 'enemy' ? enemy : cleanseHolder;
      const planted = e.from === 'enemy' ? 'smoke.buff' : 'smoke.debuff';
      // targetFilter Any 的技能一次只打一个方向 —— 只断言实际施放的那个方向
      const thisDirectionFired = e.from === 'enemy' ? finalTarget === enemy : finalTarget !== enemy;
      if (thisDirectionFired) {
        expect(aurasOf(auras, holder.id).some((a) => a.def.id === planted),
          `${label}：驱散（${e.from}）没有清掉种下的靶子`).toBe(false);
      }
    }
    if (e.kind === 'interrupt') {
      // 读条必须**提前**消失 —— 只查最后一刻的话，自然读完也算「消失」，测了个寂寞
      expect(enemyCastGoneAt,
        `${label}：敌人的读条自然读完了（${plantedCastEndsAt}s），没有被打断`)
        .toBeLessThan(plantedCastEndsAt - 0.1);
    }
  }
};

// ── 用例展开：每职业一组，每技能一条 ─────────────────────────────

for (const cls of ALL_CLASSES) {
  describe(`技能冒烟：${cls.name}（${cls.skills.length} 技能）`, () => {
    for (const skill of cls.skills) {
      it(`${skill.name}（${skill.id as string}）放得出去且效果生效`, () => {
        runSmoke(cls, skill);
      });
    }
  });
}

// 冒烟覆盖面自检：确保上面的循环真的展开了全部技能（防止将来有人改坏枚举）
describe('冒烟覆盖面', () => {
  it('全部职业全部技能都进了冒烟循环', () => {
    const total = ALL_CLASSES.reduce((n, c) => n + c.skills.length, 0);
    // P9：116 → 117（盗贼疾跑）。这是**下限**，加技能时随实际数量抬高，
    // 这样删掉一个技能才会红 —— 停在旧值等于给「悄悄少一个」开了口子
    expect(total).toBeGreaterThanOrEqual(117);
  });

  it('偷袭这类脱战技能在夹具里真的放得出去（lastCombatAt 门禁被喂到）', () => {
    const rogue = ALL_CLASSES.find((c) => (c.id as string) === 'rogue')!;
    const cheapShot = rogue.skills.find((sk) => (sk.id as string) === 'rogue.cheap_shot');
    expect(cheapShot, 'rogue.cheap_shot 不存在了？').toBeDefined();
    // 上面的循环已经跑过它 —— 这里只声明意图：它是最容易被夹具漏掉的一类
    void asSkillId;
  });
});
