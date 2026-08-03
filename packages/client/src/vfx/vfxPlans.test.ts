/**
 * 特效**参数计划**的纯函数断言（14.1 / 14.2 / 14.3）。
 *
 * ★ 与 `vfx.test.ts` 的分工：那边钉规格书条款（八属性表、护盾四态、
 *   画质角色归属），这边钉**参数本身**——「雪到底往下落吗」「引导段的
 *   时间轴是不是按引导算的」这类靠看截图会漏、靠读代码会自我说服的东西。
 */

import { describe, expect, it } from 'vitest';
import { MOTION, boltOrientation, trailPlanFor } from './boltVfx.js';
import {
  PHYSICAL_WINDUP_STYLES, WINDUP_STYLES, fizzlePlanFor, windupPlanFor, windupStyleOf,
} from './castVfx.js';
import {
  MAX_FILL_AREAS, groundFillPlanFor, verticalTravel, waveEase, wavePlanFor,
} from './groundVfx.js';
import { ATTRIBUTE_VISUALS, visualForAuraId } from './schools.js';
import { strongestShield } from './status.js';
import { QualityTier } from '../render/quality.js';

/** 冰霜风暴：0.8 秒读条 + 4 秒引导，从 t=0 起手 */
const blizzard = (now: number, density = 1) =>
  windupPlanFor({ now, startedAt: 0, endsAt: 0.8, channelEndsAt: 4.8, density });

/** 霜矢：1.4 秒纯读条 */
const frostbolt = (now: number, density = 1) =>
  windupPlanFor({ now, startedAt: 0, endsAt: 1.4, density });

describe('windupPlanFor —— 读条段', () => {
  it('progress 随时间单调涨到 1', () => {
    expect(frostbolt(0).progress).toBeCloseTo(0, 6);
    expect(frostbolt(0.7).progress).toBeCloseTo(0.5, 6);
    expect(frostbolt(1.4).progress).toBeCloseTo(1, 6);
  });

  it('★ 聚能环半径单调收紧 —— 「攒」靠向内的运动表达，不靠越来越亮', () => {
    const early = frostbolt(0.1).gatherRadius;
    const mid = frostbolt(0.7).gatherRadius;
    const late = frostbolt(1.3).gatherRadius;
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });

  it('★ 节拍随进度加密 —— 「就要放出来了」的表现层线索（7.5 假读条博弈用它）', () => {
    expect(frostbolt(1.3).cadence).toBeLessThan(frostbolt(0.1).cadence);
  });

  it('法阵在 POP_IN 内弹出，之后保持满缩放', () => {
    expect(frostbolt(0).circleScale).toBeCloseTo(0, 6);
    expect(frostbolt(0.09).circleScale).toBeGreaterThan(0);
    expect(frostbolt(0.09).circleScale).toBeLessThan(1);
    expect(frostbolt(0.5).circleScale).toBe(1);
  });
});

describe('windupPlanFor —— 引导段', () => {
  it('★★ 引导段按引导自己的时间轴重算，不是接着读条继续涨', () => {
    // t=0.8 是引导刚开始：进度必须回到 0，而不是读条结束时的 1
    const start = blizzard(0.81);
    expect(start.phase).toBe('channel');
    expect(start.progress).toBeLessThan(0.05);

    // 引导过半
    expect(blizzard(2.8).progress).toBeCloseTo(0.5, 1);
    // 引导结束
    expect(blizzard(4.8).progress).toBeCloseTo(1, 6);
  });

  it('读条段仍归 bar，边界处切到 channel', () => {
    expect(blizzard(0.5).phase).toBe('bar');
    expect(blizzard(0.8).phase).toBe('channel');
  });

  it('★ 引导期间法阵转得更快、更亮 ——「正在倾泻」比「正在积蓄」更急', () => {
    const bar = blizzard(0.5);
    const channel = blizzard(2.5);
    expect(channel.circleSpin).toBeGreaterThan(bar.circleSpin);
    expect(channel.circleOpacity).toBeGreaterThan(bar.circleOpacity);
  });

  it('没有 channelEndsAt 的技能永远不会进 channel 段', () => {
    // 读条早就结束了（超时那一帧），仍然是 bar —— 引导相位不能凭空出现
    expect(frostbolt(9).phase).toBe('bar');
    expect(frostbolt(9).progress).toBe(1);
  });
});

