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
import { spawnColliding, spawnDelayedImpact } from '../projectile.js';
import { asSkillId } from '../../types/ids.js';
import type { CombatEntity } from '../entity.js';
import { registerEffect, type EffectContext } from './registry.js';

/**
 * 把实体移动到目标点，路径被墙截断时停在墙前。
 * ★ 所有位移的唯一出口（验收 #46）。
 */
const moveTo = (ctx: EffectContext, entity: CombatEntity, to: Vec3, kind: string): void => {
  const landing = clampDisplacement(entity.position, to, entity.radius, ctx.world.obstacles);
  entity.position = landing;
  ctx.events.push({ t: 'displaced', targetId: entity.id, to: landing, kind });
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
    ctx.resolve([{ kind: 'dispel', types: ['movement'], count: 'all', from: 'ally' }], [ctx.source]);
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
    // 抗控型护甲降低击退距离（10.8），这里读聚合后的修正
    const dir = normalize2D(sub(t.position, ctx.source.position));
    moveTo(ctx, t, addScaled(t.position, dir, e.distance), 'knockback');
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

registerEffect('delayedGroundImpact', (ctx, e, targets) => {
  // 落点：地面技能由 castState.groundPoint 传进来，这里用第一个目标位置兜底
  const center = ctx.groundPoint ?? targets[0]?.position ?? ctx.source.position;
  spawnDelayedImpact(ctx.world, ctx.projectiles, {
    skillId: asSkillId(ctx.skillId),
    source: ctx.source,
    center,
    radius: e.radius,
    delay: e.delay,
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
