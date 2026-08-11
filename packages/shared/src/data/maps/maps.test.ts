/**
 * 地图公平性与尺寸测试。对应规格书 11.2 / 11.3 与验收 #24。
 *
 * 11.3 的公平约束是**可机器校验**的 —— 这个文件把每一条都写成断言，
 * 以后任何人加新地图都会被同一组规则约束。
 */

import { describe, expect, it } from 'vitest';
import { GEOMETRY, MOVE } from '../../constants/combat.js';
import { distance2D, vec3 } from '../../math/vec3.js';
import { createMovementState, stepMovement } from '../../sim/movement.js';
import { TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { ARENA_MAPS, ARENA_SPECS } from './arena.js';
import { ctfMap } from './ctf.js';
import { ALL_MAPS } from './index.js';
import type { MapDef } from './schema.js';

const center = vec3(0, 0, 0);

const spawnsOf = (map: MapDef, team: number) =>
  (map.prepRooms ?? []).filter((r) => (r.team as number) === team).flatMap((r) => r.spawns);

describe('11.2 竞技场尺寸与掩体（验收 #24）', () => {
  for (const [i, map] of ARENA_MAPS.entries()) {
    const spec = ARENA_SPECS[i]!;

    describe(`${map.name}（${spec.mode}）`, () => {
      it('出生点到中央的距离符合 11.2 的移动时间', () => {
        const d = distance2D(spawnsOf(map, TEAM_RED)[0]!.position, center);
        const seconds = d / MOVE.BASE_SPEED;
        // 允许 ±1.5 秒的实现余量
        expect(Math.abs(seconds - spec.spawnToCenterSeconds)).toBeLessThan(1.5);
      });

      it('★ 主要掩体数量符合 11.2', () => {
        const pillars = map.geometry.filter((v) => v.tag === 'pillar');
        expect(pillars.length).toBe(spec.pillarCount);
      });

      it('每队出生点数量等于队伍人数', () => {
        expect(spawnsOf(map, TEAM_RED)).toHaveLength(spec.teamSize);
        expect(spawnsOf(map, TEAM_BLUE)).toHaveLength(spec.teamSize);
      });
    });
  }

  it('地图尺寸沿梯子严格递增（P12：1v1 → 12v12）', () => {
    const sizes = ARENA_MAPS.map((m) => m.bounds.max.x - m.bounds.min.x);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i - 1]!).toBeLessThan(sizes[i]!);
  });

  it('掩体数量沿梯子严格递增', () => {
    const counts = ARENA_MAPS.map((m) => m.geometry.filter((v) => v.tag === 'pillar').length);
    for (let i = 1; i < counts.length; i++) expect(counts[i - 1]!).toBeLessThan(counts[i]!);
  });
});