describe('windupPlanFor —— 画质', () => {
  it('★ 低画质（density=0）不发聚能粒子，但法阵照画（验收 #48）', () => {
    const low = frostbolt(0.7, 0);
    expect(low.count).toBe(0);
    expect(low.cadence).toBe(0);
    // 法阵是关键信息「这个人在施法」—— 一点都不能少
    expect(low.circleScale).toBe(1);
    expect(low.circleOpacity).toBeGreaterThan(0);
  });

  it('中画质（density=0.5）节拍翻倍、每簇减半 —— 负载减半', () => {
    const high = frostbolt(0.7, 1);
    const medium = frostbolt(0.7, 0.5);
    expect(medium.cadence).toBeCloseTo(high.cadence * 2, 6);
    expect(medium.count).toBeLessThan(high.count);
    expect(medium.count).toBeGreaterThan(0);
  });

  it('★ 单个施法者的并发槽占用不超过 3 格（细流池预算的基础）', () => {
    for (const t of [0.05, 0.4, 0.8, 1.2, 1.39]) {
      const p = frostbolt(t);
      expect(Math.ceil(p.life / p.cadence)).toBeLessThanOrEqual(3);
    }
  });
});

describe('boltOrientation', () => {
  it('正前方（-Z）/ 正后方（+Z）/ 正右（+X）的 yaw 各就各位', () => {
    // 本项目的「前方」是 -Z（见 ModelLibrary 的归一化注释）
    expect(boltOrientation({ x: 0, y: 0, z: -1 }).yaw).toBeCloseTo(Math.PI, 6);
    expect(boltOrientation({ x: 0, y: 0, z: 1 }).yaw).toBeCloseTo(0, 6);
    expect(boltOrientation({ x: 1, y: 0, z: 0 }).yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('俯仰：水平为 0，正上为 +90°，正下为 -90°', () => {
    expect(boltOrientation({ x: 0, y: 0, z: 1 }).pitch).toBeCloseTo(0, 6);
    expect(boltOrientation({ x: 0, y: 1, z: 0 }).pitch).toBeCloseTo(Math.PI / 2, 6);
    expect(boltOrientation({ x: 0, y: -1, z: 0 }).pitch).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('45° 斜上飞的俯仰是 45°', () => {
    expect(boltOrientation({ x: 0, y: 1, z: 1 }).pitch).toBeCloseTo(Math.PI / 4, 6);
  });

  it('★ 零向量不产生 NaN —— NaN 进 rotation 会让整发弹体从画面上消失', () => {
    const o = boltOrientation({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(o.yaw)).toBe(true);
    expect(Number.isFinite(o.pitch)).toBe(true);
  });

  it('长度不影响角度（只看方向）', () => {
    const near = boltOrientation({ x: 0.001, y: 0, z: -0.001 });
    const far = boltOrientation({ x: 10, y: 0, z: -10 });
    expect(near.yaw).toBeCloseTo(far.yaw, 6);
  });
});

describe('trailPlanFor', () => {
  it('★★ 拖尾方向与 MOTION 同号 —— 火向上飘、冰向下落', () => {
    for (const av of Object.values(ATTRIBUTE_VISUALS)) {
      const plan = trailPlanFor(av.particle, 1);
      expect(Math.sign(plan.gravity)).toBe(Math.sign(MOTION[av.particle].gravity));
    }
    // 逐个点名两条最容易写反的
    expect(trailPlanFor('ember', 1).gravity).toBeGreaterThan(0);
    expect(trailPlanFor('snowflake', 1).gravity).toBeLessThan(0);
  });

  it('★ 阻力足够小，尾巴才拖得住（旧值 4 会在 0.25 秒内把粒子拽停）', () => {
    expect(trailPlanFor('ember', 1).drag).toBeLessThan(2);
    expect(trailPlanFor('ember', 1).life).toBeGreaterThanOrEqual(0.4);
  });

  it('低画质不发拖尾粒子（彗尾条另有画质门禁）', () => {
    const low = trailPlanFor('ember', 0);
    expect(low.count).toBe(0);
    expect(low.cadence).toBe(0);
  });

  it('★ 单发弹体的并发槽占用不超过 6 格（细流池预算：6×4 + 蓄力 12 + 地面 12 = 48）', () => {
    for (const d of [1, 0.5]) {
      const plan = trailPlanFor('ember', d);
      expect(Math.ceil(plan.life / plan.cadence)).toBeLessThanOrEqual(6);
    }
  });
});

describe('wavePlanFor / waveEase', () => {
  it('★ 低画质砍掉染色盘，但波本体仍在（它画的是这次 AOE 的真实半径，essential）', () => {
    const low = wavePlanFor(5, QualityTier.Low);
    expect(low.decal).toBe(false);
    expect(low.life).toBeGreaterThan(0);
    expect(low.ringOpacity).toBeGreaterThan(0);
    expect(wavePlanFor(5, QualityTier.High).decal).toBe(true);
  });

  it('范围越大扩得越久 —— 大范围扩太快会读成一次闪光', () => {
    expect(wavePlanFor(12, QualityTier.High).life)
      .toBeGreaterThan(wavePlanFor(5, QualityTier.High).life);
  });

  it('★ 扩张缓动先快后慢：半程时已经铺开六成以上', () => {
    expect(waveEase(0)).toBeCloseTo(0, 6);
    expect(waveEase(1)).toBeCloseTo(1, 6);
    expect(waveEase(0.5)).toBeGreaterThan(0.6);
    // 单调
    expect(waveEase(0.3)).toBeLessThan(waveEase(0.6));
  });

  it('缓动对越界输入钳到 [0,1]', () => {
    expect(waveEase(-1)).toBe(0);
    expect(waveEase(2)).toBe(1);
  });
});

describe('groundFillPlanFor —— 天气', () => {
  it('★★ 冰是从高处**往下**落的 —— 直接钉住「暴风雪啥都没有」那条反馈', () => {
    const snow = groundFillPlanFor('snowflake', 6, 1);
    expect(snow.mode).toBe('fall');
    expect(snow.gravity).toBeLessThan(0);
    expect(snow.spawnHeight).toBeGreaterThan(2);
  });

  it('火与圣是贴地**升起**的', () => {
    for (const p of ['ember', 'beam'] as const) {
      const plan = groundFillPlanFor(p, 6, 1);
      expect(plan.mode).toBe('rise');
      expect(plan.gravity).toBeGreaterThan(0);
      expect(plan.spawnHeight).toBeLessThan(0.5);
    }
  });

  it('★ 八属性的填充方向与 MOTION 同号（同一张表派生，不会各写各的）', () => {
    for (const av of Object.values(ATTRIBUTE_VISUALS)) {
      const plan = groundFillPlanFor(av.particle, 6, 1);
      expect(Math.sign(plan.gravity)).toBe(Math.sign(MOTION[av.particle].gravity));
    }
  });

  it('★ 区域越大撒得越多，但加在**每簇粒子数**上 —— 簇数是线性吃池槽的', () => {
    expect(groundFillPlanFor('snowflake', 12, 1).count)
      .toBeGreaterThan(groundFillPlanFor('snowflake', 2, 1).count);
    // 每簇不超过细流池的单格容量（超了会被 Burst.emit 静默钳掉）
    expect(groundFillPlanFor('snowflake', 40, 1).count).toBeLessThanOrEqual(32);
    expect(groundFillPlanFor('snowflake', 40, 1).clusters).toBeLessThanOrEqual(2);
  });

  it('低画质不发填充粒子、不画染色盘（边界环另有 essential 保证）', () => {
    const low = groundFillPlanFor('snowflake', 6, 0);
    expect(low.clusters).toBe(0);
    expect(low.count).toBe(0);
    expect(low.tintOpacity).toBe(0);
  });

  it('★ 单片区域并发槽 ≤ 6、三片合计 ≤ 18（细流池 48 = 蓄力 12 + 拖尾 18 + 地面 18）', () => {
    for (const d of [1, 0.5]) {
      for (const av of Object.values(ATTRIBUTE_VISUALS)) {
        const plan = groundFillPlanFor(av.particle, 12, d);
        const slots = Math.ceil(plan.life / plan.cadence) * plan.clusters;
        expect(slots).toBeLessThanOrEqual(6);
      }
    }
    expect(MAX_FILL_AREAS * 6).toBeLessThanOrEqual(18);
  });
});

describe('verticalTravel —— 参数错在单测里就红', () => {
  it('★★ 雪真的落得到地面：3.2 米生成高度，life 内至少落 2.5 米', () => {
    const snow = groundFillPlanFor('snowflake', 6, 1);
    const drop = verticalTravel(snow.gravity, snow.drag, snow.life);
    expect(drop).toBeLessThan(-2.5); // 向下为负
    // 也别穿到地底太深（穿过地面几米就成了「雪往地心钻」）
    expect(drop).toBeGreaterThan(-snow.spawnHeight - 2);
  });

  it('火的余烬真的升得起来（life 内上升 > 0.5 米）', () => {
    const fire = groundFillPlanFor('ember', 6, 1);
    expect(verticalTravel(fire.gravity, fire.drag, fire.life)).toBeGreaterThan(0.5);
  });

  it('零重力不产生位移；阻力越大位移越小', () => {
    expect(verticalTravel(0, 1, 1)).toBeCloseTo(0, 6);
    expect(Math.abs(verticalTravel(-3, 5, 1))).toBeLessThan(Math.abs(verticalTravel(-3, 0.2, 1)));
  });
});

describe('strongestShield —— 试验场与联网共用的唯一判据', () => {
  it('取剩余量最大的那一面盾', () => {
    const best = strongestShield([
      { auraId: 'a', absorbRemaining: 100, absorbInitial: 400 },
      { auraId: 'b', absorbRemaining: 250, absorbInitial: 250 },
    ]);
    expect(best?.auraId).toBe('b');
    expect(best?.remaining).toBe(250);
  });

  it('★ 多个盾不求和 —— 四态是按「这一面还剩几成」定义的', () => {
    const best = strongestShield([
      { auraId: 'a', absorbRemaining: 100, absorbInitial: 400 },
      { auraId: 'b', absorbRemaining: 250, absorbInitial: 250 },
    ]);
    expect(best?.remaining).not.toBe(350);
  });

  it('非吸收光环（没有 absorbRemaining）被跳过，空表返回 undefined', () => {
    expect(strongestShield([{ auraId: 'chill' }])).toBeUndefined();
    expect(strongestShield([{ auraId: 'x', absorbRemaining: 0 }])).toBeUndefined();
    expect(strongestShield([])).toBeUndefined();
  });

  it('initial 缺失时退到 remaining —— 不会算出 >100% 的剩余比例', () => {
    const best = strongestShield([{ auraId: 'a', absorbRemaining: 120 }]);
    expect(best?.initial).toBe(120);
  });
});

describe('visualForAuraId —— 护盾终于不再一律金色', () => {
  it('★ 冰盾是冰蓝、护心屏障是圣金（光环 id 就是技能 id）', () => {
    expect(visualForAuraId('mage.ice_barrier')).toBe(ATTRIBUTE_VISUALS.frost);
    expect(visualForAuraId('priest.power_word_shield')).toBe(ATTRIBUTE_VISUALS.holy);
  });

  it('三段式光环 id 取前两段查回技能', () => {
    expect(visualForAuraId('mage.blizzard.chill')).toBe(ATTRIBUTE_VISUALS.frost);
  });

  it('★ 查不回技能的系统光环返回 undefined —— 编一个颜色比不画更糟', () => {
    expect(visualForAuraId('control.root.x')).toBeUndefined();
    expect(visualForAuraId('nonsense')).toBeUndefined();
  });
});

describe('fizzlePlanFor', () => {
  it('★★ gravity 恒为负 —— 释放向上炸开，「泄了」必须向下垮掉', () => {
    for (const p of [0, 0.5, 1]) {
      expect(fizzlePlanFor(p).gravity).toBeLessThan(0);
    }
  });

  it('攒得越满泄得越明显', () => {
    expect(fizzlePlanFor(1).count).toBeGreaterThan(fizzlePlanFor(0).count);
    expect(fizzlePlanFor(1).speed).toBeGreaterThan(fizzlePlanFor(0).speed);
  });

  it('progress 越界不产生负数或 NaN', () => {
    for (const p of [-1, 2, Number.NaN]) {
      const plan = fizzlePlanFor(p);
      expect(Number.isFinite(plan.count)).toBe(true);
      expect(plan.count).toBeGreaterThan(0);
    }
  });
});

/**
 * ★★ 蓄力形态的个性化（用户实测反馈：施法过程八属性长得一模一样，
 *   战士/盗贼/猎人的物理技能之间也没有区分）。
 *
 *   这组断言钉的是**语义**不是数值手感：方向即含义（圣光从天上来、
 *   火苗往上冒）、物理不画奥术纹章、风格表不许触碰池预算的输入。
 */
describe('windupStyleOf —— 蓄力形态按属性/职业分化', () => {
  it('★ 八属性形态确实拉开了（不是一张表复制八行）', () => {
    const forms = new Set(
      Object.values(WINDUP_STYLES).map((s) => JSON.stringify(s)),
    );
    expect(forms.size).toBe(8);
  });

  it('★ 方向即语义：圣光自上而下、火/毒/暗影自下而上、雪微沉', () => {
    expect(WINDUP_STYLES.beam.origin).toBe('above');
    expect(WINDUP_STYLES.beam.lift).toBeLessThan(0);
    for (const k of ['ember', 'droplet', 'smoke'] as const) {
      expect(WINDUP_STYLES[k].origin).toBe('ground');
      expect(WINDUP_STYLES[k].lift).toBeGreaterThan(0);
    }
    expect(WINDUP_STYLES.snowflake.lift).toBeLessThan(0);
  });

  it('★ 物理不画奥术纹章 —— 拉弓抡刀的人脚下不该有法阵纹样', () => {
    expect(WINDUP_STYLES.spark.motif).toBe('none');
    for (const s of Object.values(PHYSICAL_WINDUP_STYLES)) {
      expect(s.motif).toBe('none');
    }
  });

  it('★★ 物理按职业细分：战士/盗贼/猎人三种蓄力互不相同，且都不同于法系', () => {
    const w = windupStyleOf('spark', 'warrior.mortal_strike');
    const r = windupStyleOf('spark', 'rogue.stealth');
    const h = windupStyleOf('spark', 'hunter.aimed_shot');
    const forms = new Set([w, r, h].map((s) => JSON.stringify(s)));
    expect(forms.size).toBe(3);
    // 猎人「屏息瞄准」收得最紧；盗贼的环反向转（与所有法系一眼可分）
    expect(h.radiusScale).toBeLessThan(w.radiusScale);
    expect(r.spinScale).toBeLessThan(0);
  });

  it('未知职业前缀 / 不传 skillId 回落到 spark 基础行（不抛不炸）', () => {
    expect(windupStyleOf('spark', 'somepet.bite')).toEqual(WINDUP_STYLES.spark);
    expect(windupStyleOf('spark')).toEqual(WINDUP_STYLES.spark);
    // 非物理属性不受 skillId 影响 —— 法师的技能不会因为 id 前缀变样
    expect(windupStyleOf('snowflake', 'mage.frostbolt')).toEqual(WINDUP_STYLES.snowflake);
  });

  it('★★ 风格表不触碰池预算的输入（cadence/life/count 只归 windupPlanFor 管）', () => {
    const allowed = new Set([
      'motif', 'motifScale', 'spinScale', 'origin', 'lift', 'drag', 'radiusScale',
    ]);
    for (const s of [...Object.values(WINDUP_STYLES), ...Object.values(PHYSICAL_WINDUP_STYLES)]) {
      for (const key of Object.keys(s)) expect(allowed.has(key), `意外字段 ${key}`).toBe(true);
    }
  });
});
