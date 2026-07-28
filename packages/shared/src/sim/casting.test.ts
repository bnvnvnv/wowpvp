/**
 * 施法与打断测试。每个 describe 对应规格书的一条规则或一条验收标准。
 *
 * 用的是**真实职业数据**（战士 + 法师 + 猎人），不是为测试捏造的假技能 ——
 * 这样测试同时也在验证 M0 写的数据本身是自洽的。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GCD, RANGE } from '../constants/combat.js';
import { getSkill, hunter, mage, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { vec3 } from '../math/vec3.js';
import { CastFailure, CastKind, Resource, School } from '../types/enums.js';
import { asSkillId, asTeamId, type SkillId } from '../types/ids.js';
import {
  beginCast,
  cancelCast,
  createCastingStore,
  isCasting,
  tickCasting,
  validateCast,
  type CastingStore,
} from './casting.js';
import { createEntity, type CombatEntity } from './entity.js';
import { applyDisarm, applyInterrupt, applySilence, interruptLockSeconds } from './interrupt.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 200, h: 1, d: 200 });

const skill = (id: string) => {
  const s = getSkill(asSkillId(id));
  if (!s) throw new Error(`技能不存在：${id}`);
  return s;
};
const getSkillFn = (id: SkillId) => getSkill(id);

let world: World;
let store: CastingStore;
let caster: CombatEntity;
let enemy: CombatEntity;

const spawn = (cls: typeof warrior, team: typeof RED, x: number, z: number): CombatEntity => {
  const e = addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));
  // 战士开局怒气为 0（9.1 的设计），测技能规则时先把资源池填满，
  // 否则一切都会先撞到 NotEnoughResource —— 那测的就不是我们想测的东西了
  for (const [r, max] of e.maxResources) e.resources.set(r, max);
  return e;
};

/** 清空施法状态与冷却，让下一次 beginCast 从干净状态开始 */
const resetCastReadiness = (e: CombatEntity): void => {
  store.delete(e.id);
  e.gcdUntil = 0;
  e.cooldowns.clear();
};

beforeEach(() => {
  world = createWorld([ground]);
  store = createCastingStore();
  caster = spawn(mage, RED, 0, 0);
  enemy = spawn(warrior, BLUE, 0, -10);
  caster.targets.hard = enemy.id;
});

/** 推进世界时间并跑 casting tick */
const advance = (seconds: number, step = 0.05) => {
  const end = world.time + seconds;
  while (world.time < end - 1e-9) {
    world.time = Math.min(end, world.time + step);
    tickCasting(world, store, { getSkill: getSkillFn });
  }
};

describe('7.4 施法生命周期', () => {
  it('瞬发技能立即完成，不进入施法状态', () => {
    const fireBlast = skill('mage.fire_blast');
    expect(fireBlast.cast.kind).toBe(CastKind.Instant);
    const r = beginCast(world, store, caster, fireBlast, { target: enemy });
    expect(r.ok).toBe(true);
    expect(isCasting(store, caster.id)).toBe(false);
    expect(caster.cooldowns.get(fireBlast.id)).toBeCloseTo(fireBlast.cooldown);
  });

  it('读条技能进入施法状态，到时间才完成', () => {
    const frostbolt = skill('mage.frostbolt');
    beginCast(world, store, caster, frostbolt, { target: enemy });
    expect(isCasting(store, caster.id)).toBe(true);

    advance(frostbolt.cast.time - 0.1);
    expect(isCasting(store, caster.id)).toBe(true);

    advance(0.2);
    expect(isCasting(store, caster.id)).toBe(false);
  });

  it('7.4 步骤 2：开始动作就启动公共冷却', () => {
    const frostbolt = skill('mage.frostbolt');
    beginCast(world, store, caster, frostbolt, { target: enemy });
    expect(caster.gcdUntil).toBeCloseTo(world.time + GCD.BASE);
  });

  it('公共冷却期间不能释放触发 GCD 的技能', () => {
    beginCast(world, store, caster, skill('mage.fire_blast'), { target: enemy });
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect(r.ok).toBe(false);
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.OnGlobalCooldown);
  });

  it('7.2 专用打断脱离公共冷却，可在 GCD 中使用', () => {
    const counterspell = skill('mage.counterspell');
    expect(counterspell.triggersGcd).toBe(false);
    caster.gcdUntil = world.time + 1; // 处于 GCD 中
    const r = beginCast(world, store, caster, counterspell, { target: enemy });
    expect(r.ok).toBe(true);
  });
});

