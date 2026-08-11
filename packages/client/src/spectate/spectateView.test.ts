/**
 * W24 客户端半边的纯逻辑测试。
 *
 * ★★ 这一组盯的东西与别处不同：**它盯的是文案会不会撒谎**。
 *   界面上的谎话没有任何自动化会红 —— 「下回合起换成你选的」在竞技场
 *   （单回合制，服务器从不调 `resetRound`）永远不会兑现，而玩家只会在
 *   等一个不会到来的回合。所以那句话由纯函数产出，并由这里钉住。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FFA, GameMode, TEAM_BLUE, TEAM_RED, getClass, type RoomPlayerView,
} from '@wowpvp/shared';

import {
  SPECTATE_HINT_TEXT,
  midJoinClassNotice,
  midJoinSeats,
  midJoinTakeoverHint,
  spectateBannerText,
} from './spectateView.js';
import { nextSpectateSeatTarget, nextSpectateTarget } from './SpectateController.js';

const player = (over: Partial<RoomPlayerView> = {}): RoomPlayerView => ({
  id: 'p',
  name: '玩家',
  team: 'spectator',
  ready: false,
  connected: true,
  ...over,
});

describe('W24 观战提示条', () => {
  it('跟着一个人时把名字与切换键都说出来', () => {
    const t = spectateBannerText('阿红');
    expect(t).toContain('阿红');
    expect(t).toContain('V');
  });

  /**
   * ★★ `you === NO_ENTITY`（0 哨兵）是协议里**真实存在的一帧**：全场阵亡
   *   或全部潜行。这一态必须有一句自己的话 —— 否则玩家看到的是一个
   *   冻住的镜头加一条说着别人名字的提示条。
   */
  it('★★ 一个可跟的都没有时如实说「暂无可观战目标」，且不冒出 undefined', () => {
    const t = spectateBannerText(undefined);
    expect(t).toContain('暂无可观战目标');
    expect(t).not.toContain('undefined');
  });

  it('★ 底部键位提示只列观战席按得动的键 —— 不许出现技能键那一串', () => {
    expect(SPECTATE_HINT_TEXT).toContain('V');
    expect(SPECTATE_HINT_TEXT).not.toContain('1–9');
    expect(SPECTATE_HINT_TEXT).not.toContain('施法');
  });
});

describe('W24 观战席的跟随轮换（与 11.4 死亡观战刻意不同源）', () => {
  const list = [
    { id: 1, team: TEAM_RED, alive: true },
    { id: 2, team: TEAM_BLUE, alive: true },
    { id: 3, team: TEAM_BLUE, alive: false },
  ];

  it('按 id 序推进并回卷；死人不在候选里', () => {
    expect(nextSpectateSeatTarget(list, null)?.id).toBe(1);
    expect(nextSpectateSeatTarget(list, 1)?.id).toBe(2);
    expect(nextSpectateSeatTarget(list, 2)?.id).toBe(1); // 3 已死 → 回卷
  });

  it('★★ 观战席**不按队伍过滤** —— 敌我两边都跟得了（他没有「己方」）', () => {
    const ids = new Set<number>();
    let cur: number | null = null;
    for (let i = 0; i < 4; i++) {
      cur = nextSpectateSeatTarget(list, cur)?.id ?? null;
      if (cur !== null) ids.add(cur);
    }
    expect([...ids].sort()).toEqual([1, 2]);
  });

  /**
   * ★★ 反向锁：死亡观战那条**仍然**按队伍过滤。两条判据合并成一条的话，
   *   场上的活人按 V 就能跟到敌人身上 —— 那正是 11.4 禁止的免费透视。
   */
  it('★★ 死亡观战那条没有被顺手放宽（同队约束仍在）', () => {
    // 视角是 1 号（红队）：候选里只该有同队的活人，而 2 号在蓝队
    expect(nextSpectateTarget(list, 1, TEAM_RED, null)).toBeUndefined();
  });

  it('全场无人存活 → undefined（调用方据此显示「暂无可观战目标」）', () => {
    expect(nextSpectateSeatTarget([{ id: 1, team: 10, alive: false }], null)).toBeUndefined();
  });
});

