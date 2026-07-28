/**
 * 命中几何测试。每个 describe 对应规格书的一条规则或一条验收标准。
 * 这些函数是客户端指示器和服务器判定的共用实现，测错了会直接产生「所见非所中」。
 */

import { describe, expect, it } from 'vitest';
import { FACING, GEOMETRY, RANGE } from '../constants/combat.js';
import {
  clampDisplacement,
  edgeDistance,
  firstProjectileHit,
  hasLineOfSight,
  hitCircle,
  hitCone,
  hitLine,
  hitRing,
  inMeleeRange,
  inRange,
  isBehind,
  isFacing,
  isGroundPositionLegal,
  nextChainTarget,
  rangedDistance,
  type Aabb,
  type HitCircle,
} from './geometry.js';
import { DEG, vec3 } from './vec3.js';

const at = (x: number, y: number, z: number): HitCircle => ({ position: vec3(x, y, z) });

describe('6.2 距离计算 — 近战按碰撞体边缘', () => {
  it('边缘距离扣掉双方半径', () => {
    // 中心相距 5 米，两个 0.45 半径 → 边缘相距 4.1
    expect(edgeDistance(at(0, 0, 0), at(5, 0, 0))).toBeCloseTo(5 - 2 * GEOMETRY.HITBOX_RADIUS);
  });

  it('验收 #10 — 模型再大也不改变碰撞体', () => {
    // 「视觉上很大」的角色仍用统一 HITBOX_RADIUS，只要不显式传 radius
    const bigLookingModel: HitCircle = { position: vec3(3, 0, 0) };
    expect(edgeDistance(at(0, 0, 0), bigLookingModel)).toBeCloseTo(3 - 2 * GEOMETRY.HITBOX_RADIUS);
  });

  it('2.8 米单手剑够得到中心相距 3.6 米的目标', () => {
    // 3.6 - 0.9 = 2.7 <= 2.8
    expect(inMeleeRange(at(0, 0, 0), at(3.6, 0, 0), RANGE.MELEE)).toBe(true);
  });

  it('高度差过大时近战失效，但小台阶不失效', () => {
    expect(inMeleeRange(at(0, 0, 0), at(1, 0.4, 0), RANGE.MELEE)).toBe(true);
    expect(inMeleeRange(at(0, 0, 0), at(1, 5, 0), RANGE.MELEE)).toBe(false);
  });

  it('远程距离按胸口到胸口', () => {
    // 水平 30 米，双方同高 → 胸口连线仍是 30 米，扣掉目标半径
    expect(rangedDistance(at(0, 0, 0), at(30, 0, 0))).toBeCloseTo(30 - GEOMETRY.HITBOX_RADIUS);
  });

  it('6.2 — 小型台阶和合理高度差不应使远程攻击频繁失效', () => {
    // 站在 2 米高台上打 30 米外的目标，仍在 30 米射程内
    expect(inRange(at(0, 2, 0), at(29, 0, 0), RANGE.RANGED)).toBe(true);
  });
});

describe('6.5 朝向', () => {
  it('正面 180 度内算面向', () => {
    // yaw = 0 面向 -Z
    expect(isFacing(vec3(0, 0, 0), 0, vec3(0, 0, -5), FACING.FRONT_ARC_DEG)).toBe(true);
    expect(isFacing(vec3(0, 0, 0), 0, vec3(5, 0, -0.01), FACING.FRONT_ARC_DEG)).toBe(true);
    expect(isFacing(vec3(0, 0, 0), 0, vec3(0, 0, 5), FACING.FRONT_ARC_DEG)).toBe(false);
  });

  it('背刺要求攻击者位于目标背后 120 度', () => {
    // 目标 yaw = 0（面向 -Z），背后是 +Z
    expect(isBehind(vec3(0, 0, 3), vec3(0, 0, 0), 0, FACING.BEHIND_ARC_DEG)).toBe(true);
    expect(isBehind(vec3(0, 0, -3), vec3(0, 0, 0), 0, FACING.BEHIND_ARC_DEG)).toBe(false);
    // 正侧面（90°）超出 120° 区域的一半（60°），不算背后
    expect(isBehind(vec3(3, 0, 0), vec3(0, 0, 0), 0, FACING.BEHIND_ARC_DEG)).toBe(false);
  });

  it('6.5 — 镜头朝向不能替代角色朝向', () => {
    // 角色面向 -Z，目标在 +Z（身后）。即使镜头转过去看着目标，isFacing 传的是角色 yaw，仍为 false
    const characterYaw = 0;
    const cameraYawLookingBack = Math.PI;
    expect(isFacing(vec3(0, 0, 0), characterYaw, vec3(0, 0, 5))).toBe(false);
    // 传镜头 yaw 会得到 true —— 这正是不允许发生的，此处仅作对照说明
    expect(isFacing(vec3(0, 0, 0), cameraYawLookingBack, vec3(0, 0, 5))).toBe(true);
  });
});

