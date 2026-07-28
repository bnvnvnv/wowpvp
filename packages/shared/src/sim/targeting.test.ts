/**
 * 目标系统测试。对应规格书 5.1–5.3、5.6 与验收 #4 / #5 / #6。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { TARGETING } from '../constants/combat.js';
import { mage, priest, rogue, warrior } from '../data/index.js';
import { box } from '../data/maps/schema.js';
import { DEG, vec3 } from '../math/vec3.js';
import { TargetFilter } from '../types/enums.js';
import { asTeamId } from '../types/ids.js';
import { createEntity, isSelectableBy, type CombatEntity } from './entity.js';
import {
  collectTabCandidates,
  pruneInvalidTargets,
  resolveSkillTarget,
  setHardTarget,
  sortTabCandidates,
  tabTarget,
  targetOfTarget,
  toggleFocus,
} from './targeting.js';
import { addEntity, allocEntityId, createWorld, type World } from './world.js';

const RED = asTeamId(0);
const BLUE = asTeamId(1);
const ground = box('g', 'floor', { x: 0, y: -1, z: 0 }, { w: 400, h: 1, d: 400 });

let world: World;
let me: CombatEntity;

const spawn = (cls: typeof warrior, team: typeof RED, x: number, z: number, name?: string) =>
  addEntity(world, createEntity(allocEntityId(world), cls, team, vec3(x, 0, z), { name }));

beforeEach(() => {
  world = createWorld([ground]);
  me = spawn(warrior, RED, 0, 0, '我');
  me.yaw = 0; // 面向 -Z
});

/** yaw=0 时镜头也面向 -Z */
const opts = (viewYaw = 0) => ({ viewYaw });

describe('5.1 目标层级', () => {
  it('硬目标与焦点目标相互独立', () => {
    const a = spawn(mage, BLUE, 0, -10, 'A');
    const b = spawn(priest, BLUE, 3, -10, 'B');

    setHardTarget(world, me, a.id);
    toggleFocus(world, me, b.id);

    expect(me.targets.hard).toBe(a.id);
    expect(me.targets.focus).toBe(b.id);

    // 换硬目标不影响焦点
    setHardTarget(world, me, b.id);
    expect(me.targets.focus).toBe(b.id);
  });

  it('焦点键再次使用会清除焦点', () => {
    const a = spawn(mage, BLUE, 0, -10);
    toggleFocus(world, me, a.id);
    expect(me.targets.focus).toBe(a.id);
    toggleFocus(world, me, a.id);
    expect(me.targets.focus).toBeUndefined();
  });

  it('「当前目标的目标」是派生值', () => {
    const enemy = spawn(mage, BLUE, 0, -10);
    const ally = spawn(priest, RED, 5, 0);
    setHardTarget(world, me, enemy.id);
    enemy.targets.hard = ally.id;

    expect(targetOfTarget(world, me)?.id).toBe(ally.id);

    // 敌人换目标，派生值立刻跟着变 —— 不存状态就不会失效
    enemy.targets.hard = me.id;
    expect(targetOfTarget(world, me)?.id).toBe(me.id);
  });
});

describe('验收 #6 — 硬目标超距或被遮挡后仍保留', () => {
  it('★ 目标跑到 100 米外，硬目标不清除', () => {
    const enemy = spawn(mage, BLUE, 0, -10);
    setHardTarget(world, me, enemy.id);

    enemy.position = vec3(0, 0, -100);
    pruneInvalidTargets(world, me);
    expect(me.targets.hard).toBe(enemy.id);
  });

  it('★ 目标被墙完全遮挡，硬目标不清除', () => {
    const enemy = spawn(mage, BLUE, 0, -10);
    setHardTarget(world, me, enemy.id);

    world.obstacles = [ground, box('w', 'wall', { x: 0, y: 0, z: -5 }, { w: 40, h: 8, d: 1 })];
    pruneInvalidTargets(world, me);
    expect(me.targets.hard).toBe(enemy.id);
  });

  it('目标死亡才清除（属于「离场」）', () => {
    const enemy = spawn(mage, BLUE, 0, -10);
    setHardTarget(world, me, enemy.id);
    enemy.alive = false;
    pruneInvalidTargets(world, me);
    expect(me.targets.hard).toBeUndefined();
  });
});

