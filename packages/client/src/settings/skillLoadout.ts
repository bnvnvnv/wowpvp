/**
 * 技能栏自定义与持久化（P3c）。用户拍板：固定 9 格（键 1–9 含义不变），
 * 从本职业全部技能池里挑；选择存 localStorage。
 *
 * ★ 与 `keybindings.ts` / `accessibility.ts` 同一套 `wowpvp.<域>.v1` 存档式、
 *   同一条纪律：**坏存档回落默认，不让游戏打不开**。
 *
 * ★★ 默认值就是「今天的行为」：试验场 = `PLAYER_SKILL_IDS`（法师演示栏），
 *   联网 = 本职业前 9 个技能（数字键此前能按到的那 9 个）。verify-m1..m4
 *   跑在无 localStorage 的全新浏览器上下文里 → `loadSkillBar` 拿不到存档
 *   → 返回默认 → **默认路径逐字节不变**。这是本文件最重要的不变量。
 *
 * ★ 纯函数 + storage 注入（`Pick<Storage, ...>`）—— 与 `loadBindings` 同构，
 *   单测不需要真 localStorage。
 */

export const SKILL_BAR_STORAGE_KEY = 'wowpvp.skillbar.v1';

/**
 * 技能栏格数。= `InputManager` 的 Skill1..Skill9 动作数 —— 键 1–9 的含义
 * 是本次自定义**明确不动**的东西（改键走 W7 的键位重绑，不在这里）。
 */
export const SKILL_BAR_SLOTS = 9;

/** 存档形状：一个 key 存全部职业 —— `{ mage: ['mage.frostbolt', ...], ... }` */
type SkillBarRecord = Partial<Record<string, unknown>>;

/**
 * 规范化一份（可能来自 localStorage、可能被手改坏的）技能栏。
 *
 * 逐格校验：不是本职业技能 / 与前面的格子重复 / 缺格 / 类型不对 → 该格
 * 回落默认；长度强制等于 `defaults.length`。
 * ★ 补默认时**跳过已被玩家选走的**：默认第 1 格的技能被玩家挪到第 7 格时，
 *   第 1 格补的是默认序列里下一个没被用的，而不是造出一个重复。
 */
export const normalizeSkillBar = (
  raw: unknown,
  defaults: readonly string[],
  classSkillIds: ReadonlySet<string>,
): string[] => {
  const used = new Set<string>();
  const arr = Array.isArray(raw) ? raw : [];
  const out: (string | null)[] = defaults.map((_, i) => {
    const v: unknown = arr[i];
    if (typeof v === 'string' && classSkillIds.has(v) && !used.has(v)) {
      used.add(v);
      return v;
    }
    return null;
  });
  // 空位从默认序列里按序补「还没被用的」。数量必然够：
  // 空位数 = 格数 - used.size，而默认里未被用的 ≥ 格数 - used.size
  const fillers = defaults.filter((d) => !used.has(d));
  let f = 0;
  return out.map((v) => v ?? fillers[f++]!);
};

export const loadSkillBar = (
  storage: Pick<Storage, 'getItem'> | undefined,
  classId: string,
  defaults: readonly string[],
  classSkillIds: ReadonlySet<string>,
): string[] => {
  const raw = storage?.getItem(SKILL_BAR_STORAGE_KEY);
  if (!raw) return [...defaults];
  try {
    const record = JSON.parse(raw) as SkillBarRecord;
    return normalizeSkillBar(record[classId], defaults, classSkillIds);
  } catch {
    return [...defaults];
  }
};

/**
 * 存一个职业的技能栏。读-改-写整份记录 —— 别的职业的自定义不能被顺手抹掉
 * （一个玩家会换职业，八份自定义共存于同一个 key）。
 */
export const saveSkillBar = (
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  classId: string,
  ids: readonly string[],
): void => {
  if (!storage) return;
  let record: SkillBarRecord = {};
  try {
    const raw = storage.getItem(SKILL_BAR_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as SkillBarRecord;
      }
    }
  } catch {
    // 坏存档：整份重建 —— 与读侧「坏了回默认」同一条纪律
  }
  record[classId] = [...ids];
  storage.setItem(SKILL_BAR_STORAGE_KEY, JSON.stringify(record));
};

/**
 * 把 `skillId` 指派到 `slot` 格，返回新栏（纯函数，不改原数组）。
 * 目标技能已在别的格 → **交换**（与 `rebindWithSwap` 同哲学：没有格子会变空，
 * 也不会两个格子放同一个技能）。
 */
export const assignSlot = (
  bar: readonly string[],
  slot: number,
  skillId: string,
): string[] => {
  const next = [...bar];
  if (slot < 0 || slot >= next.length) return next;
  const existing = next.indexOf(skillId);
  if (existing >= 0) next[existing] = next[slot]!;
  next[slot] = skillId;
  return next;
};
