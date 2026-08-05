/**
 * W7 键位持久化与重绑规则的纯逻辑（DOM 面板本体走 verify:m13 端到端，
 * 本仓库没有 jsdom —— 与 W9 面板测试同一条约束）。
 */

import { describe, expect, it } from 'vitest';
import { Action, DEFAULT_BINDINGS } from '../input/InputManager.js';
import {
  actionHoldingCode,
  loadBindings,
  makeRebindController,
  normalizeBindings,
  rebindWithSwap,
  saveBindings,
  type Bindings,
} from './keybindings.js';

/** 一组「可重绑」动作（= 面板精选表的子集就够测规则）*/
const REBINDABLE = new Set<Action>([Action.Trinket, Action.FlagInteract, Action.Jump]);

describe('W7 normalizeBindings：坏存档回落默认，不留「按不出来的」动作', () => {
  it('缺字段/空串/非字符串一律回落默认', () => {
    const b = normalizeBindings({
      [Action.Trinket]: 'KeyT',      // 有效，采用
      [Action.Jump]: '',             // 空串，回落
      [Action.FlagInteract]: 42,     // 非字符串，回落
      // Skill1 缺失，回落
    });
    expect(b[Action.Trinket]).toBe('KeyT');
    expect(b[Action.Jump]).toBe(DEFAULT_BINDINGS[Action.Jump]);
    expect(b[Action.FlagInteract]).toBe(DEFAULT_BINDINGS[Action.FlagInteract]);
    expect(b[Action.Skill1]).toBe(DEFAULT_BINDINGS[Action.Skill1]);
  });

  it('每个 Action 都有键 —— 不会因为存档缺项留下一个哑动作', () => {
    const b = normalizeBindings({});
    for (const a of Object.values(Action)) expect(b[a]).toBeTruthy();
  });
});

describe('W7 load/save 往返', () => {
  const fakeStorage = () => {
    const store: Record<string, string> = {};
    return {
      store,
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
  };

  it('★ 存了再读，改过的键留着', () => {
    const s = fakeStorage();
    const b = { ...DEFAULT_BINDINGS, [Action.Trinket]: 'KeyT' } as Bindings;
    saveBindings(s, b);
    expect(loadBindings(s)[Action.Trinket]).toBe('KeyT');
  });

  it('★ 没存过 → 默认表', () => {
    expect(loadBindings(fakeStorage())[Action.Jump]).toBe(DEFAULT_BINDINGS[Action.Jump]);
  });

  it('★ 存档是坏 JSON → 回落默认，不抛（坏存档不该让游戏打不开）', () => {
    const s = fakeStorage();
    s.store['wowpvp.keybindings.v1'] = '{不是 json';
    expect(() => loadBindings(s)).not.toThrow();
    expect(loadBindings(s)[Action.Jump]).toBe(DEFAULT_BINDINGS[Action.Jump]);
  });
});

describe('W7 rebindWithSwap：三种冲突处理', () => {
  const base = (): Bindings => ({ ...DEFAULT_BINDINGS });

  it('★ 目标键没人用 → 直接绑', () => {
    const r = rebindWithSwap(base(), Action.Trinket, 'KeyH', REBINDABLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bindings[Action.Trinket]).toBe('KeyH');
      expect(r.swappedWith).toBeUndefined();
    }
  });

  it('★★ 目标键被另一个可重绑动作占用 → 交换（无人变哑，无人抢键）', () => {
    // Jump=Space、Trinket=KeyR。把 Trinket 绑到 Space → 与 Jump 交换
    const r = rebindWithSwap(base(), Action.Trinket, 'Space', REBINDABLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.swappedWith).toBe(Action.Jump);
      expect(r.bindings[Action.Trinket]).toBe('Space');
      expect(r.bindings[Action.Jump]).toBe('KeyR'); // Jump 接过 Trinket 的旧键
    }
  });

  it('★★ 目标键被不可重绑动作（移动键）占用 → 拒绝，原表不动', () => {
    // KeyW = MoveForward，不在 REBINDABLE 里
    const before = base();
    const r = rebindWithSwap(before, Action.Trinket, 'KeyW', REBINDABLE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict).toBe(Action.MoveForward);
    // 原表逐位不变（纯函数不改入参）
    expect(before[Action.Trinket]).toBe(DEFAULT_BINDINGS[Action.Trinket]);
  });

  it('actionHoldingCode 找得到占用者、排除自己', () => {
    const b = base();
    expect(actionHoldingCode(b, 'Space', Action.Trinket)).toBe(Action.Jump);
    expect(actionHoldingCode(b, 'KeyR', Action.Trinket)).toBeUndefined(); // 自己不算
    expect(actionHoldingCode(b, 'KeyЫ', Action.Trinket)).toBeUndefined(); // 没人用
  });
});

