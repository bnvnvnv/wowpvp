/**
 * 命中反馈的唯一编排者（打击感改造）。
 *
 * ★★ 试验场与联网场景各自的伤害反馈 switch 都收缩成一次 `onHit()` ——
 *   之前两边散装写，已经漂出过一处不一致（联网只给自己 flashHit，
 *   试验场给所有目标），这里顺手修掉：**所有可见目标都闪**。
 *
 * 固定顺序：分档 → 浮字 → 粒子 → 模型（闪白/受击动作）→ 音效分层 →
 * 震动 → 顿帧 → 屏闪。
 *
 * ★★ 两条红线：
 *   · **震动与顿帧只在事件牵涉本地玩家时触发**（targetId 或 sourceId 是自己）。
 *     12v12 里 24 个人对轰，不筛画面会一直在抖。唯一例外：附近死亡按
 *     距离加微量创伤（onDeath）。
 *   · **damageNumbers=false 时其余每条通道照常**（规格书 8.1/333 行：
 *     必须给出清晰命中反馈）—— 浮字的开关在 FloatingNumbers 内部，
 *     本文件**不允许**出现任何 access().damageNumbers 判断。
 */

import { School, type EntityId } from '@wowpvp/shared';
import type { AccessibilitySettings } from '../settings/accessibility.js';
import type { FloaterKind } from '../hud/FloatingNumbers.js';
import { impactTierOf, type ImpactTier } from './impactTier.js';
import { NEARBY_DEATH_RANGE, SHAKE } from '../camera/CameraShake.js';
import { HIT_STOP } from '../render/HitStop.js';

/** 一次伤害结算的表现视图 —— 本地 CombatEvent 与网络 Damage 消息都收敛成它 */
export interface HitEvent {
  targetId: EntityId;
  sourceId?: EntityId | undefined;
  amount: number;
  absorbed: number;
  immune: boolean;
  avoided?: 'dodge' | 'parry' | 'block' | undefined;
  crit: boolean;
  /** >0 = 这一发就是致命一击 */
  overkill: number;
  school: School;
  /** 目标最大生命（重击的比例判据）。联网侧从快照查，查不到就走绝对值兜底 */
  targetMaxHealth?: number | undefined;
}

/** 目标模型的最小接口。playHitReact 可缺席（胶囊兜底/旧模型）*/
export interface TargetViewLike {
  flashHit(strength?: number, seconds?: number): void;
  playHitReact?(): void;
}

export interface HitFeedbackDeps {
  selfId: () => EntityId | undefined;
  /** 浮字位置（目标头顶）。拿不到 → 不出字，其余通道照常 */
  headOf: (id: EntityId) => { x: number; y: number; z: number } | undefined;
  /** 音效的距离衰减参数（自己 = 不衰减）*/
  audioAt: (id: EntityId) => { distance?: number };
  viewOf: (id: EntityId) => TargetViewLike | undefined;
  floaters: {
    push(
      text: string, kind: FloaterKind,
      at: { x: number; y: number; z: number },
      opts?: { peakScale?: number },
    ): void;
  };
  /** 自己挨打的屏幕边缘闪红（CombatHud.flashScreen）*/
  flashScreen: () => void;
  /** 14.2 命中爆发。?art=off 时缺席 */
  vfxDamage?: (ev: {
    targetId: EntityId; amount: number; school: School; immune: boolean;
    avoided?: 'dodge' | 'parry' | 'block' | undefined; tier: ImpactTier;
  }) => void;
  addTrauma: (t: number) => void;
  hitStop: { trigger(seconds: number): void };
  audio: {
    play(name: string, opts?: { group?: 'sfx' | 'music' | 'ui'; volume?: number; rate?: number; distance?: number }): void;
    playVariant(group: string, opts?: { volume?: number; rate?: number; distance?: number }): void;
    playImpact(school: School, opts?: { volume?: number; distance?: number }): void;
  };
  access: () => AccessibilitySettings;
}

/** 重击（非暴击）浮字的峰值缩放：比普通大、比暴击小，且不抢暴击的橙色 */
const HEAVY_PEAK = 1.45;

