/**
 * P10 大厅可用性修复的纯逻辑面。
 *
 * 本仓库没有 jsdom（见 settingsPanel.test.ts 同一条约束），所以 DOM 装配走
 * verify:m13 / 真机复验，这里只钉住**会悄悄变成谎话**的那几条：
 *   · 职业定位小字必须与 shared 的职业数据一致（手写文案 = 迟早的谎言）
 *   · 「开始练习」的 URL 必须带 &grace，而验收脚本那条 ?testbed 路不带
 *   · 新手教学未完成态说的是玩家没通关，不是功能没做完
 */

import { describe, expect, it } from 'vitest';
import { ALL_CLASSES, CastKind, getClass } from '@wowpvp/shared';

import {
  DEFAULT_PRACTICE_CLASS,
  classTagline,
  offlineToast,
  practiceUrl,
  tutorialLabel,
} from './LobbyShell.js';

describe('P10-1 连不上服务器时标题页也要说话', () => {
  it('★ 提示里带服务器地址 —— 端口/主机填错是自建服务器最常见的失败', () => {
    const text = offlineToast('ws://192.168.1.9:8080');
    expect(text).toContain('ws://192.168.1.9:8080');
  });

  it('★ 同时给出此刻就能玩的两条单机路（不是只说一句「失败」）', () => {
    const text = offlineToast('ws://localhost:8080');
    expect(text).toContain('练习场');
    expect(text).toContain('新手教学');
  });
});

describe('P10-3 职业定位小字（全部由职业数据算出）', () => {
  it('八个职业都有一行小字，且是三段/两段的短句', () => {
    for (const c of ALL_CLASSES) {
      const line = classTagline(c);
      expect(line.length, `${c.name} 的小字为空`).toBeGreaterThan(3);
      expect(line, `${c.name} 的小字没有分段`).toContain(' · ');
      expect(line, `${c.name} 的小字里漏了 undefined`).not.toContain('undefined');
    }
  });

  it('★★ 远近说法与 autoAttack.ranged 一致 —— 界面不许对实现撒谎', () => {
    for (const c of ALL_CLASSES) {
      const line = classTagline(c);
      const said = line.startsWith('远程') ? true : line.startsWith('近战') ? false : null;
      expect(said, `${c.name}「${line}」没说清远近`).not.toBeNull();
      expect(said, `${c.name}「${line}」与 autoAttack.ranged=${c.autoAttack.ranged} 矛盾`)
        .toBe(c.autoAttack.ranged);
    }
  });

  it('★★ 节奏说法与非瞬发技能数一致（说「全瞬发」的必须一个读条都没有）', () => {
    for (const c of ALL_CLASSES) {
      const line = classTagline(c);
      const casts = c.skills.filter((s) => s.cast.kind !== CastKind.Instant).length;
      if (line.includes('全瞬发')) {
        expect(casts, `${c.name} 号称全瞬发，实际有 ${casts} 个非瞬发技能`).toBe(0);
      } else {
        expect(casts, `${c.name} 号称有读条，实际一个都没有`).toBeGreaterThan(0);
      }
      // 三档必须落在其中之一 —— 漏档等于小字变成半句话
      expect(
        ['全瞬发', '少量读条', '依赖读条'].some((tag) => line.includes(tag)),
        `${c.name}「${line}」没有节奏那一段`,
      ).toBe(true);
    }
  });

  it('定位词取自 role 第一段，且不把「近战」说两遍', () => {
    const warrior = getClass('warrior' as never)!;
    // 战士 role = 「近战压制、…」→ 头一段自己就说了近战，不再前缀一次
    expect(classTagline(warrior)).toBe('近战压制 · 全瞬发');
  });
});

describe('P10-3 练习场默认职业', () => {
  it('★ 默认是展示顺序第一位的战士（原来是第 6 位的法师）', () => {
    expect(DEFAULT_PRACTICE_CLASS).toBe('warrior');
    expect(DEFAULT_PRACTICE_CLASS).toBe(ALL_CLASSES[0]!.id as string);
  });

  it('★ 默认职业必须是「零读条」的那种 —— 第一次玩不该先撞打断', () => {
    const cls = getClass(DEFAULT_PRACTICE_CLASS as never)!;
    expect(cls.skills.filter((s) => s.cast.kind !== CastKind.Instant)).toHaveLength(0);
  });
});

describe('P10-4 新手教学文案', () => {
  it('⚠️ 未完成态说的是玩家没通关，不是功能没做完', () => {
    expect(tutorialLabel(false)).not.toContain('尚未完成');
    expect(tutorialLabel(false)).toContain('未通关');
  });

  it('完成态仍然邀请重温', () => {
    expect(tutorialLabel(true)).toContain('已完成');
    expect(tutorialLabel(true)).toContain('可重温');
  });
});

describe('P10-6 / 合同 C8 练习场 URL', () => {
  it('★ 大厅入口带 &grace（新手缓冲开关）', () => {
    expect(practiceUrl('/', 'warrior', 'normal')).toBe(
      '/?testbed&combat&class=warrior&bot=normal&grace',
    );
  });

  it('★ 既有参数一个不少、次序不变（?testbed&combat&class&bot）', () => {
    const url = practiceUrl('/index.html', 'mage', 'hard');
    expect(url.startsWith('/index.html?testbed&combat&class=mage&bot=hard')).toBe(true);
  });

  it('职业/难度都过编码 —— URL 拼装不接受意外字符', () => {
    expect(practiceUrl('/', 'a b', 'x&y')).toBe('/?testbed&combat&class=a%20b&bot=x%26y&grace');
  });
});

