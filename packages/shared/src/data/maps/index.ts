/**
 * 地图注册表。加一张地图 = 新建文件 + 在 ALL_MAPS 里加一行。
 */

import type { MapDef } from './schema.js';
import { testbed } from './testbed.js';
import { arena2v2, arena3v3, arena5v5 } from './arena.js';

export * from './schema.js';
export { testbed, TESTBED_SPAWN } from './testbed.js';
export { arena2v2, arena3v3, arena5v5, ARENA_MAPS, ARENA_SPECS } from './arena.js';

export const ALL_MAPS: readonly MapDef[] = [testbed, arena2v2, arena3v3, arena5v5];

export const MAP_BY_ID: ReadonlyMap<string, MapDef> = new Map(
  ALL_MAPS.map((m) => [m.id as string, m]),
);

/** 按模式找可用地图 */
export const mapsForMode = (mode: MapDef['modes'][number]): MapDef[] =>
  ALL_MAPS.filter((m) => m.modes.includes(mode));