describe('11.3 公平约束', () => {
  for (const map of ARENA_MAPS) {
    describe(map.name, () => {
      it('★ 双方出生点到中央的距离一致', () => {
        const red = spawnsOf(map, TEAM_RED).map((s) => distance2D(s.position, center));
        const blue = spawnsOf(map, TEAM_BLUE).map((s) => distance2D(s.position, center));
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        expect(Math.abs(avg(red) - avg(blue))).toBeLessThan(map.fairness.tolerance);
      });

      it('★ 不存在只有位移职业才能到达的可站立面', () => {
        expect(map.fairness.mobilityOnlyPlatforms).toEqual([]);

        // 更强的校验：所有柱子都高于跳跃高度，谁都上不去。
        // 跳跃约 1.18 米（MOVEMENT.JUMP_SPEED²/2g），这里用 2 米作保守阈值
        const climbable = map.geometry.filter(
          (v) => v.tag === 'pillar' && v.max.y - Math.max(0, v.min.y) < 2,
        );
        expect(climbable.map((v) => v.id)).toEqual([]);
      });

      it('★ 玩家不能重新进入准备区（开门后翻转为禁入）', () => {
        for (const room of map.prepRooms ?? []) {
          expect(room.reentry).toBe('blocked');
          const forbid = map.forbidden.find((f) => f.volume.min.z === room.volume.min.z);
          expect(forbid, `${room.id} 缺少对应的禁入体积`).toBeDefined();
          expect(forbid!.scope).toBe('all');
        }
      });

      it('11.1 双方大门同时开启', () => {
        const opensAt = new Set(map.gates.map((g) => g.opensAt));
        expect(opensAt.size).toBe(1);
      });

      it('★ 柱子之间留有通道，不形成永久安全点', () => {
        const pillars = map.geometry.filter((v) => v.tag === 'pillar');
        for (let i = 0; i < pillars.length; i++) {
          for (let j = i + 1; j < pillars.length; j++) {
            const a = pillars[i]!;
            const b = pillars[j]!;
            const ca = vec3((a.min.x + a.max.x) / 2, 0, (a.min.z + a.max.z) / 2);
            const cb = vec3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
            const gap = distance2D(ca, cb) - (a.max.x - a.min.x);
            // 通道宽度至少要能让两个角色并排通过
            expect(gap, `${a.id} 与 ${b.id} 之间通道过窄`)
              .toBeGreaterThan(GEOMETRY.HITBOX_RADIUS * 4);
          }
        }
      });

      it('出生点都在地图边界内', () => {
        for (const s of [...spawnsOf(map, TEAM_RED), ...spawnsOf(map, TEAM_BLUE)]) {
          expect(s.position.x).toBeGreaterThan(map.bounds.min.x);
          expect(s.position.x).toBeLessThan(map.bounds.max.x);
          expect(s.position.z).toBeGreaterThan(map.bounds.min.z);
          expect(s.position.z).toBeLessThan(map.bounds.max.z);
        }
      });

      it('四面外墙封闭 —— 不会从边界掉出去', () => {
        const walls = map.geometry.filter((v) => v.tag === 'wall' && v.id.startsWith('wall_'));
        expect(walls).toHaveLength(4);
      });
    });
  }
});