describe('W24 席位面板：余量从名单算出', () => {
  const teamRoster = [
    player({ id: 'r1', team: 'red' }),
    player({ id: 'r2', team: 'red', bot: true }),
    player({ id: 'b1', team: 'blue' }),
    player({ id: 'w', team: 'spectator' }),
  ];

  it('组队模式给红蓝两个选项，空位与人机席位分开数', () => {
    const seats = midJoinSeats(teamRoster, { mode: GameMode.Arena3v3, teamSize: 3 });
    expect(seats.map((s) => s.team)).toEqual(['red', 'blue']);
    const red = seats[0]!;
    expect(red.free).toBe(1);   // 3 席，红方坐了 2 个
    expect(red.bots).toBe(1);   // 其中一个是人机
    expect(seats[1]!.free).toBe(2);
  });

  /**
   * ★★ 满员 + 全人机的队伍**仍然可选** —— 这正是中途加入的主场景
   *   （开局后队伍被人机补满）。判成「满员不可选」的话，这条路在界面上不存在。
   */
  it('★★ 满员但坐着人机 → 仍然可选，且说清「沿用它的职业」', () => {
    const full = [
      player({ id: 'r1', team: 'red' }),
      player({ id: 'r2', team: 'red', bot: true }),
      player({ id: 'r3', team: 'red', bot: true }),
    ];
    const red = midJoinSeats(full, { mode: GameMode.Arena3v3, teamSize: 3 })[0]!;
    expect(red.free).toBe(0);
    expect(red.bots).toBe(2);
    expect(red.selectable).toBe(true);
    expect(red.hint).toContain('沿用');
  });

  it('满员且一个人机都没有（纯真人局）→ 不可选，且说清理由', () => {
    const full = [
      player({ id: 'r1', team: 'red' }),
      player({ id: 'r2', team: 'red' }),
      player({ id: 'r3', team: 'red' }),
    ];
    const red = midJoinSeats(full, { mode: GameMode.Arena3v3, teamSize: 3 })[0]!;
    expect(red.selectable).toBe(false);
    expect(red.hint).toContain('没有人机席位');
  });

  it('★ 大乱斗只有一个「参战」选项（P12：没有两队）', () => {
    const seats = midJoinSeats(teamRoster, { mode: GameMode.Ffa, teamSize: 0 });
    expect(seats).toHaveLength(1);
    expect(seats[0]!.label).toBe('参战');
    expect(seats[0]!.free).toBe(FFA.MAX_PLAYERS - 3); // 观战席那位不算参战者
    // 大乱斗中途加入是新建实体 —— 没有「顶替人机」这一说
    expect(seats[0]!.bots).toBe(0);
  });

  it('大乱斗满员 → 不可选，且照实说', () => {
    const many = Array.from({ length: FFA.MAX_PLAYERS }, (_, i) =>
      player({ id: `f${i}`, team: 'red' }));
    const seat = midJoinSeats(many, { mode: GameMode.Ffa, teamSize: 0 })[0]!;
    expect(seat.selectable).toBe(false);
    expect(seat.hint).toContain('满员');
  });
});

describe('W24 顶替人机之后的职业文案（界面不许承诺一个不会到来的回合）', () => {
  const warriorName = getClass('warrior' as never)!.name;
  const priestName = getClass('priest' as never)!.name;

  it('★★ 竞技场：说「本局沿用」，绝不说「下回合」—— 那个回合不会到来', () => {
    const t = midJoinClassNotice('priest', 'warrior', 'arena')!;
    expect(t).toContain(warriorName);
    expect(t).toContain(priestName);
    expect(t).toContain('本局');
    expect(t).not.toContain('下回合');
    expect(t).not.toContain('下一回合');
  });

  it('★★ 夺旗有复活波次 → 说「下一次复活后生效」', () => {
    const t = midJoinClassNotice('priest', 'warrior', 'ctf')!;
    expect(t).toContain('复活');
  });

  it('★ 大乱斗一个字都不说 —— 那条路是新建实体，职业当场生效', () => {
    expect(midJoinClassNotice('priest', 'warrior', 'ffa')).toBeNull();
  });

  it('选的就是当场生效的那个（坐空席位 / 没顶替）→ 不说话', () => {
    expect(midJoinClassNotice('warrior', 'warrior', 'arena')).toBeNull();
  });

  it('不是中途加入（没有请求过职业）→ 不说话', () => {
    expect(midJoinClassNotice(undefined, 'warrior', 'arena')).toBeNull();
    expect(midJoinClassNotice('warrior', undefined, 'arena')).toBeNull();
  });

  /**
   * ★★ 事前提示与事后提示是同一件事的两个时刻 —— 竞技场那一支必须
   *   说同一句话，否则玩家会在选之前被告知「下回合生效」、进场之后
   *   才知道没有下回合。
   */
  it('★★ 事前的席位提示与事后的通知在竞技场上口径一致（都不承诺下回合）', () => {
    const before = midJoinTakeoverHint('arena')!;
    expect(before).toContain('本局');
    expect(before).not.toContain('下回合');
    expect(midJoinTakeoverHint('ctf')!).toContain('复活');
    expect(midJoinTakeoverHint('ffa')).toBeNull();
  });
});

// ── 接线锁（本仓库最常见的缺陷家族：写完了没人接线）────────────────

/**
 * ★★ 下面几条锁的是**源码里那一行还在不在**。理由很具体：观战席这条路
 *   跑在浏览器里（本仓库没有 jsdom），它的三条硬要求 —— 不预测、不发
 *   `Input`、镜头不分叉 —— 在单测里够不着，而它们退化之后的表现全都是
 *   「画面有点怪」而不是任何一条断言变红。
 */
