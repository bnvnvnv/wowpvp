/**
 * 快照 Tab 与 sim Tab 的**一致性**。规格书 5.3 / 已知偏差 #5。
 *
 * ★★ 这个文件测的不是「客户端 Tab 能用」，而是
 *   **「两条路径在同一个场景上挑出同一个人」**。
 *
 *   把 Tab 搬到客户端的唯一风险就是「5.3 的优先级出现第二份实现并漂移」。
 *   防它的办法是让排序与循环语义都复用 shared 的 `sortTabCandidates()` /
 *   `nextTabPick()`，而这条测试就是那份复用的守卫：哪天有人在客户端
 *   「顺手按自己的想法排一下」，两边的结果会分岔，这里立刻红。
 */

import { describe, expect, it } from 'vitest';
import {
  TARGETING,
  asClassId,
  asTeamId,
  collectTabCandidates,
  createEntity,
  createWorld,
  addEntity,
  allocEntityId,
  nextTabPick,
  sortTabCandidates,
  vec3,
  mage,
  warrior,
  type EntityId,
  type HydratedEntitySnapshot as EntitySnapshot,
  type World,
} from '@wowpvp/shared';

import { pickTabTargetFromSnapshot } from './snapshotTargeting.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);

/** 把一个 sim 实体转成它在快照里的样子（只填 Tab 用得到的字段）*/
const toSnapshot = (e: {
  id: EntityId; team: ReturnType<typeof asTeamId>;
  position: { x: number; y: number; z: number }; alive: boolean;
}): EntitySnapshot => ({
  id: e.id,
  name: `e${e.id}`,
  team: e.team,
  classId: asClassId('mage'),
  position: e.position,
  yaw: 0,
  teleported: false,
  health: 100,
  maxHealth: 100,
  alive: e.alive,
  resources: {},
  maxResources: {},
  auras: [],
  carryingFlag: false,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
});

/** 造一个「玩家 + N 个敌人」的场景，两条路径各跑一次 */
const scene = (positions: readonly { x: number; z: number }[]) => {
  const world: World = createWorld([]);
  const me = addEntity(world, createEntity(allocEntityId(world), mage, RED, vec3(0, 0, 0)));
  const foes = positions.map((p) =>
    addEntity(world, createEntity(allocEntityId(world), warrior, BLUE, vec3(p.x, 0, p.z))));
  return { world, me, foes };
};

describe('★★ 快照 Tab 与 sim Tab 挑出同一个人', () => {
  const viewYaw = 0; // 面向 −Z

  const compare = (positions: readonly { x: number; z: number }[], current?: EntityId) => {
    const { world, me, foes } = scene(positions);

    // sim 路径
    const simSorted = sortTabCandidates(collectTabCandidates(world, me, { viewYaw }));
    const simPick = nextTabPick(simSorted, current)?.id;

    // 快照路径
    const snapPick = pickTabTargetFromSnapshot({
      selfId: me.id,
      selfPosition: me.position,
      selfTeam: me.team,
      viewYaw,
      entities: foes.map(toSnapshot),
      ...(current !== undefined ? { currentTargetId: current } : {}),
    });

    return { simPick, snapPick, foes };
  };

  it('★★ 单个目标：两边都选中他', () => {
    const { simPick, snapPick, foes } = compare([{ x: 0, z: -10 }]);
    expect(snapPick).toBe(foes[0]!.id);
    expect(snapPick, '快照路径与 sim 路径分岔了').toBe(simPick);
  });

  it('★★ 多个目标：两边挑出同一个（屏幕中心优先）', () => {
    // 一个正前方稍远、一个偏 30° 很近 —— 5.3 先看中心夹角分档
    const { simPick, snapPick } = compare([
      { x: 0, z: -22 },
      { x: -12, z: -12 },
      { x: 9, z: -18 },
    ]);
    expect(snapPick).toBeDefined();
    expect(snapPick, '多目标时两条路径挑了不同的人').toBe(simPick);
  });

  it('★★ 带当前目标时，两边的「下一个」也一致', () => {
    const first = compare([{ x: 0, z: -12 }, { x: 5, z: -14 }, { x: -6, z: -16 }]);
    const cur = first.snapPick!;
    const again = compare([{ x: 0, z: -12 }, { x: 5, z: -14 }, { x: -6, z: -16 }], cur);
    expect(again.snapPick, '循环到的下一个不一致').toBe(again.simPick);
    expect(again.snapPick, '「下一个」应当换人').not.toBe(cur);
  });
});

describe('5.3 的过滤条件', () => {
  it('★ 超出 45 米的不进候选', () => {
    const { me, foes } = scene([{ x: 0, z: -(TARGETING.TAB_MAX_RANGE + 5) }]);
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: foes.map(toSnapshot),
    });
    expect(pick, '超距目标进了候选').toBeUndefined();
  });

  it('★ 完全在身后的不进首轮候选（镜头前方 140°）', () => {
    const { me, foes } = scene([{ x: 0, z: 10 }]); // 正后方
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: foes.map(toSnapshot),
    });
    expect(pick).toBeUndefined();
  });

  it('★ 队友不进候选', () => {
    const { me } = scene([]);
    const ally = toSnapshot({ id: 99 as EntityId, team: me.team, position: vec3(0, 0, -8), alive: true });
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: [ally],
    });
    expect(pick).toBeUndefined();
  });

  it('★ 死人不进候选', () => {
    const { me } = scene([]);
    const dead = toSnapshot({ id: 98 as EntityId, team: BLUE, position: vec3(0, 0, -8), alive: false });
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: [dead],
    });
    expect(pick).toBeUndefined();
  });

  /**
   * ★★ 验收 #5 在这条路径上是**自动成立**的：未被发现的潜行者根本不在快照里，
   *   所以客户端连「要不要排除他」这个判断都不需要做 —— 也**做不了**。
   *   这正是 `visibility.ts` 那句「未被发现的潜行者对该客户端根本不存在」
   *   在客户端一侧的体现。
   */
  it('★★ 不在快照里的实体不可能被 Tab 到（验收 #5）', () => {
    const { me } = scene([]);
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: [], // 潜行者被服务器裁掉了
    });
    expect(pick).toBeUndefined();
  });

  it('★ 没有候选时返回 undefined —— 调用方据此**保持原目标不变**（5.3）', () => {
    const { me } = scene([]);
    const pick = pickTabTargetFromSnapshot({
      selfId: me.id, selfPosition: me.position, selfTeam: me.team,
      viewYaw: 0, entities: [], currentTargetId: 7 as EntityId,
    });
    expect(pick).toBeUndefined();
  });
});
