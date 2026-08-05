/**
 * 键位持久化与重绑规则（技术债总账 W7）。规格书 17.2「全键位可重绑」。
 *
 * ★★ 在此之前 `InputManager.rebind()` / `getBindings()` **全仓零调用方**，
 *   也没有任何持久化：键位事实上不可重绑，而 17.2 明文要求可重绑
 *   （非 QWERTY 布局、单手玩家、无障碍都被这一条挡在门外）。数据层
 *   （`InputManager` 的运行时重绑）当时就在，缺的是持久化 + UI + 接线。
 *
 * ★ 与 `accessibility.ts` 同一套 `wowpvp.<域>.v1` 存档式、同一条「坏存档
 *   回落默认、不让游戏打不开」的纪律。
 */

import { Action, DEFAULT_BINDINGS } from '../input/InputManager.js';

export const KEYBINDINGS_STORAGE_KEY = 'wowpvp.keybindings.v1';

export type Bindings = Record<Action, string>;

/**
 * 规范化一份（可能来自 localStorage 或旧版本的）键位表。
 * ★ 逐 Action 校验：存档里缺的、非字符串的、空串的一律回落默认 ——
 *   一个坏字段不该让整套键位失效，也不该留下一个「按不出来的」动作。
 */
export const normalizeBindings = (raw: Partial<Record<string, unknown>>): Bindings => {
  const out = { ...DEFAULT_BINDINGS } as Bindings;
  for (const action of Object.values(Action)) {
    const v = raw[action];
    if (typeof v === 'string' && v.length > 0) out[action] = v;
  }
  return out;
};

export const loadBindings = (storage: Pick<Storage, 'getItem'> | undefined): Bindings => {
  const raw = storage?.getItem(KEYBINDINGS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_BINDINGS };
  try {
    return normalizeBindings(JSON.parse(raw) as Partial<Record<string, unknown>>);
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
};

export const saveBindings = (
  storage: Pick<Storage, 'setItem'> | undefined,
  bindings: Bindings,
): void => {
  storage?.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(bindings));
};

/** 当前把 `code` 绑在身上的动作（`except` 除外）。没有则 undefined */
export const actionHoldingCode = (
  bindings: Readonly<Bindings>,
  code: string,
  except: Action,
): Action | undefined => {
  for (const action of Object.values(Action)) {
    if (action !== except && bindings[action] === code) return action;
  }
  return undefined;
};

export type RebindResult =
  | { ok: true; bindings: Bindings; swappedWith?: Action }
  /** 目标键被一个**不可重绑**的动作（移动/系统键）占用，拒绝 —— 见下 */
  | { ok: false; conflict: Action };

/**
 * 把 `action` 重绑到 `code`，按冲突分三种处理：
 *
 *   · 无人占用 → 直接绑。
 *   · 被另一个**可重绑**动作占用 → **交换**：那个动作接过 `action` 的旧键。
 *     于是没有任何动作变成「没有键」，也不会两个动作抢同一个键。交换双方
 *     都在面板里看得见（都属于 `rebindable`），不是静默改动。
 *   · 被一个**不可重绑**动作（移动四键、系统键）占用 → 拒绝。悄悄把 W 从
 *     「前进」改成「跳跃」是最糟的那种意外：玩家在面板里根本看不到「前进」，
 *     无从发现自己为什么走不动。让他先换一个别的键。
 *
 * ★ 纯函数：返回**新**表，不改原表 —— 便于单测，也便于「冲突就整个不动」。
 */
export const rebindWithSwap = (
  bindings: Readonly<Bindings>,
  action: Action,
  code: string,
  rebindable: ReadonlySet<Action>,
): RebindResult => {
  const holder = actionHoldingCode(bindings, code, action);
  if (holder === undefined) {
    return { ok: true, bindings: { ...bindings, [action]: code } };
  }
  if (!rebindable.has(holder)) {
    return { ok: false, conflict: holder };
  }
  // 交换：holder 接过 action 的旧键
  return {
    ok: true,
    swappedWith: holder,
    bindings: { ...bindings, [holder]: bindings[action], [action]: code },
  };
};

/** SettingsPanel 的 rebind 钩子回传：面板用它（配自己的 ACTION_LABELS）拼提示 */
export type RebindOutcome =
  | { ok: true; swappedWith?: Action }
  | { ok: false; conflict: Action };

/** 重绑控制器所需的 InputManager 能力（便于测试注入假对象）*/
export interface RebindableInput {
  getBindings(): Readonly<Bindings>;
  rebind(action: Action, code: string): void;
}

export interface RebindController {
  rebind: (action: Action, code: string) => RebindOutcome;
  reset: () => void;
}

/**
 * 把「重绑 + 持久化 + 交换」收成一个控制器 —— 两个场景（试验场 / 联网）
 * 逐字相同的接线，收在这里一份（批次三去重同则）。
 *
 * ★ 只做数据侧：应用到 `InputManager`、落 localStorage。提示文案的拼装留给
 *   面板（`ACTION_LABELS` 在那边），所以回的是结构化 `RebindOutcome`。
 */
export const makeRebindController = (
  input: RebindableInput,
  rebindable: ReadonlySet<Action>,
  storage: Pick<Storage, 'setItem'> | undefined,
  onChanged?: () => void,
): RebindController => ({
  rebind: (action, code) => {
    const r = rebindWithSwap(input.getBindings(), action, code, rebindable);
    if (!r.ok) return { ok: false, conflict: r.conflict };
    input.rebind(action, code);
    // 交换：把被顶走的动作也落到它的新键（action 的旧键）
    if (r.swappedWith !== undefined) input.rebind(r.swappedWith, r.bindings[r.swappedWith]);
    saveBindings(storage, input.getBindings());
    onChanged?.();
    return r.swappedWith !== undefined ? { ok: true, swappedWith: r.swappedWith } : { ok: true };
  },
  reset: () => {
    for (const a of Object.values(Action)) input.rebind(a, DEFAULT_BINDINGS[a]);
    saveBindings(storage, input.getBindings());
    onChanged?.();
  },
});
