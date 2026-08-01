/**
 * 死亡结算漏斗。规格书 10.10 / 17.3，验收 #37。
 *
 * ★ 这个文件解决的是一个**接线**问题，不是规则问题。
 *
 *   10.10「玩家死亡后临时装备随该玩家失效，不掉给敌人」的规则实现
 *   （`loadout.onDeath()`）从 M6 起就是对的，`loadout.test.ts` 也一直是绿的 ——
 *   但**真实对局里从来没有人调用它**。真正的死亡发生在
 *   `effects/combat.ts` 的 `dealDamage()` 里，而那里拿不到装备栏。
 *
 *   后果在竞技场看不出来（死亡即淘汰），在夺旗里就很明显：M7 的波次复活会让
 *   一个人带着一路捡来的装备原地复活，正是 10.10 要防的滚雪球。
 *
 *   这是本项目第三次遇到同一类 bug（M3/M4 七个、M8 的 #2）：
 *   **规则写对了、单元测试全绿，但没有人调用它。**
 *   所以这里不只是补一次调用，还配了一个自检（见 `assertDeathsSettled`）——
 *   下一次有人加了新的「死亡时该清理的东西」而忘了接线，会被它抓住。
 */

import type { EntityId } from '../types/ids.js';
import { onDeath as clearTemporaryEquipment, type LoadoutStore, type SwapStore } from './loadout.js';
import type { PickupStore } from './arsenal.js';
import type { CombatEvent } from './effects/registry.js';
import { listEntities, type World } from './world.js';

export interface DeathSettleDeps {
  world: World;
  loadouts: LoadoutStore;
  swaps: SwapStore;
  pickups: PickupStore;
}

export interface DeathSettlement {
  entityId: EntityId;
  /**
   * 10.10 临时装备已失效并回退到默认装备。
   * 类型写死成 `true` —— 想加一条「某种情况下不清」的分支，
   * 得先改这个类型，那是一次显眼的改动。
   */
  temporaryEquipmentCleared: true;
}

/**
 * 消费本 tick 的 `death` 事件，完成死亡后的状态收尾。
 *
 * ⚠️⚠️ **调用顺序：必须在 `tickSwaps()` 与 `tickPickups()` 之后。**
 *
 *   那两个函数靠「实体已死」这个条件发出 `result: 'death'` 的中断事件
 *   （17.3 的「换装瞬间死亡」就是它们负责的，而且 `tickSwaps` 里
 *   `!e.alive` 的判断刻意排在 `now >= endsAt` 之前 —— 同一 tick 里
 *   死亡赢过换装完成，状态因此唯一）。
 *
 *   本函数会清掉进行中的换装。**放在它们之前调用会把那个事件吃掉** ——
 *   于是 16.2 的换装统计和 HUD 的「换装被打断」反馈都会静默丢失。
 *   这类「顺序错了不报错、只是少了点东西」的 bug 最难查，所以写在这里。
 */
export const settleDeaths = (
  deps: DeathSettleDeps,
  events: readonly CombatEvent[],
): DeathSettlement[] => {
  const out: DeathSettlement[] = [];

  for (const ev of events) {
    if (ev.t !== 'death') continue;
    const e = deps.world.entities.get(ev.targetId);
    if (!e) continue;

    const loadout = deps.loadouts.get(e.id);
    if (loadout) {
      // 10.10：临时装备失效、回退默认装备、取消进行中的换装。
      // ★ 复用 loadout.ts 的实现，不在这里另写一份 ——
      //   「默认装备永不删除」那条只有一个实现处
      clearTemporaryEquipment(e, loadout, deps.swaps);
    }
    // 17.3「状态必须唯一」：拾取进度不能跨越死亡活下来。
    // tickPickups 已经会因 !alive 中断并发事件，这里是兜底 ——
    // 万一某条路径绕过了 tickPickups（例如实体被直接移出世界）
    deps.pickups.delete(e.id);

    out.push({ entityId: e.id, temporaryEquipmentCleared: true });
  }

  return out;
};

/**
 * 自检：死掉的人身上不该留下任何「进行中」的状态或临时装备。
 *
 * ★ 与 M4 的 `assertAllEffectsRegistered()` 同一个思路 ——
 *   把「忘了接线」变成**响亮的失败**而不是静默的少做一件事。
 *
 *   `settleDeaths()` 漏调、或者将来有人给「死亡时该清理的东西」加了新项
 *   却没加进 `settleDeaths`，都会在这里被抓住。
 *
 * 由测试与 `verify:m9` 在每个 tick 之后调用。
 */
export const assertDeathsSettled = (deps: DeathSettleDeps): void => {
  for (const e of listEntities(deps.world)) {
    if (e.alive) continue;

    if (deps.swaps.has(e.id)) {
      throw new Error(
        `死亡结算漏了：实体 ${e.id}（${e.name}）已死却仍有进行中的换装。` +
          `17.3 要求状态唯一 —— 检查 settleDeaths() 有没有被调用。`,
      );
    }
    if (deps.pickups.has(e.id)) {
      throw new Error(
        `死亡结算漏了：实体 ${e.id}（${e.name}）已死却仍有进行中的拾取。17.3。`,
      );
    }

    const l = deps.loadouts.get(e.id);
    if (!l) continue;
    if (l.spareWeapons.length > 0 || l.spareArmors.length > 0 || l.consumables.length > 0) {
      throw new Error(
        `死亡结算漏了：实体 ${e.id}（${e.name}）已死却仍持有临时装备` +
          `（武器 ${l.spareWeapons.length} / 护甲 ${l.spareArmors.length} / 道具 ${l.consumables.length}）。` +
          `10.10：临时装备随该玩家失效，不掉给敌人 —— 否则夺旗的波次复活会滚雪球。`,
      );
    }
    if (e.weaponId !== l.defaultWeaponId || e.armorId !== l.defaultArmorId) {
      throw new Error(
        `死亡结算漏了：实体 ${e.id}（${e.name}）已死却仍装备着非默认装备。10.10。`,
      );
    }
  }
};