// ⚠️ 换行统一成 \n —— 工作副本在 Windows 上是 CRLF，按 `\n  }\n` 切函数体
//    会一个都切不到（切出整个文件尾巴，然后断言以「错误的理由」通过）
const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const NET_SCENE_SRC = readSrc('../scenes/NetworkScene.ts');
const COMBAT_HUD_SRC = readSrc('../hud/CombatHud.ts');

/** 取某个方法的源码体（从签名到同缩进的收尾大括号）*/
const bodyOf = (src: string, signature: string): string => {
  const at = src.indexOf(signature);
  expect(at, `源码里找不到 ${signature} —— 接线被删或改名了`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n  }\n', at);
  return src.slice(at, end);
};

describe('W24 接线锁', () => {
  it('★★ 场景真的消费了 `MatchStart.spectating`（不接就是一整批功能不可达）', () => {
    expect(NET_SCENE_SRC).toContain('msg.spectating === true');
  });

  /**
   * ★★ 观战席发出任何一条需要身体的消息，都会换来一串阶段拒绝（20Hz 刷屏）。
   *   所以这条分支是**白名单**：它里面出现下列任何一个词都说明有人顺手
   *   把战斗消息放了进来。
   */
  it('★★ 观战输入分支里没有任何需要身体的消息', () => {
    const body = bodyOf(NET_SCENE_SRC, 'private readSpectateInput(');
    for (const forbidden of [
      "t: 'Input'", 'CastRequest', 'SetTarget', 'sendCast', 'InteractStart',
      'UseTrinket', 'SwapWeapon', 'UseConsumable', 'predictor',
    ]) {
      expect(body, `观战输入分支里出现了 ${forbidden}`).not.toContain(forbidden);
    }
    // 反向：V 换视角这一条**必须**在（那是观战席唯一的操作）
    expect(body).toContain('SpectateFollow');
  });

  it('★★ 观战席不发指令帧：simulate 里那道显式闸在任何上行之前', () => {
    const body = bodyOf(NET_SCENE_SRC, 'private simulate(');
    /**
     * ⚠️ A5 收口把这道闸从一行 `if (this.spectating) return;` 变成了一个块
     *   （观战席要顺带清掉转身账本的基准 —— 服务器那边观战席根本没有账本）。
     *   本条断言的意图**一字未改**：闸必须还在、必须 `return`、必须排在
     *   `simulate` 里任何一句上行之前。所以判据从「逐字包含那一行」换成
     *   「位置关系」，而不是把断言删掉。
     */
    const guard = body.indexOf('if (this.spectating)');
    expect(guard, '观战闸没了').toBeGreaterThanOrEqual(0);
    // 闸体里必须有 return（不是「进去做点事然后继续往下走」）
    expect(body.slice(guard, guard + 600)).toContain('return;');
    const send = body.indexOf('this.conn.send(');
    expect(send, '指令帧那句上行得还在，否则这条断言在空转').toBeGreaterThan(0);
    expect(guard, '观战闸排到了上行之后').toBeLessThan(send);
  });

  /**
   * ★★ G4 教训的可执行形式：镜头只有**一处**推。死亡观战与观战席各写一份
   *   的话，其中一份迟早会长出一个「自选坐标」的参数 —— 而那就是 11.4
   *   禁止的自由镜头（= 免费透视）。
   */
  it('★★ 全场只有一处 `cam.update(` —— 观战镜头不分叉', () => {
    const calls = NET_SCENE_SRC.match(/this\.cam\.update\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(bodyOf(NET_SCENE_SRC, 'private updateCamera(')).toContain('spectateCameraTarget()');
  });

  /**
   * ★★ 观战席落进死亡遮罩那段的话，第一句「找不到自己 → 清跟随目标」
   *   会把 `spectatingId` 每帧抹一次，镜头当场退回原点。
   */
  it('★★ renderDeathState 对观战席先返回', () => {
    const body = bodyOf(NET_SCENE_SRC, 'private renderDeathState(');
    const guard = body.indexOf('if (this.spectating)');
    // ⚠️ P10 把「按 id 找人」从线性 `lastEntities.find` 换成了索引
    //   `entityOf()`；本条断言的意图（那道闸必须在找自己**之前**）一字未改
    const findSelf = body.indexOf('this.entityOf(this.selfId');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(findSelf, '找自己那一句得还在，否则这条断言在空转').toBeGreaterThan(0);
    expect(guard).toBeLessThan(findSelf);
  });

  it('★★ HUD 观战面：技能栏/自身施法条/自身光环行三块都在同一道闸后面', () => {
    expect(COMBAT_HUD_SRC).toMatch(
      /if \(!this\.spectating\)[\s\S]{0,300}renderSelfAuras[\s\S]{0,300}renderPlayerCast[\s\S]{0,300}renderSkillBar/,
    );
  });
});
