/**
 * 教学状态机测试。docs/14 §M15：「每环有『不教就过不去』的验证点」——
 * 这里给每一环配**正路 + 否定路**两组断言；verify:m15 在浏览器里复验的
 * 是同一台状态机的接线，规约本身在这里就钉死。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFENSE_SKILLS,
  FEINT_WINDOW_SECONDS,
  FIRST_CAST_SKILL,
  GROUND_SKILLS,
  INSTANT_SKILL,
  MOVE_METERS,
  STEP_ORDER,
  STEPS,
  advanceTutorial,
  initialTutorialState,
  type TutorialSignal,
  type TutorialState,
} from './steps.js';

const feed = (s: TutorialState, ...sigs: TutorialSignal[]): TutorialState =>
  sigs.reduce(advanceTutorial, s);

/** 快进到某一环开头（用「合法存档」直接落位，与重进语义一致）*/
const at = (id: (typeof STEP_ORDER)[number]): TutorialState =>
  initialTutorialState(STEP_ORDER.slice(0, STEP_ORDER.indexOf(id)) as never);

describe('课程结构', () => {
  it('十二环齐全且顺序固定（完整教学：基础七环 + 反制四环 + 毕业）', () => {
    expect(STEPS.map((s) => s.id)).toEqual(STEP_ORDER);
    expect(STEP_ORDER).toHaveLength(12);
  });

  it('存档只认前缀连续的完成序列 —— 跳步存档按最长合法前缀截断', () => {
    const s = initialTutorialState(['move', 'target'] as never); // 缺 camera，target 不算
    expect(s.done).toEqual(['move']);
    expect(s.current).toBe('camera');
  });
});

describe('1 移动', () => {
  it('走满 5 米 + 跳一次 → 过', () => {
    const s = feed(at('move'), { t: 'moved', meters: MOVE_METERS }, { t: 'jumped' });
    expect(s.current).toBe('camera');
  });

  it('★ 只走不跳 / 只跳不走 → 不过', () => {
    expect(feed(at('move'), { t: 'moved', meters: 99 }).current).toBe('move');
    expect(feed(at('move'), { t: 'jumped' }).current).toBe('move');
  });

  it('距离是累计的（碎步也算）', () => {
    const s = feed(at('move'),
      { t: 'moved', meters: 2 }, { t: 'moved', meters: 2 }, { t: 'moved', meters: 1.2 },
      { t: 'jumped' });
    expect(s.current).toBe('camera');
  });
});

describe('2 镜头', () => {
  it('环绕满 1 弧度 + 缩放满 2 米 → 过', () => {
    const s = feed(at('camera'),
      { t: 'cameraOrbited', radians: 1.1 }, { t: 'cameraZoomed', meters: 2.5 });
    expect(s.current).toBe('target');
  });

  it('★ 只环绕不缩放 → 不过', () => {
    expect(feed(at('camera'), { t: 'cameraOrbited', radians: 9 }).current).toBe('camera');
  });
});

describe('3 选中目标', () => {
  it('选中 → 过；★ 放技能不能替代选中环', () => {
    expect(feed(at('target'), { t: 'targeted' }).current).toBe('firstCast');
    expect(
      feed(at('target'), { t: 'playerCastResolved', skillId: FIRST_CAST_SKILL, school: 'frost', at: 1 }).current,
    ).toBe('target');
  });
});

