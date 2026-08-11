/**
 * X17：目标框 / 自身框的光环行。
 *
 * ★★ 这一组钉的是**信息盲区被补上了**，而不是「有个好看的小图标」。
 *   在此之前「DoT 还剩几秒 / 有没有吸收盾 / 我的减益掉没掉」三件事
 *   只走战斗日志一条通道 —— 日志回答「刚才发生了什么」，
 *   回答不了「现在是什么状态」，而目标制 PVP 每一秒都在问后者。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HIDDEN_AURA_ID, School } from '@wowpvp/shared';

import {
  AURA_KIND_GLYPH,
  AURA_NEUTRAL_COLOR,
  AURA_ROW_MAX,
  auraIconUrl,
  auraRowHtml,
  auraRowModel,
  auraTimeText,
} from './auraRow.js';
import type { HudAura, HudUnit } from './CombatView.js';
import { BLOCKER_GLYPH } from './skillTooltip.js';
import { CONTROL_VISUALS } from '../vfx/status.js';
import { setRemoteIconsAvailable } from './skillIcon.js';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const INDEX_HTML = readSrc('../../index.html');
const COMBAT_HUD_SRC = readSrc('./CombatHud.ts');

const aura = (over: Partial<HudAura> = {}): HudAura => ({
  id: 'mage.frostbolt.chill',
  kind: 'debuff',
  expiresAt: 106,
  ...over,
});

describe('★★ X17 光环行：投影与掩码', () => {
  it('★★ 没接线时逐字节不变：auras 是可选字段，空行渲染成空串', () => {
    // 生产方（CombatDirector / 快照视图）还没填 auras ⇒ 这必须是一个合法状态，
    // 而不是编译错误、也不是一个停在那里的空控件（合同 C1 的 gcdRemaining 同手法）
    const unit: Pick<HudUnit, 'auras'> = {};
    expect(unit.auras).toBeUndefined();
    expect(auraRowModel(undefined, 100)).toEqual({ chips: [], overflow: 0 });
    expect(auraRowHtml(auraRowModel(undefined, 100))).toBe('');
    expect(auraRowHtml(auraRowModel([], 100))).toBe('');
  });

  it('★ 剩余秒数由 expiresAt 与 now 现算 —— 发事实，不发每 tick 都在变的 remaining', () => {
    expect(auraRowModel([aura({ expiresAt: 106 })], 100).chips[0]!.remaining).toBeCloseTo(6, 6);
    // 同一份数据、更晚的 now ⇒ 更少的剩余（快照被插值重读时不会越读越旧）
    expect(auraRowModel([aura({ expiresAt: 106 })], 104.5).chips[0]!.remaining).toBeCloseTo(1.5, 6);
    // 过期不给负数
    expect(auraRowModel([aura({ expiresAt: 106 })], 200).chips[0]!.remaining).toBe(0);
  });

  it('★★ persistent（潜行 / 德鲁伊形态）不画倒计时，而不是画一个不动的 0', () => {
    expect(auraRowModel([aura({ expiresAt: undefined })], 100).chips[0]!.remaining).toBeUndefined();
    expect(auraRowModel([aura({ expiresAt: Infinity })], 100).chips[0]!.remaining).toBeUndefined();
    expect(auraRowHtml(auraRowModel([aura({ expiresAt: Infinity })], 100)))
      .not.toContain('aura-left');
  });

  it('★★ S7 掩码（HIDDEN_AURA_ID）中性显示：不查学派、不查图标、不编名字', () => {
    // 服务器刚把「会泄露施加者职业」的 id 掩掉，客户端不能从旁边漏回去
    const row = auraRowModel(
      [{ id: HIDDEN_AURA_ID, kind: 'debuff', school: School.Frost, expiresAt: 104 }],
      100,
    );
    const chip = row.chips[0]!;
    expect(chip.kind, '掩码光环连是好是坏都不该断言').toBe('unknown');
    expect(chip.color, '给了 school 也不许用 —— 那就是把刚掩掉的东西漏回去')
      .toBe(AURA_NEUTRAL_COLOR);
    expect(chip.iconUrl).toBeUndefined();
    expect(auraIconUrl(HIDDEN_AURA_ID)).toBeUndefined();
    expect(chip.label).toContain('未知效果');
    expect(chip.label).not.toContain('frost');
  });

  it('★ 排序：减益在前、快到期的在前、掩码垫底', () => {
    const row = auraRowModel(
      [
        { id: 'b.long', kind: 'buff', expiresAt: 200 },
        { id: HIDDEN_AURA_ID, kind: 'debuff', expiresAt: 101 },
        { id: 'd.slow', kind: 'debuff', expiresAt: 130 },
        { id: 'd.dot', kind: 'debuff', expiresAt: 103 },
      ],
      100,
    );
    expect(row.chips.map((c) => c.id)).toEqual(['d.dot', 'd.slow', 'b.long', HIDDEN_AURA_ID]);
  });

  it('★ 截断不是悄悄丢掉：超出上限的收成一个 +N', () => {
    const many = Array.from(
      { length: AURA_ROW_MAX + 3 },
      (_, i) => aura({ id: `d.${i}`, expiresAt: 110 + i }),
    );
    const row = auraRowModel(many, 100);
    expect(row.chips).toHaveLength(AURA_ROW_MAX);
    expect(row.overflow).toBe(3);
    expect(auraRowHtml(row)).toContain('>+3<');
    // 刚好装得下时不出 +N
    const exact = auraRowModel(many.slice(0, AURA_ROW_MAX), 100);
    expect(exact.overflow).toBe(0);
    expect(auraRowHtml(exact)).not.toContain('aura more');
  });

  it('★ 14.3 护盾：格子上带一条随剩余吸收量退下去的条', () => {
    const row = auraRowModel([aura({ kind: 'buff', absorbRemaining: 300, absorbInitial: 1200 })], 100);
    expect(row.chips[0]!.absorbPct).toBeCloseTo(0.25, 6);
    expect(auraRowHtml(row)).toContain('class="aura-abs" style="height:25%"');
    // 非护盾不画（不是画一条 0% 的假条）
    expect(auraRowModel([aura()], 100).chips[0]!.absorbPct).toBeUndefined();
    expect(auraRowHtml(auraRowModel([aura()], 100))).not.toContain('aura-abs');
  });

  it('★ 叠层：1 层不印数字，多层才印', () => {
    expect(auraRowHtml(auraRowModel([aura({ stacks: 1 })], 100))).not.toContain('aura-stk');
    expect(auraRowHtml(auraRowModel([aura({ stacks: 5 })], 100))).toContain('>5<');
  });
});

describe('★★ X17 光环行：17.2 的双通道与转义', () => {
  it('★★ 增益 / 减益既有边框色也有字形，且三个字形与仓库里另外三张表不撞', () => {
    const glyphs = Object.values(AURA_KIND_GLYPH);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    for (const g of glyphs) {
      // 同一个符号两个意思，是最难查的那一类 UI 缺陷
      expect(Object.values(BLOCKER_GLYPH)).not.toContain(g);
      expect(Object.values(CONTROL_VISUALS).map((v) => v.glyph)).not.toContain(g);
      expect(['▲', '◆'], '姓名板/目标框的阵营前缀').not.toContain(g);
    }
    const html = auraRowHtml(auraRowModel([aura(), aura({ id: 'x.buff', kind: 'buff' })], 100));
    expect(html).toContain('class="aura debuff"');
    expect(html).toContain('class="aura buff"');
    expect(html).toContain(AURA_KIND_GLYPH.buff);
    expect(html).toContain(AURA_KIND_GLYPH.debuff);
    // 边框色由 CSS 按 class 给 —— 颜色之外还有 class 与字形两条通道
    expect(INDEX_HTML).toContain('.aura.buff { border-color: var(--c-friendly); }');
    expect(INDEX_HTML).toContain('.aura.debuff { border-color: var(--c-hostile); }');
  });

  it('★ 时间排版：10 秒以内给一位小数（DoT 收尾那两秒值钱），以上取整', () => {
    expect(auraTimeText(2.34)).toBe('2.3');
    expect(auraTimeText(9.99)).toBe('10.0');
    expect(auraTimeText(12.4)).toBe('12');
    expect(auraTimeText(75)).toBe('2m');
  });

  it('★ 转义不漏：光环 id / 名字里的尖括号撑不破这一行', () => {
    const html = auraRowHtml(auraRowModel([aura({ id: '<img src=x>', name: '"坏"' })], 100));
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});

describe('★ X17 光环行：图标来源', () => {
  it('★ 光环 id 去掉最后一段能落到技能图标上，落不到就回落色块', () => {
    // mage.frostbolt.chill → mage.frostbolt（图标表里有）
    expect(auraIconUrl('mage.frostbolt.chill')).toBe(auraIconUrl('mage.frostbolt'));
    expect(auraIconUrl('mage.frostbolt')).toContain('/art/ui/skills/');
    // control.<kind> 被 sim 统一改写过，反查不回技能 —— 回落色块而不是猜一张图
    expect(auraIconUrl('control.stun')).toBeUndefined();
    expect(auraIconUrl('nope')).toBeUndefined();
  });

  it('★★ X26 正面用例：id 反查不回技能的那四条，靠注册表拿到了正确的图标', () => {
    // 此前它们在光环行上是**光秃秃的色块** —— 玩家被致死打击的重伤咬着
    // 和被油腻地面绊住，看到的是同一个灰格子
    const pairs: readonly [string, string][] = [
      ['warrior.mortal_wounds', 'warrior.mortal_strike'],
      ['deathknight.winter_domain_chill', 'deathknight.winter_domain'],
      ['ffa.greasy', 'ffa.drumstick_volley'],
      ['ffa.stardust', 'ffa.starfall'],
    ];
    for (const [auraId, skillId] of pairs) {
      expect(auraIconUrl(auraId), `${auraId} 还是没图标`).toBe(auraIconUrl(skillId));
      expect(auraIconUrl(auraId)).toContain('/art/ui/skills/');
    }
  });

  it('★★ 原样查排在注册表前面：`rogue.stealth` 要的是潜行那张图，不是消失', () => {
    // 潜行与消失施加同一枚光环，注册表按先来先得只记得住一个技能 ——
    // 名字对得上的那张图永远最准，所以第一级台阶是「原样查」
    expect(auraIconUrl('rogue.stealth')).toBe(auraIconUrl('rogue.stealth'));
    expect(auraIconUrl('rogue.stealth')).not.toBe(auraIconUrl('rogue.vanish'));
  });

  it('★★ 素材没探测通过时一律走色块 —— 不许每秒发几十个注定 404 的 <img>', () => {
    setRemoteIconsAvailable(false);
    expect(auraRowModel([aura()], 100).chips[0]!.iconUrl).toBeUndefined();
    expect(auraRowHtml(auraRowModel([aura()], 100))).not.toContain('<img');
    setRemoteIconsAvailable(true);
    expect(auraRowModel([aura()], 100).chips[0]!.iconUrl).toBeDefined();
    setRemoteIconsAvailable(false); // 还原：出厂默认就是 false
  });
});

describe('★★ X17 接线：三处光环行同一份实现', () => {
  it('★★ 目标框 / 焦点框 / 自身都调同一对函数', () => {
    // 目标框与焦点框共用 renderUnitFrame，自身走 renderSelfAuras
    const frame = /private renderUnitFrame\([\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain('auraRowHtml(auraRowModel(unit.auras, dir.now))');
    const self = /private renderSelfAuras\([\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(self.length).toBeGreaterThan(0);
    expect(self).toContain('auraRowHtml(auraRowModel(dir.player.auras, dir.now))');
  });

  it('★ 自身那块出厂 display:none —— 没接线时默认路径一个像素都不变', () => {
    expect(COMBAT_HUD_SRC).toContain('<div id="self-auras" style="display:none"></div>');
    expect(COMBAT_HUD_SRC).toContain("this.selfAuras.style.display = html === '' ? 'none' : '';");
    expect(INDEX_HTML).toContain('#self-auras {');
  });

  it('★ 光环行在 20Hz 那一拍重建，不是每帧（X10 点过名：HUD 的 DOM 是 CPU 嫌疑人）', () => {
    const update = /\n {2}update\(dir: CombatView[\s\S]*?\n {2}\}/.exec(COMBAT_HUD_SRC)?.[0] ?? '';
    expect(update).toContain('if (!full) return;');
    // renderSelfAuras 在 `if (!full) return` 之后 —— 与目标框、技能栏同一拍
    expect(update.indexOf('this.renderSelfAuras(dir)'))
      .toBeGreaterThan(update.indexOf('if (!full) return;'));
  });
});
