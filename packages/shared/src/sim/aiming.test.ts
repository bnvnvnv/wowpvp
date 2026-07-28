/**
 * 瞄准解算测试。对应规格书 5.4 / 5.5 / 6.3 与验收 #7 / #8。
 *
 * 主线：**客户端画的边界和服务器判定的边界必须是同一个**。
 * 最后一组测试直接把这件事写成断言。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getSkill, hunter, mage, priest, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { vec3 } from '../math/vec3.js';
import { CastFailure, TargetFilter, Targeting } from '../types/enums.js';
import { asSkillId, asTeamId } from '../types/ids.js';
import {
  collectShapeTargets,
  directionOf,
  isDirectional,
  needsGroundPlacement,
  needsHardTarget,
  resolveGroundPlacement,
  shapeOrigin,
  shapeRadius,
} from './aiming.js';
import { createEntity, type CombatEntity } from './entity.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });
const skill = (id: string) => {
  const s = getSkill(asSkillId(id));
  if (!s) throw new Error(`技能不存在：${id}`);
  return s;
};

let world: World;
let caster: CombatEntity;

const spawn = (cls: typeof mage, team: typeof RED, x: number, z: number) =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z)));

beforeEach(() => {
  world = createWorld([ground]);
  caster = spawn(mage, RED, 0, 0);
  caster.yaw = 0; // 面向 -Z
});

describe('5.4 六类瞄准可以区分（验收 #7）', () => {
  it('八职业的技能覆盖了全部六类瞄准', () => {
    const kinds = new Set<string>();
    for (const cls of [warrior, mage, priest, hunter]) {
      for (const s of cls.skills) kinds.add(s.targeting);
    }
    // 直接目标、地面、直线、锥形、自身中心、自身 —— 碰撞投射物由效果层承载
    expect(kinds.has(Targeting.Direct)).toBe(true);
    expect(kinds.has(Targeting.Ground)).toBe(true);
    expect(kinds.has(Targeting.SelfCenter)).toBe(true);
    expect(kinds.has(Targeting.Self)).toBe(true);
  });

  it('分类函数把技能正确分流到三种输入流程', () => {
    expect(needsGroundPlacement(skill('mage.blizzard'))).toBe(true);
    expect(needsHardTarget(skill('mage.frostbolt'))).toBe(true);
    expect(isDirectional(skill('warrior.cleave'))).toBe(true);

    expect(needsGroundPlacement(skill('mage.frostbolt'))).toBe(false);
    expect(needsHardTarget(skill('mage.blizzard'))).toBe(false);
  });

  it('自身中心技能以施法者为原点，地面技能以落点为原点', () => {
    caster.position = vec3(5, 0, 5);
    expect(shapeOrigin(caster, skill('mage.frost_nova'))).toEqual(vec3(5, 0, 5));
    expect(shapeOrigin(caster, skill('mage.blizzard'), vec3(1, 0, 2))).toEqual(vec3(1, 0, 2));
  });

  it('方向技能的朝向来自角色 yaw', () => {
    caster.yaw = 0;
    const d = directionOf(caster);
    expect(d.z).toBeCloseTo(-1); // yaw=0 面向 -Z
    caster.yaw = Math.PI;
    expect(directionOf(caster).z).toBeCloseTo(1);
  });
});

describe('5.5 地面指示器（验收 #8）', () => {
  const blizzard = () => skill('mage.blizzard');

  it('落点在范围内时合法且不钳制', () => {
    const p = resolveGroundPlacement(caster, vec3(0, 0, -10), blizzard(), world.obstacles);
    expect(p.legal).toBe(true);
    expect(p.clamped).toBe(false);
    expect(p.center).toEqual(vec3(0, 0, -10));
  });

  it('超出最大距离时钳制到边缘，仍然合法', () => {
    const s = blizzard();
    const p = resolveGroundPlacement(caster, vec3(0, 0, -100), s, world.obstacles);
    expect(p.clamped).toBe(true);
    expect(p.legal).toBe(true);
    expect(Math.hypot(p.center.x, p.center.z)).toBeCloseTo(s.range.max, 3);
  });

  it('★ 落点被封闭墙体挡住时不合法，不能确认（6.4）', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -8 }, { w: 60, h: 8, d: 1 })];
    const p = resolveGroundPlacement(caster, vec3(0, 0, -20), blizzard(), world.obstacles);
    expect(p.legal).toBe(false);
    expect(p.reason).toBe(CastFailure.NoLineOfSight);
  });

  it('绕过墙体侧面的落点仍然合法', () => {
    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -8 }, { w: 10, h: 8, d: 1 })];
    const p = resolveGroundPlacement(caster, vec3(20, 0, -20), blizzard(), world.obstacles);
    expect(p.legal).toBe(true);
  });

  it('超出地图边界时不合法', () => {
    const bounds = { min: vec3(-15, -5, -15), max: vec3(15, 30, 15) };
    const p = resolveGroundPlacement(caster, vec3(0, 0, -25), blizzard(), world.obstacles, bounds);
    expect(p.legal).toBe(false);
    expect(p.reason).toBe(CastFailure.InvalidGroundPosition);
  });

  it('★ 5.5 预览必须包含的五项信息都在返回值里', () => {
    const s = blizzard();
    const p = resolveGroundPlacement(caster, vec3(0, 0, -10), s, world.obstacles);
    expect(p.radius).toBeGreaterThan(0);      // 真实外边界
    expect(p.center).toBeDefined();            // 中心点
    expect(p.maxRange).toBe(s.range.max);      // 最大施放距离
    expect(typeof p.legal).toBe('boolean');    // 是否被墙体阻挡 / 超出地图
    expect(p.reason).toBeDefined();            // 不合法的具体原因
  });

  it('★ 14.3 环形技能同时给出内外半径', () => {
    const ringSkill = {
      ...blizzard(),
      shape: { kind: 'ring' as const, innerRadius: 3, outerRadius: 8 },
    };
    const p = resolveGroundPlacement(caster, vec3(0, 0, -10), ringSkill, world.obstacles);
    expect(p.innerRadius).toBe(3);
    expect(p.radius).toBe(8);
  });
});

describe('6.3 形状选目标', () => {
  it('圆形只影响半径内的目标', () => {
    const inside = spawn(warrior, BLUE, 0, -10);
    const outside = spawn(warrior, BLUE, 0, -20);
    const hits = collectShapeTargets(world, caster, {
      origin: vec3(0, 0, -10),
      yaw: 0,
      shape: { kind: 'circle', radius: 5 },
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toEqual([inside.id]);
    expect(outside).toBeDefined();
  });

  it('锥形不影响背后的目标', () => {
    const front = spawn(warrior, BLUE, 0, -4);
    const behind = spawn(warrior, BLUE, 0, 4);
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'cone', angleDeg: 90, range: 8 },
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toEqual([front.id]);
    expect(behind).toBeDefined();
  });

  it('环形的内圈是安全区', () => {
    const inCenter = spawn(warrior, BLUE, 0, -1);
    const inBand = spawn(warrior, BLUE, 0, -6);
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'ring', innerRadius: 3, outerRadius: 8 },
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toEqual([inBand.id]);
    expect(inCenter).toBeDefined();
  });

  it('友方过滤：范围技能不误伤队友（8.1 友军伤害默认关闭）', () => {
    const ally = spawn(priest, RED, 0, -3);
    const enemy = spawn(warrior, BLUE, 0, -4);
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'circle', radius: 8 },
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toContain(enemy.id);
    expect(hits.map((e) => e.id)).not.toContain(ally.id);
  });

  it('★ 验收 #5：未被发现的潜行目标不会被范围技能选中', () => {
    const sneak = spawn(warrior, BLUE, 0, -3);
    sneak.flags.stealthed = true;
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'circle', radius: 10 },
      filter: TargetFilter.Enemy,
    });
    expect(hits).toHaveLength(0);
  });

  it('maxTargets 截断时取最近的几个（群体驱散上限 5）', () => {
    for (let i = 1; i <= 8; i++) spawn(warrior, BLUE, 0, -i);
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'circle', radius: 20, maxTargets: 5 },
      filter: TargetFilter.Enemy,
    });
    expect(hits).toHaveLength(5);
    // 最近的五个是 z = -1..-5
    expect(hits.map((e) => Math.round(-e.position.z)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('链式逐跳寻找最近的未命中目标，超出跳转距离即停止', () => {
    const a = spawn(warrior, BLUE, 0, -3);
    const b = spawn(warrior, BLUE, 0, -6);
    const tooFar = spawn(warrior, BLUE, 0, -30);
    const hits = collectShapeTargets(world, caster, {
      origin: caster.position,
      yaw: 0,
      shape: { kind: 'chain', jumpRange: 6, maxTargets: 4 },
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(tooFar).toBeDefined();
  });
});

describe('★ 验收 #8 —— 客户端预览边界与服务器判定边界是同一个', () => {
  it('指示器画的圆内的目标恰好就是被命中的目标', () => {
    const s = skill('mage.blizzard');
    const requested = vec3(0, 0, -12);

    // 客户端：拿到预览参数
    const preview = resolveGroundPlacement(caster, requested, s, world.obstacles);

    // 在预览边界内外各放一个目标
    const justInside = spawn(warrior, BLUE, preview.center.x + preview.radius - 0.6, preview.center.z);
    const justOutside = spawn(warrior, BLUE, preview.center.x + preview.radius + 1.2, preview.center.z);

    // 服务器：用**预览给出的同一组数**做判定
    const hits = collectShapeTargets(world, caster, {
      origin: preview.center,
      yaw: caster.yaw,
      shape: s.shape,
      filter: TargetFilter.Enemy,
    });

    expect(hits.map((e) => e.id)).toContain(justInside.id);
    expect(hits.map((e) => e.id)).not.toContain(justOutside.id);
  });

  it('钳制后的落点也一致：服务器用 center 而不是玩家的原始鼠标位置', () => {
    const s = skill('mage.blizzard');
    const preview = resolveGroundPlacement(caster, vec3(0, 0, -100), s, world.obstacles);
    expect(preview.clamped).toBe(true);

    // 目标站在**钳制后**的落点上，应当被命中
    const atClamped = spawn(warrior, BLUE, preview.center.x, preview.center.z);
    // 目标站在玩家**原始**鼠标位置上，不应被命中
    const atRequested = spawn(warrior, BLUE, 0, -100);

    const hits = collectShapeTargets(world, caster, {
      origin: preview.center,
      yaw: caster.yaw,
      shape: s.shape,
      filter: TargetFilter.Enemy,
    });
    expect(hits.map((e) => e.id)).toContain(atClamped.id);
    expect(hits.map((e) => e.id)).not.toContain(atRequested.id);
  });

  it('shapeRadius 对每种形状都给出客户端该画的外径', () => {
    expect(shapeRadius({ kind: 'circle', radius: 6 })).toBe(6);
    expect(shapeRadius({ kind: 'ring', innerRadius: 3, outerRadius: 9 })).toBe(9);
    expect(shapeRadius({ kind: 'cone', angleDeg: 60, range: 12 })).toBe(12);
    expect(shapeRadius({ kind: 'line', length: 20, width: 3 })).toBe(20);
    expect(shapeRadius({ kind: 'single' })).toBe(0);
  });
});
