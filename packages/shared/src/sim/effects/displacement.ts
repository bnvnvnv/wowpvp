/**
 * 位移与生成类效果。规格书 13.5 / 6.6，验收 #46。
 *
 * ★ 验收 #46：「冲锋、闪现、后跃、拉拽和队友拉回都不能穿墙或到达非法位置」。
 *   所有位移**必须**经过 `geometry.clampDisplacement`，没有例外 ——
 *   这个文件里每一个位移处理器都调用同一个 `moveTo()` 辅助函数，
 *   想绕过它就得显式绕开这个模块，代码审查一眼能看到。
 */

import { clampDisplacement } from '../../math/geometry.js';
import { addScaled, normalize2D, sub, yawToDir, type Vec3 } from '../../math/vec3.js';
import { getSkill } from '../../data/index.js';
import { TargetFilter } from '../../types/enums.js';
import { effectiveModifiersOf } from '../aura.js';
import { teleportTo } from '../movement.js';
import { spawnColliding, spawnDelayedImpact, spawnHoming } from '../projectile.js';
import { asSkillId } from '../../types/ids.js';
import type { CombatEntity } from '../entity.js';
import { registerEffect, type EffectContext } from './registry.js';

/**
 * 把实体移动到目标点，路径被墙截断时停在墙前。
 * ★ 所有位移的唯一出口（验收 #46）。
 */
const moveTo = (ctx: EffectContext, entity: CombatEntity, to: Vec3, kind: string): void => {
  const landing = clampDisplacement(entity.position, to, entity.radius, ctx.world.obstacles);
  /**
   * ★★ 必须同步 `MovementState`，只写 `entity.position` 是**死代码**：
   *   `tickWorld` 第 2 步每 tick 都用移动积分的结果覆盖 `entity.position`，
   *   于是位移在下一 tick（50ms 后）被原样抹回 —— 冲锋/闪现/击退/拉拽
   *   对一切**有移动条目**的实体（联网玩家、实战模式假人）从未真正生效过，
   *   且没有任何断言站在断点上（效果测试从不跑第二个 tick）。
   *
   * `teleportTo()` 此前同样是零调用方 —— 它才是位移落点的正确收口：
   *   贴地、清速度、置 `teleported` 标记（13.4 动画层据此不播高速跑步）。
   *
   * 没有移动条目的实体（试验场玩家，位置由场景驱动）仍走旧路径，
   * 驱动方消费 `displaced` 事件自行同步 —— 事件里的 `to` 就是权威落点。
   */
  const prev = ctx.movement?.get(entity.id);
  if (prev) {
    const next = teleportTo(prev, landing, ctx.world.obstacles, entity.radius);
    ctx.movement!.set(entity.id, next);
    entity.position = next.position;
  } else {
    entity.position = landing;
  }
  ctx.events.push({ t: 'displaced', targetId: entity.id, to: entity.position, kind });
};

registerEffect('chargeTo', (ctx, e, targets) => {
  const target = targets[0];
  if (!target) return;
  // 停在距离目标 stopDistance 处，而不是重叠在一起
  const dir = normalize2D(sub(ctx.source.position, target.position));
  const dest = addScaled(target.position, dir, e.stopDistance);
  moveTo(ctx, ctx.source, dest, 'charge');
});

registerEffect('chargeToAlly', (ctx, e, targets) => {
  const ally = targets[0];
  if (!ally) return;
  const dir = normalize2D(sub(ctx.source.position, ally.position));
  moveTo(ctx, ctx.source, addScaled(ally.position, dir, e.stopDistance), 'chargeToAlly');
});

registerEffect('pullTarget', (ctx, e, targets) => {
  for (const t of targets) {
    // 死亡之握 / 信仰飞跃：把目标拉到施法者附近。同样不能穿墙（验收 #46）
    const dir = normalize2D(sub(t.position, ctx.source.position));
    moveTo(ctx, t, addScaled(ctx.source.position, dir, e.toDistance), 'pull');
  }
});

registerEffect('blinkForward', (ctx, e) => {
  // ★ 沿**角色**面向，不是镜头面向（5.4 / 6.5）
  const dir = yawToDir(ctx.source.yaw);
  moveTo(ctx, ctx.source, addScaled(ctx.source.position, dir, e.distance), 'blink');
  if (e.clearsRoot) {
    ctx.resolve([{ kind: 'removeAura', auraIds: ['control.root'] }], [ctx.source]);
  }
});