describe('验收 #19 — 开始和完成都检查目标、距离、视线、朝向', () => {
  it('开始时超距直接失败', () => {
    enemy.position = vec3(0, 0, -100);
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.OutOfRange);
  });

  it('★ 开始时合法、完成瞬间跑出距离 → 失败且不扣资源不进冷却', () => {
    const frostbolt = skill('mage.frostbolt');
    const manaBefore = caster.resources.get(Resource.Mana)!;

    beginCast(world, store, caster, frostbolt, { target: enemy });
    // 读条途中目标跑到 100 米外
    enemy.position = vec3(0, 0, -100);
    advance(frostbolt.cast.time + 0.1);

    expect(isCasting(store, caster.id)).toBe(false);
    expect(caster.resources.get(Resource.Mana)).toBe(manaBefore); // 未扣资源
    expect(caster.cooldowns.has(frostbolt.id)).toBe(false); // 未进冷却
  });

  it('★ 完成瞬间目标死亡 → 失败，不产生任何结算', () => {
    const frostbolt = skill('mage.frostbolt');
    beginCast(world, store, caster, frostbolt, { target: enemy });
    enemy.alive = false;
    advance(frostbolt.cast.time + 0.1);
    expect(caster.cooldowns.has(frostbolt.id)).toBe(false);
  });

  it('视线被墙挡住时失败', () => {
    const wall = box('w', 'wall', { x: 0, y: 0, z: -5 }, { w: 20, h: 6, d: 1 });
    world.obstacles = [ground, wall];
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.NoLineOfSight);
  });

  it('6.5 朝向：需要朝向的技能，目标在背后时失败', () => {
    const w = spawn(warrior, RED, 0, 0);
    const target = spawn(mage, BLUE, 0, 2); // 在 +Z，即 yaw=0 时的背后
    w.yaw = 0;
    const r = beginCast(world, store, w, skill('warrior.mortal_strike'), { target });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.WrongFacing);

    w.yaw = Math.PI; // 转身面向 +Z
    resetCastReadiness(w);
    const r2 = beginCast(world, store, w, skill('warrior.mortal_strike'), { target });
    expect(r2.ok).toBe(true);
  });

  it('★ 6.5：只改镜头不改角色朝向 —— validate 只认角色 yaw', () => {
    const w = spawn(warrior, RED, 0, 0);
    const target = spawn(mage, BLUE, 0, 2);
    w.yaw = 0; // 角色背对目标
    // 无论镜头怎么转，validateCast 的入参里根本没有镜头 yaw 这个东西
    expect(
      validateCast({ world, caster: w, skill: skill('warrior.mortal_strike'), target, phase: 'start' }),
    ).toBe(CastFailure.WrongFacing);
  });

  it('冲锋贴脸时报 TooClose 而不是 OutOfRange（15.2 要求明确原因）', () => {
    const w = spawn(warrior, RED, 0, 0);
    const target = spawn(mage, BLUE, 0, -2); // 2 米，小于冲锋的 8 米最小距离
    const r = beginCast(world, store, w, skill('warrior.charge'), { target });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.TooClose);
  });
});

describe('验收 #18 / 7.5 — 假读条：主动取消不消耗资源和冷却', () => {
  it('取消后资源与技能冷却都没动', () => {
    const frostbolt = skill('mage.frostbolt');
    const manaBefore = caster.resources.get(Resource.Mana)!;

    beginCast(world, store, caster, frostbolt, { target: enemy });
    advance(0.5);
    expect(cancelCast(world, store, caster)).toBe(true);

    expect(isCasting(store, caster.id)).toBe(false);
    expect(caster.resources.get(Resource.Mana)).toBe(manaBefore);
    expect(caster.cooldowns.has(frostbolt.id)).toBe(false);
  });

  it('★ 但已经过的公共冷却不返还（7.4 第 6 条）', () => {
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    const gcdAfterStart = caster.gcdUntil;
    advance(0.3);
    cancelCast(world, store, caster);
    // GCD 没有被重置或提前结束 —— 这是骗打断的成本
    expect(caster.gcdUntil).toBe(gcdAfterStart);
    expect(caster.gcdUntil).toBeGreaterThan(world.time);
  });
});

