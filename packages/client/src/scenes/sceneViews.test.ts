/**
 * 场景投影三件套（A17 夺旗时钟 / X21 排队回执 / X14 阵营标记名单）。
 *
 * ★ 这一支钉的全是**中间那一跳**：数据在快照里、控件在 HUD/VFX 里，
 *   而两头之间的转换此前内联在需要 WebGL 才能构造的场景类里 ——
 *   于是「接没接上」在整个仓库里没有任何可执行证据。
 */

import { describe, expect, it, vi } from 'vitest';
import { GEOMETRY, TEAM_BLUE, TEAM_NEUTRAL, TEAM_RED, asSkillId } from '@wowpvp/shared';

import {
  ctfHudViewFromMatch,
  factionRingViewsOf,
  queueExpiredFlash,
  type FactionRingSource,
} from './sceneViews.js';

const TEAMS = { red: TEAM_RED as number, blue: TEAM_BLUE as number };

// ════════════════════════════════════════════════════════════════
//  A17：夺旗 HUD 的比赛时钟
// ════════════════════════════════════════════════════════════════

describe('ctfHudViewFromMatch', () => {
  it('★★ A17：timeRemaining / overtime 透传到 HUD（这就是那条断了的线）', () => {
    const v = ctfHudViewFromMatch({ timeRemaining: 42.5, overtime: true }, [], TEAMS);
    expect(v.timeRemaining).toBe(42.5);
    expect(v.overtime).toBe(true);
  });

  it('★ 不限时的一局：服务器不发 → 仍然整行不画（W12 口径没变）', () => {
    const v = ctfHudViewFromMatch({}, [], TEAMS);
    expect(v).not.toHaveProperty('timeRemaining');
    expect(v).not.toHaveProperty('overtime');
  });

  it('比分按队号取，缺席算 0（快照只发非零项）', () => {
    const v = ctfHudViewFromMatch(
      { score: { [String(TEAM_RED as number)]: 2 }, scoreToWin: 3 },
      [], TEAMS,
    );
    expect(v.scoreRed).toBe(2);
    expect(v.scoreBlue).toBe(0);
    expect(v.scoreToWin).toBe(3);
  });

  it('respawnIn 只在服务器给了才带（12.6 的波次钟）', () => {
    expect(ctfHudViewFromMatch({}, [], TEAMS)).not.toHaveProperty('respawnIn');
    expect(ctfHudViewFromMatch({ respawnIn: 7 }, [], TEAMS).respawnIn).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════════
//  X21：排队窗过期的技能栏回执
// ════════════════════════════════════════════════════════════════

describe('queueExpiredFlash', () => {
  it('★★ skillId 转成字符串 —— HUD 内部用 String(skill.id) 比对，不转就永远闪不出来', () => {
    const hud = { flashQueueExpired: vi.fn() };
    queueExpiredFlash({ skillId: asSkillId('mage.frostbolt'), waited: 0.42 }, hud);
    expect(hud.flashQueueExpired).toHaveBeenCalledWith('mage.frostbolt', 0.42);
  });

  it('waited 钳到非负（文案在任何输入下都得是一句人话）', () => {
    const hud = { flashQueueExpired: vi.fn() };
    queueExpiredFlash({ skillId: 'x.y', waited: -1 }, hud);
    expect(hud.flashQueueExpired).toHaveBeenCalledWith('x.y', 0);
  });
});

// ════════════════════════════════════════════════════════════════
//  X14：全体脚下阵营标记
// ════════════════════════════════════════════════════════════════

const unit = (over: Partial<FactionRingSource> = {}): FactionRingSource => ({
  id: 1,
  team: TEAM_RED as number,
  alive: true,
  position: { x: 1, y: 0, z: 2 },
  ...over,
});

describe('factionRingViewsOf', () => {
  it('同队 = 友方，别的一律敌方', () => {
    const views = factionRingViewsOf(
      [unit({ id: 1, team: TEAM_RED as number }), unit({ id: 2, team: TEAM_BLUE as number })],
      { selfTeam: TEAM_RED as number },
    );
    expect(views[0]?.faction).toBe('friendly');
    expect(views[1]?.faction).toBe('hostile');
  });

  it('★★ 大乱斗：人手一个队号 → 除自己外全场敌色，不需要任何分支', () => {
    const views = factionRingViewsOf(
      [unit({ id: 1, team: 7 }), unit({ id: 2, team: 8 }), unit({ id: 3, team: 9 })],
      { selfId: 1, selfTeam: 7 },
    );
    expect(views.map((v) => v.faction)).toEqual(['friendly', 'hostile', 'hostile']);
  });

  it('★ BOSS 是 TEAM_NEUTRAL → 敌色（同一条口径覆盖，不写第二个分支）', () => {
    const views = factionRingViewsOf([unit({ team: TEAM_NEUTRAL as number })], {
      selfTeam: TEAM_RED as number,
    });
    expect(views[0]?.faction).toBe('hostile');
  });

  it('★★ 死人不画 —— 但条目保留，复活时不必重建', () => {
    const views = factionRingViewsOf([unit({ alive: false })], { selfTeam: TEAM_RED as number });
    expect(views).toHaveLength(1);
    expect(views[0]?.hidden).toBe(true);
  });

  it('★ 第一人称下收掉**自己**的那一个，别人的不受影响', () => {
    const views = factionRingViewsOf([unit({ id: 1 }), unit({ id: 2 })], {
      selfId: 1, selfTeam: TEAM_RED as number, firstPerson: true,
    });
    expect(views[0]?.hidden).toBe(true);
    expect(views[1]?.hidden).toBeUndefined();
  });

  it('第三人称下自己照常画', () => {
    const views = factionRingViewsOf([unit({ id: 1 })], {
      selfId: 1, selfTeam: TEAM_RED as number, firstPerson: false,
    });
    expect(views[0]?.hidden).toBeUndefined();
  });

  it('★★ 位置取**渲染中**的那一份（20Hz 的快照位置会让环跳、人却是平滑的）', () => {
    const views = factionRingViewsOf([unit({ id: 5, position: { x: 0, y: 0, z: 0 } })], {
      positionOf: (id) => (id === 5 ? { x: 9, y: 0, z: 9 } : undefined),
    });
    expect(views[0]?.position).toEqual({ x: 9, y: 0, z: 9 });
  });

  it('渲染位置查不到就回落到快照位置（刚进场的那一帧）', () => {
    const views = factionRingViewsOf([unit({ id: 5 })], { positionOf: () => undefined });
    expect(views[0]?.position).toEqual({ x: 1, y: 0, z: 2 });
  });

  it('身高默认取标准碰撞盒（验收 #10：模型大小不改变它）', () => {
    expect(factionRingViewsOf([unit()])[0]?.height).toBe(GEOMETRY.HITBOX_HEIGHT);
    expect(factionRingViewsOf([unit({ height: 3.2 })])[0]?.height).toBe(3.2);
  });

  it('★ selfTeam 未知（开局前）时保守全按敌对 —— 不会把敌人画成友色', () => {
    const views = factionRingViewsOf([unit({ team: TEAM_RED as number })], {});
    expect(views[0]?.faction).toBe('hostile');
  });
});
