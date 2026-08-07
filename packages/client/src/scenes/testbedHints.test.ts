/**
 * P10：底部操作提示条（C7）与 `#help` 战斗段的**文案生成**。
 *
 * ★★ 这里验的全是同一条纪律：**界面写出来的键必须真的能按**。
 *   被这一轮改掉的两处撒谎都是「文案写死、机制会变」的产物：
 *     · `#help` 写着「1–8 释放技能」，技能栏其实是 9 格；
 *     · `#help` 战斗段列的是法师技能，`?class=warrior` 之后整段全错。
 *   写死的文案没有任何机制会随职业/重绑更新 —— 所以断言的对象不是
 *   「文案长什么样」，而是「换了绑定/换了技能栏，它跟不跟着变」。
 *
 * ★ 只测纯函数：DOM 装配（SceneShell.showHintBar / main.ts 注入）本仓库
 *   没有 jsdom 测不了 —— 与 W9 设置面板、大厅纯逻辑同一条约束。
 */

import { describe, expect, it } from 'vitest';
import { mage, warrior } from '@wowpvp/shared';
import { Action, DEFAULT_BINDINGS } from '../input/InputManager.js';
import { combatHelpHtml, hintBarHtml } from './TestbedScene.js';

/**
 * 去掉标签只看文字 —— 断言的是玩家**读到**的那句话。
 * ★ 标签换成空格而不是删掉：`<kbd>1</kbd><td>霜矢` 直接删标签会粘成「1霜矢」，
 *   那样「键 + 技能名」是不是同一行就断言不出来了。
 */
const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const bindings = (over: Partial<Record<Action, string>> = {}): Record<Action, string> =>
  ({ ...DEFAULT_BINDINGS, ...over });

describe('C7 底部提示条', () => {
  it('默认键位下的一整句', () => {
    // ★ 写「Escape」不写「Esc」：键名一律走 prettyKey，与 F10 键位表里
    //   那一行**逐字一致** —— 两处叫法不同，玩家会以为是两颗键
    expect(text(hintBarHtml(bindings()))).toBe(
      'Tab 选目标 · 1–9 技能 · Escape 取消读条 · 左右键同按 向前跑 · K 实战模式 · F10 设置与键位',
    );
  });

  it('★ 说的是 1–9 而不是 1–8 —— 技能栏九格，第 9 格也有键', () => {
    const t = text(hintBarHtml(bindings()));
    expect(t).toContain('1–9');
    expect(t).not.toContain('1–8');
  });

  it('★★ 重绑之后跟着变：改了选目标键就不许再写 Tab', () => {
    const t = text(hintBarHtml(bindings({ [Action.TargetNext]: 'KeyT' })));
    expect(t).toContain('T 选目标');
    expect(t).not.toContain('Tab 选目标');
  });

  it('★★ 技能键不连号时逐个列出，不缩写成撒谎的区间', () => {
    // 把第 5 格换到 F5：1–9 这个区间从此不成立
    const t = text(hintBarHtml(bindings({ [Action.Skill5]: 'F5' })));
    expect(t).not.toContain('1–9');
    expect(t).toContain('1/2/3/4/F5/6/7/8/9 技能');
  });

  it('F10 与实战模式键都来自绑定表（提示条是 F10 的唯一入口）', () => {
    const t = text(hintBarHtml(bindings({
      [Action.OpenSettings]: 'F9', [Action.ToggleCombatMode]: 'KeyJ',
    })));
    expect(t).toContain('F9 设置与键位');
    expect(t).toContain('J 实战模式');
  });
});

describe('#help 战斗段从真实技能栏生成', () => {
  it('★★ 换职业就换内容：战士那栏里不会出现法师技能', () => {
    const html = combatHelpHtml(warrior.skills.slice(0, 9), bindings());
    for (const s of warrior.skills.slice(0, 9)) expect(html).toContain(s.name);
    // 写死的那份列的是火球术/冰霜新星/变形术，战士身上一个都不该有
    expect(html).not.toContain(mage.skills[0]!.name);
  });

  it('第 N 键 = 第 N 格技能，且顺序与技能栏一致', () => {
    const skills = mage.skills.slice(0, 9);
    const rows = combatHelpHtml(skills, bindings())
      .split('<tr>').slice(1)
      .map((r) => text(r));
    // 前三行是选目标/点击选中/焦点，技能行从第 4 行起
    const skillRows = rows.slice(3, 3 + skills.length);
    expect(skillRows.map((r) => r.replace(/^(\S+)\s.*$/, '$1')))
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(skillRows[0]).toContain(skills[0]!.name);
    expect(skillRows[8]).toContain(skills[8]!.name);
  });

  it('★ 地面技能标出「要选落点」—— 这是按下之后必须先知道的一步', () => {
    const ground = mage.skills.find((s) => s.targeting === 'ground')!;
    expect(combatHelpHtml([ground], bindings())).toContain('落点预览');
  });

  it('★ 超出九格的技能不列 —— 没有键可按，列出来就是撒谎', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      name: `技能${i + 1}`, targeting: 'direct', range: { max: 30 },
    }));
    const html = combatHelpHtml(many, bindings());
    expect(html).toContain('技能9');
    expect(html).not.toContain('技能10');
  });

  it('★★ 重绑之后跟着变：Esc 换成别的键，取消读条那行也要跟着换', () => {
    const html = combatHelpHtml(
      mage.skills.slice(0, 9),
      bindings({ [Action.CancelCast]: 'Backquote', [Action.Skill1]: 'KeyZ' }),
    );
    expect(text(html)).toContain('Backquote 取消瞄准 / 取消读条');
    expect(text(html)).toContain(`Z ${mage.skills[0]!.name}`);
  });

  it('技能名里的尖括号被转义（HTML 直接塞进 innerHTML）', () => {
    const html = combatHelpHtml(
      [{ name: '<b>x</b>', targeting: 'direct', range: { max: 5 } }],
      bindings(),
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
