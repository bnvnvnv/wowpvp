/**
 * 移动物理测试。每个 describe 对应规格书 13.5 表格的一行或一条验收标准。
 */

import { describe, expect, it } from 'vitest';
import { GEOMETRY, MOVE } from '../constants/combat.js';
import type { Aabb } from '../math/geometry.js';
import { vec3 } from '../math/vec3.js';
import { box } from '../data/maps/schema.js';
import {
  MOVEMENT,
  createMovementState,
  cylinderOverlapsAabb,
  findGroundY,
  isInWater,
  movementLockOf,
  separationVelocity,
  stepMovement,
  teleportTo,
  type MovementInput,
  type MovementState,
} from './movement.js';

const DT = 1 / 60;
const ground: Aabb = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 200, h: 1, d: 200 });

const idle: MovementInput = { forward: 0, strafe: 0, jump: false, yaw: 0 };
const fwd = (yaw = 0): MovementInput => ({ forward: 1, strafe: 0, jump: false, yaw });

/** 跑 n 帧，返回最终状态 */
const run = (
  s: MovementState,
  input: MovementInput | ((i: number) => MovementInput),
  obstacles: readonly Aabb[],
  frames: number,
): MovementState => {
  let cur = s;
  for (let i = 0; i < frames; i++) {
    const inp = typeof input === 'function' ? input(i) : input;
    cur = stepMovement(cur, inp, DT, obstacles).state;
  }
  return cur;
};

/** 落到地面上并稳定下来 */
const settle = (pos = vec3(0, 2, 0), obstacles: readonly Aabb[] = [ground]): MovementState =>
  run(createMovementState(pos), idle, obstacles, 60);

describe('碰撞基元', () => {
  it('圆柱与 AABB 的相交判定', () => {
    const b = box('b', 'wall', { x: 0, y: 0, z: 0 }, { w: 2, h: 4, d: 2 });
    expect(cylinderOverlapsAabb(vec3(0, 0, 0), 0.45, 2, b)).toBe(true);
    expect(cylinderOverlapsAabb(vec3(5, 0, 0), 0.45, 2, b)).toBe(false);
    // 贴边：圆心距墙面 1.2，半径 0.45 → 不相交
    expect(cylinderOverlapsAabb(vec3(2.2, 0, 0), 0.45, 2, b)).toBe(false);
    // 高度不重叠
    expect(cylinderOverlapsAabb(vec3(0, 10, 0), 0.45, 2, b)).toBe(false);
  });

  it('findGroundY 找到脚下最高的可站立面', () => {
    const low = box('low', 'floor', { x: 0, y: 0, z: 0 }, { w: 4, h: 1, d: 4 });
    const high = box('high', 'floor', { x: 0, y: 0, z: 0 }, { w: 4, h: 2, d: 4 });
    expect(findGroundY(vec3(0, 3, 0), 0.45, [low, high], 5)).toBe(2);
  });

  it('standable:false 的装饰体不能站', () => {
    const deco = box('d', 'arch', { x: 0, y: 0, z: 0 }, { w: 4, h: 2, d: 4 }, { standable: false });
    expect(findGroundY(vec3(0, 3, 0), 0.45, [deco], 5)).toBeUndefined();
  });
});

describe('8.1 基础速度', () => {
  it('前进达到 7 米/秒', () => {
    const s = run(settle(), fwd(), [ground], 120);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(MOVE.BASE_SPEED, 1);
  });

  it('后退约为前进的 65%', () => {
    const s = run(settle(), { forward: -1, strafe: 0, jump: false, yaw: 0 }, [ground], 120);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(
      MOVE.BASE_SPEED * MOVE.BACKWARD_FACTOR,
      1,
    );
  });

  it('侧移与前进同速', () => {
    const s = run(settle(), { forward: 0, strafe: 1, jump: false, yaw: 0 }, [ground], 120);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(MOVE.BASE_SPEED, 1);
  });

  it('斜向输入不比直线快', () => {
    const s = run(settle(), { forward: 1, strafe: 1, jump: false, yaw: 0 }, [ground], 120);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeLessThanOrEqual(MOVE.BASE_SPEED + 0.05);
  });
});

