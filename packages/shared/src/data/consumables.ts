/**
 * 消耗品目录。规格书 10.1「临时增益道具」。
 *
 * ★ 与武器/护甲不同，消耗品**不挂在职业下面** —— 10.1 的临时增益是场地上
 *   捡到的通用道具，不是职业方案的一部分。所以它有自己的注册表，
 *   而不是 `ClassDef.consumables`。
 *
 * ★★ **数值是占位值。** 与各职业的 `flat:` 同一状态 —— 见 PROGRESS.md
 *   技术债 §2。这里的数字只为让「增益期间击杀」这条统计有真实来源，
 *   配平时会重调。**这次把这句话写在数据旁边**，因为上一次没写，
 *   结果 19 处伤害数字的由来在代码里完全找不到。
 */

import { DispelType, School } from '../types/enums.js';
import { asConsumableId } from '../types/ids.js';
import { PARTY_CONSUMABLES } from './party.js';
import type { ConsumableDef } from './schema.js';

export const CONSUMABLES: readonly ConsumableDef[] = [
  {
    id: asConsumableId('consumable.battle_draught'),
    name: '战斗药剂',
    buffSeconds: 15,
    cooldown: 60,
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'consumable.battle_draught',
          name: '战斗药剂',
          kind: 'buff',
          duration: 15,
          dispelType: DispelType.Magic,
          // 占位值：+10% 输出。配平时重调
          modifiers: { damageDealt: 1.1 },
          description: '造成的伤害提高 10%。',
        },
      },
    ],
    description: '15 秒内造成的伤害提高 10%。',
  },
  {
    id: asConsumableId('consumable.mending_salve'),
    name: '愈合药膏',
    buffSeconds: 12,
    cooldown: 45,
    effects: [
      // 占位值：即时小治疗 + 短时受治疗加成
      { kind: 'heal', amount: { flat: 120 } },
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'consumable.mending_salve',
          name: '愈合药膏',
          kind: 'buff',
          duration: 12,
          dispelType: DispelType.Magic,
          modifiers: { healingTaken: 1.15 },
          description: '受到的治疗提高 15%。',
        },
      },
    ],
    description: '立即恢复少量生命，并在 12 秒内受到的治疗提高 15%。',
  },
  {
    id: asConsumableId('consumable.warding_powder'),
    name: '护佑粉末',
    buffSeconds: 10,
    cooldown: 45,
    effects: [
      {
        kind: 'applyAura',
        target: 'self',
        aura: {
          id: 'consumable.warding_powder',
          name: '护佑粉末',
          kind: 'buff',
          duration: 10,
          dispelType: DispelType.Magic,
          // 占位值：只减法术伤害 —— 与抗法护甲同一个表达方式，不做成全局减伤
          modifiers: {
            damageTakenBySchool: Object.values(School)
              .filter((x) => x !== School.Physical)
              .reduce<Partial<Record<School, number>>>((a, x) => ((a[x] = 0.85), a), {}),
          },
          description: '受到的法术伤害降低 15%。',
        },
      },
    ],
    description: '10 秒内受到的法术伤害降低 15%。',
  },
];

/**
 * ★★ `CONSUMABLES` 是**竞技场补给池**（`spawnDropsFromRoster` 按下标轮着刷），
 *   大乱斗的派对消耗品刻意不在里面 —— 混进去会让「巨人化」「跳跳地雷」
 *   出现在 3v3 的军械点旁边，那是另一个游戏。
 *
 * ★ 但按 id **查得到**是另一回事：`tickWorld` 第 1b 步用 `getConsumable()`
 *   把槽位里的 id 换成效果，查不到就直接 `continue` —— 表现是喝了一瓶
 *   什么也没发生，且没有任何报错。所以索引表是**两池合一**。
 */
const BY_ID = new Map(
  [...CONSUMABLES, ...PARTY_CONSUMABLES].map((c) => [c.id as string, c]),
);

export const getConsumable = (id: string): ConsumableDef | undefined => BY_ID.get(id);
