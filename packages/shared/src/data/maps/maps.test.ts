/**
 * 地图公平性与尺寸测试。对应规格书 11.2 / 11.3 与验收 #24。
 *
 * 11.3 的公平约束是**可机器校验**的 —— 这个文件把每一条都写成断言，
 * 以后任何人加新地图都会被同一组规则约束。
 */

import { describe, expect, it } from 'vitest';
import { GEOMETRY, MOVE } from '../../constants/combat.js';
import { distance2D, vec3 } from '../../math/vec3.js';
import { GameMode } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { ARENA_MAPS, ARENA_SPECS } from './arena.js';
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

  it('三张地图尺寸依次递增（2v2 < 3v3 < 5v5）', () => {
    const sizes = ARENA_MAPS.map((m) => m.bounds.max.x - m.bounds.min.x);
    expect(sizes[0]!).toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[2]!);
  });

  it('掩体数量依次递增', () => {
    const counts = ARENA_MAPS.map((m) => m.geometry.filter((v) => v.tag === 'pillar').length);
    expect(counts[0]!).toBeLessThan(counts[1]!);
    expect(counts[1]!).toBeLessThan(counts[2]!);
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
  it('三张竞技场地图都已注册', () => {
    for (const m of ARENA_MAPS) {
      expect(ALL_MAPS.map((x) => x.id)).toContain(m.id);
    }
  });

  it('每张竞技场地图只服务一个模式', () => {
    expect(ARENA_MAPS.map((m) => m.modes)).toEqual([
      [GameMode.Arena2v2], [GameMode.Arena3v3], [GameMode.Arena5v5],
    ]);
  });

  it('地图 id 唯一', () => {
    const ids = ALL_MAPS.map((m) => m.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
