/**
 * 新手教学的指挥器：把试验场的现实翻译成 `TutorialSignal`，喂给纯规约。
 * docs/14 §M15。
 *
 * ★★ 红线兑现：**sim 一行未动。** 本类做的四件事全在客户端：
 *   1. **旁路订阅** —— 包一层 `CombatDirector.onCombatEvent / onCastActivity`
 *      （保留原处理器，先转发再折叠，与统计/音效/特效互不相扰）
 *   2. **每帧采样** —— 位置/镜头/着地/选中/学派锁/延迟落点，全是 HUD 也在读的
 *      公开状态；「取消读条」由「正在读条 → 没在读条，且没完成也没被锁」推理出来
 *   3. **舞台调度** —— 走位环暂停假人自驱脚本、以 requestCast 同一入口替
 *      假人·法师往玩家脚下丢陨石；毕业环把三个假人血量压低（试验场规则，
 *      与 reviveInTestbed 同一层）
 *   4. **持久化** —— localStorage（照 accessibility 的键式），可跳过、可重进
 */

import {
  distance2D,
  isCasting,
  asSkillId,
  getClass,
  getSkill,
  type CombatEntity,
  type CombatEvent,
  type SkillDef,
} from '@wowpvp/shared';

import type { CombatDirector } from '../combat/CombatDirector.js';
import {
  STEP_ORDER,
  advanceTutorial,
  initialTutorialState,
  type StepId,
  type TutorialSignal,
  type TutorialState,
} from './steps.js';

export const TUTORIAL_STORAGE_KEY = 'wowpvp.tutorial.v1';

/** 走位环里两颗陨石之间的间隔，秒（读条 1s + 落地 1.5s + 喘息）*/
const METEOR_RESTAGE_SECONDS = 4.5;
/**
 * 毕业环把假人**血量上限**压到这个值（速胜局，一套爆发能打倒）。
 * ★ 压上限而不是压当前血：牧师会给自己奶 —— 只压一次当前血的话，
 *   玩家打别人时它悄悄奶回满血，「速胜局」变成打不动的马拉松。
 *   压上限后治疗是**真的**但到顶就停，「先断奶再爆发」的考点原样成立。
 */
const GRADUATE_DUMMY_MAX_HEALTH = 360;

interface StoredTutorial {
  v: 1;
  done: StepId[];
  skipped: boolean;
}

const loadStored = (storage: Storage | undefined): StoredTutorial => {
  try {
    const raw = storage?.getItem(TUTORIAL_STORAGE_KEY);
    if (!raw) return { v: 1, done: [], skipped: false };
    const parsed = JSON.parse(raw) as Partial<StoredTutorial>;
    return {
      v: 1,
      done: Array.isArray(parsed.done)
        ? parsed.done.filter((d): d is StepId => STEP_ORDER.includes(d as StepId))
        : [],
      skipped: parsed.skipped === true,
    };
  } catch {
    return { v: 1, done: [], skipped: false };
  }
};

/** 供场景每帧喂进来的采样值（都是 TestbedScene 本来就有的读数）*/
export interface TutorialFrameSample {
  cameraYaw: number;
  playerYaw: number;
  cameraDistance: number;
  grounded: boolean;
}

/** 供 verify:m15 与 HUD 读取的状态视图 */
export interface TutorialStatus {
  active: boolean;
  skipped: boolean;
  current: StepId | null;
  done: readonly StepId[];
  moveGoals: TutorialState['moveGoals'];
  cameraGoals: TutorialState['cameraGoals'];
  killedDummies: number;
}

export class TutorialDirector {
  private state: TutorialState;
  private skipped: boolean;
  /** 状态变化（含子勾）时回调 —— HUD 重绘 + 存档都挂在它上 */
  onChange?: () => void;

  // ── 每帧采样的上一帧值 ──
  private prevPos: { x: number; z: number } | null = null;
  private prevYawGap: number | null = null;
  private prevDistance: number | null = null;
  private prevGrounded = true;
  private prevTargetId: number | undefined;
  private prevCasting = false;
  /** 上一帧的学派锁快照（school → until），用于检出「新锁出现 = 被打断」 */
  private prevLocks = new Map<string, number>();
  /** 本帧内已由事件流解释过的施法结束（resolved），不再当作「取消」 */
  private castEndExplained = false;
  /** 正在读条的技能（合成取消信号时要报它的 id）*/
  private castingSkillId: string | null = null;

  // ── 舞台调度 ──
  private nextMeteorAt = 0;
  /** 已盯上的那颗陨石（延迟落点 id）*/
  private watchedImpactId: number | null = null;
  private graduateStaged = false;