describe('13.5 墙体 — 不能穿墙，斜向碰撞沿墙滑动（验收 #44）', () => {
  const wall = box('w', 'wall', { x: 0, y: 0, z: -5 }, { w: 20, h: 4, d: 1 });

  it('正面撞墙会被挡住', () => {
    const s = run(settle(vec3(0, 1, 0)), fwd(), [ground, wall], 120);
    // 墙面在 z = -5.5，角色半径 0.45 → 最多到 -5.05
    expect(s.position.z).toBeGreaterThan(-5.1);
  });

  it('斜向撞墙时沿墙滑动，而不是卡死', () => {
    // 朝左前方 45° 推进
    const diagonal: MovementInput = { forward: 1, strafe: -1, jump: false, yaw: 0 };
    const s = run(settle(vec3(0, 1, -3)), diagonal, [ground, wall], 120);
    expect(s.position.z).toBeGreaterThan(-5.1); // 没穿墙
    expect(s.position.x).toBeLessThan(-3); // 但沿着墙滑出去了
  });

  it('墙角不产生高频抖动', () => {
    const wallA = box('a', 'wall', { x: 0, y: 0, z: -5 }, { w: 20, h: 4, d: 1 });
    const wallB = box('b', 'wall', { x: -5, y: 0, z: 0 }, { w: 1, h: 4, d: 20 });
    const diagonal: MovementInput = { forward: 1, strafe: -1, jump: false, yaw: 0 };
    let s = settle(vec3(-3, 1, -3), [ground, wallA, wallB]);
    const positions: number[] = [];
    for (let i = 0; i < 90; i++) {
      s = stepMovement(s, diagonal, DT, [ground, wallA, wallB]).state;
      positions.push(s.position.x + s.position.z);
    }
    // 稳定后每帧位移应当趋近 0 且单调，不应来回跳
    const tail = positions.slice(-20);
    for (let i = 1; i < tail.length; i++) {
      expect(Math.abs(tail[i]! - tail[i - 1]!)).toBeLessThan(0.02);
    }
  });
});

describe('13.5 低障碍与楼梯 — 自动跨越，脚部贴地（验收 #44）', () => {
  it('0.3 米路缘可以自动跨越', () => {
    const curb = box('c', 'floor', { x: 0, y: 0, z: -5 }, { w: 20, h: 0.3, d: 1 });
    const s = run(settle(vec3(0, 1, 0)), fwd(), [ground, curb], 150);
    expect(s.position.z).toBeLessThan(-6); // 越过去了
  });

  it('高于 STEP_HEIGHT 的墙不能跨越', () => {
    const tooHigh = box('t', 'wall', { x: 0, y: 0, z: -5 }, { w: 20, h: 1.5, d: 1 });
    const s = run(settle(vec3(0, 1, 0)), fwd(), [ground, tooHigh], 150);
    expect(s.position.z).toBeGreaterThan(-5.1);
  });

  it('走楼梯时保持贴地，不进入跳跃状态', () => {
    // 五级台阶（顶面 0.35/0.7/1.05/1.4/1.75）+ 顶部平台。
    // 没有顶部平台的话角色会走过尽头掉下去，那是正确物理而不是 bug。
    const stairs = Array.from({ length: 5 }, (_, i) =>
      box(`s${i}`, 'floor', { x: 0, y: 0, z: -3 - i * 1.2 }, { w: 6, h: 0.35 * (i + 1), d: 1.2 }),
    );
    const platform = box('top', 'floor', { x: 0, y: 0, z: -12 }, { w: 6, h: 1.75, d: 6 });
    const obstacles = [ground, ...stairs, platform];

    let s = settle(vec3(0, 1, 0), obstacles);
    let leftGround = 0;
    for (let i = 0; i < 120; i++) {
      s = stepMovement(s, fwd(), DT, obstacles).state;
      if (!s.grounded) leftGround++;
    }
    expect(s.position.y).toBeCloseTo(1.75, 2); // 爬到顶了
    expect(leftGround).toBe(0); // 全程贴地
  });

  it('下坡时脚部贴地，不会一路弹跳', () => {
    // 六级下行台阶，每级降 0.3 米（< GROUND_SNAP 0.45），顶面 2.0 → 0.5
    const steps = Array.from({ length: 6 }, (_, i) =>
      box(`d${i}`, 'floor', { x: 0, y: 0, z: -i * 1.5 }, { w: 6, h: 2 - i * 0.3, d: 1.5 }),
    );
    let s = run(createMovementState(vec3(0, 2, 0)), idle, steps, 60);
    expect(s.position.y).toBe(2);

    let airborne = 0;
    // 60 帧走约 6.6 米，正好走到第五级，不会冲出台阶尽头（z = -8.25）
    for (let i = 0; i < 60; i++) {
      s = stepMovement(s, fwd(), DT, steps).state;
      if (!s.grounded) airborne++;
    }
    expect(s.position.y).toBeLessThan(2); // 确实下来了
    expect(airborne).toBe(0); // 全程贴地，一帧都没弹起来
  });
});

