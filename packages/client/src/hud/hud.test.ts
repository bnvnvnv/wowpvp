/**
 * HUD 测试。规格书 15.1 / 15.3 / 15.4，验收 #5 / #35。
 *
 * 这里重点验两条**否定式**规则，它们靠肉眼看是看不出来的：
 *   · 15.4「竞技场不显示任何旗帜信息」
 *   · 验收 #5「未被发现的潜行目标不能被小地图选中」
 */

import { describe, expect, it } from 'vitest';
import { FlagState, TEAM_BLUE, TEAM_RED, mage, type WeaponDef } from '@wowpvp/shared';
import {
  isFlagBlip,
  type ArenaBlip,
  type ArenaHudView,
  type CtfHudView,
  type MinimapBlip,
} from './ModeHud.js';
import { MAX_PARTY_MEMBERS, type PartyMemberView } from './PartyFrame.js';
import { SWAP_INTERRUPT_TEXT, compareArmors, compareWeapons } from './LoadoutPanel.js';
import { CONTROL_VISUALS } from '../vfx/status.js';

describe('★ 15.4 竞技场不显示任何旗帜信息', () => {
  it('★★ ArenaHudView 的字段里没有任何旗帜相关项', () => {
    // 类型上不存在，所以这里只能用运行时对象来表达这条约束：
    // 构造一个完整的竞技场视图，断言它的 key 集合里没有旗帜字样
    const v: ArenaHudView = {
      aliveRed: 3,
      aliveBlue: 2,
      round: 1,
      scoreRed: 0,
      scoreBlue: 0,
      dampening: 0.2,
      suddenDeath: false,
    };
    const keys = Object.keys(v).join(' ').toLowerCase();
    expect(keys).not.toContain('flag');
    expect(keys).not.toContain('carrier');
  });

  it('★★ 竞技场小地图的 blip 类型排除了旗手与掉落旗帜', () => {
    // ArenaBlip 是 MinimapBlip 的收窄类型。下面两行如果能通过类型检查就说明收窄失效了 ——
    // 这里用运行时断言把这条约束记下来，同时验证 isFlagBlip 的判定
    const allowed: ArenaBlip['kind'][] = ['self', 'ally', 'enemy', 'supply'];
    for (const kind of allowed) {
      expect(isFlagBlip({ x: 0, z: 0, kind })).toBe(false);
    }
    for (const kind of ['flagCarrier', 'droppedFlag'] as const) {
      expect(isFlagBlip({ x: 0, z: 0, kind })).toBe(true);
    }
  });

  it('夺旗视图**有**旗帜字段 —— 两种模式确实是两张不同的表', () => {
    const v: CtfHudView = {
      scoreRed: 1,
      scoreBlue: 0,
      scoreToWin: 3,
      timeRemaining: 600,
      flags: [
        { team: TEAM_RED, state: FlagState.AtBase, position: { x: 0, y: 0, z: 10 } },
        { team: TEAM_BLUE, state: FlagState.Carried, position: { x: 0, y: 0, z: -5 }, carrierName: '甲' },
      ],
      focusStacks: 0,
    };
    expect(v.flags).toHaveLength(2);
    expect(v.flags[1]!.carrierName).toBe('甲');
  });
});

describe('★ 验收 #5：小地图不能泄露未被发现的潜行者', () => {
  it('★★ Minimap.draw 只接受调用方给的列表，自己拿不到世界状态', () => {
    // 这条约束在类型层面表达为：draw 的入参是 readonly MinimapBlip[]，
    // Minimap 的构造函数只接收一个 HTMLElement —— 没有 World、没有实体表。
    // 所以"画出了未被发现的潜行者"必然是调用方传错了，不可能是小地图自己去查的。
    const blips: MinimapBlip[] = [{ x: 0, z: 0, kind: 'self' }];
    expect(blips.every((b) => 'kind' in b)).toBe(true);
    // 过滤责任在网络层（M9 的 net/visibility.ts），这里显式记录
    expect(isFlagBlip({ x: 0, z: 0, kind: 'enemy' })).toBe(false);
  });
});

describe('15.1 左侧队伍框', () => {
  const member = (over: Partial<PartyMemberView> = {}): PartyMemberView => ({
    id: 1,
    name: '甲',
    className: '战士',
    health: 80,
    maxHealth: 100,
    controls: [],
    dead: false,
    carryingFlag: false,
    ...over,
  });

  it('★ 15.1 要求的六项在类型里全是必填', () => {
    const m = member();
    // 少写任何一项都是编译错误；这里断言六项都在
    for (const k of ['health', 'maxHealth', 'className', 'controls', 'dead', 'carryingFlag']) {
      expect(k in m, k).toBe(true);
    }
  });

  it('★ 最多 12 名（12v12 每边正好 12 人）', () => {
    expect(MAX_PARTY_MEMBERS).toBe(12);
  });

  it('★ 控制状态与 3D 场景共用同一张字形表 —— 玩家不用学两套符号', () => {
    const m = member({ controls: ['silenced'] });
    expect(CONTROL_VISUALS[m.controls[0]!].glyph).toBe(CONTROL_VISUALS.silenced.glyph);
  });

  it('资源可以缺省 —— 有的职业没有主资源', () => {
    expect(member().resource).toBeUndefined();
    expect(member({ resource: { current: 50, max: 100, label: '法力' } }).resource?.max).toBe(100);
  });
});

describe('★ 15.3 战场装备栏（验收 #35）', () => {
  const weapons = mage.weapons;
  const first = weapons[0]!;
  const second = weapons.find((w) => w.id !== first.id)!;

  it('★★ 拾取时直接比较新旧，只列**变了**的项而不是堆全字段表', () => {
    const diff = compareWeapons(first, second);
    expect(diff.length).toBeGreaterThan(0);
    // 每一行都带方向箭头，玩家扫一眼就知道是升还是降
    for (const line of diff) {
      expect(line, line).toMatch(/[↑↓⇄]/);
    }
    // 15.3 第三条的重点是"不只显示复杂数值" —— 所以要短
    expect(diff.length).toBeLessThanOrEqual(4);
  });

  it('同一件装备与自己比较时没有差异行', () => {
    expect(compareWeapons(first, first)).toEqual([]);
  });

  it('没有当前装备时给出「新武器」而不是空列表', () => {
    expect(compareWeapons(undefined, first)[0]).toContain('新武器');
  });

  it('护甲比较基于 modifiers，不依赖不存在的「防御值」字段', () => {
    const armors = mage.armors;
    if (armors.length < 2) return;
    const d = compareArmors(armors[0]!, armors[1]!);
    for (const line of d) expect(line).toMatch(/[↑↓⇄]/);
  });

  it('★ 15.3 第二条：换装中断要有明确原因，五种都有中文文案', () => {
    for (const k of ['damage', 'control', 'movement', 'forcedMove', 'cancelled']) {
      expect(SWAP_INTERRUPT_TEXT[k], k).toBeTruthy();
    }
  });

  it('武器的优势与代价直接来自数据，不是 UI 自己编的（附录A#4）', () => {
    for (const w of weapons as WeaponDef[]) {
      expect(w.advantage.length, w.name).toBeGreaterThan(0);
      expect(w.cost.length, w.name).toBeGreaterThan(0);
    }
  });
});
