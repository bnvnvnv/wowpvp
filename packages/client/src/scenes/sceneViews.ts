/**
 * 场景喂给表现层的几笔**投影**。
 *
 * ★★ 它们放在一起的理由只有一条，而且是同一条：这三段逻辑此前全都内联在
 *   两千行的场景类里，而场景类需要 WebGL 才能构造 —— 于是没有任何单测
 *   够得着它们。本仓库最反复出现的缺陷家族（「写完了没人接线」）恰恰
 *   长在这种地方：数据齐了、控件齐了，中间那一跳漏了，全绿。
 *
 * ★ 三笔投影各自服务一个消费方：
 *   · `ctfHudViewFromMatch`  → `ModeHud.renderCtf`（A17 的比赛时钟）
 *   · `queueExpiredFlash`    → `CombatHud.flashQueueExpired`（X21 的回执）
 *   · `factionRingViewsOf`   → `FactionRings.update`（X14 的脚下阵营标记）
 *
 * ⚠️ 这里**不许**出现任何 three.js / DOM 引用 —— 它们能被测试的前提就是纯。
 */

import { GEOMETRY, type FlagView, type SkillId, type Vec3 } from '@wowpvp/shared';

import type { CtfHudView } from '../hud/ModeHud.js';
import type { FactionRingView } from '../vfx/FactionRing.js';

// ── A17：夺旗 HUD 视图 ───────────────────────────────────────────

/** 投影要读的那几个 `MatchSnapshot` 字段。★ 收窄到真读的，理由同 `CombatView` */
export interface CtfMatchSource {
  score?: Readonly<Record<string, number>>;
  scoreToWin?: number;
  focusStacks?: number;
  respawnIn?: number;
  /** A17：剩余比赛时间。★ 不限时的一局服务器不发，那时整行不画 */
  timeRemaining?: number;
  /** A17：已进入加时（此时 `timeRemaining` 是距硬上限的秒数）*/
  overtime?: boolean;
}

/**
 * 快照的 `match` 块 → 夺旗 HUD 视图。
 *
 * ★★ A17 的收尾就在 `timeRemaining` / `overtime` 这两行上。
 *   在此之前这里有一段注释写着「刻意**不传** timeRemaining：sim 里没有
 *   夺旗时限」—— 那句话在 Wave1-D 之后就过期了（sim + 服务器 + 快照三层
 *   都通了），而**注释本身没有过期机制**：它会一直劝阻下一个来接线的人。
 *   所以那段注释连同判断一起删掉，换成这里的透传。
 *
 * ★ 两个字段都**只在服务器真的下发时才带**：不限时的一局（`CTF.DURATION`
 *   查不到 → 0 → 服务器不发）仍然整行不画，W12 的口径一字未改。
 */
export const ctfHudViewFromMatch = (
  m: CtfMatchSource,
  flags: readonly FlagView[],
  teams: { red: number; blue: number },
): CtfHudView => {
  const score = m.score ?? {};
  return {
    scoreRed: score[String(teams.red)] ?? 0,
    scoreBlue: score[String(teams.blue)] ?? 0,
    scoreToWin: m.scoreToWin ?? 0,
    flags,
    focusStacks: m.focusStacks ?? 0,
    ...(m.respawnIn !== undefined ? { respawnIn: m.respawnIn } : {}),
    ...(m.timeRemaining !== undefined ? { timeRemaining: m.timeRemaining } : {}),
    ...(m.overtime !== undefined ? { overtime: m.overtime } : {}),
  };
};

// ── X21：排队窗过期的技能栏回执 ──────────────────────────────────

/** `CombatHud.flashQueueExpired` 那一面。★ 收窄成接口，投影不认识整个 HUD */
export interface QueueExpiredSink {
  flashQueueExpired(skillId: string, waited: number): void;
}

/**
 * 一条「刚才那一下没赶上」→ 技能栏上闪哪一格。
 *
 * ★★ 存在的理由是 `skillId` 的**形态**：协议里它是 `SkillId`（带牌的字符串），
 *   而 HUD 内部拿 `String(slot.skill.id)` 比对。两边不转换就永远匹配不上，
 *   而那种失配是**静默**的 —— 闪不出来和「没人接线」长得一模一样。
 * ★ `waited` 钳到非负：sim 侧它恒为正（≈0.4），钳一下是为了让 HUD 的
 *   「没赶上 0.4s」文案在任何输入下都是一句人话。
 */
export const queueExpiredFlash = (
  msg: { skillId: SkillId | string; waited: number },
  hud: QueueExpiredSink,
): void => {
  hud.flashQueueExpired(String(msg.skillId), Math.max(0, msg.waited));
};

// ── X14：全体脚下阵营标记的名单 ─────────────────────────────────

/** 投影要读的实体字段。两个场景（快照实体 / `CombatEntity`）都满足它 */
export interface FactionRingSource {
  id: number;
  team: number;
  alive: boolean;
  position: Vec3;
  /** 角色身高，米。省略 = 标准碰撞盒（变形/巨化才需要给）*/
  height?: number;
}

export interface FactionRingOptions {
  /** 自己的实体 id。看不到自己（还没进场）时 undefined */
  selfId?: number;
  /** 自己的队伍。undefined 时全场按敌对画（开局前的保守口径）*/
  selfTeam?: number;
  /** 第一人称视角：自己的标记要收掉，否则脚下那圈会糊在镜头里 */
  firstPerson?: boolean;
  /** 渲染中的位置（插值/预测后）。查不到回落到快照位置 */
  positionOf?: (id: number) => Vec3 | undefined;
}

/**
 * 场上实体 → 阵营标记名单。
 *
 * ★★ `hidden` 的判定**必须**在这里做而不是在 `FactionRings` 里：那个类
 *   读不到死亡/潜行/第一人称，硬猜只会猜错。而漏判的后果比不画更糟 ——
 *   「人看不见但脚下有环」等于给对手报点。
 *
 * ★ 潜行**不需要**在这里判：两个场景喂进来的名单本身就已经过滤过了
 *   （联网侧不可见的实体压根不进快照 —— 验收 #5；试验场走
 *   `visibleEntities()` 的 `isSelectableBy`）。在这里再判一次等于把
 *   侦测规则抄第三份。
 *
 * ★★ 阵营口径是「**和我同队才是友方**」，所以大乱斗（人手一个队号）
 *   自然全场敌色、BOSS（`TEAM_NEUTRAL`）也自然是敌色 —— 不需要为它们
 *   写任何分支。自己永远与自己同队，于是自己是友色。
 */
export const factionRingViewsOf = (
  units: readonly FactionRingSource[],
  opts: FactionRingOptions = {},
): FactionRingView[] =>
  units.map((u) => {
    const isSelf = opts.selfId !== undefined && u.id === opts.selfId;
    const hidden = !u.alive || (isSelf && opts.firstPerson === true);
    return {
      id: u.id,
      position: opts.positionOf?.(u.id) ?? u.position,
      faction: opts.selfTeam !== undefined && u.team === opts.selfTeam ? 'friendly' : 'hostile',
      height: u.height ?? GEOMETRY.HITBOX_HEIGHT,
      ...(hidden ? { hidden: true } : {}),
    };
  });
