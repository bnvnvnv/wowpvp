/**
 * P5 四张主题竞技场的机检。
 *
 * ★★ 写法照 3v3 试点地形那五条（`maps.test.ts` 末节）—— 每一条都对应
 *   **一个会坏掉的具体方式**，不是「地形存在」的冒烟测试：
 *     镜像破了 = 阵营不公平；级高超了 = 位移职业专属高台（违 11.3）；
 *     净空矮了 = 桥下卡头；走廊被占 = bot（无寻路）直线流被断；
 *     件出了界 = 玩家看得见走不到；装饰压走廊 = 视觉骗人。
 *
 * ★ 与试点那节的差别是**广义化**：试点是逐个 id 点名，这里是四张图
 *   一起跑同一组规则 —— 以后再加主题图会被同一套约束接住。
 */

import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GEOMETRY, MOVE } from '../../constants/combat.js';
import { distance2D, vec3 } from '../../math/vec3.js';
// ★ `Aabb` 的家在 math —— schema.ts 只是 import 它，没有再导出一遍
//   （从 schema 借道会是 TS2459：「声明了但没导出」）
import type { Aabb } from '../../math/geometry.js';
import {
  createMovementState, cylinderOverlapsAabb, stepMovement, type MovementState,
} from '../../sim/movement.js';
import { TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { ARENA_SPECS } from './arena.js';
import { ALL_MAPS, mapsForMode } from './index.js';
import type { MapDef, MapVolume } from './schema.js';
import {
  THEMED_ARENA_MAPS, THEMED_ARENA_SPECS, THEMED_TOLERANCE_SECONDS, themedContextOf,
} from './themed.js';

const center = vec3(0, 0, 0);
const cx = (v: Aabb): number => (v.min.x + v.max.x) / 2;
const cz = (v: Aabb): number => (v.min.z + v.max.z) / 2;

const spawnsOf = (map: MapDef, team: number) =>
  (map.prepRooms ?? []).filter((r) => (r.team as number) === team).flatMap((r) => r.spawns);

/** 外壳件（地板 + 四面外墙）不参与地形规则 —— 它们是每张图都一样的底座 */
const SHELL = new Set(['floor', 'wall_n', 'wall_s', 'wall_w', 'wall_e']);
const terrainOf = (map: MapDef): MapVolume[] => map.geometry.filter((v) => !SHELL.has(v.id));

const pairs = THEMED_ARENA_SPECS.map((spec) => {
  const map = THEMED_ARENA_MAPS.find((m) => (m.id as string) === spec.id);
  // ★ 按 id 查找而不是按下标（m5 #24 之鉴：SPECS 插一行就全错位）
  if (!map) throw new Error(`主题图 ${spec.id} 没生成出来`);
  const ctx = themedContextOf(spec);
  return { spec, map, ctx, prepHalfW: ctx.prepHalfW };
});

// ── 真解算器：机检不比数据，机检**走一遍** ───────────────────────

const TICK = 1 / 60;

/**
 * ★★ 本文件里凡是「走得过去 / 上得去」的断言，一律跑
 *   `createMovementState` + `stepMovement`，**不比几何数据**。
 *
 *   起因是一条 blocker：三张图的台顶级高恰好 = `STEP_HEIGHT`，
 *   而 `platH − k*RISE` 的浮点误差让 `tryStepUp` 差一个 ulp 直接放弃 ——
 *   台顶只有会跳的人上得去。当时的机检比的是**数据里的 max.y 差**
 *   还带了 `+1e-9` 容差，63 条全绿地骗过了两批人。
 *   数据比对永远抓不到这一类：**判定藏在解算器里，就得问解算器**。
 */
const walk = (
  obstacles: readonly Aabb[],
  from: { x: number; y: number; z: number },
  yaw: number,
  seconds: number,
  onTick?: (s: MovementState) => boolean,
): MovementState => {
  let st = createMovementState(vec3(from.x, from.y, from.z), yaw);
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    st = stepMovement(st, { forward: 1, strafe: 0, jump: false, yaw }, TICK, obstacles).state;
    if (onTick?.(st)) break;
  }
  return st;
};

