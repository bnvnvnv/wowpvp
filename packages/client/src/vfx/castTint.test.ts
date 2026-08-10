/**
 * 法阵按技能换色/换形（`castTint.ts`）。规格书 14.1 / 14.2 / 17.2，P3 技能签名。
 *
 * ★★ 这批断言的重心不是「颜色变了」，而是**两头都要红**：
 *   差异变小要被发现（这次改动的起因：用户实测「施法的光环……
 *   现在似乎都是一样的」），差异越界也要被发现（14.2 属性→颜色的红线）。
 *   中间那条「去重数」的断言尤其重要 —— 第一版「乘 2 再钳」的写法
 *   把 108 个技能的法阵色从 90 种压成 52 种，只有这条量得出来。
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, asSkillId, getSkill, type SkillDef } from '@wowpvp/shared';
// ★ 灌入手写签名表 —— 断言要走**真实**路径（手写覆盖推导），
//   只测推导层等于放过了「手写值被曲线压塌」这一半风险
import '../av/signatures/index.js';
import { SCALE_CLAMP, TINT_CLAMP, resolveSignature } from '../av/skillSignature.js';
import {
  ATTRIBUTE_VISUALS,
  hueDistance,
  hueOf,
  hueShifted,
  tintedVisual,
  visualOf,
} from './schools.js';
import {
  CIRCLE_SCALE_GAIN,
  CIRCLE_TEETH,
  MOTIF_SCALE_GAIN,
  castCircleStyleOf,
  circleTeethOf,
  circleTintShift,
} from './castTint.js';
import { SpellVfx } from './SpellVfx.js';
import { vfxScaleOf } from './skillWeight.js';

const allSkills = (): SkillDef[] => ALL_CLASSES.flatMap((c) => c.skills);

/** 走一遍 SpellVfx 的真实路径：基色 → 叠签名 tint → 算法阵外观 */
const circleOf = (skill: SkillDef) => {
  const sig = resolveSignature(skill.id as string);
  return castCircleStyleOf(tintedVisual(visualOf(skill), sig.tintShift), sig, skill.id as string);
};

/** HSL 的后两位 —— 「属性还认得出来」的度量，与 vfx.test.ts 同一把尺子 */
const slOf = (color: number): { s: number; l: number } => {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  return { s: d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min)), l };
};

describe('castTint · 色相预算：撑到上限，一步都不越界', () => {
  it('★★ 曲线过后仍钳在 ±TINT_CLAMP —— 火技能不会被染成蓝色', () => {
    for (const t of [-9, -TINT_CLAMP, -0.03, 0, 0.03, TINT_CLAMP, 9]) {
      expect(Math.abs(circleTintShift(t))).toBeLessThanOrEqual(TINT_CLAMP + 1e-9);
    }
    for (const s of allSkills()) {
      const c = circleOf(s);
      expect(Math.abs(c.ringShift), `${s.name} 外圈色相越界`)
        .toBeLessThanOrEqual(TINT_CLAMP + 1e-9);
      expect(Math.abs(c.motifShift), `${s.name} 纹章色相越界`)
        .toBeLessThanOrEqual(TINT_CLAMP + 1e-9);
    }
  });

  it('★★ 全量 117 技能：法阵两层相对属性基色的色相位移 ≤ TINT_CLAMP', () => {
    for (const s of allSkills()) {
      const base = visualOf(s);
      const c = circleOf(s);
      expect(hueDistance(hueOf(c.ringColor), hueOf(base.primary)), `${s.name} 外圈`)
        .toBeLessThanOrEqual(TINT_CLAMP + 0.006); // 0.006 = 8 位量化误差
      expect(hueDistance(hueOf(c.motifColor), hueOf(base.secondary)), `${s.name} 纹章`)
        .toBeLessThanOrEqual(TINT_CLAMP + 0.006);
    }
  });

  it('★★ 只旋色相 —— 饱和度与明度逐位不动（14.2 的主辨识靠 S/L）', () => {
    /**
     * 神圣 40.5° 与物理 38.3° 的色相几乎重合，把它们分开的是 S/L。
     * 法阵一旦碰 S/L，神圣技能就可能褪成物理色 —— 那才是打穿 14.2 的那一刀。
     */
    for (const s of allSkills()) {
      const base = visualOf(s);
      const c = circleOf(s);
      const bp = slOf(base.primary);
      const gp = slOf(c.ringColor);
      expect(gp.s, `${s.name} 外圈饱和度被改`).toBeCloseTo(bp.s, 2);
      expect(gp.l, `${s.name} 外圈明度被改`).toBeCloseTo(bp.l, 2);
      const bs = slOf(base.secondary);
      const gs = slOf(c.motifColor);
      expect(gs.s, `${s.name} 纹章饱和度被改`).toBeCloseTo(bs.s, 2);
      expect(gs.l, `${s.name} 纹章明度被改`).toBeCloseTo(bs.l, 2);
    }
  });

  it('★ 补的是**差额**：等价于从属性基色一次转到 ringShift', () => {
    /**
     * `castCircleStyleOf` 收的是「已叠过 tintShift 的视觉」，内部补差额。
     * 破了就意味着法阵色偷偷多转了一次。
     *
     * ★ 比色相距离而不是比位：中间那一步要在 8 位 RGB 上落一次地。
     *   容差 0.015 而不是 0.006 是因为**近白的辅色**（冰霜 0xeaf6ff、
     *   神圣 0xfff6e0）色度只有 0.08 左右，1/255 的舍入在色环上就是近一度 ——
     *   这是颜色本身的性质，不是换算跑偏。真正管越界的是上面那两条。
     */
    for (const s of allSkills()) {
      const base = visualOf(s);
      const c = circleOf(s);
      expect(
        hueDistance(hueOf(c.ringColor), hueOf(hueShifted(base.primary, c.ringShift))),
        `${s.name} 外圈`,
      ).toBeLessThan(0.015);
      expect(
        hueDistance(hueOf(c.motifColor), hueOf(hueShifted(base.secondary, c.motifShift))),
        `${s.name} 纹章`,
      ).toBeLessThan(0.015);
    }
  });
});

