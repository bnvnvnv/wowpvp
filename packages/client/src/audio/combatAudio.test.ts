/**
 * P10：战斗音效的**语义**。
 *
 * ★★ 这一支不验「有没有声音」（那要浏览器），验的是「三件语义相反的事
 *   是不是还共用同一声」—— 那种缺陷单元测试从来抓不到，只有戴着耳机
 *   打一局才会发现，而发现的时候已经上线了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CastKind, School, asSkillId, type CombatEvent, type EntityId, type SkillDef, type Vec3 }
  from '@wowpvp/shared';

import type { AudioManager } from './AudioManager.js';
import { playCastActivity, playCombatEvent } from './combatAudio.js';

/**
 * 记下播了什么的假音频层。★ 只记录，不发声 —— 与真 AudioManager 的接口同形。
 * ★ P3：多了 `playCastFor` / `playImpactFor` 两支，且**记的是 skillId 而不是学派** ——
 *   「同一学派的十几个技能共用一声」这件事，只有把 id 记进调用串才验得出来。
 */
const makeAudio = () => {
  const calls: string[] = [];
  const stub = {
    play: (name: string) => { calls.push(`play:${name}`); },
    playVariant: (group: string) => { calls.push(`variant:${group}`); },
    playCast: (school: School) => { calls.push(`cast:${school}`); },
    playImpact: (school: School) => { calls.push(`impact:${school}`); },
    playCastFor: (s: { id: string }) => { calls.push(`castFor:${s.id}`); },
    playImpactFor: (s: { id: string }) => { calls.push(`impactFor:${s.id}`); },
  };
  return { calls, audio: stub as unknown as AudioManager };
};

const SELF = 1 as EntityId;
const OTHER = 2 as EntityId;
const at: Vec3 = { x: 0, y: 0, z: 0 };
const deps = {
  listener: () => at,
  positionOf: () => at,
  selfId: () => SELF,
};

const skill: SkillDef = getFrostbolt();
function getFrostbolt(): SkillDef {
  // 只用到 school / cast.kind，其余字段不参与判定
  return {
    id: asSkillId('mage.frostbolt'),
    school: School.Frost,
    cast: { kind: CastKind.Cast, time: 1.4, movable: false, interruptible: true },
  } as unknown as SkillDef;
}

const interruptEvent = (success: boolean): CombatEvent =>
  ({ t: 'interrupt', sourceId: SELF, targetId: OTHER, success }) as CombatEvent;

describe('7.2 打断的三种结果三种声音', () => {
  it('★★ 打断**成功**不再播 ui_error —— 那是「出错了」的声音，不是「我截住了」', () => {
    const { calls, audio } = makeAudio();
    playCombatEvent(audio, deps, interruptEvent(true));
    expect(calls).not.toContain('play:ui_error');
    expect(calls.length).toBe(1);
  });

  it('★ 成功与落空必须听得出区别（7.2：落空也进冷却，玩家要能分辨）', () => {
    const hit = makeAudio();
    const miss = makeAudio();
    playCombatEvent(hit.audio, deps, interruptEvent(true));
    playCombatEvent(miss.audio, deps, interruptEvent(false));
    expect(hit.calls).not.toEqual(miss.calls);
  });

  it('★ 挑的键必须是 AudioManager 已注册的变体组（不许引用不存在的素材）', () => {
    const hit = makeAudio();
    const miss = makeAudio();
    playCombatEvent(hit.audio, deps, interruptEvent(true));
    playCombatEvent(miss.audio, deps, interruptEvent(false));
    // VARIANTS 里确实有 metal / swing 两组，且每个文件都在 assets/music/sfx 下
    expect(hit.calls).toEqual(['variant:metal']);
    expect(miss.calls).toEqual(['variant:swing']);
  });

  it('「被打断」仍是 ui_error —— 它确实是一件坏事，与上面两者互不相同', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'interrupted', SELF, skill);
    expect(calls).toEqual(['play:ui_error']);
  });
});