describe('验收 #5 / 5.3 — 未被发现的潜行目标不能被选中', () => {
  it('★ 潜行且未被发现 → 不能点击选中', () => {
    const sneak = spawn(rogue, BLUE, 0, -5);
    sneak.flags.stealthed = true;

    expect(isSelectableBy(sneak, me)).toBe(false);
    expect(setHardTarget(world, me, sneak.id)).toBe(false);
    expect(me.targets.hard).toBeUndefined();
  });

  it('★ 潜行且未被发现 → 不进入 Tab 候选', () => {
    const sneak = spawn(rogue, BLUE, 0, -5);
    sneak.flags.stealthed = true;
    const visible = spawn(mage, BLUE, 0, -20);

    const ids = collectTabCandidates(world, me, opts()).map((c) => c.entity.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(sneak.id);
  });

  it('被发现后（照明弹 / 3 米内）恢复可选中', () => {
    const sneak = spawn(rogue, BLUE, 0, -5);
    sneak.flags.stealthed = true;
    sneak.flags.stealthRevealed = true;

    expect(isSelectableBy(sneak, me)).toBe(true);
    expect(collectTabCandidates(world, me, opts()).map((c) => c.entity.id)).toContain(sneak.id);
  });

  it('队友能看见自己人潜行', () => {
    const ally = spawn(rogue, RED, 0, -5);
    ally.flags.stealthed = true;
    expect(isSelectableBy(ally, me)).toBe(true);
  });

  it('旋风等「无法被选中」状态同样不可选中', () => {
    const target = spawn(mage, BLUE, 0, -5);
    target.flags.untargetable = true;
    expect(isSelectableBy(target, me)).toBe(false);
  });
});

describe('5.3 Tab 候选过滤', () => {
  it('只在 45 米内', () => {
    const near = spawn(mage, BLUE, 0, -40);
    const far = spawn(mage, BLUE, 0, -50);
    const ids = collectTabCandidates(world, me, opts()).map((c) => c.entity.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    expect(TARGETING.TAB_MAX_RANGE).toBe(45);
  });

  it('★ 完全位于身后的目标不进首轮列表', () => {
    const front = spawn(mage, BLUE, 0, -10);
    const behind = spawn(mage, BLUE, 0, 10); // 正后方
    const ids = collectTabCandidates(world, me, opts()).map((c) => c.entity.id);
    expect(ids).toContain(front.id);
    expect(ids).not.toContain(behind.id);
  });

  it('前方 140° 边界内外的分界正确', () => {
    // 140° 扇形的半角是 70°
    const inside = spawn(mage, BLUE, Math.sin(65 * DEG) * 10, -Math.cos(65 * DEG) * 10);
    const outside = spawn(mage, BLUE, Math.sin(80 * DEG) * 10, -Math.cos(80 * DEG) * 10);
    const ids = collectTabCandidates(world, me, opts()).map((c) => c.entity.id);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
  });

  it('★ 用的是镜头朝向而不是角色朝向', () => {
    const behind = spawn(mage, BLUE, 0, 10);
    // 角色仍面向 -Z，但镜头转到了 +Z（左键环绕）
    expect(collectTabCandidates(world, me, opts(0)).map((c) => c.entity.id)).not.toContain(behind.id);
    expect(collectTabCandidates(world, me, opts(Math.PI)).map((c) => c.entity.id)).toContain(behind.id);
  });

  it('不选中友方', () => {
    const ally = spawn(priest, RED, 0, -10);
    expect(collectTabCandidates(world, me, opts()).map((c) => c.entity.id)).not.toContain(ally.id);
  });

  it('宠物默认不进候选，开启后才进', () => {
    const pet = addEntity(
      world,
      createEntity(allocEntityId(world), mage, BLUE, vec3(0, 0, -8), { isPet: true }),
    );
    expect(collectTabCandidates(world, me, opts()).map((c) => c.entity.id)).not.toContain(pet.id);
    expect(
      collectTabCandidates(world, me, { ...opts(), includePets: true }).map((c) => c.entity.id),
    ).toContain(pet.id);
  });
});

describe('5.3 Tab 优先级排序', () => {
  it('屏幕中心附近优先于偏离中心的', () => {
    const offCenter = spawn(mage, BLUE, 8, -8, '偏');
    const centered = spawn(mage, BLUE, 0, -12, '中');
    const sorted = sortTabCandidates(collectTabCandidates(world, me, opts()));
    expect(sorted[0]!.entity.id).toBe(centered.id);
    expect(sorted[1]!.entity.id).toBe(offCenter.id);
  });

  it('同样靠近中心时，距离近的优先', () => {
    const far = spawn(mage, BLUE, 0, -30, '远');
    const near = spawn(mage, BLUE, 0, -8, '近');
    const sorted = sortTabCandidates(collectTabCandidates(world, me, opts()));
    expect(sorted[0]!.entity.id).toBe(near.id);
    expect(sorted[1]!.entity.id).toBe(far.id);
  });

  it('中心与距离同档时，可见的优先于被遮挡的', () => {
    // 两个目标对称放在中线两侧同一距离，一个被柱子挡住
    const blocked = spawn(mage, BLUE, -2, -12, '挡');
    const clear = spawn(mage, BLUE, 2, -12, '通');
    world.obstacles = [
      ground,
      box('pillar', 'wall', { x: -2, y: 0, z: -6 }, { w: 3, h: 6, d: 3 }),
    ];
    const sorted = sortTabCandidates(collectTabCandidates(world, me, opts()));
    expect(sorted[0]!.entity.id).toBe(clear.id);
    expect(sorted.find((c) => c.entity.id === blocked.id)!.visible).toBe(false);
  });

  it('其余条件相同时，正在施法的优先', () => {
    const idle = spawn(mage, BLUE, -1, -12);
    const casting = spawn(mage, BLUE, 1, -12);
    const sorted = sortTabCandidates(
      collectTabCandidates(world, me, { ...opts(), isCasting: (e) => e.id === casting.id }),
    );
    expect(sorted[0]!.entity.id).toBe(casting.id);
  });

  it('其余条件相同时，敌方旗手优先', () => {
    const normal = spawn(mage, BLUE, -1, -12);
    const carrier = spawn(mage, BLUE, 1, -12);
    carrier.flags.carryingFlag = true;
    const sorted = sortTabCandidates(collectTabCandidates(world, me, opts()));
    expect(sorted[0]!.entity.id).toBe(carrier.id);
    expect(normal).toBeDefined();
  });

  it('排序是确定的 —— 服务器与客户端必须得到同一个结果', () => {
    for (let i = 0; i < 6; i++) spawn(mage, BLUE, i - 3, -10 - i);
    const a = sortTabCandidates(collectTabCandidates(world, me, opts())).map((c) => c.entity.id);
    const b = sortTabCandidates(collectTabCandidates(world, me, opts())).map((c) => c.entity.id);
    expect(a).toEqual(b);
  });
});

describe('5.3 Tab 循环行为', () => {
  it('依次循环所有候选并回到开头', () => {
    const a = spawn(mage, BLUE, 0, -8);
    const b = spawn(mage, BLUE, 0, -16);
    const c = spawn(mage, BLUE, 0, -24);

    expect(tabTarget(world, me, opts())?.id).toBe(a.id);
    expect(tabTarget(world, me, opts())?.id).toBe(b.id);
    expect(tabTarget(world, me, opts())?.id).toBe(c.id);
    expect(tabTarget(world, me, opts())?.id).toBe(a.id);
  });

  it('Shift+Tab 反向循环', () => {
    const a = spawn(mage, BLUE, 0, -8);
    const b = spawn(mage, BLUE, 0, -16);
    const c = spawn(mage, BLUE, 0, -24);

    expect(tabTarget(world, me, opts())?.id).toBe(a.id);
    expect(tabTarget(world, me, opts(), true)?.id).toBe(c.id);
    expect(tabTarget(world, me, opts(), true)?.id).toBe(b.id);
  });

  it('没有候选时保持原目标不变', () => {
    const a = spawn(mage, BLUE, 0, -8);
    setHardTarget(world, me, a.id);
    a.position = vec3(0, 0, 100); // 跑出候选范围

    expect(tabTarget(world, me, opts())).toBeUndefined();
    expect(me.targets.hard).toBe(a.id); // 仍然选中（验收 #6）
  });

  it('当前目标不在候选里时从头开始', () => {
    const outOfList = spawn(mage, BLUE, 0, 20); // 身后，不进候选
    const inList = spawn(mage, BLUE, 0, -10);
    me.targets.hard = outOfList.id;
    expect(tabTarget(world, me, opts())?.id).toBe(inList.id);
  });
});

describe('5.6 技能取目标', () => {
  it('攻击型技能无目标时提示「需要目标」，不自动选敌人', () => {
    spawn(mage, BLUE, 0, -5); // 场上有敌人，但玩家没选
    const r = resolveSkillTarget(world, me, TargetFilter.Enemy);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('noTarget');
  });

  it('自身技能永远合法', () => {
    const r = resolveSkillTarget(world, me, TargetFilter.Self);
    expect(r.ok && r.target.id).toBe(me.id);
  });

  it('鼠标指向优先于硬目标，且不改变硬目标', () => {
    const hard = spawn(priest, RED, 0, -5);
    const mouseover = spawn(priest, RED, 3, -5);
    me.targets.hard = hard.id;
    me.targets.mouseover = mouseover.id;

    const r = resolveSkillTarget(world, me, TargetFilter.Ally, { allowMouseover: true });
    expect(r.ok && r.target.id).toBe(mouseover.id);
    expect(me.targets.hard).toBe(hard.id); // 硬目标没被改
  });

  it('技能不支持鼠标指向时忽略它', () => {
    const hard = spawn(priest, RED, 0, -5);
    const mouseover = spawn(priest, RED, 3, -5);
    me.targets.hard = hard.id;
    me.targets.mouseover = mouseover.id;

    const r = resolveSkillTarget(world, me, TargetFilter.Ally);
    expect(r.ok && r.target.id).toBe(hard.id);
  });

  it('选着敌人放治疗 → 按住自我施法键才落到自己', () => {
    const enemy = spawn(mage, BLUE, 0, -5);
    me.targets.hard = enemy.id;

    expect(resolveSkillTarget(world, me, TargetFilter.Ally).ok).toBe(false);
    const r = resolveSkillTarget(world, me, TargetFilter.Ally, { selfCastHeld: true });
    expect(r.ok && r.target.id).toBe(me.id);
  });

  it('★ 不按自我施法键时不会默默自疗', () => {
    const r = resolveSkillTarget(world, me, TargetFilter.Ally);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('noTarget');
  });

  it('对友方用敌对技能会被拒绝', () => {
    const ally = spawn(priest, RED, 0, -5);
    me.targets.hard = ally.id;
    const r = resolveSkillTarget(world, me, TargetFilter.Enemy);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('invalidTarget');
  });
});
