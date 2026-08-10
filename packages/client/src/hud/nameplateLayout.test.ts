/**
 * X18：姓名板三件小账。
 *
 *   ① 互相重叠无避让（12v12 实测 3 对重叠、血条压在别人名字上）
 *   ② 底部锚定导致读条出现/消失时整板上跳 6px（**点击热区在光标下移动**）
 *   ③ 4px 血条无数字、低血不变色（「谁进了斩杀线」看不出来）
 *
 * ★★ 三条里最要命的是 ②：姓名板是 5.2 的点击选中面，热区在光标底下
 *   来回跳意味着「点了没选中」——混战里那是玩家最难自己归因的一类失败。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NAMEPLATE_GAP_PX,
  NAMEPLATE_HEIGHT_PX,
  NAMEPLATE_LOW_HP,
  NAMEPLATE_MAX_LIFT_PX,
  NAMEPLATE_WIDTH_PX,
  isLowHealth,
  lowHealthColor,
  needsRelayout,
  stackNameplates,
  type NameplateSpot,
} from './nameplateLayout.js';
import { ColorblindMode, paletteFor } from '../settings/accessibility.js';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const INDEX_HTML = readSrc('../../index.html');
const COMBAT_HUD_SRC = readSrc('./CombatHud.ts');
/** ★ 跨包读源码：0.35 这条线在两个包里各有一份，本文件负责钉住它们同数 */
const BOT_SRC = readSrc('../../../shared/src/ai/botController.ts');

const spot = (id: number, x: number, y: number): NameplateSpot => ({ id, x, y });

/** 两块板错位之后的矩形还压不压在一起 */
const overlaps = (
  a: NameplateSpot,
  b: NameplateSpot,
  off: ReadonlyMap<number, number>,
): boolean =>
  Math.abs(a.x - b.x) < NAMEPLATE_WIDTH_PX
  && Math.abs((a.y - (off.get(a.id) ?? 0)) - (b.y - (off.get(b.id) ?? 0))) < NAMEPLATE_HEIGHT_PX;

describe('★★ X18① 姓名板互相避让', () => {
  it('★ 不重叠的板一动不动 —— 避让不该给站得开的人加戏', () => {
    const wide = stackNameplates([spot(1, 0, 100), spot(2, 300, 100)]);
    expect([...wide.values()]).toEqual([0, 0]);
    const tall = stackNameplates([spot(1, 0, 100), spot(2, 0, 400)]);
    expect([...tall.values()]).toEqual([0, 0]);
  });

  it('★★ 12v12 实测的那种重叠真的被分开了（三对压在一起）', () => {
    const spots = [
      spot(1, 400, 300), spot(2, 430, 306),
      spot(3, 700, 220), spot(4, 690, 232),
      spot(5, 900, 500), spot(6, 905, 505),
    ];
    const off = stackNameplates(spots);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        expect(overlaps(spots[i]!, spots[j]!, off), `${spots[i]!.id} 与 ${spots[j]!.id} 仍然重叠`)
          .toBe(false);
      }
    }
  });

  it('★ 推的是**刚好够**的量，不按固定档位跳出一个大空隙', () => {
    const a = spot(1, 0, 100);
    const b = spot(2, 0, 110);
    const off = stackNameplates([a, b]);
    const gap = Math.abs(a.y - (b.y - off.get(2)!));
    expect(gap).toBe(NAMEPLATE_HEIGHT_PX + NAMEPLATE_GAP_PX);
  });

  it('★ 抬高有上限 —— 抬到天上去的板比重叠更难认，还会被屏幕上沿剔掉', () => {
    const many = Array.from({ length: 10 }, (_, i) => spot(i + 1, 500, 300 + i));
    for (const v of stackNameplates(many).values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(NAMEPLATE_MAX_LIFT_PX);
    }
  });

  it('★★ 迟滞：只差几个像素不往回降（否则名字在抽搐），差得多才降', () => {
    const a = spot(1, 0, 100);
    const cold = stackNameplates([a, spot(2, 0, 110)]);
    const before = cold.get(2)!;
    expect(before).toBeGreaterThan(0);

    // ① 这一拍算出来只要少抬 4px（在迟滞阈值内）⇒ 维持原高度，不动
    const tiny = stackNameplates([a, spot(2, 0, 106)], cold);
    expect(tiny.get(2)).toBe(before);
    // 对照：同一步没有迟滞的话会降到 38
    expect(stackNameplates([a, spot(2, 0, 106)]).get(2)).toBe(before - 4);

    // ② 已经完全不压人了 ⇒ 该降就降，迟滞不是「粘住不放」
    expect(stackNameplates([a, spot(2, 0, 100 + NAMEPLATE_HEIGHT_PX + 40)], cold).get(2)).toBe(0);
  });

  it('★★ 名次对镜头微动不敏感 —— y 差几个像素时不许换人（那同样是抽搐的来源）', () => {
    /**
     * 两块板 y 只差 1px。纯按 y 排序的话，镜头稍一动名次就翻，
     * 于是「谁不动、谁被抬起来」每 50ms 换一次人 —— 玩家看到的是两个
     * 名字在互相跳。量化到 `NAMEPLATE_SORT_BUCKET_PX` 之后按 id 兜底：
     * 名次由 id 决定，与镜头无关。
     */
    const asc = stackNameplates([spot(1, 0, 100), spot(2, 0, 101)]);
    const flipped = stackNameplates([spot(1, 0, 101), spot(2, 0, 100)]);
    expect(asc.get(1)).toBe(0);
    expect(flipped.get(1), 'y 名次翻了，但不动的仍该是同一块板').toBe(0);
    expect(asc.get(2)).toBeGreaterThan(0);
    expect(flipped.get(2)).toBeGreaterThan(0);
  });

  it('★★ 省算：集合没变、位置只挪了几个像素 ⇒ 连算都不算（X10 点过名的 CPU）', () => {
    const prev = [spot(1, 0, 100), spot(2, 0, 110)];
    expect(needsRelayout(undefined, prev), '冷启动必须算').toBe(true);
    expect(needsRelayout(prev, [spot(1, 2, 101), spot(2, 1, 112)])).toBe(false);
    expect(needsRelayout(prev, [spot(1, 0, 100), spot(2, 0, 140)]), '挪远了要重算').toBe(true);
    expect(needsRelayout(prev, [spot(1, 0, 100)]), '有人走了要重算').toBe(true);
    expect(needsRelayout(prev, [spot(1, 0, 100), spot(9, 0, 110)]), '换了个人要重算').toBe(true);
  });

  it('★ 接线：避让只在 20Hz 那一拍算，位置仍然每帧跟镜头', () => {
    const fn = /private renderNameplates\([\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain('needsRelayout(this.lastPlateSpots, spots)');
    // 错位向**上**（板锚在头顶），且每帧照着上一次的结果摆位
    expect(fn).toContain('translate(${spot.x}px,${spot.y - lift}px)');
    // 被密度裁掉 / 跑出屏幕的板不参与避让 —— 看不见的人不该顶开看得见的板
    expect(fn).toContain('live.push({ spot: { id: key, x, y }, el, unit: e });');
  });
});