describe('自身施法失败的提示音节流（~300ms）', () => {
  /**
   * ★ 直接推 `setSystemTime`，不用 `advanceTimersByTime` ——
   *   节流读的是 `Date.now()`（节流的是**人手的节奏**，与模拟时间无关），
   *   而定时器推进不保证带着 Date 一起走。
   */
  let clock = Date.UTC(2026, 0, 1);
  const jumpTo = (ms: number): void => { clock += ms; vi.setSystemTime(clock); };

  beforeEach(() => {
    vi.useFakeTimers();
    // 每个用例都跳到一个很远的新时刻：节流状态是模块级的、跨用例存活，
    // 不隔开的话上一条的余波会吃掉下一条的第一声
    jumpTo(60_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('★ 连按 8 次只响一声 —— 8 声 ui_error 听上去像系统坏了', () => {
    const { calls, audio } = makeAudio();
    for (let i = 0; i < 8; i++) {
      playCastActivity(audio, deps, 'failed', SELF, skill);
      jumpTo(30); // 人手连按的节奏，远大于 AudioManager 的 40ms 去重
    }
    expect(calls).toEqual(['play:ui_error']);
  });

  it('★ 隔开的两次**分开的**误操作各响一声（别把节流做成静音）', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'failed', SELF, skill);
    jumpTo(400);
    playCastActivity(audio, deps, 'failed', SELF, skill);
    expect(calls).toEqual(['play:ui_error', 'play:ui_error']);
  });

  it('别人失败照旧没有提示音（旁观信息，日志够了）', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'failed', OTHER, skill);
    expect(calls).toEqual([]);
  });

  it('⚠️ 节流只管失败提示音，不影响施法音（那是另一条通道）', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'failed', SELF, skill);
    playCastActivity(audio, deps, 'resolved', SELF, skill);
    playCastActivity(audio, deps, 'resolved', SELF, skill);
    expect(calls.filter((c) => c.startsWith('castFor:')).length).toBe(2);
  });
});

/**
 * P3：施法音改走技能签名（`playCastFor`）之后，P10 那套「三件语义相反的事
 * 三种声音」必须原样还在。
 *
 * ★★ 这一支存在的理由很具体：P3 的改法是把 `playCast(school)` 换成
 *   `playCastFor(skill)`，最容易顺手做过头的一件事就是**把失败/被打断也一起
 *   签名化** —— 那会让「我按了没放出来」这一声随技能变调，
 *   而 P10 花了一整批才把它固定成一个玩家学得会的常量。
 */
describe('P3 重构后：P10 的打断三分法与失败提示音没有回退', () => {
  it('★★ 打断成功 / 落空 / 被打断，三条仍是三种互不相同的声音', () => {
    const ok = makeAudio();
    const miss = makeAudio();
    const mine = makeAudio();
    playCombatEvent(ok.audio, deps, interruptEvent(true));
    playCombatEvent(miss.audio, deps, interruptEvent(false));
    playCastActivity(mine.audio, deps, 'interrupted', SELF, skill);
    expect(ok.calls).toEqual(['variant:metal']);
    expect(miss.calls).toEqual(['variant:swing']);
    expect(mine.calls).toEqual(['play:ui_error']);
  });

  it('★★ 失败/被打断**不**走签名 —— 它们说的是「没成」，不是「这是什么技能」', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'interrupted', SELF, skill);
    expect(calls.some((c) => c.startsWith('castFor:'))).toBe(false);
  });
});

describe('★★ P3：施法音携带 skillId（同学派的十几个技能不再共用一声）', () => {
  it('★★ resolved 递下去的是技能本身，不是它的学派', () => {
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'resolved', SELF, skill);
    expect(calls).toEqual(['castFor:mage.frostbolt']);
    // 老的学派入口在技能语境里彻底不再出现（回落发生在 AudioManager 内部）
    expect(calls.some((c) => c.startsWith('cast:'))).toBe(false);
  });

  it('★ 同学派的两个技能给出两条不同的调用（此前两者完全同声）', () => {
    const iceLance = { ...skill, id: asSkillId('mage.ice_lance') } as SkillDef;
    const a = makeAudio();
    const b = makeAudio();
    playCastActivity(a.audio, deps, 'resolved', SELF, skill);
    playCastActivity(b.audio, deps, 'resolved', SELF, iceLance);
    expect(a.calls).not.toEqual(b.calls);
  });

  it('⚠️ 起手声仍只给读条/引导 —— 瞬发不许响两声（P10 结论未变）', () => {
    const instant = {
      ...skill, cast: { kind: CastKind.Instant, time: 0, movable: true, interruptible: false },
    } as SkillDef;
    const { calls, audio } = makeAudio();
    playCastActivity(audio, deps, 'started', SELF, instant);
    expect(calls).toEqual([]);
  });
});