describe('13.5 陡坡 — 不能斜向跳爬（验收 #44）', () => {
  it('3 米高台跳不上去', () => {
    const cliff = box('cliff', 'wall', { x: 0, y: 0, z: -6 }, { w: 20, h: 3, d: 8 });
    const jumping = (): MovementInput => ({ forward: 1, strafe: 0, jump: true, yaw: 0 });
    const s = run(settle(vec3(0, 1, 0)), jumping, [ground, cliff], 300);
    expect(s.position.y).toBeLessThan(3);
    expect(s.position.z).toBeGreaterThan(-2.1);
  });
});

describe('13.5 / 验收 #45 跳跃 — 保留动量、不增速、不瞬间反向', () => {
  it('跳跃高度约 1.2 米，够上台阶不够爬高台', () => {
    let s = settle();
    let maxY = s.position.y;
    s = stepMovement(s, { ...idle, jump: true }, DT, [ground]).state;
    for (let i = 0; i < 120; i++) {
      s = stepMovement(s, idle, DT, [ground]).state;
      maxY = Math.max(maxY, s.position.y);
    }
    expect(maxY).toBeGreaterThan(1.0);
    expect(maxY).toBeLessThan(1.4);
  });

  it('无连续二段跳（4.2）', () => {
    let s = settle();
    s = stepMovement(s, { ...idle, jump: true }, DT, [ground]).state;
    const vyAfterFirst = s.velocity.y;
    // 空中再按跳
    s = stepMovement(s, { ...idle, jump: true }, DT, [ground]).state;
    expect(s.velocity.y).toBeLessThan(vyAfterFirst); // 只受重力影响，没有二次起跳
  });

  it('跳跃保留水平动量', () => {
    let s = run(settle(), fwd(), [ground], 120);
    const speedBefore = Math.hypot(s.velocity.x, s.velocity.z);
    s = stepMovement(s, { ...fwd(), jump: true }, DT, [ground]).state;
    s = run(s, idle, [ground], 10); // 空中松开按键
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeGreaterThan(speedBefore * 0.8);
  });

  it('★ 空中画圈不能累积速度（bunny-hop 防护）', () => {
    let s = run(settle(), fwd(), [ground], 120);
    const cap = Math.hypot(s.velocity.x, s.velocity.z);
    s = stepMovement(s, { ...fwd(), jump: true }, DT, [ground]).state;

    // 空中持续改变输入方向绕圈，尝试累积速度
    let maxSpeed = 0;
    for (let i = 0; i < 60; i++) {
      const yaw = (i / 60) * Math.PI * 2;
      s = stepMovement(s, { forward: 1, strafe: 0, jump: false, yaw }, DT, [ground]).state;
      maxSpeed = Math.max(maxSpeed, Math.hypot(s.velocity.x, s.velocity.z));
    }
    expect(maxSpeed).toBeLessThanOrEqual(cap + 0.01);
  });

  /**
   * ★★ 8.4 × 13.5 的边界（docs/10 偏差 #13 的闭合断言，设计侧已拍板按 bug 口径）：
   *   **被减速时跳起来也是减速的** —— 起跳不是反减速的操作技巧。
   *
   *   两道闸共同保证：空中目标速度 = `BASE_SPEED × speedMultiplier`（缩放过），
   *   且 `airSpeedCap` 锁的是**起跳瞬间的实际速度**。任何一道被改掉
   *   （比如空中目标改回未缩放的 BASE_SPEED），这两条断言就红。
   *   偏差 #13 当时实测到 6.97 m/s，是试验场尚未接 speedMultiplier 时量的。
   */
  it('★ 被减速起跳：空中同样被减速，回不到基础速度', () => {
    const slowed = { speedMultiplier: 0.7 };
    let s = settle();
    for (let i = 0; i < 120; i++) s = stepMovement(s, fwd(), DT, [ground], slowed).state;
    const groundSpeed = Math.hypot(s.velocity.x, s.velocity.z);
    expect(groundSpeed).toBeCloseTo(MOVE.BASE_SPEED * 0.7, 1);

    s = stepMovement(s, { ...fwd(), jump: true }, DT, [ground], slowed).state;
    let maxAir = 0;
    for (let i = 0; i < 120 && !s.grounded; i++) {
      s = stepMovement(s, fwd(), DT, [ground], slowed).state;
      maxAir = Math.max(maxAir, Math.hypot(s.velocity.x, s.velocity.z));
    }
    expect(maxAir).toBeLessThanOrEqual(groundSpeed + 0.01);
  });

  it('★ 减速在空中到期，也不能超过起跳前的速度（airSpeedCap 锁在起跳瞬间）', () => {
    const slowed = { speedMultiplier: 0.7 };
    let s = settle();
    for (let i = 0; i < 120; i++) s = stepMovement(s, fwd(), DT, [ground], slowed).state;
    const jumpSpeed = Math.hypot(s.velocity.x, s.velocity.z);

    s = stepMovement(s, { ...fwd(), jump: true }, DT, [ground], slowed).state;
    let maxAir = 0;
    for (let i = 0; i < 120 && !s.grounded; i++) {
      // 减速到期：倍率回到 1，目标速度回到 7 —— 但空中上限不放行
      s = stepMovement(s, fwd(), DT, [ground]).state;
      maxAir = Math.max(maxAir, Math.hypot(s.velocity.x, s.velocity.z));
    }
    expect(maxAir).toBeLessThanOrEqual(jumpSpeed + 0.01);
  });

  it('空中转向明显慢于地面（有限空中修正）', () => {
    // 地面上反向
    let groundState = run(settle(), fwd(0), [ground], 120);
    groundState = run(groundState, fwd(Math.PI), [ground], 6);

    // 空中反向
    let airState = run(settle(), fwd(0), [ground], 120);
    airState = stepMovement(airState, { ...fwd(0), jump: true }, DT, [ground]).state;
    airState = run(airState, fwd(Math.PI), [ground], 6);

    // 两者都从「velocity.z = -7（朝 -Z 全速）」开始反向。
    // 6 帧后各自离初始速度有多远 —— 地面应该甩开空中一大截。
    const initialVz = -MOVE.BASE_SPEED;
    const groundChange = Math.abs(groundState.velocity.z - initialVz);
    const airChange = Math.abs(airState.velocity.z - initialVz);
    expect(groundChange).toBeGreaterThan(airChange * 5);
  });
});