registerEffect('leapBackward', (ctx, e) => {
  const back = yawToDir(ctx.source.yaw + Math.PI);
  moveTo(ctx, ctx.source, addScaled(ctx.source.position, back, e.distance), 'leapBackward');
  if (e.clearsSlow) {
    /**
     * ★ `clearsSlow` 的语义是「只清减速」—— 用 `impairs: 'slow'`，不能用
     *   `impairs: 'movement'`（那会连定身一起清，后撤跃变成免费解定身），
     *   也不能用旧的 `types: ['movement']`（按类别选不到 magic/poison 减速，
     *   而且被定身时人根本跳不出去，「清掉定身」在这里语义不通）。
     */
    ctx.resolve([{ kind: 'dispel', impairs: 'slow', count: 'all', from: 'ally' }], [ctx.source]);
  }
});

registerEffect('teleportBehindTarget', (ctx, e, targets) => {
  const target = targets[0];
  if (!target) return;
  // 目标背后：沿目标朝向的反方向偏移
  const back = yawToDir(target.yaw + Math.PI);
  moveTo(ctx, ctx.source, addScaled(target.position, back, e.offset), 'shadowstep');
  // 落在背后之后把自己转向目标，否则玩家还要手动转身
  ctx.source.yaw = target.yaw;
});

registerEffect('knockback', (ctx, e, targets) => {
  for (const t of targets) {
    /**
     * ★★ **`AuraModifiers.knockbackTaken` 的唯一消费方（W26）。**
     *   这一行的上方原本写着「抗控型护甲降低击退距离（10.8），这里读聚合后的
     *   修正」—— 而它下面那行**没有读**任何修正。注释描述的是一件不发生的事，
     *   正是本仓库最怕的那类缺陷（PROGRESS 技术债 §9）。
     *
     * ★ 方向按 schema 原文「受到击退距离乘算」：机动甲 1.25 = 被推得**更远**
     *   （换来 12% 移速的代价），抗控甲 0.6 = 被推得**更近**，死骑骨盾 0.5 同理。
     * ★ 读的是**被推的人**的聚合值，不是施法者的 —— 「击退抵抗」是承受方的属性。
     * ⚠️ 只作用于 `knockback`，不碰 `pullTarget`：10.8 的护甲文案说的是
     *   「击退距离」，拉拽（死亡之握/信仰飞跃）落点由施法者位置决定，
     *   按承受方的抵抗缩放会把人拽到半路上悬着，语义不通。
     */
    const dir = normalize2D(sub(t.position, ctx.source.position));
    const taken = effectiveModifiersOf(ctx.auras, t, ctx.world.time).knockbackTaken;
    moveTo(ctx, t, addScaled(t.position, dir, e.distance * taken), 'knockback');
  }
});

// ── 生成类 ───────────────────────────────────────────────────────

registerEffect('spawnProjectile', (ctx, e) => {
  spawnColliding(ctx.world, ctx.projectiles, {
    skillId: asSkillId(ctx.skillId),
    source: ctx.source,
    direction: yawToDir(ctx.source.yaw),
    speed: e.speed,
    radius: e.radius,
    maxDistance: 45,
    pierce: e.pierce,
    onHit: e.onHit,
  });
});

/**
 * 6.6 锁定投射物（W23）。**每个目标一发**，到达才结算 `onHit`。
 *
 * ★★ **结算走的是同一条路，一条也不旁路。** 弹体到达时由
 *   `tickWorld` 第 5 步的 `resolve(projectile.sourceId, projectile.skillId, …)`
 *   结算 —— 与直接施放共用 `resolveEffects` / 效果注册表，于是暴击掷骰、
 *   `damage.skillId`（X3 死亡回顾）、S7 的来源抹除、统计折叠、击杀归账、
 *   光环施加（含 `applyControl` 从 skillId 反查学派）全部自动跟上。
 *   在这里另写一条「投射物专用结算」是本仓库最贵的那类错误
 *   （tick.ts 头部的 A2 教训），所以这个处理器**只负责生成弹体**。
 *
 * ★ `spawnHoming` 从 M4 起就零生产调用方 —— 这里是它的第一个。
 */
registerEffect('lockedProjectile', (ctx, e, targets) => {
  for (const t of targets) {
    spawnHoming(ctx.world, ctx.projectiles, {
      skillId: asSkillId(ctx.skillId),
      source: ctx.source,
      target: t,
      speed: e.speed,
      onHit: e.onHit,
    });
  }
});