  constructor(
    private readonly combat: CombatDirector,
    private readonly storage: Storage | undefined = globalThis.localStorage,
  ) {
    const stored = loadStored(storage);
    this.skipped = stored.skipped;
    this.state = initialTutorialState(stored.done);
  }

  // ── 对外视图 ─────────────────────────────────────────────────

  get status(): TutorialStatus {
    return {
      active: !this.skipped && this.state.current !== null,
      skipped: this.skipped,
      current: this.state.current,
      done: this.state.done,
      moveGoals: this.state.moveGoals,
      cameraGoals: this.state.cameraGoals,
      killedDummies: this.state.killedDummies.length,
    };
  }

  /** 跳过教学（可重进：restart）。docs/14 §M15 红线 */
  skip(): void {
    this.skipped = true;
    this.unstage();
    this.save();
    this.onChange?.();
  }

  /** 从头再来（清空存档进度）*/
  restart(): void {
    this.skipped = false;
    this.state = initialTutorialState();
    this.graduateStaged = false;
    this.save();
    this.onChange?.();
  }

  // ── 接线 ─────────────────────────────────────────────────────

  /**
   * 包住 CombatDirector 的两个旁路钩子。★ 必须在场景自己接完之后调用 ——
   * 原处理器（音效/特效/打击感）先走，教学折叠垫在后面，互不知晓。
   */
  attach(): void {
    const prevEvent = this.combat.onCombatEvent;
    this.combat.onCombatEvent = (ev) => {
      prevEvent?.(ev);
      this.onEvent(ev);
    };
    const prevActivity = this.combat.onCastActivity;
    this.combat.onCastActivity = (kind, caster, skill, targets) => {
      prevActivity?.(kind, caster, skill, targets);
      this.onActivity(kind, caster, skill, targets);
    };
  }

  private onEvent(ev: CombatEvent): void {
    if (!this.statusActive()) return;
    if (ev.t === 'death' && (ev.targetId as number) !== (this.combat.player.id as number)) {
      this.feed({ t: 'dummyDied', entityId: ev.targetId as number, at: this.now() });
    }
  }

  private onActivity(
    kind: 'started' | 'resolved' | 'interrupted' | 'failed',
    caster: CombatEntity,
    skill: SkillDef | undefined,
    targets?: readonly CombatEntity[],
  ): void {
    if (!this.statusActive() || !skill) return;
    const me = this.combat.player;

    if (caster.id === me.id) {
      if (kind === 'started') {
        this.castingSkillId = skill.id as string;
        this.feed({
          t: 'playerCastStarted', skillId: skill.id as string,
          school: skill.school as string, at: this.now(),
        });
      }
      if (kind === 'resolved') {
        this.castEndExplained = true;
        this.castingSkillId = null;
        this.feed({
          t: 'playerCastResolved', skillId: skill.id as string,
          school: skill.school as string, at: this.now(),
        });
        // 玩家的专用打断（法术反制）不走效果结算 —— 在这里判定「打断成功」：
        // 表现通知先于 applyInterrupt 触发，此刻目标还在读条 = 这一下会打断它
        if (skill.effects.some((e) => e.kind === 'interrupt')) {
          const target = targets?.[0];
          const landed = target !== undefined && isCasting(this.combat.store, target.id);
          if (landed) {
            this.feed({
              t: 'interruptLanded',
              byPlayer: true,
              targetWasMageDummy:
                (target.classId as string) === 'mage' && target.team !== me.team,
              at: this.now(),
            });
          }
        }
      }
      if (kind === 'interrupted' || kind === 'failed') {
        this.castEndExplained = true;
        this.castingSkillId = null;
      }
      return;
    }

    // 战士假人的拳击挥出瞬间（表现通知先于打断结算 —— 此刻玩家读条与否
    // 就是「骗到了没有」）
    if ((skill.id as string) === 'warrior.pummel' && kind === 'resolved') {
      /**
       * ★ 同 tick 竞态：Esc 取消发生在本 tick 输入阶段、拳击挥出在同 tick 的
       *   combat.update 里 —— 此刻 frame() 还没跑，「取消」尚未被合成，直接喂
       *   pummelSwung 会撞上 cancelledAt === null，玩家看着「落空」却不给过。
       *   先补合成本 tick 的取消，信号顺序恢复成现实里的因果顺序。
       */
      this.detectCancel();
      this.feed({
        t: 'pummelSwung',
        playerWasCasting: isCasting(this.combat.store, me.id),
        at: this.now(),
      });
    }
  }