describe('13.5 坠落', () => {
  it('落地时报告落差', () => {
    let s = createMovementState(vec3(0, 12, 0));
    let landing;
    for (let i = 0; i < 200 && !landing; i++) {
      const r = stepMovement(s, idle, DT, [ground]);
      s = r.state;
      landing = r.landing;
    }
    expect(landing).toBeDefined();
    expect(landing!.fallHeight).toBeGreaterThan(MOVEMENT.FALL_DAMAGE_HEIGHT);
    expect(landing!.intoWater).toBe(false);
  });

  it('落入深水时标记 intoWater —— 可终止坠落伤害', () => {
    const water = box('water', 'water', { x: 0, y: -1, z: 0 }, { w: 20, h: 1, d: 20 }, {
      blocksMovement: false,
      standable: false,
      endsFallDamage: true,
    });
    const pool = box('pool_bottom', 'floor', { x: 0, y: -2, z: 0 }, { w: 20, h: 1, d: 20 });
    let s = createMovementState(vec3(0, 12, 0));
    let landing;
    for (let i = 0; i < 200 && !landing; i++) {
      const r = stepMovement(s, idle, DT, [pool, water]);
      s = r.state;
      landing = r.landing;
    }
    expect(landing?.intoWater).toBe(true);
  });
});

