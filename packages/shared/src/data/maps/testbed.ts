/**
 * M1 测试地图。**不是竞技场地图**，只用来验证移动物理与镜头的每一条规则。
 *
 * 布局（俯视，X 向右，Z 向下；出生点在南侧 Z=+）：
 *
 *        -30                 0                 +30
 *   -30   ┌──────────────────────────────────────┐
 *         │  ▓▓▓▓ 陡坡(不可爬)      ╱╱ 缓坡 ╱╱   │
 *         │                                      │
 *   -15   │   ▉ 柱   ═══════ 高墙 ═══════        │
 *         │                          ▉ 柱        │
 *    0    │        ▉柱      ⌂ 屋顶+拱门          │
 *         │                                      │
 *   +15   │   ┌──┐ 台阶     ┈┈ 低栏杆 ┈┈        │
 *         │   └──┘                               │
 *   +30   │              ★ 出生点                │
 *         └──────────────────────────────────────┘
 *
 * 每个物件对应一条要验证的规则，改动前先看注释里写的是哪条。
 */

import { asMapId, asTeamId } from '../../types/ids.js';
import { box, type MapDef, type MapVolume } from './schema.js';

const GROUND_SIZE = 70;

const geometry: MapVolume[] = [
  // ── 地面 ────────────────────────────────────────────────────
  box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: GROUND_SIZE, h: 1, d: GROUND_SIZE }, {
    blocksSight: false, // 地面不该挡水平视线
  }),

  // ── 四面外墙：验收 #44「不能穿墙」+ 4.3「镜头不得穿过墙壁」 ──
  box('wall_n', 'wall', { x: 0, y: 0, z: -GROUND_SIZE / 2 }, { w: GROUND_SIZE, h: 6, d: 1 }),
  box('wall_s', 'wall', { x: 0, y: 0, z: GROUND_SIZE / 2 }, { w: GROUND_SIZE, h: 6, d: 1 }),
  box('wall_w', 'wall', { x: -GROUND_SIZE / 2, y: 0, z: 0 }, { w: 1, h: 6, d: GROUND_SIZE }),
  box('wall_e', 'wall', { x: GROUND_SIZE / 2, y: 0, z: 0 }, { w: 1, h: 6, d: GROUND_SIZE }),

  // ── 中央高墙：测试沿墙滑动、镜头拉近、视线阻挡（6.4 / 验收 #11）──
  box('wall_center', 'wall', { x: 0, y: 0, z: -15 }, { w: 24, h: 5, d: 1.2 }),

  // ── 柱子：测试绕柱视线博弈与镜头碰撞（11.3）──
  box('pillar_a', 'pillar', { x: -16, y: 0, z: -14 }, { w: 2, h: 5, d: 2 }),
  box('pillar_b', 'pillar', { x: 14, y: 0, z: -10 }, { w: 2, h: 5, d: 2 }),
  box('pillar_c', 'pillar', { x: -12, y: 0, z: 0 }, { w: 2.5, h: 5, d: 2.5 }),

  // ── 拱门：6.4「开放拱门、门口和可通行通道允许效果传播」──
  // blocksMovement/blocksSight 都是 false —— 它只是视觉上的门框
  box('arch_center', 'arch', { x: 6, y: 0, z: 0 }, { w: 6, h: 4, d: 0.5 }, {
    blocksMovement: false,
    blocksSight: false,
    standable: false,
  }),
  // 拱门两侧的实体门柱
  box('arch_post_l', 'wall', { x: 2.6, y: 0, z: 0 }, { w: 0.8, h: 4, d: 0.8 }),
  box('arch_post_r', 'wall', { x: 9.4, y: 0, z: 0 }, { w: 0.8, h: 4, d: 0.8 }),
  // 屋顶：4.3「镜头不得穿过屋顶」
  box('roof_center', 'roof', { x: 6, y: 4, z: 0 }, { w: 8, h: 0.4, d: 6 }),

  // ── 低栏杆：6.4「低矮栏杆或仅遮挡脚部的物体不应频繁造成无视线」──
  // 挡移动但不挡视线。验收 #11 的反例侧。
  box('rail_low', 'rail', { x: 10, y: 0, z: 14 }, { w: 14, h: 0.6, d: 0.3 }, {
    blocksSight: false,
  }),

  // ── 楼梯：13.5「脚部贴地，不因每级台阶进入跳跃」──
  // 五级，每级 0.35 米 < STEP_HEIGHT(0.45)，应能平滑走上去
  ...Array.from({ length: 5 }, (_, i) =>
    box(`stair_${i}`, 'floor', { x: -14, y: 0, z: 14 - i * 1.2 }, { w: 5, h: 0.35 * (i + 1), d: 1.2 }, {
      blocksSight: false,
    }),
  ),
  // 楼梯顶部平台
  box('stair_top', 'floor', { x: -14, y: 0, z: 6.5 }, { w: 5, h: 1.75, d: 4 }, { blocksSight: false }),

  // ── 单级低障碍：13.5「小台阶、路缘和低石块可自动跨越」──
  box('curb', 'floor', { x: 4, y: 0, z: 20 }, { w: 8, h: 0.3, d: 0.6 }, { blocksSight: false }),

  // ── 缓坡：13.5「缓坡可走」。用阶梯逼近，每级 0.25 米 ──
  ...Array.from({ length: 12 }, (_, i) =>
    box(`ramp_${i}`, 'ramp', { x: 20, y: 0, z: -20 + i * 1.5 }, { w: 6, h: 0.25 * (12 - i), d: 1.5 }, {
      blocksSight: false,
    }),
  ),

  // ── 陡坡/高台：13.5「陡坡视为墙，不能斜向跳爬」──
  // 3 米高的垂直面。跳跃最高约 1.2 米，正常手段上不去。
  // 11.3「不设置只有特定位移职业才能到达的高台」—— 所以它旁边有缓坡可以绕上去
  box('cliff', 'wall', { x: -20, y: 0, z: -24 }, { w: 12, h: 3, d: 8 }),

  // ── 深水：13.5「深水可终止坠落伤害」──
  box('water', 'water', { x: 24, y: -1, z: 24 }, { w: 12, h: 1.2, d: 12 }, {
    blocksMovement: false,
    blocksSight: false,
    standable: false,
    endsFallDamage: true,
  }),
];

const TEAM_RED = asTeamId(0);

export const testbed: MapDef = {
  id: asMapId('testbed'),
  name: '移动物理试验场',
  family: 'testbed',
  modes: [],
  bounds: {
    min: { x: -GROUND_SIZE / 2, y: -5, z: -GROUND_SIZE / 2 },
    max: { x: GROUND_SIZE / 2, y: 30, z: GROUND_SIZE / 2 },
  },
  geometry,
  forbidden: [],
  gates: [],
  fairness: {
    spawnToCenterDelta: 0,
    spawnToSupplyDelta: {},
    mobilityOnlyPlatforms: [],
    tolerance: 2.0,
  },
};

/** M1 单人测试的出生点 */
export const TESTBED_SPAWN = {
  id: 'testbed_spawn',
  team: TEAM_RED,
  position: { x: 0, y: 0, z: 26 },
  yaw: 0, // 面向 -Z，即朝向场地中央
};

/** 只参与判定的体积（排除纯装饰）*/
export const testbedObstacles = geometry;
