/**
 * 新手教学场地。docs/14 §M15。
 *
 * ★★ **它存在的理由是「试验场不该兼职」。**
 *
 *   M15 的教学最初直接跑在 `testbed` 上 —— 那张图自己的文件头写着
 *   「每个物件对应一条要验证的规则」，它是**诊断场**：楼梯是为了验
 *   「不因每级台阶进入跳跃」、矮栏杆是为了验「低矮物不误判视线」、
 *   断崖是为了验「陡坡视为墙」。这些对新玩家的第一课毫无意义。
 *
 *   更要命的是两边的约束会**互相踩**，而且从任何一侧都看不见：
 *   试验场的假人钉在玩家正前方 2.6 米（拳击 3 米够得到，验收脚本
 *   靠这个固定坐标做镜像走位），而教学第一环要玩家「走 5 米」——
 *   软推开落地后，新玩家按下 W 会当场被那个假人顶住，第一课就过不去。
 *   **教学那条「正前方 5 米内不能站人」的前提，此前不写在任何地方。**
 *
 * ── 布局（俯视，X 向右，Z 向下；出生点在南侧 Z=+）────────────────
 *
 *        -25              0              +25
 *   -25   ┌──────────────────────────────────┐
 *         │        ▉        ▉                │  两根柱子：镜头环有东西可绕
 *   -10   │                                  │
 *         │         ◇ 训练场中心 ◇           │  开阔地：走位环的陨石圈落这里
 *    +5   │   ▁▁▁ 矮台 ▁▁▁                  │  一处矮台：跳跃有目标感
 *   +18   │              ★ 出生点            │
 *         └──────────────────────────────────┘
 *
 * ★ **出生点正前方（-Z）一路开阔**：教学第一环是「走 5 米 + 跳一次」，
 *   这条走廊上不放任何东西 —— 几何、装饰、假人都不放。
 *   这条不变量由 `tutorial.test.ts` 与 `verify:m15` 各钉一次。
 */

import { asMapId, asTeamId } from '../../types/ids.js';
import { box, type MapDecorDef, type MapDef, type MapVolume } from './schema.js';

const GROUND = 56;

/**
 * 出生点正前方需要保持空旷的距离，米。
 *
 * ★ 取 8 米而不是 5 米：教学第一环要求走满 5 米，留 3 米余量是因为
 *   「走满 5 米」是**累计位移**，玩家可能斜着走、可能先转身 ——
 *   卡在 5.0 米整会让这条不变量变成一条勉强成立的巧合。
 */
export const TUTORIAL_CLEAR_AHEAD = 8;

/**
 * 这条走廊的半宽，米。
 *
 * ★ 取 1.6：角色胶囊半径 0.4，两个角色的软推开在 0.8 米就开始 ——
 *   1.6 米是「即使玩家走歪了也不会蹭到」的宽度。
 *   ★ 它同时定义了「什么叫挡在正前方」：`|x - spawn.x| <= 1.6` 且
 *     在 -Z 方向 8 米内。侧前方 2.5 米的战士假人**不在**走廊里，
 *     所以它既够得到玩家（拳击 3 米），又不挡路。
 */
export const TUTORIAL_CORRIDOR_HALF_WIDTH = 1.6;

const geometry: MapVolume[] = [
  // ── 地面 ────────────────────────────────────────────────────
  box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: GROUND, h: 1, d: GROUND }, {
    blocksSight: false,
  }),

  // ── 四面外墙：把新玩家圈在场地里，别走丢 ──────────────────
  box('wall_n', 'wall', { x: 0, y: 0, z: -GROUND / 2 }, { w: GROUND, h: 6, d: 1 }),
  box('wall_s', 'wall', { x: 0, y: 0, z: GROUND / 2 }, { w: GROUND, h: 6, d: 1 }),
  box('wall_w', 'wall', { x: -GROUND / 2, y: 0, z: 0 }, { w: 1, h: 6, d: GROUND }),
  box('wall_e', 'wall', { x: GROUND / 2, y: 0, z: 0 }, { w: 1, h: 6, d: GROUND }),

  /**
   * 两根柱子。**镜头环**要玩家绕视角与拉近拉远 —— 空场里转视角没有参照物，
   * 玩家看不出自己在转。
   * ★ 都放在 |x| ≥ 9 —— 出生点正前方的走廊不放东西（见文件头）。
   */
  box('pillar_w', 'pillar', { x: -10, y: 0, z: -14 }, { w: 2, h: 5, d: 2 }),
  box('pillar_e', 'pillar', { x: 10, y: 0, z: -14 }, { w: 2, h: 5, d: 2 }),

  /**
   * 一处矮台。**跳跃**有个落脚目标比对着空气跳更容易学会。
   * 高 0.8 米 > `STEP_HEIGHT`(0.45)，所以必须真的跳，不会被自动跨越。
   * ★ 放在侧边（x=-11），不挡正前方走廊。
   */
  box('platform', 'floor', { x: -11, y: 0, z: 4 }, { w: 5, h: 0.8, d: 4 }, {
    blocksSight: false,
  }),
];

const TEAM_RED = asTeamId(0);

/**
 * 装饰（纯表现，sim 不读）。
 * ★ 全部避开出生点正前方走廊与训练场中心 —— 教学场地的第一要求是**别挡路**。
 */
const decor: MapDecorDef[] = [
  { model: 'foliage/oak_1', position: { x: -24, y: 0, z: 24 }, yaw: 0.6 },
  { model: 'foliage/oak_1', position: { x: 24, y: 0, z: 24 }, yaw: 2.1 },
  { model: 'foliage/pine_1', position: { x: -24, y: 0, z: -22 }, yaw: 1.2 },
  { model: 'foliage/pine_1', position: { x: 24, y: 0, z: -22 }, yaw: 4.0 },
  { model: 'props/bonfire', position: { x: -20, y: 0, z: 16 }, yaw: 0 },
  { model: 'props/barrel', position: { x: 21, y: 0, z: 14 }, yaw: 0.4 },
];

export const tutorialMap: MapDef = {
  id: asMapId('tutorial'),
  name: '新手训练场',
  // ★ 与试验场同属 testbed 家族：它同样不是对战地图，不进任何模式的可选地图池
  family: 'testbed',
  modes: [],
  bounds: {
    min: { x: -GROUND / 2, y: -5, z: -GROUND / 2 },
    max: { x: GROUND / 2, y: 30, z: GROUND / 2 },
  },
  geometry,
  decor,
  forbidden: [],
  gates: [],
  fairness: {
    spawnToCenterDelta: 0,
    spawnToSupplyDelta: {},
    mobilityOnlyPlatforms: [],
    tolerance: 2.0,
  },
};

/** 教学的出生点。面向 -Z（场地中央），正前方一路开阔 */
export const TUTORIAL_SPAWN = {
  id: 'tutorial_spawn',
  team: TEAM_RED,
  position: { x: 0, y: 0, z: 18 },
  yaw: 0,
};

/** 只参与判定的体积（这张图没有纯装饰几何，全部参与）*/
export const tutorialObstacles = geometry;
