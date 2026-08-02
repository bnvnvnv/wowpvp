/**
 * 联网侧的**施法注册表**。
 *
 * ★★ 这个文件存在的理由是一个真 bug：`SnapshotCombatView.playerCast` 从 M10 起
 *   就是一个「声明了、注释写着由事件维护、但全仓库没有一处赋值」的字段。
 *   自己的施法条、姓名板施法条、目标框施法条、`setCasting` 施法姿态
 *   四条通道一起是死的，**915 个单测和 14 项 m10 验收没有一条发现它** ——
 *   因为它们验的是「快照解析对不对」，而这个洞在「有没有人把事件写进去」。
 *
 *   所以这里测的不是形状转换，而是**生命周期**：进得去、出得来、
 *   以及最关键的**出不来时兜底出得来**（`CastResolved.casterId` 可空）。
 */

import { describe, expect, it } from 'vitest';
import {
  CastKind,
  School,
  asSkillId,
  type EntityId,
} from '@wowpvp/shared';

import { SnapshotCombatView, castStateFromStarted } from './SnapshotCombatView.js';

const CASTER = 7 as EntityId;
const alwaysPresent = (): boolean => true;

/** 一条 `CastStarted` 消息。skillId 默认取一个**读条**技能 */
const started = (over: Partial<Parameters<typeof castStateFromStarted>[0]> = {}) => ({
  casterId: CASTER,
  skillId: asSkillId('mage.frostbolt'),
  duration: 1.4,
  interruptible: true,
  school: School.Frost,
  castKind: CastKind.Cast,
  ...over,
});

describe('castStateFromStarted', () => {
  it('读条技能：endsAt - startedAt 恰好是协议给的 duration', () => {
    const st = castStateFromStarted(started(), 100);
    expect(st.startedAt).toBe(100);
    expect(st.endsAt).toBeCloseTo(101.4, 6);
    expect(st.channelEndsAt).toBeUndefined();
  });

  it('★ 引导技能：channelEndsAt 由技能数据补回来 —— 协议里没有这一段', () => {
    // 冰霜风暴 = 0.8 秒读条 + 4 秒引导。服务器发的 duration 只有 0.8
    const st = castStateFromStarted(
      started({ skillId: asSkillId('mage.blizzard'), duration: 0.8, castKind: CastKind.Channel }),
      100,
    );
    expect(st.endsAt).toBeCloseTo(100.8, 6);
    // 4.8 而不是 0.8 —— 蓄力法阵要亮满整个引导段
    expect(st.channelEndsAt).toBeCloseTo(104.8, 6);
  });

  it('学派与可打断标记原样透传（HUD 的施法条颜色与盾牌标记读它们）', () => {
    const st = castStateFromStarted(started({ interruptible: false }), 0);
    expect(st.school).toBe(School.Frost);
    expect(st.interruptible).toBe(false);
    expect(st.kind).toBe(CastKind.Cast);
  });
});

describe('SnapshotCombatView 施法注册表', () => {
  it('CastStarted 进表之后 playerCast 与 castOfId 都拿得到', () => {
    const v = new SnapshotCombatView();
    v.beginCast(CASTER, castStateFromStarted(started(), 0));
    expect(v.castOfId(CASTER)?.skillId).toBe(asSkillId('mage.frostbolt'));
    expect(v.activeCasts()).toHaveLength(1);
  });

  it('endCast 清除（CastResolved / CastInterrupted / Death 三条路都走它）', () => {
    const v = new SnapshotCombatView();
    v.beginCast(CASTER, castStateFromStarted(started(), 0));
    v.endCast(CASTER);
    expect(v.castOfId(CASTER)).toBeUndefined();
    expect(v.activeCasts()).toHaveLength(0);
  });

  it('★★ casterId 被抹掉时靠超时兜底 —— 否则法阵会一直转下去', () => {
    const v = new SnapshotCombatView();
    v.beginCast(CASTER, castStateFromStarted(started(), 0)); // endsAt = 1.4

    // 读条还没结束：不能清
    v.pruneCasts(1.0, alwaysPresent);
    expect(v.castOfId(CASTER)).toBeDefined();

    // 刚结束、还在宽限期内：也不清（结束消息可能正在路上）
    v.pruneCasts(1.5, alwaysPresent);
    expect(v.castOfId(CASTER)).toBeDefined();

    // 超过宽限期：强制清除
    v.pruneCasts(2.5, alwaysPresent);
    expect(v.castOfId(CASTER)).toBeUndefined();
  });

  it('★ 引导技能的宽限期按 channelEndsAt 算，不是按读条段', () => {
    const v = new SnapshotCombatView();
    v.beginCast(
      CASTER,
      castStateFromStarted(
        started({ skillId: asSkillId('mage.blizzard'), duration: 0.8, castKind: CastKind.Channel }),
        0,
      ),
    );
    // 读条段早过了，但引导还在跑 —— 清掉就等于引导中途特效消失
    v.pruneCasts(3, alwaysPresent);
    expect(v.castOfId(CASTER)).toBeDefined();

    v.pruneCasts(5.4, alwaysPresent);
    expect(v.castOfId(CASTER)).toBeUndefined();
  });

  it('施法者离场（死亡/离线/走出视野）立即清除，不等超时', () => {
    const v = new SnapshotCombatView();
    v.beginCast(CASTER, castStateFromStarted(started(), 0));
    v.pruneCasts(0.5, () => false);
    expect(v.castOfId(CASTER)).toBeUndefined();
  });

  it('多个施法者互不干扰', () => {
    const v = new SnapshotCombatView();
    const other = 9 as EntityId;
    v.beginCast(CASTER, castStateFromStarted(started(), 0));
    v.beginCast(other, castStateFromStarted(started({ casterId: other }), 0));
    v.endCast(CASTER);
    expect(v.castOfId(CASTER)).toBeUndefined();
    expect(v.castOfId(other)).toBeDefined();
  });
});
