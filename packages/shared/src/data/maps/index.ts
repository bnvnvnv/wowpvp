/**
 * 地图注册表。加一张地图 = 新建文件 + 在 ALL_MAPS 里加一行。
 */

import type { MapDef } from './schema.js';
import { testbed } from './testbed.js';

export * from './schema.js';
export { testbed, TESTBED_SPAWN } from './testbed.js';

export const ALL_MAPS: readonly MapDef[] = [testbed];

export const MAP_BY_ID: ReadonlyMap<string, MapDef> = new Map(
  ALL_MAPS.map((m) => [m.id as string, m]),
);