describe('13.5 玩家碰撞 — 软推开，不形成实体堵门（验收 #43）', () => {
  it('重叠时产生分离速度', () => {
    const v = separationVelocity(vec3(0, 0, 0), [vec3(0.3, 0, 0)], GEOMETRY.HITBOX_RADIUS);
    expect(v.x).toBeLessThan(0); // 被推向 -X
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0);
  });

  it('距离足够时不产生推力', () => {
    const v = separationVelocity(vec3(0, 0, 0), [vec3(5, 0, 0)], GEOMETRY.HITBOX_RADIUS);
    expect(Math.hypot(v.x, v.z)).toBe(0);
  });

  it('推力有上限，不能把人弹飞', () => {
    const v = separationVelocity(vec3(0, 0, 0), [vec3(0.01, 0, 0)], GEOMETRY.HITBOX_RADIUS);
    expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(MOVEMENT.SEPARATION_STRENGTH + 0.01);
  });

  /**
   * ★★ 接线断言：`stepMovement` 的 `separation` 输入真的会把人挪开。
   *   `separationVelocity` 从 M1 就在、测试也绿 —— 但**零调用方**，
   *   角色可以完全重叠站成一个点。这两条钉的是「函数被积分消费」这件事。
   */
  it('★ separation 输入参与位移积分：站着不动也会被挤开', () => {
    let s = settle();
    const other = vec3(0.3, 0, 0); // 深度重叠
    for (let i = 0; i < 30; i++) {
      const sep = separationVelocity(s.position, [other], GEOMETRY.HITBOX_RADIUS);
      s = stepMovement(s, idle, DT, [ground], { separation: sep }).state;
    }
    const d = Math.hypot(s.position.x - other.x, s.position.z - other.z);
    expect(d).toBeGreaterThanOrEqual(GEOMETRY.HITBOX_RADIUS * 2 - 0.05); // 被推出重叠
    // 软推开是外力位移不是动量：推完不留残余速度（松开后不继续滑）
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeLessThan(0.05);
  });

  it('★ 软推开推不进墙 —— 与玩家自己的移动受同一套碰撞约束', () => {
    const wall = box('w', 'wall', { x: -1.45, y: 0, z: -2 }, { w: 1, h: 3, d: 4 });
    let s = settle();
    // 对手站在正东侧、把人往墙（西侧）里推
    for (let i = 0; i < 30; i++) {
      const sep = separationVelocity(s.position, [vec3(0.3, 0, 0)], GEOMETRY.HITBOX_RADIUS);
      s = stepMovement(s, idle, DT, [ground, wall], { separation: sep }).state;
    }
    // 确实被推向了墙的方向……
    expect(s.position.x).toBeLessThan(-0.3);
    // ……但停在墙面（x=-0.95）+ 胶囊半径（0.45）处，绝不能进墙
    expect(s.position.x).toBeGreaterThan(-0.95 + GEOMETRY.HITBOX_RADIUS - 0.02);
  });
});

describe('13.4 / 验收 #47 — 传送不能被识别为高速跑步', () => {
  it('传送后置位 teleported 标记且水平位移记为 0', () => {
    const s = settle();
    const t = teleportTo(s, vec3(20, 5, 20), [ground]);
    expect(t.teleported).toBe(true);
    expect(t.lastHorizontalDistance).toBe(0);
    expect(t.position.y).toBe(0); // 吸附到地面
  });

  it('正常跑步不置位 teleported', () => {
    const s = run(settle(), fwd(), [ground], 120);
    expect(s.teleported).toBe(false);
    expect(s.lastHorizontalDistance).toBeGreaterThan(0);
  });
});