describe('地图注册表', () => {
  it('全部竞技场地图都已注册', () => {
    for (const m of ARENA_MAPS) {
      expect(ALL_MAPS.map((x) => x.id)).toContain(m.id);
    }
  });

  it('每张竞技场地图只服务一个模式（P12 全梯子按 SPECS 对齐）', () => {
    expect(ARENA_MAPS.map((m) => m.modes)).toEqual(ARENA_SPECS.map((s) => [s.mode]));
  });

  it('地图 id 唯一', () => {
    const ids = ALL_MAPS.map((m) => m.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * X1（技术债总账）：夺旗图装饰 —— 速赢清单「下一铲」的收尾。
 * ★ 装饰是纯表现（sim 不读），但**摆错位置会误导走位**：这里钉的全是
 *   「不挡承重路线」的否定式约束，与试验场「走廊必须空」同一个思路。
 */
describe('X1 夺旗图装饰', () => {
  const decor = ctfMap.decor ?? [];

  it('装饰存在且红蓝对称（蓝方 = 红方中心旋转）', () => {
    expect(decor.length).toBeGreaterThanOrEqual(24);
    expect(decor.length % 2).toBe(0);
    const half = decor.length / 2;
    for (let i = 0; i < half; i++) {
      const r = decor[i]!;
      const b = decor[half + i]!;
      expect(b.position.x).toBeCloseTo(-r.position.x, 6);
      expect(b.position.z).toBeCloseTo(-r.position.z, 6);
    }
  });

  it('全部在地图边界内', () => {
    for (const d of decor) {
      expect(Math.abs(d.position.x)).toBeLessThanOrEqual(72);
      expect(Math.abs(d.position.z)).toBeLessThanOrEqual(180);
    }
  });

  it('★ 不挡承重路线：中路让空、地道口让空、旗帜房与墓地内部不放', () => {
    for (const d of decor) {
      const { x, z } = d.position;
      const ax = Math.abs(x);
      const az = Math.abs(z);
      // 中央路线走廊（x=0 一路到旗房门口）
      expect(ax, `${d.model} 挡在中路上（x=${x}）`).toBeGreaterThanOrEqual(8);
      // 地道口（x 18..26 × z 64..90，两侧对称）—— M7 验收时真的有人掉进去过
      const inTrench = ax >= 17 && ax <= 27 && az >= 63 && az <= 91;
      expect(inTrench, `${d.model} 挡在地道口（${x},${z}）`).toBe(false);
      // 旗帜房内部（|x|<16 × z 110..142）与墓地内部（|x|<20 × z 150..168）
      const inRoom = ax < 16 && az > 110 && az < 142;
      const inGrave = ax < 20 && az > 150 && az < 168;
      expect(inRoom || inGrave, `${d.model} 摆进了旗帜房/墓地（${x},${z}）`).toBe(false);
    }
  });
});

/** W15：每张图一个昼夜（值的合法性由 client 侧 presetOf 测试钉住） */
describe('W15 环境预设', () => {
  it('每张图都配了 envPreset', () => {
    for (const m of ALL_MAPS) {
      expect(m.envPreset, `${m.id as string} 没配 envPreset`).toBeDefined();
    }
  });
});

/**
 * X10 试点地形（用户拍板：「竞技场要有复杂的地形 —— 视线遮挡、楼梯和小桥」）。
 * 11.3 的结构保证逐件断言 —— 这些不是「地形存在」的冒烟测试，每一条都对应
 * 一个会坏掉的具体方式：镜像破了是阵营不公平，级高超了是位移职业专属高台，
 * 净空矮了是桥下卡头，走廊被占是 bot（无寻路）直线流被断。
 */
describe('arena_3v3 试点地形（高台楼梯 + 跨桥 + 视线矮墙）', () => {
  const map = ARENA_MAPS.find((m) => (m.id as string) === 'arena_3v3')!;
  const vol = (id: string) => {
    const v = map.geometry.find((g) => g.id === id);
    if (!v) throw new Error(`试点件 ${id} 不存在`);
    return v;
  };
  const cx = (v: { min: { x: number }; max: { x: number } }): number => (v.min.x + v.max.x) / 2;
  const cz = (v: { min: { z: number }; max: { z: number } }): number => (v.min.z + v.max.z) / 2;
  const PILOT_IDS = [
    'plat_n', 'plat_s', 'plat_bridge', 'sight_wall_n', 'sight_wall_s',
    ...(['n', 's'] as const).flatMap((s) => [0, 1, 2, 3].map((i) => `plat_${s}_stair_${i}`)),
  ];

  it('★ 全部件 z→-z 镜像（±Z 两队公平的结构保证）', () => {
    const pairs: [string, string][] = [
      ['plat_n', 'plat_s'],
      ['sight_wall_n', 'sight_wall_s'],
      ...[0, 1, 2, 3].map((i): [string, string] => [`plat_n_stair_${i}`, `plat_s_stair_${i}`]),
    ];
    for (const [n, s] of pairs) {
      const a = vol(n);
      const b = vol(s);
      expect(cz(a), `${n}/${s} 的 z 不镜像`).toBeCloseTo(-cz(b), 5);
      expect(cx(a), `${n}/${s} 的 x 不一致`).toBeCloseTo(cx(b), 5);
      expect(a.max.y, `${n}/${s} 的高度不一致`).toBeCloseTo(b.max.y, 5);
    }
    // 桥自身跨中线
    expect(cz(vol('plat_bridge'))).toBeCloseTo(0, 5);
  });

  /**
   * ★★ **跑真解算器，不比数据。**
   *
   *   这条原本比的是「相邻两级的 `max.y` 差 ≤ STEP_HEIGHT + 1e-9」，
   *   全绿地放过了一个 blocker：级高当初写成 `PLAT_H − (i+1)*RISE` 倒着算，
   *   IEEE754 上比「抬升后的脚底」高 1 个 ulp，`tryStepUp` 直接 `return undefined`
   *   —— **实测直走停在 y=0.90，第三级永远上不去**，台顶只有会跳的人到得了，
   *   而 `fairness.mobilityOnlyPlatforms` 还是空的。那个 `+1e-9` 容差
   *   正好把差值吃掉了（见 `arena.ts` 的 `PILOT_STAIR_TOPS`）。
   *
   *   判定藏在解算器里，就得问解算器：从台脚起 `createMovementState` +
   *   `stepMovement` 一路直走，断言脚底真的踩到了台顶/桥面。
   */
  it('★★ 直走就能登上台顶与桥面（跑真解算器）—— 高台不是位移职业专属（11.3）', () => {
    const TICK = 1 / 60;
    const px = (vol('plat_s').min.x + vol('plat_s').max.x) / 2;
    /** 从 `from` 朝 `yaw` 直走，返回途中是否踩到过 `top` 的顶面 */
    const climbs = (
      from: { x: number; y: number; z: number }, yaw: number, topId: string,
    ): { ok: boolean; end: { x: number; y: number; z: number } } => {
      const top = vol(topId);
      let s = createMovementState(vec3(from.x, from.y, from.z), yaw);
      let ok = false;
      for (let i = 0; i < 20 * 60 && !ok; i++) {
        s = stepMovement(s, { forward: 1, strafe: 0, jump: false, yaw }, TICK, map.geometry).state;
        ok = Math.abs(s.position.y - top.max.y) < 1e-3
          && s.position.x > top.min.x - GEOMETRY.HITBOX_RADIUS
          && s.position.x < top.max.x + GEOMETRY.HITBOX_RADIUS
          && s.position.z > top.min.z - GEOMETRY.HITBOX_RADIUS
          && s.position.z < top.max.z + GEOMETRY.HITBOX_RADIUS;
      }
      return { ok, end: s.position };
    };

    for (const side of ['n', 's'] as const) {
      const pz = (vol(`plat_${side}`).min.z + vol(`plat_${side}`).max.z) / 2;
      // 楼梯朝东下行 → 从台东侧的地面朝西（yawToDir(π/2) = (−1, 0, 0)）直走
      const up = climbs({ x: px + 12, y: 0, z: pz }, Math.PI / 2, `plat_${side}`);
      expect(
        up.ok,
        `${side} 侧直走上不了台顶（y=${vol(`plat_${side}`).max.y}），`
        + `停在 (${up.end.x.toFixed(2)}, ${up.end.y.toFixed(2)}, ${up.end.z.toFixed(2)})`
        + ' —— 只有会跳的人上得去',
      ).toBe(true);

      // 台顶朝中线（yawToDir(0) = (0, 0, −1)；北台要朝 +z 所以取 π）走上桥面
      const onto = climbs(
        { x: px, y: vol(`plat_${side}`).max.y, z: pz }, side === 's' ? 0 : Math.PI, 'plat_bridge',
      );
      expect(
        onto.ok,
        `${side} 台顶走不上桥面（y=${vol('plat_bridge').max.y}），`
        + `停在 (${onto.end.x.toFixed(2)}, ${onto.end.y.toFixed(2)}, ${onto.end.z.toFixed(2)}）`,
      ).toBe(true);
    }
  });

  it('★ 桥下净空 ≥ 角色高度（桥下是通道，不是卡头的房梁）', () => {
    expect(vol('plat_bridge').min.y).toBeGreaterThanOrEqual(GEOMETRY.HITBOX_HEIGHT);
  });

  it('★ 出生走廊（|x| ≤ 准备区半宽）无任何新增几何 —— bot 无寻路，主通道保持直走可达', () => {
    const prepHalfW = 10; // 3v3 teamSize=3 → max(10, …) = 10，与 buildArena 同式
    for (const id of PILOT_IDS) {
      const v = vol(id);
      const overlaps = v.max.x >= -prepHalfW && v.min.x <= prepHalfW;
      expect(overlaps, `${id} 侵入出生走廊（x ∈ [${v.min.x.toFixed(1)}, ${v.max.x.toFixed(1)}]）`).toBe(false);
    }
  });

  it('试点只在 3v3：其余图不得混入试点件', () => {
    for (const m of ARENA_MAPS) {
      if ((m.id as string) === 'arena_3v3') continue;
      const leaked = m.geometry.some((v) => v.id.startsWith('plat_') || v.id.startsWith('sight_wall_'));
      expect(leaked, `${m.id as string} 混入了试点件`).toBe(false);
    }
  });
});