describe('W7 makeRebindController：应用到 input + 落盘', () => {
  const fakeInput = () => {
    const bindings = { ...DEFAULT_BINDINGS } as Bindings;
    return {
      bindings,
      getBindings: () => bindings,
      rebind: (a: Action, c: string) => { bindings[a] = c; },
    };
  };
  const fakeStorage = () => {
    const store: Record<string, string> = {};
    return { store, setItem: (k: string, v: string) => { store[k] = v; } };
  };

  it('★★ 无冲突重绑：input 与 localStorage 都更新', () => {
    const input = fakeInput();
    const storage = fakeStorage();
    const ctl = makeRebindController(input, REBINDABLE, storage);
    const r = ctl.rebind(Action.Trinket, 'KeyH');
    expect(r.ok).toBe(true);
    expect(input.bindings[Action.Trinket]).toBe('KeyH');
    expect(JSON.parse(storage.store['wowpvp.keybindings.v1']!)[Action.Trinket]).toBe('KeyH');
  });

  it('★★ 交换重绑：被顶走的动作也落到新键并存盘', () => {
    const input = fakeInput();
    const storage = fakeStorage();
    const ctl = makeRebindController(input, REBINDABLE, storage);
    const r = ctl.rebind(Action.Trinket, 'Space');
    expect(r.ok && r.swappedWith).toBe(Action.Jump);
    expect(input.bindings[Action.Trinket]).toBe('Space');
    expect(input.bindings[Action.Jump]).toBe('KeyR');
    const saved = JSON.parse(storage.store['wowpvp.keybindings.v1']!);
    expect(saved[Action.Jump]).toBe('KeyR');
  });

  it('★ 冲突（移动键）→ 拒绝，input 与存盘都不动', () => {
    const input = fakeInput();
    const storage = fakeStorage();
    const ctl = makeRebindController(input, REBINDABLE, storage);
    const r = ctl.rebind(Action.Trinket, 'KeyW');
    expect(r.ok).toBe(false);
    expect(input.bindings[Action.Trinket]).toBe(DEFAULT_BINDINGS[Action.Trinket]);
    expect(storage.store['wowpvp.keybindings.v1']).toBeUndefined();
  });

  it('★ 恢复默认：全部回默认并存盘', () => {
    const input = fakeInput();
    const storage = fakeStorage();
    const ctl = makeRebindController(input, REBINDABLE, storage);
    ctl.rebind(Action.Trinket, 'KeyH');
    ctl.reset();
    expect(input.bindings[Action.Trinket]).toBe(DEFAULT_BINDINGS[Action.Trinket]);
    for (const a of Object.values(Action)) expect(input.bindings[a]).toBe(DEFAULT_BINDINGS[a]);
  });

  it('★ onChanged 每次改动都回调（供刷新技能栏 <kbd>）', () => {
    const input = fakeInput();
    let calls = 0;
    const ctl = makeRebindController(input, REBINDABLE, fakeStorage(), () => { calls++; });
    ctl.rebind(Action.Trinket, 'KeyH');
    ctl.reset();
    expect(calls).toBe(2);
    // 被拒的那次不回调
    ctl.rebind(Action.Trinket, 'KeyW');
    expect(calls).toBe(2);
  });
});