  /**
   * 取消读条的合成信号：在读 → 没在读，且没有任何别的解释（完成/被打断都会
   * 先把 castEndExplained 立起来）。每 tick 末尾由 frame() 调；拳击挥出时
   * 也提前调一次（见 onActivity 的竞态注释）。幂等 —— 合成后 prevCasting
   * 已翻面，同 tick 再调不会重复发信号。
   */
  private detectCancel(): void {
    const casting = isCasting(this.combat.store, this.combat.player.id);
    if (this.prevCasting && !casting && !this.castEndExplained) {
      this.feed({
        t: 'playerCastCancelled',
        skillId: this.castingSkillId ?? '',
        at: this.now(),
      });
      this.castingSkillId = null;
    }
    this.prevCasting = casting;
  }

  // ── 每帧 ─────────────────────────────────────────────────────

  /** 由 TestbedScene 每帧调用（在 combat.update 之后）*/
  frame(sample: TutorialFrameSample): void {
    if (!this.statusActive()) return;
    const me = this.combat.player;
    const now = this.now();

    // 位移（水平）。瞬移级的跳变不计 —— 那不是「玩家在移动」
    if (this.prevPos) {
      const d = Math.hypot(me.position.x - this.prevPos.x, me.position.z - this.prevPos.z);
      if (d > 0.001 && d < 2) this.feed({ t: 'moved', meters: d });
    }
    this.prevPos = { x: me.position.x, z: me.position.z };

    // 跳跃：着地 → 离地 的沿
    if (this.prevGrounded && !sample.grounded) this.feed({ t: 'jumped' });
    this.prevGrounded = sample.grounded;

    // 镜头环绕：镜头与角色的**夹角变化量**（A/D 转身时两者同转，夹角不变 ——
    // 只有左键环绕才改变夹角，正好是 4.2 的语义）
    const gap = this.wrapAngle(sample.cameraYaw - sample.playerYaw);
    if (this.prevYawGap !== null) {
      const delta = Math.abs(this.wrapAngle(gap - this.prevYawGap));
      if (delta > 0.001 && delta < 1) this.feed({ t: 'cameraOrbited', radians: delta });
    }
    this.prevYawGap = gap;

    // 缩放
    if (this.prevDistance !== null) {
      const dz = Math.abs(sample.cameraDistance - this.prevDistance);
      if (dz > 0.001) this.feed({ t: 'cameraZoomed', meters: dz });
    }
    this.prevDistance = sample.cameraDistance;

    // 选中：目标 **id 变化**才触发 —— 若在更早的环里已经选过人，
    // 「无→有」的沿已经烧掉了，Tab 循环换目标同样是一次「选中」操作
    const hardId = me.targets.hard as number | undefined;
    if (hardId !== undefined && hardId !== this.prevTargetId) this.feed({ t: 'targeted' });
    this.prevTargetId = hardId;

    // 学派锁：出现**新锁**（或延长）说明刚被打断（战士拳击不走事件流）
    for (const [school, until] of me.schoolLocks) {
      const prev = this.prevLocks.get(school as string) ?? 0;
      if (until > prev && until > now) {
        this.feed({
          t: 'playerInterrupted',
          skillId: this.castingSkillId ?? '',
          lockedSchool: school as string,
          lockUntil: until,
          at: now,
        });
        this.castEndExplained = true;
        this.castingSkillId = null;
      }
    }
    this.prevLocks = new Map([...me.schoolLocks] as [string, number][]);

    // 取消读条（合成信号，见 detectCancel）。学派锁检测在上 —— 被打断的
    // 结束要先由 playerInterrupted 解释掉，才轮不到「取消」
    this.detectCancel();
    this.castEndExplained = false;

    this.stage(now);
    this.sampleMeteor(now);
  }

  // ── 舞台调度 ─────────────────────────────────────────────────