export class HitFeedback {
  /**
   * 暴击音效层的自有节流。40ms 同名去重挡不住变体轮换出的不同文件名 ——
   * 一发 AOE 暴击 3 个人会叠 3 声不同的 combat_crit_*。
   */
  private lastCritSoundAt = -Infinity;
  private now = 0;
  /** 诊断只读：本场景累计看到的暴击数（diag-feel 断言 > 0）*/
  critsSeen = 0;
  /** 诊断只读：创伤峰值（clamp 前的原始请求值取 max）*/
  traumaPeak = 0;

  constructor(private readonly deps: HitFeedbackDeps) {}

  /** 每帧推进（只服务暴击音效节流）。用真实 dt —— 音效不在顿帧时钟上 */
  update(realDt: number): void {
    this.now += realDt;
  }

  onHit(ev: HitEvent): void {
    const d = this.deps;
    const self = d.selfId();
    const onSelf = ev.targetId === self;
    const bySelf = ev.sourceId !== undefined && ev.sourceId === self;
    const at = d.headOf(ev.targetId);

    // ── 1. 分档（唯一判据在 impactTier.ts）─────────────────────
    const tier = impactTierOf({
      amount: ev.amount, crit: ev.crit, overkill: ev.overkill,
      maxHealth: ev.targetMaxHealth,
    });
    if (ev.crit) this.critsSeen++;

    // ── 2. 浮字（开关在 FloatingNumbers 内部，这里不判断）────────
    if (at) {
      if (ev.immune) d.floaters.push('免疫', 'immune', at);
      else if (ev.avoided) {
        d.floaters.push(
          { dodge: '闪避', parry: '招架', block: '格挡' }[ev.avoided], 'miss', at,
        );
      } else if (ev.amount > 0) {
        if (ev.crit) {
          // 「!」是第三条通道（字形）：颜色 + 尺寸 + 字形，色盲/小屏下都剩两条
          d.floaters.push(`${ev.amount}!`, 'crit', at);
        } else {
          d.floaters.push(
            String(ev.amount), 'damage', at,
            tier === 'heavy' || tier === 'kill' ? { peakScale: HEAVY_PEAK } : {},
          );
        }
      } else if (ev.absorbed > 0) {
        d.floaters.push(`吸收 ${ev.absorbed}`, 'absorb', at);
      }
    }

    // ── 3. 粒子（SpellVfx 按 tier 放大，?art=off 时整体缺席）────
    d.vfxDamage?.({
      targetId: ev.targetId, amount: ev.amount, school: ev.school,
      immune: ev.immune, avoided: ev.avoided, tier,
    });

    // ── 4. 模型：闪白强度分档；heavy 及以上加受击动作 ────────────
    if (!ev.immune && !ev.avoided && (ev.amount > 0 || ev.absorbed > 0)) {
      const view = d.viewOf(ev.targetId);
      if (view) {
        if (ev.crit) view.flashHit(1.4, 0.2);
        else if (tier === 'heavy' || tier === 'kill') view.flashHit(1.1, 0.16);
        else view.flashHit();
        if (tier !== 'light' && tier !== 'normal') view.playHitReact?.();
      }
    }

    // ── 5. 音效分层（基础层 + 按档叠加，层与层不同名，见 AudioManager）─
    const opts = onSelf ? {} : d.audioAt(ev.targetId);
    if (ev.immune) {
      d.audio.play('buff_apply', { ...opts, rate: 0.8, volume: 0.7 });
    } else if (ev.avoided === 'dodge') {
      d.audio.playVariant('dodge', opts);
      d.audio.playVariant('leather', { ...opts, volume: 0.45 });
    } else if (ev.avoided === 'parry') {
      d.audio.playVariant('parry', opts);
    } else if (ev.avoided === 'block') {
      d.audio.playVariant('block', opts);
      d.audio.playVariant('metal', { ...opts, volume: 0.5 });
    } else if (ev.amount > 0 || ev.absorbed > 0) {
      d.audio.playImpact(ev.school, opts);
      if (onSelf) d.audio.playVariant('hurt', { volume: 0.85 });
      // 重击的低频骨感层（物理才有「骨」可言）
      if (
        (tier === 'heavy' || tier === 'critHeavy' || tier === 'kill') &&
        ev.school === School.Physical
      ) {
        d.audio.playVariant('bone', { ...opts, rate: 0.88, volume: 0.7 });
      }
      // 暴击尖锐层：只在牵涉本地玩家时播（团战里别人互暴不该刺耳朵）
      if (ev.crit && (onSelf || bySelf) && this.now - this.lastCritSoundAt >= 0.12) {
        this.lastCritSoundAt = this.now;
        d.audio.playVariant('crit', { volume: bySelf ? 0.85 : 0.75 });
      }
      // 击杀确认：只给击杀者
      if (ev.overkill > 0 && bySelf) {
        d.audio.play('ui_achievement', { group: 'ui', volume: 0.6 });
      }
    }

    // ── 6/7. 震动 + 顿帧：只在牵涉本地玩家时 ────────────────────
    if (!ev.immune && !ev.avoided && (ev.amount > 0 || ev.absorbed > 0)) {
      /**
       * ★ cameraShake=0 时**仍然**调 addTrauma —— 幅度归零由
       * shakeAmplitude() 在采样端负责。两处判断必有一处会被忘掉，
       * 归零逻辑只放在唯一入口那一端。
       */
      const trauma = onSelf
        ? SHAKE.TRAUMA[SELF_TRAUMA[tier]]
        : bySelf
          ? tier === 'kill'
            ? SHAKE.TRAUMA.dealtKill
            : tier === 'crit' || tier === 'critHeavy'
              ? SHAKE.TRAUMA.dealtCrit
              : tier === 'heavy'
                ? SHAKE.TRAUMA.dealtHeavy
                : 0
          : 0;
      if (trauma > 0) {
        this.traumaPeak = Math.max(this.traumaPeak, trauma);
        d.addTrauma(trauma);
      }
      if ((onSelf || bySelf) && this.deps.access().hitStop) {
        d.hitStop.trigger(HIT_STOP.DURATION[tier]);
      }
    }

    // ── 8. 屏闪：只有自己挨打（别人挨打闪我的屏幕是错误的主语）───
    if (onSelf && ev.amount > 0) d.flashScreen();
  }