describe('确定性 —— 客户端预测回放的前提', () => {
  it('相同输入序列产生逐位相同的结果', () => {
    const obstacles = [
      ground,
      box('w', 'wall', { x: 0, y: 0, z: -5 }, { w: 20, h: 4, d: 1 }),
    ];
    const inputs = (i: number): MovementInput => ({
      forward: Math.sin(i / 7) > 0 ? 1 : -1,
      strafe: Math.cos(i / 11) > 0 ? 1 : 0,
      jump: i % 37 === 0,
      yaw: (i / 50) % (Math.PI * 2),
    });
    const a = run(settle(vec3(0, 1, 0), obstacles), inputs, obstacles, 300);
    const b = run(settle(vec3(0, 1, 0), obstacles), inputs, obstacles, 300);
    expect(a.position).toEqual(b.position);
    expect(a.velocity).toEqual(b.velocity);
  });

  it('stepMovement 是纯函数，不修改入参', () => {
    const s = settle();
    const snapshot = JSON.parse(JSON.stringify(s));
    stepMovement(s, fwd(), DT, [ground]);
    expect(JSON.parse(JSON.stringify(s))).toEqual(snapshot);
  });
});

describe('障碍物空间索引 —— movement 侧逐位等价（P11 性能改造的正确性闸门）', () => {
  /**
   * geometry.test.ts 已对线段查询做了索引/线性对拍；这里补点查询侧：
   *   · findGroundY —— 谓词取 max，走 GROUND_SCRATCH
   *   · isInWater  —— 谓词布尔 OR，走 WATER_SCRATCH
   *   · obstaclesInRect 的**超集性质**（collides 不导出，它的正确性由
   *     「候选集是超集 + 谓词幂等」保证，超集性质在此单独站岗）
   */
  const mulberry32 = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('findGroundY / isInWater 在 128 盒地图上与线性版一致；候选集是超集', async () => {
    const { ctfMap } = await import('../data/maps/ctf.js');
    const { obstaclesInRect } = await import('../math/geometry.js');
    const obstacles = ctfMap.geometry;
    expect(obstacles.length).toBeGreaterThanOrEqual(16);

    const rand = mulberry32(20260809);
    const R = 0.45;

    const linearGround = (p: { x: number; y: number; z: number }, maxDrop: number) => {
      let best: number | undefined;
      const lo = p.y - maxDrop;
      for (const b of obstacles) {
        if (b.blocksMovement === false) continue;
        if (b.standable === false) continue;
        if (b.max.y > p.y + 1e-3 || b.max.y < lo) continue;
        const cx = Math.min(Math.max(p.x, b.min.x), b.max.x);
        const cz = Math.min(Math.max(p.z, b.min.z), b.max.z);
        const dx = p.x - cx;
        const dz = p.z - cz;
        if (dx * dx + dz * dz >= R * R) continue;
        if (best === undefined || b.max.y > best) best = b.max.y;
      }
      return best;
    };
    const linearWater = (p: { x: number; y: number; z: number }) =>
      obstacles.some(
        (b) => b.endsFallDamage === true &&
          p.x >= b.min.x && p.x <= b.max.x &&
          p.z >= b.min.z && p.z <= b.max.z &&
          p.y <= b.max.y + 0.5,
      );

    const scratch: typeof obstacles[number][] = [];
    for (let i = 0; i < 800; i++) {
      const p = vec3(rand() * 200 - 100, rand() * 12, rand() * 400 - 200);
      expect(findGroundY(p, R, obstacles, 5)).toBe(linearGround(p, 5));
      expect(isInWater(p, obstacles)).toBe(linearWater(p));

      // 超集性质：矩形线性命中的每个盒子都必须出现在候选集里
      const w = rand() * 6, h = rand() * 6;
      const got = new Set(obstaclesInRect(obstacles, p.x, p.z, p.x + w, p.z + h, scratch));
      for (const b of obstacles) {
        const overlaps = b.max.x >= p.x && b.min.x <= p.x + w && b.max.z >= p.z && b.min.z <= p.z + h;
        if (overlaps) expect(got.has(b)).toBe(true);
      }
    }
  });
});