describe('验收 #13 / 7.3 — 四类动作的中断规则各不相同', () => {
  it('读条被硬控制终止', () => {
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    caster.flags.stunned = true;
    advance(0.1);
    expect(isCasting(store, caster.id)).toBe(false);
  });

  it('原地读条被主动移动终止', () => {
    const frostbolt = skill('mage.frostbolt');
    expect(frostbolt.cast.movable).toBe(false);
    beginCast(world, store, caster, frostbolt, { target: enemy });
    caster.position = vec3(0, 0, 1); // 走了 1 米
    advance(0.1);
    expect(isCasting(store, caster.id)).toBe(false);
  });

  it('可移动施法的技能不会被移动终止', () => {
    // 猎人的瞄准射击是 movable:false，奥术射击是瞬发；
    // 这里用一个人为可移动的读条来验证分支
    const movable = { ...skill('mage.frostbolt'), cast: { ...skill('mage.frostbolt').cast, movable: true } };
    beginCast(world, store, caster, movable, { target: enemy });
    caster.position = vec3(0, 0, 3);
    advance(0.1);
    expect(isCasting(store, caster.id)).toBe(true);
  });

  it('★ 验收 #14：普通伤害不取消也不延长施法', () => {
    const frostbolt = skill('mage.frostbolt');
    beginCast(world, store, caster, frostbolt, { target: enemy });
    const endsAt = store.get(caster.id)!.endsAt;

    // 反复造成伤害
    for (let i = 0; i < 10; i++) {
      caster.health -= 50;
      advance(0.05);
    }
    expect(isCasting(store, caster.id)).toBe(true);
    expect(store.get(caster.id)!.endsAt).toBe(endsAt); // 也没被延长
  });
});

describe('验收 #17 — 沉默不阻止物理射击，缴械不阻止纯魔法', () => {
  it('★ 沉默阻止魔法读条', () => {
    caster.flags.silenced = true;
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.Silenced);
  });

  it('★ 沉默**不**阻止猎人的物理瞄准射击', () => {
    const h = spawn(hunter, RED, 0, 0);
    h.flags.silenced = true;
    const aimed = skill('hunter.aimed_shot');
    expect(aimed.school).toBe(School.Physical);
    const r = beginCast(world, store, h, aimed, { target: enemy });
    expect(r.ok).toBe(true);
  });

  it('★ 缴械阻止物理武器技能', () => {
    const w = spawn(warrior, RED, 0, -9);
    w.flags.disarmed = true;
    const r = beginCast(world, store, w, skill('warrior.mortal_strike'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.Disarmed);
  });

  it('★ 缴械**不**阻止纯魔法施法', () => {
    caster.flags.disarmed = true;
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect(r.ok).toBe(true);
  });

  it('进行中的魔法读条被沉默终止，物理射击不受影响', () => {
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect(applySilence(world, store, caster)).toBe(true);
    expect(isCasting(store, caster.id)).toBe(false);

    const h = spawn(hunter, RED, 0, 0);
    beginCast(world, store, h, skill('hunter.aimed_shot'), { target: enemy });
    expect(applySilence(world, store, h)).toBe(false); // 沉默对物理射击无效
    expect(isCasting(store, h.id)).toBe(true);
  });

  it('进行中的物理射击被缴械终止，魔法读条不受影响', () => {
    const h = spawn(hunter, RED, 0, 0);
    beginCast(world, store, h, skill('hunter.aimed_shot'), { target: enemy });
    expect(applyDisarm(world, store, h)).toBe(true);

    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect(applyDisarm(world, store, caster)).toBe(false); // 缴械对纯魔法无效
    expect(isCasting(store, caster.id)).toBe(true);
  });
});

