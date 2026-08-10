/**
 * X21 在**试验场那一路**的接线：sim 的 `onQueueExpired` → `CombatDirector`
 * 的同名钩子 → 场景闪技能栏。
 *
 * ★★ 这一支存在的理由与 `net/castRegistry.test.ts` 一字不差：X21 的三层
 *   （sim / 协议 / 服务器）在 Wave1-D 就通了，HUD 面在 Wave1.5 也做好了，
 *   而**中间那一跳**是没有任何测试够得着的地方 —— 钩子没接、或者接了但
 *   caster 没传出来（于是场景没法区分玩家和假人），两种情况都是静默的。
 */

import { describe, expect, it } from 'vitest';

import { CAST_QUEUE_WINDOW, type CombatEntity, type SkillDef } from '@wowpvp/shared';

import { CombatDirector } from './CombatDirector.js';

const SPAWN = { x: 0, y: 0, z: 0 };

const advance = (dir: CombatDirector, seconds: number, step = 1 / 60): void => {
  for (let t = 0; t < seconds; t += step) dir.update(step, SPAWN, 0);
};

/** 选中一个假人，然后按 0 号格（寒冰箭，1.4 秒读条）—— 排队窗的入口条件 */
const startCasting = (dir: CombatDirector): void => {
  const dummy = dir.visibleEntities().find((e) => e.name.includes('战士'))!;
  dir.selectById(dummy.id as number);
  dir.castSlot(0);
  advance(dir, 0.1);
};

describe('X21 排队窗过期 → CombatDirector.onQueueExpired', () => {
  it('★★ 读条期间再按一格：0.4 秒后钩子响一次，带上技能与等待时长', () => {
    const dir = new CombatDirector([], SPAWN);
    const seen: { caster: CombatEntity; skill: SkillDef; waited: number }[] = [];
    dir.onQueueExpired = (caster, skill, waited) => seen.push({ caster, skill, waited });

    startCasting(dir);
    dir.castSlot(1); // 火焰冲击：进排队位（AlreadyCasting 是可排队的失败）
    advance(dir, 0.2);
    expect(seen, '排队窗还没到期就不该响').toHaveLength(0);

    advance(dir, 0.4);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.skill.id as string).toBe('mage.fire_blast');
    expect(seen[0]!.waited).toBeGreaterThan(CAST_QUEUE_WINDOW);
    // 「差一点」还是「早就凉了」由表现层判断，所以别把它钳成常数
    expect(seen[0]!.waited).toBeLessThan(CAST_QUEUE_WINDOW + 0.2);
  });

  it('★★ caster 传得出来 —— 场景据此只闪**玩家自己**的技能栏', () => {
    const dir = new CombatDirector([], SPAWN);
    let caster: CombatEntity | undefined;
    dir.onQueueExpired = (c) => { caster = c; };

    startCasting(dir);
    dir.castSlot(1);
    advance(dir, 0.6);

    expect(caster?.id).toBe(dir.player.id);
  });

  it('★ 只响一次 —— 过期的那一发从排队位里被摘掉，不会每 tick 重播', () => {
    const dir = new CombatDirector([], SPAWN);
    let n = 0;
    dir.onQueueExpired = () => { n++; };

    startCasting(dir);
    dir.castSlot(1);
    advance(dir, 2);

    expect(n).toBe(1);
  });

  it('★★ 不写战斗日志 —— X21 拍板的正是「迟到的失败提示比沉默更误导」', () => {
    const dir = new CombatDirector([], SPAWN);
    startCasting(dir);
    const before = dir.log.length;
    dir.castSlot(1);
    advance(dir, 0.6);

    // 这 0.6 秒里日志只可能多出读条完成那类行，绝不能出现「无法释放」
    expect(dir.log.slice(0, dir.log.length - before).map((l) => l.text).join('\n'))
      .not.toMatch(/无法释放/);
  });

  it('没接钩子时一切照旧（钩子是可选的，默认路径零改动）', () => {
    const dir = new CombatDirector([], SPAWN);
    startCasting(dir);
    dir.castSlot(1);
    expect(() => advance(dir, 1)).not.toThrow();
  });
});