describe('★★ X18② 读条区常驻占位 —— 整块板不再上跳 6px', () => {
  it('★★ 姓名板永远输出 np-cast 节点，没读条时只加 idle', () => {
    const fn = /private renderNameplates\([\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn).toContain('<div class="np-cast${castCls}"');
    expect(fn).toContain("' idle'");
    // 老写法（有施法才把节点插进来）必须已经消失
    expect(fn).not.toMatch(/\$\{cast && castP \? `<div class="np-cast/);
  });

  it('★★ idle 用 visibility 而不是 display —— 这正是两者的区别', () => {
    expect(INDEX_HTML).toContain('.np-cast.idle { visibility: hidden; }');
    expect(INDEX_HTML).not.toContain('.np-cast.idle { display: none');
  });

  it('★ 低血百分比也不许改布局高度（否则等于换个地方再犯一次同样的错）', () => {
    expect(INDEX_HTML).toMatch(/\.np-pct \{ position: absolute;/);
  });
});

describe('★★ X18③ 低血变色 + 百分比小字', () => {
  it('★ 判据是 35%，与 bot 开保命键同一条线', () => {
    expect(NAMEPLATE_LOW_HP).toBe(0.35);
    expect(isLowHealth(34, 100)).toBe(true);
    expect(isLowHealth(35, 100), '等于 35% 还不算进斩杀线').toBe(false);
    expect(isLowHealth(36, 100)).toBe(false);
    // 死人不算低血（姓名板另有处理），maxHealth 为 0 不许除出 NaN
    expect(isLowHealth(0, 100)).toBe(false);
    expect(isLowHealth(1, 0)).toBe(false);
  });

  it('★★ 两处 0.35 是同一条线：bot 的 SURVIVAL_HEALTH 改了这里要一起改', () => {
    expect(BOT_SRC).toMatch(/SURVIVAL_HEALTH:\s*0\.35/);
  });

  it('★★ 低血色不能用 danger —— 四套色板里它与 hostile 是同一个值', () => {
    for (const mode of Object.values(ColorblindMode)) {
      const p = paletteFor(mode as ColorblindMode);
      expect(p.danger, `${mode}：danger 与 hostile 同值，敌人低血会一点都看不出来`)
        .toBe(p.hostile);
      // 所以低血走 neutral：它在两条阵营色之外，敌我两侧都明显
      expect(lowHealthColor(p)).toBe(p.neutral);
      expect(lowHealthColor(p)).not.toBe(p.hostile);
      expect(lowHealthColor(p)).not.toBe(p.friendly);
    }
  });

  it('★ 17.2 第二通道：变色的同时冒出百分比数字，不是只换个颜色', () => {
    const fn = /private renderNameplates\([\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(fn).toContain('isLowHealth(e.health, e.maxHealth)');
    expect(fn).toContain('lowHealthColor(p)');
    expect(fn).toContain('<b class="np-pct">${Math.round(hpPct)}%</b>');
  });
});
