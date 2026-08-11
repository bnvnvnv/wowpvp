/**
 * 地图注册表。加一张地图 = 新建文件 + 在 ALL_MAPS 里加一行。
 */

import type { GameMode } from '../../types/enums.js';
import type { ForbiddenVolume, MapDef } from './schema.js';
import { testbed } from './testbed.js';
import { tutorialMap } from './tutorial.js';
import { ARENA_MAPS } from './arena.js';
import { THEMED_ARENA_MAPS } from './themed.js';
import { ctfMap } from './ctf.js';
import { ffaMap } from './ffa.js';

export * from './schema.js';
export { testbed, TESTBED_SPAWN } from './testbed.js';
export {
  tutorialMap, TUTORIAL_SPAWN, tutorialObstacles,
  TUTORIAL_CLEAR_AHEAD, TUTORIAL_CORRIDOR_HALF_WIDTH,
} from './tutorial.js';
export { arena2v2, arena3v3, arena5v5, ARENA_MAPS, ARENA_SPECS } from './arena.js';
export {
  THEMED_ARENA_MAPS, THEMED_ARENA_SPECS, THEMED_TOLERANCE_SECONDS,
  arenaFrostOutpost, arenaGroveAltar, arenaLavaRift, arenaRuinsColosseum,
} from './themed.js';
export { ffaMap } from './ffa.js';
export { ctfMap, routeLength, routeSeconds, graveyardSeesFlag, CTF_MAP_METRICS } from './ctf.js';

/**
 * P12：竞技场是 1v1–12v12 全梯子（arena.ts SPECS 一次生成），逐张点名会漏。
 *
 * ★★ **顺序有语义**：`mapsForMode(mode)[0]` 是 `setMode` 换图时取的「该模式
 *   首张可用地图」。P5 的四张主题图（`THEMED_ARENA_MAPS`）各自覆盖一段
 *   人数档区间，**必须排在 `ARENA_MAPS` 之后** —— 排前面的话，房主一切模式
 *   就被静默换到主题图上，「无参默认路径行为不变」当场破功。
 *   主题图要玩家在选图 UI 里**主动挑**才会用上。
 */
export const ALL_MAPS: readonly MapDef[] =
  [testbed, tutorialMap, ...ARENA_MAPS, ffaMap, ctfMap, ...THEMED_ARENA_MAPS];

export const MAP_BY_ID: ReadonlyMap<string, MapDef> = new Map(
  ALL_MAPS.map((m) => [m.id as string, m]),
);

/** 按模式找可用地图 */
export const mapsForMode = (mode: MapDef['modes'][number]): MapDef[] =>
  ALL_MAPS.filter((m) => m.modes.includes(mode));

/**
 * 某个模式下**实际生效**的禁入体积。
 *
 * `MapDef.forbidden` 里混着两类：始终生效的（复活安全区），
 * 和只在特定人数下生效的（6v6 关掉地道）。规则是：
 *   **只要一个 id 出现在任何模式的 `extraForbidden` 里，它就是条件生效的**，
 *   仅对点名它的模式启用；其余 id 始终生效。
 *
 * 写成函数而不是让每个调用方自己判断 —— 这条规则光看 schema 猜不出来，
 * 猜错的后果是 8v8 的地道被莫名封死，而且只有玩家会发现。
 */
export const activeForbidden = (map: MapDef, mode: GameMode): readonly ForbiddenVolume[] => {
  const conditional = new Set<string>();
  for (const s of Object.values(map.scaling ?? {})) {
    for (const id of s?.extraForbidden ?? []) conditional.add(id);
  }
  const enabled = new Set(map.scaling?.[mode]?.extraForbidden ?? []);
  return map.forbidden.filter((f) => !conditional.has(f.id) || enabled.has(f.id));
};