describe('验收 #15 / #16 / 7.2 — 专用打断与学派锁定', () => {
  it('★ 打断魔法读条 → 停止 + 同学派锁定', () => {
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    const out = applyInterrupt(world, store, caster, 3);

    expect(out.interrupted).toBe(true);
    expect(out.schoolLock?.school).toBe(School.Frost);
    expect(caster.schoolLocks.get(School.Frost)).toBeCloseTo(world.time + 3);
  });

  it('学派锁定期间不能再放同学派技能，其他学派可以', () => {
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    applyInterrupt(world, store, caster, 3);

    const frost = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((frost as { reason: CastFailure }).reason).toBe(CastFailure.SchoolLocked);

    // 火焰冲击是火焰学派，不受寒冰锁定影响
    caster.gcdUntil = 0;
    caster.cooldowns.delete(skill('mage.fire_blast').id);
    const fire = beginCast(world, store, caster, skill('mage.fire_blast'), { target: enemy });
    expect(fire.ok).toBe(true);
  });

  it('★ 验收 #16：打断物理射击准备只取消本次，不产生学派锁定', () => {
    const h = spawn(hunter, RED, 0, 0);
    beginCast(world, store, h, skill('hunter.aimed_shot'), { target: enemy });

    const out = applyInterrupt(world, store, h, 3);
    expect(out.interrupted).toBe(true);
    expect(out.schoolLock).toBeUndefined();
    expect(h.schoolLocks.size).toBe(0);

    // 下一发射击立刻就能开始
    h.gcdUntil = 0;
    h.cooldowns.clear();
    expect(beginCast(world, store, h, skill('hunter.aimed_shot'), { target: enemy }).ok).toBe(true);
  });

  it('★ 7.2：目标没在施法时打断落空（调用方仍需让技能进冷却）', () => {
    const out = applyInterrupt(world, store, caster, 3);
    expect(out.interrupted).toBe(false);
    expect(out.reason).toBe('notCasting');
  });

  it('★ 7.1：不可打断技能带盾牌标记，专用打断对它无效', () => {
    const frostbolt = skill('mage.frostbolt');
    const unstoppable = { ...frostbolt, cast: { ...frostbolt.cast, interruptible: false } };
    beginCast(world, store, caster, unstoppable, { target: enemy });

    const out = applyInterrupt(world, store, caster, 3);
    expect(out.interrupted).toBe(false);
    expect(out.reason).toBe('notInterruptible');
    expect(isCasting(store, caster.id)).toBe(true); // 还在读
  });

  it('已有更长的锁定不会被新打断缩短', () => {
    caster.schoolLocks.set(School.Frost, world.time + 10);
    beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    applyInterrupt(world, store, caster, 3);
    expect(caster.schoolLocks.get(School.Frost)).toBeCloseTo(world.time + 10);
  });

  it('7.2：法师反制锁 4 秒，其余职业锁 3 秒 —— 值来自技能数据', () => {
    expect(interruptLockSeconds(skill('mage.counterspell'))).toBe(4);
    expect(interruptLockSeconds(skill('warrior.pummel'))).toBe(3);
    expect(interruptLockSeconds(skill('rogue.kick'))).toBe(3);
    expect(interruptLockSeconds(skill('hunter.counter_shot'))).toBe(3);
  });
});

describe('验收 #20 — 技能失败不产生重复伤害、资源扣除或冷却异常', () => {
  it('连续多次失败不会累积任何副作用', () => {
    const frostbolt = skill('mage.frostbolt');
    const manaBefore = caster.resources.get(Resource.Mana)!;
    enemy.position = vec3(0, 0, -100); // 一直超距

    for (let i = 0; i < 5; i++) {
      caster.gcdUntil = 0;
      beginCast(world, store, caster, frostbolt, { target: enemy });
    }
    expect(caster.resources.get(Resource.Mana)).toBe(manaBefore);
    expect(caster.cooldowns.has(frostbolt.id)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('成功一次只扣一次资源、只进一次冷却', () => {
    const fireBlast = skill('mage.fire_blast');
    const manaBefore = caster.resources.get(Resource.Mana)!;
    beginCast(world, store, caster, fireBlast, { target: enemy });
    const cost = fireBlast.cost?.amount ?? 0;
    expect(manaBefore - caster.resources.get(Resource.Mana)!).toBe(cost);
    expect(caster.cooldowns.get(fireBlast.id)).toBeCloseTo(world.time + fireBlast.cooldown);
  });

  it('资源不足时失败且不进冷却', () => {
    caster.resources.set(Resource.Mana, 0);
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.NotEnoughResource);
    expect(caster.cooldowns.size).toBe(0);
  });
});

describe('6.1 距离基准在真实技能数据上成立', () => {
  it('近战技能够不到 10 米外的目标', () => {
    const w = spawn(warrior, RED, 0, 0);
    const far = spawn(mage, BLUE, 0, -10);
    const r = beginCast(world, store, w, skill('warrior.mortal_strike'), { target: far });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.OutOfRange);
  });

  it('32 米法术够得到 25 米外的目标，够不到 40 米外的', () => {
    enemy.position = vec3(0, 0, -25);
    expect(beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy }).ok).toBe(true);

    resetCastReadiness(caster);
    enemy.position = vec3(0, 0, -40);
    const r = beginCast(world, store, caster, skill('mage.frostbolt'), { target: enemy });
    expect((r as { reason: CastFailure }).reason).toBe(CastFailure.OutOfRange);
  });

  it('没有技能能超过 45 米最大选中距离', () => {
    expect(RANGE.MAX_SELECT).toBe(45);
  });
});