describe('castTint · 差异化：法阵真的按技能不一样了', () => {
  it('★★ 曲线保序且单射 —— 两个不同的签名值不会塌成同一个法阵色', () => {
    /**
     * ★★ 这条就是「乘 2 再钳」翻车的地方：手写签名大多落在 0.03–0.07，
     *   乘 2 之后一律撞钳位，十二个圣骑士技能一起塌成 ±0.08 两个值。
     *   保序 + 单射是「放大差异」这件事的最低要求。
     */
    const xs: number[] = [];
    for (let i = -80; i <= 80; i++) xs.push(i / 1000);
    const ys = xs.map(circleTintShift);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]!, `${xs[i]} 处不再严格递增`).toBeGreaterThan(ys[i - 1]!);
    }
  });

  it('★★ 小值被抬起来（欠的是推导层的账，就只补推导层）', () => {
    // 推导层散列落在 ±0.04，预算是 ±0.08 —— 小的那几档差 1.8° 等于没差
    expect(circleTintShift(0.005) / 0.005).toBeGreaterThan(2.5);
    expect(circleTintShift(0.02) / 0.02).toBeGreaterThan(1.5);
    // 手写层已经接近上限，几乎不动 —— 抬它只会把它推到红线上
    expect(circleTintShift(0.07) / 0.07).toBeLessThan(1.1);
    expect(circleTintShift(TINT_CLAMP)).toBeCloseTo(TINT_CLAMP, 9);
  });

  it('★★ 外圈与纹章**反向**偏移 —— 同学派两个技能有两张脸', () => {
    for (const s of allSkills()) {
      const c = circleOf(s);
      expect(c.motifShift, `${s.name}`).toBeCloseTo(-c.ringShift, 9);
    }
  });

  it('★★ 同职业同属性的技能，法阵外圈颜色不许塌成一坨', () => {
    /**
     * 量的就是文件头那把尺子：按「职业 × 属性」分组数外圈颜色的去重数。
     * 现状 90/108；第一版「乘 2 再钳」是 52/108，正是这条会红。
     * 门槛取 0.7 —— 留出 8 位量化必然造成的少量撞色，
     * 但任何把差异整体压扁的改动都过不去。
     */
    let total = 0;
    let distinct = 0;
    for (const cls of ALL_CLASSES) {
      const groups = new Map<number, { n: number; colors: Set<number> }>();
      for (const s of cls.skills) {
        const key = visualOf(s).primary;
        let g = groups.get(key);
        if (!g) { g = { n: 0, colors: new Set() }; groups.set(key, g); }
        g.n += 1;
        g.colors.add(circleOf(s).ringColor);
      }
      for (const [key, g] of groups) {
        if (g.n < 3) continue; // 组太小说明不了问题
        total += g.n;
        distinct += g.colors.size;
        expect(
          g.colors.size,
          `${cls.id as string}/${key.toString(16)} 的 ${g.n} 个技能只有 ${g.colors.size} 种法阵色`,
        ).toBeGreaterThanOrEqual(Math.ceil(g.n * 0.55));
      }
    }
    expect(total, '没有任何一组够大到能验').toBeGreaterThan(60);
    expect(distinct / total, `全局去重率 ${distinct}/${total} 掉下来了`)
      .toBeGreaterThan(0.8);
  });

  it('★★ 非颜色通道：齿数在区间内、逐技能散得开、同一个技能永远同一个', () => {
    const counts = new Map<number, number>();
    for (const s of allSkills()) {
      const n = circleTeethOf(s.id as string);
      expect(n, `${s.name} 齿数越界`).toBeGreaterThanOrEqual(CIRCLE_TEETH.min);
      expect(n).toBeLessThanOrEqual(CIRCLE_TEETH.max);
      expect(Number.isInteger(n)).toBe(true);
      expect(circleTeethOf(s.id as string), '同一个技能齿数不稳定').toBe(n);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    // 七档全部用上；且没有哪一档吃掉一半以上（散列退化的信号）
    expect(counts.size).toBe(CIRCLE_TEETH.max - CIRCLE_TEETH.min + 1);
    for (const [n, c] of counts) {
      expect(c, `齿数 ${n} 占了 ${c}/${allSkills().length}`)
        .toBeLessThan(allSkills().length * 0.5);
    }
  });

  it('★ 齿数与色相不相关 —— 两条轴取的是散列的不同位段', () => {
    // 若相关，「齿多的技能颜色也总是偏暖」会被肉眼读成规律而不是身份
    const xs = allSkills().map((s) => circleTeethOf(s.id as string));
    const ys = allSkills().map((s) => circleOf(s).ringShift);
    const mean = (a: number[]): number => a.reduce((p, v) => p + v, 0) / a.length;
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < xs.length; i++) {
      cov += (xs[i]! - mx) * (ys[i]! - my);
      vx += (xs[i]! - mx) ** 2;
      vy += (ys[i]! - my) ** 2;
    }
    expect(Math.abs(cov / Math.sqrt(vx * vy))).toBeLessThan(0.25);
  });

  it('偏移 0 是干净基线：两层都不转，与改造前逐位相同', () => {
    const av = ATTRIBUTE_VISUALS.fire;
    const c = castCircleStyleOf(av, { tintShift: 0, scale: 1 });
    expect(c.ringColor).toBe(av.primary);
    expect(c.motifColor).toBe(av.secondary);
    expect(c.circleScale).toBe(1);
    expect(c.motifScale).toBe(1);
  });
});