registerEffect('delayedGroundImpact', (ctx, e, targets) => {
  // 落点：地面技能由 castState.groundPoint 传进来，这里用第一个目标位置兜底
  const center = ctx.groundPoint ?? targets[0]?.position ?? ctx.source.position;
  spawnDelayedImpact(ctx.world, ctx.projectiles, {
    skillId: asSkillId(ctx.skillId),
    source: ctx.source,
    center,
    radius: e.radius,
    delay: e.delay,
    /**
     * ★★ 8.1「友军伤害默认关闭」：落地要重新圈人（1.5 秒后的事），
     *   阵营判据从**技能定义**带过去 —— 与施法期 `aiming.ts` 读的是同一个
     *   字段，不在投射物层另立一套。查不到 `SkillDef` 时（光环周期跳、
     *   弹体二段效果这类 `ctx.skillId` 反查不到技能的场景，与
     *   `applyControl` 反查学派时的处境相同）回落到 `Enemy`，
     *   与 `spawnDelayedImpact` 的缺省一致。
     */
    targetFilter: getSkill(asSkillId(ctx.skillId))?.targetFilter ?? TargetFilter.Enemy,
    onImpact: e.onImpact,
  });
});

registerEffect('spawnGroundArea', (ctx, e) => {
  const center = ctx.groundPoint ?? ctx.source.position;
  ctx.groundAreas.push({
    id: ctx.groundAreas.length + 1,
    areaId: e.areaId,
    skillId: ctx.skillId,
    sourceId: ctx.source.id,
    center: { ...center },
    radius: e.radius,
    createdAt: ctx.world.time,
    expiresAt: ctx.world.time + e.duration,
    tickInterval: e.tickInterval ?? 0,
    nextTickAt: e.tickInterval ? ctx.world.time + e.tickInterval : Infinity,
    onTick: e.onTick ?? [],
    blocksTargetingFromOutside: e.blocksTargetingFromOutside === true,
    revealsStealth: e.revealsStealth === true,
  });
});

registerEffect('spawnTrap', (ctx, e) => {
  const center = ctx.groundPoint ?? ctx.source.position;
  ctx.traps.push({
    id: ctx.traps.length + 1,
    skillId: ctx.skillId,
    sourceId: ctx.source.id,
    center: { ...center },
    triggerRadius: e.triggerRadius,
    armedAt: ctx.world.time + e.armTime,
    expiresAt: ctx.world.time + e.armTime + e.duration,
    onTrigger: e.onTrigger,
    // 冰冻陷阱只对「首个敌人」生效（9.5）
    singleTrigger: e.singleTrigger !== false,
  });
});

// ── 其他 ─────────────────────────────────────────────────────────

registerEffect('dropFlag', (ctx, e, targets) => {
  const list = e.target === 'target' ? targets : [ctx.source];
  for (const t of list) {
    if (!t.flags.carryingFlag) continue;
    t.flags.carryingFlag = false;
    ctx.events.push({ t: 'custom', handler: 'dropFlag', sourceId: ctx.source.id, targetId: t.id });
  }
});

registerEffect('shapeshift', (ctx, e) => {
  ctx.events.push({ t: 'custom', handler: `shapeshift:${e.form}`, sourceId: ctx.source.id });
});

registerEffect('enterStealth', (ctx, e) => {
  ctx.source.flags.stealthed = true;
  ctx.source.flags.stealthRevealed = false;
  ctx.events.push({
    t: 'custom', handler: `enterStealth:${e.graceSeconds ?? 0}`, sourceId: ctx.source.id,
  });
});

registerEffect('interveneGuard', (ctx, e, targets) => {
  const ally = targets[0];
  if (!ally) return;
  ctx.events.push({
    t: 'custom', handler: `interveneGuard:${e.duration}`,
    sourceId: ctx.source.id, targetId: ally.id,
  });
});

registerEffect('onNthHit', (ctx, e, targets) => {
  // 计数由地面区域/光环的持有者维护，这里只在达到阈值时透传子效果。
  // M4 用「每 N 次周期跳触发一次」近似 —— 凛冬领域的语义正是如此。
  ctx.resolve(e.effects, targets);
  void e.count;
});

registerEffect('custom', (ctx, e, targets) => {
  // 逃生舱：登记在 docs/PROGRESS.md 技术债第 1 节的那些 handler 走这里。
  // 没有对应实现时**只记事件不抛异常** —— custom 本来就是「引擎暂不理解」的标记。
  ctx.events.push({
    t: 'custom', handler: e.handler,
    sourceId: ctx.source.id, targetId: targets[0]?.id,
  });
});
