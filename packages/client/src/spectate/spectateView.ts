/**
 * W24 观战席 / 中途加入的**纯逻辑面**（提示条文案、席位余量、顶替后的职业文案）。
 *
 * ★★ 放这里的理由与 `scenes/sceneViews.ts` 一字不差：这几段判断的天然归宿是
 *   `NetworkScene` / `LobbyShell` 两个类，而它们一个需要 WebGL、一个需要 DOM ——
 *   本仓库没有 jsdom，内联进去就等于**一条断言都写不了**。而 W24 客户端半边
 *   最容易悄悄变成谎话的恰恰是文案：「下回合起换成你选的」在竞技场里
 *   （单回合制）永远不会兑现，那是界面在对玩家撒谎，而撒谎不会让任何测试变红。
 *
 * ⚠️ 这里**不许**出现 three.js / DOM 引用。
 */

import { FFA, GameMode, getClass, type RoomPlayerView } from '@wowpvp/shared';

// ── 观战提示条 ──────────────────────────────────────────────────

/**
 * 屏幕顶部那一条。★ 两态：跟着一个人 / 一个可跟的都没有。
 *
 * ★★ 「暂无可观战目标」这一态是**协议里真实存在的一帧**：服务器在
 *   `you` 上发 `NO_ENTITY`（0 哨兵）—— 全场阵亡或全场潜行时就是它。
 *   客户端此刻要做的是「保持上一帧镜头 + 如实说一句」，**不是**去查实体 0。
 */
export const spectateBannerText = (followName?: string): string =>
  followName === undefined
    ? '观战中 · 暂无可观战目标（场上无人存活或全部潜行）'
    : `观战中 · 正在看 ${followName} · 按 V 切换视角`;

/** 观战席的底部键位提示。★ 只列观战席**真的按得动**的键 —— 技能键在这条路上一个都发不出去 */
export const SPECTATE_HINT_TEXT =
  '观战席 · V 切换视角 · 鼠标拖动/滚轮转镜头 · O 记分板 · F10 设置 · 面板里可离开对局';

// ── 中途加入：席位余量 ───────────────────────────────────────────

/** 席位面板上的一颗按钮。★ 全部字段都从 `RoomState` 名单算出，客户端不猜 */
export interface MidJoinSeat {
  /** 发给服务器的取值。大乱斗两个取值同义，统一发 red（协议注释里的口径）*/
  team: 'red' | 'blue';
  label: string;
  /** 空席位数：新建实体入场，选的职业**当场生效** */
  free: number;
  /**
   * 名单上标着「人机」的席位数 —— 顶替它就是**沿用它的职业**。
   *
   * ⚠️ 这个数是**上界**不是保证：`RoomPlayerView.bot` 对「掉线接管」的席位
   *   同样为真，而那种席位服务器**不允许**顶替（那是某个真人的角色，他攥着
   *   重连令牌）。协议里没有第二个字段区分两者，客户端也不该猜 ——
   *   点下去会收到一条诚实拒绝，那比在这里编一个更小的数诚实。
   */
  bots: number;
  /** 这颗按钮点不点得动 */
  selectable: boolean;
  /** 按钮下面那句人话（禁用理由 / 生效口径）*/
  hint: string;
}

/**
 * `RoomState` 名单 → 中途加入的席位选项。
 *
 * ★★ 顺序与服务器 `onJoinOngoing` 的两条路**一一对应**（先空席、后顶替）——
 *   两边的口径分叉的话，界面会承诺一个服务器不给的结果。
 * ★ 大乱斗只有一个选项「参战」：P12 的独立阵营下没有红蓝，服务器把
 *   `team` 的两个取值都读作「参战」。
 */
export const midJoinSeats = (
  players: readonly RoomPlayerView[],
  opts: { mode?: GameMode | undefined; teamSize: number },
): MidJoinSeat[] => {
  const hintOf = (free: number, bots: number): string =>
    free > 0
      ? `${free} 个空位 —— 新角色入场，你选的职业当场生效`
      : bots > 0
        ? `${bots} 个人机席位可顶替 —— 本局沿用它的职业`
        : '满员，且没有人机席位可顶替';

  if (opts.mode === GameMode.Ffa) {
    const fighters = players.filter((p) => p.team !== 'spectator');
    const free = Math.max(0, FFA.MAX_PLAYERS - fighters.length);
    return [{
      team: 'red',
      label: '参战',
      free,
      bots: 0,
      selectable: free > 0,
      hint: free > 0 ? `${free} 个名额 —— 大乱斗中途加入是新角色，职业当场生效` : '这局大乱斗已经满员了',
    }];
  }

  return (['red', 'blue'] as const).map((team) => {
    const members = players.filter((p) => p.team === team);
    const free = Math.max(0, opts.teamSize - members.length);
    const bots = members.filter((p) => p.bot === true).length;
    return {
      team,
      label: team === 'red' ? '红方' : '蓝方',
      free,
      bots,
      selectable: free + bots > 0,
      hint: hintOf(free, bots),
    };
  });
};

/**
 * 席位面板上那句「顶替人机意味着什么」的**事前**提示（选之前就说清楚）。
 * 返回 null = 这个模式没有这一说（大乱斗永远是新建实体，职业当场生效）。
 *
 * ★★ 与 `midJoinClassNotice`（事后）是同一件事的两个时刻，所以两处的
 *   竞技场分支必须说同一句话：**这局不会有下一个回合**。
 */
export const midJoinTakeoverHint = (family: string | undefined): string | null =>
  family === 'ffa'
    ? null
    : family === 'ctf'
      ? '⚠️ 顶替人机席位时本回合沿用它的职业，你选的会在下一次复活后生效'
      : '⚠️ 顶替人机席位时本局沿用它的职业 —— 竞技场只有一个回合，你选的这局不会生效';

// ── 中途加入：顶替之后的职业文案 ─────────────────────────────────

/**
 * 顶替人机之后那句「你选的职业还没生效」。返回 null = 不该说这句话。
 *
 * ★★ **竞技场那一支是本函数存在的全部理由。** 服务器把选的职业登记进
 *   `pendingRespec`，兑现点是「死 → 活」那一跳；而竞技场默认单回合制
 *   （`roundsToWin: 1`，服务器从不调 `resetRound`）—— 那一刻在本局
 *   **不会到来**。照抄夺旗那句「下回合起换成你选的」就是承诺一个不会
 *   发生的下回合，而承诺落空不会让任何测试变红。
 * ★ 大乱斗一律 null：那条路是**新建实体**（`admitToMatch`），职业当场生效，
 *   压根没有「还没生效」这一态。
 */
export const midJoinClassNotice = (
  requestedClassId: string | undefined,
  actualClassId: string | undefined,
  family: string | undefined,
): string | null => {
  if (!requestedClassId || !actualClassId) return null;
  if (requestedClassId === actualClassId) return null;
  if (family === 'ffa') return null;
  const nameOf = (id: string): string => getClass(id as never)?.name ?? id;
  const now = nameOf(actualClassId);
  const want = nameOf(requestedClassId);
  return family === 'ctf'
    ? `本局先用【${now}】（顶替的人机就是这个职业）—— 你选的【${want}】会在下一次复活后生效`
    : `本局将沿用【${now}】（顶替的人机就是这个职业）—— 竞技场只有一个回合，你选的【${want}】这局不会生效`;
};
