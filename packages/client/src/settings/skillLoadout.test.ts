/**
 * 技能栏持久化（P3c）。镜像 keybindings.test.ts 的口径：
 * 坏存档的每一种坏法都要回落默认、不炸，而且**默认 = 今天的行为**
 * （verify-m1..m4 跑在无 localStorage 的上下文里，默认路径逐字节不变）。
 */

import { describe, expect, it } from 'vitest';
import {
  assignSlot,
  loadSkillBar,
  normalizeSkillBar,
  saveSkillBar,
  SKILL_BAR_STORAGE_KEY,
} from './skillLoadout.js';

const DEFAULTS = ['a.one', 'a.two', 'a.three', 'a.four'] as const;
const CLASS_SKILLS = new Set([...DEFAULTS, 'a.five', 'a.six']);

/** 内存版 storage —— 与 keybindings 测试同法，不碰真 localStorage */
const memStorage = (initial: Record<string, string> = {}) => {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
};

describe('normalizeSkillBar：逐格校验，坏一格只落一格', () => {
  it('★★ 完整合法的存档原样通过', () => {
    const bar = ['a.five', 'a.one', 'a.six', 'a.two'];
    expect(normalizeSkillBar(bar, DEFAULTS, CLASS_SKILLS)).toEqual(bar);
  });

  it('★★ 外职业技能回落默认，其余格保留', () => {
    const bar = ['b.hostile', 'a.one', 'a.six', 'a.two'];
    // 第 0 格非法 → 从默认序列补第一个没被用的（a.three）
    expect(normalizeSkillBar(bar, DEFAULTS, CLASS_SKILLS))
      .toEqual(['a.three', 'a.one', 'a.six', 'a.two']);
  });

  it('★★ 重复技能只认第一次，后面的格子回落', () => {
    const bar = ['a.one', 'a.one', 'a.one', 'a.one'];
    expect(normalizeSkillBar(bar, DEFAULTS, CLASS_SKILLS))
      .toEqual(['a.one', 'a.two', 'a.three', 'a.four']);
  });

  it('★ 缺格 / 超长都强制回到默认长度', () => {
    expect(normalizeSkillBar(['a.five'], DEFAULTS, CLASS_SKILLS))
      .toEqual(['a.five', 'a.one', 'a.two', 'a.three']);
    expect(normalizeSkillBar([...DEFAULTS, 'a.five', 'a.six'], DEFAULTS, CLASS_SKILLS))
      .toEqual([...DEFAULTS]);
  });

  it('★ 非数组 / 数字混入 → 全部回落默认', () => {
    expect(normalizeSkillBar('oops', DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
    expect(normalizeSkillBar([1, null, {}, []], DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
  });

  it('★★ 默认技能被挪位后，补位不造重复（默认第 1 格在第 3 格 → 第 1 格补下一个）', () => {
    const bar = [null, 'a.two', 'a.one', null];
    expect(normalizeSkillBar(bar, DEFAULTS, CLASS_SKILLS))
      .toEqual(['a.three', 'a.two', 'a.one', 'a.four']);
  });
});

describe('loadSkillBar / saveSkillBar：坏存档回落，多职业共存', () => {
  it('★★ 没有存档 → 返回默认（verify 脚本走的就是这条路）', () => {
    expect(loadSkillBar(undefined, 'a', DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
    expect(loadSkillBar(memStorage(), 'a', DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
  });

  it('★★ 坏 JSON → 默认，不炸', () => {
    const st = memStorage({ [SKILL_BAR_STORAGE_KEY]: '{oops' });
    expect(loadSkillBar(st, 'a', DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
  });

  it('★★ 存了再读，逐字回来；别的职业的自定义不被抹掉', () => {
    const st = memStorage();
    saveSkillBar(st, 'a', ['a.five', 'a.one', 'a.six', 'a.two']);
    saveSkillBar(st, 'b', ['b.x', 'b.y']);
    expect(loadSkillBar(st, 'a', DEFAULTS, CLASS_SKILLS))
      .toEqual(['a.five', 'a.one', 'a.six', 'a.two']);
    const record = JSON.parse(st.dump()[SKILL_BAR_STORAGE_KEY]!) as Record<string, unknown>;
    expect(record['b']).toEqual(['b.x', 'b.y']);
  });

  it('★ 存档整体是坏 JSON 时保存会整份重建（读侧同纪律）', () => {
    const st = memStorage({ [SKILL_BAR_STORAGE_KEY]: '[[[' });
    saveSkillBar(st, 'a', [...DEFAULTS]);
    expect(loadSkillBar(st, 'a', DEFAULTS, CLASS_SKILLS)).toEqual([...DEFAULTS]);
  });
});

describe('assignSlot：交换语义（与键位重绑同哲学）', () => {
  it('★★ 指派一个不在栏上的技能 → 直接落格', () => {
    expect(assignSlot(['a.one', 'a.two'], 1, 'a.five')).toEqual(['a.one', 'a.five']);
  });

  it('★★ 指派已在别的格的技能 → 两格交换，无空格、无重复', () => {
    expect(assignSlot(['a.one', 'a.two', 'a.three'], 0, 'a.three'))
      .toEqual(['a.three', 'a.two', 'a.one']);
  });

  it('★ 指派到自己所在的格 = 不变', () => {
    expect(assignSlot(['a.one', 'a.two'], 0, 'a.one')).toEqual(['a.one', 'a.two']);
  });

  it('★ 越界槽位不动原栏（纯函数，返回副本）', () => {
    const bar = ['a.one', 'a.two'];
    expect(assignSlot(bar, 9, 'a.five')).toEqual(bar);
  });
});