  /** 治疗反馈：暴击治疗放大浮字（沿用 fn-heal 的绿色，不新增 CSS 类）*/
  onHeal(ev: { targetId: EntityId; amount: number; crit: boolean }): void {
    if (ev.amount <= 0) return;
    const at = this.deps.headOf(ev.targetId);
    if (!at) return;
    this.deps.floaters.push(
      ev.crit ? `+${ev.amount}!` : `+${ev.amount}`,
      'heal', at,
      ev.crit ? { peakScale: 1.6 } : {},
    );
  }

  /**
   * 死亡反馈的震动部分：自己死 = 大创伤；附近死亡按距离衰减的微量创伤。
   * （死亡音效/粒子仍在场景的 death 分支 —— 它们不需要分档信息。）
   */
  onDeath(ev: { entityId: EntityId; killerId?: EntityId | undefined; distance?: number | undefined }): void {
    const self = this.deps.selfId();
    if (ev.entityId === self) {
      this.deps.addTrauma(SHAKE.TRAUMA.selfDeath);
      if (this.deps.access().hitStop) this.deps.hitStop.trigger(HIT_STOP.DURATION.kill);
      return;
    }
    if (ev.distance !== undefined && ev.distance < NEARBY_DEATH_RANGE) {
      this.deps.addTrauma(
        SHAKE.TRAUMA.nearbyDeathMax * (1 - ev.distance / NEARBY_DEATH_RANGE),
      );
    }
  }
}

/** 自己挨打时各档的创伤键 */
const SELF_TRAUMA: Record<ImpactTier, keyof typeof SHAKE.TRAUMA> = {
  light: 'selfHitLight',
  normal: 'selfHit',
  heavy: 'selfHeavy',
  crit: 'selfCrit',
  critHeavy: 'selfCritHeavy',
  kill: 'selfHeavy', // 击杀档在「自己是目标」侧就是被打死 —— onDeath 会补 selfDeath
};
