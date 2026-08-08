/**
 * 大乱斗地图（P12，玩家需求：「所有玩家都是敌人，房间人数上限 100 人」）。
 *
 * ★★ **大乱斗没有阵营** —— 规则实现是「每名玩家一个独立 TeamId」
 *   （setup.ts 的 ffa 分支），于是既有的敌对判定 / 潜行裁剪 / 光环掩码
 *   全部原样生效：isFriendly 恒 false，人人互为敌人不需要任何新判定。
 *
 * 地图形态取「大圆桌」：
 *   · 没有准备区与大门（没有「双方」，也就没有 11.1 的对开门可言）——
 *     开局直接站在场上，与试验场同一形态
 *   · 出生/复活点走**中立墓地**（team = TEAM_NEUTRAL）：24 个点沿外圈
 *     均匀散开，复活出口同一批点 —— 复活系统按队号查出口，
 *     setup.ts 把每名玩家的独立队号都映射到这同一份出口表
 *   · 掩体两圈：外圈 12 根、内圈 6 根 —— 100 人档的混战密度下，
 *     11.3「不形成永久安全点」靠柱间距离保证（与竞技场同一套断言思路）
 */

import { MOVE } from '../../constants/combat.js';
import { GameMode } from '../../types/enums.js';
import { asMapId, TEAM_NEUTRAL } from '../../types/ids.js';
import type { Vec3 } from '../../math/vec3.js';
import { box, type MapDef, type MapVolume, type SpawnPoint } from './schema.js';

/** 场地半径：横穿 ~20 秒的大圆桌（比 5v5 竞技场大一圈，装得下百人混战） */
const HALF = 10 * MOVE.BASE_SPEED; // 70m
const ARENA_HALF = HALF + 6;
const WALL_H = 8;

/** 外圈出生/复活点数量。100 人开局按此轮转落位（setup.ts 的游标） */
const SPAWN_COUNT = 24;

const spawns: SpawnPoint[] = Array.from({ length: SPAWN_COUNT }, (_, i) => {
  const a = (i / SPAWN_COUNT) * Math.PI * 2;
  const r = HALF - 4;
  return {
    id: `ffa_spawn_${i}`,
    team: TEAM_NEUTRAL,
    position: { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r },
    // 面向场地中央 —— 复活睁眼就看到战场，不是看墙
    yaw: Math.atan2(-Math.sin(a), -Math.cos(a)),
  };
});

const exits: Vec3[] = spawns.map((s) => ({ ...s.position }));

const pillars: MapVolume[] = [
  // 外圈 12 根
  ...Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    return box(
      `ffa_pillar_out_${i}`, 'pillar',
      { x: Math.cos(a) * HALF * 0.6, y: 0, z: Math.sin(a) * HALF * 0.6 },
      { w: 2.4, h: 5, d: 2.4 },
    );
  }),
  // 内圈 6 根
  ...Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2;
    return box(
      `ffa_pillar_in_${i}`, 'pillar',
      { x: Math.cos(a) * HALF * 0.28, y: 0, z: Math.sin(a) * HALF * 0.28 },
      { w: 2.4, h: 5, d: 2.4 },
    );
  }),
];

export const ffaMap: MapDef = {
  id: asMapId('ffa_melee'),
  name: '乱斗场·百人圆桌',
  family: 'ffa',
  modes: [GameMode.Ffa],
  bounds: {
    min: { x: -ARENA_HALF, y: -5, z: -ARENA_HALF },
    max: { x: ARENA_HALF, y: 40, z: ARENA_HALF },
  },
  geometry: [
    box('floor', 'floor', { x: 0, y: -1, z: 0 },
      { w: ARENA_HALF * 2, h: 1, d: ARENA_HALF * 2 }, { blocksSight: false }),
    box('wall_n', 'wall', { x: 0, y: 0, z: -ARENA_HALF }, { w: ARENA_HALF * 2, h: WALL_H, d: 1 }),
    box('wall_s', 'wall', { x: 0, y: 0, z: ARENA_HALF }, { w: ARENA_HALF * 2, h: WALL_H, d: 1 }),
    box('wall_w', 'wall', { x: -ARENA_HALF, y: 0, z: 0 }, { w: 1, h: WALL_H, d: ARENA_HALF * 2 }),
    box('wall_e', 'wall', { x: ARENA_HALF, y: 0, z: 0 }, { w: 1, h: WALL_H, d: ARENA_HALF * 2 }),
    ...pillars,
  ],
  envPreset: 'dusk',
  forbidden: [],
  // 大乱斗没有「双方」，也就没有 11.1 的对开大门 —— 与试验场同形态
  gates: [],
  /**
   * ★ 中立墓地承载出生与复活（见文件头）。volume 只是登记用的包围盒 ——
   *   大乱斗没有「复活区建筑」，出生点全在场内沿圈散开。
   */
  graveyards: [{
    id: 'ffa_ring',
    team: TEAM_NEUTRAL,
    volume: {
      min: { x: -ARENA_HALF, y: 0, z: -ARENA_HALF },
      max: { x: ARENA_HALF, y: WALL_H, z: ARENA_HALF },
    },
    spawns,
    exits,
  }],
  fairness: {
    // 出生点沿圆环均匀分布，到中央距离全部相等
    spawnToCenterDelta: 0,
    spawnToSupplyDelta: {},
    mobilityOnlyPlatforms: [],
    tolerance: 2.0,
  },
};
