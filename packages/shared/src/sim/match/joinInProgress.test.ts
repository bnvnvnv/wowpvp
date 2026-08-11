/**
 * W24 中途加入的**模拟侧**：新实体入场（`admitToMatch`）与延后换职业
 * （`respecCombatant`）。用户拍板 2026-08-10：「运行中房间可以观战，
 * 也可以中途加入（根据房间当前队伍情况…可以自己选择职业）」。
 *
 * ★ 名单侧的规则（谁能坐、坐哪儿）在 `room.test.ts` 的 W24 组；
 *   协议与阶段鉴权在服务器侧。这里只测**世界里真的多了一个能打的人**，
 *   以及换职业换得干净 —— 本仓库最常见的失败模式是「规则写对了、
 *   装配漏了一张表」，所以断言逐张表来。
 */

import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, getClass, warrior } from '../../data/index.js';
import { arena3v3 } from '../../data/maps/index.js';
import { ffaMap } from '../../data/maps/ffa.js';
import { ArenaPreset, DispelType, GameMode } from '../../types/enums.js';
import { asClassId, TEAM_BLUE, TEAM_RED } from '../../types/ids.js';
import { applyAura } from '../aura.js';
import { addWeapon } from '../loadout.js';
import { createEntity } from '../entity.js';
import { listEntities } from '../world.js';
import {
  Slot, createRoom, joinRoom, selectClass, selectSlot, setReady, startMatch, type Room,
} from './room.js';
import { admitToMatch, createMatch, respecCombatant } from './setup.js';

const config = (over: Partial<Room['config']> = {}) => ({
  mode: GameMode.Arena3v3,
  mapId: arena3v3.id,
  preset: ArenaPreset.Classic,
  roundsToWin: 1,
  allowUnbalanced: false,
  fillWithBots: false,
  ...over,
});

const roomWith = (
  members: readonly { id: string; slot: Slot; classId: string }[],
  over: Partial<Room['config']> = {},
): Room => {
  const room = createRoom('r1', members[0]?.id ?? 'host', config(over));
  for (const m of members) {
    joinRoom(room, m.id, m.id);
    selectSlot(room, m.id, m.slot);
    selectClass(room, m.id, asClassId(m.classId));
    setReady(room, m.id, true);
  }
  startMatch(room);
  return room;
};

// ════════════════════════════════════════════════════════════════
//  新实体入场
// ════════════════════════════════════════════════════════════════

