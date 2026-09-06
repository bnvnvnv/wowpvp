/**
 * 单机场景的两套「舞台」：**验收用的试验场** 与 **新手教学场**。
 *
 * ★★ **分开的是数据，不是机制。**
 *
 *   `TestbedScene` 一个类演两台戏 —— 渲染、HUD、输入、假人行为、
 *   `botController` 决策全部共享。舞台只决定三样东西：
 *   **哪张地图、从哪出生、假人摆在哪**。
 *
 *   为什么必须分：两边的约束天生冲突，而且从任何一侧都看不见对方。
 *   · 试验场要「假人钉在已知坐标上」—— 二十多支验收脚本靠它做镜像走位
 *   · 教学要「第一环教走路，正前方就不能站人」
 *   共用一份坐标的后果已经出现过一次：上一轮的软推开修复（角色不再互相
 *   重叠）让教学第一环当场卡死，新玩家按下 W 被正前方 2.6 米的战士假人
 *   顶住，走不满 5 米 —— 而这个缺陷从两侧都看不见，因为教学那条
 *   「正前方 5 米内不能站人」的前提**不写在任何地方**。
 *   现在它写在 `data/maps/tutorial.ts` 的 `TUTORIAL_CLEAR_AHEAD` 上，
 *   并由 `tutorial.test.ts` 与 `verify:m15` 各钉一次。
 */

import {
  TESTBED_SPAWN, TUTORIAL_SPAWN, testbed, tutorialMap, asMapId, box, type MapDef,
} from '@wowpvp/shared';
import {
  TUTORIAL_DUMMIES, VERIFY_DUMMIES, stressDummies, type DummySpot,
} from '../combat/dummyLayouts.js';

export interface Stage {
  map: MapDef;
  spawn: { position: { x: number; y: number; z: number }; yaw: number };
  dummies: readonly DummySpot[];
}

/**
 * 验收用试验场。**M1–M16 两百多项验收的载体，动它等于动整张回归网。**
 * ★ 它是 `TestbedScene` 的默认舞台，所以默认路径的行为与分家之前逐字相同。
 */
export const TESTBED_STAGE: Stage = {
  map: testbed,
  spawn: { position: TESTBED_SPAWN.position, yaw: TESTBED_SPAWN.yaw },
  dummies: VERIFY_DUMMIES,
};

/** 新手教学场。为教学设计：正前方开阔、场地小一圈、没有诊断用的障碍 */
export const TUTORIAL_STAGE: Stage = {
  map: tutorialMap,
  spawn: { position: TUTORIAL_SPAWN.position, yaw: TUTORIAL_SPAWN.yaw },
  dummies: TUTORIAL_DUMMIES,
};

/** A compact team fight, with clear lanes and cover, for the player-facing practice entry. */
export const PRACTICE_STAGE: Stage = {
  map: {
    ...testbed,
    id: asMapId('practice_courtyard'),
    name: '\u738b\u51a0\u5ead\u9662',
    envPreset: 'day',
    groundTexture: 'stone',
    bounds: { min: { x: -29, y: -5, z: -27 }, max: { x: 29, y: 30, z: 27 } },
    geometry: [
      box('floor', 'floor', { x: 0, y: -1, z: 0 }, { w: 56, h: 1, d: 52 }, { blocksSight: false }),
      box('wall_n', 'wall', { x: 0, y: 0, z: -26 }, { w: 56, h: 3.6, d: 1.2 }),
      box('wall_s', 'wall', { x: 0, y: 0, z: 26 }, { w: 56, h: 3.6, d: 1.2 }),
      box('wall_w', 'wall', { x: -28, y: 0, z: 0 }, { w: 1.2, h: 3.6, d: 52 }),
      box('wall_e', 'wall', { x: 28, y: 0, z: 0 }, { w: 1.2, h: 3.6, d: 52 }),
      ...[-1, 1].flatMap((side) => Array.from({ length: 18 }, (_, i) => [
        box(`merlon_z_${side}_${i}`, 'pillar', { x: -26 + i * 3.05, y: 3.6, z: side * 26 }, { w: 1.35, h: 0.65, d: 1.2 }),
        box(`merlon_x_${side}_${i}`, 'pillar', { x: side * 28, y: 3.6, z: -24.5 + i * 2.9 }, { w: 1.2, h: 0.65, d: 1.25 }),
      ]).flat()),
      ...[-1, 1].flatMap((side) => [-1, 1].map((end) =>
        box(`tower_${side}_${end}`, 'pillar', { x: side * 9, y: 0, z: end * 6 }, { w: 3, h: 4.2, d: 3 }))),
      ...[-1, 1].flatMap((side) => [-1, 1].flatMap((end) => [-1, 1].flatMap((dx) => [-1, 1].map((dz) =>
        box(`tower_crown_${side}_${end}_${dx}_${dz}`, 'pillar',
          { x: side * 9 + dx * 1.1, y: 4.2, z: end * 6 + dz * 1.1 }, { w: 0.8, h: 0.6, d: 0.8 }))))),
      box('dais', 'floor', { x: 0, y: 0, z: 0 }, { w: 7, h: 0.35, d: 5 }, { blocksSight: false }),
    ],
    decor: [
      { model: 'props/eastbrook_grand_armoury', position: { x: 0, y: -0.3, z: -43 }, scale: 0.76 },
      { model: 'props/eastbrook_chapel', position: { x: 0, y: 0, z: 38 }, scale: 1.55, yaw: Math.PI },
      { model: 'props/eastbrook_chapel', position: { x: -40, y: 0, z: -12 }, scale: 1.3, yaw: Math.PI / 2 },
      { model: 'props/eastbrook_chapel', position: { x: 40, y: 0, z: -12 }, scale: 1.3, yaw: -Math.PI / 2 },
    ],
  },
  spawn: { position: { x: 0, y: 0, z: 17 }, yaw: 0 },
  dummies: [
    { classId: 'warrior', offset: { x: -4, y: 0, z: -3 }, name: '\u961f\u53cb\u00b7\u6218\u58eb', ally: true },
    { classId: 'priest', offset: { x: 4, y: 0, z: 1 }, name: '\u961f\u53cb\u00b7\u7267\u5e08', ally: true },
    { classId: 'warrior', offset: { x: 0, y: 0, z: -24 }, name: '\u5bf9\u624b\u00b7\u6218\u58eb' },
    { classId: 'mage', offset: { x: -5, y: 0, z: -29 }, name: '\u5bf9\u624b\u00b7\u6cd5\u5e08' },
    { classId: 'priest', offset: { x: 5, y: 0, z: -30 }, name: '\u5bf9\u624b\u00b7\u7267\u5e08' },
  ],
};

/**
 * P2 压测场（`?stress=`）：24 个实体全部在一个视野里同时开打。
 *
 * ★ 复用试验场的地图与出生点 —— 压测要量的是**实体与特效负载**，
 *   换一张地图会把地图几何的差异混进读数。第三个舞台只改「摆几个人、
 *   摆在哪」，与前两个舞台是同一条机制。
 * ★ `?stress=<n>` 可调人数（默认 23 + 玩家 = 24 = 12v12）——
 *   跑出瓶颈后想二分定位「多少人开始掉帧」时用得上。
 */
export const stressStage = (count?: number): Stage => ({
  map: testbed,
  spawn: { position: TESTBED_SPAWN.position, yaw: TESTBED_SPAWN.yaw },
  dummies: stressDummies(count),
});