describe('4 第一发读条 / 5 瞬发 / 6 地面 / 7 自保 —— 各自只认各自的技能', () => {
  it('寒冰箭读完 → 过第一发环', () => {
    const s = feed(at('firstCast'),
      { t: 'playerCastResolved', skillId: FIRST_CAST_SKILL, school: 'frost', at: 1 });
    expect(s.current).toBe('instant');
  });

  it('★ 用火冲糊脸过不了「第一发读条」环（教的是读条要站稳）', () => {
    expect(
      feed(at('firstCast'), { t: 'playerCastResolved', skillId: INSTANT_SKILL, school: 'fire', at: 1 }).current,
    ).toBe('firstCast');
  });

  it('火冲 → 过瞬发环；暴风雪/陨石 → 过地面环；新星/冰屏障 → 过自保环', () => {
    expect(feed(at('instant'),
      { t: 'playerCastResolved', skillId: INSTANT_SKILL, school: 'fire', at: 1 }).current).toBe('ground');
    expect(feed(at('ground'),
      { t: 'playerCastResolved', skillId: GROUND_SKILLS[0]!, school: 'frost', at: 1 }).current).toBe('defense');
    expect(feed(at('defense'),
      { t: 'playerCastResolved', skillId: DEFENSE_SKILLS[0]!, school: 'frost', at: 1 }).current).toBe('interrupt');
  });

  it('★ 地面环放寒冰箭不算', () => {
    expect(feed(at('ground'),
      { t: 'playerCastResolved', skillId: FIRST_CAST_SKILL, school: 'frost', at: 1 }).current).toBe('ground');
  });
});

describe('8 打断对手', () => {
  it('玩家打断法师假人 → 过', () => {
    const s = feed(at('interrupt'),
      { t: 'interruptLanded', byPlayer: true, targetWasMageDummy: true, at: 1 });
    expect(s.current).toBe('locked');
  });

  it('★ 战士替你打断的不算；打断别的目标也不算', () => {
    expect(feed(at('interrupt'),
      { t: 'interruptLanded', byPlayer: false, targetWasMageDummy: true, at: 1 }).current).toBe('interrupt');
    expect(feed(at('interrupt'),
      { t: 'interruptLanded', byPlayer: true, targetWasMageDummy: false, at: 1 }).current).toBe('interrupt');
  });
});

describe('9 被打断的代价', () => {
  const interrupted: TutorialSignal =
    { t: 'playerInterrupted', skillId: FIRST_CAST_SKILL, lockedSchool: 'frost', lockUntil: 10, at: 6 };

  it('被打断（冰锁）→ 锁内用火焰打出去 → 过', () => {
    const s = feed(at('locked'), interrupted,
      { t: 'playerCastResolved', skillId: INSTANT_SKILL, school: 'fire', at: 8 });
    expect(s.current).toBe('feint');
  });

  it('★ 没被打断直接放火冲 → 不过（这一环教的是「锁定期内还能反击」）', () => {
    expect(feed(at('locked'),
      { t: 'playerCastResolved', skillId: INSTANT_SKILL, school: 'fire', at: 8 }).current).toBe('locked');
  });

  it('★ 锁过期后才还手 → 不过；用同学派（等于没体会锁）→ 不过', () => {
    expect(feed(at('locked'), interrupted,
      { t: 'playerCastResolved', skillId: INSTANT_SKILL, school: 'fire', at: 11 }).current).toBe('locked');
    expect(feed(at('locked'), interrupted,
      { t: 'playerCastResolved', skillId: 'mage.frost_nova', school: 'frost', at: 8 }).current).toBe('locked');
  });
});

