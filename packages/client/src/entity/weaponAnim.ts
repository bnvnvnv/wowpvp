/**
 * 武器 → 攻击动作片段的选择（技术债总账 W14 的余账之一）。
 *
 * ★★ **在此之前所有武器共用同一个片段**：`CharacterView.SWING_CLIPS` 是一张
 *   「找到第一个存在的就用」的候选表，而八个玩家模型都带全 22 个片段 ——
 *   于是**永远**命中第一项 `1H_Melee_Attack_Slice_Diagonal`。大剑抡出单手斜劈、
 *   双持匕首也是单手斜劈、猎人的弓更是拿着弓做劈砍。用户实测的原话是
 *   「近战职业似乎目前只会用手攻击，没有看到有拿武器攻击」。
 *   模型里躺着的 `Dualwield_Melee_Attack_Chop` / `2H_Melee_Attack_Chop` /
 *   `2H_Ranged_Shoot` 三个片段自 M12 挂上素材起零调用。
 *
 * ★ 本文件只做**纯查表**（武器 id → 风格 → 片段名 / 倍速），不碰 three.js
 *   的 mixer 与 action —— 于是「每一件武器分别选中哪个片段」可以逐类单测，
 *   而不必等真机截图。真机观感（Synty 骨架上劈得像不像）仍是截图的事。
 */

import { getWeapon } from '@wowpvp/shared';

import { WEAPON_MODEL } from './ModelLibrary.js';

/**
 * 攻击动作的**风格**。它不等于 `WeaponDef.handedness` —— 后者把弓弩与魔杖
 * 法杖一起塞进了 `'ranged'`（见 `swingStyleFor` 的注释），而这两者的出手
 * 动作截然不同。
 */
export type SwingStyle = 'unarmed' | 'oneHand' | 'dualWield' | 'twoHand' | 'bow' | 'spell';

/**
 * 单手挥击的一对片段。★ 交替播放（见 `swingClipsFor` 的 `alt`）：
 * 单手武器攻速快（剑盾 1.7 秒、匕首 0.85 秒一刀），同一个斜劈连播十次
 * 会读成贴图循环而不是「在打人」。
 */
const ONE_HAND: readonly [string, string] = [
  '1H_Melee_Attack_Slice_Diagonal',
  '1H_Melee_Attack_Chop',
];

/**
 * 武器 id → 攻击风格。未知 id / 没有武器都算徒手。
 *
 * ★★ **`handedness` 一个字段不够用**：`'ranged'` 同时罩着猎人的弓弩和
 *   法师的魔杖、圣骑士的权杖圣典；`'staff'` 的法杖 `isRanged` 也是 true。
 *   拿这个字段直接映射的话，法师平砍会做出拉弓的动作。
 *   真正的判据是**持握**：上游约定弓与盾挂左手（见 `WEAPON_MODEL` 的注释），
 *   于是「远程 + 只挂左手」= 弓弩，「远程 + 有右手件」= 施法器 ——
 *   后者的「平砍」本来就是推出一发法术，正好走 `Spellcast_Shoot`。
 * ★ 没配模型映射的远程武器保守归 `'spell'`：推一掌总比对着空气拉弓合理。
 */
export const swingStyleFor = (weaponId: string | undefined): SwingStyle => {
  if (weaponId === undefined) return 'unarmed';
  const def = getWeapon(weaponId as never);
  if (!def) return 'unarmed';
  if (def.isRanged === true) {
    const att = WEAPON_MODEL[weaponId];
    return att !== undefined && att.right === undefined && att.left !== undefined ? 'bow' : 'spell';
  }
  switch (def.handedness) {
    case 'dualWield':
      return 'dualWield';
    case 'twoHand':
    case 'staff':
      return 'twoHand';
    default:
      return 'oneHand';
  }
};

/**
 * 攻击风格 → 候选片段，按优先级排列：**找到第一个模型里真有的就用**。
 *
 * ★ 候选表不是冗余 —— 13.4「缺失专属动作时使用最接近的武器动作」：
 *   八个玩家模型恰好片段齐全（逐个 GLB 核对过），但 BOSS 与将来的新模型
 *   未必。一个都没有时调用方安静跳过，绝不 T-pose（A14 之鉴：
 *   候选表里**不许**写模型里不存在的片段名，上面每一个都验过）。
 * @param alt 挥砍序号；单手/双持的 1H 片段按奇偶交替，见 `ONE_HAND`。
 */
export const swingClipsFor = (style: SwingStyle, alt = 0): readonly string[] => {
  const a = ONE_HAND[alt % 2 === 0 ? 0 : 1];
  const b = ONE_HAND[alt % 2 === 0 ? 1 : 0];
  switch (style) {
    case 'dualWield':
      return ['Dualwield_Melee_Attack_Chop', a, b];
    case 'twoHand':
      return ['2H_Melee_Attack_Chop', a, b];
    case 'bow':
      return ['2H_Ranged_Shoot', '2H_Melee_Attack_Chop', a];
    case 'spell':
      return ['Spellcast_Shoot', a, b];
    default:
      return [a, b, '2H_Melee_Attack_Chop'];
  }
};

/** 挥砍希望占用的时长（秒）。1H 片段约 1.0 秒，1.33 倍速 ≈ 0.8 —— 与旧的固定 1.3 倍速同感觉 */
export const SWING_TARGET_SECONDS = 0.8;

/**
 * 挥砍倍速：把片段压进「下一刀之前播得完」的节奏里。
 *
 * ★★ 素材时长差了 60%（1H 斜劈 1.0 秒、双持 1.27 秒、2H 劈砍 1.63 秒），
 *   而攻速差了一倍还多（双持匕首 0.7 秒一刀、双手锤 2.5 秒一刀）。
 *   固定倍速的后果很具体：双持匕首每 0.7 秒起一次手，1.27 秒的片段每次
 *   播到一半就被下一刀 `reset()` —— 玩家只看得见抬手，永远看不到落刀。
 *   于是目标时长取「攻击间隔的八成」与 0.8 秒中的小者。
 * ★ 倍速夹在 [1, 2.4]：下限保证不会比素材本身还慢（慢动作读作卡顿），
 *   上限挡住抽搐。夹到上限仍播不完的，说明该换更短的素材，不是代码的事。
 */
export const swingTimeScaleFor = (duration: number, weaponId: string | undefined): number => {
  if (!(duration > 0)) return 1;
  const interval = weaponId === undefined ? undefined : getWeapon(weaponId as never)?.swingInterval;
  const target = Math.min(SWING_TARGET_SECONDS, (interval ?? Infinity) * 0.8);
  return Math.min(2.4, Math.max(1, duration / target));
};
