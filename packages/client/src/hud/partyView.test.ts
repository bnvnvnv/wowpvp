/**
 * 15.1 队友投影的双源一致性（技术债总账 W1）。
 *
 * ★★ 核心主张只有一条：**同一个人，从 CombatEntity 投影与从 EntitySnapshot
 *   投影，得到的 PartyMemberView 逐字段相等** —— 这是「同一件事只有一份
 *   实现」的回归锚。护盾判据分叉过一次（联网侧四态少画两态），
 *   这条断言站在同一类断点上：将来有人给其中一侧「顺手」改语义，先在这里红。
 */

import { describe, expect, it } from 'vitest';

import {
  TEAM_RED,
  asClassId,
  asEntityId,
  createEntity,
  getClass,
  vec3,
  type EntitySnapshot,
} from '@wowpvp/shared';

import { controlKindsOf, partyViewFromSnapshot, partyViewOf } from './PartyFrame.js';

const mage = getClass(asClassId('mage'))!;

const makeEntity = () => {
  const e = createEntity(asEntityId(7), mage, TEAM_RED, vec3(0, 0, 0));
  e.health = 130;
  e.resources.set('mana' as never, 80);
  e.maxResources.set('mana' as never, 100);
  e.flags = { ...e.flags, feared: true, stunned: true, rooted: true, carryingFlag: true };
  return e;
};

/** 与 makeEntity 同一个人的快照形态 —— 资源容器是 Record 不是 Map */
const snapshotTwin = (e: ReturnType<typeof makeEntity>): EntitySnapshot => ({
  id: e.id,
  name: e.name,
  team: e.team,
  classId: e.classId,
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  health: e.health,
  maxHealth: e.maxHealth,
  alive: e.alive,
  resources: { mana: 80 },
  maxResources: { mana: 100 },
  auras: [],
  carryingFlag: true,
  flags: {
    stunned: true, feared: true, rooted: true, silenced: false, disarmed: false,
    carryingFlag: true, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  teleported: false,
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
});

describe('W1：队友投影只有一份实现', () => {
  it('★★ 同一个人：实体投影与快照投影逐字段相等', () => {
    const e = makeEntity();
    const [fromEntity] = partyViewOf([e]);
    const [fromSnap] = partyViewFromSnapshot([snapshotTwin(e)]);
    expect(fromSnap).toEqual(fromEntity);
    // ★ 抽查真值 —— toEqual 双方都错也能绿，先钉住其中一侧的绝对值
    // （`key` 是 P10 给资源条上色用的，与目标框同一套配色）
    expect(fromEntity!.resource).toEqual({ current: 80, max: 100, label: '法力', key: 'mana' });
    expect(fromEntity!.carryingFlag).toBe(true);
    expect(fromEntity!.className).toBe(mage.name);
  });

  it('恐惧盖过昏迷：同时生效只显示恐惧（7.3 置双标志 × 14.3 视觉必须不同）', () => {
    expect(
      controlKindsOf({ feared: true, stunned: true, rooted: false, silenced: false, disarmed: false }),
    ).toEqual(['feared']);
    expect(
      controlKindsOf({ feared: false, stunned: true, rooted: true, silenced: false, disarmed: false }),
    ).toEqual(['stunned', 'rooted']);
  });

  it('死亡映射为 dead（血条归零由渲染层负责，不在投影里改数值）', () => {
    const e = makeEntity();
    e.alive = false;
    const [v] = partyViewOf([e]);
    expect(v!.dead).toBe(true);
    expect(v!.health).toBe(130); // 投影如实带血量，压 0% 是 renderMember 的事
  });
});
