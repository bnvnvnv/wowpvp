/**
 * 投射物测试。对应规格书 6.6 与验收 #12：
 * 「锁定投射物与碰撞投射物具有不同命中和躲避规则」。
 *
 * 这两类的差别是整条测试的主线：**能不能靠走位躲开**。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mage, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { vec3 } from '../math/vec3.js';
import { asSkillId, asTeamId } from '../types/ids.js';
import { createEntity, type CombatEntity } from './entity.js';
import {
  createProjectileStore,
  spawnColliding,
  spawnDelayedImpact,
  spawnHoming,
  tickProjectiles,
  type ProjectileStore,
} from './projectile.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const SKILL = asSkillId('mage.frostbolt');

let world: World;
let store: ProjectileStore;
let shooter: CombatEntity;
let target: CombatEntity;

const spawn = (cls: typeof mage, team: typeof RED, x: number, z: number) =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld([ground]);
  store = createProjectileStore();
  shooter = spawn(mage, RED, 0, 0);
  target = spawn(warrior, BLUE, 0, -20);
});

/** 推进 n 秒，收集所有命中事件 */
const advance = (seconds: number, step = 0.05) => {
  const events = [];
  const end = world.time + seconds;
  while (world.time < end - 1e-9) {
    world.time = Math.min(end, world.time + step);
    events.push(...tickProjectiles(world, store, step));
  }
  return events;
};

describe('6.6 锁定投射物 —— 释放瞬间确认命中资格', () => {
  it('正常飞行并命中', () => {
    spawnHoming(world, store, { skillId: SKILL, source: shooter, target, speed: 30, onHit: [] });
    const events = advance(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.targets[0]!.id).toBe(target.id);
  });

  it('★ 目标释放后跑到 100 米外，仍然命中（不能靠走位躲开）', () => {
    spawnHoming(world, store, { skillId: SKILL, source: shooter, target, speed: 30, onHit: [] });
    target.position = vec3(0, 0, -100); // 拔腿就跑
    const events = advance(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.targets[0]!.id).toBe(target.id);
  });

  it('★ 飞行途中被墙挡住，仍然命中（墙不影响锁定投射物）', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -10 }, { w: 40, h: 8, d: 1 })];
    spawnHoming(world, store, { skillId: SKILL, source: shooter, target, speed: 30, onHit: [] });
    const events = advance(2);
    expect(events).toHaveLength(1);
  });

  it('目标在命中前死亡则不产生事件', () => {
    spawnHoming(world, store, { skillId: SKILL, source: shooter, target, speed: 30, onHit: [] });
    target.alive = false;
    expect(advance(2)).toHaveLength(0);
  });

  it('命中时间由释放瞬间的距离决定', () => {
    const p = spawnHoming(world, store, {
      skillId: SKILL, source: shooter, target, speed: 20, onHit: [],
    });
    expect(p.impactAt).toBeCloseTo(20 / 20, 2); // 20 米 / 20 米每秒
    // 目标跑远也不改变已定的命中时刻
    target.position = vec3(0, 0, -200);
    expect(p.impactAt).toBeCloseTo(1, 2);
  });
});

