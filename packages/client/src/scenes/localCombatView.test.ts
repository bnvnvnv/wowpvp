/**
 * X17 在**试验场那一路**的光环投影（`AuraStore` → `HudUnit.auras`）。
 *
 * ★★ 这一支存在的理由是那层包装本身：`CombatDirector` 已经满足 `CombatView`，
 *   所以「多包一层」这件事是有可能白做的 —— 包了但场景没换、或者换了但
 *   三个 getter 里漏了一个（自身框有光环、目标框没有），都是静默的。
 * ★ 与 `net/snapshotAuras.test.ts` 是同一件事的两半：本地这边**什么都查得到**，
 *   所以 kind / school / name 一律如实填；联网那边只能诚实报 unknown。
 */

import { describe, expect, it } from 'vitest';

import { CombatDirector } from '../combat/CombatDirector.js';
import { auraDefById, auraSchoolById } from '../data/auraRegistry.js';
import { LocalCombatView } from './LocalCombatView.js';

const SPAWN = { x: 0, y: 0, z: 0 };

/** 玩家给自己套霜甲护盾（技能栏第 9 格），推到结算完成 */
const shieldSelf = (dir: CombatDirector): void => {
  dir.castSlot(8);
  for (let t = 0; t < 0.5; t += 1 / 60) dir.update(1 / 60, SPAWN, 0);
};

describe('LocalCombatView（X17 试验场侧光环投影）', () => {
  it('★★ 自身框：套了盾之后 player.auras 里能读到它，且带吸收量', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    expect(view.player.auras).toEqual([]); // 开局身上什么都没有

    shieldSelf(dir);
    const shield = view.player.auras?.find((a) => a.absorbRemaining !== undefined);
    expect(shield, '霜甲护盾没投影出来').toBeDefined();
    expect(shield!.absorbRemaining).toBeGreaterThan(0);
    expect(shield!.absorbInitial).toBe(shield!.absorbRemaining);
  });

  /**
   * ★★ **X26 收口：本地这条投影的 `school` 也走注册表。**
   *
   *   霜甲护盾的 `AuraDef` **自己不写 `school`**（63 枚里 53 枚都不写），
   *   只有施加它的技能写了 `School.Frost`。改之前本地只读 `a.def.school`，
   *   于是同一枚护盾在试验场是中性灰、在联网局是冰蓝 —— 判据成了两处。
   *   这条走的是**真的** `hudAurasOf`（不是复刻一份公式），
   *   `net/snapshotAuras.test.ts` 那条全注册表门禁负责比「两边是否一致」。
   */
  it('★★ school 从施加技能推得出来（def 自己不写，别退回中性灰）', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    shieldSelf(dir);
    const shield = view.player.auras!.find((a) => a.absorbRemaining !== undefined)!;
    expect(auraDefById(shield.id)?.school, '这枚光环自己写了 school —— 换一枚测')
      .toBeUndefined();
    expect(shield.school, '本地侧退回了中性灰（X26 的两处判据复发）')
      .toBe(auraSchoolById(shield.id));
    expect(shield.school).toBeDefined();
  });

  it('★ 本地这边查得到向与名字 —— 与联网侧只能报 unknown 形成对照', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    shieldSelf(dir);
    const a = view.player.auras![0]!;
    expect(a.kind).toBe('buff');
    expect(a.name).not.toBe('');
    expect(a.name).not.toBe(a.id);
  });

  it('★★ 目标框走的是同一条投影（三个 getter 漏一个就是静默的）', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    const dummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
    dir.selectById(dummy.id as number);

    expect(view.target?.id).toBe(dummy.id);
    expect(view.target?.auras).toBeDefined();
  });

  it('★ 转发的那几样原样可用：距离、施法、技能栏、日志、选中', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    const dummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;

    expect(view.now).toBe(dir.world.time);
    expect(view.skills.length).toBe(dir.skills.length);
    expect(view.log).toBe(dir.log);
    // 距离回到 director 那把尺子（不在包装层重算一遍平面距离）
    expect(view.distanceTo(dummy)).toBeCloseTo(dir.distanceTo(dummy), 9);
    expect(view.castOf(dummy)).toBe(dir.castOf(dummy));

    view.selectById(dummy.id as number);
    expect(dir.player.targets.hard).toBe(dummy.id);
  });

  it('★★ 姓名板那条不拷贝 —— 12v12 里每帧多出 24 个拷贝是白花的', () => {
    const dir = new CombatDirector([], SPAWN);
    const view = new LocalCombatView(dir);
    const first = view.visibleUnits()[0];
    expect(first).toBe(dir.visibleEntities()[0]);
  });

  it('★ 没有焦点时 focus 是 undefined（不是一个空壳）', () => {
    const dir = new CombatDirector([], SPAWN);
    expect(new LocalCombatView(dir).focus).toBeUndefined();
  });
});
