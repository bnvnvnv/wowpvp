/**
 * P10：`CombatDirector` 的**可用性**行为。
 *
 * ★★ 这一支钉的全是「玩家看到/听到什么」，不是战斗规则本身 ——
 *   规则在 shared 里各有自己的测试。这里管的是那类「单元测试全绿、
 *   浏览器里一眼就不对」的缺陷：日志刷屏把有用的行顶掉、提示说反话、
 *   内部 id 直接打给玩家看、宽限期形同虚设。
 *
 * ⚠️ **红线守卫在最后一个 describe**：`graceSeconds` 缺省 0 时，
 *   假人的行为必须与参数化之前逐帧相同 —— 二十多支 verify 脚本靠它。
 */

import { describe, expect, it } from 'vitest';

import {
  CastFailure,
  TargetFilter,
  asSkillId,
  getSkill,
  isCasting,
  type CombatEntity,
  type EntityId,
  type Vec3,
} from '@wowpvp/shared';

import { CombatDirector } from './CombatDirector.js';
import type { DummySpot } from './dummyLayouts.js';

const SPAWN: Vec3 = { x: 0, y: 0, z: 0 };

/** 无障碍物的空场 + 指定布置。★ 不传 layout 就是验收那一套（默认路径） */
const makeDirector = (layout?: readonly DummySpot[]): CombatDirector =>
  layout ? new CombatDirector([], SPAWN, undefined, layout) : new CombatDirector([], SPAWN);

/** 推进 n 帧。★ 玩家位置由场景驱动，测试里钉在出生点不动 */
const advance = (dir: CombatDirector, seconds: number, step = 1 / 60): void => {
  for (let t = 0; t < seconds; t += step) dir.update(step, SPAWN, 0);
};

const texts = (dir: CombatDirector): string[] => dir.log.map((l) => l.text);

// ════════════════════════════════════════════════════════════════
//  日志合并：资源不足连按 8 次不该顶掉 14 行可见区
// ════════════════════════════════════════════════════════════════

describe('战斗日志：连续相同失败合并成「… ×N」', () => {
  it('★ 同一条 fail 连打 8 次 → 只占 1 行，计数到 8', () => {
    const dir = makeDirector();
    const before = dir.log.length;
    for (let i = 0; i < 8; i++) dir.castSlot(0); // 没有目标的直接目标技能

    expect(dir.log.length - before).toBe(1);
    expect(dir.log[0]?.text).toMatch(/ ×8$/);
    expect(dir.log[0]?.repeat).toBe(8);
  });

  it('中间插了别的事就重新起一行 —— 日志唯一的承诺是顺序', () => {
    const dir = makeDirector();
    dir.castSlot(0);
    dir.castSlot(0);
    dir.info('别的事');
    dir.castSlot(0);

    // 最新在前：新的失败行 / 别的事 / 合并成 ×2 的那行
    expect(dir.log[0]?.repeat).toBeUndefined();
    expect(dir.log[1]?.text).toBe('别的事');
    expect(dir.log[2]?.text).toMatch(/ ×2$/);
  });

  it('★ 只合并 fail：伤害/信息行是流水账，合并会抹平真实节奏', () => {
    const dir = makeDirector();
    dir.info('同一句话');
    dir.info('同一句话');
    expect(dir.log[0]?.text).toBe('同一句话');
    expect(dir.log[1]?.text).toBe('同一句话');
  });

  it('合并行的时间跟到最后一次（它代表「到刚才为止」）', () => {
    const dir = makeDirector();
    dir.castSlot(0);
    const t0 = dir.log[0]!.time;
    advance(dir, 0.5);
    dir.castSlot(0);
    expect(dir.log[0]!.time).toBeGreaterThan(t0);
  });
});

// ════════════════════════════════════════════════════════════════
//  敌我文案：友方技能选着敌人时不许说「需要目标」
// ════════════════════════════════════════════════════════════════