describe('6.6 碰撞投射物 —— 沿真实轨迹飞行', () => {
  it('直线命中路径上的目标', () => {
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.3, maxDistance: 40, pierce: false, onHit: [],
    });
    const events = advance(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.targets[0]!.id).toBe(target.id);
  });

  it('★ 目标走开就能躲掉 —— 与锁定投射物的核心区别', () => {
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 20, radius: 0.3, maxDistance: 40, pierce: false, onHit: [],
    });
    advance(0.3); // 先飞一段
    target.position = vec3(6, 0, -20); // 横向闪开
    expect(advance(3)).toHaveLength(0);
  });

  it('★ 被墙体挡下', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -10 }, { w: 40, h: 8, d: 1 })];
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.3, maxDistance: 40, pierce: false, onHit: [],
    });
    expect(advance(2)).toHaveLength(0);
    expect(store.items).toHaveLength(0); // 撞墙后消失
  });

  it('非穿透投射物命中第一个目标后消失', () => {
    const behind = spawn(warrior, BLUE, 0, -30);
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.3, maxDistance: 60, pierce: false, onHit: [],
    });
    const events = advance(3);
    expect(events).toHaveLength(1);
    expect(events[0]!.targets[0]!.id).toBe(target.id);
    expect(events.some((e) => e.targets[0]!.id === behind.id)).toBe(false);
  });

  it('穿透投射物依次命中多个目标，且每个只命中一次', () => {
    const behind = spawn(warrior, BLUE, 0, -30);
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.3, maxDistance: 60, pierce: true, onHit: [],
    });
    const events = advance(3);
    const hitIds = events.map((e) => e.targets[0]!.id);
    expect(hitIds).toContain(target.id);
    expect(hitIds).toContain(behind.id);
    expect(new Set(hitIds).size).toBe(hitIds.length); // 无重复
  });

  it('超出最大距离后消失', () => {
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(1, 0, 0), // 打向空处
      speed: 30, radius: 0.3, maxDistance: 10, pierce: false, onHit: [],
    });
    advance(2);
    expect(store.items).toHaveLength(0);
  });

  it('不会命中射手自己', () => {
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.5, maxDistance: 5, pierce: true, onHit: [],
    });
    const events = advance(1);
    expect(events.every((e) => e.targets[0]!.id !== shooter.id)).toBe(true);
  });

  it('★ 验收 #5：未被发现的潜行目标不会被碰撞投射物命中', () => {
    target.flags.stealthed = true;
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 30, radius: 0.3, maxDistance: 40, pierce: false, onHit: [],
    });
    expect(advance(2)).toHaveLength(0);
  });
});

describe('6.6 延迟落点 —— 落点与倒计时全程可见', () => {
  it('延迟结束后结算范围内全部目标', () => {
    const a = spawn(warrior, BLUE, 1, -20);
    const b = spawn(warrior, BLUE, -1, -20);
    const far = spawn(warrior, BLUE, 30, -20);

    spawnDelayedImpact(world, store, {
      skillId: SKILL, source: shooter, center: vec3(0, 0, -20),
      radius: 5, delay: 1.5, onImpact: [],
    });

    expect(advance(1.4)).toHaveLength(0); // 还没落地
    const events = advance(0.3);
    expect(events).toHaveLength(1);
    const ids = events[0]!.targets.map((t) => t.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(far.id);
  });

  it('★ 走出落点范围就能躲开 —— 这是它唯一的反制方式（14.3）', () => {
    spawnDelayedImpact(world, store, {
      skillId: SKILL, source: shooter, center: vec3(0, 0, -20),
      radius: 5, delay: 1.5, onImpact: [],
    });
    advance(1.0);
    target.position = vec3(0, 0, -40); // 在落地前走开
    const events = advance(1.0);
    expect(events[0]!.targets.map((t) => t.id)).not.toContain(target.id);
  });

  it('倒计时信息完整，客户端才能画出全程可见的落点', () => {
    const p = spawnDelayedImpact(world, store, {
      skillId: SKILL, source: shooter, center: vec3(0, 0, -20),
      radius: 5, delay: 1.5, onImpact: [],
    });
    // 14.3 要求落点边界和倒计时全程可见 —— 这三个字段就是客户端画它所需的全部信息
    expect(p.center).toEqual(vec3(0, 0, -20));
    expect(p.radius).toBe(5);
    expect(p.impactAt - p.createdAt).toBeCloseTo(1.5);
  });
});

describe('验收 #12 —— 两类投射物的规则确实不同', () => {
  it('同样的走位，锁定命中而碰撞落空', () => {
    // 锁定
    spawnHoming(world, store, { skillId: SKILL, source: shooter, target, speed: 20, onHit: [] });
    advance(0.2);
    target.position = vec3(8, 0, -20);
    const homingEvents = advance(3);

    // 重置后用碰撞投射物重复同一套动作
    world = createWorld([ground]);
    store = createProjectileStore();
    shooter = spawn(mage, RED, 0, 0);
    target = spawn(warrior, BLUE, 0, -20);
    spawnColliding(world, store, {
      skillId: SKILL, source: shooter, direction: vec3(0, 0, -1),
      speed: 20, radius: 0.3, maxDistance: 40, pierce: false, onHit: [],
    });
    advance(0.2);
    target.position = vec3(8, 0, -20);
    const collidingEvents = advance(3);

    expect(homingEvents).toHaveLength(1); // 躲不掉
    expect(collidingEvents).toHaveLength(0); // 躲掉了
  });
});
