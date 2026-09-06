/**
 * 舞台不变量：**教学场地的出生点正前方必须是空的。**
 *
 * ★★ 这个文件存在的理由是一次真实的缺陷：
 *
 *   教学最初直接跑在试验场上，而试验场的战士假人钉在玩家**正前方 2.6 米**
 *   （拳击 3 米够得到，验收脚本靠这个固定坐标做镜像走位）。
 *   上一轮的软推开修复（角色不再互相重叠）落地后，教学第一环
 *   「走 5 米 + 跳一次」**当场卡死** —— 新玩家按下 W 会被那个假人顶住，
 *   实测只走了 2.2 米就停下。
 *
 *   最要命的不是这个 bug，而是**它从任何一侧都看不见**：
 *   教学那条「正前方 5 米内不能站人」的前提不写在任何地方，
 *   验收也不知道自己的坐标被另一台戏当成了舞台。
 *   两百多项验收全绿，`pnpm test` 全绿，只有真的按住 W 才会发现。
 *
 *   现在这条前提是一条断言。
 */

import { describe, expect, it } from 'vitest';
import {
  GEOMETRY, RANGE, TUTORIAL_CLEAR_AHEAD, TUTORIAL_CORRIDOR_HALF_WIDTH, box,
} from '@wowpvp/shared';
import { TESTBED_STAGE, TUTORIAL_STAGE, PRACTICE_STAGE, type Stage } from './stages.js';
import type { DummySpot } from '../combat/dummyLayouts.js';

/**
 * 这个假人是否挡在出生点正前方的走廊里。
 *
 * 出生点朝向 -Z（两张图都是），所以「前方」= `offset.z < 0`。
 * ★ 判据同时看**纵深**与**横向**：侧前方 2.5 米的假人不算挡路
 *   —— 它够得到你（近战 3 米），但你走得过去。
 */
const blocksCorridor = (spot: DummySpot): boolean =>
  spot.offset.z < 0 &&
  -spot.offset.z <= TUTORIAL_CLEAR_AHEAD &&
  Math.abs(spot.offset.x) <= TUTORIAL_CORRIDOR_HALF_WIDTH;

/**
 * 地图几何是否挡在同一条走廊里（只看会挡移动的体积）。
 *
 * ⚠️ **第一版这个函数什么都没验**：它读的是 `v.center` / `v.size`，
 *   而 `MapVolume extends Aabb` —— 只有 `min` / `max`。两个 undefined
 *   做比较恒为 false，于是「没有几何挡路」这条断言**因为错误的原因通过**。
 *   单测是绿的，`pnpm typecheck` 把它抓了出来 ——
 *   这正是本仓库第三层验证（「测试自己有没有说谎」）存在的理由。
 */
const geometryBlocksCorridor = (stage: Stage): string[] => {
  const spawn = stage.spawn.position;
  const hits: string[] = [];
  for (const v of stage.map.geometry) {
    // ★ `blocksMovement` 不填默认为 true（见 Aabb 的注释），所以只跳过显式 false
    if (v.blocksMovement === false) continue;
    // 顶面高度低于可跨越台阶的体积不算挡路（地面本身就是这一类）
    if (v.max.y <= GEOMETRY.STEP_HEIGHT) continue;

    // 走廊：x ∈ spawn.x ± 半宽，z ∈ [spawn.z - CLEAR_AHEAD, spawn.z]
    const overlapsX =
      v.max.x >= spawn.x - TUTORIAL_CORRIDOR_HALF_WIDTH &&
      v.min.x <= spawn.x + TUTORIAL_CORRIDOR_HALF_WIDTH;
    const overlapsZ =
      v.max.z >= spawn.z - TUTORIAL_CLEAR_AHEAD && v.min.z <= spawn.z;
    if (overlapsX && overlapsZ) hits.push(v.id);
  }
  return hits;
};

describe('practice courtyard', () => {
  it('starts a three-versus-three fight with a clear movement corridor', () => {
    expect(PRACTICE_STAGE.dummies.filter((d) => d.ally)).toHaveLength(2);
    expect(PRACTICE_STAGE.dummies.filter((d) => !d.ally)).toHaveLength(3);
    expect(PRACTICE_STAGE.dummies.filter(blocksCorridor)).toHaveLength(0);
    expect(geometryBlocksCorridor(PRACTICE_STAGE)).toEqual([]);
  });
});