describe('castTint · 规模轴：大招该更大，但不能把地面糊满', () => {
  it('★★ 法阵尺寸乘数衰减到 0.9–1.2（贴地的圆不能按 1.8 倍直乘）', () => {
    const small = castCircleStyleOf(ATTRIBUTE_VISUALS.fire, { tintShift: 0, scale: SCALE_CLAMP.min });
    const big = castCircleStyleOf(ATTRIBUTE_VISUALS.fire, { tintShift: 0, scale: SCALE_CLAMP.max });
    expect(small.circleScale).toBeCloseTo(1 + (SCALE_CLAMP.min - 1) * CIRCLE_SCALE_GAIN, 9);
    expect(big.circleScale).toBeCloseTo(1 + (SCALE_CLAMP.max - 1) * CIRCLE_SCALE_GAIN, 9);
    expect(small.circleScale).toBeGreaterThanOrEqual(0.9);
    expect(big.circleScale).toBeLessThanOrEqual(1.2);
    // 大招的确更大 —— 衰减不能衰成「没差别」
    expect(big.circleScale).toBeGreaterThan(small.circleScale * 1.25);
  });

  it('★ 纹章吃得更多（0.5）：「大招的印记更大」由中央符号说，不占地面', () => {
    expect(MOTIF_SCALE_GAIN).toBeGreaterThan(CIRCLE_SCALE_GAIN);
    const big = castCircleStyleOf(ATTRIBUTE_VISUALS.fire, { tintShift: 0, scale: SCALE_CLAMP.max });
    expect(big.motifScale).toBeGreaterThan(big.circleScale);
  });

  it('★ 越界与非有限值被夹回，不会算出 NaN 法阵（黑圈）', () => {
    const nan = castCircleStyleOf(ATTRIBUTE_VISUALS.frost, {
      tintShift: Number.NaN, scale: Number.NaN,
    });
    expect(nan.ringShift).toBe(0);
    expect(nan.circleScale).toBe(1);
    expect(nan.ringColor).toBe(ATTRIBUTE_VISUALS.frost.primary);
    expect(nan.teeth).toBeGreaterThanOrEqual(CIRCLE_TEETH.min);
    const huge = castCircleStyleOf(ATTRIBUTE_VISUALS.frost, { tintShift: 9, scale: 99 });
    expect(huge.ringShift).toBeCloseTo(TINT_CLAMP, 9);
    expect(huge.circleScale).toBeCloseTo(1 + (SCALE_CLAMP.max - 1) * CIRCLE_SCALE_GAIN, 9);
  });

  it('★ 同一个技能永远同一个法阵 —— 签名是身份不是随机装饰', () => {
    const s = allSkills()[0]!;
    expect(circleOf(s)).toEqual(circleOf(s));
  });
});