/**
 * 控制效果的移动锁（X10 真机轮实测发现的缺口：`flags.rooted` 此前在移动
 * 积分链上零消费方 —— 定身的光环只置标志，减速链不认它，「定身的战士
 * 照样追人」。修法见 `MovementLock` 的注释）。
 */
describe('控制移动锁（定身/昏迷）', () => {
  const rooted = { lock: 'move' as const };
  const stunned = { lock: 'full' as const };

  it("movementLockOf：stunned → 'full'，rooted → 'move'，否则 'none'（stunned 优先）", () => {
    expect(movementLockOf({ stunned: false, rooted: false })).toBe('none');
    expect(movementLockOf({ stunned: false, rooted: true })).toBe('move');
    expect(movementLockOf({ stunned: true, rooted: false })).toBe('full');
    expect(movementLockOf({ stunned: true, rooted: true })).toBe('full');
  });

  it("★ 'move'（定身）：不能走、不能跳，但可以转身", () => {
    let s = run(settle(), fwd(), [ground], 60); // 先跑起来（满速）
    const from = { ...s.position };
    // 定身后继续按 W + 跳：位置应收敛停住，不产生新位移
    for (let i = 0; i < 60; i++) {
      s = stepMovement(s, { ...fwd(Math.PI / 2), jump: true }, DT, [ground], rooted).state;
    }
    // 转身生效（yaw 采信输入）……
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 5);
    // ……但速度衰减到零、没有起跳
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeLessThan(0.01);
    expect(s.grounded).toBe(true);
    // 惯性滑行距离有限（GROUND_ACCEL 把速度拉回 0 的那零点几米）
    const drift = Math.hypot(s.position.x - from.x, s.position.z - from.z);
    expect(drift).toBeLessThan(1);
  });

  it("★ 'full'（昏迷）：连转身一起锁", () => {
    let s = settle();
    for (let i = 0; i < 30; i++) {
      s = stepMovement(s, { ...fwd(Math.PI / 2), jump: true }, DT, [ground], stunned).state;
    }
    expect(s.yaw).toBe(0); // 输入的 yaw 被忽略，保持 settle 时的 0
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeLessThan(0.01);
    expect(s.grounded).toBe(true);
  });

  it('★ 锁的是意图不是物理：定身在空中照样吃重力落地', () => {
    // 从空中开始（3 米高），全程定身 —— 必须正常落到地面
    let s = createMovementState(vec3(0, 3, 0));
    for (let i = 0; i < 120; i++) {
      s = stepMovement(s, fwd(), DT, [ground], rooted).state;
    }
    expect(s.grounded).toBe(true);
    expect(s.position.y).toBeCloseTo(0, 1);
  });

  it('锁下软推开照常：定身的角色仍会被挤开让位（A2 口径）', () => {
    let s = settle();
    const before = s.position.x;
    for (let i = 0; i < 30; i++) {
      s = stepMovement(s, idle, DT, [ground], {
        ...rooted,
        separation: separationVelocity(s.position, [vec3(s.position.x - 0.3, 0, s.position.z)], GEOMETRY.HITBOX_RADIUS),
      }).state;
    }
    expect(s.position.x).toBeGreaterThan(before + 0.05); // 被从 -X 方向推开
  });

  it("lock 缺省 = 'none'：不带锁的一切行为不变（回归哨兵）", () => {
    const a = run(settle(), fwd(), [ground], 60);
    let b = settle();
    for (let i = 0; i < 60; i++) {
      b = stepMovement(b, fwd(), DT, [ground], { lock: 'none' }).state;
    }
    expect(b.position).toEqual(a.position);
    expect(b.velocity).toEqual(a.velocity);
  });
});
