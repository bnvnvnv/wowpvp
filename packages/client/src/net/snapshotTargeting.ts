/**
 * 从**快照**里算 Tab 候选。规格书 5.3。
 *
 * ★★ **为什么 Tab 要在客户端算，而不是发一条 `TabTarget` 给服务器：**
 *
 *   5.3 规定 Tab 取的是**镜头**前方 140°，而协议里根本没有镜头朝向 ——
 *   `InputMessage.characterYaw` 特意注明了「**角色**朝向，不是镜头朝向（6.5）」。
 *   服务器拿不到镜头，就做不出符合 5.3 的 Tab（已登记为已知偏差 #5）。
 *
 *   而把 Tab 放在客户端**不会**引入作弊口子：客户端算完只是发一条
 *   `SetTarget{entityId}`，而服务器对 `SetTarget` 是**校验可见集合**的
 *   （`RoomServer.onSetTarget`，verify:m10 第 7 条盯着）。
 *   也就是说客户端只能在「服务器已经告诉过他的实体」里挑一个 ——
 *   挑错了也越不过那道门。**既符合 5.3，又不放宽安全边界。**
 *
 * ★ 排序规则**不在这里** —— 复用 shared 的 `sortTabCandidates()` / `nextTabPick()`。
 *   5.3 的优先级（屏幕中心 → 距离 → 可见 → 施法 → 旗手）以及「当前目标不在
 *   候选里就从头开始」这条边界，都只有一处实现。这里只负责**把快照喂成
 *   那个函数认识的形状**。
 */

import {
  TARGETING,
  dirToYaw,
  distance,
  normalize2D,
  sortTabCandidates,
  nextTabPick,
  sub,
  type EntityId,
  type EntitySnapshot,
  type TabRanking,
  type TeamId,
  type Vec3,
} from '@wowpvp/shared';

const DEG = Math.PI / 180;

/** 把角度差折算到 [0, π] */
const angleDelta = (a: number, b: number): number => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
};

export interface SnapshotTabInput {
  /** 自己的实体 id 与位置 */
  selfId: EntityId;
  selfPosition: Vec3;
  selfTeam: TeamId;
  /** ★ **镜头** yaw，不是角色 yaw —— 这正是本文件存在的理由 */
  viewYaw: number;
  entities: readonly EntitySnapshot[];
  /** 当前硬目标，用于决定「下一个」是谁 */
  currentTargetId?: EntityId;
  /** 谁正在施法。快照里没有施法状态时传 undefined，该项排序权重自然失效 */
  isCasting?: (id: EntityId) => boolean;
}

/**
 * 算出 Tab 应当选中谁。返回 undefined 表示**没有候选，保持原目标不变**（5.3）。
 *
 * ⚠️ 这里**不做视线判断** —— 客户端没有地图几何的权威副本，
 *    而 5.3 说被墙挡住的目标「可以保持已选中，但不优先进入新的 Tab 候选」。
 *    所以 `visible` 一律填 true：宁可让排序少一个降权因素，
 *    也不要用一个和服务器不一致的视线判断去**排除**候选 ——
 *    那会让玩家 Tab 不到一个服务器认为合法的目标。
 */
export const pickTabTargetFromSnapshot = (
  input: SnapshotTabInput,
  reverse = false,
): EntityId | undefined => {
  const halfArc = (TARGETING.TAB_FRONT_ARC_DEG / 2) * DEG;
  const candidates: TabRanking[] = [];

  for (const e of input.entities) {
    if (e.id === input.selfId) continue;
    // 5.3：只对敌对目标循环。★ 潜行者压根不在快照里，所以「排除未被发现的
    //   潜行目标」（验收 #5）在这里是**自动成立**的 —— 不需要也无法再判一次
    if (e.team === input.selfTeam) continue;
    if (!e.alive) continue;

    const d = distance(input.selfPosition, e.position);
    if (d > TARGETING.TAB_MAX_RANGE) continue;

    const toTarget = normalize2D(sub(e.position, input.selfPosition));
    const angleFromCenter = angleDelta(input.viewYaw, dirToYaw(toTarget));
    if (angleFromCenter > halfArc) continue;

    candidates.push({
      id: e.id,
      angleFromCenter,
      distance: d,
      visible: true, // 见函数头的 ⚠️
      casting: input.isCasting?.(e.id) ?? false,
      isFlagCarrier: e.carryingFlag,
    });
  }

  // ★ 排序与「下一个」的循环语义都来自 shared —— 这里一行规则都没有
  return nextTabPick(sortTabCandidates(candidates), input.currentTargetId, reverse)?.id;
};