/** 角色此刻是不是**站在** `v` 的顶面上 */
const standingOn = (s: MovementState, v: MapVolume): boolean =>
  Math.abs(s.position.y - v.max.y) < 1e-3
  && s.position.x > v.min.x - GEOMETRY.HITBOX_RADIUS
  && s.position.x < v.max.x + GEOMETRY.HITBOX_RADIUS
  && s.position.z > v.min.z - GEOMETRY.HITBOX_RADIUS
  && s.position.z < v.max.z + GEOMETRY.HITBOX_RADIUS;

/**
 * 实测跳跃顶点：一块平地上按住跳，记最高点。
 * 解析解是 `JUMP_SPEED²/(2·GRAVITY)` = 1.178 m，60Hz 离散化后拿不到那么高 ——
 * 「翻不翻得过去」是行为问题，就得用行为量。
 */
const JUMP_APEX = ((): number => {
  const ground: Aabb[] = [{ min: { x: -50, y: -1, z: -50 }, max: { x: 50, y: 0, z: 50 } }];
  let s = createMovementState(vec3(0, 0, 0), 0);
  let apex = 0;
  for (let i = 0; i < 120; i++) {
    s = stepMovement(s, { forward: 0, strafe: 0, jump: true, yaw: 0 }, TICK, ground).state;
    apex = Math.max(apex, s.position.y);
  }
  return apex;
})();

