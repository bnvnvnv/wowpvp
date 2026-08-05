/**
 * M6 端到端验收脚本。附录A#7 要求的阶段验收用例。
 *
 * 覆盖验收 #28（预设决定是否生成武装）、#29（职业锁定且物品不消失）、
 * #30（装备栏容量与默认装备）、#33（换装有时间与中断窗口）、
 * #34（★ 换装的五项禁止利用）、#36（敌人看不到备用装备）、#37（回合清除）。
 *
 * 与 M5 同理，这里**不驱动浏览器** —— 装备系统是纯逻辑，
 * 要验的是「一整局武装竞技场里装备争夺能正确进行」。
 *
 * 用法：pnpm verify:m6
 */

import * as shared from '../packages/shared/src/index.ts';

const {
  ArenaPreset, GameMode, Resource, School, DispelType,
  EQUIP, RANGE, TEAM_RED,
  SwapKind, addWeapon, applyAura, aurasOf, armoryLayoutFor, armoryOptionsFor,
  availableWeapons, beginPickup, beginSwap, canPickupWeapon,
  createArsenalStore, createAuraStore, createEntity, createLoadout, createLoadoutStore,
  createPickupStore, createSwapStore, createWorld, dropViewFor, enemyLoadoutView,
  onDeath, ownLoadoutView, resetLoadouts, setupArmories, spawnDropsFromRoster,
  telegraphedArmories, tickPickups, tickSwaps,
  addEntity, allocEntityId, asArmorId, asWeaponId, getClass, mage, warrior, vec3,
} = shared;

