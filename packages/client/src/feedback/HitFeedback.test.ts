/**
 * 命中反馈编排。重点是三条**独立性**规则：
 *   · 关掉伤害数字，其余通道一条不少（8.1：必须给出清晰命中反馈）
 *   · cameraShake=0 时 addTrauma 照样被调（归零在 shakeAmplitude 唯一入口）
 *   · 震动/顿帧只在牵涉本地玩家时触发（12v12 防抖成筛子）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { School, asEntityId } from '@wowpvp/shared';
import { DEFAULT_ACCESSIBILITY, type AccessibilitySettings } from '../settings/accessibility.js';
import { HitFeedback, flashColorFor, type HitEvent } from './HitFeedback.js';
import { ATTRIBUTE_VISUALS } from '../vfx/schools.js';

const SELF = asEntityId(1);
const ENEMY = asEntityId(2);
const OTHER = asEntityId(3);

const makeDeps = (access: Partial<AccessibilitySettings> = {}) => {
  const settings = { ...DEFAULT_ACCESSIBILITY, ...access };
  const view = { flashHit: vi.fn(), playHitReact: vi.fn(), playAvoidReact: vi.fn() };
  const deps = {
    selfId: () => SELF,
    headOf: () => ({ x: 0, y: 1.8, z: 0 }),
    audioAt: () => ({}),
    viewOf: () => view,
    floaters: { push: vi.fn() },
    flashScreen: vi.fn(),
    vfxDamage: vi.fn(),
    addTrauma: vi.fn(),
    hitStop: { trigger: vi.fn() },
    // P3 起命中音走 playImpactFor（签名层）；playImpact 保留在假对象里是
    // 因为 deps 类型仍然要求它（非技能语境的兜底通道）
    audio: { play: vi.fn(), playVariant: vi.fn(), playImpact: vi.fn(), playImpactFor: vi.fn() },
    access: () => settings,
  };
  return { deps, view, feedback: new HitFeedback(deps) };
};

const hit = (over: Partial<HitEvent> = {}): HitEvent => ({
  targetId: SELF, sourceId: ENEMY,
  amount: 100, absorbed: 0, immune: false,
  crit: false, overkill: 0, school: School.Fire,
  targetMaxHealth: 1000,
  ...over,
});

let ctx: ReturnType<typeof makeDeps>;
beforeEach(() => { ctx = makeDeps(); });

describe('★★ 通道独立性', () => {
  it('★★ damageNumbers=false 时音效/屏闪/震动/粒子照常（8.1 红线）', () => {
    const { deps, feedback } = makeDeps({ damageNumbers: false });
    feedback.onHit(hit({ crit: true, amount: 300 }));
    // 浮字开关在 FloatingNumbers 内部 —— HitFeedback 这层甚至不该少调 push
    expect(deps.audio.playImpactFor).toHaveBeenCalled();
    expect(deps.flashScreen).toHaveBeenCalled();
    expect(deps.addTrauma).toHaveBeenCalled();
    expect(deps.vfxDamage).toHaveBeenCalled();
  });

  it('★★ cameraShake=0 时 addTrauma 仍被调用（归零只在 shakeAmplitude 一处）', () => {
    const { deps, feedback } = makeDeps({ cameraShake: 0 });
    feedback.onHit(hit({ amount: 300 }));
    expect(deps.addTrauma).toHaveBeenCalled();
  });

  it('★ hitStop=false 时 trigger 不被调用', () => {
    const { deps, feedback } = makeDeps({ hitStop: false });
    feedback.onHit(hit({ crit: true, amount: 300 }));
    expect(deps.hitStop.trigger).not.toHaveBeenCalled();
  });
});

describe('★★ 本地玩家筛选', () => {
  it('retains the available skill identity for impact visuals', () => {
    const { deps, feedback } = makeDeps();
    feedback.onHit(hit({ skillId: 'mage.frostbolt' }));
    expect(deps.vfxDamage).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'mage.frostbolt', sourceId: ENEMY }));
    feedback.onHit(hit({ skillId: undefined, sourceId: undefined }));
    expect(deps.vfxDamage).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: undefined, sourceId: undefined }));
  });

  it('coalesces simultaneous area hits into one camera impulse', () => {
    const { deps, feedback } = makeDeps();
    for (let i = 0; i < 6; i++) feedback.onHit(hit({ sourceId: SELF, targetId: asEntityId(i + 2), crit: true }));
    expect(deps.addTrauma).toHaveBeenCalledTimes(1);
    feedback.update(0.1);
    feedback.onHit(hit({ sourceId: SELF, targetId: ENEMY, crit: true }));
    expect(deps.addTrauma).toHaveBeenCalledTimes(2);
  });
  it('hides unrelated combat numbers while retaining visible impacts', () => {
    const { deps, view, feedback } = makeDeps();
    feedback.onHit(hit({ targetId: OTHER, sourceId: ENEMY, crit: true, amount: 400 }));
    expect(deps.addTrauma).not.toHaveBeenCalled();
    expect(deps.hitStop.trigger).not.toHaveBeenCalled();
    expect(deps.floaters.push).not.toHaveBeenCalled();
    expect(deps.vfxDamage).toHaveBeenCalled();
    expect(view.flashHit).toHaveBeenCalled();
  });

  it('labels unrelated damage separately when all numbers are enabled', () => {
    const { deps, feedback } = makeDeps({ otherCombatNumbers: true });
    feedback.onHit(hit({ targetId: OTHER, sourceId: ENEMY, crit: true, amount: 400 }));
    expect(deps.floaters.push).toHaveBeenCalledWith('他人 400!', 'otherDamage', expect.anything());
  });

  it('distinguishes outgoing and incoming damage without relying only on color', () => {
    const { deps, feedback } = makeDeps();
    feedback.onHit(hit({ targetId: OTHER, sourceId: SELF, amount: 80 }));
    expect(deps.floaters.push).toHaveBeenLastCalledWith('80', 'damage', expect.anything(), {});
    feedback.onHit(hit({ amount: 80 }));
    expect(deps.floaters.push).toHaveBeenLastCalledWith('-80', 'damageTaken', expect.anything(), {});
    feedback.onHeal({ sourceId: SELF, targetId: OTHER, amount: 30, crit: false });
    expect(deps.floaters.push).toHaveBeenLastCalledWith('+30', 'heal', expect.anything(), {});
  });

  it('★ 自己打出暴击：有创伤（攻击方的手感），弱于挨到暴击', () => {
    const { deps, feedback } = makeDeps();
    feedback.onHit(hit({ targetId: OTHER, sourceId: SELF, crit: true }));
    const dealt = (deps.addTrauma as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    ctx = makeDeps();
    ctx.feedback.onHit(hit({ targetId: SELF, sourceId: ENEMY, crit: true }));
    const taken = (ctx.deps.addTrauma as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(dealt).toBeGreaterThan(0);
    expect(taken).toBeGreaterThan(dealt);
  });
});

describe('分档驱动的表现', () => {
  it('★ P6：普通命中也踉跄（此前只有重击 —— 用户实测「感觉不到被击中」）；light 仍只闪白', () => {
    const { view, feedback } = makeDeps();
    feedback.onHit(hit({ amount: 10 })); // light（刮痧/DoT 跳）
    expect(view.playHitReact, 'light 档踉跄会把 DoT 目标抖成帕金森').not.toHaveBeenCalled();
    feedback.onHit(hit({ amount: 100 })); // normal
    expect(view.playHitReact).toHaveBeenCalledTimes(1);
    feedback.onHit(hit({ amount: 300 })); // heavy
    expect(view.playHitReact).toHaveBeenCalledTimes(2);
  });

  it('★ 暴击浮字带「!」后缀（字形是第三通道）且颜色分敌我：自己挨的走 critTaken', () => {
    const { deps, feedback } = makeDeps();
    // 默认夹具打的是**自己**（targetId = SELF）→ 红色的 critTaken
    feedback.onHit(hit({ crit: true, amount: 123 }));
    expect(deps.floaters.push).toHaveBeenCalledWith('-123!', 'critTaken', expect.anything());
    // 打**别人**的暴击 → 橙黄的 crit（X10 追加轮拍板：谁在爆谁一眼分清）
    feedback.onHit(hit({ crit: true, amount: 88, targetId: OTHER, sourceId: SELF }));
    expect(deps.floaters.push).toHaveBeenCalledWith('88!', 'crit', expect.anything());
  });

  it('★ overkill>0 且自己击杀 → 击杀确认音', () => {
    const { deps, feedback } = makeDeps();
    feedback.onHit(hit({ targetId: OTHER, sourceId: SELF, overkill: 20 }));
    expect(deps.audio.play).toHaveBeenCalledWith('ui_achievement', expect.objectContaining({ group: 'ui' }));
  });

  it('★ 被规避的一发：miss 浮字 + 规避音，不闪白不震动', () => {
    const { deps, view, feedback } = makeDeps();
    feedback.onHit(hit({ avoided: 'dodge', amount: 0 }));
    expect(deps.floaters.push).toHaveBeenCalledWith('闪避', 'miss', expect.anything());
    expect(deps.audio.playVariant).toHaveBeenCalledWith('dodge', expect.anything());
    expect(view.flashHit).not.toHaveBeenCalled();
    expect(deps.addTrauma).not.toHaveBeenCalled();
  });

  it('★★ P6：规避有模型动作 —— 此前只有浮字+音效，模型纹丝不动（用户实测点名）', () => {
    const { view, feedback } = makeDeps();
    feedback.onHit(hit({ avoided: 'dodge', amount: 0 }));
    expect(view.playAvoidReact).toHaveBeenCalledWith('dodge');
    feedback.onHit(hit({ avoided: 'block', amount: 0 }));
    expect(view.playAvoidReact).toHaveBeenCalledWith('block');
    // 规避不该同时触发受击踉跄（挨打和躲开是互斥的两件事）
    expect(view.playHitReact).not.toHaveBeenCalled();
  });

  it('★ 暴击音效层有 120ms 节流（AOE 暴击 3 人只响一声）', () => {
    const { deps, feedback } = makeDeps();
    feedback.onHit(hit({ crit: true }));
    feedback.onHit(hit({ crit: true, targetId: SELF }));
    const critCalls = (deps.audio.playVariant as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'crit');
    expect(critCalls.length).toBe(1);
    feedback.update(0.2); // 过了节流窗口
    feedback.onHit(hit({ crit: true }));
    const after = (deps.audio.playVariant as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'crit');
    expect(after.length).toBe(2);
  });
});

describe('flashColorFor —— 受击闪光的学派色（承受者不再只会闪白）', () => {
  it('普通命中闪的是这一发的学派色', () => {
    expect(flashColorFor(School.Fire, false)).toBe(ATTRIBUTE_VISUALS.fire.primary);
    expect(flashColorFor(School.Frost, false)).toBe(ATTRIBUTE_VISUALS.frost.primary);
    expect(flashColorFor(School.Shadow, false)).toBe(ATTRIBUTE_VISUALS.shadow.primary);
  });

  it('★★ 白只留给暴击 —— 且没有任何学派的主色是纯白', () => {
    expect(flashColorFor(School.Fire, true)).toBe(0xffffff);
    expect(flashColorFor(School.Frost, true)).toBe(0xffffff);
    for (const v of Object.values(ATTRIBUTE_VISUALS)) {
      expect(v.primary).not.toBe(0xffffff);
    }
  });

  it('八个学派各有颜色，没有一个漏成 undefined', () => {
    for (const school of Object.values(School)) {
      expect(typeof flashColorFor(school, false)).toBe('number');
    }
  });
});

describe('受击闪光接线 —— 分档参数之外还要带上颜色', () => {
  it('普通/重击/暴击三档都把颜色传给 flashHit', () => {
    const { view, feedback } = makeDeps();
    feedback.onHit(hit({ school: School.Frost }));
    expect(view.flashHit).toHaveBeenLastCalledWith(
      0.85, 0.12, ATTRIBUTE_VISUALS.frost.primary,
    );
    feedback.onHit(hit({ school: School.Frost, crit: true }));
    expect(view.flashHit).toHaveBeenLastCalledWith(1.4, 0.2, 0xffffff);
  });

  it('★ 只被吸收（amount=0、absorbed>0）也要闪 —— 盾挡下的一发不是「没打中」', () => {
    const { view, feedback } = makeDeps();
    feedback.onHit(hit({ amount: 0, absorbed: 120, school: School.Holy }));
    expect(view.flashHit).toHaveBeenCalledWith(
      0.85, 0.12, ATTRIBUTE_VISUALS.holy.primary,
    );
  });
});