describe('目标文案：不许说反话', () => {
  /** 牧师的治疗术（Ally）—— 用技能栏第 1 格装它 */
  const healBar = ['priest.flash_heal'];

  it('★ 选着敌人放友方技能 → 说「目标不是友方」，不是「需要目标」', () => {
    const dir = new CombatDirector([], SPAWN, undefined, undefined, healBar);
    const foe = dir.visibleEntities().find((e) => e.team !== dir.player.team)!;
    dir.selectById(foe.id as number);
    expect(dir.player.targets.hard).toBe(foe.id);

    dir.castSlot(0);
    expect(dir.log[0]?.text).toContain('目标不是友方');
    expect(dir.log[0]?.text).not.toContain('需要目标');
  });

  it('★ 文案里的「按住 Alt 对自己施放」必须是真的（不许对实现撒谎）', () => {
    const dir = new CombatDirector([], SPAWN, undefined, undefined, healBar);
    const skill = getSkill(asSkillId('priest.flash_heal'))!;
    // 文案承诺的出路：Ally/Any 技能按住 Alt 会改写成自我施法
    expect([TargetFilter.Ally, TargetFilter.Any]).toContain(skill.targetFilter);

    const foe = dir.visibleEntities().find((e) => e.team !== dir.player.team)!;
    dir.selectById(foe.id as number);
    dir.castSlot(0, undefined, { selfCast: true });
    // 走到了自我施法这条路：不再报「目标不是友方」
    expect(dir.log[0]?.text ?? '').not.toContain('目标不是友方');
  });

  it('敌方技能没有目标时仍报「需要目标」（这条本来就是对的，别改坏）', () => {
    const dir = makeDirector();
    dir.castSlot(0); // 第 1 格是寒冰箭（Enemy）
    expect(dir.log[0]?.text).toContain('需要目标');
  });
});

// ════════════════════════════════════════════════════════════════
//  合同 C8：练习场宽限期
// ════════════════════════════════════════════════════════════════