describe('P5 主题竞技场：注册与人数档', () => {
  it('★ 四张图都进了 ALL_MAPS 且 id 唯一', () => {
    const ids = ALL_MAPS.map((m) => m.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { spec } of pairs) expect(ids).toContain(spec.id);
  });

  it('★★ 默认路径不变：每个模式的首张可用地图仍是试炼环那张', () => {
    // 主题图排在 ARENA_MAPS 之后，setMode 的 `mapsForMode(mode)[0]` 取不到它们
    for (const arenaSpec of ARENA_SPECS) {
      const first = mapsForMode(arenaSpec.mode)[0];
      expect(first?.id as string, `${arenaSpec.mode} 的首张地图被主题图抢了`)
        .toBe(arenaSpec.id);
    }
  });

  it('★ 适配档位区间连续，且每档都能选到这张图', () => {
    for (const { spec, map } of pairs) {
      const ladder = ARENA_SPECS.map((s) => s.mode);
      const idx = spec.modes.map((m) => ladder.indexOf(m));
      expect(idx.every((i) => i >= 0), `${spec.id} 声明了梯子上没有的档`).toBe(true);
      for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe(idx[i - 1]! + 1);
      for (const mode of spec.modes) {
        expect(mapsForMode(mode).map((m) => m.id as string)).toContain(spec.id);
      }
      expect(map.modes).toEqual(spec.modes);
    }
  });

  it('★ 尺寸按 11.2 推：与区间内每一档的标准节奏差 ≤ 1.5 秒', () => {
    for (const { spec, map } of pairs) {
      const d = distance2D(spawnsOf(map, TEAM_RED)[0]!.position, center);
      const seconds = d / MOVE.BASE_SPEED;
      // 图自身的出生距离要对得上它声明的秒数
      expect(Math.abs(seconds - spec.spawnToCenterSeconds)).toBeLessThan(1.5);
      for (const mode of spec.modes) {
        // ★ 按 mode 查规格，不按下标
        const arenaSpec = ARENA_SPECS.find((s) => s.mode === mode)!;
        expect(
          Math.abs(seconds - arenaSpec.spawnToCenterSeconds),
          `${spec.id} 对 ${mode} 太${seconds > arenaSpec.spawnToCenterSeconds ? '大' : '小'}`,
        ).toBeLessThanOrEqual(THEMED_TOLERANCE_SECONDS);
      }
    }
  });

  it('★ 每队出生点 = 区间里最大那档的人数（小档只用前 N 个）', () => {
    for (const { spec, map } of pairs) {
      expect(spawnsOf(map, TEAM_RED)).toHaveLength(spec.maxTeamSize);
      expect(spawnsOf(map, TEAM_BLUE)).toHaveLength(spec.maxTeamSize);
    }
  });

  it('★ 四张图合起来盖满 1v1–12v12 —— 每一档都至少多一个选择', () => {
    const covered = new Set(pairs.flatMap((p) => p.spec.modes as string[]));
    const uncovered = ARENA_SPECS.filter((s) => !covered.has(s.mode)).map((s) => s.id);
    expect(uncovered, '这些人数档只有试炼环一张图可选').toEqual([]);
  });

  it('四张图的风格轴两两不同（布局/装饰/昼夜）', () => {
    const presets = pairs.map((p) => p.spec.envPreset);
    expect(new Set(presets).size).toBe(presets.length);
    const names = pairs.map((p) => p.spec.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('P5 主题竞技场：11.3 公平约束', () => {
  for (const { spec, map, ctx, prepHalfW } of pairs) {
    describe(`${spec.name}（${spec.id}）`, () => {
      it('★ 全部地形件 z 镜像 —— 要么自己对称，要么有 _n/_s 孪生', () => {
        const byId = new Map(map.geometry.map((v) => [v.id, v]));
        for (const v of terrainOf(map)) {
          if (v.id.endsWith('_s')) {
            const twin = byId.get(`${v.id.slice(0, -2)}_n`);
            expect(twin, `${v.id} 没有 −z 孪生`).toBeDefined();
            expect(cz(v), `${v.id} 的 z 不镜像`).toBeCloseTo(-cz(twin!), 6);
            expect(cx(v), `${v.id} 的 x 不一致`).toBeCloseTo(cx(twin!), 6);
            expect(v.max.y, `${v.id} 的高度不一致`).toBeCloseTo(twin!.max.y, 6);
            expect(v.max.x - v.min.x).toBeCloseTo(twin!.max.x - twin!.min.x, 6);
            expect(v.max.z - v.min.z).toBeCloseTo(twin!.max.z - twin!.min.z, 6);
          } else if (v.id.endsWith('_n')) {
            expect(byId.has(`${v.id.slice(0, -2)}_s`), `${v.id} 是孤儿孪生`).toBe(true);
          } else {
            // 跨中线的件必须自己就 z 对称
            expect(v.min.z, `${v.id} 跨中线却不 z 对称`).toBeCloseTo(-v.max.z, 6);
          }
        }
      });

      it('★ 双方出生点到中央的距离一致', () => {
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const red = spawnsOf(map, TEAM_RED).map((s) => distance2D(s.position, center));
        const blue = spawnsOf(map, TEAM_BLUE).map((s) => distance2D(s.position, center));
        expect(Math.abs(avg(red) - avg(blue))).toBeLessThan(map.fairness.tolerance);
        expect(map.fairness.spawnToCenterDelta).toBe(0);
      });

      it('★★ 直走就能登上每处台顶（跑真解算器，不比数据）—— 高台不是位移职业专属', () => {
        expect(map.fairness.mobilityOnlyPlatforms).toEqual([]);
        const climbs = spec.climbs(ctx);
        expect(climbs.length, '没声明任何登顶行为').toBeGreaterThan(0);
        for (const c of climbs) {
          const top = map.geometry.find((g) => g.id === c.top);
          if (!top) throw new Error(`${spec.id} 的登顶目标 ${c.top} 不存在`);
          let arrived = false;
          const end = walk(
            map.geometry,
            { x: c.from[0], y: c.startY ?? 0, z: c.from[1] },
            c.yaw,
            20,
            (s) => (arrived = standingOn(s, top)),
          );
          expect(
            arrived,
            `${spec.id}：从 (${c.from[0].toFixed(1)}, ${c.from[1].toFixed(1)}) 朝 `
            + `yaw=${c.yaw.toFixed(2)} 直走上不了 ${c.top}（顶面 y=${top.max.y}），`
            + `停在 (${end.position.x.toFixed(2)}, ${end.position.y.toFixed(2)}, `
            + `${end.position.z.toFixed(2)}）—— 只有会跳的人上得去`,
          ).toBe(true);
        }
      });

      /**
       * ★★ 出生走廊的**行为**断言。
       *
       *   此前这条只验「走廊带子上没有几何件」，而中央件整体豁免 ——
       *   于是「楼梯比出生点排面窄」这种情况完全测不到：熔岩裂谷 9 个出生点
       *   里有 4 个正对着 2.25 米高的台壁，直走永久停在 16.6 米外。
       *   现在是把每个出生点放进解算器直走一遍，要求**走过中线**。
       */
      it('★★ 每个出生点直走都能穿过中央到达对面（bot 无寻路，B1）', () => {
        for (const room of map.prepRooms ?? []) {
          for (const s of room.spawns) {
            const end = walk(map.geometry, s.position, s.yaw, 40);
            expect(
              end.position.z * s.position.z,
              `${spec.id} 的 ${s.id}（x=${s.position.x.toFixed(2)}）直走没能过中线，`
              + `停在 z=${end.position.z.toFixed(2)}`,
            ).toBeLessThan(0);
          }
        }
      });

      it('★ 桥下净空 ≥ 角色高度（桥下是通道，不是卡头的房梁）', () => {
        for (const id of spec.bridges) {
          const v = map.geometry.find((g) => g.id === id);
          expect(v, `桥 ${id} 不存在`).toBeDefined();
          expect(v!.min.y, `${id} 桥下净空不足`)
            .toBeGreaterThanOrEqual(GEOMETRY.HITBOX_HEIGHT);
        }
      });

      it('★ 出生走廊无几何 —— bot 无寻路，主通道保持直走可达', () => {
        for (const v of terrainOf(map)) {
          const inCorridorX = v.max.x >= -prepHalfW && v.min.x <= prepHalfW;
          // 中央地形件是例外：它朝出生方向有可跨楼梯（上一条已逐级验过）
          const outsideCenter = Math.max(Math.abs(v.min.z), Math.abs(v.max.z)) > spec.centerRadius;
          expect(
            inCorridorX && outsideCenter,
            `${v.id} 侵入出生走廊（x ∈ [${v.min.x.toFixed(1)}, ${v.max.x.toFixed(1)}]，`
            + `z ∈ [${v.min.z.toFixed(1)}, ${v.max.z.toFixed(1)}]）`,
          ).toBe(false);
        }
      });

      it('★ 全部几何在边界内，且不压准备区', () => {
        // 外壳的四面墙**骑在** bounds 上（墙厚 1，中心在 ±arenaHalf）—— 与试炼环
        // 同款做法，它们就是边界本身。这里验的是地形件不外溢。
        for (const v of terrainOf(map)) {
          expect(v.min.x, `${v.id} 越过西墙`).toBeGreaterThanOrEqual(map.bounds.min.x);
          expect(v.max.x, `${v.id} 越过东墙`).toBeLessThanOrEqual(map.bounds.max.x);
          expect(v.min.z, `${v.id} 越过北墙`).toBeGreaterThanOrEqual(map.bounds.min.z);
          expect(v.max.z, `${v.id} 越过南墙`).toBeLessThanOrEqual(map.bounds.max.z);
        }
        for (const room of map.prepRooms ?? []) {
          for (const v of terrainOf(map)) {
            const hit = v.max.x > room.volume.min.x && v.min.x < room.volume.max.x
              && v.max.z > room.volume.min.z && v.min.z < room.volume.max.z;
            expect(hit, `${v.id} 压进了准备区 ${room.id}`).toBe(false);
          }
        }
      });

      /**
       * ★ 两件地形互相插进对方体内 = 渲染穿模 + 一块「看着能走其实是实心」的
       *   夹缝。共面相邻（楼梯贴台沿、桥搭台顶）是设计，**体积重叠**不是。
       */
      it('★ 地形件互不穿插（共面相邻可以，体积重叠不行）', () => {
        const t = terrainOf(map);
        const EPS = 1e-6;
        for (let i = 0; i < t.length; i++) {
          for (let j = i + 1; j < t.length; j++) {
            const a = t[i]!;
            const b = t[j]!;
            const overlap = a.max.x - b.min.x > EPS && b.max.x - a.min.x > EPS
              && a.max.y - b.min.y > EPS && b.max.y - a.min.y > EPS
              && a.max.z - b.min.z > EPS && b.max.z - a.min.z > EPS;
            expect(overlap, `${a.id} 与 ${b.id} 体积重叠`).toBe(false);
          }
        }
      });

      it('★ 掩体之间留有通道，不形成永久安全点（11.3）', () => {
        const cover = terrainOf(map).filter((v) => v.tag === 'pillar');
        for (let i = 0; i < cover.length; i++) {
          for (let j = i + 1; j < cover.length; j++) {
            const a = cover[i]!;
            const b = cover[j]!;
            const gap = distance2D(vec3(cx(a), 0, cz(a)), vec3(cx(b), 0, cz(b)))
              - (a.max.x - a.min.x);
            expect(gap, `${a.id} 与 ${b.id} 之间通道过窄`)
              .toBeGreaterThan(GEOMETRY.HITBOX_RADIUS * 4);
          }
        }
      });

      it('11.1/11.3 大门同开、准备区开门后禁入', () => {
        expect(new Set(map.gates.map((g) => g.opensAt)).size).toBe(1);
        for (const room of map.prepRooms ?? []) {
          expect(room.reentry).toBe('blocked');
          const forbid = map.forbidden.find((f) => f.volume.min.z === room.volume.min.z);
          expect(forbid, `${room.id} 缺少对应的禁入体积`).toBeDefined();
          expect(forbid!.scope).toBe('all');
        }
      });

      it('★ 半高掩体（≤ 胸口 1.35m）必须显式不挡视线（6.4）', () => {
        for (const v of terrainOf(map)) {
          // 只管**落地**的件：桥面/台面之类架高的薄板不是掩体，
          // 它们的「厚度」跟视线博弈没关系（桥的意义在净空，另有一条）
          if (v.min.y > 1e-6) continue;
          const h = v.max.y - v.min.y;
          if (h > GEOMETRY.CHEST_HEIGHT) continue;
          expect(
            v.blocksSight,
            `${v.id} 只有 ${h.toFixed(2)}m 却参与视线判定 —— 玩家会以为躲得住`,
          ).toBe(false);
        }
      });

      /**
       * ★★ **死区**：跳跃顶点 < 高度 ≤ 胸口线。
       *
       *   这段高度的落地件跨不过去（> STEP_HEIGHT）、跳不上去（> 实测顶点），
       *   却因为 ≤ 胸口线而被上一条要求写 `blocksSight:false`
       *   ——「显式声明我很矮，其实是一堵谁也过不去的绝对墙」。
       *   grove 的倒木与 ruins 的矮瓦砾都曾经是 1.2 m，8–9 米长，
       *   纯直走和按住跳都停在盒外一个身位，还能隔着它对射。
       *
       *   ★ 顶点是**跑出来的**不是算出来的：解析解 7.2²/(2·22) = 1.178 m，
       *     60Hz 离散化后实际只有 1.119 m —— 又是一处「按公式写的机检会放过真机行为」。
       *   ★ 台阶不在此列：判据是「旁边有没有一级踩得上来的下级」，
       *     而不是件本身有多高 —— 阶梯环的 1.35 m 那级当然合法。
       */
      it('★★ 没有落在「跨不过又跳不上」死区里的落地件', () => {
        const solids = map.geometry.filter((v) => v.blocksMovement !== false);
        /** 有没有一件与它 XZ 相邻、顶面正好在一步之内的下级 */
        const hasLowerStep = (v: MapVolume): boolean => solids.some((u) => u.id !== v.id
          && u.max.y < v.max.y - 1e-9
          && u.max.y >= v.max.y - GEOMETRY.STEP_HEIGHT - 1e-9
          && u.max.x >= v.min.x - 1e-6 && v.max.x >= u.min.x - 1e-6
          && u.max.z >= v.min.z - 1e-6 && v.max.z >= u.min.z - 1e-6);

        for (const v of terrainOf(map)) {
          if (v.min.y > 1e-6 || v.blocksMovement === false) continue;
          const h = v.max.y - v.min.y;
          if (h <= JUMP_APEX || h > GEOMETRY.CHEST_HEIGHT) continue;
          expect(
            hasLowerStep(v),
            `${v.id} 高 ${h.toFixed(2)}m：跨不过（> ${GEOMETRY.STEP_HEIGHT}）`
            + `又跳不上（> ${JUMP_APEX.toFixed(3)}），却矮到必须声明不挡视线，`
            + '而且旁边没有任何一级踩得上来的下级',
          ).toBe(true);
        }
      });
    });
  }
});

/**
 * ★★ bot 不做寻路（B1），而 `moveAndSlide` 是逐轴解算：斜着走进一个凹角，
 *   两个轴各被一面挡住，角色**彻底停住**且没有任何恢复手段。这是地形唯一
 *   能「吃掉」一个参战单位的方式，也是本批审计里最隐蔽的一条 ——
 *   密林祭坛的 28 棵树阵曾有 42% 的采样落点走不到中央。
 *
 * ★ 卡死的机制是**盒子的竖棱**，不是「障碍太多」：角色圆柱贴到凸角上以后，
 *   往 x 走和往 z 走都会让它更靠近那根棱 → 两轴都判相交 → 彻底停住。
 *   所以稀释树阵没用（实测把树径 2.6 缩到 1.8 反而从 6.7% 涨到 11.3%：
 *   洞开得越大，越多直线能走到更靠里的那圈盒子上去撞棱）。真正的杠杆是
 *   **中央前的最后一段只留可跨几何** —— 见 `themed.ts` 的 `GROVE_SHRINES`。
 * ★ 门槛按**既有已发布图**的量级定，不是拍脑袋。同一支探针（GRID=8）实测：
 *     试炼环 1v1 1.61% / 2v2 5.00% / **3v3 试点 11.46%** / 8v8 4.61% /
 *     11v11 4.75% / 12v12 2.62%；大乱斗 6.47%；夺旗 0.40%；testbed 6.82%。
 *   本批四张：雪原 1.37% / 密林 3.85% / 熔岩 1.96% / 废墟 3.00%。
 *   卡 6% = 既有图里最差那几张的量级，且给本批留了 1.5 倍余量。
 *   ⚠️ 3v3 试点那 11.46% 是**既有缺陷**（柱环正好摆在 45° 上，出生点直走
 *      撞的就是柱子的棱），不在本批范围内 —— 已记在 docs/17。
 * ★ 只算**场内**静止：走到外墙前贴着停下是任何直线走法的终局，不是缺陷。
 */
describe('P5 主题竞技场：直线陷阱率（bot 无寻路，B1）', () => {
  const GRID = 8;
  const MAX_STUCK_RATE = 0.06;

  for (const { spec, map } of pairs) {
    it(`★★ ${spec.name}：场内永久静止的采样落点 < ${(MAX_STUCK_RATE * 100).toFixed(0)}%`, () => {
      const obstacles = map.geometry;
      const lim = map.bounds.max.x - 10;
      let total = 0;
      let stuck = 0;
      const samples: string[] = [];
      for (let x = -lim; x <= lim; x += GRID) {
        for (let z = -lim; z <= lim; z += GRID) {
          const p = vec3(x, 0, z);
          const inside = obstacles.some((b) => b.blocksMovement !== false
            && cylinderOverlapsAabb(p, GEOMETRY.HITBOX_RADIUS, GEOMETRY.HITBOX_HEIGHT, b));
          // 盒子里的格与准备区的格不参与
          if (inside || Math.abs(z) > map.bounds.max.z - 8) continue;
          total++;
          // yawToDir(yaw) = (−sin, 0, −cos)，要指向原点就取 atan2(x, z)
          const yaw = Math.atan2(x, z);
          let reached = false;
          let frozen = 0;
          let ticks = 0;
          let mark = p;
          const end = walk(obstacles, p, yaw, 30, (s) => {
            if (Math.hypot(s.position.x, s.position.z) < 3) reached = true;
            if (++ticks % 30 !== 0) return false;
            frozen = Math.hypot(s.position.x - mark.x, s.position.z - mark.z) < 0.05
              ? frozen + 1 : 0;
            mark = s.position;
            return frozen >= 4;
          });
          const atWall = map.bounds.max.x
            - Math.max(Math.abs(end.position.x), Math.abs(end.position.z)) < 2.5;
          if (frozen >= 4 && !atWall && !reached) {
            stuck++;
            if (samples.length < 3) {
              samples.push(`(${x.toFixed(1)}, ${z.toFixed(1)}) → 停在 `
                + `(${end.position.x.toFixed(2)}, ${end.position.z.toFixed(2)})`);
            }
          }
        }
      }
      expect(total, '采样格太少，探针没在跑').toBeGreaterThan(50);
      expect(
        stuck / total,
        `${spec.id}：${stuck}/${total} 个落点直走会被地形永久吸住。样例 ${samples.join('；')}`,
      ).toBeLessThan(MAX_STUCK_RATE);
    }, 60_000);
  }
});

// ── 从 glb 现量模型的世界尺寸 ────────────────────────────────────

interface Gltf {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: {
    mesh?: number; children?: number[]; matrix?: number[];
    translation?: number[]; rotation?: number[]; scale?: number[];
  }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min: number[]; max: number[]; normalized?: boolean; componentType: number }[];
}

/** 只读 glb 的 JSON 块（文件开头几十 KB），不把整个几百 KB 的二进制读进内存 */
const readGltfJson = (file: string): Gltf => {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} 不是 glb`);
    const len = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${file} 首块不是 JSON`);
    const json = Buffer.alloc(len);
    readSync(fd, json, 0, len, 20);
    return JSON.parse(json.toString('utf8')) as Gltf;
  } finally {
    closeSync(fd);
  }
};

/** 归一化整数属性的反量化除数（KHR_mesh_quantization 常见于本仓库的素材） */
const NORMALIZE_DIVISOR: Readonly<Record<number, number>> = {
  5120: 127, 5121: 255, 5122: 32767, 5123: 65535,
};

const matMul = (a: readonly number[], b: readonly number[]): number[] => {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
};

const nodeMatrix = (n: Gltf['nodes'][number]): number[] => {
  if (n.matrix) return [...n.matrix];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
  const m = [
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!), 0,
    2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!), 0,
    2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!), 0,
    tx!, ty!, tz!, 1,
  ];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r]! *= s[c]!;
  return m;
};