describe('10 假读条（否定式验证点是 M15 判据的原文举例）', () => {
  it('起手 → 取消 → 拳击落空（窗口内）→ 过', () => {
    const s = feed(at('feint'),
      { t: 'playerCastStarted', skillId: FIRST_CAST_SKILL, school: 'frost', at: 5 },
      { t: 'playerCastCancelled', skillId: FIRST_CAST_SKILL, at: 5.3 },
      { t: 'pummelSwung', playerWasCasting: false, at: 5.75 });
    expect(s.current).toBe('sidestep');
  });

  it('★★ 不按 Esc 直接读完 → 任务不亮（判据原文的那条）', () => {
    const s = feed(at('feint'),
      { t: 'playerCastStarted', skillId: FIRST_CAST_SKILL, school: 'frost', at: 5 },
      { t: 'playerCastResolved', skillId: FIRST_CAST_SKILL, school: 'frost', at: 6.4 });
    expect(s.current).toBe('feint');
  });

  it('★ 被打断（没来得及取消）→ 不过；拳击命中（playerWasCasting）→ 不过', () => {
    expect(feed(at('feint'),
      { t: 'playerCastStarted', skillId: FIRST_CAST_SKILL, school: 'frost', at: 5 },
      { t: 'pummelSwung', playerWasCasting: true, at: 5.5 }).current).toBe('feint');
  });

  it('★ 取消太久之后的落空不算（不是这次取消骗出来的）', () => {
    const s = feed(at('feint'),
      { t: 'playerCastCancelled', skillId: FIRST_CAST_SKILL, at: 5 },
      { t: 'pummelSwung', playerWasCasting: false, at: 5 + FEINT_WINDOW_SECONDS + 0.1 });
    expect(s.current).toBe('feint');
  });

  it('取消与挥拳在同一时刻（同 tick）→ 过 —— Director 的竞态补偿依赖这个语义', () => {
    const s = feed(at('feint'),
      { t: 'playerCastCancelled', skillId: FIRST_CAST_SKILL, at: 5 },
      { t: 'pummelSwung', playerWasCasting: false, at: 5 });
    expect(s.current).toBe('sidestep');
  });
});

describe('11 走位反制', () => {
  it('进过圈 + 落地时在圈外 → 过', () => {
    const s = feed(at('sidestep'),
      { t: 'meteorZoneEntered', at: 3 },
      { t: 'meteorImpact', playerInside: false, enteredBefore: true, at: 5.5 });
    expect(s.current).toBe('graduate');
  });

  it('★ 站在圈里挨炸 → 不过，且这一轮作废（等下一颗）', () => {
    const s = feed(at('sidestep'),
      { t: 'meteorZoneEntered', at: 3 },
      { t: 'meteorImpact', playerInside: true, enteredBefore: true, at: 5.5 });
    expect(s.current).toBe('sidestep');
    expect(s.enteredMeteorZone).toBe(false);
  });

  it('★ 从头到尾没进圈（站外面看戏）→ 不过', () => {
    const s = feed(at('sidestep'),
      { t: 'meteorImpact', playerInside: false, enteredBefore: false, at: 5.5 });
    expect(s.current).toBe('sidestep');
  });
});

describe('12 毕业考', () => {
  it('三个不同假人倒下 → 毕业（全部完成，current=null）', () => {
    const s = feed(at('graduate'),
      { t: 'dummyDied', entityId: 2, at: 1 },
      { t: 'dummyDied', entityId: 3, at: 2 },
      { t: 'dummyDied', entityId: 4, at: 3 });
    expect(s.done).toEqual(STEP_ORDER);
    expect(s.current).toBeNull();
  });

  it('★ 同一个假人倒三次（试验场会复活）→ 只算一个', () => {
    const s = feed(at('graduate'),
      { t: 'dummyDied', entityId: 2, at: 1 },
      { t: 'dummyDied', entityId: 2, at: 2 },
      { t: 'dummyDied', entityId: 2, at: 3 });
    expect(s.current).toBe('graduate');
    expect(s.killedDummies).toEqual([2]);
  });
});

describe('顺序门控（提前做对也不算 —— 每一环的否定断言共用这一条地基）', () => {
  it('★ 在第一环就做完假读条整套动作 → 教学仍停在第一环', () => {
    const s = feed(initialTutorialState(),
      { t: 'playerCastStarted', skillId: FIRST_CAST_SKILL, school: 'frost', at: 5 },
      { t: 'playerCastCancelled', skillId: FIRST_CAST_SKILL, at: 5.2 },
      { t: 'pummelSwung', playerWasCasting: false, at: 5.6 });
    expect(s.current).toBe('move');
    expect(s.done).toEqual([]);
  });
});
