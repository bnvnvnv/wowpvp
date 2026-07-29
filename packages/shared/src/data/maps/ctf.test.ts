/**
 * 夺旗地图结构测试。规格书 12.5 + 19.1，支撑验收 #38–#43。
 *
 * 12.5 的每一条都写成断言 —— 它们全是可量化的：
 * 路线时间、入口数量、出口数量、视线遮挡、对称性。
 * 以后谁改了地图坐标，跑一次测试就知道破了哪一条。
 */

import { describe, expect, it } from 'vitest';
import { hasLineOfSight } from '../../math/geometry.js';
import { distance2D } from '../../math/vec3.js';
import { GameMode } from '../../types/enums.js';
import { TEAM_BLUE, TEAM_RED, type TeamId } from '../../types/ids.js';
import { findGroundY } from '../../sim/movement.js';
import { ctfMap, graveyardSeesFlag, routeSeconds } from './ctf.js';
import { activeForbidden, ALL_MAPS } from './index.js';

const TEAMS: TeamId[] = [TEAM_RED, TEAM_BLUE];
const routeOf = (id: string) => ctfMap.routes!.find((r) => r.id === id)!;

/** 从高空往下扫，看这个 XZ 上有没有可站立的地面 */
const groundAt = (x: number, z: number, fromY = 30): number | undefined =>
  findGroundY({ x, y: fromY, z }, 0.5, ctfMap.geometry, fromY + 40);