const sizeCache = new Map<string, { w: number; d: number; top: number }>();

/** 模型的世界尺寸：宽 / 深 / **站立面以上**的高度（scale 由调用方乘） */
const modelSize = (file: string): { w: number; d: number; top: number } => {
  const hit = sizeCache.get(file);
  if (hit) return hit;
  const g = readGltfJson(file);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const visit = (idx: number, parent: readonly number[]): void => {
    const n = g.nodes[idx]!;
    const m = matMul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      for (const prim of g.meshes[n.mesh]!.primitives) {
        const acc = g.accessors[prim.attributes.POSITION]!;
        const div = acc.normalized ? (NORMALIZE_DIVISOR[acc.componentType] ?? 1) : 1;
        const mn = acc.min.map((v) => Math.max(v / div, div === 1 ? -Infinity : -1));
        const mx = acc.max.map((v) => Math.max(v / div, div === 1 ? -Infinity : -1));
        for (let corner = 0; corner < 8; corner++) {
          const p = [
            corner & 1 ? mx[0]! : mn[0]!,
            corner & 2 ? mx[1]! : mn[1]!,
            corner & 4 ? mx[2]! : mn[2]!,
          ];
          for (let axis = 0; axis < 3; axis++) {
            const world = m[axis]! * p[0]! + m[4 + axis]! * p[1]!
              + m[8 + axis]! * p[2]! + m[12 + axis]!;
            lo[axis] = Math.min(lo[axis]!, world);
            hi[axis] = Math.max(hi[axis]!, world);
          }
        }
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of g.scenes[g.scene ?? 0]!.nodes) visit(root, identity);
  // 半埋的件（巨石）原点在地面，负的那半截不算「看起来能挡住人」的高度
  const size = { w: hi[0]! - lo[0]!, d: hi[2]! - lo[2]!, top: hi[1]! };
  sizeCache.set(file, size);
  return size;
};

describe('P5 主题竞技场：装饰（纯表现，sim 不读）', () => {
  const MODEL_ROOT = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../../../assets/art/models',
  );

  for (const { spec, map, prepHalfW } of pairs) {
    describe(`${spec.name}`, () => {
      const decor = map.decor ?? [];

      it('装饰存在且 z 镜像（前一半 = 后一半沿 z 翻转）', () => {
        expect(decor.length).toBeGreaterThanOrEqual(20);
        expect(decor.length % 2).toBe(0);
        const h = decor.length / 2;
        for (let i = 0; i < h; i++) {
          const s = decor[i]!;
          const n = decor[h + i]!;
          expect(n.position.x).toBeCloseTo(s.position.x, 6);
          expect(n.position.z).toBeCloseTo(-s.position.z, 6);
          expect(n.position.y).toBeCloseTo(s.position.y, 6);
        }
      });

      it('★ 装饰不挡出生走廊（与几何同一条规则）', () => {
        for (const d of decor) {
          const { x, z } = d.position;
          const inCorridor = Math.abs(x) <= prepHalfW && Math.abs(z) > spec.centerRadius;
          expect(inCorridor, `${d.model} 摆在出生走廊上（${x.toFixed(1)}, ${z.toFixed(1)}）`)
            .toBe(false);
        }
      });

      it('★ 装饰在边界内，且不摆进准备区', () => {
        for (const d of decor) {
          const { x, z } = d.position;
          expect(Math.abs(x), `${d.model} 越界`).toBeLessThan(map.bounds.max.x);
          expect(Math.abs(z), `${d.model} 越界`).toBeLessThan(map.bounds.max.z);
          for (const room of map.prepRooms ?? []) {
            const inRoom = x > room.volume.min.x && x < room.volume.max.x
              && z > room.volume.min.z && z < room.volume.max.z;
            expect(inRoom, `${d.model} 摆进了 ${room.id}`).toBe(false);
          }
        }
      });

      /**
       * ★ 与 `partyAssets.test.ts` 同一条纪律：模型路径拼错的下场是
       *   `DecorRenderer` 静默少摆一件（它逐层兜底、不报错），
       *   于是「图上该有的火盆」在真机上永远不出现而没人知道。
       */
      it('★ 每个装饰模型在素材盘上真实存在（防静默少摆）', () => {
        const missing = [...new Set(decor.map((d) => d.model))]
          .filter((m) => !existsSync(resolve(MODEL_ROOT, `${m}.glb`)));
        expect(missing, '装饰模型路径拼错').toEqual([]);
      });

      /**
       * ★★ §8.2「所见即所中」的**装饰侧**红线，`MapDecorDef` 的原话是
       *   「体量大到『看起来能挡住人』的东西必须同时登记一条 MapVolume」。
       *
       *   此前一条机检都没有，于是：密林祭坛摆了 7.1×7.0 m 的先祖废墟
       *   （比同一张图里**有**碰撞的树柱还大三倍）、4.0 m 的鹿角神龛，
       *   熔岩裂谷的台顶火盆 1.6 m > 胸口线，两张图的「贴外墙的树」
       *   实际离墙面 2.5–3.5 m —— 全部零碰撞，玩家躲进去就是躲了个寂寞。
       *
       *   尺寸是**从 glb 现量的**（accessor min/max × 节点变换），不是维护一张
       *   会烂掉的清单：换了模型、改了 scale，这条会自己重新判。
       */
      it('★★ 「看起来能挡住人」的装饰，身位内必须有真碰撞体', () => {
        const solids = map.geometry.filter((v) => v.blocksMovement !== false);
        const offenders: string[] = [];
        for (const d of decor) {
          const s = modelSize(resolve(MODEL_ROOT, `${d.model}.glb`));
          const scale = d.scale ?? 1;
          /** XZ 体量：比一个身位（2×半径 = 0.9 m）大一倍就够玩家动躲的念头 */
          const bulk = Math.max(s.w, s.d) * scale;
          /** 站立面以上的可见高度 */
          const top = s.top * scale;
          if (bulk <= 2 && top <= GEOMETRY.CHEST_HEIGHT) continue;
          // 影子半径就是判定半径：你的轮廓必须压在真碰撞体上
          const reach = Math.max(bulk / 2, 0.5);
          const needTop = d.position.y + Math.min(top, GEOMETRY.CHEST_HEIGHT);
          const backed = solids.some((v) => v.max.y >= needTop - 1e-6
            && v.min.y <= d.position.y + 1e-6
            && distance2D(d.position, {
              x: Math.min(Math.max(d.position.x, v.min.x), v.max.x),
              y: 0,
              z: Math.min(Math.max(d.position.z, v.min.z), v.max.z),
            }) <= reach + 1e-6);
          if (!backed) {
            offenders.push(`${d.model} @(${d.position.x.toFixed(1)}, ${d.position.z.toFixed(1)})`
              + ` ${bulk.toFixed(1)}×${top.toFixed(1)}m，${reach.toFixed(1)}m 内没有碰撞体`);
          }
        }
        expect(offenders, '大件装饰穿模（§8.2）').toEqual([]);
      });
    });
  }
});