describe('6.3 六种范围形状', () => {
  it('圆形：碰撞体擦到边界即命中', () => {
    expect(hitCircle(vec3(0, 0, 0), 5, at(5.4, 0, 0))).toBe(true);
    expect(hitCircle(vec3(0, 0, 0), 5, at(5.6, 0, 0))).toBe(false);
  });

  it('环形：内圈是安全区，外圈之外也安全', () => {
    expect(hitRing(vec3(0, 0, 0), 3, 6, at(4.5, 0, 0))).toBe(true);
    expect(hitRing(vec3(0, 0, 0), 3, 6, at(1, 0, 0))).toBe(false); // 内圈里
    expect(hitRing(vec3(0, 0, 0), 3, 6, at(9, 0, 0))).toBe(false); // 外圈外
  });

  it('锥形：正前方命中，背后不受影响', () => {
    // yaw = 0 面向 -Z，90 度扇形，5 米
    expect(hitCone(vec3(0, 0, 0), 0, 90, 5, at(0, 0, -4))).toBe(true);
    expect(hitCone(vec3(0, 0, 0), 0, 90, 5, at(0, 0, 4))).toBe(false);
    expect(hitCone(vec3(0, 0, 0), 0, 90, 5, at(0, 0, -9))).toBe(false); // 超距
  });

  it('锥形：贴身目标一定在扇形内', () => {
    expect(hitCone(vec3(0, 0, 0), 0, 60, 5, at(0.2, 0, 0.2))).toBe(true);
  });

  it('锥形：边界附近按碰撞体切线补偿', () => {
    // 45° 半角边界外一点点，但目标半径 0.45 在 4 米处张开约 6.5°，应被补偿进来
    const justOutside = 46 * DEG;
    const p = at(Math.sin(justOutside) * -4 * -1, 0, -Math.cos(justOutside) * 4);
    expect(hitCone(vec3(0, 0, 0), 0, 90, 5, p)).toBe(true);
  });

  it('直线：胶囊体判定', () => {
    expect(hitLine(vec3(0, 0, 0), 0, 20, 2, at(0.9, 0, -10))).toBe(true);
    expect(hitLine(vec3(0, 0, 0), 0, 20, 2, at(3, 0, -10))).toBe(false);
    expect(hitLine(vec3(0, 0, 0), 0, 20, 2, at(0, 0, -25))).toBe(false); // 超长
  });

  it('链式：每次跳到最近的未命中目标', () => {
    const a = at(0, 0, 2);
    const b = at(0, 0, 5);
    const c = at(0, 0, 20);
    const hit = new Set<HitCircle>();
    const first = nextChainTarget(vec3(0, 0, 0), [a, b, c], 8, hit);
    expect(first).toBe(a);
    hit.add(a);
    expect(nextChainTarget(a.position, [a, b, c], 8, hit)).toBe(b);
    hit.add(b);
    // c 在 15 米外，超出 8 米跳转距离
    expect(nextChainTarget(b.position, [a, b, c], 8, hit)).toBeUndefined();
  });
});

describe('6.4 视线与障碍物', () => {
  const wall: Aabb = { min: vec3(-1, 0, -1), max: vec3(1, 4, 1) };
  const lowRailing: Aabb = { min: vec3(-1, 0, -1), max: vec3(1, 0.6, 1), blocksSight: false };

  it('验收 #11 — 墙体阻挡视线', () => {
    expect(hasLineOfSight(at(0, 0, -6), at(0, 0, 6), [wall])).toBe(false);
    expect(hasLineOfSight(at(0, 0, -6), at(0, 0, 6), [])).toBe(true);
  });

  it('验收 #11 — 低矮栏杆不造成无视线', () => {
    expect(hasLineOfSight(at(0, 0, -6), at(0, 0, 6), [lowRailing])).toBe(true);
  });

  it('绕过墙体侧面可以看到', () => {
    expect(hasLineOfSight(at(-5, 0, -6), at(-5, 0, 6), [wall])).toBe(true);
  });

  it('6.4 — 地面范围不能穿过封闭墙体放置', () => {
    expect(isGroundPositionLegal(at(0, 0, -6), vec3(0, 0, 6), [wall])).toBe(false);
    expect(isGroundPositionLegal(at(0, 0, -6), vec3(0, 0, -3), [wall])).toBe(true);
  });
});

describe('6.6 碰撞投射物（验收 #12）', () => {
  it('命中路径上最近的目标', () => {
    const near = at(0, 0, -5);
    const far = at(0, 0, -15);
    const hit = firstProjectileHit(vec3(0, 0, 0), vec3(0, 0, -20), 0.2, [near, far]);
    expect(hit?.target).toBe(near);
  });

  it('偏离轨迹的目标不被命中 —— 碰撞投射物可以被躲开', () => {
    const dodged = at(4, 0, -5);
    expect(firstProjectileHit(vec3(0, 0, 0), vec3(0, 0, -20), 0.2, [dodged])).toBeUndefined();
  });
});

describe('13.5 / 验收 #46 — 位移技能必须停在合法位置', () => {
  const wall: Aabb = { min: vec3(-5, 0, 4), max: vec3(5, 4, 6) };

  it('冲锋撞墙时停在墙前，不穿墙', () => {
    const landing = clampDisplacement(vec3(0, 0, 0), vec3(0, 0, 20), GEOMETRY.HITBOX_RADIUS, [wall]);
    expect(landing.z).toBeLessThan(4);
    expect(landing.z).toBeGreaterThan(0);
  });

  it('无阻挡时到达目标点', () => {
    const landing = clampDisplacement(vec3(0, 0, 0), vec3(0, 0, -20), GEOMETRY.HITBOX_RADIUS, [wall]);
    expect(landing.z).toBeCloseTo(-20);
  });
});