const results: { id: string; pass: boolean }[] = [];
const check = (id: string, name: string, pass: boolean, detail: string) => {
  results.push({ id, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${id} ${name}\n      ${detail}`);
};

const world = createWorld([]);
const spawnEntity = (cls: typeof warrior, x = 0, z = 0, name?: string) =>
  addEntity(world, createEntity(allocEntityId(world), cls, TEAM_RED, vec3(x, 0, z), { name }));

console.log('\n── 规格书 10.1 / 验收 #28：预设决定是否生成临时武装 ──');
{
  const classic = createArsenalStore(ArenaPreset.Classic);
  setupArmories(classic, GameMode.Arena3v3, 0);
  const classicDrops = spawnDropsFromRoster(classic, [warrior.id], vec3(0, 0, 0), 0);

  const armed = createArsenalStore(ArenaPreset.Armed);
  setupArmories(armed, GameMode.Arena3v3, 0);
  const armedDrops = spawnDropsFromRoster(armed, [warrior.id, mage.id], vec3(0, 0, 0), 0);

  check('#28', '★ 经典竞技场不生成任何武装，武装竞技场才生成',
    classic.armories.length === 0 && classicDrops.length === 0 &&
    armed.armories.length > 0 && armedDrops.length > 0,
    `经典：军械点 ${classic.armories.length} 掉落 ${classicDrops.length}；` +
    `武装：军械点 ${armed.armories.length} 掉落 ${armedDrops.length}`);
}

console.log('\n── 规格书 10.4：刷新可预测、双方距离对等、提前 5 秒预告 ──');
{
  const store = createArsenalStore(ArenaPreset.Armed);
  setupArmories(store, GameMode.Arena3v3, 0, 20, 60);

  // 对称性：每个军械点都要有 z 镜像
  let symmetric = true;
  for (const mode of [GameMode.Arena2v2, GameMode.Arena3v3, GameMode.Arena5v5]) {
    const layout = armoryLayoutFor(mode);
    for (const { offset } of layout) {
      symmetric &&= layout.some(
        (o) => Math.abs(o.offset.z + offset.z) < 1e-6 && Math.abs(o.offset.x - offset.x) < 1e-6,
      );
    }
  }
  check('10.4a', '★ 军械点沿 ±Z 对称 —— 双方到达距离相等（10.4 / 11.3）',
    symmetric,
    `2v2 ${armoryLayoutFor(GameMode.Arena2v2).length} 点 / ` +
    `3v3 ${armoryLayoutFor(GameMode.Arena3v3).length} 点 / ` +
    `5v5 ${armoryLayoutFor(GameMode.Arena5v5).length} 点，全部成对或居中`);

  check('10.4b', '刷新前 5 秒进入预告窗口',
    telegraphedArmories(store, 10).length === 0 &&
    telegraphedArmories(store, 16).length > 0 &&
    telegraphedArmories(store, 21).length === 0,
    `t=10s 预告 ${telegraphedArmories(store, 10).length} / t=16s 预告 ${telegraphedArmories(store, 16).length} / t=21s 预告 ${telegraphedArmories(store, 21).length}（阈值 ${EQUIP.SPAWN_TELEGRAPH_SECONDS}s）`);

  const opts = armoryOptionsFor(warrior.id);
  const allWarrior = opts.every(
    (o) => (!o.weaponId || (o.weaponId as string).startsWith('warrior.')) &&
           (!o.armorId || (o.armorId as string).startsWith('warrior.')),
  );
  check('10.4c', '★ 军械箱只给打开者本职业的三个横向选择（进攻/机动/防御）',
    opts.length === 3 && allWarrior && opts.every((o) => o.advantage && o.cost),
    opts.map((o) => `${o.choice}：${o.advantage} / 代价 ${o.cost}`).join('｜'));
}

console.log('\n── 规格书 10.2 / 验收 #29：职业锁定，错误交互不使物品消失 ──');
{
  const store = createArsenalStore(ArenaPreset.Armed);
  const pickups = createPickupStore();
  spawnDropsFromRoster(store, [warrior.id], vec3(0, 0, 0), 0);

  const m = spawnEntity(mage, 0, 1, '法师');
  const mLoadout = createLoadout(m.classId);
  const before = store.drops.length;
  const r = beginPickup(m, mLoadout, store, pickups, store.drops[0]!.id, 0);
  const view = dropViewFor(store.drops[0]!, m, mLoadout);

  check('#29', '★ 跨职业拾取被拒绝、提示归属、且物品仍在地上',
    !r.ok && (r as { reason: string }).reason.includes('职业不匹配') &&
    store.drops.length === before && view.ownerClassName === '战士' && !view.pickableByViewer,
    `提示「${(r as { reason: string }).reason}」；地面物品 ${before} → ${store.drops.length}；` +
    `法师看到的归属＝${view.ownerClassName}，可拾取＝${view.pickableByViewer}`);
}

console.log('\n── 规格书 10.5：拾取的时间与中断规则 ──');
{
  const store = createArsenalStore(ArenaPreset.Armed);
  const pickups = createPickupStore();
  spawnDropsFromRoster(store, [warrior.id], vec3(0, 0, 0), 0);

  const w1 = spawnEntity(warrior, 0, 1, '战士甲');
  const w2 = spawnEntity(warrior, 0, -1, '战士乙');
  const l1 = createLoadout(w1.classId);
  const l2 = createLoadout(w2.classId);
  const loadouts = new Map([[w1.id, l1], [w2.id, l2]]);

  // 普通伤害不中断
  beginPickup(w1, l1, store, pickups, store.drops[0]!.id, 0);
  let damagedButAlive = true;
  for (let t = 0.1; t < 0.7; t += 0.1) {
    w1.health -= 60;
    if (tickPickups(world.entities, loadouts, store, pickups, t).length > 0) damagedButAlive = false;
  }
  const done = tickPickups(world.entities, loadouts, store, pickups, EQUIP.PICKUP_SECONDS + 0.01);

  check('10.5a', '★ 普通伤害不中断拾取（与 7.3「伤害不打断施法」同源）',
    damagedButAlive && done[0]?.result === 'completed' && l1.spareWeapons.length === 1,
    `期间扣血 ${w1.maxHealth - w1.health} 点仍完成拾取；拾取耗时 ${EQUIP.PICKUP_SECONDS}s，交互距离 ${RANGE.INTERACT}m`);

  // 多人争夺
  const store2 = createArsenalStore(ArenaPreset.Armed);
  const pickups2 = createPickupStore();
  spawnDropsFromRoster(store2, [warrior.id], vec3(0, 0, 0), 0);
  const l1b = createLoadout(w1.classId);
  const l2b = createLoadout(w2.classId);
  const loadouts2 = new Map([[w1.id, l1b], [w2.id, l2b]]);
  w1.health = w1.maxHealth;

  const dropId = store2.drops[0]!.id;
  beginPickup(w1, l1b, store2, pickups2, dropId, 0);
  beginPickup(w2, l2b, store2, pickups2, dropId, 0.1);
  const ev = tickPickups(world.entities, loadouts2, store2, pickups2, EQUIP.PICKUP_SECONDS + 0.2);

  // ★ 断言「**这一件**被拿走了」，不是「地面空了」——
  //   M11 给军械箱加了消耗品掉落后，地上本来就还会有别的东西。
  //   按意图收紧，而不是把数字从 0 改成 1（下次再加一种掉落又会红）。
  check('10.5b', '★ 多人同时拾取只有第一个完成者成功，其余收到明确失败反馈',
    ev.filter((e) => e.result === 'completed').length === 1 &&
    ev.filter((e) => e.result === 'taken').length === 1 &&
    !store2.drops.some((d) => d.id === dropId),
    ev.map((e) => `${world.entities.get(e.entityId)?.name}＝${e.result}`).join('，'));
}

console.log('\n── 规格书 10.6 / 验收 #30：装备栏容量与默认装备 ──');
{
  const w = spawnEntity(warrior, 5, 0, '战士');
  const l = createLoadout(w.classId);

  const cap: string[] = [];
  addWeapon(l, asWeaponId('warrior.greatsword'));
  addWeapon(l, asWeaponId('warrior.dual_swords'));
  const third = canPickupWeapon(w, l, asWeaponId('warrior.sword_shield'));
  cap.push(`备用武器 ${l.spareWeapons.length}/${EQUIP.MAX_SPARE_WEAPONS}，第三件被拒＝${!third.ok}`);

  check('#30', '★ 默认装备不可删除且始终可切换；备用槽有上限',
    availableWeapons(l).includes(l.defaultWeaponId) &&
    l.spareWeapons.length === EQUIP.MAX_SPARE_WEAPONS && !third.ok,
    `${cap[0]}；可切换武器 ${availableWeapons(l).length} 件（含默认 ${getClass(w.classId)?.weapons.find((x) => x.isDefault)?.name}）`);
}

console.log('\n── 规格书 10.7 / 验收 #33：换装的时间与中断窗口 ──');
{
  const w = spawnEntity(warrior, 10, 0, '战士');
  const l = createLoadout(w.classId);
  const swaps = createSwapStore();
  addWeapon(l, asWeaponId('warrior.greatsword'));
  l.spareArmors.push(asArmorId('warrior.offense'));

  // 武器：0.8 秒、可缓慢移动、不受伤害影响
  beginSwap(w, l, swaps, SwapKind.Weapon, asWeaponId('warrior.greatsword'), 0);
  w.position = vec3(10, 0, 1); // 移动
  const weaponSurvivedMove = tickSwaps(world.entities, swaps, 0.4).length === 0;
  const weaponDone = tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);

  // 护甲：2 秒、必须原地
  w.position = vec3(10, 0, 0);
  beginSwap(w, l, swaps, SwapKind.Armor, asArmorId('warrior.offense'), 0);
  w.position = vec3(10, 0, 2);
  const armorInterrupted = tickSwaps(world.entities, swaps, 0.5);

  check('#33', '★ 武器换装 0.8s 可移动；护甲换装 2s 必须原地，移动即中断',
    weaponSurvivedMove && weaponDone[0]?.result === 'completed' &&
    armorInterrupted[0]?.result === 'moved',
    `武器：移动中未中断＝${weaponSurvivedMove}，${EQUIP.SWAP_WEAPON_SECONDS}s 后完成；` +
    `护甲：移动后 ${armorInterrupted[0]?.result}（时长 ${EQUIP.SWAP_ARMOR_SECONDS}s）`);
}

console.log('\n── ★★ 规格书 10.7 / 验收 #34：换装的五项禁止利用 ──');
{
  const w = spawnEntity(warrior, 20, 0, '战士');
  const l = createLoadout(w.classId);
  const swaps = createSwapStore();
  const auras = createAuraStore();
  addWeapon(l, asWeaponId('warrior.greatsword'));

  // 造一个「打架打到一半」的完整状态
  w.nextSwingAt = 1.2;
  w.swingRecoveryUntil = 0.4;
  w.cooldowns.set(warrior.skills[0]!.id, 9);
  w.gcdUntil = 0.7;
  w.schoolLocks.set(School.Fire, 3);
  w.resources.set(Resource.Rage, 25);
  applyAura(auras, w, {
    id: 'test.debuff', name: '致死创伤', kind: 'debuff', duration: 6,
    dispelType: DispelType.None, modifiers: { healingTaken: 0.75 }, description: '',
  }, w.id, 0);

  const before = {
    nextSwingAt: w.nextSwingAt,
    swingRecoveryUntil: w.swingRecoveryUntil,
    cooldown: w.cooldowns.get(warrior.skills[0]!.id),
    gcdUntil: w.gcdUntil,
    schoolLock: w.schoolLocks.get(School.Fire),
    rage: w.resources.get(Resource.Rage),
    debuffs: aurasOf(auras, w.id).length,
  };

  beginSwap(w, l, swaps, SwapKind.Weapon, asWeaponId('warrior.greatsword'), 0);
  tickSwaps(world.entities, swaps, EQUIP.SWAP_WEAPON_SECONDS + 0.01);

  const after = {
    nextSwingAt: w.nextSwingAt,
    swingRecoveryUntil: w.swingRecoveryUntil,
    cooldown: w.cooldowns.get(warrior.skills[0]!.id),
    gcdUntil: w.gcdUntil,
    schoolLock: w.schoolLocks.get(School.Fire),
    rage: w.resources.get(Resource.Rage),
    debuffs: aurasOf(auras, w.id).length,
  };

  const items: [string, boolean][] = [
    ['不刷新普通攻击', after.nextSwingAt === before.nextSwingAt],
    ['不取消攻击后摇', after.swingRecoveryUntil === before.swingRecoveryUntil],
    ['不重置技能冷却', after.cooldown === before.cooldown && after.gcdUntil === before.gcdUntil && after.schoolLock === before.schoolLock],
    ['不恢复资源', after.rage === before.rage],
    ['不清除负面状态', after.debuffs === before.debuffs],
  ];

  check('#34', '★★ 换装成功，但五项禁止利用全部成立',
    w.weaponId === asWeaponId('warrior.greatsword') && items.every(([, ok]) => ok),
    `武器已换＝${w.weaponId}；` + items.map(([n, ok]) => `${n}${ok ? '✓' : '✗'}`).join('，'));
}

console.log('\n── 规格书 10.6 / 验收 #36：敌人看不到备用装备 ──');
{
  const w = spawnEntity(warrior, 30, 0, '战士');
  const l = createLoadout(w.classId);
  const swaps = createSwapStore();
  addWeapon(l, asWeaponId('warrior.greatsword'));
  addWeapon(l, asWeaponId('warrior.dual_swords'));

  const enemyView = enemyLoadoutView(w, swaps);
  const ownView = ownLoadoutView(w, l, swaps, 0);
  const serialized = JSON.stringify(enemyView);

  check('#36', '★ 敌方视图不含任何备用装备，己方视图能看到全部',
    !serialized.includes('greatsword') && !serialized.includes('dual_swords') &&
    enemyView.currentWeapon !== undefined && enemyView.armorArchetype !== undefined &&
    ownView.spareWeapons.length === 2,
    `敌方可见字段：${Object.keys(enemyView).join('/')}（当前武器 ${enemyView.currentWeapon?.name}，护甲原型 ${enemyView.armorArchetype}）；` +
    `己方备用武器 ${ownView.spareWeapons.map((x) => x?.name).join('、')}`);
}

console.log('\n── 规格书 10.10 / 验收 #37：死亡与回合重置 ──');
{
  const w = spawnEntity(warrior, 40, 0, '战士');
  const l = createLoadout(w.classId);
  const swaps = createSwapStore();
  const loadouts = createLoadoutStore();
  loadouts.set(w.id, l);

  addWeapon(l, asWeaponId('warrior.greatsword'));
  w.weaponId = asWeaponId('warrior.greatsword');
  onDeath(w, l, swaps);
  const afterDeath = { spares: l.spareWeapons.length, weapon: w.weaponId };

  addWeapon(l, asWeaponId('warrior.dual_swords'));
  l.spareArmors.push(asArmorId('warrior.offense'));
  w.weaponId = asWeaponId('warrior.dual_swords');
  resetLoadouts([w], loadouts, swaps);

  check('#37', '★ 死亡后临时装备失效不掉给敌人；回合结束全部清除并恢复默认',
    afterDeath.spares === 0 && afterDeath.weapon === l.defaultWeaponId &&
    l.spareWeapons.length === 0 && l.spareArmors.length === 0 &&
    w.weaponId === l.defaultWeaponId,
    `死亡后备用 ${afterDeath.spares} 件、武器回到默认；回合重置后备用武器 ${l.spareWeapons.length}、备用护甲 ${l.spareArmors.length}`);
}

console.log('\n── 一整局武装竞技场的装备争夺 ──');
{
  const store = createArsenalStore(ArenaPreset.Armed);
  const pickups = createPickupStore();
  setupArmories(store, GameMode.Arena3v3, 0, 5, 60);

  const a = spawnEntity(warrior, 50, 0, '红·战士');
  const b = spawnEntity(mage, 50, 3, '蓝·法师');
  const la = createLoadout(a.classId);
  const lb = createLoadout(b.classId);
  const loadouts = new Map([[a.id, la], [b.id, lb]]);

  // 刷出两个职业各自的掉落
  spawnDropsFromRoster(store, [a.classId, b.classId], vec3(50, 0, 1.5), 6);
  const timeline: string[] = [];

  // 双方各自拾取属于自己的那件
  for (const [e, l] of [[a, la], [b, lb]] as const) {
    // ★ 只找**本职业的装备**。消耗品没有 classId（人人可用），自然不会被选中
    const mine = store.drops.find(
      (d) => d.classId !== undefined && (d.classId as string) === (e.classId as string),
    );
    if (!mine) continue;
    const r = beginPickup(e, l, store, pickups, mine.id, 6);
    timeline.push(`${e.name} 起手拾取＝${r.ok}`);
  }
  const ev = tickPickups(world.entities, loadouts, store, pickups, 6 + EQUIP.PICKUP_SECONDS + 0.01);
  for (const x of ev) timeline.push(`${world.entities.get(x.entityId)?.name}＝${x.result}`);

  // ★ 判据是「**职业装备**都被拿走了」。消耗品无人拾取会留在地上，那是对的
  check('M6', '★ 双方各自拾到本职业装备，互不干扰，职业装备已清空',
    la.spareWeapons.length === 1 && lb.spareWeapons.length === 1 &&
    !store.drops.some((d) => d.classId !== undefined),
    `${timeline.join('，')}；战士获得 ${la.spareWeapons.length} 件、法师获得 ${lb.spareWeapons.length} 件`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
console.log(`M6 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.id).join(', '));
  process.exit(1);
}
