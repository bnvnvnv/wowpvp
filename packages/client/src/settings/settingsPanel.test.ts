/**
 * W9 设置面板的纯逻辑部分。DOM 面板本体走 verify:m13 的端到端断言
 * （本仓库没有 jsdom —— 与死亡回顾折叠、大厅纯逻辑同一条约束）。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BINDINGS } from '../input/InputManager.js';
import { ACTION_LABELS, prettyKey } from './SettingsPanel.js';

describe('W9 键位表（只读展示）', () => {
  it('键名按玩家习惯显示（code → 可读键名）', () => {
    expect(prettyKey('KeyW')).toBe('W');
    expect(prettyKey('Digit1')).toBe('1');
    expect(prettyKey('AltLeft')).toBe('Alt');
    expect(prettyKey('ShiftTab')).toBe('Shift+Tab');
    expect(prettyKey('F10')).toBe('F10');
    expect(prettyKey('Space')).toBe('Space');
    expect(prettyKey('Escape')).toBe('Escape');
  });

  it('★ 精选清单里的每一项都是真 Action 且不重复 —— 表是手写的，防拼错', () => {
    const seen = new Set<string>();
    for (const { action, label } of ACTION_LABELS) {
      expect(DEFAULT_BINDINGS[action], `「${label}」指向未知动作 ${action}`).toBeDefined();
      expect(seen.has(action), `动作 ${action} 在表里出现了两次`).toBe(false);
      seen.add(action);
    }
  });
});