describe('12.5 路线结构', () => {
  it('★ 从己方基地到敌方旗帜房约 35~45 秒（无战斗）', () => {
    for (const r of ctfMap.routes!) {
      const s = routeSeconds(r);
      expect(s, `${r.id} = ${s.toFixed(1)}s`).toBeGreaterThanOrEqual(35);
      expect(s, `${r.id} = ${s.toFixed(1)}s`).toBeLessThanOrEqual(45);
    }
  });

  it('★ 中央路线最短', () => {
    const center = routeSeconds(routeOf('route_center'));
    const others = ctfMap.routes!.filter((r) => r.kind !== 'center').map(routeSeconds);
    for (const s of others) expect(center).toBeLessThan(s);
  });

  it('三类路线都存在：中央 / 侧翼 / 地下', () => {
    const kinds = new Set(ctfMap.routes!.map((r) => r.kind));
    expect(kinds).toEqual(new Set(['center', 'flank', 'underground']));
  });

  it('★ 每条主路线至少两个出口', () => {
    for (const r of ctfMap.routes!) {
      expect(r.exits.length, r.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ 基地旗帜房至少两个入口', () => {
    for (const f of ctfMap.flags!) {
      expect(f.entrances.length, f.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('★ 复活区至少两个出口', () => {
    for (const g of ctfMap.graveyards!) {
      expect(g.exits.length, g.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('侧翼掩体比中央多（12.5：侧翼掩体多，中央开阔）', () => {
    const pillars = ctfMap.geometry.filter((v) => v.tag === 'pillar');
    const flank = pillars.filter((v) => Math.abs((v.min.x + v.max.x) / 2) > 30).length;
    const center = pillars.filter((v) => Math.abs((v.min.x + v.max.x) / 2) <= 30).length;
    expect(flank).toBeGreaterThan(center);
  });

  it('地道狭窄（宽度不超过 10 米）', () => {
    const floor = ctfMap.geometry.find((v) => v.id === 'tunnel_floor')!;
    expect(floor.max.x - floor.min.x).toBeLessThanOrEqual(10);
  });
});

describe('★ 12.5 复活区安全性（验收 #43）', () => {
  it('★★ 不能从复活区直接攻击旗帜房 —— 后墙挡住视线', () => {
    for (const team of TEAMS) {
      expect(graveyardSeesFlag(ctfMap, team), `${team as number} 队复活区能看到自己的旗`).toBe(false);
    }
  });

  it('★ 敌人不能进入复活安全区', () => {
    for (const g of ctfMap.graveyards!) {
      const forbid = ctfMap.forbidden.find((f) => f.volume.min.z === g.volume.min.z);
      expect(forbid, `${g.id} 缺少禁入体积`).toBeDefined();
      // 只禁敌方 —— 自己人当然要能待在自己的复活区里
      expect(forbid!.scope).toEqual({ forTeam: g.team === TEAM_RED ? TEAM_BLUE : TEAM_RED });
    }
  });

  it('复活出口分散，不会全挤在一个门口', () => {
    for (const g of ctfMap.graveyards!) {
      for (let i = 0; i < g.exits.length; i += 1) {
        for (let j = i + 1; j < g.exits.length; j += 1) {
          // 两个出口至少隔开 10 米，堵住一个还有别的路
          expect(distance2D(g.exits[i]!, g.exits[j]!), `${g.id} 出口 ${i}/${j} 太近`)
            .toBeGreaterThan(10);
        }
      }
    }
  });

  it('复活点与出口都站得住', () => {
    for (const g of ctfMap.graveyards!) {
      for (const s of g.spawns) expect(groundAt(s.position.x, s.position.z), s.id).toBeDefined();
      for (const [i, e] of g.exits.entries()) {
        expect(groundAt(e.x, e.z), `${g.id} exit ${i}`).toBeDefined();
      }
    }
  });
});

describe('11.3 公平性（旋转对称）', () => {
  it('★ 两侧完全对称：红方的每个体积都有一个 180° 旋转的对应体', () => {
    const key = (v: { min: { x: number; z: number }; max: { x: number; z: number } }) =>
      `${v.min.x.toFixed(2)},${v.min.z.toFixed(2)},${v.max.x.toFixed(2)},${v.max.z.toFixed(2)}`;
    const present = new Set(ctfMap.geometry.map(key));
    for (const v of ctfMap.geometry) {
      const rotated = key({
        min: { x: -v.max.x, z: -v.max.z },
        max: { x: -v.min.x, z: -v.min.z },
      });
      expect(present.has(rotated), `${v.id} 没有对称的对应体`).toBe(true);
    }
  });

  it('★ 双方旗帜到中央的距离一致', () => {
    const [a, b] = ctfMap.flags!;
    expect(distance2D(a!.position, { x: 0, y: 0, z: 0 }))
      .toBeCloseTo(distance2D(b!.position, { x: 0, y: 0, z: 0 }));
  });

  it('★ 不存在只有位移职业才能到达的可站立面', () => {
    expect(ctfMap.fairness.mobilityOnlyPlatforms).toEqual([]);
    // 房顶明确不可站立，否则就成了只有位移职业能上的高台
    const roof = ctfMap.geometry.filter((v) => v.tag === 'roof');
    expect(roof.length).toBeGreaterThan(0);
    for (const r of roof) expect(r.standable, r.id).toBe(false);
  });

  it('旗帜与旗帜房门口都站得住', () => {
    for (const f of ctfMap.flags!) {
      expect(groundAt(f.position.x, f.position.z), f.id).toBe(0);
      for (const [i, e] of f.entrances.entries()) {
        expect(groundAt(e.x, e.z), `${f.id} entrance ${i}`).toBe(0);
      }
    }
  });

  it('四面外墙封闭', () => {
    expect(ctfMap.geometry.filter((v) => v.id.startsWith('wall_'))).toHaveLength(4);
  });

  it('没有退化的盒子（min >= max）', () => {
    const bad = ctfMap.geometry.filter(
      (v) => v.min.x >= v.max.x || v.min.y >= v.max.y || v.min.z >= v.max.z,
    );
    expect(bad.map((v) => v.id)).toEqual([]);
  });
});

describe('★ 12.1 交旗区与旗帜房', () => {
  it('交旗区就是己方旗帜房 —— 旗帜在自己的交旗区内', () => {
    for (const team of TEAMS) {
      const zone = ctfMap.captureZones!.find((c) => c.team === team)!;
      const flag = ctfMap.flags!.find((f) => f.team === team)!;
      expect(flag.position.x).toBeGreaterThanOrEqual(zone.volume.min.x);
      expect(flag.position.x).toBeLessThanOrEqual(zone.volume.max.x);
      expect(flag.position.z).toBeGreaterThanOrEqual(zone.volume.min.z);
      expect(flag.position.z).toBeLessThanOrEqual(zone.volume.max.z);
    }
  });

  it('两个交旗区不重叠', () => {
    const [a, b] = ctfMap.captureZones!;
    const overlap = a!.volume.max.z > b!.volume.min.z && b!.volume.max.z > a!.volume.min.z;
    expect(overlap).toBe(false);
  });

  it('旗帜房门口能看到旗，房外远处看不到（后墙+顶盖挡住）', () => {
    const flag = ctfMap.flags!.find((f) => f.team === TEAM_RED)!;
    const door = flag.entrances[0]!;
    expect(hasLineOfSight({ position: door }, { position: flag.position }, ctfMap.geometry)).toBe(true);
    // 从旗帜房正后方（复活区一侧）打不到
    const behind = { x: 0, y: 0, z: 155 };
    expect(hasLineOfSight({ position: behind }, { position: flag.position }, ctfMap.geometry)).toBe(false);
  });
});

describe('19.1 一张地图服务三种人数', () => {
  it('地图声明支持 6v6 / 8v8 / 12v12', () => {
    expect(ctfMap.modes).toEqual([GameMode.Ctf6v6, GameMode.Ctf8v8, GameMode.Ctf12v12]);
  });

  it('每种模式的复活点数量都够用', () => {
    for (const mode of ctfMap.modes) {
      const s = ctfMap.scaling![mode]!;
      for (const g of ctfMap.graveyards!) {
        expect(g.spawns.length, `${mode} / ${g.id}`).toBeGreaterThanOrEqual(s.spawnsPerTeam);
        expect(g.exits.length, `${mode} / ${g.id}`).toBeGreaterThanOrEqual(s.graveyardExits);
      }
    }
  });

  it('人越多复活出口要求越多（防堵门）', () => {
    const counts = ctfMap.modes.map((m) => ctfMap.scaling![m]!.graveyardExits);
    expect(counts[0]!).toBeLessThanOrEqual(counts[1]!);
    expect(counts[1]!).toBeLessThanOrEqual(counts[2]!);
  });

  it('★ 6v6 关闭地道，8v8 与 12v12 开放', () => {
    const closed = (mode: GameMode) =>
      activeForbidden(ctfMap, mode).some((f) => f.id === 'forbid_underground');
    expect(closed(GameMode.Ctf6v6)).toBe(true);
    expect(closed(GameMode.Ctf8v8)).toBe(false);
    expect(closed(GameMode.Ctf12v12)).toBe(false);
  });

  it('★ 复活安全区在所有模式下都生效 —— 不会被 extraForbidden 规则误关', () => {
    for (const mode of ctfMap.modes) {
      const ids = activeForbidden(ctfMap, mode).map((f) => f.id);
      expect(ids, mode).toContain('forbid_grave_red');
      expect(ids, mode).toContain('forbid_grave_blue');
    }
  });
});

describe('注册表', () => {
  it('夺旗地图已注册且 id 唯一', () => {
    expect(ALL_MAPS.map((m) => m.id)).toContain(ctfMap.id);
    const ids = ALL_MAPS.map((m) => m.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