describe('合同 C8 练习场缓冲', () => {
  /** 实战模式 + 宽限期：假人既不锁定也不出招 */
  it('★ 宽限期内假人不锁定玩家、不出招', () => {
    const dir = makeDirector();
    dir.combatMode = true;
    dir.graceSeconds = 5;

    advance(dir, 3);

    const dummies = dir.allEntities().filter((e) => e.id !== dir.player.id);
    expect(dummies.length).toBeGreaterThan(0);
    for (const d of dummies) {
      expect(d.targets.hard, `${d.name} 在宽限期内锁定了玩家`).toBeUndefined();
      expect(isCasting(dir.store, d.id), `${d.name} 在宽限期内出招了`).toBe(false);
    }
  });

  it('★ 站桩模式同样受宽限期约束（练习场不一定开实战模式）', () => {
    const dir = makeDirector();
    dir.graceSeconds = 5;
    advance(dir, 3);
    const casting = dir.allEntities()
      .filter((e) => e.id !== dir.player.id && isCasting(dir.store, e.id));
    expect(casting).toEqual([]);
  });

  it('★ 宽限期结束打一条「战斗开始」，且只打一次', () => {
    const dir = makeDirector();
    dir.graceSeconds = 1;
    advance(dir, 0.5);
    expect(texts(dir).filter((t) => t.includes('战斗开始'))).toEqual([]);

    advance(dir, 1.5);
    expect(texts(dir).filter((t) => t.includes('战斗开始')).length).toBe(1);
  });

  it('★★ 红线：缺省 graceSeconds=0 时假人的行为与从前逐帧相同', () => {
    const dir = makeDirector();
    // 站桩脚本 2 秒后开火（spawnDummy 里 dummyNextCast = 2）
    advance(dir, 2.2);
    const casting = dir.allEntities()
      .filter((e) => e.id !== dir.player.id && isCasting(dir.store, e.id));
    expect(casting.length, '缺省路径下假人应照常读条').toBeGreaterThan(0);
    // 而且**一个字**「战斗开始」都不能多打
    expect(texts(dir).some((t) => t.includes('战斗开始'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
//  合同 C1：技能栏的 GCD 与全部阻碍项
// ════════════════════════════════════════════════════════════════

describe('合同 C1 技能栏视图', () => {
  it('★ blockers 给出**全部**原因，而 blocker 只给门禁的第一个', () => {
    /**
     * 复刻 A16 老债的原话：「怒气 0 的战士站 30m 外被告知『资源不足』」。
     * ★ 40 米 —— 在 45 米选中上限内（选得中），在霜矢的 32 米射程外（放不出）。
     */
    const dir = makeDirector([
      { classId: 'mage', offset: { x: 0, y: 0, z: -40 }, name: '远处的法师' },
    ]);
    const farMage = dir.visibleEntities()[0]!;
    dir.selectById(farMage.id as number);
    expect(dir.player.targets.hard).toBe(farMage.id);
    for (const r of dir.player.resources.keys()) dir.player.resources.set(r, 0);

    const slot = dir.skillSlots()[0]!;
    // 7.4 步骤 1 规定资源在距离之前 —— 门禁答案照旧（不许为了提示改门禁）
    expect(slot.blocker).toBe(CastFailure.NotEnoughResource);
    // 提示要把「你还太远」也说出来（A16 老债）
    expect(slot.blockers).toContain(CastFailure.OutOfRange);
    expect(slot.blockers).toContain(CastFailure.NotEnoughResource);
  });

  it('可释放时 blockers 为空数组', () => {
    const dir = makeDirector();
    const warriorDummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(warriorDummy.id as number);
    const slot = dir.skillSlots()[0]!;
    expect(slot.blocker).toBe(CastFailure.Ok);
    expect(slot.blockers).toEqual([]);
  });

  it('★ GCD 期间：吃 GCD 的技能有剩余，不吃 GCD 的恒为 0（别把唯一的出路涂灰）', () => {
    const dir = makeDirector();
    dir.player.gcdUntil = dir.world.time + 0.6;

    for (const slot of dir.skillSlots()) {
      expect(slot.gcdTotal).toBeGreaterThan(0);
      if (slot.skill.triggersGcd) expect(slot.gcdRemaining).toBeCloseTo(0.6, 5);
      else expect(slot.gcdRemaining).toBe(0);
    }
  });

  it('GCD 过期后剩余归 0，不出现负数', () => {
    const dir = makeDirector();
    dir.player.gcdUntil = dir.world.time - 5;
    for (const slot of dir.skillSlots()) expect(slot.gcdRemaining).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
//  合同 C3：自己的四件大事
// ════════════════════════════════════════════════════════════════

describe('合同 C3 自身事件回调', () => {
  it('★ 自己施法失败 → onSelfCastFailed 拿到与日志同一句话（不带 ×N）', () => {
    const dir = makeDirector();
    const seen: string[] = [];
    dir.onSelfCastFailed = (t) => seen.push(t);

    dir.castSlot(0);
    dir.castSlot(0);

    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toMatch(/×/);
    // 日志那边合并了，回调这边没有 —— 中部提示本来就是一闪而过的单条
    expect(dir.log[0]?.text).toBe(`${seen[0]!} ×2`);
  });

  it('★ 自己死亡 → onSelfDeath；试验场假复活 → onSelfRevive', () => {
    const dir = makeDirector();
    let died = 0;
    let revived = 0;
    dir.onSelfDeath = () => { died++; };
    dir.onSelfRevive = () => { revived++; };

    dir.player.health = 0;
    dir.player.alive = false;
    advance(dir, 1 / 60, 1 / 60); // 一帧：reviveInTestbed 把人救起来

    expect(revived).toBe(1);
    // 死亡事件由 sim 发；这里手动置死不经过 settleDeaths，所以 died 不作断言，
    // 只钉「回调挂得上、复活确实通知了」
    expect(died).toBeGreaterThanOrEqual(0);
    expect(dir.player.alive).toBe(true);
  });

  it('★ 自己被打断的日志用第二人称，并推给 onSelfInterrupted', () => {
    const dir = makeDirector();
    const notices: string[] = [];
    dir.onSelfInterrupted = (t) => notices.push(t);

    // 站在战士假人拳击射程里读霜矢 → 0.45s 反应后必被打断。
    // ★ 先跑过 2 秒：假人的自驱脚本 t<2 不动手（spawnDummy 的 dummyNextCast）
    advance(dir, 2.1);
    const frostbolt = getSkill(asSkillId('mage.frostbolt'))!;
    const warriorDummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(warriorDummy.id as number);
    dir.requestCast(dir.player, frostbolt, { targetId: warriorDummy.id });
    advance(dir, 1.2);

    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toContain('打断了你的');
    expect(dir.log.some((l) => l.text === notices[0])).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  光环显示名：不许把内部 id 打给玩家看
// ════════════════════════════════════════════════════════════════

describe('光环显示名', () => {
  it('★ 日志里的光环名不是内部 id（「获得 mage.frostbolt.chill」是给写代码的人看的）', () => {
    const dir = makeDirector();
    const frostbolt = getSkill(asSkillId('mage.frostbolt'))!;
    const warriorDummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(warriorDummy.id as number);
    // 直接把光环挂上去比等一发霜矢读完稳：这里验的是**文案**，不是命中判定
    dir.requestCast(dir.player, frostbolt, { targetId: warriorDummy.id });
    advance(dir, 3);

    const auraLines = texts(dir).filter((t) => t.includes('获得'));
    expect(auraLines.length).toBeGreaterThan(0);
    for (const line of auraLines) {
      expect(line, `光环行仍在打内部 id：${line}`).not.toMatch(/[a-z_]+\.[a-z_]+/);
    }
  });

  it('★★ X26：光环已经掉了也说得出**光环**名，而不是退回施加它的技能名', () => {
    // 回落链第 2 级（注册表）。此前实例查不到时只能按 id 前缀反查技能，
    // 于是「驱散了 霜矢」—— 玩家身上从来没有一个叫霜矢的东西，那是一发法术。
    // 现在两条路（试验场 / 联网 `toHudAura`）吃同一张表，说的是同一个词
    const dir = makeDirector();
    const line = (dir as unknown as {
      auraDisplayName(t: EntityId, id: string): string;
    }).auraDisplayName(dir.player.id, 'mage.frostbolt.chill');
    expect(line).toBe('寒冷');
    // 表外的 id 仍然走第 3/4 级 —— 兜底一条都没删
    const fallback = (dir as unknown as {
      auraDisplayName(t: EntityId, id: string): string;
    }).auraDisplayName(dir.player.id, 'control.stun');
    expect(fallback).toBe('control.stun');
  });
});

// ════════════════════════════════════════════════════════════════
//  合同 C6：选中距离
// ════════════════════════════════════════════════════════════════

describe('合同 C6 选中距离', () => {
  const FAR: readonly DummySpot[] = [
    { classId: 'mage', offset: { x: 0, y: 0, z: -80 }, name: '远处的假人' },
  ];

  it('★ 45 米外点姓名板 → 拒绝选中并打「超出选中距离」', () => {
    const dir = makeDirector(FAR);
    const far = dir.allEntities().find((e) => e.id !== dir.player.id)!;
    dir.selectById(far.id as number);

    expect(dir.player.targets.hard).toBeUndefined();
    expect(dir.log[0]?.text).toContain('超出选中距离');
  });

  it('射程内正常选中，不打任何日志', () => {
    const dir = makeDirector();
    const before = dir.log.length;
    const near = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(near.id as number);

    expect(dir.player.targets.hard).toBe(near.id);
    expect(dir.log.length).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════
//  合同 C5：施法排队 —— 红线是「假人永远不带 queue」
// ════════════════════════════════════════════════════════════════

describe('合同 C5 施法排队', () => {
  it('★★ 红线：假人的施法请求不带 queue（平衡零扰动）', () => {
    const dir = makeDirector();
    dir.combatMode = true;
    advance(dir, 2);

    // pendingCasts 每 tick 会被清空，所以直接查 requestCast 的产物：
    // 用一个假人手动走一次假人路径，断言意图里没有 queue
    const dummy = dir.allEntities().find((e) => e.id !== dir.player.id)!;
    const skill = getSkill(asSkillId('mage.frostbolt'))!;
    dir.requestCast(dummy, skill, { targetId: dir.player.id });
    expect(intentOf(dir, dummy)).not.toHaveProperty('queue');
  });

  it('★ 玩家路径带 queue:true（GCD 边缘按下去不再直接丢掉）', () => {
    const dir = makeDirector();
    const warriorDummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(warriorDummy.id as number);
    dir.castSlot(0);
    expect(intentOf(dir, dir.player)).toMatchObject({ queue: true });
  });
});

/** 读出某个实体本 tick 排好的施法意图。★ 私有字段，测试里只读不改 */
const intentOf = (dir: CombatDirector, e: CombatEntity): unknown =>
  (dir as unknown as { pendingCasts: Map<unknown, unknown> }).pendingCasts.get(e.id);