describe('W24 admitToMatch：队伍还有空位 → 新实体入场', () => {
  it('★★ 五张表一张不漏：实体 / 装备栏 / 移动状态 / 统计行 / 双向映射', () => {
    const room = roomWith([
      { id: 'a', slot: Slot.Red, classId: 'warrior' },
      { id: 'b', slot: Slot.Blue, classId: 'mage' },
    ]);
    const m = createMatch(room, arena3v3);
    const before = listEntities(m.world).length;

    const r = admitToMatch(m, {
      playerId: 'late', name: '迟到的人', classId: asClassId('priest'), slot: Slot.Blue,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(listEntities(m.world).length).toBe(before + 1);
    const e = m.world.entities.get(r.entityId)!;
    expect(e.team).toBe(TEAM_BLUE);
    expect(e.classId as string).toBe('priest');
    expect(e.name).toBe('迟到的人');
    // ★★ 漏 movement 的那个人「动不了且不报错」—— 逐张表钉住
    expect(m.movement.has(e.id)).toBe(true);
    expect(m.loadouts.has(e.id)).toBe(true);
    expect(m.stats.players.get(e.id)?.classId as string).toBe('priest');
    expect(m.entityOf.get('late')).toBe(e.id);
    expect(m.playerOf.get(e.id)).toBe('late');
  });

  it('★ 出生点落在该队的准备室里（不是原点）', () => {
    const room = roomWith([
      { id: 'a', slot: Slot.Red, classId: 'warrior' },
      { id: 'b', slot: Slot.Blue, classId: 'mage' },
    ]);
    const m = createMatch(room, arena3v3);
    const r = admitToMatch(m, {
      playerId: 'late', name: '迟到的人', classId: asClassId('priest'), slot: Slot.Red,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pos = m.world.entities.get(r.entityId)!.position;
    const spawns = (arena3v3.prepRooms ?? [])
      .filter((p) => p.team === TEAM_RED)
      .flatMap((p) => p.spawns);
    expect(spawns.some((s) => s.position.x === pos.x && s.position.z === pos.z)).toBe(true);
  });

  /**
   * ★★ 竞技场靠「一方全灭」判负（2.1 / 验收 #26）。给刚被清台的队伍补一个
   *   满血的人 = 让已经进入结算窗口的回合活过来 —— 那不是中途加入，是免费续命。
   */
  it('★★ 已全灭的队伍不能被中途加入续命', () => {
    const room = roomWith([
      { id: 'a', slot: Slot.Red, classId: 'warrior' },
      { id: 'b', slot: Slot.Blue, classId: 'mage' },
    ]);
    const m = createMatch(room, arena3v3);
    for (const e of listEntities(m.world)) if (e.team === TEAM_BLUE) e.alive = false;

    const r = admitToMatch(m, {
      playerId: 'late', name: '迟到的人', classId: asClassId('priest'), slot: Slot.Blue,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('全灭');
    // 世界一个字节都没动
    expect(m.entityOf.has('late')).toBe(false);
  });

  it('★ 职业非法 / 重复入场：诚实拒绝且不改世界', () => {
    const room = roomWith([
      { id: 'a', slot: Slot.Red, classId: 'warrior' },
      { id: 'b', slot: Slot.Blue, classId: 'mage' },
    ]);
    const m = createMatch(room, arena3v3);
    const n = listEntities(m.world).length;

    // BOSS 是注册表里玩家选不到的职业 —— 与 selectClass 同一条 isPlayableClass
    expect(admitToMatch(m, {
      playerId: 'late', name: 'x', classId: asClassId('boss'), slot: Slot.Red,
    }).ok).toBe(false);
    expect(admitToMatch(m, {
      playerId: 'a', name: 'x', classId: asClassId('priest'), slot: Slot.Red,
    }).ok).toBe(false);
    expect(listEntities(m.world).length).toBe(n);
  });
});

describe('W24 admitToMatch：大乱斗（FFA）', () => {
  const ffaRoom = () => roomWith(
    [{ id: 'a', slot: Slot.Red, classId: 'warrior' }, { id: 'b', slot: Slot.Red, classId: 'mage' }],
    { mode: GameMode.Ffa, mapId: ffaMap.id },
  );

  it('★★ 独立阵营：中途加入者与场上任何人都不同队（人人为敌的实现方式）', () => {
    const m = createMatch(ffaRoom(), ffaMap);
    const teams = [...m.playerOf.keys()].map((id) => m.world.entities.get(id)!.team);
    const r = admitToMatch(m, {
      playerId: 'late', name: '迟到的人', classId: asClassId('priest'), slot: Slot.Red,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(teams).not.toContain(r.team);
  });

  /**
   * ★★ 新队号必须登记复活出口，否则他一死就在 (0,0,0) 复活 ——
   *   `nextExitFor` 查不到队号返回零向量，而零向量在任何一张图上都不报错。
   */
  it('★★ 新队号登记了复活出口（不然死一次就掉回原点）', () => {
    const m = createMatch(ffaRoom(), ffaMap);
    const r = admitToMatch(m, {
      playerId: 'late', name: '迟到的人', classId: asClassId('priest'), slot: Slot.Red,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(m.respawn?.exits.get(r.team as number)?.length ?? 0).toBeGreaterThan(0);
  });

  it('★ 满员（100 参战）诚实拒绝', () => {
    const m = createMatch(ffaRoom(), ffaMap);
    // 直接把世界填到上限 —— 白盒地布置，黑盒地断言
    let n = 2;
    while (n < 100) {
      const ok = admitToMatch(m, {
        playerId: `f${n}`, name: `f${n}`, classId: asClassId('warrior'), slot: Slot.Red,
      });
      expect(ok.ok).toBe(true);
      n++;
    }
    const r = admitToMatch(m, {
      playerId: 'overflow', name: 'x', classId: asClassId('warrior'), slot: Slot.Red,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('满员');
  });
});

// ════════════════════════════════════════════════════════════════
//  延后换职业
// ════════════════════════════════════════════════════════════════

describe('W24 respecCombatant：顶替人机后「下一次复活起换成自己选的」', () => {
  const rig = () => {
    const room = roomWith([
      { id: 'a', slot: Slot.Red, classId: 'warrior' },
      { id: 'b', slot: Slot.Blue, classId: 'mage' },
    ]);
    const m = createMatch(room, arena3v3);
    return { m, e: m.world.entities.get(m.entityOf.get('a')!)! };
  };

  /**
   * ★★ **逐字段与一个全新实体比对** —— 漏抄一项（比如 `resourceRegen`）
   *   不会有任何断言变红，只会让他顶着旧职业的回复速率打完整场。
   */
  it('★★ 换完之后与「新建一个该职业的实体」逐字段相同（不动 id/位置/队伍/名字）', () => {
    const { m, e } = rig();
    const id = e.id;
    const name = e.name;
    const pos = { ...e.position };

    respecCombatant(m, e, getClass(asClassId('priest'))!);

    const fresh = createEntity(id, getClass(asClassId('priest'))!, TEAM_RED, pos, { name });
    for (const key of Object.keys(fresh) as (keyof typeof fresh)[]) {
      // rng 刻意保留（按实体分流的随机流），其余全部对齐
      if (key === 'rng') continue;
      expect(JSON.stringify([key, serialize(e[key])]))
        .toEqual(JSON.stringify([key, serialize(fresh[key])]));
    }
    expect(e.id).toBe(id);
    expect(e.name).toBe(name);
    expect(e.team).toBe(TEAM_RED);
  });

  it('★ 装备栏换成新职业的默认套（上一个职业的备用武器留着没有意义）', () => {
    const { m, e } = rig();
    addWeapon(m.loadouts.get(e.id)!, warrior.weapons.find((w) => !w.isDefault)!.id);
    respecCombatant(m, e, getClass(asClassId('priest'))!);
    const l = m.loadouts.get(e.id)!;
    expect(l.spareWeapons).toHaveLength(0);
    expect(l.defaultWeaponId).toBe(getClass(asClassId('priest'))!.defaultWeaponId);
  });

  /**
   * ★ 光环不清的话，一个法师会顶着熊形态的生命上限跑：
   *   `applyMaxHealthMultiplier` 每 tick 从光环重算，它不认识「这人已经
   *   不是德鲁伊了」。
   */
  it('★★ 旧职业的光环清干净', () => {
    const { m, e } = rig();
    applyAura(m.auras, e, {
      id: 'test.buff', name: '测试', kind: 'buff', duration: 999,
      dispelType: DispelType.Magic, modifiers: { maxHealth: 1.2 },
      description: '测试用：生命上限 +20%',
    }, e.id, 0);
    expect(m.auras.get(e.id)?.length ?? 0).toBeGreaterThan(0);
    respecCombatant(m, e, getClass(asClassId('priest'))!);
    expect(m.auras.get(e.id)?.length ?? 0).toBe(0);
  });

  /**
   * ★ 统计行**保留累计值**（统计按实体记，而实体没换），只更新职业与名字 ——
   *   否则战后面板会用旧职业解释他整场的表现。如实记在 docs/15 W24 行。
   */
  it('★ 统计行：职业更新、累计值保留', () => {
    const { m, e } = rig();
    const row = m.stats.players.get(e.id)!;
    row.general.damageDone = 1234;
    e.name = '真人甲';
    respecCombatant(m, e, getClass(asClassId('priest'))!);
    expect(row.classId as string).toBe('priest');
    expect(row.name).toBe('真人甲');
    expect(row.general.damageDone).toBe(1234);
  });

  it('★ 八个职业逐个换一遍都不炸（数据驱动，不写死职业名）', () => {
    for (const cls of ALL_CLASSES) {
      const { m, e } = rig();
      respecCombatant(m, e, cls);
      expect(e.classId).toBe(cls.id);
      expect(e.health).toBe(cls.baseHealth);
      expect(e.availableSkills.size).toBeGreaterThan(0);
    }
  });
});

/** Map/Set 不进 JSON —— 比对前摊平成可比较的形状 */
const serialize = (v: unknown): unknown => {
  if (v instanceof Map) return [...v.entries()].sort();
  if (v instanceof Set) return [...v].sort();
  return v;
};