describe('★★ 教学舞台：出生点正前方的走廊必须是空的', () => {
  it('★★ 没有任何假人挡在正前方 —— 第一环「走 5 米」走得出去', () => {
    const blockers = TUTORIAL_STAGE.dummies.filter(blocksCorridor);
    expect(
      blockers.map((b) => `${b.name}@(${b.offset.x},${b.offset.z})`),
      '有假人挡在教学出生点正前方 —— 新玩家按下 W 会被顶住，第一课就过不去',
    ).toEqual([]);
  });

  it('★★ 没有任何地图几何挡在正前方', () => {
    expect(
      geometryBlocksCorridor(TUTORIAL_STAGE),
      '有几何体挡在教学出生点正前方的走廊里',
    ).toEqual([]);
  });

  it('★★ 阳性对照：真放一堵墙进走廊，上面那条**会**红', () => {
    /**
     * 没有这一条的话，「没有几何挡路」可能只是**碰巧没东西**，
     * 而不是「这个检查真的会查」—— 上一版它就因为读错字段而恒为空。
     */
    const wall = box('probe_wall', 'wall',
      { x: TUTORIAL_STAGE.spawn.position.x, y: 0, z: TUTORIAL_STAGE.spawn.position.z - 4 },
      { w: 4, h: 3, d: 1 });
    const polluted: Stage = {
      ...TUTORIAL_STAGE,
      map: { ...TUTORIAL_STAGE.map, geometry: [...TUTORIAL_STAGE.map.geometry, wall] },
    };
    expect(geometryBlocksCorridor(polluted)).toContain('probe_wall');
  });

  it('★ 战士假人仍在近战射程内 —— 打断课与假读条课的几何没被这次挪动破坏', () => {
    const warrior = TUTORIAL_STAGE.dummies.find((d) => d.classId === 'warrior');
    expect(warrior, '教学舞台没有战士假人 —— 反制链第一环就演示不出来').toBeDefined();

    const d = Math.hypot(warrior!.offset.x, warrior!.offset.z);
    expect(
      d,
      `战士假人距玩家 ${d.toFixed(2)} 米，超出拳击的 ${RANGE.MELEE} 米 —— 它永远够不到你`,
    ).toBeLessThanOrEqual(RANGE.MELEE);
  });

  it('★ 三个假人一个不少（反制链三环各要一个演示者）', () => {
    expect(TUTORIAL_STAGE.dummies.map((d) => d.classId).sort())
      .toEqual(['mage', 'priest', 'warrior']);
  });

  it('★ 假人都落在地图边界之内', () => {
    const { min, max } = TUTORIAL_STAGE.map.bounds;
    for (const d of TUTORIAL_STAGE.dummies) {
      const x = TUTORIAL_STAGE.spawn.position.x + d.offset.x;
      const z = TUTORIAL_STAGE.spawn.position.z + d.offset.z;
      expect(x, `${d.name} 的 x 出界`).toBeGreaterThan(min.x);
      expect(x, `${d.name} 的 x 出界`).toBeLessThan(max.x);
      expect(z, `${d.name} 的 z 出界`).toBeGreaterThan(min.z);
      expect(z, `${d.name} 的 z 出界`).toBeLessThan(max.z);
    }
  });
});

describe('★ 两台戏的约束确实是冲突的（这就是它们不能共用舞台的原因）', () => {
  /**
   * ★★ 这条断言反过来钉住**试验场**：它的战士假人**就是**挡在正前方的，
   *   而且**必须**如此 —— 拳击 3 米，放远了 7.5 的假读条博弈演示不出来，
   *   二十多支验收脚本也靠这个固定坐标做镜像走位。
   *
   *   所以它不是「试验场那边写错了、改一下就好」。两个约束同时成立，
   *   只能分成两套布置。这条断言的作用是：将来有人想「顺手把试验场的
   *   假人也挪开」时，先在这里撞一下墙。
   */
  it('★★ 试验场的战士假人**故意**挡在正前方 —— 不许「顺手挪开」', () => {
    const blockers = TESTBED_STAGE.dummies.filter(blocksCorridor);
    expect(
      blockers.map((b) => b.classId),
      '试验场的战士假人被挪出了正前方 —— 拳击够不到玩家，假读条博弈就演示不出来了',
    ).toContain('warrior');
  });

  it('★ 两套布置确实是两份数据（不是同一个数组的两个引用）', () => {
    expect(TUTORIAL_STAGE.dummies).not.toBe(TESTBED_STAGE.dummies);
    expect(TUTORIAL_STAGE.map.id).not.toBe(TESTBED_STAGE.map.id);
  });
});