  /** 按当前步骤布置舞台（幂等，每帧调）*/
  private stage(now: number): void {
    const current = this.state.current;

    /**
     * 各环的假人静音表：
     *   基础七环 —— 法师炮台闭嘴（M14 后它一发 200+，新手边学走路边被轰死
     *   不是教学；战士与牧师无害，留着当活教材）
     *   打断环 —— 法师必须开着（教的就是打断它）
     *   代价/假读条环 —— 又静音法师（专心和战士过招）
     *   走位环 —— 三个全停，陨石由本类亲自驱动
     *   毕业环 —— 全开（它们是考题）
     */
    const paused = this.combat.pausedDummyClasses;
    paused.clear();
    const sidestep = current === 'sidestep';
    if (sidestep) {
      paused.add('mage'); paused.add('priest'); paused.add('warrior');
    } else if (current === 'interrupt' || current === 'graduate' || current === null) {
      // 全开
    } else {
      paused.add('mage');
    }

    if (sidestep) {
      const pending = this.pendingMeteor();
      if (!pending && now >= this.nextMeteorAt) {
        const mageDummy = this.dummies().find((d) => (d.classId as string) === 'mage');
        const meteor = getSkill(asSkillId('mage.meteor'));
        if (mageDummy && meteor) {
          // 与假人自驱脚本同款的资源与冷却豁免（假人无蓝了教学就卡死了）
          for (const [r, max] of mageDummy.maxResources) mageDummy.resources.set(r, max);
          mageDummy.cooldowns.clear();
          mageDummy.gcdUntil = 0;
          this.combat.requestCast(mageDummy, meteor, {
            groundPoint: { ...this.combat.player.position },
          });
          this.nextMeteorAt = now + METEOR_RESTAGE_SECONDS;
        }
      }
    }

    // 毕业环：把三个假人的血量上限压低（速胜局，见常量注释）。
    // 试验场的假复活按 maxHealth 拉满 —— 压的是上限，复活后仍是小血池；
    // 击杀去重在规约里，同一假人复活再倒不重复计数
    if (current === 'graduate' && !this.graduateStaged) {
      for (const d of this.dummies()) {
        d.maxHealth = GRADUATE_DUMMY_MAX_HEALTH;
        d.health = Math.min(d.health, d.maxHealth);
      }
      this.graduateStaged = true;
    }
  }

  /** 盯着场上的陨石（延迟落点）：进圈发沿信号，落地判内外 */
  private sampleMeteor(now: number): void {
    if (this.state.current !== 'sidestep') return;
    const me = this.combat.player;
    const impact = this.pendingMeteor();

    if (impact) {
      this.watchedImpactId = impact.id;
      if (distance2D(me.position, impact.center) <= impact.radius) {
        if (!this.state.enteredMeteorZone) this.feed({ t: 'meteorZoneEntered', at: now });
      }
      return;
    }

    // 盯着的那颗没了 = 已落地（本帧或上帧）。落点判定用它最后的位置 ——
    // 没存也没关系：落地瞬间的伤害与否由「玩家此刻还在不在圈里」等价判定，
    // 这里直接读玩家当帧位置与最后已知圆心比对
    if (this.watchedImpactId !== null) {
      const last = this.lastImpact;
      this.watchedImpactId = null;
      if (last) {
        this.feed({
          t: 'meteorImpact',
          playerInside: distance2D(me.position, last.center) <= last.radius,
          enteredBefore: this.state.enteredMeteorZone,
          at: now,
        });
      }
      this.lastImpact = null;
    }
  }

  private lastImpact: { center: { x: number; y: number; z: number }; radius: number } | null = null;

  private pendingMeteor():
    | { id: number; center: { x: number; y: number; z: number }; radius: number }
    | null {
    for (const p of this.combat.projectiles.items) {
      if (p.kind === 'delayedImpact' && (p.skillId as string) === 'mage.meteor') {
        this.lastImpact = { center: p.center, radius: p.radius };
        return { id: p.id, center: p.center, radius: p.radius };
      }
    }
    return null;
  }

  /** 撤掉全部舞台改动（跳过/完成时）*/
  private unstage(): void {
    this.combat.pausedDummyClasses.clear();
    // 毕业布置过的小血池恢复职业原值（getClass 只在有布置时才需要）
    if (this.graduateStaged) {
      for (const d of this.dummies()) {
        const cls = getClass(d.classId);
        if (cls) {
          d.maxHealth = cls.baseHealth;
          d.health = Math.min(d.health, d.maxHealth);
        }
      }
    }
  }

  // ── 杂项 ─────────────────────────────────────────────────────

  private dummies(): CombatEntity[] {
    return this.combat
      .allEntities()
      .filter((e) => e.id !== this.combat.player.id);
  }

  private statusActive(): boolean {
    return !this.skipped && this.state.current !== null;
  }

  private now(): number {
    return this.combat.world.time;
  }

  private wrapAngle(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  private feed(sig: TutorialSignal): void {
    const before = this.state;
    this.state = advanceTutorial(this.state, sig);
    if (this.state === before) return;

    // 步骤推进时的善后
    if (this.state.done.length !== before.done.length) {
      if (before.current === 'sidestep') this.unstage();
      if (this.state.current === null) this.unstage(); // 毕业
      this.save();
    }
    this.onChange?.();
  }

  private save(): void {
    try {
      const payload: StoredTutorial = { v: 1, done: this.state.done, skipped: this.skipped };
      this.storage?.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* 存不进去就算了 —— 下次从头教一遍总比教不了强 */
    }
  }

  /** 供 verify:m15 直接注入信号做规约级断言（浏览器里复验同一台状态机）*/
  debugFeed(sig: TutorialSignal): void {
    this.feed(sig);
  }
}
