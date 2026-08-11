/**
 * W24 收口：**局内换职业**时技能栏要跟着换（`SnapshotCombatView.ingest`）。
 *
 * ★★ 这个文件存在的理由是一次审计实测：中途加入顶替人机的人在下一次复活
 *   换成了他选的职业（服务器 `respecCombatant` 把 `classId`/`availableSkills`/
 *   装备栏全换了、静态块也按指纹补发了），而客户端的判据是
 *   `if (me && this.skills.length === 0)` —— **只在栏是空的时候算一次**。
 *   于是屏幕下方整局是被顶替者那个职业的技能，玩家每按一个键换来一条
 *   `CastFailed`，而快照里的血量/资源全是对的，没有任何一层会报错。
 *
 * ★ 判据换成「职业变了 **或** 栏还是空的」：后半句不能省 —— 同职业顶替
 *   （观战期看的就是战士、坐上去也是战士）在只判「变了」时会一格都不发。
 */

import { describe, expect, it } from 'vitest';
import {
  Resource,
  TEAM_RED,
  asClassId,
  asEntityId,
  getClass,
  type EntityId,
  type HydratedEntitySnapshot as EntitySnapshot,
  type HydratedSnapshot as Snapshot,
} from '@wowpvp/shared';

import { SnapshotCombatView } from './SnapshotCombatView.js';

const ME = asEntityId(1);

const entity = (id: EntityId, classId: string): EntitySnapshot => ({
  id,
  name: 'me',
  team: TEAM_RED,
  classId: asClassId(classId),
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  teleported: false,
  health: 100,
  maxHealth: 100,
  alive: true,
  resources: { [Resource.Mana]: 999, [Resource.Rage]: 999 },
  maxResources: { [Resource.Mana]: 999, [Resource.Rage]: 999 },
  auras: [],
  carryingFlag: false,
  flags: {
    stunned: false, feared: false, rooted: false, silenced: false, disarmed: false,
    carryingFlag: false, immuneAll: false, immunePhysical: false, immuneMagic: false,
  },
  equipment: { currentWeaponId: undefined, armorArchetype: undefined, swapping: false },
});

const snapshot = (classId: string): Snapshot => ({
  tick: 1,
  you: ME,
  entities: [entity(ME, classId)],
  projectiles: [], grounds: [], drops: [], armories: [],
  match: { dampening: 0, suddenDeath: false },
});

describe('W24 收口：局内换职业 → 技能栏重算', () => {
  it('★★ classId 变了 → 重新问一次 skillBarFor，技能栏换成新职业的', () => {
    const view = new SnapshotCombatView();
    const asked: string[] = [];
    view.skillBarFor = (classId) => {
      asked.push(classId);
      return getClass(asClassId(classId))!.skills.slice(0, 9);
    };

    view.ingest(snapshot('warrior'), 0);
    view.ingest(snapshot('warrior'), 0.1); // 同一个职业：一次都不多问
    expect(asked).toEqual(['warrior']);
    expect(view.skills.every((s) => (s.id as string).startsWith('warrior.'))).toBe(true);

    // ★ 服务器把他换成牧师了（下一次复活兑现 respec）
    view.ingest(snapshot('priest'), 0.2);
    expect(asked, '换了职业却没有重新问技能栏').toEqual(['warrior', 'priest']);
    expect(view.skills.every((s) => (s.id as string).startsWith('priest.')))
      .toBe(true);
  });

  /**
   * ★ F10 设置面板改过的自定义技能栏**不能被下一帧覆盖回默认九格** ——
   *   `setSkillBar` 不改「上次据以算栏的职业」，所以判据仍然是「没变」。
   */
  it('★ 自定义过的技能栏在职业没变时不会被 ingest 覆盖', () => {
    const view = new SnapshotCombatView();
    view.skillBarFor = (classId) => getClass(asClassId(classId))!.skills.slice(0, 9);
    view.ingest(snapshot('warrior'), 0);

    const custom = getClass(asClassId('warrior'))!.skills.slice(2, 5);
    view.setSkillBar(custom);
    view.ingest(snapshot('warrior'), 0.1);
    expect(view.skills).toEqual(custom);
  });

  /**
   * ★ 同职业顶替：观战期一格都没有（`skillBarFor` 对观战席返回空栏），
   *   上场后职业与看的那个人恰好相同 —— 只判「变了」的话他整局没有技能栏。
   */
  it('★ 栏还是空的时候照常补算（同职业顶替不会留下一个空技能栏）', () => {
    const view = new SnapshotCombatView();
    let spectating = true;
    view.skillBarFor = (classId) =>
      spectating ? [] : getClass(asClassId(classId))!.skills.slice(0, 9);

    view.ingest(snapshot('warrior'), 0);
    expect(view.skills).toHaveLength(0);

    spectating = false; // 坐上了同职业的席位
    view.ingest(snapshot('warrior'), 0.1);
    expect(view.skills.length).toBeGreaterThan(0);
  });
});