// ════════════════════════════════════════════════════════════════
//  接线：SpellVfx 真的消费了这一层
// ════════════════════════════════════════════════════════════════

/**
 * ★★ 上面全是纯函数断言 —— 换算对了不等于**画上去了**。
 *   P3 那次的教训正是这个形状：签名层测得很齐，可法阵那边
 *   一句 `ensureWindup` 把颜色定死在建节点那一刻，
 *   实际画面上「所有技能一个样」，而所有断言都是绿的。
 *   下面这组把 `SpellVfx` 真的跑起来，从场景图上把颜色读回来。
 */
describe('castTint · SpellVfx 接线', () => {
  const castOf = (skillId: string, id = 1) => ({
    id, skillId,
    position: { x: 0, y: 0, z: 0 },
    height: 2, yaw: 0, startedAt: 0, endsAt: 2,
  });
  const frame = (vfx: SpellVfx, casts: ReturnType<typeof castOf>[], now = 0.5): void => {
    vfx.frame(0.05, {
      quality: 'high', cameraDistance: 8, pointScale: 600, now,
      projectiles: [], grounds: [], casts,
    });
  };
  /** 从场景图里把法阵外圈的颜色捞出来（法阵是 renderOrder 3 的环）*/
  const ringColors = (vfx: SpellVfx): number[] => {
    const out: number[] = [];
    vfx.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.renderOrder === 3 && o.geometry.type !== 'PlaneGeometry') {
        out.push((o.material as THREE.MeshBasicMaterial).color.getHex());
      }
    });
    return out;
  };

  it('★★ 同学派两个技能的法阵外圈**不是同一个颜色**（用户点名的那句）', () => {
    const vfx = new SpellVfx();
    frame(vfx, [castOf('mage.frostbolt', 1), castOf('mage.blizzard', 2)]);
    const colors = ringColors(vfx);
    expect(colors).toHaveLength(2);
    expect(colors[0], '同为冰霜的两个技能法阵色仍然一模一样').not.toBe(colors[1]);
    vfx.dispose();
  });

  it('★★ 查不回技能的兜底路径也不越界（那条分支谁都不会去看）', () => {
    /**
     * ★ 纹章是这条分支上真正危险的那一层：`castCircleStyleOf` 补的是差额，
     *   喂它一份**没上色**的基色，纹章补出来的就是 `motifShift - tintShift`
     *   —— 最坏 0.16 色环，恰好把 14.2 的 ±0.08 预算打穿一倍。
     */
    // 挑一个推导偏移足够大的假 id —— 偏移接近 0 的话「有没有预上色」测不出来
    const fake = [...Array(64).keys()]
      .map((i) => `nosuch.skill${i}`)
      .find((id) => Math.abs(resolveSignature(id).tintShift) >= 0.03)!;
    const t = resolveSignature(fake).tintShift;
    const base = ATTRIBUTE_VISUALS.arcane; // 兜底属性

    const vfx = new SpellVfx();
    frame(vfx, [castOf(fake, 1)]);
    const ring = ringColors(vfx);
    expect(ring).toHaveLength(1);
    /**
     * 位移量必须**恰好**是 `circleTintShift(t)`。忘了预上色的话
     * 这里会是 `circleTintShift(t) - t`（外圈变小、纹章反过来变大到 0.16），
     * 两者差 0.03 以上，远超 8 位量化的 0.006。
     */
    expect(hueDistance(hueOf(ring[0]!), hueOf(base.primary)))
      .toBeCloseTo(Math.abs(circleTintShift(t)), 2);
    expect(Math.abs(circleTintShift(t))).toBeLessThanOrEqual(TINT_CLAMP + 1e-9);
    vfx.dispose();
  });

  it('★★ 同一个施法者换技能 → 法阵跟着换（此前颜色卡在第一个技能上）', () => {
    const vfx = new SpellVfx();
    frame(vfx, [castOf('mage.frostbolt', 7)]);
    const first = ringColors(vfx)[0]!;
    // ★ **不留空帧**地直接换技能 —— 正是靠差分兜住的那条路径
    frame(vfx, [castOf('mage.fireball', 7)]);
    const second = ringColors(vfx);
    expect(second, '换技能之后法阵不止一个 —— 旧的没被摘掉').toHaveLength(1);
    expect(second[0], '换技能法阵没换色').not.toBe(first);
    vfx.dispose();
  });

  it('★ 外圈仍是「一道连续的圆 + 外扩的齿」，齿数按技能不同', () => {
    const vfx = new SpellVfx();
    frame(vfx, [castOf('mage.frostbolt', 1), castOf('mage.blizzard', 2)]);
    const geos: THREE.BufferGeometry[] = [];
    vfx.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.renderOrder === 3 && o.geometry.type !== 'PlaneGeometry') {
        geos.push(o.geometry);
      }
    });
    expect(geos).toHaveLength(2);
    const verts = geos.map((g) => g.getAttribute('position').count);
    // 两个技能的齿数不同 → 合并后的顶点数不同（同齿数会相同，换一对就是了）
    expect(circleTeethOf('mage.frostbolt')).not.toBe(circleTeethOf('mage.blizzard'));
    expect(verts[0]).not.toBe(verts[1]);
    // 齿只外扩：包围球半径大于光秃圆环的 1.0
    for (const g of geos) {
      g.computeBoundingSphere();
      expect(g.boundingSphere!.radius).toBeGreaterThan(1);
    }
    vfx.dispose();
  });

  it('★★ 法阵尺寸 = 2.2 × 分量 × **签名规模**（后一项是这次新加的）', () => {
    /**
     * ★ 逐项算清楚而不是只比大小：只比大小的话，`ws`（分量）一个人就能
     *   让断言绿 —— 那是改造**前**就有的，等于没验到新加的这一项。
     *   陨星 `scale: 1.8` → 衰减后 1.2，霜矢没写 scale → 1.0。
     */
    const vfx = new SpellVfx();
    frame(vfx, [castOf('mage.frostbolt', 1), castOf('mage.meteor', 2)]);
    const scales = vfx.group.children
      // 蓄力法阵是唯一被摆平（rotation.x = -π/2）的 Group
      .filter((g): g is THREE.Group =>
        g instanceof THREE.Group && Math.abs(g.rotation.x + Math.PI / 2) < 1e-6)
      .map((g) => g.scale.x);
    expect(scales).toHaveLength(2);

    const expected = (id: string): number => {
      const skill = getSkill(asSkillId(id))!;
      const sig = resolveSignature(id);
      return 2.2 * vfxScaleOf(skill) * (1 + (sig.scale - 1) * CIRCLE_SCALE_GAIN);
    };
    expect(scales[0]).toBeCloseTo(expected('mage.frostbolt'), 6);
    expect(scales[1]).toBeCloseTo(expected('mage.meteor'), 6);
    // 陨星的签名规模是 1.8 —— 衰减后仍要留下看得见的 20%
    expect(resolveSignature('mage.meteor').scale).toBeGreaterThan(1.5);
    vfx.dispose();
  });
});
